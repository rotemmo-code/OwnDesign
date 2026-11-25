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
  const extracting = session.extract(2);
  expect(worker.sent[1]).toEqual([{ id: 2, page: 2 }]);
  const refused = { ok: false, code: 'image-only' };
  worker.says({ id: 2, result: refused });
  expect(await extracting).toEqual(refused);
  expect(worker.terminated).toBe(0); // another page may still be read
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
  const extracting = session.extract(1);
  await vi.advanceTimersByTimeAsync(TIMEOUT_MS);
  expect(await extracting).toEqual({ ok: false, code: 'timeout' });
  session.close();
  expect(await session.extract(1)).toEqual({ ok: false, code: 'timeout' });
});

it('a worker error is failed; close settles what is pending', async () => {
  for (const event of ['onerror', 'onmessageerror'] as const) {
    const opening = openPdf(new ArrayBuffer(8));
    StubWorker.last[event]();
    expect(await opening).toEqual({ ok: false, code: 'failed' });
    expect(StubWorker.last.terminated).toBeGreaterThan(0);
  }
  const { worker, session } = await opened();
  const pending = session.extract(1);
  session.close();
  expect(worker.terminated).toBe(1);
  expect(await pending).toEqual({ ok: false, code: 'failed' });
  expect(await session.extract(1)).toEqual({ ok: false, code: 'failed' });
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

it('a refusal ends the worker', async () => {
  const opening = openPdf(new ArrayBuffer(8));
  const worker = StubWorker.last;
  worker.says({ id: 1, result: { ok: false, code: 'locked' } });
  expect(await opening).toEqual({ ok: false, code: 'locked' });
  expect(worker.terminated).toBe(1);
});

// Node has no Web Worker, so the worker's own side is loaded here with a made-up global scope and a made-up reader.
describe('reader.worker', () => {
  const reader = { openDocument: vi.fn(), extractPage: vi.fn() };
  const post = vi.fn();
  let receive: (event: { data: unknown }) => Promise<void>;

  beforeEach(async () => {
    vi.resetModules();
    vi.resetAllMocks();
    vi.doMock('../../src/pdf/extract', () => reader);
    vi.doMock('pdfjs-dist/legacy/build/pdf.mjs', () => ({}));
    vi.doMock('pdfjs-dist/legacy/build/pdf.worker.mjs', () => ({}));
    vi.stubGlobal('location', { origin: 'https://example.invalid' });
    vi.stubGlobal('postMessage', post);
    vi.stubGlobal('addEventListener', (_type: string, listener: typeof receive) => {
      receive = listener;
    });
    await import('../../src/pdf/reader.worker');
  });
  afterEach(() => {
    vi.doUnmock('../../src/pdf/extract');
    vi.doUnmock('pdfjs-dist/legacy/build/pdf.mjs');
    vi.doUnmock('pdfjs-dist/legacy/build/pdf.worker.mjs');
  });

  it('opens a file and reads its pages', async () => {
    const doc = { numPages: 3 };
    reader.openDocument.mockResolvedValue({ ok: true, doc });
    await receive({ data: { id: 1, open: Uint8Array.of(7, 8).buffer } });
    expect(reader.openDocument).toHaveBeenCalledWith(expect.anything(), Uint8Array.of(7, 8), 'https://example.invalid/pdfjs/');
    reader.extractPage.mockResolvedValue({ ok: false, code: 'image-only' });
    await receive({ data: { id: 2, page: 3 } });
    expect(reader.extractPage).toHaveBeenCalledWith(expect.anything(), doc, 3);
    expect(post.mock.calls).toEqual([[{ id: 1, result: { ok: true, pageCount: 3 } }], [{ id: 2, result: { ok: false, code: 'image-only' } }]]);
  });

  it('passes a refusal on', async () => {
    reader.openDocument.mockResolvedValue({ ok: false, code: 'locked' });
    await receive({ data: { id: 1, open: new ArrayBuffer(1) } });
    expect(post.mock.calls).toEqual([[{ id: 1, result: { ok: false, code: 'locked' } }]]);
  });

  it('answers failed at once when opening or reading throws', async () => {
    reader.openDocument.mockRejectedValue(new Error('out of memory'));
    await receive({ data: { id: 1, open: new ArrayBuffer(1) } });
    reader.extractPage.mockRejectedValue(new Error('out of memory'));
    await receive({ data: { id: 2, page: 1 } });
    expect(post.mock.calls).toEqual([1, 2].map(id => [{ id, result: { ok: false, code: 'failed' } }]));
  });

  it('answers failed when the answer cannot be sent', async () => {
    reader.extractPage.mockResolvedValue({ ok: true });
    post.mockImplementationOnce(() => {
      throw new Error('it could not be cloned');
    });
    await receive({ data: { id: 3, page: 1 } });
    expect(post.mock.calls.at(-1)).toEqual([{ id: 3, result: { ok: false, code: 'failed' } }]);
  });
});
