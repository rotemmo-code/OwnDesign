import { TIMEOUT_MS } from '../limits';
import type { ExtractedPage, OpenError } from './extract';
import type { Box, Picture } from './render';

type Refusal = { ok: false; code: OpenError };
export type ReaderRequest = { open: ArrayBuffer } | { page: number; width: number; height: number } | { box: Box; scale: number };
export type PdfSession = {
  pageCount: number;
  /** Reads a page and draws it whole, to fit width x height screen pixels. One time limit for both. */
  show(pageNo: number, width: number, height: number): Promise<{ ok: true; page: ExtractedPage; picture: Picture } | Refusal>;
  /** Draws a part of the page shown last, at scale screen pixels per point. */
  draw(box: Box, scale: number): Promise<{ ok: true; picture: Picture } | Refusal>;
  close(): void;
};

/**
 * The caller's buffer is copied to the worker, never transferred: the page picture and the project file need it too.
 * An abort ends the worker at once, also before it has answered; what is still open then answers failed.
 */
export async function openPdf(bytes: ArrayBuffer, signal?: AbortSignal): Promise<{ ok: true; session: PdfSession } | Refusal> {
  const worker = new Worker(new URL('./reader.worker.ts', import.meta.url), { type: 'module' });
  const waiting = new Map<number, (result: unknown) => void>();
  let lastId = 0;
  let ended: OpenError | null = null;

  const end = (code: OpenError) => {
    if (ended) return;
    ended = code;
    worker.terminate(); // also what frees the memory pdf.js took
    for (const answer of waiting.values()) answer({ ok: false, code: ended });
  };
  worker.onerror = worker.onmessageerror = () => end('failed');
  signal?.addEventListener('abort', () => end('failed'));
  if (signal?.aborted) end('failed'); // the next file came while this one was still being read
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
      show: (page, width, height) => ask<{ ok: true; page: ExtractedPage; picture: Picture }>({ page, width, height }),
      draw: (box, scale) => ask<{ ok: true; picture: Picture }>({ box, scale }),
      close: () => end('failed'),
    },
  };
}
