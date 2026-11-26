import { area, contains, dist, intersection, polygon, rings, wallBody } from './geo';
import { isExterior } from './kind';
import { roomsOnSide } from './measure';
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

/**
 * Walls a change may not touch while a room is marked as the mamad. shortcut: every wall that bounds the mamad over any
 * part of its length; if the owner relaxes it, only the outline guard of rebuildExisting and a split inside the mamad's
 * face span stay.
 */
export const wallLockedByMamad = (s: State, wallId: Id): boolean => wallBoundsMamad(s, wallId);

const toSegment = (p: Pt, a: Pt, b: Pt) => {
  const l2 = (b.x - a.x) ** 2 + (b.y - a.y) ** 2;
  const t = l2 ? Math.max(0, Math.min(1, ((p.x - a.x) * (b.x - a.x) + (p.y - a.y) * (b.y - a.y)) / l2)) : 0;
  return dist(p, { x: a.x + (b.x - a.x) * t, y: a.y + (b.y - a.y) * t });
};
const toRings = (region: Pt[][], p: Pt) => Math.min(...region.flatMap(r => r.map((a, i) => toSegment(p, a, r[(i + 1) % r.length]))));
/** The body of w reaches more than 0.01 mm into the mamad's floor (judged by depth, not area, whatever its length). */
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
