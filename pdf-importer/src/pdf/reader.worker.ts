import type { PDFDocumentProxy, PDFPageProxy } from 'pdfjs-dist';
import * as pdfjs from 'pdfjs-dist/legacy/build/pdf.mjs';
import 'pdfjs-dist/legacy/build/pdf.worker.mjs'; // sets globalThis.pdfjsWorker, so pdf.js runs its core on this thread
import { extractPage, openDocument } from './extract';
import type { ReaderRequest } from './openPdf';
import { DRAWING, drawPage } from './render';

const assets = new URL(`${import.meta.env.BASE_URL}pdfjs/`, location.origin).href;
let bytes: Uint8Array;
let doc: PDFDocumentProxy;
let drawn: PDFDocumentProxy | undefined; // the same file with its images: reading decodes none
let page: PDFPageProxy | undefined; // of it, the one on the screen

async function answer(request: ReaderRequest) {
  if ('box' in request) return drawPage(pdfjs, drawn!, page!, request.box, request.scale);
  if ('page' in request) {
    const read = await extractPage(pdfjs, doc, request.page);
    if (!read.ok) return read;
    if (!drawn) {
      const opened = await openDocument(pdfjs, bytes, assets, DRAWING);
      if (!opened.ok) return opened;
      drawn = opened.doc;
    }
    page?.cleanup();
    page = await drawn.getPage(request.page);
    const { widthPt, heightPt } = read.page;
    const whole = await drawPage(pdfjs, drawn, page, [0, 0, widthPt, heightPt], Math.min(request.width / widthPt, request.height / heightPt));
    return whole.ok ? { ...read, picture: whole.picture } : whole;
  }
  bytes = new Uint8Array(request.open);
  const opened = await openDocument(pdfjs, bytes, assets);
  if (!opened.ok) return opened;
  doc = opened.doc;
  return { ok: true, pageCount: doc.numPages };
}

async function respond(data: { id: number } & ReaderRequest) {
  try {
    const result = await answer(data);
    postMessage({ id: data.id, result }, { transfer: 'picture' in result ? [result.picture.bitmap] : [] }); // moved, not copied
  } catch {
    postMessage({ id: data.id, result: { ok: false, code: 'failed' } });
  }
}

let last = Promise.resolve();
// One after the other, so that the page drawn is always the one asked for last.
addEventListener('message', ({ data }: MessageEvent<{ id: number } & ReaderRequest>) => (last = last.then(() => respond(data))));
