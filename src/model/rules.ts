import { area, contains, corners, dist, intersection, polygon, rings, wallBody } from './geo';
import { TOUCH } from './join';
import { isExterior } from './kind';
import { faces, roomsOnSide } from './measure';
import { live } from './rooms';
import { LIMITS } from './schema';
import type { Action, Id, Notice, Opening, Project, Pt, Reason, Room, Separator, State, Wall } from './types';

/** Thrown by a handler to refuse the action; apply turns it into { ok: false, reason }. */
export class Refused {
  constructor(readonly reason: Reason) {}
}
export const refuse = (reason: Reason): never => {
  throw new Refused(reason);
};
export type Change = { project: Project; notice?: Notice };
export type Handler<T extends Action['type']> = (p: Project, a: Extract<Action, { type: T }>) => Change;
export type Handlers = { [T in Action['type']]?: Handler<T> };

/** Two walls whose bodies share more than this of the smaller one lie on each other. */
export const OVERLAP = 0.9;
const TOL = LIMITS.tolerance;
/** mm: how far an edge of a room may lie from a separator and still be that separator (rooms.ts runs cuts on by 1 mm). */
const ON_LINE = 0.51;
const LEAST_EDGE = 9.99;

const length = (s: { a: Pt; b: Pt }) => dist(s.a, s.b);
type Box = { x0: number; y0: number; x1: number; y1: number };
const boxOf = (w: Wall): Box => {
  const h = w.thickness / 2;
  return { x0: Math.min(w.a.x, w.b.x) - h, x1: Math.max(w.a.x, w.b.x) + h, y0: Math.min(w.a.y, w.b.y) - h, y1: Math.max(w.a.y, w.b.y) + h };
};
const meet = (a: Box, b: Box) => a.x0 <= b.x1 && b.x0 <= a.x1 && a.y0 <= b.y1 && b.y0 <= a.y1;

/** Length, thickness, and not lying on another wall. */
export function wallFits(s: State, w: Wall): Reason | null {
  if (length(w) < LIMITS.wallLength - TOL || w.thickness < LIMITS.thicknessMin || w.thickness > LIMITS.thicknessMax) return 'invalid-geometry';
  const body = wallBody(w);
  const own = length(w) * w.thickness;
  const box = boxOf(w);
  for (const o of live(s.walls)) {
    if (o.id === w.id || !meet(box, boxOf(o))) continue;
    if (area(intersection(body, wallBody(o))) > OVERLAP * Math.min(own, length(o) * o.thickness)) return 'invalid-geometry';
  }
  return null;
}

const family = (o: Opening) => (o.kind === 'window' ? 'window' : o.kind === 'passage' ? o.id : 'door');
const shared = (o: Opening, q: Opening) => Math.min(o.offset + o.width, q.offset + q.width) - Math.max(o.offset, q.offset);
/**
 * Every opening of the wall lies inside it. Openings may not overlap, except on a wall that bounds the mamad, where a
 * mamad's double door or double window shares one opening (owner, round 8): two of one family that share at least half
 * of the narrower one, and neither overlapping any third. Only overlaps of a changed opening are judged, so a pair made
 * while the mark stood is kept when the mark is cleared.
 */
export function openingsFit(s: State, wallId: Id, changed: Id[]): Reason | null {
  const w = s.walls.find(x => x.id === wallId);
  if (!w) return 'invalid-action';
  const list = s.openings.filter(o => o.wallId === wallId);
  if (list.some(o => o.offset < 0 || o.offset + o.width > length(w) + TOL)) return 'opening-out-of-wall';
  const over = (o: Opening) => list.filter(q => q !== o && shared(o, q) > TOL);
  const mamad = list.some(o => changed.includes(o.id)) && wallBoundsMamad(s, wallId);
  for (const o of list.filter(x => changed.includes(x.id))) {
    const others = over(o);
    if (!others.length) continue;
    const [q] = others;
    const double = mamad && others.length === 1 && over(q).length === 1 && family(o) === family(q);
    if (!double || shared(o, q) < Math.min(o.width, q.width) / 2 - TOL) return 'invalid-geometry';
  }
  return null;
}

const mamadOf = (s: State): Room | undefined => s.rooms.find(r => r.isMamad);

/**
 * The wall bounds the mamad: a face of it holds a piece of the mamad's outline (or of one of its holes) of 9.99 mm or
 * more, as measure.faces sees it; the same test that makes wallKind 'mamad'. A wall that meets the mamad only at a
 * corner, or lies beyond a neighbouring room, does not.
 */
export function wallBoundsMamad(s: State, wallId: Id): boolean {
  const m = mamadOf(s);
  return !!m && (['A', 'B'] as const).some(side => roomsOnSide(s, wallId, side).includes(m.id));
}

const toSegment = (p: Pt, a: Pt, b: Pt) => {
  const l2 = (b.x - a.x) ** 2 + (b.y - a.y) ** 2;
  const t = l2 ? Math.max(0, Math.min(1, ((p.x - a.x) * (b.x - a.x) + (p.y - a.y) * (b.y - a.y)) / l2)) : 0;
  return dist(p, { x: a.x + (b.x - a.x) * t, y: a.y + (b.y - a.y) * t });
};
const toBody = (w: Wall, p: Pt) => {
  const c = corners(w.a, w.b, w.thickness);
  return contains(c, p) ? 0 : Math.min(...c.map((q, i) => toSegment(p, q, c[(i + 1) % 4])));
};
/** Place along w's line from a, and distance beside it. */
const along = (w: Wall, p: Pt) => {
  const l = length(w);
  const [x, y] = [p.x - w.a.x, p.y - w.a.y];
  return { at: (x * (w.b.x - w.a.x) + y * (w.b.y - w.a.y)) / l, off: Math.abs(x * (w.b.y - w.a.y) - y * (w.b.x - w.a.x)) / l };
};
const onLine = (w: Wall, q: Wall) => q.thickness === w.thickness && along(w, q.a).off <= TOL && along(w, q.b).off <= TOL;

/**
 * The span of the wall, in mm from a, where a face of it is an edge of the mamad (from the first to the last piece that
 * measure.faces finds); before and after: the thickness of the thickest other wall that reaches the wall's centre line
 * there (within half its thickness + 2.01 mm), which is the corner joint of the mamad. null: the wall does not bound it.
 */
export function mamadSpan(s: State, wallId: Id): { from: number; to: number; before: number; after: number } | null {
  const m = mamadOf(s);
  const w = s.walls.find(x => x.id === wallId);
  if (!m || !w) return null;
  const pieces = (['A', 'B'] as const).flatMap(side => faces(s, wallId, side)).filter(f => f.room === m.id);
  if (!pieces.length) return null;
  const [from, to] = [Math.min(...pieces.map(f => f.from)), Math.max(...pieces.map(f => f.to))];
  const reach = (t: number) => {
    const c = { x: w.a.x + ((w.b.x - w.a.x) * t) / length(w), y: w.a.y + ((w.b.y - w.a.y) * t) / length(w) };
    return Math.max(0, ...live(s.walls).filter(o => o.id !== w.id && toBody(o, c) <= w.thickness / 2 + TOUCH).map(o => o.thickness));
  };
  return { from, to, before: reach(from), after: reach(to) };
}

/**
 * What a change may do to a wall while a room is marked as the mamad (owner: only the mamad is locked, not the whole
 * wall). A wall that bounds it is never deleted; it is split only outside its span and the corner joints there; its end
 * moves only along its own line, thickness kept, the span still covered.
 */
export const mamadAllows = {
  delete: (s: State, wallId: Id): boolean => !wallBoundsMamad(s, wallId),
  split: (s: State, wallId: Id, at: number): boolean => {
    const k = mamadSpan(s, wallId);
    return !k || at <= k.from - k.before + TOL || at >= k.to + k.after - TOL;
  },
  set: (s: State, old: Wall, w: Wall): boolean => {
    const k = mamadSpan(s, old.id);
    if (!k) return true;
    const [from, to] = guarded(k, length(old));
    return onLine(old, w) && along(old, w.a).at <= from + TOL && along(old, w.b).at >= to - TOL;
  },
  /** w (new or changed) does not run along a wall that bounds the mamad, over its span and corner joints. */
  lay: (s: State, w: Wall): boolean => {
    if (length(w) < LIMITS.wallLength - TOL) return true;
    const body = wallBody(w);
    const u = { x: (w.b.x - w.a.x) / length(w), y: (w.b.y - w.a.y) / length(w) };
    return !boundingWalls(s).some(o => {
      if (o.id === w.id) return false;
      const l = length(o);
      const v = { x: (o.b.x - o.a.x) / l, y: (o.b.y - o.a.y) / l };
      if (Math.abs(u.x * v.y - u.y * v.x) >= ALONG) return false;
      const [from, to] = guarded(mamadSpan(s, o.id)!, l);
      const at = (t: number) => ({ x: o.a.x + v.x * t, y: o.a.y + v.y * t });
      const g = intersection(body, polygon(corners(at(from), at(to), o.thickness)));
      const ats = rings(g).flat().map(q => along(o, q).at);
      // more than 0.01 mm wide on average over the length they share
      return ats.length > 0 && area(g) > TOL * (Math.max(...ats) - Math.min(...ats));
    });
  },
};
/** The span with the corner joints at both ends, within the wall. */
const guarded = (k: { from: number; to: number; before: number; after: number }, l: number): [number, number] => [
  Math.max(0, k.from - k.before),
  Math.min(l, k.to + k.after),
];
/** The value of LEAST_SINE in join.ts (not exported there): under it a wall runs along another instead of meeting it. */
const ALONG = Math.sin((14.99 * Math.PI) / 180);
const boundingWalls = (s: State): Wall[] => {
  const m = mamadOf(s);
  if (!m) return [];
  const xs = m.boundary.map(q => q.x);
  const ys = m.boundary.map(q => q.y);
  const room: Box = { x0: Math.min(...xs) - 1, x1: Math.max(...xs) + 1, y0: Math.min(...ys) - 1, y1: Math.max(...ys) + 1 };
  return live(s.walls).filter(w => meet(boxOf(w), room) && mamadSpan(s, w.id) !== null);
};

/**
 * After a change: every wall that bounded the mamad before still lies there, same line and thickness, along all of its
 * span and the corner joints at its ends (any wall on that line counts, so the two parts of a split do). The outline guard alone misses a wall thickened or
 * thinned outward, which keeps the inside face.
 */
export function mamadWallsKept(before: State, after: State): boolean {
  if (!mamadOf(before)) return true;
  return boundingWalls(before).every(w => {
      const [from, to] = guarded(mamadSpan(before, w.id)!, length(w));
      const cover = live(after.walls)
        .filter(q => onLine(w, q))
        .map(q => [along(w, q.a).at, along(w, q.b).at].sort((x, y) => x - y))
        .sort((x, y) => x[0] - y[0]);
      let reached = from;
      for (const [x0, x1] of cover) if (x0 <= reached + TOL) reached = Math.max(reached, x1);
      return reached >= to - TOL;
    });
}

const toRings = (region: Pt[][], p: Pt) => Math.min(...region.flatMap(r => r.map((a, i) => toSegment(p, a, r[(i + 1) % r.length]))));
/**
 * The body of w reaches more than 0.01 mm into the mamad's floor, judged by depth, not area, whatever its length. It
 * misses a thin wall that crosses the mamad from edge to edge (every corner of the overlap lies on the mamad's outline);
 * the outline guard of rebuildExisting refuses that one.
 */
export function wallEntersMamad(s: State, w: Wall): boolean {
  const m = mamadOf(s);
  if (!m || length(w) < LIMITS.wallLength - TOL) return false;
  const region = [m.boundary, ...m.holes];
  return rings(intersection(wallBody(w), polygon(m.boundary, m.holes))).some(r => r.some(p => toRings(region, p) > TOL));
}

/** Length of the line that lies inside the region [outline, ...holes]. */
function insideLength(line: { a: Pt; b: Pt }, region: Pt[][]): number {
  const d = { x: line.b.x - line.a.x, y: line.b.y - line.a.y };
  const cuts = [0, 1];
  for (const ring of region)
    ring.forEach((p, i) => {
      const q = ring[(i + 1) % ring.length];
      const e = { x: q.x - p.x, y: q.y - p.y };
      const den = d.x * e.y - d.y * e.x;
      if (den === 0) return;
      const t = ((p.x - line.a.x) * e.y - (p.y - line.a.y) * e.x) / den;
      const u = ((p.x - line.a.x) * d.y - (p.y - line.a.y) * d.x) / den;
      if (t > 0 && t < 1 && u >= 0 && u <= 1) cuts.push(t);
    });
  cuts.sort((x, y) => x - y);
  const [shell, ...holes] = region;
  let sum = 0;
  for (let i = 1; i < cuts.length; i++) {
    const t = (cuts[i - 1] + cuts[i]) / 2;
    const at = { x: line.a.x + d.x * t, y: line.a.y + d.y * t };
    if (contains(shell, at) && !holes.some(h => contains(h, at))) sum += (cuts[i] - cuts[i - 1]) * length(line);
  }
  return sum;
}
/** Some of the separator, more than 0.01 mm, lies inside the mamad. */
export function separatorEntersMamad(s: State, line: Pick<Separator, 'a' | 'b'>): boolean {
  const m = mamadOf(s);
  return !!m && insideLength(line, [m.boundary, ...m.holes]) > TOL;
}
/** An edge of the mamad's outline, 9.99 mm or longer, lies on the separator. */
export function separatorBoundsMamad(s: State, separatorId: Id): boolean {
  const m = mamadOf(s);
  const line = s.separators.find(x => x.id === separatorId);
  if (!m || !line) return false;
  const l = length(line);
  const u = { x: (line.b.x - line.a.x) / l, y: (line.b.y - line.a.y) / l };
  const on = (p: Pt) => {
    const [x, y] = [p.x - line.a.x, p.y - line.a.y];
    const along = x * u.x + y * u.y;
    return Math.abs(x * u.y - y * u.x) <= ON_LINE && along >= -1 - ON_LINE && along <= l + 1 + ON_LINE;
  };
  return [m.boundary, ...m.holes].some(ring => ring.some((p, i) => {
    const q = ring[(i + 1) % ring.length];
    return dist(p, q) >= LEAST_EDGE && on(p) && on(q);
  }));
}

/** Walls of no stored class (or 'unknown') that hold a window, lie on the apartment's edge, or are columns. */
export function suggestedFixed(p: Project): Id[] {
  const s = p.existing;
  return s.walls
    .filter(w => (p.wallClass[w.id] ?? 'unknown') === 'unknown')
    .filter(
      w =>
        s.openings.some(o => o.wallId === w.id && o.kind === 'window') ||
        length(w) <= 2 * w.thickness + TOL ||
        isExterior(s, w.id),
    )
    .map(w => w.id);
}
