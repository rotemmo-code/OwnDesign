import type { Project } from '../model/types';
import { checkProject, type Parsed } from './projectFile';

/** The newest project is written at most this long after the first unsaved change. */
const DELAY_MS = 2_000;
/** Days without the draft being written or opened, after which it is flagged expired; only clearDraft deletes it. */
const KEEP_DAYS = 14;
const DAY_MS = 86_400_000;
const DB = 'etelier';
const STORE = 'draft';

/** savedAt null: the draft's time could not be read. expired: older than KEEP_DAYS; still stored, the user decides. */
export type Draft = { savedAt: string | null; expired: boolean; result: Parsed };
type Stored = { savedAt: string; model: Omit<Project, 'pdfBase64'> };

type Claim = 'mine' | 'other-tab' | 'unavailable';
let mine = false;
let claim: Promise<Claim> | undefined;
/**
 * Only the first tab backs up (owner decision 10.2). The other functions refuse in a tab that did not get 'mine'.
 * Calls share one answer, so a second call in the tab that holds the lock (a remount, StrictMode) is 'mine' too;
 * a tab that did not get it may ask again later.
 */
export const claimDraft = (): Promise<Claim> =>
  (claim ??= requestLock().then(answer => {
    mine = answer === 'mine';
    if (!mine) claim = undefined;
    return answer;
  }));
const requestLock = () =>
  new Promise<Claim>(resolve => {
    if (!navigator.locks) return resolve('unavailable');
    navigator.locks
      .request('etelier-draft', { ifAvailable: true }, lock => {
        resolve(lock ? 'mine' : 'other-tab');
        return lock && new Promise<never>(() => {}); // held until the tab is gone
      })
      .catch(() => resolve('unavailable'));
  });
const notMine = () => Promise.reject(new Error('this tab does not hold the draft'));

let db: IDBDatabase | undefined;
let stored: string | undefined; // the pdfBase64 the store holds
let queue: Promise<unknown> = Promise.resolve();
/** One database job at a time, in the order asked. */
const inTurn = <T>(job: () => Promise<T>): Promise<T> => {
  const result = queue.then(job);
  queue = result.catch(() => {});
  return result;
};

const open = () =>
  new Promise<IDBDatabase>((resolve, reject) => {
    const request = indexedDB.open(DB, 1);
    request.onupgradeneeded = () => request.result.createObjectStore(STORE);
    request.onerror = () => reject(request.error);
    request.onsuccess = () => {
      const opened = request.result;
      // another connection wants to delete the database (or the user cleared site data): let it, open again next time
      opened.onclose = opened.onversionchange = () => {
        opened.close();
        if (db === opened) db = stored = undefined;
      };
      resolve(opened);
    };
  });

/** One transaction: all of it is stored, or nothing and the old records stay. */
async function run(mode: IDBTransactionMode, use: (store: IDBObjectStore) => void): Promise<void> {
  db ??= await open();
  const tx = db.transaction(STORE, mode, { durability: 'strict' });
  return new Promise((resolve, reject) => {
    tx.oncomplete = () => resolve();
    tx.onabort = () => reject(tx.error);
    use(tx.objectStore(STORE));
  });
}

async function write(p: Project): Promise<void> {
  const { pdfBase64, ...model } = p;
  const same = stored === pdfBase64;
  stored = undefined;
  await run('readwrite', store => {
    const count = store.count('pdf');
    count.onsuccess = () => {
      // the PDF is 28 MB at most and rarely changes; it is written again when it went missing
      if (!same || count.result === 0) store.put(pdfBase64, 'pdf');
      store.put({ savedAt: new Date().toISOString(), model } satisfies Stored, 'model');
    };
  });
  stored = pdfBase64;
}

let timer: ReturnType<typeof setTimeout> | undefined;
let latest: Project;
/** A running timer is not restarted, so edits that never pause are still backed up (owner decision 10.7). */
export function scheduleDraft(p: Project, done: (ok: boolean) => void): void {
  if (!mine) return queueMicrotask(() => done(false));
  latest = p;
  timer ??= setTimeout(() => {
    timer = undefined;
    inTurn(() => write(latest)).then(
      () => done(true),
      () => done(false),
    );
  }, DELAY_MS);
}

/** A time as toISOString writes it, else null. */
const readTime = (value: unknown): number | null => {
  if (typeof value !== 'string') return null;
  const time = Date.parse(value);
  return Number.isFinite(time) && new Date(time).toISOString() === value ? time : null;
};

/** The one place that decides whether a draft is old. Owner decision: an old draft is flagged, never deleted here. */
const isExpired = (since: number, now: number) => since !== -Infinity && now - since > KEEP_DAYS * DAY_MS;
const notAhead = (time: number | null, now: number) => (time !== null && time <= now ? time : -Infinity);

/**
 * Rejects when storage is blocked. Nothing is ever deleted here: a draft that fails the check (owner decision 10.6) and
 * an expired one are both returned and kept, and the user decides (restore, or clearDraft).
 * Age counts from the later of the last write and the last load that passed the check (the 'kept' record); a time
 * that cannot be read or lies in the future is ignored, so such a draft counts from the first load that saw it.
 */
export const loadDraft = (): Promise<Draft | null> => {
  if (!mine) return notMine();
  return inTurn(async () => {
    let pdf!: IDBRequest, record!: IDBRequest, kept!: IDBRequest;
    await run('readonly', store => {
      pdf = store.get('pdf');
      record = store.get('model');
      kept = store.get('kept');
    });
    const draft = record.result as Partial<Stored> | null | undefined;
    if (draft === undefined) return null;
    const now = Date.now();
    const savedAt = readTime(draft?.savedAt);
    const since = Math.max(notAhead(savedAt, now), notAhead(readTime(kept.result), now));
    const expired = isExpired(since, now);
    const result = checkProject({ ...draft?.model, pdfBase64: pdf.result });
    // first seen, or opened intact and in time: one small record, not the PDF; a failure here does not fail the load.
    // An expired draft keeps its age until the user answers.
    if (since === -Infinity || (result.ok && !expired)) {
      await run('readwrite', store => store.put(new Date(now).toISOString(), 'kept')).catch(() => {});
    }
    return { savedAt: savedAt === null ? null : (draft as Stored).savedAt, expired, result };
  });
};

/** Cancels a waiting write, lets one in progress finish, then deletes the database. */
export function clearDraft(): Promise<void> {
  if (!mine) return notMine();
  clearTimeout(timer);
  timer = undefined;
  return inTurn(remove);
}

// The whole database, not store.clear(): after clear() the room names were still readable in the browser's files.
function remove(): Promise<void> {
  db?.close();
  db = stored = undefined;
  return new Promise((resolve, reject) => {
    const request = indexedDB.deleteDatabase(DB);
    request.onsuccess = () => resolve();
    request.onerror = () => reject(request.error);
    // not request.error: reading it throws while the request is still pending
    request.onblocked = () => reject(new Error('another connection keeps the draft open'));
  });
}
