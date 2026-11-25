import { TIMEOUT_MS } from '../limits';
import type { ExtractedPage, OpenError } from './extract';

type Refusal = { ok: false; code: OpenError };
export type ReaderRequest = { open: ArrayBuffer } | { page: number };
export type PdfSession = {
  pageCount: number;
  extract(pageNo: number): Promise<{ ok: true; page: ExtractedPage } | Refusal>;
  close(): void;
};

/** The caller's buffer is copied to the worker, never transferred: the page picture and the project file need it too. */
export async function openPdf(bytes: ArrayBuffer): Promise<{ ok: true; session: PdfSession } | Refusal> {
  const worker = new Worker(new URL('./reader.worker.ts', import.meta.url), { type: 'module' });
  const waiting = new Map<number, (result: unknown) => void>();
  let lastId = 0;
  let ended: OpenError | null = null;

  const end = (code: OpenError) => {
    ended ??= code;
    worker.terminate(); // also what frees the memory pdf.js took
    for (const answer of waiting.values()) answer({ ok: false, code: ended });
  };
  worker.onerror = worker.onmessageerror = () => end('failed');
  // pdf.js posts messages of its own from this worker. They carry none of our ids.
  worker.onmessage = ({ data }) => waiting.get(data?.id)?.(data.result);

  const ask = <T>(request: ReaderRequest) =>
    new Promise<T | Refusal>(resolve => {
      if (ended) return resolve({ ok: false, code: ended });
      const id = ++lastId;
      const timer = setTimeout(() => end('timeout'), TIMEOUT_MS);
      waiting.set(id, result => {
        clearTimeout(timer);
        waiting.delete(id);
        resolve(result as T);
      });
      try {
        worker.postMessage({ id, ...request });
      } catch {
        end('failed'); // a detached buffer cannot be sent
      }
    });

  const opened = await ask<{ ok: true; pageCount: number }>({ open: bytes });
  if (!opened.ok) {
    end(opened.code);
    return opened;
  }
  return {
    ok: true,
    session: {
      pageCount: opened.pageCount,
      extract: page => ask<{ ok: true; page: ExtractedPage }>({ page }),
      close: () => end('failed'),
    },
  };
}
