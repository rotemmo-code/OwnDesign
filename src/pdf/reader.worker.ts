import type { PDFDocumentProxy } from 'pdfjs-dist';
import * as pdfjs from 'pdfjs-dist/legacy/build/pdf.mjs';
import 'pdfjs-dist/legacy/build/pdf.worker.mjs'; // sets globalThis.pdfjsWorker, so pdf.js runs its core on this thread
import { extractPage, openDocument } from './extract';
import type { ReaderRequest } from './openPdf';

const assets = new URL(`${import.meta.env.BASE_URL}pdfjs/`, location.origin).href;
let doc: PDFDocumentProxy;

async function answer(request: ReaderRequest) {
  if ('page' in request) return extractPage(pdfjs, doc, request.page);
  const opened = await openDocument(pdfjs, new Uint8Array(request.open), assets);
  if (!opened.ok) return opened;
  doc = opened.doc;
  return { ok: true, pageCount: doc.numPages };
}

addEventListener('message', async ({ data }: MessageEvent<{ id: number } & ReaderRequest>) => {
  try {
    postMessage({ id: data.id, result: await answer(data) });
  } catch {
    postMessage({ id: data.id, result: { ok: false, code: 'failed' } });
  }
});
