import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { TIMEOUT_MS } from '../../src/limits';
import { openPdf } from '../../src/pdf/openPdf';

class StubWorker {
  static last: StubWorker;
  onmessage!: (event: { data: unknown }) => void;
  onerror!: () => void;
  onmessageerror!: () => void;
  sent: [message: unknown, transfer?: unknown][] = [];
  terminated = 0;
  constructor(readonly url: URL, readonly options: unknown) {
    StubWorker.last = this;
  }
  postMessage(...message: [unknown, unknown?]) {
    this.sent.push(message);
  }
  terminate() {
    this.terminated++;
  }
  says(data: unknown) {
    this.onmessage({ data });
  }
}

beforeEach(() => {
  vi.useFakeTimers();
  vi.stubGlobal('Worker', StubWorker);
});
afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

/** Two pages, opened. */
async function opened() {
  const opening = openPdf(new ArrayBuffer(8));
  const worker = StubWorker.last;
  worker.says({ id: 1, result: { ok: true, pageCount: 2 } });
  const result = await opening;
  if (!result.ok) throw new Error(result.code);
  return { worker, session: result.session };
}

it('starts a module worker and does not transfer the bytes', async () => {
  const bytes = new ArrayBuffer(8);
  void openPdf(bytes);
  const { url, options, sent } = StubWorker.last;
  expect(String(url)).toContain('reader.worker');
  expect(options).toEqual({ type: 'module' });
  expect(sent).toEqual([[{ id: 1, open: bytes }]]);
});

it('asks for a page and passes the answer on', async () => {
  const { worker, session } = await opened();
  expect(session.pageCount).toBe(2);
  const extracting = session.show(2, 1500, 900);
  expect(worker.sent[1]).toEqual([{ id: 2, page: 2, width: 1500, height: 900 }]);
  const refused = { ok: false, code: 'image-only' };
  worker.says({ id: 2, result: refused });
  expect(await extracting).toEqual(refused);
  expect(worker.terminated).toBe(0); // another page may still be read
});

it('asks for a part of the page to be drawn', async () => {
  const { worker, session } = await opened();
  const drawing = session.draw([1, 2, 30, 40], 5);
  expect(worker.sent[1]).toEqual([{ id: 2, box: [1, 2, 30, 40], scale: 5 }]);
  worker.says({ id: 2, result: { ok: true, picture: 'picture' } });
  expect(await drawing).toEqual({ ok: true, picture: 'picture' });
});

it('ignores messages that are not ours', async () => {
  const settled = vi.fn();
  const opening = openPdf(new ArrayBuffer(8)).then(result => {
    settled();
    return result;
  });
  const worker = StubWorker.last;
  worker.says({ sourceName: 'worker', targetName: 'main', action: 'ready', data: new Uint8Array() }); // pdf.js, from the same worker
  worker.says(null);
  worker.says({ id: 2, result: { ok: true, pageCount: 1 } });
  await vi.advanceTimersByTimeAsync(0);
  expect(settled).not.toHaveBeenCalled();
  worker.says({ id: 1, result: { ok: true, pageCount: 1 } });
  expect((await opening).ok).toBe(true);
});

it('kills the worker at 30 s, not before', async () => {
  const opening = openPdf(new ArrayBuffer(8));
  const worker = StubWorker.last;
  await vi.advanceTimersByTimeAsync(29_999);
  expect(worker.terminated).toBe(0);
  await vi.advanceTimersByTimeAsync(1);
  expect(worker.terminated).toBeGreaterThan(0);
  expect(await opening).toEqual({ ok: false, code: 'timeout' });
});

it('each request has its own 30 s', async () => {
  const { worker, session } = await opened();
  await vi.advanceTimersByTimeAsync(2 * TIMEOUT_MS);
  expect(worker.terminated).toBe(0);
  const extracting = session.show(1, 1500, 900);
  await vi.advanceTimersByTimeAsync(TIMEOUT_MS);
  expect(await extracting).toEqual({ ok: false, code: 'timeout' });
  session.close();
  expect(await session.show(1, 1500, 900)).toEqual({ ok: false, code: 'timeout' });
});

it('a worker error is failed; close settles what is pending', async () => {
  for (const event of ['onerror', 'onmessageerror'] as const) {
    const opening = openPdf(new ArrayBuffer(8));
    StubWorker.last[event]();
    expect(await opening).toEqual({ ok: false, code: 'failed' });
    expect(StubWorker.last.terminated).toBeGreaterThan(0);
  }
  const { worker, session } = await opened();
  const pending = session.show(1, 1500, 900);
  session.close();
  expect(worker.terminated).toBe(1);
  expect(await pending).toEqual({ ok: false, code: 'failed' });
  expect(await session.show(1, 1500, 900)).toEqual({ ok: false, code: 'failed' });
});

it('a buffer that cannot be sent is failed', async () => {
  const bytes = new ArrayBuffer(8);
  structuredClone(bytes, { transfer: [bytes] }); // detaches it
  vi.spyOn(StubWorker.prototype, 'postMessage').mockImplementationOnce(message => {
    structuredClone(message); // as a worker does
  });
  expect(await openPdf(bytes)).toEqual({ ok: false, code: 'failed' });
  expect(StubWorker.last.terminated).toBeGreaterThan(0);
  expect(vi.getTimerCount()).toBe(0);
});

it('an abort ends the worker at once, also while it is still opening', async () => {
  const stop = new AbortController();
  const opening = openPdf(new ArrayBuffer(8), stop.signal);
  stop.abort();
  expect(await opening).toEqual({ ok: false, code: 'failed' });
  expect(StubWorker.last.terminated).toBe(1);
  expect(vi.getTimerCount()).toBe(0);
});

it('a signal that was aborted before the call ends the worker at once (the next file came while this one was still being read)', async () => {
  const stop = new AbortController();
  stop.abort();
  expect(await openPdf(new ArrayBuffer(8), stop.signal)).toEqual({ ok: false, code: 'failed' });
  expect(StubWorker.last.terminated).toBe(1);
  expect(vi.getTimerCount()).toBe(0);
});

it('a refusal ends the worker', async () => {
  const opening = openPdf(new ArrayBuffer(8));
  const worker = StubWorker.last;
  worker.says({ id: 1, result: { ok: false, code: 'locked' } });
  expect(await opening).toEqual({ ok: false, code: 'locked' });
  expect(worker.terminated).toBe(1);
});

// Node has no Web Worker, so the worker's own side is loaded here with a made-up global scope, reader and drawing.
describe('reader.worker', () => {
  const reader = { openDocument: vi.fn(), extractPage: vi.fn() };
  const render = { DRAWING: { with: 'images' }, drawPage: vi.fn() };
  const post = vi.fn();
  const said = () => post.mock.calls.map(([message]) => message);
  let receive: (event: { data: unknown }) => Promise<void>;

  const ASSETS = 'https://example.invalid/pdfjs/';
  const pageOne = { number: 1, cleanup: vi.fn() };
  const pageTwo = { number: 2, cleanup: vi.fn() };
  const doc = { numPages: 3 };
  const drawn = { getPage: vi.fn() };
  const ask = { width: 1684, height: 600 };
  const read = { ok: true, page: { widthPt: 842, heightPt: 595 } };

  beforeEach(async () => {
    vi.resetModules();
    vi.resetAllMocks();
    vi.doMock('../../src/pdf/extract', () => reader);
    vi.doMock('../../src/pdf/render', () => render);
    vi.doMock('pdfjs-dist/legacy/build/pdf.mjs', () => ({}));
    vi.doMock('pdfjs-dist/legacy/build/pdf.worker.mjs', () => ({}));
    vi.stubGlobal('location', { origin: 'https://example.invalid' });
    vi.stubGlobal('postMessage', post);
    vi.stubGlobal('addEventListener', (_type: string, listener: typeof receive) => {
      receive = listener;
    });
    await import('../../src/pdf/reader.worker');
    reader.openDocument.mockImplementation((_pdfjs, _bytes, _assets, drawing) => Promise.resolve({ ok: true, doc: drawing ? drawn : doc }));
    reader.extractPage.mockResolvedValue(read);
    render.drawPage.mockResolvedValue({ ok: true, picture: { bitmap: 'bitmap' } });
    drawn.getPage.mockImplementation(n => Promise.resolve(n === 1 ? pageOne : pageTwo));
    await receive({ data: { id: 1, open: Uint8Array.of(7, 8).buffer } });
  });
  afterEach(() => {
    for (const module of ['../../src/pdf/extract', '../../src/pdf/render', 'pdfjs-dist/legacy/build/pdf.mjs', 'pdfjs-dist/legacy/build/pdf.worker.mjs']) vi.doUnmock(module);
  });

  it('opens a file, reads a page without images and draws it whole from a second opening with them', async () => {
    await receive({ data: { id: 2, page: 1, ...ask } });
    await receive({ data: { id: 3, page: 2, ...ask } });
    expect(reader.openDocument.mock.calls).toEqual([
      [expect.anything(), Uint8Array.of(7, 8), ASSETS],
      [expect.anything(), Uint8Array.of(7, 8), ASSETS, render.DRAWING],
    ]);
    expect(reader.extractPage.mock.calls).toEqual([[expect.anything(), doc, 1], [expect.anything(), doc, 2]]);
    expect(render.drawPage.mock.calls).toEqual([pageOne, pageTwo].map(page => [expect.anything(), drawn, page, [0, 0, 842, 595], 600 / 595])); // it fits by its height
    expect([pageOne.cleanup.mock.calls.length, pageTwo.cleanup.mock.calls.length]).toEqual([1, 0]); // the page before is given back
    expect(said()).toEqual([{ id: 1, result: { ok: true, pageCount: 3 } }, ...[2, 3].map(id => ({ id, result: { ...read, picture: { bitmap: 'bitmap' } } }))]);
    expect(post.mock.calls.map(([, options]) => options)).toEqual([{ transfer: [] }, { transfer: ['bitmap'] }, { transfer: ['bitmap'] }]); // moved, not copied
  });

  it('draws a part of the page shown last', async () => {
    await receive({ data: { id: 2, page: 2, ...ask } });
    await receive({ data: { id: 3, box: [1, 2, 30, 40], scale: 5 } });
    expect(render.drawPage.mock.lastCall).toEqual([expect.anything(), drawn, pageTwo, [1, 2, 30, 40], 5]);
    expect(post.mock.lastCall).toEqual([{ id: 3, result: { ok: true, picture: { bitmap: 'bitmap' } } }, { transfer: ['bitmap'] }]);
  });

  it('answers one request after the other', async () => {
    let finish = (_: object) => {};
    reader.extractPage.mockReturnValueOnce(new Promise(resolve => (finish = resolve)));
    const answers = [receive({ data: { id: 2, page: 1, ...ask } }), receive({ data: { id: 3, page: 2, ...ask } }), receive({ data: { id: 4, box: [1, 2, 30, 40], scale: 5 } })];
    await vi.advanceTimersByTimeAsync(1000);
    expect(reader.extractPage).toHaveBeenCalledTimes(1);
    finish(read);
    await Promise.all(answers);
    expect(said().map(({ id }) => id)).toEqual([1, 2, 3, 4]);
    expect(render.drawPage.mock.lastCall![2]).toBe(pageTwo);
  });

  it('passes a refusal on, of opening, reading or drawing; a page that is refused is not drawn', async () => {
    reader.openDocument.mockResolvedValueOnce({ ok: false, code: 'locked' });
    await receive({ data: { id: 2, open: new ArrayBuffer(1) } });
    reader.extractPage.mockResolvedValueOnce({ ok: false, code: 'image-only' });
    await receive({ data: { id: 3, page: 1, ...ask } });
    expect(render.drawPage).not.toHaveBeenCalled();
    reader.openDocument.mockResolvedValueOnce({ ok: false, code: 'corrupt' });
    await receive({ data: { id: 4, page: 1, ...ask } });
    render.drawPage.mockResolvedValueOnce({ ok: false, code: 'corrupt' });
    await receive({ data: { id: 5, page: 1, ...ask } });
    expect(said().slice(1)).toEqual([[2, 'locked'], [3, 'image-only'], [4, 'corrupt'], [5, 'corrupt']].map(([id, code]) => ({ id, result: { ok: false, code } })));
  });

  it('answers failed at once when opening, reading or drawing throws', async () => {
    const broken = new Error('out of memory');
    reader.openDocument.mockRejectedValueOnce(broken);
    await receive({ data: { id: 2, open: new ArrayBuffer(1) } });
    reader.extractPage.mockRejectedValueOnce(broken);
    await receive({ data: { id: 3, page: 1, ...ask } });
    render.drawPage.mockRejectedValueOnce(broken);
    await receive({ data: { id: 4, page: 1, ...ask } });
    expect(said().slice(1)).toEqual([2, 3, 4].map(id => ({ id, result: { ok: false, code: 'failed' } })));
  });

  it('answers failed when the answer cannot be sent', async () => {
    post.mockImplementationOnce(() => {
      throw new Error('it could not be cloned');
    });
    await receive({ data: { id: 2, page: 1, ...ask } });
    expect(said().at(-1)).toEqual({ id: 2, result: { ok: false, code: 'failed' } });
  });
});
