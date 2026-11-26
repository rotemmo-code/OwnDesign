import { expect, it } from 'vitest';
import { area, contains, corners, difference, dist, intersection, parts, polygon, ringArea, wallBody } from '../../src/model/geo';
import { joinWalls } from '../../src/model/join';
import { wallKind } from '../../src/model/kind';
import { faceLength, roomMetrics, roomsOnSide } from '../../src/model/measure';
import { computeRooms, spaces } from '../../src/model/rooms';
import type { Pt, Room, Separator, State, Wall } from '../../src/model/types';
import { boxApartment, wall } from '../fixtures/box';

const RUNS = Number(process.env.ETELIER_RUNS ?? 300);
const LIMIT = RUNS * 60;
type Move = (p: Pt) => Pt;
const P = (x: number, y: number): Pt => ({ x, y });

/** mulberry32: the same plans on every run. */
const randomFrom = (seed: number) => () => {
  seed = (seed + 0x6d2b79f5) | 0;
  let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
  t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
  return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
};
const tools = (random: () => number) => ({
  whole: (from: number, to: number) => from + Math.floor(random() * (to - from + 1)),
  pick: <T>(list: T[]): T => list[Math.floor(random() * list.length)],
  yes: (chance: number) => random() < chance,
});
/** The same plan turned by t and moved to p. */
const turn = (t: number, p: Pt): Move => q => P(p.x + q.x * Math.cos(t) - q.y * Math.sin(t), p.y + q.x * Math.sin(t) + q.y * Math.cos(t));
const anywhere = (random: () => number) => turn(random() * 7, P(random() * 3e4, random() * 3e4));
const moved = (walls: Wall[], move: Move) => walls.map(w => ({ ...w, a: move(w.a), b: move(w.b) }));
const lines = (list: [Pt, Pt][], move: Move): Separator[] => list.map(([a, b], i) => ({ id: `s${i}`, a: move(a), b: move(b) }));
const same: Move = p => p;
const net = (region: Pt[][]) => region.reduce((sum, r, i) => sum + (i ? -1 : 1) * Math.abs(ringArea(r)), 0);
const sorted = (list: number[]) => [...list].sort((a, b) => a - b);
const between = (a: Pt, b: Pt, t: number) => P(a.x + (b.x - a.x) * t, a.y + (b.y - a.y) * t);
const loop = (points: Pt[], t: number, id: string): Wall[] =>
  points.map((a, i) => {
    const b = points[(i + 1) % points.length];
    return wall(id + i, a.x, a.y, b.x, b.y, t);
  });

/** Rectangle, L, cut corners or pieces end to end, with partitions (to faces or to centre lines), free ends, columns, a closed box. */
function plan(random: () => number): Wall[] {
  const { whole, pick, yes } = tools(random);
  const [W, H, t] = [whole(60, 110) * 100, whole(50, 80) * 100, pick([100, 150, 200])];
  const [cut, x0, y0] = [whole(6, 14) * 100, whole(15, 25) * 100, whole(10, 20) * 100];
  const walls: Wall[] = [];
  const add = (x1: number, y1: number, x2: number, y2: number, thickness: number) => walls.push(wall(`w${walls.length}`, x1, y1, x2, y2, thickness));
  const closed = (points: Pt[], thickness: number) => loop(points, thickness, '').forEach(w => add(w.a.x, w.a.y, w.b.x, w.b.y, thickness));
  const kind = whole(0, 3);
  if (kind === 0) closed([P(0, 0), P(W, 0), P(W, H), P(0, H)], t);
  else if (kind === 1) closed([P(0, 0), P(W, 0), P(W, H - y0), P(W - x0, H - y0), P(W - x0, H), P(0, H)], t);
  else if (kind === 2) closed([P(0, 0), P(W - cut, 0), P(W, cut), P(W, H), P(cut, H), P(0, H - cut)], t);
  else {
    add(-t / 2, 0, 3000, 0, t);
    add(3000, 0, W + t / 2, 0, t);
    add(W, t / 2, W, H - t / 2, t);
    add(W + t / 2, H, -t / 2, H, t);
    add(0, H - t / 2, 0, t / 2, t);
  }
  const x = whole(20, W / 100 - 30) * 100;
  const thin = pick([80, 100, 120]);
  const face = yes(0.5) ? t / 2 : 0;
  add(x, face, x, yes(0.5) ? H - face : whole(15, H / 100 - 15) * 100, thin);
  if (yes(0.5)) add(x, 2000, W - face, 2000, thin);
  if (yes(0.4)) {
    const y = whole(22, 30) * 100;
    add(face, y, x - 900, y, 100);
    add(x - 900, y, x - 900, 1200, 100);
    add(x - 900, 1200, face, 1200, 100);
  }
  if (yes(0.4)) add(W - 3537, H - 1513, W - 3237, H - 1513, 200);
  if (yes(0.3)) closed([P(300, H - 1900), P(1400, H - 1900), P(1400, H - 700), P(300, H - 700)], 100);
  if (yes(0.3)) add(x + 300, 600, x + 1400, 1500, 100);
  return walls;
}
/** Everything the model says about a plan and its separators, after a move. The rooms are in order of size; flag marks some of them. */
function look(walls: Wall[], drawn: [Pt, Pt][], move: Move, flag: number) {
  const s: State = { walls: moved(walls, move), openings: [], separators: lines(drawn, move), rooms: [] };
  s.rooms = computeRooms(s, [])
    .rooms.sort((p, q) => roomMetrics(p, []).areaMm2 - roomMetrics(q, []).areaMm2)
    .map((r, j): Room => ({ ...r, id: `r${j}`, inApartment: j % 3 !== flag, outdoor: j % 5 === flag, isMamad: j === flag }));
  const all = s.rooms.map(r => roomMetrics(r, s.separators));
  return {
    areas: all.map(m => m.areaMm2),
    facts: [
      all.map((m, j) => [m.rect === null, m.edges.length, m.steps.length, s.rooms[j].holes.length]),
      s.walls.map(w => [roomsOnSide(s, w.id, 'A').sort(), roomsOnSide(s, w.id, 'B').sort(), wallKind(s, w.id)]),
      [...joinWalls(s.walls).values()].map(j => j.tips.length),
    ],
    lengths: [
      ...all.flatMap(m => [m.rect?.l ?? 0, m.rect?.w ?? 0, ...sorted(m.edges.map(e => e.mm)), ...sorted(m.steps.map(e => e.mm))]),
      ...s.walls.flatMap(w => s.rooms.map(r => faceLength(s, r.id, w.id))),
    ],
  };
}
type Look = ReturnType<typeof look>;
/** The same facts, areas within 1 mm2, lengths within 0.001 mm. */
function alike(x: Look, y: Look, text: string) {
  expect(y.facts, text).toEqual(x.facts);
  x.areas.forEach((v, j) => expect(Math.abs(v - y.areas[j]), `${text}, area`).toBeLessThanOrEqual(1));
  x.lengths.forEach((v, j) => expect(Math.abs(v - y.lengths[j]), `${text}, length`).toBeLessThanOrEqual(0.001));
}
/** A wall 90 % inside another: Task 8 refuses it. */
const doubled = (walls: Wall[]) =>
  walls.some((p, i) => walls.some((q, j) => i !== j && contains(corners(q.a, q.b, q.thickness + 400), between(p.a, p.b, 0.5)) && area(intersection(wallBody(p), wallBody(q))) > 0.9 * area(wallBody(p))));

it(
  'rooms, measures, sides and kinds do not depend on the angle of the plan',
  () => {
    const random = randomFrom(7);
    const { pick } = tools(random);
    let compared = 0;
    for (let i = 0; i < RUNS; i++) {
      const walls = plan(random);
      const move = anywhere(random);
      if (doubled(walls)) continue;
      const found = spaces({ walls, separators: [] });
      if (!found.length) continue;
      const ring = pick(found)[0];
      const from = pick(ring);
      const k = Math.floor(random() * ring.length);
      const to = between(ring[k], ring[(k + 1) % ring.length], 0.5);
      const line: [Pt, Pt][] = dist(from, to) > 300 && random() < 0.5 ? [[from, to]] : [];
      const x = look(walls, line, same, i % 3);
      if (x.areas.some((v, j) => j && v - x.areas[j - 1] < 50)) continue; // equal rooms have no order
      compared++;
      alike(x, look(walls, line, move, i % 3), `run ${i}`);
    }
    expect(compared).toBeGreaterThan(RUNS / 3);
  },
  LIMIT,
);

it(
  'a plan that sits exactly on a limit has the same rooms, measures, sides and joints at every angle',
  () => {
    const outer = boxApartment().walls.slice(0, 4);
    const part = wall('part', 3250, 200, 3250, 4200, 100);
    /** A wall from p, degrees off the downward direction. */
    const from = (id: string, p: Pt, degrees: number, length: number, t: number) => {
      const a = (degrees * Math.PI) / 180;
      return wall(id, p.x, p.y, p.x - Math.sin(a) * length, p.y + Math.cos(a) * length, t);
    };
    const room = (w: number, h: number) => loop([P(-50, -50), P(w + 50, -50), P(w + 50, h + 50), P(-50, h + 50)], 100, 's');
    const leaning = 4000 * Math.tan((0.5 * Math.PI) / 180);
    const cases: { walls: Wall[]; lines?: [Pt, Pt][] }[] = [
      { walls: [...outer, wall('part', 3250, 202, 3250, 4200, 100)] }, // a gap of 2 mm
      { walls: [...outer, wall('p', 3250, 200, 3250, 2200, 100), wall('q', 3352, 1200, 3352, 4200, 100)] }, // 2 mm between two faces
      ...[0.1, 0.5, 2, 5].map(d => ({ walls: [...outer, wall('p', 3250, 200, 3250, 2200, 100), wall('q', 3250 + d, 2200, 3250 + d, 4200, 100)] })), // end to end, d apart
      ...[[5, 0], [3, 4], [4, 3], [0, 5]].map(([x, y]) => ({ walls: [...outer, wall('h', 200, 2200, 2200 + x, 2200, 100), wall('v', 2200, 2200 + y, 2200, 4200, 100)] })), // ends 5 mm apart
      ...[15, 30, 60].map(d => ({ walls: [...outer, part, from('n', P(3200, 800), d, 2500, 200)] })), // 15 degrees; twice as thick at 60
      { walls: [...outer, part, from('n', P(3200, 800), 15, 2500, 100)] },
      ...[0.1, 1].map(d => ({ walls: [...outer, wall('p', 3250, 200, 3250, 2000, 200), from('n', P(3250, 2000), d, 2500, 200)] })), // bends
      { walls: [...outer, wall('p', 3250, 200, 3250, 2000, 200), from('n', P(3250, 2000), 0, 2200, 100), from('m', P(3250, 2000), 1, 2500, 100)] }, // 1 degree apart
      { walls: room(500, 500) }, // 0.25 m2
      { walls: room(3000, 4000), lines: [[P(0, 1500), P(2999, 1500)]] }, // 1 mm short
      { walls: room(3000, 4000), lines: [[P(0, 100), P(20, 0)]] }, // 1,000 mm2
      { walls: [...outer, part, wall('q', 2950, 1000, 3200, 1000, 100), wall('z', 2950, 1110, 3200, 1110, 100)] }, // a face of 10 mm
      ...[0.1, 2].map(d => ({ walls: [wall('t1', 0, 100, 1200, 100, 200), wall('t2', 1200, 100 + d, 6400, 100 + d, 200), ...outer.slice(1), part] })), // steps
      { walls: [...outer, wall('part', 3250, 200, 3260, 4200, 100)] }, // sides 10 mm apart
      { walls: [...outer.slice(0, 3), wall('left', 100 + leaning, 4200, 100, 200, 200), wall('part', 3250, 200, 3250 + leaning, 4200, 100)] }, // 0.5 degrees from square
      { walls: [...outer, wall('p', 3250, 200, 3250, 2400, 100), wall('q', 3250.5, 1800, 3250.5, 4200, 100)] }, // one face 0.5 mm behind another
    ];
    for (const [i, { walls, lines: drawn = [] }] of cases.entries()) {
      const x = look(walls, drawn, same, 1);
      expect(x.areas.length, `case ${i}`).toBeGreaterThan(0);
      for (let k = 0; k < 40; k++) alike(x, look(walls, drawn, turn(k * 0.157, P((k * 7919) % 20_000, (k * 104_729) % 20_000)), 1), `case ${i}, angle ${k}`);
    }
  },
  LIMIT,
);

it(
  'noise: random plans with ends up to 1 mm off never throw, and turned they have the same rooms to 0.001 m2',
  () => {
    const random = randomFrom(17);
    const noisy = (p: Pt) => P(p.x + (random() - 0.5) * 2, p.y + (random() - 0.5) * 2);
    for (let i = 0; i < RUNS; i++) {
      const walls = moved(plan(random), noisy);
      const [x, y] = [same, anywhere(random)].map(move => spaces({ walls: moved(walls, move), separators: [] }).map(net));
      expect(y.length, `run ${i}`).toBe(x.length);
      sorted(x).forEach((v, j) => expect(Math.abs(v - sorted(y)[j]), `run ${i}`).toBeLessThan(1000));
    }
  },
  LIMIT,
);

it(
  'separators: zero width at any angle, with holes and crossing lines, against an independent cut',
  () => {
    const random = randomFrom(11);
    const { whole, pick } = tools(random);
    let cuts = 0;
    for (let i = 0; i < RUNS; i++) {
      const walls = plan(random);
      const regions = spaces({ walls, separators: [] });
      if (!regions.length) continue;
      const region = pick(regions);
      const drawn: [Pt, Pt][] = [];
      const onEdge = () => {
        const r = pick(region);
        const k = whole(0, r.length - 1);
        return between(r[k], r[(k + 1) % r.length], whole(1, 19) / 20);
      };
      const end = (): Pt => {
        const q = random();
        if (q < 0.4) return onEdge();
        if (q < 0.75) return pick(pick(region));
        if (q < 0.9 && drawn.length) return between(...pick(drawn), whole(1, 9) / 10);
        return P(whole(0, 10_000), whole(0, 7_000));
      };
      for (let n = whole(1, 4); n > 0; n--) {
        const [a, b] = [end(), end()];
        const longer = pick([0, 0, 0, 0.5, -0.5, -20, 40]) / dist(a, b);
        if (dist(a, b) > 300) drawn.push([between(a, b, -longer), between(a, b, 1 + longer)]);
      }
      const cut = (move: Move) => sorted(spaces({ walls: moved(walls, move), separators: lines(drawn, move) }).map(net));
      const mine = cut(same);
      const turned = cut(anywhere(random));
      // the space minus bodies 0.001 mm wide, each line run on by reach at both ends
      const without = (g: ReturnType<typeof polygon>, [a, b]: [Pt, Pt], reach: number) =>
        difference(g, polygon(corners(between(a, b, -reach / dist(a, b)), between(a, b, 1 + reach / dist(a, b)), 0.001)));
      const hair = (reach: number) =>
        sorted(regions.flatMap(r => parts(drawn.reduce((g, line) => without(g, line, reach), polygon(r[0], r.slice(1))))).map(area).filter(v => v >= 1000));
      const truths = [1, 1.02].map(hair);
      if (truths[0].length !== truths[1].length) continue; // an end 1.00 to 1.02 mm short: either answer is right
      if (truths[0].length > regions.length) cuts++;
      const close = (a: number[], b: number[], tolerance: number) => a.length === b.length && a.every((v, k) => Math.abs(v - b[k]) <= tolerance);
      const length = drawn.reduce((sum, [a, b]) => sum + dist(a, b), 0);
      const text = `run ${i}: ${mine} / ${turned} / ${truths.join(' / ')}`;
      expect(truths.some(truth => close(mine, truth, 2 + length * 0.02)), text).toBe(true);
      expect(close(mine, turned, 1), text).toBe(true);
      const total = (list: number[]) => list.reduce((sum, v) => sum + v, 0);
      expect(Math.abs(total(mine) - total(regions.map(net))), text).toBeLessThan(1000 * (drawn.length * 3 + 1));
    }
    expect(cuts).toBeGreaterThan(RUNS / 5);
  },
  LIMIT,
);

it(
  'hand-drawn noise: ends up to 0.7 mm off close the same rooms at any angle',
  () => {
    const random = randomFrom(13);
    const noisy = (p: Pt) => P(p.x + (random() - 0.5) * 1.4, p.y + (random() - 0.5) * 1.4);
    for (let i = 0; i < RUNS; i++) {
      const move = anywhere(random);
      const s = boxApartment();
      const { rooms } = computeRooms({ ...s, walls: moved(s.walls, p => noisy(move(p))) }, []);
      const found = sorted(rooms.map(r => roomMetrics(r, []).areaMm2));
      expect(found, `run ${i}`).toHaveLength(2);
      [11.6e6, 12e6].forEach((v, k) => expect(Math.abs(found[k] - v), `run ${i}`).toBeLessThan(15_000));
    }
  },
  LIMIT,
);

it(
  'a closed box 2.4 mm from a diagonal wall keeps its room at 400 angles (closeGaps alone loses the box at some)',
  () => {
    const outside = loop([P(0, 0), P(8000, 0), P(8000, 7900), P(1000, 7900), P(0, 7200)], 200, 'o');
    const inside = loop([P(300, 6000), P(1400, 6000), P(1400, 7200), P(300, 7200)], 100, 'k');
    for (let i = 0; i < 400; i++) {
      const move = turn(i * 0.0015708, P((i * 7919) % 20_000, (i * 104_729) % 20_000));
      expect(spaces({ walls: moved([...outside, ...inside], move), separators: [] }), `angle ${i}`).toHaveLength(2);
      // and a gap of 1.5 mm elsewhere still closes
      const gap = wall('gap', 5000, 101.5, 5000, 7800, 100);
      if (i % 4 === 0) expect(spaces({ walls: moved([...outside, ...inside, gap], move), separators: [] }), `angle ${i}`).toHaveLength(3);
    }
  },
  LIMIT,
);

it(
  'odd input does not throw: one wall, a wall on itself, a folded pair, walls far away, 1e6 mm',
  () => {
    const rooms = (...walls: Wall[]) => computeRooms({ walls, openings: [], separators: [{ id: 's', a: P(0, 0), b: P(0, 0) }], rooms: [] }, []).rooms;
    expect(rooms(...boxApartment().walls)).toHaveLength(2);
    const one = wall('a', 0, 0, 1000, 0, 100);
    expect(rooms(one)).toEqual([]);
    expect(rooms(one, wall('b', 0, 0, 1000, 0, 100))).toEqual([]);
    expect(rooms(one, wall('b', 1000, 0, 0, 3, 100))).toEqual([]);
    expect(rooms(wall('a', 0, 0, 0, 0, 100))).toEqual([]);
    expect(rooms(wall('a', 1e6 - 3000, 1e6, 1e6, 1e6, 100), wall('b', -1e6, -1e6, -1e6, -999_000, 100))).toEqual([]);
  },
  LIMIT,
);
