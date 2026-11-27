// Runs in the reader worker only: pdf.js draws on an OffscreenCanvas, beside its reading.
import type { PDFDocumentProxy, PDFPageProxy } from 'pdfjs-dist';
import { MAX_IMAGE_PIXELS } from '../limits';
import { layerTracker, type OpenError } from './extract';

type Pdfjs = typeof import('pdfjs-dist');
/** View points. */
export type Box = [left: number, top: number, width: number, height: number];
/** The pixels, and exactly what they cover. */
export type Picture = { bitmap: ImageBitmap; box: Box };

/** The factories of pdf.js need a document, and a worker has none. */
class CanvasFactory {
  create(width: number, height: number) {
    const canvas = new OffscreenCanvas(width, height);
    return { canvas, context: canvas.getContext('2d', { willReadFrequently: true }) };
  }
  reset({ canvas }: { canvas: OffscreenCanvas }, width: number, height: number) {
    canvas.width = width;
    canvas.height = height;
  }
  destroy(entry: { canvas: OffscreenCanvas | null; context: unknown }) {
    if (entry.canvas) entry.canvas.width = entry.canvas.height = 0; // gives the memory back at once
    entry.canvas = entry.context = null;
  }
  getNoAlphaContext(canvas: OffscreenCanvas) {
    return canvas.getContext('2d', { alpha: false, willReadFrequently: true });
  }
}
const none = () => 'none';
/** Without SVG filters pdf.js works masks and transfer functions out by itself. */
class FilterFactory {
  addFilter = none;
  addAlphaFilter = none;
  addLuminosityFilter = none;
  addKnockoutFilter = none;
  destroy() {}
}
/**
 * What a document that is drawn is opened with, besides the options of one that is read. It is drawn on this thread: on pdf.js's
 * own renderer worker the operators would be sent away before operationsFilter could mend them.
 */
export const DRAWING = { maxImageSize: MAX_IMAGE_PIXELS, CanvasFactory, FilterFactory, disableWorkerRendering: true };

const EVERYWHERE = Float32Array.of(-1e9, -1e9, 1e9, 1e9); // a path's box that meets every clip

/** Draws a box of the page at scale pixels per point, or at less when that is more than MAX_IMAGE_PIXELS, in the file's own colours. */
export async function drawPage(
  pdfjs: Pdfjs,
  doc: PDFDocumentProxy,
  page: PDFPageProxy,
  [x, y, width, height]: Box,
  scale: number,
): Promise<{ ok: true; picture: Picture } | { ok: false; code: OpenError }> {
  const { OPS, AnnotationMode } = pdfjs;
  try {
    const fits = Math.min(scale, Math.sqrt(MAX_IMAGE_PIXELS / (width * height)));
    // two sides rounded up can pass MAX_IMAGE_PIXELS by a row (seen at 2400 x 1500 at density 3): then both go down
    const over = Math.round(width * fits) * Math.round(height * fits) > MAX_IMAGE_PIXELS;
    const whole = over ? Math.floor : Math.round;
    const canvas = new OffscreenCanvas(Math.max(1, whole(width * fits)), Math.max(1, whole(height * fits)));
    const layerOf = layerTracker(pdfjs, await doc.getOptionalContentConfig());
    const evenOdds = [OPS.eoFill, OPS.eoFillStroke, OPS.closeEOFillStroke];
    await page.render({
      canvas: canvas as unknown as HTMLCanvasElement,
      viewport: page.getViewport({ scale: fits, offsetX: -x * fits, offsetY: -y * fits }),
      annotationMode: AnnotationMode.DISABLE,
      // Takes out what pdf.js would draw wrongly, see layerTracker.
      operationsFilter: (i, { fnArray, argsArray }) => {
        const [op, args] = [fnArray[i], argsArray[i]];
        const at = layerOf(op, args);
        if (at === 'left out') return false;
        if (op === OPS.constructPath) {
          // An even-odd fill that shows nothing would make the next fill even-odd too.
          if (at === 'hidden') args[0] = OPS.endPath;
          else if (evenOdds.includes(args[0]) && args[2]) args[2] = EVERYWHERE;
        } else if (op === OPS.setGState) {
          // pdf.js stops at a dash that is no list, such as null; extractPage reads it as no dash
          args[0] = args[0].map(([key, value]: [string, any]) => [key, key === 'D' && !Array.isArray(value?.[0]) ? [[], 0] : value]);
        }
        return true;
      },
    }).promise;
    return { ok: true, picture: { box: [x, y, canvas.width / fits, canvas.height / fits], bitmap: canvas.transferToImageBitmap() } };
  } catch {
    return { ok: false, code: 'corrupt' };
  }
}
