import { expect, it } from 'vitest';
import { apply } from '../../src/model/apply';
import { finishStrips, roomAfterFinish } from '../../src/model/finish';
import { area, buffer, intersection, polygon, union } from '../../src/model/geo';
import { roomMetrics } from '../../src/model/measure';
import { computeRooms } from '../../src/model/rooms';
import { ProjectSchema } from '../../src/model/schema';
import type { Action, FinishAction, Project, Pt, State, Wall } from '../../src/model/types';
import { boxApartment, boxProject, wall } from '../fixtures/box';

const RUNS = Number(process.env.ETELIER_RUNS ?? 40);

/** mulberry32: the same sequences on every run. */
const randomFrom = (seed: number) => () => {
  seed = (seed + 0x6d2b79f5) | 0;
  let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
  t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
  return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
};
const fin = (wallId: string, side: FinishAction['side'], mm: unknown): Action => ({ type: 'setFinish', state: 'existing', wallId, side, mm }) as never;
const why = (p: Project, a: Action) => {
  const r = apply(p, a);
  return r.ok ? 'ok' : r.reason;
};
const indoors = (s: State): State => ({ ...s, rooms: computeRooms(s, s.rooms).rooms.map(r => ({ ...r, inApartment: true })) });
const everyFace = (s: State, d: number): State => ({ ...s, walls: s.walls.map(w => ({ ...w, finishA: d, finishB: d, finishStart: d, finishEnd: d })) });
const gross = (s: State, id: string) => roomMetrics(s.rooms.find(r => r.id === id)!, s.separators).areaMm2;
/** Turns about (50000, 50000) by angle. */
const turn = (angle: number) => (x: number, y: number): Pt => ({ x: 50_000 + x * Math.cos(angle) - y * Math.sin(angle), y: 50_000 + x * Math.sin(angle) + y * Math.cos(angle) });
const between = (id: string, a: Pt, b: Pt, t: number): Wall => ({ ...wall(id, 0, 0, 1, 1, t), a, b });
/** The shortest edge of the room's rings. */
const shortest = (r: { boundary: Pt[]; holes: Pt[][] }) =>
  Math.min(...[r.boundary, ...r.holes].flatMap(ring => ring.map((p, i) => Math.hypot(ring[(i + 1) % ring.length].x - p.x, ring[(i + 1) % ring.length].y - p.y))));

/** Outer walls, up to two full partitions, up to two cross walls, maybe a column; any angle. */
function plan(r: () => number): State {
  const [W, H] = [4000 + Math.floor(r() * 6000), 3000 + Math.floor(r() * 5000)];
  const at = turn(r() < 0.5 ? 0 : r() * 2 * Math.PI);
  const list: [number, number, number, number, number][] = [
    [0, 100, W, 100, 200],
    [W - 100, 200, W - 100, H - 200, 200],
    [W, H - 100, 0, H - 100, 200],
    [100, H - 200, 100, 200, 200],
  ];
  const xs: number[] = [];
  for (let i = Math.floor(r() * 3); i > 0; i--) {
    const x = Math.round(600 + r() * (W - 1200));
    if (xs.every(v => Math.abs(v - x) >= 700)) xs.push(x), list.push([x, 200, x, H - 200, 100]);
  }
  const bounds = [200, ...xs.sort((a, b) => a - b), W - 200];
  for (let i = Math.floor(r() * 3); i > 0; i--) {
    const y = Math.round(600 + r() * (H - 1200));
    const k = Math.floor(r() * (bounds.length - 1));
    list.push([bounds[k] + (k ? 50 : 0), y, bounds[k + 1] - (k + 1 < bounds.length - 1 ? 50 : 0), y, 100 + Math.floor(r() * 3) * 50]);
  }
  if (r() < 0.7) {
    const [cx, cy] = [800 + r() * (W - 1600), 800 + r() * (H - 1600)];
    list.push([cx, cy, cx + 200 + r() * 300, cy, 200 + r() * 200]);
  }
  const walls = list.map(([x1, y1, x2, y2, t], i) => between(`w${i}`, at(x1, y1), at(x2, y2), t));
  return indoors({ walls, openings: [], separators: [], rooms: [] });
}

it.each([0, -5, 201, 2.5, NaN, Infinity, '20', undefined])('%s mm -> finish-range', mm => {
  expect(why(boxProject(), fin('part', 'B', mm))).toBe('finish-range');
  expect(why(boxProject(), fin('part', 'end', mm))).toBe('finish-range');
});

it('200 mm on both long walls of a 300 mm corridor -> finish-no-room-left; 145 + 145 leaves 10 mm and passes, 145 + 146 refused', () => {
  const s = boxApartment();
  const p: Project = { ...boxProject(), existing: indoors({ ...s, walls: [...s.walls, wall('k', 3300, 3850, 6200, 3850, 100)] }) };
  const then = (first: number, second: number) => {
    const r = apply(p, fin('k', 'B', first));
    return r.ok ? why(r.project, fin('bottom', 'B', second)) : r.reason;
  };
  expect([then(200, 200), then(145, 145), then(145, 146), then(100, 100)]).toEqual(['finish-no-room-left', 'ok', 'finish-no-room-left', 'ok']);
});

it('rectangles at any angle with a random finish per side: area equals the exact product within 1 mm2', () => {
  const r = randomFrom(7);
  let checked = 0;
  for (let run = 0; run < RUNS; run++) {
    const [C, at] = [2000 + r() * 2000, turn(r() * 2 * Math.PI)];
    const walls: Wall[] = [];
    for (let i = 0; i <= 3; i++)
      for (let j = 0; j < 3; j++)
        for (const [x1, y1, x2, y2] of [[j * C, i * C, (j + 1) * C, i * C], [i * C, j * C, i * C, (j + 1) * C]]) {
          const w = between(`w${walls.length}`, at(x1, y1), at(x2, y2), 100 + Math.floor(r() * 3) * 50);
          walls.push({ ...w, finishA: r() < 0.5 ? null : 1 + Math.floor(r() * 200), finishB: r() < 0.5 ? null : 1 + Math.floor(r() * 200) });
        }
    const s = indoors({ walls, openings: [], separators: [], rooms: [] });
    for (const room of s.rooms) {
      // the finish of the wall face each edge lies on
      const edges = room.boundary.map((p, i) => {
        const q = room.boundary[(i + 1) % room.boundary.length];
        const mid = { x: (p.x + q.x) / 2, y: (p.y + q.y) / 2 };
        const best = walls
          .map(w => {
            const l = Math.hypot(w.b.x - w.a.x, w.b.y - w.a.y);
            const u = { x: (w.b.x - w.a.x) / l, y: (w.b.y - w.a.y) / l };
            const [along, off] = [(mid.x - w.a.x) * u.x + (mid.y - w.a.y) * u.y, (mid.x - w.a.x) * u.y - (mid.y - w.a.y) * u.x];
            return { miss: along < 0 || along > l ? Infinity : Math.abs(Math.abs(off) - w.thickness / 2), d: (off > 0 ? w.finishA : w.finishB) ?? 0 };
          })
          .sort((x, y) => x.miss - y.miss)[0];
        return { l: Math.hypot(q.x - p.x, q.y - p.y), d: best.d };
      });
      if (edges.length !== 4) continue;
      const want = Math.max(0, edges[0].l - edges[1].d - edges[3].d) * Math.max(0, edges[1].l - edges[0].d - edges[2].d);
      expect(Math.abs((roomAfterFinish(s, room.id)?.areaMm2 ?? gross(s, room.id)) - want)).toBeLessThanOrEqual(1);
      checked++;
    }
  }
  expect(checked).toBeGreaterThan(RUNS * 8);
});

it('random plans with columns, the same finish on every face and end: area equals jsts mitre erosion within 1 mm2', () => {
  const r = randomFrom(42);
  let checked = 0;
  for (let run = 0; run < RUNS; run++) {
    const d = 1 + Math.floor(r() * 200);
    const s = everyFace(plan(r), d);
    // an edge under 10 mm is not a face and takes no finish (a column 5 mm into a room): left to the next test
    for (const room of s.rooms.filter(x => shortest(x) >= 10)) {
      checked++;
      const want = area(buffer(polygon(room.boundary, room.holes), -d));
      expect(Math.abs((roomAfterFinish(s, room.id)?.areaMm2 ?? 0) - want), `run ${run}`).toBeLessThanOrEqual(1);
    }
  }
  expect(checked).toBeGreaterThan(RUNS);
});

it('random plans without openings: gross minus after-finish equals the drawn strips inside the room within 1 mm2', () => {
  const r = randomFrom(5);
  for (let run = 0; run < RUNS; run++) {
    const base = plan(r);
    const s = { ...base, walls: base.walls.map(w => ({ ...w, finishA: r() < 0.5 ? null : 1 + Math.floor(r() * 200), finishB: r() < 0.5 ? null : 1 + Math.floor(r() * 200) })) };
    const strips = union([...finishStrips(s).values()]);
    for (const room of s.rooms) {
      const taken = gross(s, room.id) - (roomAfterFinish(s, room.id)?.areaMm2 ?? gross(s, room.id));
      expect(Math.abs(area(intersection(strips, polygon(room.boundary, room.holes))) - taken), `run ${run}`).toBeLessThanOrEqual(1);
    }
  }
});

it('convex rooms at any angle: equal to the mitre erosion within 1 mm2 where every edge is longer than 10 times the finish', () => {
  const r = randomFrom(11);
  let checked = 0;
  for (let run = 0; run < RUNS * 4; run++) {
    const [n, radius] = [3 + Math.floor(r() * 6), 2000 + r() * 3000];
    const angles = Array.from({ length: n }, () => r() * 2 * Math.PI).sort((a, b) => a - b);
    const points = angles.map(a => ({ x: 50_000 + radius * Math.cos(a) * (1 + r() * 0.5), y: 50_000 + radius * Math.sin(a) }));
    let s: State;
    try {
      s = indoors({ walls: points.map((p, i) => between(`e${i}`, p, points[(i + 1) % n], 200)), openings: [], separators: [], rooms: [] });
    } catch {
      continue;
    }
    const d = 1 + Math.floor(r() * 120);
    s = everyFace(s, d);
    for (const room of s.rooms.filter(x => !x.holes.length && shortest(x) > 10 * d)) {
      expect(Math.abs((roomAfterFinish(s, room.id)?.areaMm2 ?? 0) - area(buffer(polygon(room.boundary), -d)))).toBeLessThanOrEqual(1);
      checked++;
    }
  }
  expect(checked).toBeGreaterThan(RUNS);
});

it('random walk of setFinish and x.setWall: accepted parse, refused change nothing, net never above gross, strips never beyond what is taken off', () => {
  const r = randomFrom(3);
  const pick = <T,>(l: T[]): T => l[Math.floor(r() * l.length)];
  let p = boxProject();
  const reached = new Set<string>();
  for (let i = 0; i < RUNS * 25; i++) {
    const a: Action =
      r() < 0.75
        ? ({
            type: 'setFinish',
            state: pick(['existing', 'existing', 'planned', 'x']),
            wallId: pick([...p.existing.walls.map(w => w.id), 'nope']),
            side: pick(['A', 'B', 'start', 'end', 'C']),
            mm: pick([null, null, 1, 20, 150, 200, 0, 201, 2.5, NaN]),
          } as never)
        : { type: 'x.setWall', id: 'part', a: { x: 3250 + (r() - 0.5) * 2000, y: 200 }, b: { x: 3250 + (r() - 0.5) * 2000, y: 4200 } };
    const before = structuredClone(p);
    const res = apply(p, a);
    expect(p).toEqual(before);
    reached.add(res.ok ? 'ok' : res.reason);
    if (!res.ok) continue;
    expect(ProjectSchema.safeParse(res.project).success).toBe(true);
    p = res.project;
    const s = p.existing;
    const strips = union([...finishStrips(s).values()]);
    for (const room of s.rooms) {
      const [g, n] = [gross(s, room.id), roomAfterFinish(s, room.id)?.areaMm2 ?? gross(s, room.id)];
      expect(n).toBeLessThanOrEqual(g + 1e-6);
      expect(area(intersection(strips, polygon(room.boundary, room.holes)))).toBeLessThanOrEqual(g - n + 1);
    }
  }
  for (const x of ['existing-not-approved', 'finish-outer-side', 'finish-range', 'invalid-action', 'ok']) expect(reached).toContain(x);
}, RUNS * 500);

it('setFinish on a 220-wall grid with every face finished takes under 50 ms', () => {
  const walls: Wall[] = [];
  for (let i = 0; i <= 10; i++)
    for (let j = 0; j < 10; j++) {
      const t = i === 0 || i === 10 ? 200 : 100;
      walls.push(wall(`h${walls.length}`, j * 3000, i * 3000, (j + 1) * 3000, i * 3000, t), wall(`v${walls.length + 1}`, i * 3000, j * 3000, i * 3000, (j + 1) * 3000, t));
    }
  const s = everyFace(indoors({ walls, openings: [], separators: [], rooms: [] }), 20);
  const p: Project = { ...boxProject(), existing: s };
  const id = s.walls[25].id;
  const start = performance.now();
  expect(why(p, fin(id, 'A', 30))).toBe('ok');
  expect(performance.now() - start).toBeLessThan(50);
});
