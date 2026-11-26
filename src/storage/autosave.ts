import type { Project } from '../model/types';
import { checkProject, type Parsed } from './projectFile';

/** The newest project is written at most this long after the first unsaved change. */
const DELAY_MS = 2_000;
/** A draft older than this is deleted when the app next opens (owner decision 10.1). */
const KEEP_DAYS = 14;
const DB = 'etelier';
const STORE = 'draft';

export type Draft = { savedAt: string; result: Parsed };
type Stored = { savedAt: string; model: Omit<Project, 'pdfBase64'> };

/** Only the first tab backs up (owner decision 10.2). Call once at start; the other functions only where it said 'mine'. */
export const claimDraft = (): Promise<'mine' | 'other-tab' | 'unavailable'> =>
  new Promise(resolve => {
    if (!navigator.locks) return resolve('unavailable');
    navigator.locks
      .request('etelier-draft', { ifAvailable: true }, lock => {
        resolve(lock ? 'mine' : 'other-tab');
        return lock && new Promise<never>(() => {}); // held until the tab is gone
      })
      .catch(() => resolve('unavailable'));
  });

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
      request.result.onclose = () => (db = undefined); // e.g. the user cleared the site's data
      resolve(request.result);
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
  latest = p;
  timer ??= setTimeout(() => {
    timer = undefined;
    inTurn(() => write(latest)).then(
      () => done(true),
      () => done(false),
    );
  }, DELAY_MS);
}

/** Rejects when storage is blocked. A draft that fails the check is kept: the user decides (owner decision 10.6). */
export const loadDraft = (): Promise<Draft | null> =>
  inTurn(async () => {
    let pdf!: IDBRequest, record!: IDBRequest;
    await run('readonly', store => {
      pdf = store.get('pdf');
      record = store.get('model');
    });
    const draft = record.result as Stored | undefined;
    if (!draft) return null;
    if (Date.now() - Date.parse(draft.savedAt) > KEEP_DAYS * 86_400_000) {
      await remove();
      return null;
    }
    return { savedAt: draft.savedAt, result: checkProject({ ...draft.model, pdfBase64: pdf.result }) };
  });

/** Cancels a waiting write, lets one in progress finish, then deletes the database. */
export function clearDraft(): Promise<void> {
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
    request.onerror = request.onblocked = () => reject(request.error ?? new Error('blocked by another connection'));
  });
}
