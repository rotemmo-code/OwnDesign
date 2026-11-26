import { area, buffer, difference, dist, type Geom, intersection, parts, polygon, ringArea, rings, union } from './geo';
import { axis, normalA } from './join';
import { isInside } from './kind';
import { FACE, faces, LEAST_FACE, type Metrics, roomMetrics, roomsOnSide } from './measure';
import { cleanRing, live, MIN_PART } from './rooms';
import { type Handlers, refuse } from './rules';
import { LIMITS } from './schema';
import type { FinishPlace, Id, Pt, Room, State, Wall } from './types';

/** A strip ends no farther than this many times the thicker finish from its corner; beyond, it ends square. */
const MITRE = 5;
/** mm: a finish must leave this much of a room's width (0.01 less, so that exactly 10 mm counts). */
const WIDTH = 9.99;
const FIELD = { A: 'finishA', B: 'finishB', start: 'finishStart', end: 'finishEnd' } as const;
const PLACES = Object.keys(FIELD);

const finishAt = (w: Wall, place: FinishPlace): number | null => w[FIELD[place]] ?? null;
const boxOf = (ring: Pt[], grow = 0) => ({
  x0: Math.min(...ring.map(p => p.x)) - grow,
  x1: Math.max(...ring.map(p => p.x)) + grow,
  y0: Math.min(...ring.map(p => p.y)) - grow,
  y1: Math.max(...ring.map(p => p.y)) + grow,
});
type Box = ReturnType<typeof boxOf>;
const meet = (a: Box, b: Box) => a.x0 <= b.x1 && b.x0 <= a.x1 && a.y0 <= b.y1 && b.y0 <= a.y1;

/**
 * The pieces [ring, edge, from, to] of the region's edges that lie across the wall's end (at a for 'start', at b for
 * 'end'), from and to along the edge from 0 to 1. Like faces(): an edge that runs on past the end face, into a
 * separator say, counts with the piece that covers the end face, when that is LEAST_FACE or longer.
 */
function endEdges(w: Wall, region: Pt[][], end: 'start' | 'end'): [number, number, number, number][] {
  const u = axis(w);
  const n = normalA(u);
  const s = end === 'start' ? 0 : dist(w.a, w.b);
  const along = (p: Pt) => (p.x - w.a.x) * u.x + (p.y - w.a.y) * u.y;
  const beside = (p: Pt) => (p.x - w.a.x) * n.x + (p.y - w.a.y) * n.y;
  const h = w.thickness / 2;
  return region.flatMap((ring, k) =>
    ring.flatMap((p, i): [number, number, number, number][] => {
      const q = ring[(i + 1) % ring.length];
      if (Math.abs(along(p) - s) > FACE || Math.abs(along(q) - s) > FACE) return [];
      const [op, oq] = [beside(p), beside(q)];
      const t = (o: number) => (o - op) / (oq - op);
      const [from, to] = [Math.max(Math.min(op, oq), -h), Math.min(Math.max(op, oq), h)];
      return to - from >= LEAST_FACE ? [[k, i, ...([t(from), t(to)].sort((x, y) => x - y) as [number, number])]] : [];
    }),
  );
}

/** The indoor rooms that the side or end of the wall faces. */
function roomsAt(s: State, wallId: Id, place: FinishPlace): Room[] {
  if (place === 'A' || place === 'B') {
    const ids = roomsOnSide(s, wallId, place);
    return s.rooms.filter(r => isInside(r) && ids.includes(r.id));
  }
  const w = live(s.walls).find(x => x.id === wallId);
  const end = w && boxOf([place === 'start' ? w.a : w.b], w.thickness);
  return end ? s.rooms.filter(r => isInside(r) && meet(end, boxOf(r.boundary)) && endEdges(w, [r.boundary, ...r.holes], place).length) : [];
}
/** The side faces a room inside the apartment; the end stands free in one. */
export const canFinish = (s: State, wallId: Id, place: FinishPlace): boolean => roomsAt(s, wallId, place).length > 0;

type Sub = { a: Pt; b: Pt; d: number; wall?: Id };
type Mark = { from: number; to: number; d: number; wall: Id };
/** Each ring of the room cut where finishes start and stop, with the finish in front of each piece (0: none). */
function pieces(state: State, room: Room): Sub[][] {
  const region = [room.boundary, ...room.holes];
  const marks = region.map(r => r.map((): Mark[] => []));
  // faces of this room only: the others' rings are not read
  const only = { ...state, rooms: [room] };
  const box = boxOf(room.boundary);
  for (const w of live(state.walls)) {
    if (!meet(box, boxOf([w.a, w.b], w.thickness / 2 + 1))) continue;
    const u = axis(w);
    const at = (p: Pt) => (p.x - w.a.x) * u.x + (p.y - w.a.y) * u.y;
    for (const side of ['A', 'B'] as const) {
      const d = finishAt(w, side);
      if (d !== null)
        for (const f of faces(only, w.id, side)) {
          const ring = region[f.ring];
          const [sp, sq] = [at(ring[f.edge]), at(ring[(f.edge + 1) % ring.length])];
          const [t0, t1] = [(f.from - sp) / (sq - sp), (f.to - sp) / (sq - sp)].sort((x, y) => x - y);
          marks[f.ring][f.edge].push({ from: t0, to: t1, d, wall: w.id });
        }
    }
    for (const end of ['start', 'end'] as const) {
      const d = finishAt(w, end);
      if (d !== null) for (const [k, i, from, to] of endEdges(w, region, end)) marks[k][i].push({ from, to, d, wall: w.id });
    }
  }
  return region.map((ring, k) => bridged(
    ring.flatMap((p, i) => {
      const q = ring[(i + 1) % ring.length];
      const list = marks[k][i];
      const ts = [...new Set([0, 1, ...list.flatMap(m => [m.from, m.to]).map(t => Math.max(0, Math.min(1, t)))])].sort((x, y) => x - y);
      const lerp = (t: number): Pt => ({ x: p.x + (q.x - p.x) * t, y: p.y + (q.y - p.y) * t });
      return ts.slice(1).flatMap((t1, j): Sub[] => {
        const t0 = ts[j];
        if ((t1 - t0) * dist(p, q) < 0.01) return [];
        const middle = (t0 + t1) / 2;
        const best = list.filter(m => m.from <= middle && m.to >= middle).sort((x, y) => y.d - x.d)[0];
        return [{ a: lerp(t0), b: lerp(t1), d: best?.d ?? 0, wall: best?.wall }];
      });
    }),
  ));
}

/**
 * A run of unfinished pieces, each shorter than LEAST_FACE, between two finished ones (the joint of two walls of
 * different thickness, a small step) takes the thinner of the two finishes: the plaster runs over it.
 */
function bridged(list: Sub[]): Sub[] {
  const short = (s: Sub) => !s.d && dist(s.a, s.b) < LEAST_FACE;
  const n = list.length;
  if (list.every(short) || !list.some(s => s.d)) return list;
  const out = [...list];
  for (let i = 0; i < n; i++) {
    if (!short(list[i]) || short(list[(i + n - 1) % n])) continue; // i starts a run
    let j = i;
    while (short(list[(j + 1) % n])) j++;
    const [before, after] = [list[(i + n - 1) % n], list[(j + 1) % n]];
    if (!before.d || !after.d) continue;
    const lead = before.d <= after.d ? before : after;
    for (let k = i; k <= j; k++) out[k % n] = { ...list[k % n], d: lead.d, wall: lead.wall };
  }
  return out;
}

/** Where the line p + u s meets q + v s. */
function crossing(p: Pt, u: Pt, q: Pt, v: Pt): Pt | null {
  const c = u.x * v.y - u.y * v.x;
  if (Math.abs(c) < 1e-9) return null;
  const s = ((q.x - p.x) * v.y - (q.y - p.y) * v.x) / c;
  return { x: p.x + u.x * s, y: p.y + u.y * s };
}

/**
 * The strips in front of the room's finished faces and ends. Each ends where its finished line meets the next piece's
 * (that piece's own line when it has no finish): an outer corner runs on, an inner corner shares the mitre.
 */
function roomStrips(state: State, room: Room): { wall: Id; ring: Pt[] }[] {
  const region = [room.boundary, ...room.holes];
  return pieces(state, room).flatMap((list, k) => {
    // the floor is on the right of a clockwise outline and on the left of a clockwise hole, however a file stores them
    const right = ringArea(region[k]) > 0 === (k === 0);
    const line = (s: Sub) => {
      const u = axis(s);
      const n = right ? { x: -u.y, y: u.x } : { x: u.y, y: -u.x };
      return { p: { x: s.a.x + n.x * s.d, y: s.a.y + n.y * s.d }, u, n };
    };
    return list.flatMap((s, j) => {
      if (!s.d) return [];
      const mine = line(s);
      const end = (other: Sub, at: Pt): Pt => {
        const o = line(other);
        const x = crossing(mine.p, mine.u, o.p, o.u);
        return x && dist(x, at) <= MITRE * Math.max(s.d, other.d) ? x : { x: at.x + mine.n.x * s.d, y: at.y + mine.n.y * s.d };
      };
      const [before, after] = [list[(j + list.length - 1) % list.length], list[(j + 1) % list.length]];
      return [{ wall: s.wall!, ring: [s.a, s.b, end(after, s.b), end(before, s.a)] }];
    });
  });
}

const floor = (r: Room) => polygon(r.boundary, r.holes);
/** The floor left in front of the room's finishes, in parts of MIN_PART or more; null when no finish faces it. */
function leftOf(state: State, room: Room): Geom[] | null {
  const strips = isInside(room) ? roomStrips(state, room) : [];
  if (!strips.length) return null;
  return parts(difference(floor(room), union(strips.map(s => polygon(s.ring))))).filter(g => area(g) >= MIN_PART);
}

/** Net: what is left of the room after its finishes (roomMetrics of the room is gross). null when no finish faces it. */
export function roomAfterFinish(state: State, roomId: Id): Metrics | null {
  const room = state.rooms.find(r => r.id === roomId);
  let left: Geom[] | null;
  try {
    left = room ? leftOf(state, room) : null;
  } catch {
    return null; // an outline jsts cannot work with
  }
  if (!left) return null;
  const all = left.map(g => {
    const [boundary, ...holes] = rings(g).map(r => cleanRing(r));
    return roomMetrics({ boundary, holes: holes.filter(h => h.length) }, state.separators);
  });
  if (all.length === 1) return all[0];
  return { areaMm2: all.reduce((sum, m) => sum + m.areaMm2, 0), rect: null, edges: all.flatMap(m => m.edges), steps: all.flatMap(m => m.steps) };
}

/**
 * What is drawn, by wall: its strips inside every indoor room. Only walls with something drawn. The strip runs across
 * doors and windows: they are not the wall's full height (owner, round 9).
 */
export function finishStrips(state: State): Map<Id, Geom> {
  const byWall = new Map<Id, Geom[]>();
  for (const room of state.rooms.filter(isInside)) {
    try {
      const mine = new Map<Id, Pt[][]>();
      for (const s of roomStrips(state, room)) mine.set(s.wall, [...(mine.get(s.wall) ?? []), s.ring]);
      for (const [id, list] of mine) byWall.set(id, [...(byWall.get(id) ?? []), intersection(union(list.map(r => polygon(r))), floor(room))]);
    } catch {
      // an outline jsts cannot work with: nothing drawn in that room
    }
  }
  return new Map([...byWall].map(([id, list]) => [id, union(list)]));
}

export const finishHandlers: Handlers = {
  setFinish: (p, a) => {
    if (a.state !== 'existing' && a.state !== 'planned') refuse('invalid-action');
    const s = a.state === 'existing' ? p.existing : (p.planned ?? refuse('existing-not-approved'));
    const w = s.walls.find(x => x.id === a.wallId) ?? refuse('invalid-action');
    if (!PLACES.includes(a.side)) refuse('invalid-action');
    const mm = a.mm;
    if (mm !== null && !(Number.isInteger(mm) && mm >= 1 && mm <= LIMITS.finishMax)) refuse('finish-range');
    if (w.status === 'removed') refuse('invalid-action');
    const next: State = { ...s, walls: s.walls.map(x => (x === w ? { ...w, [FIELD[a.side]]: mm } : x)) };
    if (mm !== null) {
      const rooms = roomsAt(s, w.id, a.side);
      if (!rooms.length) refuse('finish-outer-side');
      // no room left: nothing WIDTH wide; an outline jsts cannot work with is invalid-geometry, not invalid-action
      let fits: boolean;
      try {
        fits = rooms.every(r => leftOf(next, r)?.some(g => area(buffer(g, -WIDTH / 2)) > 0) ?? true);
      } catch {
        return refuse('invalid-geometry');
      }
      if (!fits) refuse('finish-no-room-left');
    }
    const project = a.state === 'existing' ? { ...p, existing: next } : { ...p, planned: next };
    return mm !== null && p.plaster === 'inWall' ? { project, notice: 'plaster-in-wall' } : { project };
  },
};
