import { area, contains, corners, dist, intersection, polygon, rings, wallBody } from './geo';
import { LEAST_SINE, normalA, TOUCH } from './join';
import { isExterior, isInside } from './kind';
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
// the boxes are asked for again and again while the envelope is compared; walls and rooms are never changed in place
const wallBoxes = new WeakMap<Wall, Box>();
const wallBox = (w: Wall): Box => wallBoxes.get(w) ?? (wallBoxes.set(w, boxOf(w)), wallBoxes.get(w)!);
const roomBoxes = new WeakMap<Room, Box>();
const roomBox = (r: Room): Box => roomBoxes.get(r) ?? (roomBoxes.set(r, ringBox(r.boundary)), roomBoxes.get(r)!);
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
/** q lies on w's line with w's thickness. */
export const onLine = (w: Wall, q: Wall) => q.thickness === w.thickness && along(w, q.a).off <= TOL && along(w, q.b).off <= TOL;

/**
 * The span of the wall, in mm from a, where a face of it is an edge of the mamad (from the first to the last piece that
 * measure.faces finds); before and after: the thickness of the thickest other wall that reaches the wall's centre line
 * there (within half its thickness + 2.01 mm), which is the corner joint of the mamad. null: the wall does not bound it.
 */
/** A locked stretch of a wall, mm from a; before and after: how far the corner joint at each end reaches. */
export type Span = { from: number; to: number; before: number; after: number };
const pointOn = (w: Wall, t: number): Pt => ({ x: w.a.x + ((w.b.x - w.a.x) * t) / length(w), y: w.a.y + ((w.b.y - w.a.y) * t) / length(w) });
/** The thickness of the thickest other wall that reaches w's centre line at t (within half its thickness + 2.01 mm). */
const reach = (s: State, w: Wall, t: number) => {
  const c = pointOn(w, t);
  return Math.max(0, ...live(s.walls).filter(o => o.id !== w.id && toBody(o, c) <= w.thickness / 2 + TOUCH).map(o => o.thickness));
};
const spanOf = (s: State, w: Wall, from: number, to: number): Span => ({ from, to, before: reach(s, w, from), after: reach(s, w, to) });

export function mamadSpan(s: State, wallId: Id): Span | null {
  const m = mamadOf(s);
  const w = s.walls.find(x => x.id === wallId);
  if (!m || !w) return null;
  const pieces = (['A', 'B'] as const).flatMap(side => faces(s, wallId, side)).filter(f => f.room === m.id);
  if (!pieces.length) return null;
  return spanOf(s, w, Math.min(...pieces.map(f => f.from)), Math.max(...pieces.map(f => f.to)));
}
const mamadSpans = (s: State, wallId: Id): Span[] => {
  const k = mamadSpan(s, wallId);
  return k ? [k] : [];
};

type Interval = [number, number];
function merge(list: Interval[]): Interval[] {
  const out: Interval[] = [];
  for (const [f, t] of [...list].sort((x, y) => x[0] - y[0]))
    if (out.length && f <= out[out.length - 1][1] + TOL) out[out.length - 1][1] = Math.max(out[out.length - 1][1], t);
    else out.push([f, t]);
  return out;
}
const minus = (a: Interval[], b: Interval[]): Interval[] =>
  a.flatMap(([f, t]) => {
    const left: Interval[] = [];
    let from = f;
    for (const [x0, x1] of b) {
      if (x1 <= from || x0 >= t) continue;
      if (x0 > from) left.push([from, x0]);
      from = Math.max(from, x1);
    }
    return from < t ? [...left, [from, t] as Interval] : left;
  });
/**
 * The outer stretches of a wall (8c): where an indoor room of the apartment lies on one face and none on the other face
 * at the same place, and where a balcony lies on either face; 9.99 mm or longer, in order, each with its corner joints.
 */
export function envelopeSpans(s: State, wallId: Id): Span[] {
  const w = live(s.walls).find(x => x.id === wallId);
  if (!w) return [];
  const rooms = new Map(s.rooms.map(r => [r.id, r]));
  // faces reads only the rooms on the wall and the walls within 2 m; a local state gives the same answer, cheaper
  const box = boxOf(w);
  const [far, close] = [grow(box, 2000), grow(box, 1)];
  const local: State = { ...s, walls: s.walls.filter(o => meet(wallBox(o), far)), rooms: s.rooms.filter(r => meet(roomBox(r), close)) };
  const sides = (['A', 'B'] as const).map(side => faces(local, wallId, side));
  const cover = (k: 0 | 1, test: (r: Room) => boolean) => merge(sides[k].filter(f => test(rooms.get(f.room)!)).map((f): Interval => [f.from, f.to]));
  // where another wall of the apartment (one with an indoor room beside it) lies against a face, that face is walled,
  // not open to the outside: a T-joint, an L of two walls. A neighbour's wall laid back to back does not count.
  const u = { x: (w.b.x - w.a.x) / length(w), y: (w.b.y - w.a.y) / length(w) };
  const n = normalA(u);
  const against = (k: 0 | 1): { all: Interval[]; lining: Interval[] } => {
    const by = (k ? -1 : 1) * (w.thickness / 2 + 0.5);
    const c = (t: number) => ({ x: w.a.x + u.x * t + n.x * by, y: w.a.y + u.y * t + n.y * by });
    const strip = polygon(corners(c(-500), c(length(w) + 500), 1));
    const near = grow(ringBox(corners(c(-500), c(length(w) + 500), 1)), 1);
    const found = live(local.walls)
      .filter(o => o.id !== w.id && meet(boxOf(o), near))
      .filter(o => (['A', 'B'] as const).some(side => roomsOnSide(s, o.id, side).some(id => (rooms.get(id) ? isInside(rooms.get(id)!) : false))))
      .flatMap(o => {
        const ats = rings(intersection(strip, wallBody(o))).flat().map(q => along(w, q).at);
        const l = length(o);
        const parallel = Math.abs(((o.b.x - o.a.x) * u.y - (o.b.y - o.a.y) * u.x) / l) < LEAST_SINE;
        return ats.length ? [{ at: [Math.min(...ats), Math.max(...ats)] as Interval, parallel }] : [];
      });
    return { all: merge(found.map(f => f.at)), lining: merge(found.filter(f => f.parallel).map(f => f.at)) };
  };
  const [inA, inB] = [cover(0, isInside), cover(1, isInside)];
  const outdoor = (r: Room) => r.outdoor;
  // the walls against a face are costly to find: only where one face is indoor and the other is not. A lining on the
  // indoor face (a wall along it) keeps that stretch indoor; any apartment wall against the other face walls it.
  const open = (mine: Interval[], other: Interval[], k: 0 | 1) => {
    if (!minus(mine, other).length) return [];
    return minus(merge([...mine, ...against(k).lining]), merge([...other, ...against(k ? 0 : 1).all]));
  };
  return merge([...open(inA, inB, 0), ...open(inB, inA, 1), ...cover(0, outdoor), ...cover(1, outdoor)])
    // a face piece may run on past the wall's own end into a joint; the wall's span ends with the wall
    .map(([f, t]): Interval => [Math.max(0, f), Math.min(length(w), t)])
    .filter(([f, t]) => t - f >= LEAST_EDGE)
    .map(([f, t]) => spanOf(local, w, f, t));
}

/** The span with the corner joints at both ends, within the wall. */
const guarded = (k: Span, l: number): Interval => [Math.max(0, k.from - k.before), Math.min(l, k.to + k.after)];
const grow = (b: Box, by: number): Box => ({ x0: b.x0 - by, y0: b.y0 - by, x1: b.x1 + by, y1: b.y1 + by });

/**
 * What a change may do to a wall with locked spans: never deleted; split only outside its spans and their corner joints;
 * an end moves only along the wall's own line, thickness kept, every span and joint still covered; no other wall laid
 * along it (judged by what an edit adds, so an overlap a wall already had is no reason to lock it).
 */
function spanRules(spansOf: (s: State, wallId: Id) => Span[]) {
  /** The part of w's body inside o's body over o's guarded spans, when w runs along o (under 15 degrees). */
  const alongShared = (w: Wall, o: Wall, ks: Span[]): { area: number; extent: number } => {
    const none = { area: 0, extent: Infinity };
    const [l, lw] = [length(o), length(w)];
    if (lw < LIMITS.wallLength - TOL) return none;
    const v = { x: (o.b.x - o.a.x) / l, y: (o.b.y - o.a.y) / l };
    if (Math.abs(((w.b.x - w.a.x) * v.y - (w.b.y - w.a.y) * v.x) / lw) >= LEAST_SINE) return none;
    let [sum, lo, hi] = [0, Infinity, -Infinity];
    for (const k of ks) {
      const [from, to] = guarded(k, l);
      const g = intersection(wallBody(w), polygon(corners(pointOn(o, from), pointOn(o, to), o.thickness)));
      const ats = rings(g).flat().map(q => along(o, q).at);
      if (!ats.length) continue;
      sum += area(g);
      [lo, hi] = [Math.min(lo, ...ats), Math.max(hi, ...ats)];
    }
    return hi > lo ? { area: sum, extent: hi - lo } : none;
  };
  return {
    delete: (s: State, wallId: Id): boolean => spansOf(s, wallId).length === 0,
    split: (s: State, wallId: Id, at: number): boolean =>
      spansOf(s, wallId).every(k => at <= k.from - k.before + TOL || at >= k.to + k.after - TOL),
    set: (s: State, old: Wall, w: Wall): boolean => {
      const ks = spansOf(s, old.id).map(k => guarded(k, length(old)));
      if (!ks.length) return true;
      const [from, to] = [Math.min(...ks.map(k => k[0])), Math.max(...ks.map(k => k[1]))];
      return onLine(old, w) && along(old, w.a).at <= from + TOL && along(old, w.b).at >= to - TOL;
    },
    lay: (s: State, w: Wall, old?: Wall): boolean => {
      const near = grow(boxOf(w), 1);
      return !live(s.walls).some(o => {
        if (o.id === w.id || !meet(boxOf(o), near)) return false;
        const ks = spansOf(s, o.id);
        if (!ks.length) return false;
        const now = alongShared(w, o, ks);
        return now.area - (old ? alongShared(old, o, ks).area : 0) > TOL * now.extent;
      });
    },
  };
}
/**
 * What a change may do to a wall while a room is marked as the mamad (owner: only the mamad is locked, not the whole
 * wall); delete is refused exactly for a wall that bounds it.
 */
export const mamadAllows = spanRules(mamadSpans);
/** The same for the outer walls while the envelope is locked (8c). */
export const envelopeAllows = spanRules(envelopeSpans);
/**
 * The facade's outer leaf (8c): a wall with no indoor room on either face that lies against an outer wall, within
 * 2.01 mm along its outer stretches. While the envelope is locked it is locked too.
 */
export function envelopeLeaf(s: State, w: Wall): boolean {
  const rooms = new Map(s.rooms.map(r => [r.id, r]));
  if ((['A', 'B'] as const).some(side => roomsOnSide(s, w.id, side).some(id => isInside(rooms.get(id)!)))) return false;
  return !envelopeAllows.lay(s, { ...w, thickness: w.thickness + 2 * TOUCH });
}
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

/**
 * The envelope is unchanged by a change (8c): every outer stretch of one state lies on a wall of the same line and
 * thickness whose outer stretches, with their corner joints, cover it in the other state. Both ways, so that no outer
 * wall is moved, thickened or lost, and no inner wall becomes an outer one. Only walls whose stretches can differ are
 * compared: those touching a changed wall or separator (their joints may change) and those beside a changed room.
 */
export function envelopeKept(before: State, after: State): boolean {
  const changed = [
    ...before.walls.filter(w => !after.walls.includes(w)),
    ...after.walls.filter(w => !before.walls.includes(w)),
  ].map(boxOf);
  const lines = [...before.separators.filter(x => !after.separators.includes(x)), ...after.separators.filter(x => !before.separators.includes(x))];
  changed.push(...lines.map(x => ringBox([x.a, x.b])));
  const same = (r: Room, list: Room[]) =>
    list.some(q => q.id === r.id && q.inApartment === r.inApartment && q.outdoor === r.outdoor && sameRings(r, q));
  const rooms = [...before.rooms.filter(r => !same(r, after.rooms)), ...after.rooms.filter(r => !same(r, before.rooms))].map(r => grow(ringBox(r.boundary), 1));
  // joints reach 5.01 mm between ends, a little more where a wall passes one: 10 mm is enough around a changed wall
  const near = [...changed.map(b => grow(b, 10)), ...rooms];
  const pick = (s: State) =>
    live(s.walls)
      .filter(w => near.some(b => meet(boxOf(w), b)))
      .map(w => ({ w, ks: envelopeSpans(s, w.id) }));
  const [b, a] = [pick(before), pick(after)];
  const covered = ({ w, ks }: { w: Wall; ks: Span[] }, other: { w: Wall; ks: Span[] }[]) => {
    const cover = merge(
      other
        .filter(o => onLine(w, o.w))
        .flatMap(o => o.ks.map(k => guarded(k, length(o.w)).map(t => along(w, pointOn(o.w, t)).at).sort((x, y) => x - y) as Interval)),
    );
    return ks.every(k => cover.some(([x0, x1]) => x0 <= k.from + TOL && x1 >= k.to - TOL));
  };
  return b.every(x => covered(x, a)) && a.every(x => covered(x, b));
}
const HAIR = 0.03;
/** The same outline and holes, point for point (computeRooms writes them in one order). */
const sameRings = (r: Room, q: Room) =>
  [r.boundary, ...r.holes].length === [q.boundary, ...q.holes].length &&
  [r.boundary, ...r.holes].every((ring, i) => {
    const other = i ? q.holes[i - 1] : q.boundary;
    return ring.length === other.length && ring.every((p, k) => dist(p, other[k]) <= HAIR);
  });
const ringBox = (ring: Pt[]): Box => ({
  x0: Math.min(...ring.map(q => q.x)),
  y0: Math.min(...ring.map(q => q.y)),
  x1: Math.max(...ring.map(q => q.x)),
  y1: Math.max(...ring.map(q => q.y)),
});

/**
 * Why an opening may not be changed in the existing state (8c, owner round 10): an opening on a wall that bounds the
 * mamad, a window and an entry door are locked from the moment they exist, until the designer releases them.
 */
export function openingLock(s: State, o: Opening): Reason | null {
  if (o.released) return null;
  if (wallBoundsMamad(s, o.wallId)) return 'mamad-locked';
  return o.kind === 'window' ? 'window-locked' : o.kind === 'entry' ? 'entry-door-locked' : null;
}

/**
 * What approval still waits for (Task 12 reads only this): something released, the envelope not confirmed, an
 * opening of the apartment (on a wall beside an apartment room) not confirmed.
 */
export function confirmationGaps(p: Project): ('released' | 'envelope-unconfirmed' | 'opening-unconfirmed')[] {
  const s = p.existing;
  const apartment = new Set(s.rooms.filter(r => r.inApartment).map(r => r.id));
  const ofApartment = (o: Opening) => (['A', 'B'] as const).some(side => roomsOnSide(s, o.wallId, side).some(id => apartment.has(id)));
  const gaps: ('released' | 'envelope-unconfirmed' | 'opening-unconfirmed')[] = [];
  if (p.envelope === 'released' || s.openings.some(o => o.released)) gaps.push('released');
  if (p.envelope !== 'confirmed') gaps.push('envelope-unconfirmed');
  if (s.openings.some(o => !o.confirmed && ofApartment(o))) gaps.push('opening-unconfirmed');
  return gaps;
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
