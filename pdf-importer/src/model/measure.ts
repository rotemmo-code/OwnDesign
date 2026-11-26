import { dist, ringArea } from './geo';
import { axis, joinWalls, normalA } from './join';
import { cleanRing, live } from './rooms';
import type { Id, Pt, Room, Separator, Side, State, Wall } from './types';

export type Edge = { a: Pt; b: Pt; mm: number };
export type Step = { at: Pt; mm: number };
export type Metrics = { areaMm2: number; rect: { l: number; w: number } | null; edges: Edge[]; steps: Step[] };

// mm, and degrees; 0.01 more or less, so that exactly the number itself counts at any angle of the plan
const STEP = 2.01;
const LEAST_STEP = 0.09;
const SAME_LENGTH = 10.01;
export const FACE = 0.51;
export const LEAST_FACE = 9.99;
const SQUARE = Math.sin((0.51 * Math.PI) / 180);

const edgesOf = (ring: Pt[]): Edge[] =>
  ring.map((a, i) => {
    const b = ring[(i + 1) % ring.length];
    return { a, b, mm: dist(a, b) };
  });
/** Place of p along a line from its start, and beside it. */
function along(line: { a: Pt; b: Pt }, p: Pt) {
  const u = axis(line);
  const [x, y] = [p.x - line.a.x, p.y - line.a.y];
  return { s: x * u.x + y * u.y, off: x * u.y - y * u.x };
}
/** The edge is a separator, not a wall. The tolerance covers an end moved by an ignored step. */
const virtual = (e: Edge, separators: Separator[]) =>
  separators.some(s => {
    const [p, q] = [along(s, e.a), along(s, e.b)];
    const by = STEP + FACE;
    return Math.max(Math.abs(p.off), Math.abs(q.off)) <= by && Math.min(p.s, q.s) >= -by && Math.max(p.s, q.s) <= dist(s.a, s.b) + by;
  });

/**
 * Area from the exact outline less the holes. L x W and the edge list ignore steps of up to 2 mm, which are reported; an
 * edge that is a separator is not listed.
 */
export function roomMetrics(room: Pick<Room, 'boundary' | 'holes'>, separators: Separator[]): Metrics {
  const ring = cleanRing(room.boundary, STEP);
  const edges = edgesOf(ring);
  const exact = edgesOf(room.boundary);
  const open = (e: Edge) => virtual(e, separators);
  const square =
    ring.length === 4 &&
    ring.every((p, i) => {
      const [a, c] = [ring[(i + 3) % 4], ring[(i + 1) % 4]];
      return Math.abs((a.x - p.x) * (c.x - p.x) + (a.y - p.y) * (c.y - p.y)) <= SQUARE * dist(a, p) * dist(c, p);
    });
  const [top, right, bottom, left] = edges.map(e => e.mm);
  const fits = square && Math.abs(top - bottom) <= SAME_LENGTH && Math.abs(right - left) <= SAME_LENGTH;
  const sizes = [(top + bottom) / 2, (right + left) / 2];
  const steps = exact.filter((e, i) => {
    const [before, after] = [exact[(i + exact.length - 1) % exact.length], exact[(i + 1) % exact.length]];
    return e.mm >= LEAST_STEP && e.mm <= STEP && !open(before) && !open(after);
  });
  return {
    areaMm2: Math.abs(ringArea(room.boundary)) - room.holes.reduce((sum, h) => sum + Math.abs(ringArea(h)), 0),
    rect: fits ? { l: Math.max(...sizes), w: Math.min(...sizes) } : null,
    edges: edges.filter(e => !open(e)),
    steps: steps.map(e => ({ at: { x: (e.a.x + e.b.x) / 2, y: (e.a.y + e.b.y) / 2 }, mm: e.mm })),
  };
}

/** mm along a -> b of the wall. ring: 0 the outline, k its hole k - 1; edge: from point edge to the next. */
export type Face = { room: Id; ring: number; edge: number; from: number; to: number };
const near = (p: Wall, q: Wall) =>
  (['x', 'y'] as const).every(
    k => Math.min(p.a[k], p.b[k]) <= Math.max(q.a[k], q.b[k]) + 2000 && Math.min(q.a[k], q.b[k]) <= Math.max(p.a[k], p.b[k]) + 2000,
  );
/** Pieces of the rooms' outlines, holes too, that lie on one face of a wall. */
export function faces(state: State, wallId: Id, side: Side): Face[] {
  const walls = live(state.walls);
  const w = walls.find(x => x.id === wallId);
  if (!w) return [];
  const u = axis(w);
  const n = normalA(u);
  const sign = side === 'A' ? 1 : -1;
  const off = (p: Pt) => sign * ((p.x - w.a.x) * n.x + (p.y - w.a.y) * n.y) - w.thickness / 2;
  const at = (p: Pt) => (p.x - w.a.x) * u.x + (p.y - w.a.y) * u.y;
  const out: Face[] = [];
  let span: [number, number] | undefined;
  for (const room of state.rooms)
    [room.boundary, ...room.holes].forEach((ring, k) =>
      ring.forEach((p, i) => {
        const q = ring[(i + 1) % ring.length];
        if (Math.abs(off(p)) > FACE || Math.abs(off(q)) > FACE) return;
        span ??= joinWalls(walls.filter(o => near(o, w))).get(w.id)![side];
        const from = Math.max(Math.min(at(p), at(q)), span[0]);
        const to = Math.min(Math.max(at(p), at(q)), span[1]);
        if (to - from >= LEAST_FACE) out.push({ room: room.id, ring: k, edge: i, from, to });
      }),
    );
  return out;
}
export const roomsOnSide = (state: State, wallId: Id, side: Side): Id[] => [...new Set(faces(state, wallId, side).map(f => f.room))];
/** Of the longer side, when a room lies on both. */
export const faceLength = (state: State, roomId: Id, wallId: Id): number =>
  Math.max(
    ...(['A', 'B'] as const).map(side =>
      faces(state, wallId, side)
        .filter(f => f.room === roomId)
        .reduce((sum, f) => sum + f.to - f.from, 0),
    ),
  );

// Rounded first to 0.1 mm (1 mm2), so that 2884.9999999 reads 289 and not 288.
export const formatCm = (mm: number): string => String(Math.round(Math.round(mm * 10) / 100));
export const formatM2 = (mm2: number): string => (Math.round(Math.round(mm2) / 1e4) / 100).toFixed(2);
/** mm, or null when the text is not such a number of cm between min and max mm. */
export function parseCm(text: string, opts: { min: number; max: number; decimals: 0 | 1 }): number | null {
  const pattern = opts.decimals ? /^\d{1,6}(\.\d)?$/ : /^\d{1,6}$/;
  if (!pattern.test(text.trim())) return null;
  const mm = Number(text) * 10; // exact: of all the numbers that the patterns let through none is off
  return mm >= opts.min && mm <= opts.max ? mm : null;
}
