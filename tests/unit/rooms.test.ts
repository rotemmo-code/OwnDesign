import { describe, expect, it } from 'vitest';
import { area, closeGaps, difference, intersection, polygon, ringArea, rings, union, wallBody } from '../../src/model/geo';
import { joinWalls, massPieces, TOUCH, wallOutlines } from '../../src/model/join';
import { faceLength, formatM2, roomMetrics } from '../../src/model/measure';
import { cleanRing, computeRooms, live } from '../../src/model/rooms';
import type { Pt, Room, RoomChange, Separator, State, Wall } from '../../src/model/types';
import { boxApartment, rect, wall } from '../fixtures/box';

type Line = [x1: number, y1: number, x2: number, y2: number];
const P = (x: number, y: number): Pt => ({ x, y });
const separator = ([x1, y1, x2, y2]: Line, i: number): Separator => ({ id: `s${i}`, a: P(x1, y1), b: P(x2, y2) });
const plan = (walls: Wall[], lines: Line[] = []): State => ({ walls, openings: [], separators: lines.map(separator), rooms: [] });
/** The box apartment after a change. */
const box = (change: (s: State) => unknown = () => {}): State => {
  const s = boxApartment();
  change(s);
  return s;
};
const run = (s: State) => {
  const found = computeRooms(s, s.rooms);
  return { ...found, state: { ...s, rooms: found.rooms } };
};
const metrics = (r: Room, s: State | null = null) => roomMetrics(r, s?.separators ?? []);
const areas = (s: State) => run(s).rooms.map(r => metrics(r, s).areaMm2).sort((a, b) => a - b);
const areasM2 = (s: State) => areas(s).map(formatM2);
const corners = (rooms: Room[]) => rooms.map(r => r.boundary.length).sort((a, b) => a - b);
const by = (rooms: Room[], id: string) => rooms.find(r => r.id === id)!;
/** The one room that is neither room-a nor room-b. */
const added = (rooms: Room[]) => rooms.filter(r => r.id !== 'room-a' && r.id !== 'room-b');
const near = (value: number, expected: number, tolerance = 1) => expect(Math.abs(value - expected), `${value}, not ${expected}`).toBeLessThanOrEqual(tolerance);
/** The walls with their joints filled, and as they are drawn. */
const massOf = (walls: Wall[]) => closeGaps(union(massPieces(walls).map(p => polygon(p))), TOUCH);
const drawn = (walls: Wall[]) => union(walls.map(w => wallBody(w)));
/** Four walls round a clear w x h at (0,0). */
const shell = (w: number, h: number, t = 100): Wall[] => [
  wall('t', -t, -t / 2, w + t, -t / 2, t),
  wall('r', w + t / 2, 0, w + t / 2, h, t),
  wall('b', w + t, h + t / 2, -t, h + t / 2, t),
  wall('l', -t / 2, h, -t / 2, 0, t),
];
/** A closed chain of walls through the points, centre line to centre line. */
const loop = (points: Pt[], t: number, id: string): Wall[] =>
  points.map((a, i) => {
    const b = points[(i + 1) % points.length];
    return wall(id + i, a.x, a.y, b.x, b.y, t);
  });
const partition = (...walls: Wall[]) => box(s => s.walls.splice(4, 1, ...walls));
const column = (x: number, y: number) => wall('col', x, y, x + 300, y, 200);

describe('rooms', () => {
  it('two rooms: 12.00 and 11.60 m2', () => {
    expect(areasM2(box())).toEqual(['11.60', '12.00']);
  });

  it('the computed rooms equal the fixture, with no change reported', () => {
    const s = box();
    const { rooms, changes } = run(s);
    for (const room of s.rooms) expect(by(rooms, room.id)).toEqual(room);
    expect(rooms).toHaveLength(2);
    expect(changes).toEqual([]);
  });

  it('rectangular room reports 300 x 400', () => {
    expect(metrics(by(run(box()).rooms, 'room-a')).rect).toEqual({ l: 4000, w: 3000 });
  });

  it('door and window openings do not open the room', () => {
    const s = box();
    expect(computeRooms(s, s.rooms)).toEqual(computeRooms({ ...s, openings: [] }, s.rooms));
    expect(run(s).rooms).toHaveLength(2);
  });

  it('toilet 1380 x 1501 gives 2.07 m2', () => {
    const s = plan(shell(1380, 1501));
    expect(areasM2(s)).toEqual(['2.07']);
    expect(metrics(run(s).rooms[0]).rect).toEqual({ l: 1501, w: 1380 });
  });

  it('diagonal room: area matches the shoelace value to 1 mm2 and rect is null', () => {
    const lines: Line[] = [
      [2200, 200, 4200, 4200], // from face to face
      [2150, 100, 4250, 4300], // from centre line to centre line
    ];
    for (const line of lines) {
      const { rooms } = run({ ...partition(wall('part', ...line, 100)), rooms: [] });
      expect(rooms).toHaveLength(2);
      for (const room of rooms) {
        const m = metrics(room);
        near(m.areaMm2, 11_776_393.2023);
        expect(m.rect).toBeNull();
        const sides = m.edges.map(e => e.mm).sort((a, b) => a - b);
        expect(sides).toHaveLength(4);
        [1944.098, 3944.098, 4000, 4472.136].forEach((mm, i) => near(sides[i], mm, 0.001));
      }
    }
  });

  it('a gap of 1.5 or 2 mm closes; 2.1 and 10 mm do not', () => {
    const rooms = (gap: number) => computeRooms(box(s => (s.walls[4].a.y = 200 + gap)), []).rooms.length;
    expect([1.5, 2, 2.1, 10].map(rooms)).toEqual([2, 2, 1, 1]);
  });

  it('closing one gap does not open another joint', () => {
    // two walls that meet the top one at a sharp angle, and a partition of two walls 1.9 mm apart
    const walls = [...shell(10_000, 6350, 150), wall('p', 4525, 2.2, 4227, 6347.8, 100), wall('q', 3925, 4, 4333, 6346, 100)];
    const partition = [wall('u', 7425, 0, 7425, 2925, 100), wall('v', 7526.9, 1925, 7526.9, 6350, 100)];
    const apart = areas(plan([...walls, ...partition]));
    expect([areas(plan(walls)).length, apart.length]).toEqual([2, 3]);
    near(apart[0] + apart[1] + apart[2] + 100 * (2925 + 4425) + 1.9 * 1000, areas(plan(walls)).reduce((sum, v) => sum + v), 1);
  });

  it('a partition of two pieces that nearly meet keeps both rooms wherever the plan lies', () => {
    // where the pieces meet, the faces of the closed mass and of the walls are some nanometres apart; at these places a room was lost
    const places: [number, number, number[]][] = [[-0.0004, 0.9295, [173, 223, 290]], [0.0004, 0.9295, [71, 121, 131, 226]], [-0.0008, 0.979, [22, 28, 58]], [-0.0001, 0.3, [160]]];
    for (const [step, lean, list] of places)
      for (const k of list) {
        const [t, o] = [k * 0.0157, P(((k * 7919) % 30_000) + 0.5, ((k * 104_729) % 30_000) + 0.25)];
        const turn = (p: Pt) => P(o.x + p.x * Math.cos(t) - p.y * Math.sin(t), o.y + p.x * Math.sin(t) + p.y * Math.cos(t));
        const s = partition(wall('p', 3250, 200, 3250, 1700, 100), wall('q', 3250 + step, 1700, 3250 + step + lean, 4200, 100));
        const walls = s.walls.map(w => ({ ...w, a: turn(w.a), b: turn(w.b) }));
        expect(computeRooms({ ...s, walls }, []).rooms, `${step} ${k}`).toHaveLength(2);
      }
  });

  it('rooms keep id, name and flags when a wall is nudged', () => {
    const s = box(s => {
      s.rooms[1].isMamad = true;
      for (const end of [s.walls[4].a, s.walls[4].b]) end.x += 37;
    });
    const { rooms, changes } = run(s);
    const [a, b] = [by(rooms, 'room-a'), by(rooms, 'room-b')];
    expect([a.name, a.inApartment, a.isMamad, a.outdoor]).toEqual(['A', true, false, false]);
    expect([b.name, b.inApartment, b.isMamad, b.outdoor]).toEqual(['B', true, true, false]);
    expect(metrics(a).rect!.w).toBe(3037);
    expect(changes).toEqual([]);
  });

  it('removed walls do not count, walls under 1 mm are ignored, no walls give no rooms', () => {
    const s = box(s => (s.walls[4].status = 'removed'));
    expect(areasM2(s)).toEqual(['24.00']);
    s.walls.push(wall('z', 500, 500, 500, 500, 100), wall('y', 900, 900, 900.9, 900, 100));
    expect(areasM2(s)).toEqual(['24.00']);
    expect(computeRooms(plan([]), [])).toEqual({ rooms: [], changes: [] });
    for (const status of ['kept', 'new', 'moved'] as const) expect(areasM2(box(s => (s.walls[4].status = status)))).toEqual(['11.60', '12.00']);
    expect(live([0.9, 1, 1.1].map(x => wall(`w${x}`, 0, 0, x, 0, 100))).map(w => w.id)).toEqual(['w1', 'w1.1']);
  });

  it('a wall drawn twice changes nothing', () => {
    expect(areasM2(box(s => s.walls.push({ ...s.walls[4], id: 'again' })))).toEqual(['11.60', '12.00']);
  });

  it('a space under 0.25 m2 is not a room', () => {
    const rooms = (w: number, ...more: Wall[]) => run(plan([...shell(w, 500), ...more])).rooms.length;
    expect([499, 499.997, 499.999, 500].map(w => rooms(w))).toEqual([0, 0, 1, 1]); // 1 mm2 less still counts
    // a column of 60 x 60 is no floor: 0.2494 and 0.2504 m2 are left
    expect([506, 508].map(w => rooms(w, wall('c', 200, 250, 260, 250, 60)))).toEqual([0, 1]);
  });

  it('a wall that is missing from the mass is an error', () => {
    for (const x of [500, 9000]) expect(() => run(box(s => s.walls.push(wall('none', x, 500, x + 1000, 500, 0))))).toThrow('a wall was lost'); // in a room, outside
  });
});

describe('outlines', () => {
  /** The same ring from every start, both ways round. */
  const all = (ring: Pt[]) => ring.flatMap((_, k) => [[...ring.slice(k), ...ring.slice(0, k)], [...ring.slice(0, k + 1).reverse(), ...ring.slice(k + 1).reverse()]]);

  it('cleanRing: clockwise on screen from the topmost, then leftmost point, however the outline was given', () => {
    for (const y of [6.98, 7, 7.02]) {
      const ring = [P(5, 7), P(100, y), P(100, 50), P(5, 50)]; // 0.02 mm higher is not higher
      for (const given of all(ring)) expect(cleanRing(given), String(y)).toEqual(ring);
    }
    const ring = [P(100, 6.96), P(100, 50), P(5, 50), P(5, 7)];
    for (const given of all(ring)) expect(cleanRing(given)).toEqual(ring);
    const tiny = rect(5, 7, 5.5, 7.5);
    for (const given of all(tiny)) expect(cleanRing(given)).toEqual(tiny);
  });

  it('cleanRing: points up to 0.015 mm off a straight line go, repeated points and spikes too', () => {
    const ring = rect(0, 0, 100, 50);
    expect([-0.014, -0.016, 0.014, 0.016].map(y => cleanRing([P(0, 0), P(50, y), P(100, 0), P(100, 50), P(0, 50)]).length)).toEqual([4, 5, 4, 5]);
    expect(cleanRing([P(0, 0), P(0, 0), P(30, 0), P(100, 0), P(100, 0.01), P(100, 50), P(0, 50), P(0, 50)])).toEqual(ring);
    const spike = (base: number) => cleanRing([P(0, 0), P(100, 0), P(100, 20), P(130, 20), P(100, 20 + base), P(100, 50), P(0, 50)]);
    expect([spike(0), spike(0.029)]).toEqual([ring, ring]);
    expect(spike(0.031)).toHaveLength(7);
    expect([[], [P(0, 0)], [P(0, 0), P(9, 0)], [P(0, 0), P(10, 0), P(20, 0)], [P(0, 0), P(10, 0), P(5, 0.01)]].map(r => cleanRing(r))).toEqual([[], [], [], [], []]);
  });
});

describe('joints', () => {
  it('an L partition drawn centre to centre has a sharp outer corner: 205 cm, six sides', () => {
    const s = partition(wall('h', 200, 2200, 2200, 2200, 100), wall('v', 2200, 2200, 2200, 4200, 100));
    const { rooms, state } = run({ ...s, rooms: [] });
    const [small, big] = [...rooms].sort((p, q) => metrics(p).areaMm2 - metrics(q).areaMm2);
    expect(rooms).toHaveLength(2);
    near(metrics(big).areaMm2, 19_797_500);
    expect(metrics(big).edges).toHaveLength(6);
    expect([faceLength(state, big.id, 'h'), faceLength(state, big.id, 'v'), faceLength(state, small.id, 'h')]).toEqual([2050, 2050, 1950]);
  });

  it('the same corner with both ends 3 mm too long, or 1.5 mm short', () => {
    for (const d of [3, -1.5]) {
      const s = partition(wall('h', 200, 2200, 2200 + d, 2200, 100), wall('v', 2200, 2200 - d, 2200, 4200, 100));
      const { rooms } = run({ ...s, rooms: [] });
      expect(rooms.map(r => metrics(r).edges.length).sort(), String(d)).toEqual([4, 6]);
    }
  });

  it('walls of 200 and 100 mm: L, T, X and Y joints leave no notch', () => {
    const l = partition(wall('h', 100, 2200, 2200, 2200, 200), wall('v', 2200, 2200, 2200, 4300, 100));
    expect(corners(run({ ...l, rooms: [] }).rooms)).toEqual([4, 6]);
    const x = [...shell(4000, 4000), wall('a', 0, 2000, 4000, 2000, 100), wall('c', 2000, 0, 2000, 4000, 100)];
    expect(corners(run(plan(x)).rooms)).toEqual([4, 4, 4, 4]);
    const t = [...shell(4000, 4000), wall('a', 0, 2000, 4000, 2000, 200), wall('c', 2000, 2000, 2000, 4000, 100)];
    expect(corners(run(plan(t)).rooms)).toEqual([4, 4, 4]);
    const y = [...shell(4000, 4000), wall('a', 2000, 2000, 2000, 4000, 100), wall('c', 2000, 2000, 0, 800, 100), wall('d', 2000, 2000, 4000, 800, 100)];
    expect(corners(run(plan(y)).rooms)).toEqual([4, 4, 5]);
  });

  it('two walls that end at one point of a passing wall leave its far side straight', () => {
    const walls = [...shell(6000, 4000), wall('w', 0, 2000, 6000, 2000, 100), wall('a', 3000, 2000, 1500, 4000, 100), wall('c', 3000, 2000, 4500, 4000, 100)];
    const { rooms } = run(plan(walls));
    const top = rooms.find(r => r.boundary[0].y < 100)!;
    expect(top.boundary).toHaveLength(4);
    near(metrics(top).areaMm2, 6000 * 1950);
  });

  it('a thick wall that meets a thin one at an angle leaves no notch, and comes out of it only where it was drawn so', () => {
    // a wall of t at the angle ends on a wall of 100 along y = 0, at its face (y = -50), half way in or at its centre line
    for (const t of [80, 100, 200, 300])
      for (const degrees of [15, 20, 30, 45, 60, 75, 90])
        for (const end of [-52, -50, -25, 0]) {
          const [c, s] = [Math.cos((degrees * Math.PI) / 180), Math.sin((degrees * Math.PI) / 180)];
          const walls = [wall('m', -9000, 0, 9000, 0, 100), wall('n', 5000 * c, end - 5000 * s, 0, end, t)];
          const [mass, plain] = [massOf(walls), drawn(walls)];
          // both faces of the wall run on to the face of the other
          const face = (side: number): Pt[] => [P(5000 * c + (side * s * t) / 2, end - 5000 * s + (side * c * t) / 2), P(((-50 - end) * -c) / s + (side * t) / 2 / s, -50)];
          const ideal = union([polygon([...face(1), ...face(-1).reverse()]), wallBody(walls[0])]);
          const below = polygon(rect(-9000, 50, 9000, 2000));
          const text = `${t} at ${degrees}, end ${end}`;
          expect(area(difference(ideal, mass)), text).toBeLessThan(1);
          expect(area(intersection(mass, below)) - area(intersection(plain, below)), text).toBeLessThan(1);
        }
  });

  it('two thick walls that end at one point of a thin one do not come out of it', () => {
    const walls = [wall('m', -9000, 0, 9000, 0, 60), wall('a', -3000, -3030, 0, -30, 200), wall('b', 3000, -3030, 0, -30, 200)];
    const below = polygon(rect(-9000, 30, 9000, 2000));
    expect(area(intersection(massOf(walls), below)) - area(intersection(drawn(walls), below))).toBeLessThan(1);
  });

  it('walls of unlike thickness that meet at an angle have one corner inside, and fill theirs outside', () => {
    for (const degrees of [30, 45, 60, 90, 110, 135, 150, 160])
      for (const [t1, t2] of [[200, 200], [300, 100], [100, 300], [460, 200]]) {
        const u = P(Math.cos((degrees * Math.PI) / 180), Math.sin((degrees * Math.PI) / 180));
        const walls = [wall('a', 0, 0, 6000, 0, t1), wall('b', 0, 0, 6000 * u.x, 6000 * u.y, t2)];
        const mass = massOf(walls);
        // where the faces on the inner side meet: t1 / 2 from a, t2 / 2 from b
        const x = (t2 / 2 + (t1 / 2) * u.x) / u.y;
        const [inner, outer] = [P(x, t1 / 2), P(-x, -t1 / 2)];
        const [n, far] = [P(u.y, -u.x), P(6000 * u.x, 6000 * u.y)];
        const ideal = polygon([inner, P(6000, t1 / 2), P(6000, -t1 / 2), outer, P(far.x - (n.x * t2) / 2, far.y - (n.y * t2) / 2), P(far.x + (n.x * t2) / 2, far.y + (n.y * t2) / 2)]);
        expect(area(difference(ideal, mass)), `${t1} and ${t2} at ${degrees}`).toBeLessThan(1);
        // beyond the ideal only what the walls themselves are drawn with
        expect(area(difference(mass, union([ideal, drawn(walls)]))), `${t1} and ${t2} at ${degrees}`).toBeLessThan(2);
      }
  });

  it('several walls of unlike thickness at one point: one corner in each sector, where the two faces meet', () => {
    const joints = [[[0, 460], [52, 150], [110, 150], [150, 80]], [[16, 100], [81, 300], [229, 150], [280, 460]], [[10, 200], [121, 80], [250, 300]], [[0, 100], [60, 300], [120, 100], [190, 200], [300, 460]]];
    for (const [k, arms] of joints.entries()) {
      const at = arms.map(([degrees, t]) => ({ a: (degrees * Math.PI) / 180, h: t / 2 }));
      const along = ({ a }: { a: number }, s: number, off: number) => P(Math.cos(a) * s - Math.sin(a) * off, Math.sin(a) * s + Math.cos(a) * off);
      const walls = at.map((x, i) => {
        const far = along(x, 4000, 0);
        return i % 2 ? wall(`w${i}`, 0, 0, far.x, far.y, 2 * x.h) : wall(`w${i}`, far.x, far.y, 0, 0, 2 * x.h);
      });
      const meet = at.map((x, i) => {
        const y = at[(i + 1) % at.length];
        const gap = y.a - x.a;
        return along(x, (y.h + x.h * Math.cos(gap)) / Math.sin(gap), x.h);
      });
      const ideal = union(at.map((x, i) => polygon([P(0, 0), meet[(i + at.length - 1) % at.length], along(x, 4000, -x.h), along(x, 4000, x.h), meet[i]])));
      const mass = massOf(walls);
      expect(area(difference(ideal, mass)), `joint ${k}`).toBeLessThan(5);
      expect(area(difference(mass, union([ideal, drawn(walls)]))), `joint ${k}`).toBeLessThan(5);
    }
  });

  it('where each face starts and ends, at a corner of either hand and either end', () => {
    // one wall from (0,0) to the right, the other from (0,0) up or down; each drawn both ways round
    const spans = (walls: Wall[]) => [...joinWalls(walls).values()].map(j => [j.A, j.B]);
    const flip = (w: Wall): Wall => ({ ...w, a: w.b, b: w.a });
    const right = wall('h', 0, 0, 3000, 0, 100);
    for (const [y, outer, inner] of [[2000, 'A', 'B'], [-2000, 'B', 'A']] as const) {
      const other = wall('v', 0, 0, 0, y, 200);
      const j = joinWalls([right, other]);
      expect([j.get('h')![outer], j.get('h')![inner]], String(y)).toEqual([[-100, 3000], [0, 3000]]);
      expect([j.get('v')![inner], j.get('v')![outer]], String(y)).toEqual([[-50, 2000], [0, 2000]]);
      const k = joinWalls([flip(right), flip(other)]);
      expect([k.get('h')![inner], k.get('h')![outer]], String(y)).toEqual([[0, 3100], [0, 3000]]);
      expect([k.get('v')![outer], k.get('v')![inner]], String(y)).toEqual([[0, 2050], [0, 2000]]);
    }
    expect(spans([right])).toEqual([[[0, 3000], [0, 3000]]]);
  });

  it('which walls an end runs on into, and how far', () => {
    const m = wall('m', 0, 0, 1000, 0, 100);
    /** How far the end of a wall of t runs on that comes down at the angle and ends at (x, y). */
    const run = (x: number, y: number, degrees = 90, t = 100) => {
      const [c, s] = [Math.cos((degrees * Math.PI) / 180), Math.sin((degrees * Math.PI) / 180)];
      const j = joinWalls([m, wall('n', x + 2000 * c, y - 2000 * s, x, y, t)]).get('n')!;
      return Math.round((Math.min(j.A[1], j.B[1]) - 2000) * 100) / 100;
    };
    expect([-52, -52.1, -50, -20, 0, 0.5, 20].map(y => run(500, y))).toEqual([52, 0, 50, 20, 0, 0, 0]); // to the centre line, from 2 mm off
    expect([-2, -2.1, 1002, 1002.1].map(x => run(x, -50))).toEqual([50, 0, 50, 0]); // within 2 mm of its ends
    expect([15, 14.9].map(degrees => run(500, -50, degrees))).toEqual([193.19, 0]); // 50 / sin 15
    expect([run(980, -50, 135), run(20, -50, 45), run(940, -50, 135)]).toEqual([0, 0, 70.71]); // not to a place past the end of m
    expect([run(-20, -50, 135), run(1020, -50, 45)]).toEqual([0, 0]); // nor from beside m, where it only points at it
    // the body runs on when no corner of it comes out of the far face: 200 at 60 degrees just fits into 100
    const bodyEnd = (t: number) => {
      const { body } = joinWalls([m, wall('n', 500 + 1000, -50 - 1000 * Math.sqrt(3), 500, -50, t)]).get('n')!;
      return Math.round((body[1].y + body[2].y) / 2);
    };
    expect([199, 200, 201].map(bodyEnd)).toEqual([0, 0, -50]);
  });

  it('ends 5 mm apart are one joint, 5.1 mm are two; a wall that passes beside it changes nothing', () => {
    // two walls nearly in line, the second from (off, 0)
    const tips = (off: number, ...more: Wall[]) => [...joinWalls([wall('a', 0, 0, -3000, 0, 100), wall('b', off, 0, off + 3000, 500, 100), ...more]).values()].slice(0, 2).map(j => j.tips.length);
    expect([0, 5, 5.1].map(off => tips(off))).toEqual([[1, 1], [1, 1], [0, 0]]);
    const across = (id: string, x: number) => wall(id, x, -1000, x, 1000, 100);
    expect([53, 52, 0].map(x => tips(0, across('c', x)))).toEqual([[1, 1], [0, 0], [0, 0]]); // 52: its body holds the joint, up to 2 mm
  });

  it('a bend of 0.1 degrees is straight, one of 0.2 is not; a step in thickness stays one up to 15 degrees', () => {
    const tips = (degrees: number, t1: number, t2: number) => {
      const a = (degrees * Math.PI) / 180;
      return [...joinWalls([wall('a', 0, 0, -3000, 0, t1), wall('b', 0, 0, 3000 * Math.cos(a), 3000 * Math.sin(a), t2)]).values()].map(j => j.tips.length);
    };
    expect([0.1, 0.2, 10].map(degrees => tips(degrees, 200, 200))).toEqual([[0, 0], [1, 1], [1, 1]]);
    // 200 and 100: at 14.9 degrees only the outer side of the thin wall runs on, at 15 also the inner side of the thick one
    expect([14.9, 15].map(degrees => tips(degrees, 200, 100))).toEqual([[0, 1], [1, 1]]);
  });

  it('a face that just reaches the other gets no tip, at any angle; nor does a wall that passes', () => {
    for (let k = 0; k < 40; k++) {
      const at = (degrees: number, length: number) => P(Math.cos(k + (degrees * Math.PI) / 180) * length, Math.sin(k + (degrees * Math.PI) / 180) * length);
      const from = (id: string, p: Pt, q: Pt, t: number) => wall(id, p.x, p.y, q.x, q.y, t);
      const tips = (...walls: Wall[]) => [...joinWalls(walls).values()].map(j => j.tips.length);
      // at 120 degrees the inner faces of 200 and 100 meet exactly where the face of the thick wall starts
      expect(tips(from('a', P(0, 0), at(0, 3000), 200), from('b', P(0, 0), at(120, 3000), 100)), `${k}`).toEqual([0, 1]);
      // a thin wall that leaves a thick one at 30 degrees; the third wall is elsewhere
      const apart = from('z', P(0, 50_000), P(3000, 50_000), 100);
      expect(tips(from('m', at(180, 3000), at(0, 3000), 200), from('n', P(0, 0), at(30, 3000), 50), apart), `${k}`).toEqual([0, 0, 0]);
    }
  });

  it('walls within 1 degree of each other lie on each other', () => {
    const tips = (degrees: number) => {
      const a = (degrees * Math.PI) / 180;
      return [...joinWalls([wall('a', 0, 0, 3000, 0, 100), wall('a2', 0, 0, 1000 * Math.cos(a), 1000 * Math.sin(a), 200), wall('b', 0, 0, 0, 3000, 100)]).values()].map(j => j.tips.length);
    };
    expect([1, 1.1].map(tips)).toEqual([[0, 1, 1], [1, 0, 1]]);
  });

  it('of equal walls that lie on each other the first takes part in the joint, at any angle; a wall that passes before all', () => {
    for (let k = 0; k < 40; k++) {
      const at = (degrees: number, length: number) => P(Math.cos(k + (degrees * Math.PI) / 180) * length, Math.sin(k + (degrees * Math.PI) / 180) * length);
      const from = (id: string, p: Pt, q: Pt, t: number) => wall(id, p.x, p.y, q.x, q.y, t);
      const tips = (...walls: Wall[]) => [...joinWalls(walls).values()].map(j => j.tips.length);
      const [h, v, v2] = [from('h', P(0, 0), at(0, 3000), 100), from('v', P(0, 0), at(90, 3000), 100), from('v2', at(90, 1500), P(0, 0), 100)];
      expect([tips(h, v, v2), tips(v2, h, v)], `${k}`).toEqual([[1, 1, 0], [1, 1, 0]]);
      const [m, n] = [from('m', at(180, 3000), at(0, 3000), 100), from('n', P(0, 0), at(0, 1500), 100)];
      expect(tips(n, m, from('k', P(0, 0), at(150, 2000), 50)), `${k}`).toEqual([0, 0, 0]);
    }
  });

  it('a bend of a thick wall leaves no notch', () => {
    for (const t of [100, 300, 460, 1000])
      for (const degrees of [0.05, 0.09, 0.11, 0.3, 0.9, 1, 1.1, 3, 10]) {
        const walls = [
          ...shell(12_000, 8000),
          wall('p', 6000, 0, 6000, 4000, t),
          wall('q', 6000, 4000, 6000 + 4000 * Math.tan((degrees * Math.PI) / 180), 8000, t),
        ];
        const edges = run(plan(walls)).rooms.flatMap(r => metrics(r).edges.map(e => e.mm));
        expect(Math.min(...edges), `${t} at ${degrees}`).toBeGreaterThan(3500);
        expect(edges.length, `${t} at ${degrees}`).toBeLessThanOrEqual(10);
      }
  });

  it('a short thick wall in a joint does not fill beyond its other end', () => {
    const walls = [wall('a', 0, 0, 3000, 0, 100), wall('s', 0, 0, -20, 12, 460)];
    const added = difference(massOf(walls), drawn(walls));
    expect(Math.min(0, ...rings(added).flat().map(p => p.x))).toBeGreaterThan(-150);
    // at 150 degrees the face of the thick wall meets the face of the thin one 156.7 mm along it
    const tips = (length: number) => [...joinWalls([wall('x', 0, 0, length, 0, 50), wall('y', 0, 0, -3000 * Math.sqrt(0.75), 1500, 200)]).values()].map(j => j.tips.length);
    expect([156, 157.5].map(tips)).toEqual([[1, 0], [1, 1]]);
  });

  it('a thick diagonal wall that ends on a thin one does not poke through it', () => {
    const walls = [...shell(6000, 4000), wall('w', 0, 2000, 6000, 2000, 100), wall('d', 3000, 1950, 1200, 150, 200), wall('e', 3000, 1950, 4800, 150, 200)];
    const low = run(plan(walls)).rooms.find(r => r.boundary[0].y > 2000)!;
    expect(low.boundary).toHaveLength(4);
    near(metrics(low).areaMm2, 6000 * 1950);
  });

  it('outer walls drawn centre to centre have one sharp outline', () => {
    const walls = loop([P(100, 100), P(6300, 100), P(6300, 4300), P(100, 4300)], 200, 'o');
    const mass = union([...wallOutlines(walls).values()].map(r => polygon(r)));
    expect(cleanRing(rings(mass)[0])).toHaveLength(4);
    expect(area(mass)).toBe(6400 * 4400 - 6000 * 4000);
  });

  it('a joint sharper than 23 degrees is left square; walls on top of each other use the thicker', () => {
    const tips = (...walls: Wall[]) => [...joinWalls(walls).values()].map(j => j.tips.length);
    const at = (degrees: number) => wall('b', 0, 0, 3000 * Math.cos((degrees * Math.PI) / 180), 3000 * Math.sin((degrees * Math.PI) / 180), 100);
    const first = wall('a', 0, 0, 3000, 0, 100);
    expect([17, 23, 24, 90].map(degrees => tips(first, at(degrees)))).toEqual([[0, 0], [0, 0], [1, 1], [1, 1]]);
    expect(tips(first, wall('a2', 0, 0, 300, 0, 200), wall('b', 0, 0, 0, 3000, 100))).toEqual([0, 1, 1]);
  });

  it('the joined pieces of 2,000 random joints are valid and never smaller than the walls', () => {
    let seed = 3;
    const random = () => (seed = (seed * 1103515245 + 12345) % 2147483648) / 2147483648;
    const pick = <T>(list: T[]) => list[Math.floor(random() * list.length)];
    for (let i = 0; i < 2000; i++) {
      const base = random() * 7;
      const walls = Array.from({ length: pick([2, 2, 3, 4]) }, (_, j) => {
        const angle = base + (j ? random() * 6.28 : 0);
        const length = pick([10, 30, 60, 300, 2000, 4000]);
        const off = (random() - 0.5) * pick([0, 0, 1, 3]);
        return wall(`w${j}`, 5000 + off, 5000 - off, 5000 + Math.cos(angle) * length, 5000 + Math.sin(angle) * length, pick([20, 80, 100, 150, 200, 250, 460]));
      });
      const joined = area(union(massPieces(walls).map(p => polygon(p))));
      const plain = area(drawn(walls));
      expect(plain, `joint ${i}`).toBeGreaterThan(0);
      expect(joined, `joint ${i}`).toBeGreaterThanOrEqual(plain - 1);
    }
  });

  it('a removed wall keeps its plain rectangle and fills no joint', () => {
    const l = [wall('h', 0, 0, 2000, 0, 100), wall('v', 2000, 0, 2000, 2000, 100)];
    const outline = (id: string) => wallOutlines(l).get(id)!;
    expect(cleanRing(outline('h'))).toHaveLength(5);
    l[1].status = 'removed';
    expect(outline('h')).toEqual([P(0, -50), P(2000, -50), P(2000, 50), P(0, 50)]);
    expect(outline('v')).toEqual([P(2050, 0), P(2050, 2000), P(1950, 2000), P(1950, 0)]);
  });

  it('a room corner of 10 or 5 degrees stays exact', () => {
    for (const degrees of [10, 5]) {
      const slope = Math.tan((degrees * Math.PI) / 180);
      const h = 6000 * slope;
      // the inner face of the sloping wall runs through (0,0) and (6000,h)
      const [x, y] = [-50 * Math.sin((degrees * Math.PI) / 180), 50 * Math.cos((degrees * Math.PI) / 180)];
      const walls = [wall('a', -2500, -50, 6100, -50, 100), wall('b', 6050, -100, 6050, h + 400, 100), wall('c', -2400 + x, -2400 * slope + y, 6150 + x, 6150 * slope + y, 100)];
      const { rooms } = run(plan(walls));
      expect(corners(rooms), String(degrees)).toEqual([3]);
      near(metrics(rooms[0]).areaMm2, (6000 * h) / 2);
    }
  });
});

describe('holes', () => {
  const closedBox = loop([P(4200, 1200), P(5700, 1200), P(5700, 2700), P(4200, 2700)], 100, 'k');

  it('a free-standing 30 x 20 cm column is a hole: 11.54 m2', () => {
    const { rooms, changes } = run(box(s => s.walls.push(column(4500, 2200))));
    const b = by(rooms, 'room-b');
    expect(b.holes.map(h => Math.abs(ringArea(h)))).toEqual([60_000]);
    expect(formatM2(metrics(b).areaMm2)).toBe('11.54');
    expect(metrics(b).rect).toEqual({ l: 4000, w: 2900 });
    expect(changes).toEqual([]);
  });

  it('a column that touches a wall is not a hole', () => {
    const b = by(run(box(s => s.walls.push(column(3300, 2200)))).rooms, 'room-b');
    expect(b.holes).toEqual([]);
    expect(formatM2(metrics(b).areaMm2)).toBe('11.54');
  });

  it('a closed box inside a room is counted once, and reported as a split', () => {
    const { rooms, changes } = run(box(s => s.walls.push(...closedBox)));
    const [inner] = added(rooms);
    expect(rooms).toHaveLength(3);
    expect(formatM2(metrics(by(rooms, 'room-b')).areaMm2)).toBe('9.04');
    expect(formatM2(metrics(inner).areaMm2)).toBe('1.96');
    expect(changes).toEqual([{ type: 'split', room: 'room-b', parts: ['room-b', inner.id] }]);
    expect(inner.inApartment).toBe(true);
  });

  it("a column inside the inner room is the inner room's hole only", () => {
    const { rooms } = run(box(s => s.walls.push(...closedBox, column(4800, 1900))));
    expect(rooms.map(r => r.holes.length).sort()).toEqual([0, 1, 1]);
    expect(formatM2(metrics(added(rooms)[0]).areaMm2)).toBe('1.90');
  });
});

describe('separators', () => {
  /** m2 of the parts of a room of 6 x 4 m with a column of 30 x 30 cm, cut by the lines. */
  const cut = (...lines: Line[]) => areas(plan([...shell(6000, 4000), wall('c', 1500, 1650, 1800, 1650, 300)], lines)).map(v => Math.round(v) / 1e6);

  it('a line splits a room in two with no area lost', () => {
    expect(cut()).toEqual([23.91]);
    expect(cut([4000, 0, 4000, 4000])).toEqual([8, 15.91]);
    expect(cut([1650, 0, 1650, 1500], [1650, 1800, 1650, 4000])).toEqual([6.555, 17.355]);
    expect(cut([1650, 0, 1650, 4000])).toEqual([6.555, 17.355]);
  });

  it('crossing lines, a T, an L of two lines, and a line by way of a column', () => {
    expect(cut([4000, 0, 4000, 4000], [0, 2500, 6000, 2500])).toEqual([3, 5, 6, 9.91]);
    expect(cut([4000, 0, 4000, 4000], [4000, 2500, 6000, 2500])).toEqual([3, 5, 15.91]);
    expect(cut([4000, 0, 4000, 2000], [4000, 2000, 6000, 2000])).toEqual([4, 19.91]);
    expect(cut([0, 1650, 1500, 1650], [1800, 1650, 6000, 1650])).toEqual([9.855, 14.055]);
  });

  it('a line that does not reach does not split: 5 mm short no, 1 mm short yes, to a column only no', () => {
    expect(cut([4000, 0, 4000, 3995])).toEqual([23.91]);
    expect(cut([4000, 1, 4000, 3999])).toEqual([8, 15.91]);
    expect(cut([0, 1650, 1500, 1650])).toEqual([23.91]);
    expect(cut([4000, 0, 4000, 3500])).toEqual([23.91]);
  });

  it('a line drawn into the walls, along a wall, or twice', () => {
    expect(cut([4000, -90, 4000, 4090])).toEqual([8, 15.91]);
    expect(cut([0, 0, 6000, 0])).toEqual([23.91]);
    expect(cut([4000, 0, 4000, 4000], [4000, 4000, 4000, 0])).toEqual([8, 15.91]);
  });

  it('a line from a corner, at any angle of the plan', () => {
    for (const t of [0, 0.1, 0.37, 1, 2, 3, 4.5, 6]) {
      const turn = (p: Pt): Pt => P(9000 + p.x * Math.cos(t) - p.y * Math.sin(t), 7000 + p.x * Math.sin(t) + p.y * Math.cos(t));
      const s = plan([...shell(6000, 4000), wall('c', 1500, 1650, 1800, 1650, 300)], [[0, 0, 6000, 4000]]);
      for (const item of [...s.walls, ...s.separators]) Object.assign(item, { a: turn(item.a), b: turn(item.b) });
      const parts = areas(s);
      expect(parts, String(t)).toHaveLength(2);
      near(parts[0] + parts[1], 23.91e6, 1e-3);
    }
  });

  it('one line across two rooms splits both', () => {
    const { rooms, changes } = run(box(s => (s.separators = [separator([200, 2200, 6200, 2200], 0)])));
    expect(rooms).toHaveLength(4);
    expect(changes.map(c => c.type === 'split' && c.room).sort()).toEqual(['room-a', 'room-b']);
  });

  it('a separator never closes an open space', () => {
    const walls = [wall('t', -100, -50, 4100, -50, 100), wall('l', -50, 0, -50, 3000, 100), wall('r', 4050, 0, 4050, 3000, 100)];
    expect(run(plan(walls, [[0, 3000, 4000, 3000]])).rooms).toEqual([]);
    expect(run(plan([...walls, wall('b', -100, 3050, 4100, 3050, 100)], [[0, 3000, 4000, 3000]])).rooms).toHaveLength(1);
  });

  it('a part under 0.25 m2 stays a room, so no area is lost', () => {
    expect(cut([0, 400, 400, 0])).toEqual([0.08, 23.83]);
  });

  it('a part under 1,000 mm2, or thinner than a hair, is dropped', () => {
    // triangles of 998.2 and 999.04 mm2: 1 mm2 less still counts
    expect([44.68, 44.7].map(x => cut([0, x, x, 0]).length)).toEqual([1, 2]);
    expect(areas(plan(shell(100_000, 1000), [[0, 0.012, 100_000, 0.012]])).map(Math.round)).toEqual([99_998_800]);
  });
});

describe('identity and changes', () => {
  it('split by a wall: the larger part keeps id and name, the other is new, both keep the flags', () => {
    const s = box(s => {
      s.rooms[0].isMamad = true;
      s.walls.push(wall('n', 200, 1250, 3200, 1250, 100));
    });
    const { rooms, changes } = run(s);
    const [other] = added(rooms);
    expect(rooms).toHaveLength(3);
    expect([by(rooms, 'room-a').name, by(rooms, 'room-a').isMamad]).toEqual(['A', true]);
    near(metrics(by(rooms, 'room-a')).areaMm2, 3000 * 2900);
    near(metrics(other).areaMm2, 3000 * 1000);
    expect([other.name, other.inApartment, other.isMamad, other.outdoor]).toEqual(['', true, true, false]);
    expect(changes).toEqual([{ type: 'split', room: 'room-a', parts: ['room-a', other.id] }]);
  });

  it('split by a separator is reported the same way, and an outdoor room stays outdoor', () => {
    const s = box(s => {
      s.rooms[1].outdoor = true;
      s.separators = [separator([3300, 1200, 6200, 1200], 0)];
    });
    const { rooms, changes } = run(s);
    expect(changes).toEqual([{ type: 'split', room: 'room-b', parts: ['room-b', added(rooms)[0].id] }]);
    expect(rooms.filter(r => r.id !== 'room-a').map(r => [r.outdoor, r.inApartment])).toEqual([[true, true], [true, true]]);
  });

  it('three parts are one report, larger first', () => {
    const { rooms, changes } = run(box(s => s.walls.push(wall('n', 200, 1250, 3200, 1250, 100), wall('m', 200, 2050, 3200, 2050, 100))));
    expect(changes).toHaveLength(1);
    const [change] = changes as Extract<RoomChange, { type: 'split' }>[];
    expect([change.type, change.room, change.parts[0]]).toEqual(['split', 'room-a', 'room-a']);
    expect(change.parts.map(id => Math.round(metrics(by(rooms, id)).areaMm2))).toEqual([6_300_000, 3_000_000, 2_100_000]);
  });

  it('merge: the larger room gives id, name and flags, and both old rooms are named', () => {
    const { rooms, changes } = run(box(s => s.walls.pop()));
    expect(rooms.map(r => [r.id, r.name, r.inApartment])).toEqual([['room-a', 'A', true]]);
    expect(changes).toEqual([{ type: 'merge', room: 'room-a', from: ['room-a', 'room-b'] }]);
  });

  it('a room that grows from 1.0 to 2.5 m keeps its id, and nothing is reported', () => {
    const at = (x: number) => partition(wall('part', x, 200, x, 4200, 100));
    const before = computeRooms(at(1250), []).rooms.map(r => ({ ...r, id: r.boundary[0].x < 300 ? 'small' : 'big', inApartment: true }));
    const { rooms, changes } = run({ ...at(2750), rooms: before });
    expect(metrics(by(rooms, 'small')).rect!.w).toBe(2500);
    expect(changes).toEqual([]);
  });

  it('a wall moved over most of its neighbour reports nothing while the neighbour lives', () => {
    const { rooms, changes } = run(partition(wall('part', 5250, 200, 5250, 4200, 100)));
    expect([by(rooms, 'room-a'), by(rooms, 'room-b')].map(r => metrics(r).rect)).toEqual([{ l: 5000, w: 4000 }, { l: 4000, w: 900 }]);
    expect(changes).toEqual([]);
  });

  it('a room that opens to the outside is gone, without a report', () => {
    const { rooms, changes } = run(box(s => s.walls.splice(1, 1)));
    expect(rooms.map(r => r.id)).toEqual(['room-a']);
    expect(changes).toEqual([]);
  });

  it('a room is the same when the two share more than half of either; a room that is none of the old ones has no name and no flags', () => {
    const gone = { ...box().rooms[0], id: 'gone', boundary: rect(50_000, 0, 51_000, 1000), isMamad: true, outdoor: true };
    const at = (w: number, x0: number, x1: number) => {
      const [room] = computeRooms(plan(shell(w, 2000)), [gone, { ...gone, id: 'old', boundary: rect(x0, 0, x1, 2000) }]).rooms;
      return [room.id === 'old', room.name, room.isMamad, room.inApartment, room.outdoor];
    };
    const [same, other] = [[true, 'A', true, true, true], [false, '', false, false, false]];
    // 2 m wide, before 5 m wide; then the other way round; 45 and 55 % of the smaller one are shared
    expect([0.45, 0.55].map(q => at(2000, 2000 - q * 2000, 7000 - q * 2000))).toEqual([other, same]);
    expect([0.45, 0.55].map(q => at(5000, 5000 - q * 2000, 7000 - q * 2000))).toEqual([other, same]);
    // a corner, and a column in it, in common are not enough
    for (const holes of [[], [rect(400, 400, 600, 600)]]) {
      const walls = [...shell(9000, 1000), ...holes.map(() => wall('c', 400, 500, 600, 500, 200))];
      const [room] = computeRooms(plan(walls), [{ ...gone, id: 'old', boundary: rect(0, 0, 1000, 9000), holes }]).rooms;
      expect([room.id === 'old', room.boundary[0], room.holes]).toEqual([false, P(0, 0), holes]);
    }
  });

  it('a corridor moved by less than half its width stays itself, by more it goes into one neighbour and out of the other', () => {
    const walls = (by: number) => [...shell(9000, 4000), wall('p', 3000 + by, 0, 3000 + by, 4000, 100), wall('q', 4500 + by, 0, 4500 + by, 4000, 100)];
    const inOrder = (rooms: Room[]) => rooms.sort((p, q) => p.boundary[0].x - q.boundary[0].x);
    const before = inOrder(computeRooms(plan(walls(0)), []).rooms).map((r, i) => ({ ...r, id: `r${i}` }));
    const after = (by: number) => {
      const { rooms, changes } = computeRooms(plan(walls(by)), before);
      return { ids: inOrder(rooms).map(r => r.id), changes };
    };
    expect(after(500)).toEqual({ ids: ['r0', 'r1', 'r2'], changes: [] });
    const { ids: [left, middle, right], changes } = after(900);
    expect([left, right]).toEqual(['r0', 'r2']);
    expect(changes).toEqual([{ type: 'split', room: 'r2', parts: ['r2', middle] }, { type: 'merge', room: 'r0', from: ['r0', 'r1'] }]);
  });

  it('only the rooms that merge are reported, not the third one', () => {
    const walls = [...shell(9000, 4000), wall('p', 3000, 0, 3000, 4000, 100), wall('q', 6000, 0, 6000, 4000, 100)];
    const before = computeRooms(plan(walls), []).rooms;
    const { rooms, changes } = computeRooms(plan(walls.slice(0, -1)), before);
    expect(rooms).toHaveLength(2);
    expect(changes).toHaveLength(1);
    expect(changes[0].type === 'merge' && changes[0].from).toHaveLength(2);
  });

  it('only spaces that are mostly in the old room make a split, only old rooms that are mostly in the space make a merge', () => {
    const old = (id: string, boundary: Pt[]): Room => ({ ...box().rooms[0], id, boundary });
    // the old room is 1 x 4 m; a corner of it is cut off, and the rest is now a part of 4 x 4 m
    const grown = computeRooms(plan(shell(4000, 4000), [[0, 950, 1000, 950], [1000, 0, 1000, 950]]), [old('p', rect(0, 0, 1000, 4000))]);
    expect([grown.rooms.length, grown.changes]).toEqual([2, []]);
    // 3 x 2 m: a fifth of p, and all of q
    const shrunk = computeRooms(plan(shell(3000, 2000)), [old('p', rect(0, 0, 1800, 9000)), old('q', rect(1800, 0, 3000, 2000))]);
    expect([shrunk.rooms.map(r => r.id), shrunk.changes]).toEqual([['p'], []]);
  });

  it('what lies in a hole of a room is not part of it', () => {
    // a closed box of 1500 x 1500 outside: the walls of 100 leave a room in it, the walls of 600 do not
    const inBox = (t: number) => plan([...shell(6000, 4000), ...loop([P(2000, 1000), P(3500, 1000), P(3500, 2500), P(2000, 2500)].map(p => P(p.x + (p.x > 2500 ? -1 : 1) * (t / 2), p.y + (p.y > 1500 ? -1 : 1) * (t / 2))), t, 'k')]);
    const [thin, thick] = [100, 600].map(t => inBox(t));
    const both = computeRooms(thin, []).rooms.map((r, i) => ({ ...r, id: `r${i}`, inApartment: true }));
    const big = both.find(r => r.holes.length)!;
    expect(both).toHaveLength(2);
    expect(computeRooms(thick, both)).toEqual({ rooms: [big], changes: [] }); // the inner room is gone, not merged
    const again = computeRooms(thin, [big]);
    expect(again.changes).toEqual([]); // the inner room is new, not split off
    expect(again.rooms.map(r => [r.id === big.id, r.inApartment]).sort()).toEqual([[false, false], [true, true]]);
  });

  it('ids are never shared', () => {
    const lines: Line[] = [1200, 2200, 4200].map(x => [x, 200, x, 4200]);
    const ids = run(box(s => (s.separators = lines.map(separator)))).rooms.map(r => r.id);
    expect(ids).toHaveLength(5);
    expect(new Set(ids).size).toBe(5);
    for (const id of ids) expect(id).toMatch(/^[a-z0-9-]{1,40}$/);
  });

  it('a broken outline in a file only loses its identity', () => {
    const zigzag = [P(500, 500), P(500, 2000), P(1500, 500), P(0, 4000), P(2000, 3000), P(0, 500), P(3500, 3500), P(500, 2500)];
    const { rooms } = run(box(s => (s.rooms[0].boundary = zigzag)));
    expect(rooms).toHaveLength(2);
    expect(by(rooms, 'room-b').name).toBe('B');
    const dot = run(box(s => (s.rooms[0].boundary = [P(500, 500)]))).rooms;
    expect(dot.map(r => r.name).sort()).toEqual(['', 'B']);
  });
});
