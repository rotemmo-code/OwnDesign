import { describe, expect, it } from 'vitest';
import type { Clip, ExtractedPage, PathItem } from '../../src/pdf/extract';
import type { Vec } from '../../src/shared';
import { alongWall, holdAxis, offsetOn, openingFoot, pickAt, secondEnd, snapCentre, snapFace, snapIndex, snapPoint, wallAt } from '../../src/editor/snap';

// Synthetic pages in view points: 842 x 595 unless a test says otherwise.
const stroke = (pts: Vec[], more: Partial<PathItem> = {}): PathItem => ({
  fill: false, stroke: true, evenOdd: false, subpaths: [{ pts, closed: false, curved: false }], fillColor: '#000000', strokeColor: '#000000',
  lineWidth: 0.25, dashed: false, layer: null, clipId: 0, ...more,
});
const filled = (pts: Vec[], more: Partial<PathItem> = {}): PathItem => stroke(pts, { fill: true, stroke: false, ...more });
const rect = (l: number, t: number, r: number, b: number, more: Partial<PathItem> = {}) => filled([[l, t], [r, t], [r, b], [l, b]], more);
const box = (l: number, t: number, r: number, b: number): Clip => ({ rings: [[[l, t], [r, t], [r, b], [l, b]]], evenOdd: false });
const PAGE = box(0, 0, 842, 595);
const pageOf = (paths: PathItem[], clips: Clip[][] = [[PAGE]], [widthPt, heightPt] = [842, 595]): ExtractedPage => ({
  widthPt, heightPt, rotation: 0, paths, clips, texts: [], layers: [], colours: [],
});
const snap = (page: ExtractedPage, p: Vec, radius = 5, from?: Vec) => snapPoint(p, snapIndex(page), radius, from);

describe('snapPoint', () => {
  it('snaps to the end of a line inside the radius', () => {
    expect(snap(pageOf([stroke([[100, 100], [200, 100]])]), [103, 102])).toEqual({ at: [100, 100], to: 'end' });
  });
  it('snaps to a crossing of two strokes', () => {
    expect(snap(pageOf([stroke([[0, 100], [200, 100]]), stroke([[150, 0], [150, 200]])]), [152, 98])).toEqual({ at: [150, 100], to: 'cross' });
  });
  it('the nearer of an end and a crossing wins: a dimension line running 5 pt past its mark', () => {
    const page = pageOf([stroke([[95, 100], [300, 100]]), stroke([[100, 90], [100, 110]])]);
    expect(snap(page, [99, 101], 8)).toEqual({ at: [100, 100], to: 'cross' });
    expect(snap(page, [96, 101], 8)).toEqual({ at: [95, 100], to: 'end' });
  });
  it('a point on the face of a filled wall when no end or crossing is near', () => {
    expect(snap(pageOf([rect(100, 100, 110, 400)]), [113, 250])).toEqual({ at: [110, 250], to: 'line' });
  });
  it('with a first point, the foot of the perpendicular from it, when within the radius; else the nearest point', () => {
    const page = pageOf([rect(100, 100, 110, 400), rect(300, 100, 310, 400)]);
    expect(snap(page, [297, 254], 5, [110, 250])).toEqual({ at: [300, 250], to: 'line' });
    expect(snap(page, [297, 264], 5, [110, 250])).toEqual({ at: [300, 264], to: 'line' }); // the foot is 14 away
    expect(snap(page, [297, 254], 5, [110, 600])).toEqual({ at: [300, 254], to: 'line' }); // the foot falls beyond the face
  });
  it('returns the point itself when nothing is near', () => {
    expect(snap(pageOf([stroke([[100, 100], [200, 100]])]), [150, 120])).toEqual({ at: [150, 120], to: null });
    expect(snap(pageOf([]), [1, 2])).toEqual({ at: [1, 2], to: null });
  });
  it('ignores ends, crossings and points on lines outside the box of their clip; a clip of nothing hides the path', () => {
    const clips = [[PAGE], [PAGE, box(0, 0, 150, 595)], [PAGE, { rings: [], evenOdd: false }]];
    const page = pageOf([stroke([[100, 100], [200, 100]], { clipId: 1 }), stroke([[180, 50], [180, 150]])], clips);
    expect(snap(page, [181, 101])).toEqual({ at: [180, 101], to: 'line' }); // the crossing lies outside the first path's clip
    expect(snap(page, [198, 101])).toEqual({ at: [198, 101], to: null }); // the end too, and so does any point of it there
    expect(snap(page, [102, 101])).toEqual({ at: [100, 100], to: 'end' });
    expect(snap(page, [140, 102])).toEqual({ at: [140, 100], to: 'line' });
    expect(snap(pageOf([stroke([[100, 100], [200, 100]], { clipId: 2 })], clips), [101, 100])).toEqual({ at: [101, 100], to: null });
  });
  it('the closing side of a closed or filled subpath counts; an open stroke has none', () => {
    const triangle: Vec[] = [[100, 100], [300, 100], [100, 300]];
    expect(snap(pageOf([stroke(triangle)]), [97, 200])).toEqual({ at: [97, 200], to: null });
    expect(snap(pageOf([filled(triangle)]), [97, 200])).toEqual({ at: [100, 200], to: 'line' });
    expect(snap(pageOf([stroke(triangle, { subpaths: [{ pts: triangle, closed: true, curved: false }] })]), [97, 200])).toEqual({ at: [100, 200], to: 'line' });
  });
  it('exactly on the radius snaps, 0.01 beyond does not', () => {
    const page = pageOf([stroke([[100, 100], [200, 100]])]);
    expect(snap(page, [97, 96])).toEqual({ at: [100, 100], to: 'end' }); // 5 away
    expect(snap(page, [150, 105])).toEqual({ at: [150, 100], to: 'line' });
    expect(snap(page, [150, 105.01])).toEqual({ at: [150, 105.01], to: null });
  });
  it('pieces of zero length are skipped, and a page edge does not hide the corners', () => {
    expect(snap(pageOf([stroke([[100, 100], [100, 100]])]), [101, 101])).toEqual({ at: [101, 101], to: null });
    expect(snap(pageOf([stroke([[0, 0], [842, 0]])]), [-2, 1])).toEqual({ at: [0, 0], to: 'end' });
  });
});

describe('pages a file could hold', () => {
  it('a clip of 300,000 points is no trouble, and its box still counts', () => {
    const ring: Vec[] = Array.from({ length: 300_000 }, (_, i) => [421 + 300 * Math.cos((i / 300_000) * 2 * Math.PI), 297 + 290 * Math.sin((i / 300_000) * 2 * Math.PI)]);
    const page = pageOf([stroke([[100, 100], [500, 400]], { clipId: 1 })], [[PAGE], [PAGE, { rings: [ring], evenOdd: false }]]);
    expect(snap(page, [100, 101])).toEqual({ at: [100, 101], to: null }); // outside the box of the clip
    expect(snap(page, [500, 399])).toEqual({ at: [500, 400], to: 'end' });
  });
  it('100,000 page-wide diagonal pieces: indexed in under 2 s, at most 64 cells each, and found', () => {
    const diagonal = Array.from({ length: 100_000 }, (_, i): Vec => [(i % 2) * 1684, (i / 100_000) * 1191]);
    const start = performance.now();
    const index = snapIndex(pageOf([stroke(diagonal)], [[box(0, 0, 1684, 1191)]], [1684, 1191]));
    expect(performance.now() - start).toBeLessThan(2000);
    expect(index.items.length).toBeLessThanOrEqual(64 * 99_999);
    const t = performance.now();
    expect(snapPoint([842, 595.6], index, 1).to).not.toBeNull();
    expect(performance.now() - t).toBeLessThan(200);
  });
  it('a page of 200,000 pt has at most a million cells, and still snaps', () => {
    const page = pageOf([stroke([[100_000, 100_000], [150_000, 100_000]])], [[box(0, 0, 200_000, 200_000)]], [200_000, 200_000]);
    const index = snapIndex(page);
    expect(index.cols * index.rows).toBeLessThanOrEqual(1_000_000);
    expect(snapPoint([100_003, 100_002], index, 5)).toEqual({ at: [100_000, 100_000], to: 'end' });
    expect(snapPoint([125_000, 100_004], index, 5)).toEqual({ at: [125_000, 100_000], to: 'line' });
  });
  it('a piece crossing many cells is found from every cell it crosses, and not from others', () => {
    const page = pageOf([stroke([[3, 5], [700, 590]])]);
    const index = snapIndex(page);
    for (let t = 0; t <= 1; t += 0.01) {
      const [x, y] = [3 + 697 * t, 5 + 585 * t];
      expect(snapPoint([x + 0.6, y - 0.6], index, 1).to, String(t)).not.toBeNull();
    }
    expect(snapPoint([600, 100], index, 5).to).toBeNull();
  });
});

describe('speed', () => {
  let seed = 3;
  const random = () => (seed = (seed * 16807) % 2147483647) / 2147483647;
  const squares = (n: number, x0: number, y0: number, spread: number) =>
    Array.from({ length: n }, () => {
      const [x, y] = [x0 + random() * spread, y0 + random() * spread];
      return rect(x, y, x + 2 + random() * 2, y + 2 + random() * 2);
    });
  it('100,000 pieces: the index in under 1 s, 1,000 queries with a median under 1 ms', () => {
    const page = pageOf(squares(25_000, 0, 0, 1180), [[box(0, 0, 1684, 1191)]], [1684, 1191]);
    let start = performance.now();
    const index = snapIndex(page);
    expect(performance.now() - start).toBeLessThan(1000);
    const times: number[] = [];
    for (let i = 0; i < 1000; i++) {
      start = performance.now();
      snapPoint([random() * 1684, random() * 1191], index, [11.2, 1.4, 0.17][i % 3], [500, 500]);
      times.push(performance.now() - start);
    }
    expect(times.sort((a, b) => a - b)[500]).toBeLessThan(1);
  });
  it('100,000 pieces in one 20 x 20 pt square: a query takes under 200 ms', () => {
    const index = snapIndex(pageOf(squares(25_000, 400, 400, 20)));
    const start = performance.now();
    const found = snapPoint([410, 410], index, 11.2);
    expect(performance.now() - start).toBeLessThan(200);
    expect(found.to).not.toBeNull();
  });
});

describe('the wall tool: snapCentre, holdAxis and pickAt', () => {
  // 1:50: 17.64 mm per point. A wall 10 pt thick (176 mm) from x 100 to 300 at y 100..110, and a hatch of short diagonals in it.
  const K = (50 * 25.4) / 72;
  const wall = rect(100, 100, 300, 110);
  const centre = (page: ExtractedPage, p: Vec, ends: Vec[] = [], between = true) => snapCentre(p, snapIndex(page), 5, K, ends, between);
  it('the middle of the edge that closes a wall\'s end, not a corner of it', () => {
    expect(centre(pageOf([wall]), [101, 104])).toEqual({ at: [100, 105], to: 'end' });
    expect(centre(pageOf([wall]), [299, 109])).toEqual({ at: [300, 105], to: 'end' });
  });
  it('an edge is a wall\'s end only with both faces leaving it square and to one side, 30 to 600 mm long', () => {
    expect(centre(pageOf([stroke([[100, 100], [100, 110]])]), [101, 104]).to).not.toBe('end'); // no faces
    expect(centre(pageOf([rect(100, 100, 300, 101)]), [101, 100.4], [], false).to).toBeNull(); // 17.6 mm: too thin for a wall
    expect(centre(pageOf([filled([[100, 100], [100, 110], [300, 140]])]), [100.5, 105], [], false).to).toBeNull(); // the sides are not square
  });
  it('at a corner, where the end edge also lies on the face of another wall, it is still the end', () => {
    const corner = pageOf([rect(100, 100, 300, 110), rect(100, 110, 110, 300)]);
    expect(centre(corner, [106, 111])).toEqual({ at: [105, 110], to: 'end' });
  });
  it('midway between a wall\'s two faces, moving across the wall only', () => {
    expect(centre(pageOf([wall]), [200, 103])).toEqual({ at: [200, 105], to: 'between' });
    expect(centre(pageOf([wall]), [200, 103], [], false)).toEqual({ at: [200, 103], to: null });
  });
  it('the closest pair of faces: a wall inside a wide one is taken, not the wide one', () => {
    const page = pageOf([rect(100, 100, 300, 110), stroke([[100, 90], [300, 90]]), stroke([[100, 130], [300, 130]])]);
    expect(centre(page, [200, 104])).toEqual({ at: [200, 105], to: 'between' });
  });
  it('never a point on a face; nothing near: the point itself', () => {
    expect(centre(pageOf([wall]), [200, 100.5]).at[1]).toBe(105);
    expect(centre(pageOf([wall]), [200, 400])).toEqual({ at: [200, 400], to: null });
  });
  it('the centre-line end of a wall already drawn comes first', () => {
    expect(centre(pageOf([wall]), [101, 104], [[102, 105]])).toEqual({ at: [102, 105], to: 'wall' });
  });
  it('midway between two near-vertical faces that lean apart by a hair, as drawings have them', () => {
    const noisy = pageOf([filled([[100, 100], [110, 100], [110.01, 300], [99.99, 300]])]);
    expect(centre(noisy, [103, 200])).toEqual({ at: [expect.closeTo(105, 6), expect.closeTo(200, 3)], to: 'between' });
    const exact = pageOf([rect(100, 100, 110, 300)]);
    expect(centre(exact, [103, 200])).toEqual({ at: [105, 200], to: 'between' });
  });
  it('secondEnd: a snapped point is kept as it is; only a free point is held to an axis', () => {
    const tan = Math.tan(Math.PI / 180);
    expect(secondEnd([0, 0], { at: [170, 170 * tan], to: 'wall' })).toEqual([170, 170 * tan]);
    expect(secondEnd([0, 0], { at: [170, 170 * tan], to: 'end' })).toEqual([170, 170 * tan]);
    expect(secondEnd([0, 0], { at: [170, 170 * tan], to: 'between' })).toEqual([170, 170 * tan]);
    expect(secondEnd([0, 0], { at: [170, 170 * tan], to: null })).toEqual([170, 0]);
  });
  it('holdAxis: within 2 degrees of the horizontal or vertical through the first end, held to it; beyond, kept', () => {
    const tan = (deg: number) => Math.tan((deg * Math.PI) / 180);
    expect(holdAxis([0, 0], [100, 100 * tan(1.9)])).toEqual([100, 0]);
    expect(holdAxis([0, 0], [100 * tan(1.9), -100])).toEqual([0, -100]);
    expect(holdAxis([0, 0], [100, 100 * tan(2.1)])).toEqual([100, 100 * tan(2.1)]);
    expect(holdAxis([5, 5], [5, 5])).toEqual([5, 5]);
  });
  it('pickAt: the nearest wall within the radius, else the room under the point; a hole is not the room; nothing outside', () => {
    const s = {
      walls: [
        { id: 'w1', a: { x: 0, y: 0 }, b: { x: 1000, y: 0 }, thickness: 100 },
        { id: 'w2', a: { x: 0, y: 200 }, b: { x: 1000, y: 200 }, thickness: 100 },
      ],
      rooms: [{ id: 'r', boundary: [{ x: 0, y: 50 }, { x: 1000, y: 50 }, { x: 1000, y: 1000 }, { x: 0, y: 1000 }], holes: [[{ x: 400, y: 400 }, { x: 600, y: 400 }, { x: 600, y: 600 }, { x: 400, y: 600 }]] }],
    };
    expect(pickAt({ x: 500, y: 60 }, s, 20)).toEqual({ kind: 'wall', id: 'w1' });
    expect(pickAt({ x: 500, y: 140 }, s, 20)).toEqual({ kind: 'wall', id: 'w2' });
    expect(pickAt({ x: 500, y: 300 }, s, 20)).toEqual({ kind: 'room', id: 'r' });
    expect(pickAt({ x: 500, y: 500 }, s, 20)).toBeNull();
    expect(pickAt({ x: 5000, y: 500 }, s, 20)).toBeNull();
  });
});

describe('11b: handles, openings, separators and faces', () => {
  const walls = [
    { id: 'w1', a: { x: 0, y: 0 }, b: { x: 1000, y: 0 }, thickness: 100 },
    { id: 'w2', a: { x: 0, y: 500 }, b: { x: 1000, y: 500 }, thickness: 100 },
  ];
  const openings = [{ id: 'o1', wallId: 'w1', offset: 200, width: 300 }];
  const separators = [{ id: 's1', a: { x: 1500, y: 0 }, b: { x: 1500, y: 500 } }];
  const plan = { walls, openings, separators, rooms: [] };
  it('pickAt: the selected wall\'s end handles, the nearer end first', () => {
    expect(pickAt({ x: 990, y: 5 }, plan, 20, { kind: 'wall', id: 'w1' })).toEqual({ kind: 'end', wall: 'w1', end: 'b' });
    expect(pickAt({ x: 10, y: 0 }, plan, 20, { kind: 'wall', id: 'w1' })).toEqual({ kind: 'end', wall: 'w1', end: 'a' });
    expect(pickAt({ x: 990, y: 5 }, plan, 20)).toEqual({ kind: 'wall', id: 'w1' }); // not selected: no handles
  });
  it('pickAt: an opening\'s edge handles when it is selected; else the opening before its wall', () => {
    expect(pickAt({ x: 205, y: 3 }, plan, 20, { kind: 'opening', id: 'o1' })).toEqual({ kind: 'edge', opening: 'o1', edge: 'start' });
    expect(pickAt({ x: 498, y: -3 }, plan, 20, { kind: 'opening', id: 'o1' })).toEqual({ kind: 'edge', opening: 'o1', edge: 'end' });
    expect(pickAt({ x: 350, y: 30 }, plan, 20)).toEqual({ kind: 'opening', id: 'o1' });
    expect(pickAt({ x: 800, y: 30 }, plan, 20)).toEqual({ kind: 'wall', id: 'w1' });
  });
  it('pickAt: a separator by its line, within the radius', () => {
    expect(pickAt({ x: 1510, y: 250 }, plan, 20)).toEqual({ kind: 'separator', id: 's1' });
    expect(pickAt({ x: 1530, y: 250 }, plan, 20)).toBeNull();
  });
  it('wallAt: the wall under the point, openings aside', () => {
    expect(wallAt({ x: 350, y: 30 }, walls, 20)).toBe('w1');
    expect(wallAt({ x: 350, y: 250 }, walls, 20)).toBeNull();
  });
  it('alongWall and offsetOn: a point of the centre line and the foot of a point on it', () => {
    expect(alongWall(walls[0], 250)).toEqual({ x: 250, y: 0 });
    expect(offsetOn(walls[0], { x: 250, y: 70 })).toBe(250);
    expect(offsetOn(walls[0], { x: -40, y: 70 })).toBe(-40);
  });
  describe('snapFace: the nearest point on a face of a wall already drawn (owner R24)', () => {
    const outline = [[{ x: 0, y: -50 }, { x: 1000, y: -50 }, { x: 1000, y: 50 }, { x: 0, y: 50 }]];
    it('on a face', () => expect(snapFace({ x: 400, y: 50 }, outline, 20)).toEqual({ x: 400, y: 50 }));
    it('3 px off a face (at 4 mm a pixel)', () => expect(snapFace({ x: 400, y: 62 }, outline, 32)).toEqual({ x: 400, y: 50 }));
    it('no face within the radius', () => expect(snapFace({ x: 400, y: 200 }, outline, 32)).toBeNull());
    it('a corner', () => expect(snapFace({ x: 1010, y: 60 }, outline, 32)).toEqual({ x: 1000, y: 50 }));
  });
});

describe('openingFoot: where along its wall a click puts an opening\'s edge (owner R34)', () => {
  // a wall along y = 105 from x = 100 to 300, 10 thick, and the drawing's grey wall with a gap from 150 to 200; 1 mm a point
  const wall = { a: { x: 100, y: 105 }, b: { x: 300, y: 105 }, thickness: 10 };
  const gap = (left: number, right: number) => snapIndex(pageOf([rect(100, 100, left, 110), rect(right, 100, 300, 110)]));
  it('a corner of the drawing within the radius is taken', () => {
    expect(openingFoot(wall, [152, 104], gap(150, 200), 5, 1)).toBeCloseTo(50, 9);
  });
  it('no corner near: the click\'s own foot', () => {
    expect(openingFoot(wall, [175, 108], gap(150, 200), 5, 1)).toBeCloseTo(75, 9);
  });
  it('of two corners, the nearer', () => {
    expect(openingFoot(wall, [154, 105], gap(150, 156), 5, 1)).toBeCloseTo(56, 9);
  });
  it('a corner across the wall but farther along it than the radius is not taken', () => {
    expect(openingFoot(wall, [155, 105], gap(152, 200), 2, 1)).toBeCloseTo(55, 9);
  });
  it('the result stays on the centre line, and within the wall', () => {
    for (const at of [[152, 101], [175, 109], [90, 105], [320, 104]] as Vec[]) {
      const t = openingFoot(wall, at, gap(150, 200), 5, 1);
      expect(t).toBeGreaterThanOrEqual(0);
      expect(t).toBeLessThanOrEqual(200);
      expect(alongWall(wall, t).y).toBeCloseTo(105, 9);
    }
  });
});
