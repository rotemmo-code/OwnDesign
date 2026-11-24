import { existsSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import * as pdfjs from 'pdfjs-dist/legacy/build/pdf.mjs';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { MIN_VECTOR_PATHS } from '../../src/limits';
import { PLAN_ORIGIN, PLAN_PAGE, planPdf, rawPdf } from '../fixtures/makePdf';
import { ALL_16_PAGES, describeSamples, samplePath } from '../samples';

type Pt = [number, number];
type Painted = { fill: boolean; color: string; layer: string | null; subpaths: Pt[][] };
const { OPS, Util } = pdfjs;

/** What pdf.js sees, in view points. Reads just what planPdf uses; the product's reader is src/pdf/extract.ts. */
async function read(bytes: Uint8Array, pageNo = 1) {
  const doc = await pdfjs.getDocument({ data: bytes, useSystemFonts: false, useWasm: false }).promise;
  const page = await doc.getPage(pageNo);
  const { width, height, transform } = page.getViewport({ scale: 1 });
  const groups = await doc.getOptionalContentConfig();
  const { fnArray, argsArray } = await page.getOperatorList();
  const painted: Painted[] = [];
  let ctm: number[] = transform;
  let color = '';
  let layer: string | null = null;
  fnArray.forEach((fn, i) => {
    const args = argsArray[i];
    if (fn === OPS.transform) ctm = Util.transform(ctm, args);
    else if (fn === OPS.setFillRGBColor) color = args[0];
    else if (fn === OPS.beginMarkedContentProps) layer = groups.getGroup(args[1].id).name;
    else if (fn === OPS.endMarkedContent) layer = null;
    else if (fn === OPS.constructPath) {
      const data: Float32Array = args[1][0];
      const subpaths: Pt[][] = [];
      for (let at = 0; at < data.length; ) {
        const op = data[at++];
        if (op === 0) subpaths.push([]);
        for (let n = [1, 1, 3, 2, 0][op]; n > 0; n--) {
          const p: Pt = [data[at++], data[at++]];
          Util.applyTransform(p, ctm);
          subpaths.at(-1)!.push(p);
        }
      }
      painted.push({ fill: args[0] === OPS.fill, color, layer, subpaths });
    }
  });
  return { pageCount: doc.numPages, size: [width, height], painted, layers: [...groups].map(([, g]) => g.name as string) };
}

const mm = (scale = 50) => (p: Pt) => p.map((v, i) => Math.round((v - PLAN_ORIGIN[i]) * ((scale * 25.4) / 72) * 100) / 100 + 0) as Pt;
const box = (pts: Pt[]) => [Math.min(...pts.map(p => p[0])), Math.min(...pts.map(p => p[1])), Math.max(...pts.map(p => p[0])), Math.max(...pts.map(p => p[1]))];
const walls = (page: { painted: Painted[] }) => page.painted.filter(p => p.fill);
const points = (page: { painted: Painted[] }) => page.painted.flatMap(p => p.subpaths.flat());

// [left, top, right, bottom] in mm from the apartment's outer top-left corner
const WALLS = [
  [[0, 0, 1100, 200], [2300, 0, 6400, 200]], // top, window 1100-2300
  [[0, 4200, 4300, 4400], [5200, 4200, 6400, 4400]], // bottom, entry door 4300-5200
  [[0, 200, 200, 4200]], // left
  [[6200, 200, 6400, 4200]], // right
  [[3200, 200, 3300, 1200], [3200, 2000, 3300, 4200]], // partition, door 1200-2000
];

describe('planPdf', () => {
  it('planPdf starts with %PDF- and is under 50 KB', () => {
    const bytes = planPdf();
    expect(Buffer.from(bytes.subarray(0, 5)).toString()).toBe('%PDF-');
    expect(bytes.length).toBeLessThan(50 * 1024);
    expect(Buffer.isBuffer(bytes)).toBe(false); // pdf.js refuses a Node Buffer
  });

  it.each([50, 100, 122.5])('at 1:%d: five gray fills, one per wall, open at the door, entry and window', async scale => {
    const fills = walls(await read(planPdf({ scale })));
    expect(fills.map(f => f.color)).toEqual(Array(5).fill('#808080'));
    expect(fills.map(f => f.subpaths.map(s => box(s.map(mm(scale)))))).toEqual(WALLS);
  });

  it('room A is 3000 x 4000 (12.00 m2) and room B is 2900 x 4000 (11.60 m2)', async () => {
    const [top, bottom, left, right, partition] = walls(await read(planPdf())).map(f => box(f.subpaths.flat().map(mm())));
    const depth = bottom[1] - top[3];
    expect([partition[0] - left[2], right[0] - partition[2], depth]).toEqual([3000, 2900, 4000]);
    expect([(partition[0] - left[2]) * depth, (right[0] - partition[2]) * depth]).toEqual([12_000_000, 11_600_000]);
  });

  it('each door is a quarter circle as wide as its gap and the window is two lines across its gap', async () => {
    const { painted } = await read(planPdf({ layers: true }));
    const on = (layer: string) => painted.filter(p => p.layer === layer).map(p => p.subpaths[0].map(mm()));
    expect(on('window').map(box)).toEqual([[1100, 50, 2300, 50], [1100, 150, 2300, 150]]);
    const doors = on('door');
    expect(doors.map(box)).toEqual([[2400, 1200, 3200, 2000], [4300, 3300, 5200, 4200]]);
    [{ hinge: [3200, 1200], width: 800, jamb: [3200, 2000] }, { hinge: [4300, 4200], width: 900, jamb: [5200, 4200] }].forEach(({ hinge, width, jamb }, i) => {
      const [a, b, c, d] = doors[i];
      const middle = [0, 1].map(n => (a[n] + 3 * b[n] + 3 * c[n] + d[n]) / 8);
      for (const p of [a, middle, d]) expect(Math.abs(Math.hypot(p[0] - hinge[0], p[1] - hinge[1]) - width)).toBeLessThan(1);
      expect([a, d]).toContainEqual(jamb);
    });
  });

  it('a frame and at least 60 ticks stand outside the apartment, unfilled, above MIN_VECTOR_PATHS', async () => {
    const { painted } = await read(planPdf({ layers: true }));
    const sheet = painted.filter(p => p.layer === null);
    expect(sheet.length).toBeGreaterThanOrEqual(61);
    expect(painted.length).toBeGreaterThanOrEqual(MIN_VECTOR_PATHS);
    expect(sheet.filter(p => p.fill)).toEqual([]);
    const inside = sheet.flatMap(p => p.subpaths.flat().map(mm())).filter(([x, y]) => x >= 0 && x <= 6400 && y >= 0 && y <= 4400);
    expect(inside).toEqual([]);
    const [w, h] = PLAN_PAGE;
    expect(points({ painted }).filter(([x, y]) => x < 0 || x > w || y < 0 || y > h)).toEqual([]);
  });

  const [W, H] = PLAN_PAGE;
  it.each<[0 | 90 | 180 | 270, (p: Pt) => Pt]>([
    [0, ([x, y]) => [x, y]],
    [90, ([x, y]) => [H - y, x]],
    [180, ([x, y]) => [W - x, H - y]],
    [270, ([x, y]) => [y, W - x]],
  ])('rotate %i and a MediaBox from 100,200: every point turns with the page and nothing shifts', async (rotate, turn) => {
    const flat = points(await read(planPdf()));
    const page = await read(planPdf({ rotate, mediaBoxOrigin: [100, 200] }));
    expect(page.size).toEqual(rotate % 180 ? [H, W] : [W, H]);
    const turned = points(page);
    expect(turned).toHaveLength(flat.length);
    const off = flat.map((p, i) => Math.hypot(turn(p)[0] - turned[i][0], turn(p)[1] - turned[i][1]));
    expect(Math.max(...off)).toBeLessThan(0.01);
  });

  it('has no layers by default, and layers: true puts walls, doors and window on their own', async () => {
    const count = (page: { painted: Painted[] }, layer: string | null, fill: boolean) => page.painted.filter(p => p.layer === layer && p.fill === fill).length;
    const plain = await read(planPdf());
    expect(plain.layers).toEqual([]);
    expect(Buffer.from(planPdf()).includes('/OC')).toBe(false);
    expect(plain.painted.every(p => p.layer === null)).toBe(true);
    const layered = await read(planPdf({ layers: true }));
    expect(layered.layers).toEqual(['hatch walls', 'door', 'window']);
    expect([count(layered, 'hatch walls', true), count(layered, 'door', false), count(layered, 'window', false)]).toEqual([5, 2, 2]);
    expect(count(layered, null, true)).toBe(0);
  });

  it('layers as an object renames them; an omitted name leaves those strokes drawn but on no layer', async () => {
    const name = 'שכבה <img src=x onerror=alert(1)> \\';
    const page = await read(planPdf({ layers: { walls: name, windows: 'W' } }));
    expect(page.layers).toEqual([name, 'W']);
    expect(walls(page).map(p => p.layer)).toEqual(Array(5).fill(name));
    expect(page.painted).toHaveLength((await read(planPdf())).painted.length);
    expect(page.painted.filter(p => p.layer === null && p.subpaths[0].length === 4 && box(p.subpaths[0].map(mm()))[0] === 2400)).toHaveLength(1);
  });

  it('pages repeats the page', async () => {
    const last = await read(planPdf({ pages: 3 }), 3);
    expect(last.pageCount).toBe(3);
    expect(points(last)).toEqual(points(await read(planPdf())));
  });
});

describe('rawPdf', () => {
  const objects = ['<</Type/Catalog/Pages 2 0 R>>', '<</Type/Pages/Count 0/Kids[]>>', '<<>>\n', '<</Length 2 0 R>>'];
  const data = Uint8Array.of(0, 255, 13, 10, 128, 41);
  const bytes = rawPdf(objects, { 3: data, 4: data });
  const text = Buffer.from(bytes).toString('latin1');

  it('keeps stream bytes as given and adds /Length only where the dictionary has none', () => {
    const stream = `\nstream\n${Buffer.from(data).toString('latin1')}\nendstream\nendobj\n`;
    expect(text).toContain(`3 0 obj\n<</Length 6>>${stream}`);
    expect(text).toContain(`4 0 obj\n<</Length 2 0 R>>${stream}`);
  });

  it('writes a cross-reference table that points at every object', () => {
    const start = Number(/startxref\n(\d+)\n%%EOF/.exec(text)![1]);
    const [keyword, head, ...entries] = text.slice(start).split('\n').slice(0, objects.length + 3);
    expect([keyword, head]).toEqual(['xref', '0 5']);
    expect(entries[0]).toBe('0000000000 65535 f ');
    entries.slice(1).forEach((entry, i) => {
      expect(entry).toMatch(/^\d{10} 00000 n $/);
      expect(text.slice(Number(entry.slice(0, 10)))).toMatch(new RegExp(`^${i + 1} 0 obj\n`));
    });
  });
});

describe('samples helper', () => {
  let dir: string;
  beforeEach(() => {
    dir = mkdtempSync(path.join(tmpdir(), 'תיקייה עם רווח '));
    vi.resetModules();
    vi.stubEnv('ETELIER_SAMPLES', dir);
  });
  afterEach(() => {
    vi.unstubAllEnvs();
    rmSync(dir, { recursive: true });
  });

  it('reads file names and pages from the manifest in ETELIER_SAMPLES, spaces and Hebrew included', async () => {
    writeFileSync(path.join(dir, 'manifest.json'), JSON.stringify({ S16: { file: 'קובץ ב.pdf', page: 2 } }));
    const samples = await import('../samples');
    expect(samples).toMatchObject({ SAMPLES_DIR: dir, hasSamples: true });
    expect(samples.samplePath('S16')).toBe(path.join(dir, 'קובץ ב.pdf'));
    expect(samples.samplePage('S16')).toBe(2);
    expect(samples.describeSamples).toBe(describe);
  });

  it('counts a missing manifest as samples absent', async () => {
    const samples = await import('../samples');
    expect(samples.hasSamples).toBe(false);
    expect(samples.describeSamples).not.toBe(describe);
  });

  it('falls back to samples/ in the repository', async () => {
    vi.stubEnv('ETELIER_SAMPLES', '');
    expect((await import('../samples')).SAMPLES_DIR).toBe(path.join(import.meta.dirname, '..', '..', 'samples'));
  });

  it('lists the 16 ids', () => {
    expect(ALL_16_PAGES).toHaveLength(16);
    expect([ALL_16_PAGES[0], ALL_16_PAGES[15]]).toEqual(['S01', 'S16']);
  });
});

describeSamples('samples', () => {
  it('every sample id names a file that exists', () => {
    expect(ALL_16_PAGES.filter(id => !existsSync(samplePath(id)))).toEqual([]);
  });
});
