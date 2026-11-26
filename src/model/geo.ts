import ArrayList from 'jsts/java/util/ArrayList.js';
import InteriorPointArea from 'jsts/org/locationtech/jts/algorithm/InteriorPointArea.js';
import Coordinate from 'jsts/org/locationtech/jts/geom/Coordinate.js';
import type Geometry from 'jsts/org/locationtech/jts/geom/Geometry.js';
import GeometryFactory from 'jsts/org/locationtech/jts/geom/GeometryFactory.js';
import PrecisionModel from 'jsts/org/locationtech/jts/geom/PrecisionModel.js';
import ScaledNoder from 'jsts/org/locationtech/jts/noding/ScaledNoder.js';
import GeometryNoder from 'jsts/org/locationtech/jts/noding/snapround/GeometryNoder.js';
import MCIndexSnapRounder from 'jsts/org/locationtech/jts/noding/snapround/MCIndexSnapRounder.js';
import BufferBuilder from 'jsts/org/locationtech/jts/operation/buffer/BufferBuilder.js';
import BufferParameters from 'jsts/org/locationtech/jts/operation/buffer/BufferParameters.js';
import DistanceOp from 'jsts/org/locationtech/jts/operation/distance/DistanceOp.js';
import Polygonizer from 'jsts/org/locationtech/jts/operation/polygonize/Polygonizer.js';
import IsValidOp from 'jsts/org/locationtech/jts/operation/valid/IsValidOp.js';
import TopologyPreservingSimplifier from 'jsts/org/locationtech/jts/simplify/TopologyPreservingSimplifier.js';
import type { Pt, Wall } from './types';

export type Geom = Geometry;
export type Segment = { a: Pt; b: Pt };

const factory = new GeometryFactory();
const coordinates = (points: Pt[]) => points.map(p => new Coordinate(p.x, p.y));
const linearRing = (ring: Pt[]) => factory.createLinearRing(coordinates([...ring, ring[0]]));

/** Signed: positive when the ring runs clockwise on screen. From its first point, so that it stays exact far from 0. */
export const ringArea = (ring: Pt[]): number =>
  ring.reduce((sum, p, i) => {
    const [o, q] = [ring[0], ring[(i + 1) % ring.length]];
    return sum + (p.x - o.x) * (q.y - o.y) - (q.x - o.x) * (p.y - o.y);
  }, 0) / 2;
export const dist = (p: Pt, q: Pt): number => Math.hypot(p.x - q.x, p.y - q.y);
/** How many times the ring runs round p. */
const winding = (ring: Pt[], p: Pt): number =>
  ring.reduce((turns, a, i) => {
    const b = ring[(i + 1) % ring.length];
    const crosses = a.y > p.y !== b.y > p.y && p.x < ((b.x - a.x) * (p.y - a.y)) / (b.y - a.y) + a.x;
    return crosses ? turns + (b.y > a.y ? 1 : -1) : turns;
  }, 0);
export const contains = (ring: Pt[], p: Pt): boolean => winding(ring, p) % 2 !== 0;

export const polygon = (shell: Pt[], holes: Pt[][] = []): Geom => factory.createPolygon(linearRing(shell), holes.map(linearRing));
/** Of the rectangle a, b, thickness: A side at a, A side at b, B side at b, B side at a. */
export function corners(a: Pt, b: Pt, thickness: number): Pt[] {
  const half = thickness / 2 / dist(a, b);
  const x = (b.y - a.y) * half;
  const y = -(b.x - a.x) * half;
  return [
    { x: a.x + x, y: a.y + y },
    { x: b.x + x, y: b.y + y },
    { x: b.x - x, y: b.y - y },
    { x: a.x - x, y: a.y - y },
  ];
}
export const wallBody = (w: Pick<Wall, 'a' | 'b' | 'thickness'>): Geom => polygon(corners(w.a, w.b, w.thickness));

export const parts = (g: Geom): Geom[] =>
  Array.from({ length: g.getNumGeometries() }, (_, i): Geom => g.getGeometryN(i)).filter(p => p.getArea() > 0);
type Ring = { getCoordinates(): Pt[] };
type Polygon = Geom & { getExteriorRing(): Ring; getNumInteriorRing(): number; getInteriorRingN(i: number): Ring };
function points(ring: Ring, clockwise: boolean): Pt[] {
  const list = ring.getCoordinates().slice(0, -1).map(c => ({ x: c.x, y: c.y }));
  return ringArea(list) > 0 === clockwise ? list : list.reverse();
}
function regionOf(part: Geom): Pt[][] {
  const p = part as Polygon;
  return [points(p.getExteriorRing(), true), ...Array.from({ length: p.getNumInteriorRing() }, (_, i) => points(p.getInteriorRingN(i), false))];
}
/** Part by part, each shell (clockwise on screen) before its holes (counter-clockwise). */
export const rings = (g: Geom): Pt[][] => parts(g).flatMap(regionOf);
export const interiorRings = (g: Geom): Pt[][] => parts(g).flatMap(p => regionOf(p).slice(1));

// Unions and cuts are made of the faces that lines cut the plane into. The overlays of jsts are not used: the plain one
// drops a wall whose end lies on another wall's face at an odd angle, the snapping one throws in 1 of 1,800 noisy plans.
type Line = [Pt, Pt];
/** Per mm. Lines are rounded to this grid before jsts cuts them at each other; otherwise it loses parts where they almost touch. */
const GRID = 1e7;
const onGrid = (p: Pt): Pt => ({ x: Math.round(p.x * GRID) / GRID, y: Math.round(p.y * GRID) / GRID });
const lineString = (line: Line) => factory.createLineString(coordinates(line));
const sides = (ring: Pt[]): Line[] => ring.map((p, i) => [p, ring[(i + 1) % ring.length]]);
const key = ([p, q]: Line) => `${p.x} ${p.y} ${q.x} ${q.y}`;
/** mm: the same place up to rounding. */
const SAME = 1e-5;
/** The lines as pieces from one end to the next: a line passes through every end within snap of it. Ends at the same place are one. */
function chained(lines: Line[], ends: Pt[], snap: number): Line[] {
  const byX: Pt[] = [];
  for (const p of [...ends].sort((p, q) => p.x - q.x)) {
    let i = byX.length - 1;
    while (i >= 0 && p.x - byX[i].x <= SAME && dist(p, byX[i]) > SAME) i--;
    if (i < 0 || p.x - byX[i].x > SAME) byX.push(p);
  }
  const firstFrom = (x: number) => {
    let [low, high] = [0, byX.length];
    while (low < high) {
      const middle = (low + high) >> 1;
      if (byX[middle].x < x) low = middle + 1;
      else high = middle;
    }
    return low;
  };
  return lines.flatMap(([a, b]) => {
    const [dx, dy] = [b.x - a.x, b.y - a.y];
    const on: { p: Pt; t: number }[] = [];
    for (let i = firstFrom(Math.min(a.x, b.x) - snap); i < byX.length && byX[i].x <= Math.max(a.x, b.x) + snap; i++) {
      const p = byX[i];
      const t = ((p.x - a.x) * dx + (p.y - a.y) * dy) / (dx * dx + dy * dy);
      const k = Math.max(0, Math.min(1, t));
      if (dist(p, { x: a.x + dx * k, y: a.y + dy * k }) <= snap) on.push({ p, t });
    }
    on.sort((p, q) => p.t - q.t);
    return on.slice(1).map(({ p }, i): Line => [on[i].p, p]);
  });
}
/** Bounded faces of lines that meet at their ends only. */
function polygonsOf(lines: Line[]): Geom[] {
  const polygonizer = new Polygonizer();
  for (const line of lines) polygonizer.add(lineString(line));
  return polygonizer.getPolygons().toArray();
}
/** Bounded faces of lines that may cross, touch or lie on each other, each with a point inside it. */
function facesOf(lines: Line[]): { face: Geom; at: Pt }[] {
  const drawn = new ArrayList(null);
  for (const [a, b] of lines) drawn.add(lineString([onGrid(a), onGrid(b)]));
  if (drawn.isEmpty()) return [];
  const pieces = new Map<string, Line>();
  for (const piece of new GeometryNoder(new PrecisionModel(GRID)).node(drawn).toArray()) {
    const [p, q]: Line = piece.getCoordinates();
    if (!pieces.has(key([q, p]))) pieces.set(key([p, q]), [p, q]);
  }
  return polygonsOf([...pieces.values()]).map(face => ({ face, at: InteriorPointArea.getInteriorPoint(face) }));
}
/** One area made of faces of the same lines: the borders between two of them go. */
function dissolve(faces: Geom[]): Geom {
  const edges = new Map(faces.flatMap(regionOf).flatMap(sides).map(side => [key(side), side]));
  const border = [...edges.values()].filter(([p, q]) => !edges.has(key([q, p])));
  // a face of the border is inside when its outline runs the way the outlines of the faces do
  const inside = polygonsOf(border).filter(face => edges.has(key(sides(regionOf(face)[0])[0])));
  return factory.createMultiPolygon(inside) as unknown as Geom;
}
/** The faces of a and b that keep accepts. */
function overlay(a: Geom[], b: Geom[], keep: (inA: boolean, inB: boolean) => boolean): Geom {
  const within = (list: Geom[]) => {
    const regions = list.flatMap(parts).map(p => ({ region: regionOf(p), box: p.getEnvelopeInternal() }));
    return (p: Pt) =>
      regions.some(({ region: [shell, ...holes], box }) => box.contains(p.x, p.y) && contains(shell, p) && !holes.some(h => contains(h, p)));
  };
  const [inA, inB] = [within(a), within(b)];
  const outlines = [...a, ...b].flatMap(rings);
  const faces = facesOf(chained(outlines.flatMap(sides), outlines.flat(), SAME));
  return dissolve(faces.filter(({ at }) => keep(inA(at), inB(at))).map(f => f.face));
}
export const union = (list: Geom[]): Geom => overlay(list, [], inside => inside);
export const difference = (a: Geom, b: Geom): Geom => overlay([a], [b], (inA, inB) => inA && !inB);
export const intersection = (a: Geom, b: Geom): Geom => overlay([a], [b], (inA, inB) => inA && inB);
export const area = (g: Geom): number => g.getArea();
/** A point inside g, not on its outline. */
export const interiorPoint = (g: Geom): Pt => InteriorPointArea.getInteriorPoint(g);
/** Rings that close and do not cross: what jsts can work with. */
export const valid = (g: Geom): boolean => IsValidOp.isValid(g);
export const distance = (a: Geom, b: Geom): number => DistanceOp.distance(a, b);

function grow(g: Geom, mm: number, mitreLimit: number): Geom {
  const params = new BufferParameters();
  params.setJoinStyle(BufferParameters.JOIN_MITRE);
  params.setMitreLimit(mitreLimit);
  params.setSimplifyFactor(0); // dropping steps of 0.01 mm moved what is closed by 1 mm
  const builder = new BufferBuilder(params);
  builder.setNoder(new ScaledNoder(new MCIndexSnapRounder(new PrecisionModel(1)), GRID));
  return builder.buffer(g, mm);
}
/** Mitre joins; negative erodes. */
export const buffer = (g: Geom, mm: number): Geom => grow(g, mm, 5);
/**
 * Closes gaps up to mm wide and takes nothing away. Mitre limit 50 keeps a room corner sharp down to 2.3 degrees. When
 * fewer spaces of 0.2 m2 would be left than there were of 0.25 m2, nothing is closed.
 */
export function closeGaps(g: Geom, mm: number): Geom {
  // with g, because a sharp mitre can cut through a wall
  const closed = union([g, grow(grow(g, mm / 2, 50), -mm / 2, 50)]);
  const spaces = (x: Geom, least: number) => interiorRings(x).filter(r => Math.abs(ringArea(r)) >= least).length;
  return spaces(closed, 200_000) >= spaces(g, 250_000) ? closed : g;
}
export const simplify = (g: Geom, mm: number): Geom => TopologyPreservingSimplifier.simplify(g, mm);

/** mm: a cut may stop this short (0.01 more than 1, so that exactly 1 counts at any angle). */
const REACH = 1.01;
/** mm: a cut, or an outline of a path, passes through every end this near to it. */
const SNAP = 0.01;
/**
 * The parts of a region [shell, ...holes] cut by lines of no width. An end may stop up to 1 mm short; a line that does
 * not reach cuts nothing.
 */
export function split(region: Pt[][], lines: Segment[]): Pt[][][] {
  const cuts = lines.flatMap(({ a, b }): Line[] => {
    const k = REACH / dist(a, b);
    const [x, y] = [(b.x - a.x) * k, (b.y - a.y) * k];
    return dist(a, b) > 0 ? [[{ x: a.x - x, y: a.y - y }, { x: b.x + x, y: b.y + y }]] : [];
  });
  const [shell, ...holes] = region;
  return facesOf([...region.flatMap(sides), ...chained(cuts, [...region.flat(), ...cuts.flat()], SNAP)])
    .filter(({ at }) => contains(shell, at) && !holes.some(h => contains(h, at)))
    .map(({ face }) => regionOf(face));
}
/** Filled area of the rings of one path: non-zero winding, or even-odd. */
export function fromRings(list: Pt[][], evenOdd = false): Geom {
  const filled = facesOf(chained(list.flatMap(sides), list.flat(), SNAP)).filter(({ at }) => {
    const turns = list.reduce((sum, r) => sum + winding(r, at), 0);
    return evenOdd ? turns % 2 !== 0 : turns !== 0;
  });
  return dissolve(filled.map(f => f.face));
}
