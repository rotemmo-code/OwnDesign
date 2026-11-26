import { readFileSync } from 'node:fs';
import path from 'node:path';
import { type BrowserContext, expect, firefox, type Page, test } from '@playwright/test';
import { build, type Rolldown } from 'vite';
import type { Project } from '../../src/model/types';
import { boxProject } from '../fixtures/box';

// Node has no IndexedDB: the storage files are bundled here and served from the app's origin, with the headers of a real
// built script, so they run under the app's own CSP (the same probe as in shell.spec.ts).
const PROBE = '\0storage-probe';
let code: string;
test.beforeAll(async () => {
  const storage = (file: string) => JSON.stringify(path.resolve('src/storage', file).replaceAll('\\', '/'));
  const out = (await build({
    configFile: false,
    logLevel: 'error',
    plugins: [
      {
        name: 'storage-probe',
        resolveId: id => (id.endsWith('storage-probe') ? PROBE : undefined), // vite passes the entry as a path
        load: id => (id === PROBE ? `export * from ${storage('autosave.ts')}; export * from ${storage('projectFile.ts')};` : undefined),
      },
    ],
    build: { write: false, minify: false, lib: { entry: 'storage-probe', formats: ['es'], fileName: 'probe' } },
  })) as Rolldown.RolldownOutput[];
  code = out[0]!.output[0].code;
});

declare global {
  interface Window {
    violations: string[];
  }
}

/** Every page of the context records CSP violations, second tabs included. */
const listen = (context: BrowserContext) =>
  context.addInitScript(() => {
    window.violations = [];
    document.addEventListener('securitypolicyviolation', e => window.violations.push(`${e.effectiveDirective} ${e.blockedURI}`));
  });
const violations = async (context: BrowserContext) => (await Promise.all(context.pages().map(p => p.evaluate(() => window.violations)))).flat();

test.beforeEach(async ({ page, context }) => {
  await listen(context);
  await serveProbe(page);
});
test.afterEach(async ({ context }) => {
  expect(await violations(context)).toEqual([]);
});

async function serveProbe(page: Page) {
  await page.goto('/');
  const script = await page.locator('script[type="module"]').getAttribute('src');
  await page.route('**/probe.js', async route => {
    const response = await route.fetch({ url: new URL(script!, route.request().url()).href });
    await route.fulfill({ response, body: code, headers: { ...response.headers(), 'content-length': String(Buffer.byteLength(code)) } });
  });
}

const named = (name: string): Project => ({ ...boxProject(), name });

// Helpers that run in the page. `m` is the probe module.
const HELPERS = `
  globalThis.m = await import('/probe.js');
  globalThis.wait = ms => new Promise(resolve => setTimeout(resolve, ms));
  globalThis.schedule = p => new Promise(resolve => m.scheduleDraft(p, resolve));
  globalThis.show = async () => { const d = await m.loadDraft(); return d && (d.result.ok ? d.result.project.name : d.result.error); };
  globalThis.raw = use => new Promise((resolve, reject) => {
    const request = indexedDB.open('etelier', 1);
    request.onupgradeneeded = () => request.result.createObjectStore('draft');
    request.onsuccess = () => {
      const tx = request.result.transaction('draft', 'readwrite');
      const r = use(tx.objectStore('draft'));
      tx.oncomplete = () => { request.result.close(); resolve(r?.result); };
      tx.onabort = () => reject(tx.error);
    };
  });`;
/** Loads the probe, claims the draft for this tab and, when it is this tab's, looks at it as the app must; returns the claim. */
const ready = (page: Page) =>
  page.evaluate(`(async () => { ${HELPERS}; const claim = await m.claimDraft(); if (claim === 'mine') await m.loadDraft(); return claim; })()`);
const DAY = 86_400_000;
const T0 = Date.parse('2026-03-01T09:00:00.000Z');
/** Writes on day 0, then loads on each day given: [savedAt, name or error, expired] per load. One fresh draft per call. */
async function days(page: Page, loads: number[], change?: string) {
  await page.evaluate(() => m.clearDraft());
  await page.clock.setFixedTime(T0);
  await page.evaluate(p => schedule(p), named('d'));
  if (change) await page.evaluate(`raw(store => { const r = store.get('model'); r.onsuccess = () => store.put((${change})(r.result), 'model'); })`);
  const seen = [];
  for (const day of loads) {
    await page.clock.setFixedTime(T0 + day * DAY);
    seen.push(await page.evaluate(async () => { const d = await m.loadDraft(); return d && [d.savedAt, d.result.ok ? d.result.project.name : d.result.error, d.expired]; }));
  }
  return seen;
}
const fresh = (seen: readonly unknown[]) => [...seen, false];
const expired = (seen: readonly unknown[]) => [...seen, true];
const stored = (page: Page) => page.evaluate(() => raw((store: IDBObjectStore) => store.count()));

test('draft: empty -> null; schedule, load: equal project and PDF bytes; clear -> null, no database left', async ({ page }) => {
  await ready(page);
  const p = named('d');
  expect(
    await page.evaluate(async p => {
      const empty = await m.loadDraft();
      const ok = await schedule(p);
      const draft = await m.loadDraft();
      await m.clearDraft();
      return {
        empty,
        ok,
        equal: draft.result.ok && JSON.stringify(draft.result.project) === JSON.stringify(p),
        pdf: draft.result.ok && Array.from(draft.result.pdf),
        savedAt: Math.abs(Date.parse(draft.savedAt) - Date.now()) < 10_000,
        expired: draft.expired,
        databases: (await indexedDB.databases()).map(d => d.name), // before loadDraft, which opens an empty one again
        after: await m.loadDraft(),
      };
    }, p),
  ).toEqual({ empty: null, ok: true, equal: true, pdf: [37, 80, 68, 70, 45], savedAt: true, expired: false, after: null, databases: [] });
});

test('six changes 450 ms apart: a write within 2 s, after it the last one; never starved', async ({ page }) => {
  await ready(page);
  const result = await page.evaluate(async base => {
    const start = performance.now();
    const done: number[] = [];
    for (let i = 0; i < 6; i++) {
      m.scheduleDraft({ ...base, name: `e${i}` }, (ok: boolean) => ok && done.push(performance.now() - start));
      await wait(450);
    }
    const midway = await show();
    await wait(2_500);
    return { done, midway, last: await show() };
  }, boxProject());
  expect(result.done).toHaveLength(2);
  expect(result.done[0]).toBeGreaterThanOrEqual(1_990);
  expect(result.done[0]).toBeLessThan(3_500); // a timer restarted by each change would first write after 4.25 s
  expect(result.midway).toBe('e4'); // the newest at the first write, while edits never paused for 2 s
  expect(result.last).toBe('e5');
});

test('clear right after schedule: nothing comes back after 2.4 s', async ({ page }) => {
  await ready(page);
  expect(
    await page.evaluate(async p => {
      let called = false;
      m.scheduleDraft(p, () => (called = true));
      await m.clearDraft();
      await wait(2_400);
      return [await m.loadDraft(), called];
    }, named('x')),
  ).toEqual([null, false]);
});

test('schedule, clear while the timer waits, schedule again: the second one is written', async ({ page }) => {
  await ready(page);
  expect(
    await page.evaluate(async base => {
      m.scheduleDraft({ ...base, name: 'first' }, () => {});
      await m.clearDraft();
      const ok = await schedule({ ...base, name: 'again' });
      return [ok, await show()];
    }, boxProject()),
  ).toEqual([true, 'again']);
});

test('another connection keeps the database open: clearDraft rejects instead of hanging, and later writes still answer', async ({ page }) => {
  await ready(page);
  expect(
    await page.evaluate(async base => {
      await schedule({ ...base, name: 'one' });
      const other = await new Promise<IDBDatabase>(resolve => {
        const request = indexedDB.open('etelier', 1);
        request.onsuccess = () => resolve(request.result); // no onversionchange: it does not let go
      });
      const cleared = await Promise.race([m.clearDraft().then(() => 'cleared', () => 'rejected'), wait(1_000).then(() => 'pending')]);
      other.close();
      const ok = await Promise.race([schedule({ ...base, name: 'two' }), wait(5_000).then(() => 'pending')]);
      return [cleared, ok, await show()];
    }, boxProject()),
  ).toEqual(['rejected', true, 'two']);
});

test('our own connection lets another one delete the database, and opens again for the next write', async ({ page }) => {
  await ready(page);
  expect(
    await page.evaluate(async base => {
      await schedule({ ...base, name: 'one' });
      const deleted = await Promise.race([
        new Promise(resolve => {
          const request = indexedDB.deleteDatabase('etelier');
          request.onsuccess = () => resolve('deleted');
          request.onblocked = () => resolve('blocked');
        }),
        wait(2_000).then(() => 'pending'),
      ]);
      const ok = await schedule({ ...base, name: 'two' });
      return [deleted, ok, await show()];
    }, boxProject()),
  ).toEqual(['deleted', true, 'two']);
});

test('a second tab cannot write, read or delete the first tab\'s draft', async ({ page, context }) => {
  expect(await ready(page)).toBe('mine');
  await page.evaluate(p => schedule(p), named('first'));
  const second = await context.newPage();
  await serveProbe(second);
  expect(await ready(second)).toBe('other-tab');
  expect(
    await second.evaluate(async p => [
      await schedule(p),
      await m.loadDraft().then(() => 'loaded', () => 'refused'),
      await m.clearDraft().then(() => 'cleared', () => 'refused'),
    ], named('second')),
  ).toEqual([false, 'refused', 'refused']);
  await second.waitForTimeout(2_300);
  expect(await page.evaluate(() => show())).toBe('first');
});

test('clear while a write has just started: the write lands first, then all of it is deleted', async ({ page }) => {
  await ready(page);
  expect(
    await page.evaluate(async p => {
      const real = window.setTimeout;
      let fire!: () => void;
      window.setTimeout = ((f: () => void) => ((fire = f), 0)) as typeof setTimeout;
      const written = new Promise(resolve => m.scheduleDraft(p, resolve));
      window.setTimeout = real;
      fire(); // the 2 s are over: the write is queued
      await m.clearDraft();
      return [await written, (await indexedDB.databases()).map(d => d.name), await m.loadDraft()];
    }, named('w')),
  ).toEqual([true, [], null]);
});

test('claimDraft: no lock manager, or a refused request -> unavailable, and asking again is allowed', async ({ page }) => {
  // not ready(): that would claim first, and a claim that was granted is kept
  expect(
    await page.evaluate(async () => {
      const probe = await import(/* @vite-ignore */ '/probe.js' as string);
      const refused = { request: () => Promise.reject(new DOMException('no', 'SecurityError')) };
      Object.defineProperty(navigator, 'locks', { value: refused, configurable: true });
      const first = await probe.claimDraft();
      Object.defineProperty(navigator, 'locks', { value: undefined, configurable: true });
      return [first, await probe.claimDraft()];
    }),
  ).toEqual(['unavailable', 'unavailable']);
});

test('PDF record gone -> invalid; the next save writes it again', async ({ page }) => {
  await ready(page);
  expect(
    await page.evaluate(async base => {
      await schedule({ ...base, name: 'y' });
      await raw((store: IDBObjectStore) => store.delete('pdf'));
      const gone = await show();
      await schedule({ ...base, name: 'z' });
      return [gone, await show()];
    }, boxProject()),
  ).toEqual(['invalid', 'z']);
});

test('version 2 -> wrong-version and 2 records still there; model 5 -> invalid', async ({ page }) => {
  await ready(page);
  expect(
    await page.evaluate(async p => {
      await schedule(p);
      const record = await raw((store: IDBObjectStore) => store.get('model'));
      await raw((store: IDBObjectStore) => store.put({ ...record, model: { ...record.model, version: 2 } }, 'model'));
      const newer = await show();
      const kept = await raw((store: IDBObjectStore) => store.count());
      await raw((store: IDBObjectStore) => store.put({ ...record, model: 5 }, 'model'));
      const broken = await show();
      return [newer, kept, broken, await raw((store: IDBObjectStore) => store.count())];
    }, named('v')),
  ).toEqual(['wrong-version', 2, 'invalid', 2]);
});

test('never loaded: fresh on day 13.9; on day 14.1 flagged expired, still stored and restorable; gone only after clearDraft', async ({ page }) => {
  await ready(page);
  const draft = [new Date(T0).toISOString(), 'd'];
  expect(await days(page, [13.9])).toEqual([fresh(draft)]);
  expect(await days(page, [14.1, 14.2])).toEqual([expired(draft), expired(draft)]); // never deleted by loading
  expect(await page.evaluate(async () => (await indexedDB.databases()).map(d => d.name))).toEqual(['etelier']);
  await page.evaluate(() => m.clearDraft());
  expect(await page.evaluate(async () => [(await indexedDB.databases()).map(d => d.name), await m.loadDraft()])).toEqual([[], null]);
});

test('restored on day 10: fresh on day 15 and on day 23, flagged expired on day 25', async ({ page }) => {
  await ready(page);
  const draft = [new Date(T0).toISOString(), 'd'];
  expect(await days(page, [10, 15])).toEqual([fresh(draft), fresh(draft)]);
  expect(await days(page, [10, 23])).toEqual([fresh(draft), fresh(draft)]);
  expect(await days(page, [10, 25])).toEqual([fresh(draft), expired(draft)]);
});

test('the clock was set back while writing and is right again: a flagged draft that can still be restored', async ({ page }) => {
  await ready(page);
  // written at T0, which was 30 days behind; opened with the correct time
  expect(await days(page, [30])).toEqual([expired([new Date(T0).toISOString(), 'd'])]);
  expect(await stored(page)).toBe(2); // pdf and model; an expired load does not refresh the draft's time
  expect(await page.evaluate(async () => { const d = await m.loadDraft(); return d.result.ok && Array.from(d.result.pdf); })).toEqual([37, 80, 68, 70, 45]);
});

test.describe('a savedAt that cannot be trusted', () => {
  const future = new Date(T0 + 365 * DAY).toISOString();
  for (const [what, change, seen] of [
    // an intact project whose time cannot be read can still be restored; savedAt says the time is unknown
    ['garbage', `r => ({ ...r, savedAt: 'garbage' })`, [null, 'd']],
    ['an object', `r => ({ ...r, savedAt: {} })`, [null, 'd']],
    ['missing', `r => { delete r.savedAt; return r; }`, [null, 'd']],
    ['a date, but not as toISOString writes it', `r => ({ ...r, savedAt: 'Sun, 01 Mar 2026 09:00:00 GMT' })`, [null, 'd']],
    ['a year ahead', `r => ({ ...r, savedAt: '${future}' })`, [future, 'd']],
    // a broken project is reported as such and kept; it never refreshes its own time
    ['garbage, and the project broken', `r => ({ ...r, savedAt: 'garbage', model: { ...r.model, page: 0 } })`, [null, 'invalid']],
    ['a year ahead, and the project broken', `r => ({ ...r, savedAt: '${future}', model: { ...r.model, page: 0 } })`, [future, 'invalid']],
  ] as const) {
    test(`${what}: reported as ${seen[0] ? 'its time' : 'no time'} and ${seen[1]}, kept, and counted from the first load that saw it`, async ({ page }) => {
      await ready(page);
      expect(await days(page, [1, 14.9], change)).toEqual([fresh(seen), fresh(seen)]);
      expect(await stored(page)).toBe(3); // pdf, model, kept
      expect(await days(page, [1, 15.1], change)).toEqual([fresh(seen), expired(seen)]);
      expect(await stored(page)).toBe(3);
    });
  }
});

test('a broken draft first seen while the clock was a year ahead still expires once the clock is right', async ({ page }) => {
  await ready(page);
  const broken = `r => ({ ...r, savedAt: 'garbage', model: { ...r.model, page: 0 } })`;
  const seen = [null, 'invalid'];
  expect(await days(page, [365, 1, 14.9], broken)).toEqual([fresh(seen), fresh(seen), fresh(seen)]);
  expect(await days(page, [365, 1, 15.1], broken)).toEqual([fresh(seen), fresh(seen), expired(seen)]);
});

test('a fresh tab: schedule and clear before the first loadDraft are refused; after it, schedule writes', async ({ page }) => {
  expect(
    await page.evaluate(async p => {
      const probe = await import(/* @vite-ignore */ '/probe.js' as string);
      const claim = await probe.claimDraft();
      const early = await new Promise(resolve => probe.scheduleDraft(p, resolve));
      const clear = await probe.clearDraft().then(() => 'cleared', () => 'refused');
      const first = await probe.loadDraft();
      const later = await new Promise(resolve => probe.scheduleDraft(p, resolve));
      const draft = await probe.loadDraft();
      return [claim, early, clear, first, later, draft.result.ok && draft.result.project.name];
    }, named('start')),
  ).toEqual(['mine', false, 'refused', null, true, 'start']);
});

test('a refused tab asks again without a reload after the first tab closes, and gets mine', async ({ page, context }) => {
  expect(await ready(page)).toBe('mine');
  const second = await context.newPage();
  await serveProbe(second);
  expect(await ready(second)).toBe('other-tab');
  await page.close();
  await expect.poll(() => second.evaluate(() => m.claimDraft())).toBe('mine');
});

test('the first tab closes with unsaved work: the second tab cannot write over it or delete it before loading it', async ({ page, context }) => {
  expect(await ready(page)).toBe('mine');
  expect(await page.evaluate(p => schedule(p), named('from A'))).toBe(true);
  const second = await context.newPage();
  await serveProbe(second);
  expect(await ready(second)).toBe('other-tab');
  await page.close();
  await expect.poll(() => second.evaluate(() => m.claimDraft())).toBe('mine');
  expect(
    await second.evaluate(async p => {
      const early = await schedule(p);
      const clear = await m.clearDraft().then(() => 'cleared', () => 'refused');
      const offered = await show(); // the app offers this one: restore or delete
      const later = await schedule(p);
      return [early, clear, offered, later, await show()];
    }, named('from B')),
  ).toEqual([false, 'refused', 'from A', true, 'from B']);
});

test.describe('a draft written seconds ago, reopened with the clock a little behind', () => {
  for (const [behind, flagged] of [
    ['5 s', false],
    ['23 h', false],
    ['2 days', true], // more than a day ahead: the time is ignored, the old kept time counts
  ] as const) {
    test(`${behind} behind: ${flagged ? 'flagged expired, as before' : 'fresh'}`, async ({ page }) => {
      await ready(page);
      const ms = { '5 s': 5_000, '23 h': 23 * 3_600_000, '2 days': 2 * DAY }[behind];
      await page.evaluate(() => m.clearDraft());
      await page.clock.setFixedTime(T0 - 20 * DAY); // a tab left open for 20 days: kept is old
      await page.evaluate(async p => { await schedule(p); await m.loadDraft(); }, named('old'));
      await page.clock.setFixedTime(T0);
      expect(await page.evaluate(p => schedule(p), named('new'))).toBe(true);
      await page.clock.setFixedTime(T0 - ms);
      expect(await page.evaluate(async () => { const d = await m.loadDraft(); return [d.result.ok && d.result.project.name, d.expired]; })).toEqual(['new', flagged]);
    });
  }
});

test('claimDraft twice in one tab, at once and one after the other: mine every time, and the draft still works', async ({ page }) => {
  expect(await ready(page)).toBe('mine');
  expect(
    await page.evaluate(async p => {
      const claims = [...(await Promise.all([m.claimDraft(), m.claimDraft()])), await m.claimDraft()];
      const ok = await schedule(p);
      return [claims, ok, await show()];
    }, named('twice')),
  ).toEqual([['mine', 'mine', 'mine'], true, 'twice']);
});

test('claimDraft twice in a fresh tab, at once: both mine (React StrictMode runs effects twice)', async ({ page }) => {
  await ready(page); // loads the probe and claims; this tab is replaced by a fresh one below
  const fresh = await page.context().newPage();
  await page.close();
  await serveProbe(fresh);
  expect(await fresh.evaluate(async () => { const probe = await import(/* @vite-ignore */ '/probe.js' as string); return Promise.all([probe.claimDraft(), probe.claimDraft()]); })).toEqual(['mine', 'mine']);
});

for (const [how, error] of [
  ['open throws (Firefox with storage blocked)', 'SecurityError'],
  ['open fails with an error event (Chromium with storage blocked)', 'UnknownError'],
] as const) {
  test(`claimed, but the database cannot be opened, ${how}: load and clear reject, done(false), nothing thrown; works once it opens`, async ({ page }) => {
    const errors: string[] = [];
    page.on('pageerror', e => errors.push(e.message));
    expect(await ready(page)).toBe('mine');
    expect(
      await page.evaluate(
        async ([error, p]) => {
          const real = indexedDB.open.bind(indexedDB);
          const refuse = () => {
            if (error === 'SecurityError') throw new DOMException('blocked', error);
            const request = {} as { error?: DOMException; onerror?: () => void };
            setTimeout(() => ((request.error = new DOMException('blocked', error)), request.onerror?.()));
            return request;
          };
          await m.clearDraft(); // closes the connection ready() opened, so the next job must open again
          Object.defineProperty(indexedDB, 'open', { value: refuse, configurable: true });
          const failed = [
            await m.loadDraft().then(() => 'loaded', (e: Error) => e.name),
            await schedule(p),
            await m.clearDraft().then(() => 'cleared', () => 'rejected'),
          ];
          Object.defineProperty(indexedDB, 'open', { value: real, configurable: true });
          return [failed, await schedule(p), await show()];
        },
        [error, named('later')] as const,
      ),
    ).toEqual([[error, false, 'cleared'], true, 'later']);
    expect(errors).toEqual([]);
  });
}

test('a failing put: done(false), the old draft and its PDF intact', async ({ page }) => {
  await ready(page);
  expect(
    await page.evaluate(async base => {
      await schedule({ ...base, name: 'good' });
      const put = IDBObjectStore.prototype.put;
      IDBObjectStore.prototype.put = function (value, key) {
        if (key === 'model') throw new DOMException('full', 'QuotaExceededError');
        return put.call(this, value, key);
      };
      const ok = await schedule({ ...base, name: 'bad', pdfBase64: 'JVBERi0x' });
      IDBObjectStore.prototype.put = put;
      return [ok, await show(), await raw((store: IDBObjectStore) => store.get('pdf'))];
    }, boxProject()),
  ).toEqual([false, 'good', 'JVBERi0=']);
});

test('two tabs: mine, other-tab; the first closes: mine; 20 reloads: always mine', async ({ page, context }) => {
  const claim = (tab: Page) => tab.evaluate(async () => (await import(/* @vite-ignore */ '/probe.js' as string)).claimDraft());
  expect(await claim(page)).toBe('mine');
  const second = await context.newPage();
  await serveProbe(second);
  expect(await claim(second)).toBe('other-tab');
  await page.close();
  await second.reload();
  expect(await claim(second)).toBe('mine');
  const claims = [];
  for (let i = 0; i < 20; i++) {
    await second.reload();
    claims.push(await claim(second));
  }
  expect(claims).toEqual(Array(20).fill('mine'));
});

test('pdfToBase64: [0,255,128,37] -> AP+AJQ==; 70,001 bytes -> 93,336 characters', async ({ page }) => {
  await ready(page);
  expect(await page.evaluate(async () => [await m.pdfToBase64(new Uint8Array([0, 255, 128, 37])), (await m.pdfToBase64(new Uint8Array(70_001).fill(7))).length])).toEqual([
    'AP+AJQ==',
    93_336,
  ]);
});

test('OPFS file: save, save again; a half-written writable leaves the old project; abort too; stale lastModified -> changed', async ({ page }) => {
  await ready(page);
  expect(
    await page.evaluate(async base => {
      const root = await navigator.storage.getDirectory();
      const handle = await root.getFileHandle('p.etelier.json', { create: true });
      const name = async () => {
        const r = await m.openProject(await handle.getFile());
        return r.ok ? r.project.name : r.error;
      };
      const first = await m.saveProject({ ...base, name: 'A' }, { handle, lastModified: null });
      const afterFirst = await name();
      await wait(20);
      const second = await m.saveProject({ ...base, name: 'B' }, first.target);
      const afterSecond = await name();
      const writable = await handle.createWritable();
      await writable.write('half');
      const midway = await name();
      await writable.abort();
      const aborted = await name();
      const stale = await m.saveProject({ ...base, name: 'C' }, first.target);
      const files: string[] = [];
      for await (const key of (root as unknown as { keys(): AsyncIterable<string> }).keys()) files.push(key);
      await root.removeEntry('p.etelier.json');
      return [first.ok, afterFirst, second.ok, afterSecond, midway, aborted, stale, await name().catch((e: Error) => e.name), files];
    }, boxProject()),
  ).toEqual([true, 'A', true, 'B', 'B', 'B', { ok: false, error: 'changed' }, 'NotFoundError', ['p.etelier.json']]);
});

test('the tab crashes mid-write, the old project is intact', async ({ page, context, browserName }) => {
  test.skip(browserName !== 'chromium', 'chrome://crash is Chromium only');
  await ready(page);
  await page.evaluate(async p => {
    const handle = await (await navigator.storage.getDirectory()).getFileHandle('c.etelier.json', { create: true });
    await m.saveProject(p, { handle, lastModified: null });
    const writable = await handle.createWritable();
    await writable.write('half written');
  }, named('old'));
  await page.goto('chrome://crash').catch(() => {});
  await page.close();
  const fresh = await context.newPage();
  await serveProbe(fresh);
  await ready(fresh);
  expect(
    await fresh.evaluate(async () => {
      const root = await navigator.storage.getDirectory();
      const r = await m.openProject(await (await root.getFileHandle('c.etelier.json')).getFile());
      const files: string[] = [];
      for await (const key of (root as unknown as { keys(): AsyncIterable<string> }).keys()) files.push(key);
      return [r.ok && r.project.name, files.filter(f => !f.endsWith('.crswap')).sort()];
    }),
  ).toEqual(['old', ['c.etelier.json']]); // Chromium may leave its swap file beside it; the project file is whole
});

test('no CSP violation; download works and equals serialize(p)', async ({ page }) => {
  await ready(page);
  const p = named('דירה 4');
  const download = page.waitForEvent('download');
  expect(
    await page.evaluate(async p => {
      Object.defineProperty(window, 'showSaveFilePicker', { value: undefined, configurable: true }); // as in Firefox and Safari
      return m.saveProject(p, null);
    }, p),
  ).toEqual({ ok: true, target: null });
  const file = await download;
  expect(file.suggestedFilename()).toBe('דירה 4.etelier.json');
  expect(readFileSync(await file.path(), 'utf8')).toBe(JSON.stringify(p));
});

test('storage blocked (firefox cookieBehavior 2): unavailable, loadDraft rejects, done(false), no exception', async ({ browserName, baseURL }) => {
  test.skip(browserName !== 'firefox', 'the preference is Firefox only');
  const browser = await firefox.launch({ firefoxUserPrefs: { 'network.cookie.cookieBehavior': 2 } });
  try {
    const context = await browser.newContext({ baseURL });
    await listen(context);
    const page = await context.newPage();
    const errors: string[] = [];
    page.on('pageerror', e => errors.push(e.message));
    await serveProbe(page);
    expect(await ready(page)).toBe('unavailable');
    expect(await page.evaluate(async p => [await m.loadDraft().then(() => 'loaded', () => 'refused'), await schedule(p)], named('b'))).toEqual(['refused', false]);
    expect(errors).toEqual([]);
    expect(await violations(context)).toEqual([]);
  } finally {
    await browser.close();
  }
});

declare global {
  // The probe module and the page helpers above.
  // eslint-disable-next-line no-var
  var m: any, wait: (ms: number) => Promise<void>, schedule: (p: Project) => Promise<boolean>, show: () => Promise<string | null>;
  // eslint-disable-next-line no-var
  var raw: (use: (store: IDBObjectStore) => IDBRequest | void) => Promise<any>;
}
