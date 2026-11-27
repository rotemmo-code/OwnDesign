// How well a click on a wall's centre line lands (Task 11a, R3). Numbers only: no name, text or picture of a sample.
import { readFileSync } from 'node:fs';
import * as pdfjs from 'pdfjs-dist/legacy/build/pdf.mjs';
import { it } from 'vitest';
import { snapCentre, snapIndex, type SnapIndex } from '../../src/editor/snap';
import { type ExtractedPage, extractPage, openDocument } from '../../src/pdf/extract';
import type { Vec } from '../../src/shared';
import { dimsPdf } from '../fixtures/dims';
import { ALL_16_PAGES, hasSamples, samplePage, samplePath } from '../samples';

const K = (50 * 25.4) / 72; // mm per pt at 1:50; every sample is read as 1:50
const VIEW = [1093, 700]; // the editor's frame at 1445 x 860, CSS px
const ZOOM_IN = 3.7; // the wheel zoom a designer uses before marking

async function read(bytes: Uint8Array, page: number): Promise<ExtractedPage> {
  const opened = await openDocument(pdfjs, bytes);
  if (!opened.ok) throw new Error(opened.code);
  const out = await extractPage(pdfjs, opened.doc, page);
  if (!out.ok) throw new Error(out.code);
  return out.page;
}

/**
 * The truth, by a fixed rule: among the edges of filled shapes (rings or triangles), one 30 to 600 mm long with an edge
 * leaving each of its ends square to it and to the same side closes a wall's end; its middle is the true centre-line
 * end. The point of the centre line min(1 m, half the shorter face edge) into the wall is the true centre inside. Taken
 * in reading order, 20 spread evenly.
 */
function truth(page: ExtractedPage) {
  type E = { a: Vec; b: Vec; l: number; u: Vec };
  const edges: E[] = [];
  for (const path of page.paths)
    if (path.fill)
      for (const { pts } of path.subpaths)
        pts.forEach((a, i) => {
          const b = pts[(i + 1) % pts.length];
          const l = Math.hypot(b[0] - a[0], b[1] - a[1]);
          if (l) edges.push({ a, b, l, u: [(b[0] - a[0]) / l, (b[1] - a[1]) / l] });
        });
  const key = (q: Vec) => `${Math.round(q[0] * 2)},${Math.round(q[1] * 2)}`;
  const at = new Map<string, E[]>();
  for (const e of edges) for (const q of [e.a, e.b]) at.set(key(q), [...(at.get(key(q)) ?? []), e]);
  const walls: { end: Vec; inside: Vec; u: Vec }[] = [];
  const seen = new Set<string>();
  for (const e of edges) {
    if (e.l * K < 30 || e.l * K > 600) continue;
    const leave = (q: Vec) =>
      (at.get(key(q)) ?? []).flatMap(f => {
        if (f === e) return [];
        const far = Math.hypot(f.a[0] - q[0], f.a[1] - q[1]) <= 0.5 ? f.b : Math.hypot(f.b[0] - q[0], f.b[1] - q[1]) <= 0.5 ? f.a : null;
        if (!far) return [];
        const l = Math.hypot(far[0] - q[0], far[1] - q[1]);
        if (l * K < 30) return []; // a face is no sliver
        const v: Vec = [(far[0] - q[0]) / l, (far[1] - q[1]) / l];
        return Math.abs(v[0] * e.u[0] + v[1] * e.u[1]) <= 0.035 ? [{ v, l, side: Math.sign(e.u[0] * v[1] - e.u[1] * v[0]) }] : [];
      });
    const [fa, fb] = [leave(e.a), leave(e.b)];
    const pair = fa.flatMap(x => fb.filter(y => y.side === x.side).map(y => [x, y] as const))[0];
    if (!pair) continue;
    const end: Vec = [(e.a[0] + e.b[0]) / 2, (e.a[1] + e.b[1]) / 2];
    if (seen.has(key(end))) continue;
    seen.add(key(end));
    const into = Math.min(1000 / K, Math.min(pair[0].l, pair[1].l) / 2);
    walls.push({ end, inside: [end[0] + pair[0].v[0] * into, end[1] + pair[0].v[1] * into], u: pair[0].v });
  }
  walls.sort((p, q) => Math.round(p.end[1]) - Math.round(q.end[1]) || p.end[0] - q.end[0]);
  const n = Math.min(20, walls.length);
  return { found: walls.length, picked: Array.from({ length: n }, (_, i) => walls[Math.floor((i * walls.length) / n)]) };
}

type Variant = { name: string; index: (page: ExtractedPage) => SnapIndex; between: boolean } | { name: 'free' };
const fills = (page: ExtractedPage) => snapIndex({ ...page, paths: page.paths.filter(p => p.fill) });
const VARIANTS: Variant[] = [
  { name: 'free' },
  { name: 'end edges (fills)', index: fills, between: false },
  { name: 'end edges + midway (fills)', index: fills, between: true },
  { name: 'end edges + midway (all lines)', index: page => snapIndex(page), between: true },
];

function measure(label: string, page: ExtractedPage) {
  const { found, picked } = truth(page);
  const rows: string[] = [];
  const whole = Math.min(VIEW[0] / page.widthPt, VIEW[1] / page.heightPt); // px per pt
  for (const variant of VARIANTS) {
    const index = 'index' in variant ? variant.index(page) : null;
    for (const [view, scale] of [['whole page', whole], ['zoomed in', whole * ZOOM_IN]] as const) {
      const radius = 8 / scale;
      const errEnd: number[] = [];
      const errIn: number[] = [];
      let wrong = 0;
      let trials = 0;
      for (const w of picked) {
        const n: Vec = [-w.u[1], w.u[0]];
        // the click itself, and 3 px off in each of four directions
        const offs: Vec[] = [[0, 0], [n[0] * 3, n[1] * 3], [-n[0] * 3, -n[1] * 3], [w.u[0] * 3, w.u[1] * 3], [-w.u[0] * 3, -w.u[1] * 3]];
        for (const o of offs) {
          const shift = (q: Vec): Vec => [q[0] + o[0] / scale, q[1] + o[1] / scale];
          const land = (q: Vec) => (index ? snapCentre(q, index, radius, K, [], (variant as { between: boolean }).between) : { at: q, to: null });
          {
            const s = land(shift(w.end));
            const e = Math.hypot(s.at[0] - w.end[0], s.at[1] - w.end[1]) * K;
            errEnd.push(e);
            trials++;
            if (s.to && e > 5) wrong++;
          }
          const s = land(shift(w.inside));
          const across = Math.abs((s.at[0] - w.inside[0]) * n[0] + (s.at[1] - w.inside[1]) * n[1]) * K;
          errIn.push(across);
          trials++;
          if (s.to && across > 5) wrong++;
        }
      }
      const stat = (xs: number[]) => {
        const sorted = [...xs].sort((a, b) => a - b);
        return `median ${sorted[Math.floor(sorted.length / 2)].toFixed(1)}, 90% ${sorted[Math.floor(sorted.length * 0.9)].toFixed(1)}, max ${sorted.at(-1)!.toFixed(1)}, mean ${(xs.reduce((a, b) => a + b, 0) / xs.length).toFixed(1)}`;
      };
      if (picked.length)
        rows.push(`${label} | ${variant.name} | ${view} | ends (mm): ${stat(errEnd)} | across the wall inside (mm): ${stat(errIn)} | caught something else: ${wrong}/${trials}`);
    }
  }
  console.log(`${label}: ${found} wall ends found, ${picked.length} used`);
  for (const r of rows) console.log(r);
}

it('the synthetic fixture', async () => {
  measure('fixture', await read(dimsPdf(), 1));
}, 120_000);

it.skipIf(!hasSamples)('the real samples (ids only)', async () => {
  for (const id of ALL_16_PAGES) {
    let page: ExtractedPage;
    try {
      page = await read(new Uint8Array(readFileSync(samplePath(id))), samplePage(id));
    } catch {
      console.log(`${id}: not read`);
      continue;
    }
    measure(id, page);
  }
}, 600_000);
