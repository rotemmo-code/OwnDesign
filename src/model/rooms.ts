import { area, closeGaps, contains, dist, interiorPoint, intersection, parts, polygon, ringArea, rings, split, union } from './geo';
import { massPieces, TOUCH } from './join';
import type { Pt, Room, RoomChange, State, Wall } from './types';

// mm2, 1 less than the numbers they stand for, so that exactly 0.25 m2 and 1,000 mm2 count at any angle.
/** Least floor between walls. */
const MIN_SPACE = 249_999;
/** Least part that a separator cuts off. */
export const MIN_PART = 999;
/** Points this close are one point. */
const HAIR = 0.03;

/** Walls that count for geometry: not removed, and long enough to have a direction. */
export const live = (walls: Wall[]): Wall[] => walls.filter(w => w.status !== 'removed' && dist(w.a, w.b) >= 1);

/**
 * Removes, smallest change first, every point whose removal moves the outline by at most tol: points on a straight
 * line, repeated points, spikes. Clockwise on screen, from the topmost, then leftmost point.
 */
export function cleanRing(ring: Pt[], tol = 0.015): Pt[] {
  const left = [...ring];
  const change = (q: Pt, i: number) => {
    const a = left[(i + left.length - 1) % left.length];
    const c = left[(i + 1) % left.length];
    const l = dist(a, c);
    return l <= HAIR ? 0 : Math.abs((c.x - a.x) * (q.y - a.y) - (c.y - a.y) * (q.x - a.x)) / l;
  };
  while (left.length > 2) {
    const changes = left.map(change);
    const least = Math.min(...changes);
    if (least > tol) break;
    left.splice(changes.indexOf(least), 1);
  }
  if (left.length < 3) return [];
  if (ringArea(left) < 0) left.reverse();
  const top = left.reduce((best, p, i) => {
    const q = left[best];
    return p.y < q.y - HAIR || (p.y <= q.y + HAIR && p.x < q.x) ? i : best;
  }, 0);
  return [...left.slice(top), ...left.slice(0, top)];
}

const net = (region: Pt[][]) => region.reduce((sum, r, i) => sum + (i ? -1 : 1) * Math.abs(ringArea(r)), 0);
const box = (ring: Pt[]) => ({
  x0: Math.min(...ring.map(p => p.x)),
  y0: Math.min(...ring.map(p => p.y)),
  x1: Math.max(...ring.map(p => p.x)),
  y1: Math.max(...ring.map(p => p.y)),
});
type Box = ReturnType<typeof box>;
const meet = (a: Box, b: Box) => a.x0 <= b.x1 && b.x0 <= a.x1 && a.y0 <= b.y1 && b.y0 <= a.y1;

/** Closed floor areas, each [outline, ...holes]. */
export function spaces(state: Pick<State, 'walls' | 'separators'>): Pt[][][] {
  const walls = live(state.walls);
  const joined = union(massPieces(walls).map(p => polygon(p)));
  const pieces = parts(closeGaps(joined, TOUCH));
  const mass = pieces.map(p => rings(p));
  const held = (p: Pt) => mass.some(([shell, ...holes]) => contains(shell, p) && !holes.some(h => contains(h, p)));
  // better no change than a silent one
  if (!walls.every(w => held({ x: (w.a.x + w.b.x) / 2, y: (w.a.y + w.b.y) / 2 }))) throw new Error('a wall was lost from the wall mass');
  const open = mass.flatMap(list => list.slice(1).map(r => ({ size: Math.abs(ringArea(r)), region: [r] })));
  // an island is a hole of the smallest space around a point inside it: one on its outline may touch the space
  pieces.forEach((piece, i) => {
    const at = interiorPoint(piece);
    const round = open.filter(o => contains(o.region[0], at)).sort((p, q) => p.size - q.size);
    round[0]?.region.push(mass[i][0]);
  });
  const cut = open
    .map(o => o.region)
    .filter(region => net(region) >= MIN_SPACE)
    .flatMap(region => {
      const b = box(region[0]);
      const lines = state.separators.filter(s => meet(b, box([s.a, s.b])));
      return lines.length ? split(region, lines).filter(part => net(part) >= MIN_PART) : [region];
    });
  return cut.map(region => region.map(r => cleanRing(r)).filter(r => r.length)).filter(region => region.length);
}

/** Shared area. 0 when an outline from a file is not a polygon jsts can work with: that room then counts as new. */
function overlap(f: Pt[][], g: Pt[][]): number {
  try {
    return area(intersection(polygon(f[0], f.slice(1)), polygon(g[0], g.slice(1))));
  } catch {
    return 0;
  }
}
const equal = (f: Pt[][], g: Pt[][]) =>
  f.length === g.length && f.every((r, i) => r.length === g[i].length && r.every((p, k) => dist(p, g[i][k]) <= HAIR));

export function computeRooms(state: State, previous: Room[]): { rooms: Room[]; changes: RoomChange[] } {
  const fresh = spaces(state);
  const old = previous.map(r => [r.boundary, ...r.holes]);
  const [freshBoxes, oldBoxes] = [fresh, old].map(list => list.map(region => box(region[0])));
  // n: place in fresh, p: place in previous; the largest shared area first
  const pairs = fresh
    .flatMap((f, n) =>
      old.flatMap((g, p) => {
        if (!meet(freshBoxes[n], oldBoxes[p])) return [];
        const shared = equal(f, g) ? net(f) : overlap(f, g);
        return [{ n, p, shared, inNew: shared > net(f) / 2, inOld: shared > net(g) / 2 }];
      }),
    )
    .filter(x => x.inNew || x.inOld)
    .sort((x, y) => y.shared - x.shared);
  const own = new Map<number, number>(); // fresh -> previous
  const heir = new Map<number, number>(); // previous -> fresh
  for (const { n, p } of pairs) {
    if (own.has(n) || heir.has(p)) continue;
    own.set(n, p);
    heir.set(p, n);
  }
  const rooms = fresh.map(([boundary, ...holes], n): Room => {
    const p = own.get(n);
    const from: Room | undefined = previous[p ?? pairs.find(x => x.n === n)?.p ?? -1];
    return {
      id: p === undefined ? crypto.randomUUID() : from.id,
      name: p === undefined ? '' : from.name,
      boundary,
      holes,
      isMamad: from?.isMamad ?? false,
      inApartment: from?.inApartment ?? false,
      outdoor: from?.outdoor ?? false,
    };
  });
  const splits = previous.flatMap((room, p): RoomChange[] => {
    const cut = pairs.filter(x => x.p === p && x.inNew && (own.get(x.n) ?? p) === p).map(x => x.n);
    // the space that keeps the id is a part too, even when most of it lay outside; a room with any part has one
    const keeper = heir.get(p)!;
    const all = cut.includes(keeper) ? cut : [keeper, ...cut];
    return cut.length > 1 ? [{ type: 'split', room: room.id, parts: all.map(n => rooms[n].id) }] : [];
  });
  const merges = rooms.flatMap((room, n): RoomChange[] => {
    const from = pairs.filter(x => x.n === n && x.inOld && (heir.get(x.p) ?? n) === n).map(x => previous[x.p].id);
    return from.length > 1 ? [{ type: 'merge', room: room.id, from }] : [];
  });
  return { rooms, changes: [...splits, ...merges] };
}
