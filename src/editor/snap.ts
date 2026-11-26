import type { ExtractedPage } from '../pdf/extract';
import type { Vec } from '../shared';

/** What a point was snapped to: the end of a line, a crossing of two, a point on one, or nothing (the point itself). */
export type Snap = { at: Vec; to: 'end' | 'cross' | 'line' | null };
/**
 * The page's straight pieces in a grid, built once per page. seg: ax, ay, bx, by of each piece; clipOf: its clip; clipBox: left, top,
 * right, bottom of each clip; first and items: the pieces of each cell (CSR); seen and stamp: to visit each piece once per query.
 */
export type SnapIndex = {
  seg: Float64Array;
  clipOf: Int32Array;
  clipBox: Float64Array;
  first: Int32Array;
  items: Int32Array;
  cols: number;
  rows: number;
  seen: Uint32Array;
  stamp: number;
};

const CELL = 8; // points
const NEAREST = 256; // at most this many pieces near the point are crossed with each other, so a crowded spot stays fast

const clamp = (value: number, count: number) => Math.max(0, Math.min(count - 1, value));

export function snapIndex(page: ExtractedPage): SnapIndex {
  // The box of a clip list is where all its clips meet; a clip with no point clips to nothing.
  const clipBox = new Float64Array(page.clips.length * 4);
  page.clips.forEach((list, c) => {
    let [left, top, right, bottom] = [-Infinity, -Infinity, Infinity, Infinity];
    for (const { rings } of list) {
      const pts = rings.flat();
      if (!pts.length) [left, top, right, bottom] = [1, 1, 0, 0];
      for (const axis of [0, 1]) {
        const values = pts.map(p => p[axis]);
        const [low, high] = [Math.min(...values), Math.max(...values)];
        if (axis === 0) [left, right] = [Math.max(left, low), Math.min(right, high)];
        else [top, bottom] = [Math.max(top, low), Math.min(bottom, high)];
      }
    }
    clipBox.set([left, top, right, bottom], c * 4);
  });

  const flat: number[] = [];
  const clips: number[] = [];
  for (const path of page.paths)
    for (const { pts, closed } of path.subpaths) {
      const sides = closed || path.fill ? pts.length : pts.length - 1; // a fill closes itself
      for (let i = 0; i < sides; i++) {
        const [[ax, ay], [bx, by]] = [pts[i], pts[(i + 1) % pts.length]];
        if (ax === bx && ay === by) continue;
        flat.push(ax, ay, bx, by);
        clips.push(path.clipId);
      }
    }
  const seg = Float64Array.from(flat);
  const count = clips.length;
  const cols = Math.max(1, Math.ceil(page.widthPt / CELL));
  const rows = Math.max(1, Math.ceil(page.heightPt / CELL));
  const cellsOf = (s: number, visit: (cell: number) => void) => {
    const [x0, y0, x1, y1] = seg.subarray(s * 4, s * 4 + 4);
    const [c0, c1] = [clamp(Math.floor(Math.min(x0, x1) / CELL), cols), clamp(Math.floor(Math.max(x0, x1) / CELL), cols)];
    const [r0, r1] = [clamp(Math.floor(Math.min(y0, y1) / CELL), rows), clamp(Math.floor(Math.max(y0, y1) / CELL), rows)];
    for (let r = r0; r <= r1; r++) for (let c = c0; c <= c1; c++) visit(r * cols + c);
  };
  const first = new Int32Array(cols * rows + 1);
  for (let s = 0; s < count; s++) cellsOf(s, cell => first[cell + 1]++);
  for (let i = 1; i < first.length; i++) first[i] += first[i - 1];
  const items = new Int32Array(first[first.length - 1]);
  const next = first.slice();
  for (let s = 0; s < count; s++) cellsOf(s, cell => (items[next[cell]++] = s));
  return { seg, clipOf: Int32Array.from(clips), clipBox, first, items, cols, rows, seen: new Uint32Array(count), stamp: 0 };
}

/**
 * The end or crossing nearest to p within the radius (an end on a tie); else a point on a line within the radius: the foot of the
 * perpendicular from `from` when that is within the radius, the nearest point otherwise; else p itself. A point outside the box of its
 * path's clip is never taken. Not "ends first": that takes the end of a dimension line running past its mark, or the end of a tick.
 */
export function snapPoint(p: Vec, index: SnapIndex, radiusPt: number, from?: Vec): Snap {
  const { seg, clipOf, clipBox, first, items, cols, rows, seen } = index;
  const [px, py] = p;
  const inside = (s: number, x: number, y: number) => {
    const c = clipOf[s] * 4;
    return x >= clipBox[c] && x <= clipBox[c + 2] && y >= clipBox[c + 1] && y <= clipBox[c + 3];
  };
  const stamp = ++index.stamp;
  const near: { s: number; d2: number }[] = [];
  const r2 = radiusPt * radiusPt;
  const [c0, c1] = [clamp(Math.floor((px - radiusPt) / CELL), cols), clamp(Math.floor((px + radiusPt) / CELL), cols)];
  const [r0, r1] = [clamp(Math.floor((py - radiusPt) / CELL), rows), clamp(Math.floor((py + radiusPt) / CELL), rows)];
  for (let r = r0; r <= r1; r++)
    for (let c = c0; c <= c1; c++)
      for (let k = first[r * cols + c]; k < first[r * cols + c + 1]; k++) {
        const s = items[k];
        if (seen[s] === stamp) continue;
        seen[s] = stamp;
        const [x, y] = nearestOn(seg, s, px, py);
        const d2 = (x - px) ** 2 + (y - py) ** 2;
        if (d2 <= r2) near.push({ s, d2 });
      }
  if (!near.length) return { at: p, to: null };
  near.sort((a, b) => a.d2 - b.d2);
  near.length = Math.min(near.length, NEAREST);

  let best: Snap | null = null;
  let bestD2 = r2;
  const offer = (x: number, y: number, to: Snap['to']) => {
    const d2 = (x - px) ** 2 + (y - py) ** 2;
    if (d2 < bestD2 || (d2 === bestD2 && !best)) [best, bestD2] = [{ at: [x, y], to }, d2];
  };
  for (const { s } of near)
    for (const e of [0, 2]) if (inside(s, seg[s * 4 + e], seg[s * 4 + e + 1])) offer(seg[s * 4 + e], seg[s * 4 + e + 1], 'end');
  for (let i = 0; i < near.length; i++)
    for (let j = i + 1; j < near.length; j++) {
      const x = crossing(seg, near[i].s, near[j].s);
      if (x && inside(near[i].s, ...x) && inside(near[j].s, ...x)) offer(...x, 'cross'); // equal to an end: the end stays
    }
  if (best) return best;

  if (from) {
    for (const { s } of near) {
      const foot = footOn(seg, s, from);
      if (foot && inside(s, ...foot)) offer(...foot, 'line');
    }
    if (best) return best;
  }
  for (const { s } of near) {
    const point = nearestOn(seg, s, px, py);
    if (inside(s, ...point)) offer(...point, 'line');
  }
  return best ?? { at: p, to: null };
}

/** Where along piece s the projection of (x, y) falls: 0 at its start, 1 at its end. */
function along(seg: Float64Array, s: number, x: number, y: number): number {
  const [ax, ay, bx, by] = seg.subarray(s * 4, s * 4 + 4);
  return ((x - ax) * (bx - ax) + (y - ay) * (by - ay)) / ((bx - ax) ** 2 + (by - ay) ** 2);
}
function pointOn(seg: Float64Array, s: number, t: number): Vec {
  const [ax, ay, bx, by] = seg.subarray(s * 4, s * 4 + 4);
  return [ax + t * (bx - ax), ay + t * (by - ay)];
}
const nearestOn = (seg: Float64Array, s: number, x: number, y: number): Vec => pointOn(seg, s, Math.max(0, Math.min(1, along(seg, s, x, y))));
/** The foot of the perpendicular from `from` on piece s, when it falls on the piece. */
function footOn(seg: Float64Array, s: number, [x, y]: Vec): Vec | null {
  const t = along(seg, s, x, y);
  return t >= 0 && t <= 1 ? pointOn(seg, s, t) : null;
}
function crossing(seg: Float64Array, i: number, j: number): Vec | null {
  const [ax, ay, ax2, ay2] = seg.subarray(i * 4, i * 4 + 4);
  const [bx, by, bx2, by2] = seg.subarray(j * 4, j * 4 + 4);
  const [rx, ry, sx, sy] = [ax2 - ax, ay2 - ay, bx2 - bx, by2 - by];
  const den = rx * sy - ry * sx;
  if (Math.abs(den) <= 1e-12 * Math.hypot(rx, ry) * Math.hypot(sx, sy)) return null; // parallel
  const t = ((bx - ax) * sy - (by - ay) * sx) / den;
  const u = ((bx - ax) * ry - (by - ay) * rx) / den;
  return t >= 0 && t <= 1 && u >= 0 && u <= 1 ? [ax + t * rx, ay + t * ry] : null;
}
