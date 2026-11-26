import { expect, it } from 'vitest';
import {
  area,
  buffer,
  closeGaps,
  contains,
  corners,
  difference,
  distance,
  fromRings,
  interiorRings,
  intersection,
  parts,
  polygon,
  ringArea,
  rings,
  simplify,
  split,
  union,
  wallBody,
} from '../../src/model/geo';
import type { Pt } from '../../src/model/types';
import { rect, wall } from '../fixtures/box';

const P = (x: number, y: number): Pt => ({ x, y });
const square = (x: number, y: number, side: number) => rect(x, y, x + side, y + side);
const reversed = (ring: Pt[]) => [...ring].reverse();
const net = (region: Pt[][]) => region.reduce((sum, r) => sum + ringArea(r), 0);
/** The plan turned by t and moved. */
const turn = (p: Pt, t: number): Pt => P(10_555 + p.x * Math.cos(t) - p.y * Math.sin(t), 14_233 + p.x * Math.sin(t) + p.y * Math.cos(t));
const turned = (ring: Pt[], t: number) => ring.map(p => turn(p, t));
/** All the way round. */
const angles = (count: number) => Array.from({ length: count }, (_, i) => (i * 2 * Math.PI) / count);
const near = (value: number, expected: number, tolerance: number, text?: string) => expect(Math.abs(value - expected), `${text}: ${value}, not ${expected}`).toBeLessThanOrEqual(tolerance);

it('wallBody is the exact rectangle of a, b and thickness', () => {
  expect(area(wallBody(wall('w', 0, 0, 3000, 0, 100)))).toBe(300_000);
  expect(area(wallBody(wall('w', 0, 0, 3000, 4000, 100)))).toBeCloseTo(500_000, 6);
  // A side at a, A at b, B at b, B at a; A is the left hand when walking from a to b on screen
  expect(corners(P(0, 0), P(3000, 0), 100)).toEqual([P(0, -50), P(3000, -50), P(3000, 50), P(0, 50)]);
  expect(corners(P(0, 0), P(0, 3000), 100)).toEqual([P(50, 0), P(50, 3000), P(-50, 3000), P(-50, 0)]);
});

it('union, intersection, difference, also with nothing', () => {
  const a = polygon(square(0, 0, 100));
  const b = polygon(square(50, 0, 100));
  const none = union([]);
  const all = [union([a, b]), intersection(a, b), difference(a, b), none, intersection(a, none), difference(a, none), difference(none, a)];
  expect(all.map(area)).toEqual([15_000, 5_000, 5_000, 0, 0, 10_000, 0]);
  expect([intersection(none, a), union([none, a, none]), intersection(a, polygon(square(500, 0, 10)))].map(area)).toEqual([0, 10_000, 0]);
  // the hole of a frame belongs to neither
  const frame = difference(a, polygon(square(20, 20, 60)));
  expect([difference(frame, polygon(square(0, 0, 10))), union([frame, polygon(square(40, 40, 20))]), intersection(frame, b)].map(area)).toEqual([6_300, 6_800, 3_200]);
});

it('ringArea is exact far from the origin too, so that the way round a tiny ring is known', () => {
  for (const at of [0, 30_000, 1e6]) expect(ringArea(square(at, at, 0.001))).toBeCloseTo(1e-6, 12);
});

it('rings: part by part, shell clockwise on screen, then its holes the other way', () => {
  const g = union([difference(polygon(reversed(square(0, 0, 100))), polygon(square(20, 20, 20))), polygon(square(500, 0, 10))]);
  expect(parts(g)).toHaveLength(2);
  expect(rings(g).map(r => Math.sign(ringArea(r)))).toEqual([1, -1, 1]);
  expect(rings(g).map(ringArea)).toEqual([10_000, -400, 100]);
  expect(interiorRings(g).map(ringArea)).toEqual([-400]);
  for (const nothing of [union([]), buffer(polygon(square(0, 0, 100)), -60)]) expect([parts(nothing), rings(nothing), interiorRings(nothing)]).toEqual([[], [], []]);
  // however the outline was given, and however small it is
  for (const r of [square(0, 0, 0.5), reversed(square(0, 0, 0.5))]) expect(rings(polygon(r, [])).map(ringArea)).toEqual([0.25]);
  expect(rings(polygon(square(0, 0, 100), [square(20, 20, 20)])).map(ringArea)).toEqual([10_000, -400]);
});

it('fromRings: non-zero and even-odd, holes, islands, overlaps, a figure of eight, rubbish', () => {
  const A = (list: Pt[][], evenOdd?: boolean) => Math.round(area(fromRings(list, evenOdd)));
  const big = square(0, 0, 100);
  const small = square(20, 20, 20);
  expect([A([big]), A([reversed(big)])]).toEqual([10_000, 10_000]);
  expect([A([big, small]), A([big, small], true), A([big, reversed(small)])]).toEqual([10_000, 9_600, 9_600]);
  const island = square(40, 40, 20);
  expect(A([big, reversed(square(20, 20, 60)), island])).toBe(6_800);
  expect(A([big, square(20, 20, 60), island], true)).toBe(6_800);
  const beside = square(50, 0, 100);
  expect([A([big, beside]), A([big, beside], true), A([big, square(300, 0, 100)])]).toEqual([15_000, 10_000, 20_000]);
  expect(A([[P(0, 0), P(100, 100), P(100, 0), P(0, 100)]])).toBe(5_000);
  expect([A([]), A([[P(0, 0), P(1, 1)]]), A([[P(0, 0), P(10, 0), P(20, 0)]])]).toEqual([0, 0, 0]);
});

it('buffer grows with mitre corners and erodes', () => {
  const g = polygon(square(0, 0, 100));
  expect([10, -10, -60].map(mm => area(buffer(g, mm)))).toEqual([14_400, 6_400, 0]);
  expect(area(buffer(union([]), 10))).toBe(0);
  // a corner of 30 degrees stays sharp, one of 20 degrees is cut at 5 times the distance
  const tip = (degrees: number) => {
    const wedge = polygon([P(0, 0), P(1000, -1000 * Math.tan((degrees * Math.PI) / 360)), P(1000, 1000 * Math.tan((degrees * Math.PI) / 360))]);
    return Math.min(...rings(buffer(wedge, 10))[0].map(p => p.x));
  };
  expect(tip(30)).toBeCloseTo(-10 / Math.sin((15 * Math.PI) / 180), 6);
  expect(tip(20)).toBeCloseTo(-50, 6);
});

it('union and fromRings of pieces that only touch, at any angle', () => {
  // a strip of equal pieces side by side, and one that ends half way along them
  const pieces = [...Array.from({ length: 6 }, (_, i) => rect(i * 60, 0, (i + 1) * 60, 100)), rect(90, 100, 150, 400)];
  for (const t of angles(100)) {
    const list = pieces.map(r => turned(r, t));
    for (const g of [union(list.map(r => polygon(r))), fromRings(list), fromRings(list, true)]) {
      near(area(g), 54_000, 0.01, `angle ${t}`);
      expect([parts(g).length, interiorRings(g).length]).toEqual([1, 0]);
    }
  }
});

it('pieces of walls with noise on which the snapping overlay of jsts throws', () => {
  // two walls, the two tips of their corner, and a third wall; sorted from left to right and joined in halves they threw. The area is that of a scan line.
  const pieces = [
    [P(13153.8303865, 12054.2910471), P(13077.4694164, 13659.4500017), P(12877.6953446, 13649.9463062), P(12954.0563146, 12044.7873516)],
    [P(12977.5823805, 13654.6981539), P(13077.4694164, 13659.4500017), P(13072.7179481, 13759.3290616), P(12977.5823805, 13654.6981539)],
    [P(12972.855352, 13754.5863689), P(6590.2152244, 13451.4608558), P(6599.7029672, 13251.6860257), P(12982.3430948, 13554.8115388)],
    [P(12977.5992234, 13654.6989538), P(13072.7179481, 13759.3290616), P(12972.855352, 13754.5863689), P(12977.5992234, 13654.6989538)],
    [P(15712.2233586, 6588.2811307), P(15641.8811516, 8081.7028952), P(15442.102637, 8072.2930541), P(15512.444844, 6578.8712895)],
  ];
  const g = union(pieces.map(r => polygon(r)));
  near(area(g), 1_898_373.794129, 0.001);
  expect(parts(g)).toHaveLength(2);
});

it('closeGaps closes a slit up to mm wide and changes nothing else', () => {
  const two = (gap: number) => union([polygon(rect(0, 0, 3000, 100)), polygon(rect(0, 100 + gap, 3000, 200 + gap))]);
  expect([1.5, 1.9, 2.1, 4].map(gap => parts(closeGaps(two(gap), 2)).length)).toEqual([1, 1, 2, 2]);
  expect(area(closeGaps(two(4), 2))).toBe(600_000);
  expect(area(closeGaps(two(1.5), 2))).toBeCloseTo(604_500, 6);
  expect(area(closeGaps(union([]), 2))).toBe(0);
});

it('closeGaps changes nothing when a space of 0.25 m2 or more would be left with under 0.2 m2, and takes nothing away', () => {
  /** A block with a hole of w x h, and beside it a slot of the given size that opens into it. */
  const hollow = (w: number, h: number, slotW = 0, slotH = 0) => {
    const block = difference(polygon(rect(-500, -500, 3000, 1500)), polygon(rect(0, 0, w, h)));
    return slotW ? difference(block, polygon(rect(w, 100, w + slotW, 100 + slotH))) : block;
  };
  const left = (g: ReturnType<typeof polygon>, mm: number) => interiorRings(closeGaps(g, mm)).map(r => Math.round(-ringArea(r)));
  expect(left(hollow(600, 600), 700)).toEqual([360_000]);
  expect([left(hollow(510, 500), 520), left(hollow(490, 500), 520)]).toEqual([[255_000], []]);
  expect(left(hollow(100, 1.5), 2)).toEqual([]); // a slit may close
  // the hole may lose its slot, as long as 0.2 m2 of it are left
  expect(left(hollow(480, 480, 300, 90), 100)).toEqual([230_400]);
  expect(left(hollow(420, 420, 900, 90), 100)).toEqual([257_400]);
  // opening instead of closing would take 4 % away; nothing goes
  const spur = union([polygon(rect(0, 0, 1000, 1000)), polygon(rect(1000, 0, 4000, 15))]);
  expect(area(closeGaps(spur, -20))).toBe(1_045_000);
});

it('closeGaps takes nothing away where a sharp mitre would cut through a wall', () => {
  // a corner of p touches the face of top along 3 mm, and q ends 0.8 mm beside it at 4 degrees
  const walls = [wall('top', 6000, 6500, 2000, 6500, 150), wall('p', 4600, 77.2, 4302, 6422.8, 100), wall('q', 4000, 79, 4408, 6421, 100)];
  for (const t of angles(40)) {
    const g = union(walls.map(w => wallBody({ ...w, a: turn(w.a, t), b: turn(w.b, t) })));
    const closed = closeGaps(g, 2);
    expect([parts(g).length, parts(closed).length], String(t)).toEqual([1, 1]);
    near(area(difference(g, closed)), 0, 0.01, String(t));
  }
});

it('closeGaps leaves a room corner of 2.4 degrees sharp', () => {
  const tip = polygon([P(0, 0), P(6000, -6000 * Math.tan((1.2 * Math.PI) / 180)), P(6000, 6000 * Math.tan((1.2 * Math.PI) / 180))]);
  const block = difference(polygon(rect(-500, -1000, 7000, 1000)), tip);
  near(area(closeGaps(block, 2)), area(block), 1);
});

it('simplify, distance, contains', () => {
  const bent = polygon([P(0, 0), P(50, 0.3), P(100, 0), P(100, 100), P(0, 100)]);
  expect([rings(simplify(bent, 0.5))[0].length, rings(simplify(bent, 0.2))[0].length]).toEqual([4, 5]);
  expect(distance(polygon(square(0, 0, 100)), polygon(square(400, 0, 100)))).toBe(300);
  expect([P(50, 50), P(150, 50), P(50, 150), P(-50, 50)].map(p => contains(square(0, 0, 100), p))).toEqual([true, false, false, false]);
  expect(contains(reversed(square(0, 0, 100)), P(50, 50))).toBe(true);
  expect(contains([...square(0, 0, 100), ...square(0, 0, 100)], P(50, 50))).toBe(false); // twice round is outside
});

it('split keeps holes with their part', () => {
  const cut = split([square(0, 0, 1000), reversed(square(100, 100, 200))], [{ a: P(500, 0), b: P(500, 1000) }]);
  const found = cut.map(region => region.map(ringArea)).sort((p, q) => p.length - q.length);
  expect(found).toEqual([[500_000], [500_000, -40_000]]);
});

it('split loses nothing when lines almost lie on each other or only touch a corner', () => {
  const shell = rect(0, 0, 3000, 4000);
  const hole = reversed(rect(1000, 1000, 1300, 1300));
  const big = (region: Pt[][]) => net(region) > 1000;
  const cases: { lines: [Pt, Pt][]; parts: number }[] = [
    { lines: [[P(0, 2000), P(3000, 2000)], [P(0, 2000.01), P(3000, 2000.01)]], parts: 2 },
    { lines: [[P(0, 2000), P(3000, 2000)], [P(0, 2000.02), P(3000, 1999.98)], [P(3000, 2000), P(0, 2000)]], parts: 2 },
    { lines: [[P(0, 0.005), P(3000, -0.005)]], parts: 1 },
    { lines: [[P(0, 1300), P(1000, 1300)], [P(1300, 1300), P(3000, 1300)]], parts: 2 }, // along the lower side of the hole
    { lines: [[P(0, 0), P(1300, 1300)], [P(1300, 1300), P(3000, 3000)]], parts: 2 }, // by two corners of the hole
    { lines: [[P(0, 2300), P(2300, 0)]], parts: 2 }, // touches the hole at one corner
    { lines: [[P(0, 2300), P(1000, 1300)], [P(1300, 1000), P(2300, 0)]], parts: 2 }, // end at two corners
    { lines: [[P(0, 2000), P(1500, 2000)], [P(1500, 2000), P(3000, 2000)]], parts: 2 }, // two lines in one
    { lines: [[P(500, 500), P(500, 500)], [P(0, 2000), P(3000, 2000)], [P(700, 0), P(700, 0)]], parts: 2 }, // lines of no length
    { lines: [[P(0, 1000), P(800, 1000)], [P(3000, 1000), P(1650, 1000)]], parts: 1 }, // end before the corners of the hole that they point to
    { lines: [[P(800, 1000), P(0, 1000)], [P(1650, 1000), P(3000, 1000)]], parts: 1 },
    { lines: [[P(1000, -1000), P(1000, 500)], [P(500, -800), P(2500, 1200)]], parts: 1 }, // cross outside the room
    { lines: [[P(0, 2000), P(2998.8, 2000)]], parts: 1 }, // 1.2 mm short
    { lines: [[P(0, 2000), P(2999, 2000)]], parts: 2 }, // 1 mm short
  ];
  for (const [i, { lines, parts }] of cases.entries())
    for (const t of angles(100)) {
      const found = split([turned(shell, t), turned(hole, t)], lines.map(([a, b]) => ({ a: turn(a, t), b: turn(b, t) })));
      near(found.reduce((sum, region) => sum + net(region), 0), 11_910_000, 40, `case ${i}, angle ${t}`);
      expect(found.filter(big), `case ${i}, angle ${t}`).toHaveLength(parts);
    }
});

it('split loses nothing where three lines end within a few hundredths of each other and of a corner', () => {
  const room = [P(0, 0), P(3000, 0), P(4000, 1000), P(4000, 3000), P(1000, 3000), P(0, 2000)];
  const lines = [[P(0.005, 2000), P(1501.01, -0.01)], [P(0.015, 2000.03), P(4000.05, 3000.001)], [P(3998.99, 3000), P(2500.0101, 3000)]];
  for (const t of angles(200)) {
    const found = split([turned(room, t)], lines.map(([a, b]) => ({ a: turn(a, t), b: turn(b, t) })));
    near(found.reduce((sum, region) => sum + net(region), 0), 11_000_000, 1, `angle ${t}`);
  }
});

it('split makes no slivers where a line passes by corners that are not quite on it', () => {
  const region = [rect(0, 0, 3000, 4000), reversed(rect(700, 1000, 999.995, 1300)), reversed(rect(1000.005, 2000, 1300, 2300)), reversed(rect(700, 3000, 999.991, 3300))];
  for (const line of [[P(1000, 0), P(1000, 4000)], [P(1000, 4000), P(1000, 0)]]) {
    const found = split(region, [{ a: line[0], b: line[1] }]);
    expect(found.map(r => r.length)).toEqual([1, 1]); // it runs along the sides of all three holes
    near(found.reduce((sum, r) => sum + net(r), 0), net(region), 1e-3);
  }
});

it('a wall that ends on a face at an odd angle is never lost from the union', () => {
  const walls = [
    wall('a', -200, -100, 6200, -100, 200),
    wall('b', 6100, -200, 6100, 4200, 200),
    wall('c', 6200, 4100, -200, 4100, 200),
    wall('d', -100, 4200, -100, -200, 200),
    wall('e', 3050, 0, 3050, 4000, 100),
  ];
  for (const t of angles(500)) {
    const all = union(walls.map(w => wallBody({ ...w, a: turn(w.a, t), b: turn(w.b, t) })));
    near(area(all), 4_560_000, 1, String(t));
  }
});
