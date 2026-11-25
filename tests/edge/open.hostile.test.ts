import * as pdfjs from 'pdfjs-dist/legacy/build/pdf.mjs';
import { expect, it } from 'vitest';
import { MAX_FILE_BYTES } from '../../src/limits';
import { checkPdfBytes, extractPage, openDocument, type OpenError } from '../../src/pdf/extract';
import { bytes, encryptedPdf, imageOnly, jsAction, manyPaths, onePage, ticks, truncated } from '../fixtures/hostile';
import { planPdf, rawPdf } from '../fixtures/makePdf';

async function read(pdf: Uint8Array, pageNo = 1) {
  const opened = await openDocument(pdfjs, pdf);
  return opened.ok ? extractPage(pdfjs, opened.doc, pageNo) : opened;
}

async function pathCount(pdf: Uint8Array, pageNo = 1) {
  const extracted = await read(pdf, pageNo);
  return extracted.ok ? extracted.page.paths.length : extracted.code;
}

it.each<[string, OpenError, () => Uint8Array, number?]>([
  ['empty', 'empty', () => new Uint8Array(0)],
  ['one byte over 20 MB of zeros', 'too-large', () => new Uint8Array(MAX_FILE_BYTES + 1)],
  ['20 MB of zeros', 'not-pdf', () => new Uint8Array(MAX_FILE_BYTES)],
  ['MZ not a pdf', 'not-pdf', () => bytes('MZ not a pdf')],
  ['<html>', 'not-pdf', () => bytes('<html><script>alert(1)</script>')],
  ['%PDF- at byte 1020', 'not-pdf', () => bytes(`${' '.repeat(1020)}%PDF-1.7`)],
  ['truncated', 'corrupt', truncated],
  ['needs a password', 'locked', () => encryptedPdf('secret')],
  ['21 pages', 'too-many-pages', () => planPdf({ pages: 21 })],
  ['one image', 'image-only', imageOnly],
  ['49 paths', 'image-only', () => onePage(ticks(49))],
  ['100,001 paths', 'too-complex', () => manyPaths(100_001)],
  ['120,000 paths', 'too-complex', () => manyPaths(120_000)],
  ['1,500 clips inside each other', 'too-complex', () => onePage(`${'0 0 600 400 re W n '.repeat(1500)}${ticks(60)}`)],
  ['page 2 of one page', 'corrupt', planPdf, 2],
])('%s -> %s', async (_name, code, pdf, pageNo) => {
  expect(await read(pdf(), pageNo)).toEqual({ ok: false, code });
});

it('the edges that open', async () => {
  expect(checkPdfBytes(bytes(`${' '.repeat(1019)}%PDF-`))).toBeNull();
  expect(await pathCount(onePage(ticks(50)))).toBe(50);
  expect(await pathCount(manyPaths(100_000))).toBe(100_000);
  expect(await pathCount(onePage(`${'0 0 m 1 1 l S '.repeat(100_000)}0 0 m 1 1 l n`))).toBe(100_000); // n paints nothing
  expect(await pathCount(onePage(`${'0 0 600 400 re W n '.repeat(1000)}${ticks(60)}`))).toBe(60); // clips inside each other
  expect(await pathCount(planPdf({ pages: 20 }), 20)).toBe(70);
  expect(await pathCount(encryptedPdf(''))).toBe(60);
});

it('a refused page leaves the other pages readable', async () => {
  const page = (content: number) => `<</Type/Page/Parent 2 0 R/MediaBox[0 0 600 400]/Contents ${content} 0 R/Resources<<>>>>`;
  const opened = await openDocument(
    pdfjs,
    rawPdf(['<</Type/Catalog/Pages 2 0 R>>', '<</Type/Pages/Count 2/Kids[3 0 R 4 0 R]>>', page(5), page(6), '<<>>', '<<>>'], { 5: bytes(ticks(1)), 6: bytes(ticks(60)) }),
  );
  if (!opened.ok) throw new Error(opened.code);
  expect(await extractPage(pdfjs, opened.doc, 1)).toEqual({ ok: false, code: 'image-only' });
  expect((await extractPage(pdfjs, opened.doc, 2)).ok).toBe(true);
});

it('JavaScript in the file never runs', async () => {
  expect(await pathCount(jsAction())).toBe(60);
  expect('pwned' in globalThis).toBe(false);
});
