import { readFileSync } from 'node:fs';
import path from 'node:path';
import { expect, firefox, type Page, test } from '@playwright/test';
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

test.beforeEach(async ({ page }) => {
  await page.addInitScript(() => {
    window.violations = [];
    document.addEventListener('securitypolicyviolation', e => window.violations.push(`${e.effectiveDirective} ${e.blockedURI}`));
  });
  await serveProbe(page);
});
test.afterEach(async ({ page }) => {
  if (!page.isClosed()) expect(await page.evaluate(() => window.violations)).toEqual([]);
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
const ready = (page: Page) => page.evaluate(`(async () => { ${HELPERS} })()`);

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
        databases: (await indexedDB.databases()).map(d => d.name), // before loadDraft, which opens an empty one again
        after: await m.loadDraft(),
      };
    }, p),
  ).toEqual({ empty: null, ok: true, equal: true, pdf: [37, 80, 68, 70, 45], savedAt: true, after: null, databases: [] });
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
  expect(result.done[0]).toBeLessThan(2_400);
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

test('claimDraft: no lock manager, or a refused request -> unavailable', async ({ page }) => {
  await ready(page);
  expect(
    await page.evaluate(async () => {
      const refused = { request: () => Promise.reject(new DOMException('no', 'SecurityError')) };
      Object.defineProperty(navigator, 'locks', { value: refused, configurable: true });
      const first = await m.claimDraft();
      Object.defineProperty(navigator, 'locks', { value: undefined, configurable: true });
      return [first, await m.claimDraft()];
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

test('13.9 days old loads, 14.1 days old -> null and no database left', async ({ page }) => {
  await ready(page);
  expect(
    await page.evaluate(async p => {
      await schedule(p);
      const record = await raw((store: IDBObjectStore) => store.get('model'));
      const age = (days: number) => raw((store: IDBObjectStore) => store.put({ ...record, savedAt: new Date(Date.now() - days * 86_400_000).toISOString() }, 'model'));
      await age(13.9);
      const young = await show();
      await age(14.1);
      return [young, await show(), (await indexedDB.databases()).map(d => d.name)];
    }, named('old')),
  ).toEqual(['old', null, []]);
});

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
    const page = await (await browser.newContext({ baseURL })).newPage();
    const errors: string[] = [];
    page.on('pageerror', e => errors.push(e.message));
    await serveProbe(page);
    await ready(page);
    expect(await page.evaluate(async p => [await m.claimDraft(), await m.loadDraft().then(() => 'loaded', (e: Error) => e.name), await schedule(p)], named('b'))).toEqual([
      'unavailable',
      'SecurityError',
      false,
    ]);
    expect(errors).toEqual([]);
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
