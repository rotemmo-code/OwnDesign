import { describe, expect, it } from 'vitest';
import type { Clip, ExtractedPage, PathItem } from '../../src/pdf/extract';
import type { Vec } from '../../src/shared';
import { snapIndex, snapPoint } from '../../src/editor/snap';

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
