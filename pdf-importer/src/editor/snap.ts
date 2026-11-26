import type { ExtractedPage } from '../pdf/extract';
import type { Vec } from '../shared';

/** What a point was snapped to: the end of a line, a crossing of two, a point on one, or nothing (the point itself). */
export type Snap = { at: Vec; to: 'end' | 'cross' | 'line' | null };
/**
 * The page's straight pieces in a grid, built once per page. seg: ax, ay, bx, by of each piece; clipOf: its clip; clipBox: left, top,
 * right, bottom of each clip; first and items: the pieces listed in each cell it crosses (CSR); long: the pieces that cross more than
 * LONG cells, which every query looks at; seen and stamp: to visit each piece once per query.
 */
export type SnapIndex = {
  seg: Float64Array;
  clipOf: Int32Array;
  clipBox: Float64Array;
  first: Int32Array;
  items: Int32Array;
  long: Int32Array;
  cell: number;
  cols: number;
  rows: number;
  seen: Uint32Array;
  stamp: number;
};

const CELL = 8; // points, unless the page is so large that the grid would pass MAX_CELLS
const MAX_CELLS = 1_000_000;
const LONG = 64; // a piece that crosses more cells is not listed in them: a page of long diagonals would fill the memory
const NEAREST = 256; // at most this many pieces near the point are crossed with each other, so a crowded spot stays fast

const clamp = (value: number, count: number) => Math.max(0, Math.min(count - 1, value));

export function snapIndex(page: ExtractedPage): SnapIndex {
  // The box of a clip list is where all its clips meet; a clip with no point clips to nothing.
  const clipBox = new Float64Array(page.clips.length * 4);
  page.clips.forEach((list, c) => {
    let [left, top, right, bottom] = [-Infinity, -Infinity, Infinity, Infinity];
    for (const { rings } of list) {
      // A loop, not Math.min(...points): a clip of a few hundred thousand points would overflow the stack.
      let [low, high, lowY, highY] = [Infinity, -Infinity, Infinity, -Infinity];
      for (const ring of rings)
        for (const [x, y] of ring) [low, high, lowY, highY] = [Math.min(low, x), Math.max(high, x), Math.min(lowY, y), Math.max(highY, y)];
      [left, right, top, bottom] = [Math.max(left, low), Math.min(right, high), Math.max(top, lowY), Math.min(bottom, highY)]; // no point: nothing
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
  let cell = Math.max(CELL, Math.sqrt((page.widthPt * page.heightPt) / MAX_CELLS));
  const size = () => [Math.max(1, Math.ceil(page.widthPt / cell)), Math.max(1, Math.ceil(page.heightPt / cell))];
  while (size()[0] * size()[1] > MAX_CELLS) cell *= 1.01;
  const [cols, rows] = size();
  const long: number[] = [];
  const isLong = new Uint8Array(count);
  for (let s = 0; s < count; s++) if (walk(seg, s, cell, cols, rows, () => {}) > LONG) [isLong[s], long[long.length]] = [1, s];
  const first = new Int32Array(cols * rows + 1);
  for (let s = 0; s < count; s++) if (!isLong[s]) walk(seg, s, cell, cols, rows, at => first[at + 1]++);
  for (let i = 1; i < first.length; i++) first[i] += first[i - 1];
  const items = new Int32Array(first[first.length - 1]);
  const next = first.slice();
  for (let s = 0; s < count; s++) if (!isLong[s]) walk(seg, s, cell, cols, rows, at => (items[next[at]++] = s));
  return { seg, clipOf: Int32Array.from(clips), clipBox, first, items, long: Int32Array.from(long), cell, cols, rows, seen: new Uint32Array(count), stamp: 0 };
}

/**
 * Visits the cells piece s crosses (Amanatides and Woo), inside the grid, and returns how many. A piece outside the grid counts as being
 * in the cell nearest its middle. Only the count is computed while it stays above LONG.
 */
function walk(seg: Float64Array, s: number, cell: number, cols: number, rows: number, visit: (at: number) => void): number {
  let [x0, y0, x1, y1] = Array.from(seg.subarray(s * 4, s * 4 + 4), v => v / cell);
  // Liang and Barsky: the part of the piece inside [0, cols] x [0, rows].
  let [t0, t1] = [0, 1];
  const [dx, dy] = [x1 - x0, y1 - y0];
  for (const [p, q] of [[-dx, x0], [dx, cols - x0], [-dy, y0], [dy, rows - y0]]) {
    if (p === 0) {
      if (q < 0) [t0, t1] = [1, 0];
    } else if (p < 0) t0 = Math.max(t0, q / p);
    else t1 = Math.min(t1, q / p);
  }
  if (t0 > t1) {
    visit(clamp(Math.floor((y0 + y1) / 2), rows) * cols + clamp(Math.floor((x0 + x1) / 2), cols));
    return 1;
  }
  [x0, y0, x1, y1] = [x0 + t0 * dx, y0 + t0 * dy, x0 + t1 * dx, y0 + t1 * dy];
  let [cx, cy] = [clamp(Math.floor(x0), cols), clamp(Math.floor(y0), rows)];
  const [ex, ey] = [clamp(Math.floor(x1), cols), clamp(Math.floor(y1), rows)];
  const count = Math.abs(ex - cx) + Math.abs(ey - cy) + 1;
  if (count > LONG) return count;
  const [stepX, stepY] = [Math.sign(dx), Math.sign(dy)];
  let tx = stepX ? ((stepX > 0 ? cx + 1 : cx) - x0) / (x1 - x0 || dx) : Infinity;
  let ty = stepY ? ((stepY > 0 ? cy + 1 : cy) - y0) / (y1 - y0 || dy) : Infinity;
  const [deltaX, deltaY] = [stepX ? Math.abs(1 / (x1 - x0 || dx)) : Infinity, stepY ? Math.abs(1 / (y1 - y0 || dy)) : Infinity];
  visit(cy * cols + cx);
  for (let n = 1; n < count; n++) {
    if (tx < ty ? cx !== ex : cy === ey) [cx, tx] = [cx + stepX, tx + deltaX];
    else [cy, ty] = [cy + stepY, ty + deltaY];
    visit(cy * cols + cx);
  }
  return count;
}

/**
 * The end or crossing nearest to p within the radius (an end on a tie); else a point on a line within the radius: the foot of the
 * perpendicular from `from` when that is within the radius, the nearest point otherwise; else p itself. A point outside the box of its
 * path's clip is never taken. Not "ends first": that takes the end of a dimension line running past its mark, or the end of a tick.
 */
export function snapPoint(p: Vec, index: SnapIndex, radiusPt: number, from?: Vec): Snap {
  const { seg, clipOf, clipBox, first, items, long, cell, cols, rows, seen } = index;
  const [px, py] = p;
  const inside = (s: number, x: number, y: number) => {
    const c = clipOf[s] * 4;
    return x >= clipBox[c] && x <= clipBox[c + 2] && y >= clipBox[c + 1] && y <= clipBox[c + 3];
  };
  const stamp = ++index.stamp;
  const near: { s: number; d2: number }[] = [];
  const r2 = radiusPt * radiusPt;
  const look = (s: number) => {
    if (seen[s] === stamp) return;
    seen[s] = stamp;
    const [x, y] = nearestOn(seg, s, px, py);
    const d2 = (x - px) ** 2 + (y - py) ** 2;
    if (d2 <= r2) near.push({ s, d2 });
  };
  const [c0, c1] = [clamp(Math.floor((px - radiusPt) / cell), cols), clamp(Math.floor((px + radiusPt) / cell), cols)];
  const [r0, r1] = [clamp(Math.floor((py - radiusPt) / cell), rows), clamp(Math.floor((py + radiusPt) / cell), rows)];
  for (let r = r0; r <= r1; r++) for (let c = c0; c <= c1; c++) for (let k = first[r * cols + c]; k < first[r * cols + c + 1]; k++) look(items[k]);
  for (const s of long) look(s);
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
