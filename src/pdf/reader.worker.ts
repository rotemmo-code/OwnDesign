import type { PDFDocumentProxy } from 'pdfjs-dist';
import * as pdfjs from 'pdfjs-dist/legacy/build/pdf.mjs';
import 'pdfjs-dist/legacy/build/pdf.worker.mjs'; // sets globalThis.pdfjsWorker, so pdf.js runs its core on this thread
import { extractPage, openDocument } from './extract';
import type { ReaderRequest } from './openPdf';

const assets = new URL(`${import.meta.env.BASE_URL}pdfjs/`, location.origin).href;
let doc: PDFDocumentProxy;

addEventListener('message', async ({ data }: MessageEvent<{ id: number } & ReaderRequest>) => {
  if ('open' in data) {
    const opened = await openDocument(pdfjs, new Uint8Array(data.open), assets);
    if (opened.ok) doc = opened.doc;
    postMessage({ id: data.id, result: opened.ok ? { ok: true, pageCount: opened.doc.numPages } : opened });
  } else {
    postMessage({ id: data.id, result: await extractPage(pdfjs, doc, data.page) });
  }
});
