import { describe, expect, it } from 'vitest';
import { axis, normalA } from '../../src/model/join';
import { faceLength, faces, formatCm, formatM2, parseCm, roomMetrics, roomsOnSide } from '../../src/model/measure';
import { computeRooms } from '../../src/model/rooms';
import type { Pt, State } from '../../src/model/types';
import { boxApartment, wall } from '../fixtures/box';

const P = (x: number, y: number): Pt => ({ x, y });
/** The box apartment after a change, its rooms computed. */
const box = (change: (s: State) => unknown = () => {}): State => {
  const s = boxApartment();
  change(s);
  return { ...s, rooms: computeRooms(s, s.rooms).rooms };
};
const partition = (x1: number, y1: number, x2: number, y2: number) => box(s => (s.walls[4] = wall('part', x1, y1, x2, y2, 100)));
const metrics = (s: State, id: string) => roomMetrics(s.rooms.find(r => r.id === id)!, s.separators);
const sorted = (list: number[]) => [...list].sort((a, b) => a - b);
const near = (value: number, expected: number, tolerance = 1e-6) => expect(Math.abs(value - expected), `${value}, not ${expected}`).toBeLessThanOrEqual(tolerance);
/** Metrics of an outline, without walls. */
const outline = (...points: [number, number][]) => roomMetrics({ boundary: points.map(([x, y]) => P(x, y)), holes: [] }, []);
/** Room A with its top wall drawn as two pieces, the right one lower by d. */
const stepped = (d: number) => box(s => s.walls.splice(0, 1, wall('t1', 0, 100, 1200, 100, 200), wall('t2', 1200, 100 + d, 6400, 100 + d, 200)));

describe('faces', () => {
  it('faceLength of the partition seen from room A is 4000, openings included', () => {
    const s = box();
    expect([faceLength(s, 'room-a', 'part'), faceLength(s, 'room-b', 'part')]).toEqual([4000, 4000]);
  });

  it('the top wall is 3000 from A and 2900 from B; the right wall is 0 from A', () => {
    const s = box();
    expect([faceLength(s, 'room-a', 'top'), faceLength(s, 'room-b', 'top'), faceLength(s, 'room-a', 'right')]).toEqual([3000, 2900, 0]);
  });

  it('side A is the left hand walking a to b on screen', () => {
    expect(normalA(axis({ a: P(0, 0), b: P(10, 0) }))).toEqual(P(0, -1));
    const down = normalA(axis({ a: P(0, 0), b: P(0, 10) }));
    expect([down.x, Math.abs(down.y)]).toEqual([1, 0]);
    const s = box();
    expect([roomsOnSide(s, 'part', 'A'), roomsOnSide(s, 'part', 'B')]).toEqual([['room-b'], ['room-a']]);
  });

  it('an outer wall has no room outside and both rooms inside', () => {
    const s = box();
    expect(roomsOnSide(s, 'top', 'A')).toEqual([]);
    expect(roomsOnSide(s, 'top', 'B').sort()).toEqual(['room-a', 'room-b']);
    const spans = faces(s, 'top', 'B').sort((p, q) => p.from - q.from);
    expect(spans).toMatchObject([{ room: 'room-a', from: 200, to: 3200 }, { room: 'room-b', from: 3300, to: 6200 }]);
  });

  it('a free-standing column has its room on both sides', () => {
    const s = box(s => s.walls.push(wall('col', 4500, 2200, 4800, 2200, 200)));
    expect([roomsOnSide(s, 'col', 'A'), roomsOnSide(s, 'col', 'B')]).toEqual([['room-b'], ['room-b']]);
    expect(faceLength(s, 'room-b', 'col')).toBe(300);
  });

  it('a wall with a free end gives its longer face, not the sum of both', () => {
    const s = box(s => s.walls.push(wall('free', 3300, 2200, 4300, 2200, 100)));
    expect(faceLength(s, 'room-b', 'free')).toBe(1000);
  });

  it('two walls end to end share one straight side: 1500 and 2500', () => {
    const s = box(s => s.walls.splice(4, 1, wall('p1', 3250, 200, 3250, 1700, 100), wall('p2', 3250, 1700, 3250, 4200, 100)));
    expect([faceLength(s, 'room-a', 'p1'), faceLength(s, 'room-a', 'p2')]).toEqual([1500, 2500]);
    // a room beside the other piece is not beside this one
    const top = box(s => s.walls.splice(0, 1, wall('t1', 0, 100, 3250, 100, 200), wall('t2', 3250, 100, 6400, 100, 200)));
    expect([roomsOnSide(top, 't1', 'B'), roomsOnSide(top, 't2', 'B')]).toEqual([['room-a'], ['room-b']]);
    expect([faceLength(top, 'room-a', 't1'), faceLength(top, 'room-a', 't2')]).toEqual([3000, 0]);
  });

  it('a wall that leaves a face at an angle is not part of it', () => {
    const s = partition(2200, 200, 4200, 4200);
    const ends = faces(s, 'top', 'B').sort((p, q) => p.from - q.from).map(f => [f.from, f.to]);
    const half = 50 * Math.sqrt(5) * 0.5; // half of what the partition covers of the top wall's face
    [[200, 2200 - half], [2200 + half, 6200]].forEach((span, i) => span.forEach((mm, k) => near(ends[i][k], mm, 1e-4)));
    expect(ends).toHaveLength(2);
  });

  it('a wall that folds back sharply is not part of the face', () => {
    const s = box(s => s.walls.push(wall('p', 3600, 1000, 5600, 1000, 100), wall('q', 5600, 1000, 5600 - 1000 * Math.sqrt(3), 2000, 100)));
    for (const [id, outer] of [['p', 'A'], ['q', 'A']] as const) {
      expect(faces(s, id, outer), id).toHaveLength(1);
      near(faceLength(s, 'room-b', id), 2000 + 50 / Math.tan(Math.PI / 12), 1e-4); // to the tip
    }
  });

  it('a step of some micrometres moves no face, at any angle', () => {
    for (const [step, lean] of [[-0.0004, 0.9295], [-0.0004, -0.8047]]) {
      const lengths = (t: number) => {
        const turn = (p: Pt): Pt => P(9000 + p.x * Math.cos(t) - p.y * Math.sin(t), 7000 + p.x * Math.sin(t) + p.y * Math.cos(t));
        const s = box(s => {
          s.walls.splice(4, 1, wall('p', 3250, 200, 3250, 1700, 100), wall('q', 3250 + step, 1700, 3250 + step + lean, 4200, 100));
          for (const w of [...s.walls]) Object.assign(w, { a: turn(w.a), b: turn(w.b) });
          s.rooms = [];
        });
        return sorted(s.rooms.flatMap(r => ['p', 'q'].map(id => faceLength(s, r.id, id))));
      };
      const first = lengths(0);
      expect(first).toHaveLength(4);
      for (let k = 1; k < 40; k++) lengths(k).forEach((mm, i) => near(mm, first[i], 0.02));
    }
  });

  it('a face up to 0.5 mm behind another belongs to its wall too, 0.6 mm does not', () => {
    const behind = (d: number) => box(s => s.walls.splice(4, 1, wall('p', 3250, 200, 3250, 2400, 100), wall('q', 3250 + d, 1800, 3250 + d, 4200, 100)));
    expect([0.5, 0.6].map(d => faceLength(behind(d), 'room-b', 'p'))).toEqual([2200, 1600]);
    // and one that stands out
    expect([-0.5, -0.6].map(d => faceLength(behind(d), 'room-b', 'q'))).toEqual([2400, 1800]);
  });

  it('a face of 10 mm counts, one of 9.9 mm does not', () => {
    const nook = (mm: number) => box(s => s.walls.push(wall('q', 2950, 1000, 3200, 1000, 100), wall('z', 2950, 1100 + mm, 3200, 1100 + mm, 100)));
    const pieces = (mm: number) => faces(nook(mm), 'part', 'B').length;
    expect([pieces(10), pieces(9.9)]).toEqual([3, 2]);
  });

  it('a face that a closed gap lengthens is measured to the end, also beside a wall of 1 m', () => {
    const thick = box(s => {
      s.walls[2] = wall('bottom', 6400, 4700, 0, 4700, 1000);
      s.walls[4].b.y = 4198.5; // 1.5 mm short of it
    });
    expect(faceLength(thick, 'room-a', 'part')).toBe(4000);
    const turned = box(s => {
      s.walls[1] = wall('right', 6700, 200, 6700, 4200, 1000);
      s.walls.splice(4, 1, wall('part', 200, 2200, 6198.5, 2200, 100));
    });
    expect(Math.max(...turned.rooms.map(r => faceLength(turned, r.id, 'part')))).toBe(6000);
  });

  it('a removed wall, and an unknown id, have no face', () => {
    const s = box();
    s.walls[4].status = 'removed';
    expect([faces(s, 'part', 'A'), faces(s, 'nope', 'A'), roomsOnSide(s, 'part', 'B')]).toEqual([[], [], []]);
    expect([faceLength(s, 'room-a', 'part'), faceLength(s, 'room-a', 'nope'), faceLength(s, 'nope', 'top')]).toEqual([0, 0, 0]);
  });
});

describe('metrics', () => {
  it('a step of 0.5 or 2 mm keeps L x W and is reported; the area stays exact', () => {
    for (const d of [0.5, 2]) {
      const s = stepped(d);
      const m = metrics(s, 'room-a');
      expect([formatCm(m.rect!.l), formatCm(m.rect!.w)]).toEqual(['400', '300']);
      expect(m.edges).toHaveLength(4);
      near(m.areaMm2, 12e6 - 2000 * d, 1e-3);
      expect(m.steps).toHaveLength(1);
      near(m.steps[0].mm, d);
      near(m.steps[0].at.x, 1200, 0.01);
      near(m.steps[0].at.y, 200 + d / 2, 0.01);
      expect(metrics(s, 'room-b').steps).toEqual([]);
    }
  });

  it('a step of 0.1 mm is reported, one of 0.08 mm is not', () => {
    expect([0.1, 0.08].map(d => metrics(stepped(d), 'room-a').steps.length)).toEqual([1, 0]);
  });

  it('the area does not depend on the way the outlines run', () => {
    const square = (x: number, side: number): Pt[] => [P(x, x), P(x + side, x), P(x + side, x + side), P(x, x + side)];
    const [boundary, hole] = [square(0, 1000), square(100, 200)];
    const areas = [[boundary, hole], [[...boundary].reverse(), hole], [boundary, [...hole].reverse()]].map(([b, h]) => roomMetrics({ boundary: b, holes: [h] }, []).areaMm2);
    expect(areas).toEqual([960_000, 960_000, 960_000]);
  });

  it('a step of 2.1 mm is an edge of its own: no L x W', () => {
    const m = metrics(stepped(2.1), 'room-a');
    expect([m.rect, m.edges.length, m.steps]).toEqual([null, 6, []]);
  });

  it('opposite sides 9.9 mm apart are still a rectangle, 10.1 mm are not', () => {
    const leaning = (d: number) => metrics(partition(3250, 200, 3250 + d, 4200), 'room-a').rect;
    near(leaning(9.9)!.w, 3000 + 9.9 / 2, 0.02);
    expect(leaning(10.1)).toBeNull();
    // either pair of sides, either way round
    for (const d of [9.9, -9.9, 10.1, -10.1]) {
      const ok = Math.abs(d) < 10;
      expect(outline([0, 0], [3000, 0], [3000 + d / 2, 4000], [-d / 2, 4000]).rect !== null, String(d)).toBe(ok);
      expect(outline([0, 0], [3000, -d / 2], [3000, 4000 + d / 2], [0, 4000]).rect !== null, String(d)).toBe(ok);
    }
  });

  it('a room leaning 0.4 degrees is a rectangle, 0.6 degrees is not', () => {
    const leaning = (degrees: number) => {
      const d = 4000 * Math.tan((degrees * Math.PI) / 180);
      const s = box(s => {
        s.walls[3] = wall('left', 100 + d, 4200, 100, 200, 200);
        s.walls[4] = wall('part', 3250, 200, 3250 + d, 4200, 100);
      });
      return metrics(s, 'room-a').rect !== null;
    };
    expect([0.4, 0.6, -0.4, -0.6].map(leaning)).toEqual([true, false, true, false]);
    // two square corners are not enough
    expect(outline([0, 0], [500, 0], [509, 500], [0, 500]).rect).toBeNull();
    // nor three of 89.67 degrees, when the fourth has 91
    expect(outline([0, 0], [500, 0], [497.15, 494.3], [2.88, 500]).rect).toBeNull();
    // square, but not upright
    const [x, y] = [Math.cos(0.5), Math.sin(0.5)];
    const turned = outline([0, 0], [3000 * x, 3000 * y], [3000 * x - 4000 * y, 3000 * y + 4000 * x], [-4000 * y, 4000 * x]).rect!;
    expect([formatCm(turned.l), formatCm(turned.w)]).toEqual(['400', '300']);
  });

  it('each side of a separator is measured up to it, and the separator itself is not listed', () => {
    const s = box(s => (s.separators = [{ id: 's', a: P(200, 1700), b: P(3200, 1700) }]));
    const parts = s.rooms.filter(r => r.boundary[0].x < 300).map(r => roomMetrics(r, s.separators)).sort((p, q) => p.areaMm2 - q.areaMm2);
    expect(parts.map(m => m.rect)).toEqual([{ l: 3000, w: 1500 }, { l: 3000, w: 2500 }]);
    expect(parts.map(m => sorted(m.edges.map(e => e.mm)))).toEqual([[1500, 1500, 3000], [2500, 2500, 3000]]);
  });

  it('an edge that is part wall, part separator is listed in full', () => {
    const s = box(s => {
      s.walls.push(wall('w', 3250, 2200, 4700, 2200, 100));
      s.separators = [{ id: 's', a: P(4700, 2150), b: P(6200, 2150) }];
    });
    const top = s.rooms.filter(r => r.boundary[0].x > 3250).map(r => roomMetrics(r, s.separators)).find(m => Math.abs(m.areaMm2 - 2900 * 1950) < 1)!;
    expect(top.rect).toEqual({ l: 2900, w: 1950 });
    expect(sorted(top.edges.map(e => e.mm))).toEqual([1950, 1950, 2900, 2900]);
    // the same with the separator on the other side, drawn either way
    for (const [a, b] of [[P(3300, 2150), P(4700, 2150)], [P(4700, 2150), P(3300, 2150)]]) {
      const s = box(s => {
        s.walls.push(wall('w', 4700, 2200, 6250, 2200, 100));
        s.separators = [{ id: 's', a, b }];
      });
      const found = s.rooms.filter(r => r.boundary[0].x > 3250).map(r => sorted(roomMetrics(r, s.separators).edges.map(e => e.mm)));
      expect(found).toContainEqual([1950, 1950, 2900, 2900]);
    }
  });

  it('a separator that ends 1.8 mm from a corner reports no step', () => {
    for (const [from, to] of [[3198.2, 1200], [201.8, 2200]]) {
      const s = box(s => (s.separators = [{ id: 's', a: P(from, 200), b: P(to, 4200) }]));
      expect(s.rooms).toHaveLength(3);
      expect(s.rooms.flatMap(r => roomMetrics(r, s.separators).steps)).toEqual([]);
      // and it is still not listed, although the ignored step moved its end
      const length = Math.hypot(from - to, 4000);
      expect(s.rooms.flatMap(r => roomMetrics(r, s.separators).edges).filter(e => Math.abs(e.mm - length) < 3)).toEqual([]);
    }
  });

  it('a step beside a separator is not reported, on either side of it', () => {
    // the top wall has a step of 2 mm at x = 1200; a separator ends 1 mm below it and leans by 20 degrees to either side
    const lean = Math.tan((20 * Math.PI) / 180);
    for (const [left, right, side] of [[100, 102, 1], [102, 100, -1]]) {
      const s = box(s => {
        s.walls.splice(0, 1, wall('t1', 0, left, 1200, left, 200), wall('t2', 1200, right, 6400, right, 200));
        s.separators = [{ id: 's', a: P(1200 + side * 0.342, 202.94), b: P(1200 + side * 1998 * lean * 0.5, 202 + 1998 * 0.5) }];
        s.walls.push(wall('n', 200, 1251, 3200, 1251, 100));
      });
      expect(s.rooms, String(side)).toHaveLength(4);
      expect(s.rooms.flatMap(r => roomMetrics(r, s.separators).steps), String(side)).toEqual([]);
    }
  });

  it('edges carry their ends, in order', () => {
    const { edges } = metrics(box(), 'room-a');
    const corners = [P(200, 200), P(3200, 200), P(3200, 4200), P(200, 4200)];
    expect(edges).toEqual(corners.map((a, i) => ({ a, b: corners[(i + 1) % 4], mm: i % 2 ? 4000 : 3000 })));
  });
});

describe('numbers', () => {
  it('formatCm rounds 2881 to 288 and 2885 to 289, also when it is 2884.9999999', () => {
    expect([2881, 2885, 2884.9999999, 2884.9, 0, 4.9, 5].map(formatCm)).toEqual(['288', '289', '289', '288', '0', '0', '1']);
  });

  it('formatM2: 2.07, 12.00, 11999999.9999 as 12.00, 2005000 as 2.01', () => {
    expect([1380 * 1501, 12e6, 11999999.9999, 2005000, 2004999.4, 2004999.6, 4999, 5000].map(formatM2)).toEqual(['2.07', '12.00', '12.00', '2.01', '2.00', '2.01', '0.00', '0.01']);
  });

  it('parseCm', () => {
    const finish = { min: 1, max: 200, decimals: 1 } as const;
    expect(['2.5', '20', ' 2.5 ', '0.1', '20.0'].map(text => parseCm(text, finish))).toEqual([25, 200, 25, 1, 200]);
    const bad = ['', ' ', '12,5', 'abc', '1e9', '-3', '0', '20.05', 'Infinity', '20.1', '2.', '.5', '+2', '1 2', '0x1'];
    expect(bad.map(text => parseCm(text, finish))).toEqual(bad.map(() => null));
    for (let mm = 1; mm <= 200; mm++) expect(parseCm((mm / 10).toFixed(1), finish)).toBe(mm);
    const length = { min: 10, max: 1e6, decimals: 0 } as const;
    expect(['250', '1', '100000', '0', '100001', '2.5', '999999', '1234567'].map(text => parseCm(text, length))).toEqual([2500, 10, 1e6, null, null, null, null, null]);
  });
});
