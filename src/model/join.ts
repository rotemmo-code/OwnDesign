import { corners, dist, polygon, rings, union } from './geo';
import type { Id, Pt, Side, Wall } from './types';

// Every limit is 0.01 wider than the number it stands for, so that exactly that number counts at any angle of the plan.
const RADIAN = Math.PI / 180;
/** mm: a wall end this near to another wall's body touches it. */
export const TOUCH = 2.01;
/** mm: ends this near to each other are one joint. */
const JOINT = 5.01;
/** A wall that meets another at less than 15 degrees does not run on into it. */
const LEAST_SINE = Math.sin(14.99 * RADIAN);
/** Walls within 1 degree of each other's direction lie on each other. */
const SAME_COSINE = Math.cos(1.01 * RADIAN);
/**
 * Neighbours at 165 to 180.1 degrees are in line: a step in thickness stays one, and the notch of a small bend is under
 * 1 mm wide at 1000 mm and closes.
 */
const BLUNT = 165.01 * RADIAN;
const STRAIGHT = 180.11 * RADIAN;

const dot = (p: Pt, q: Pt) => p.x * q.x + p.y * q.y;
const sub = (p: Pt, q: Pt): Pt => ({ x: p.x - q.x, y: p.y - q.y });
const step = (p: Pt, u: Pt, d: number): Pt => ({ x: p.x + u.x * d, y: p.y + u.y * d });
const minus = (u: Pt): Pt => ({ x: -u.x, y: -u.y });
const angle = (u: Pt) => Math.atan2(u.y, u.x);
/** Direction of a -> b, length 1. */
export function axis(s: { a: Pt; b: Pt }): Pt {
  const l = dist(s.a, s.b);
  return { x: (s.b.x - s.a.x) / l, y: (s.b.y - s.a.y) / l };
}
/** Normal of side A: the left hand when walking along u on screen. */
export const normalA = (u: Pt): Pt => ({ x: u.y, y: -u.x });

/**
 * body: the wall's rectangle, run on at joints. tips: the pieces that fill its corners there. A, B: where each face
 * starts and ends along a -> b, in mm from a.
 */
export type Joined = { body: Pt[]; tips: Pt[][]; A: [number, number]; B: [number, number] };
type Axis = { w: Wall; u: Pt; l: number; t: number };
/**
 * One end of wall i, b when end is 1. p: where its body ends. at: where its centre line meets the joint. u: from there
 * along the wall.
 */
type Arm = { i: number; end: 0 | 1; p: Pt; at: Pt; u: Pt; l: number; t: number };
/** A piece at the end of a face, which then ends at to. */
type Tip = { side: Side; to: Pt; piece: Pt[] };

/** Where p lies along m and beside its centre line, and the sine of the angle at which out meets m. */
function seenFrom(m: Axis, p: Pt, out: Pt) {
  const [n, d] = [normalA(m.u), sub(p, m.w.a)];
  return { s: dot(d, m.u), off: dot(d, n), sine: dot(out, n) };
}
/** The place lies in the body of m, or within TOUCH of it. */
const holds = (m: Axis, s: number, off: number) => s >= -TOUCH && s <= m.l + TOUCH && Math.abs(off) <= m.t / 2 + TOUCH;
/** How far an end at p runs on to out: to the centre line of a wall that it touches. */
const reach = (walls: Axis[], p: Pt, out: Pt) =>
  walls.reduce((best, m) => {
    const { s, off, sine } = seenFrom(m, p, out);
    const e = -off / sine;
    const touches = holds(m, s, off) && Math.abs(sine) >= LEAST_SINE;
    return touches && holds(m, s + e * dot(out, m.u), 0) ? Math.max(best, e) : best;
  }, 0);
/** The two directions of a wall that goes on at both sides of p. */
function through(m: Axis, p: Pt): Arm[] {
  const { s, off } = seenFrom(m, p, m.u);
  const at = step(m.w.a, m.u, s);
  const passes = s > JOINT && s < m.l - JOINT && holds(m, s, off);
  return passes ? [m.u, minus(m.u)].map(u => ({ i: -1, end: 0, p: at, at, u, l: Infinity, t: m.t })) : [];
}
/** Of x and y, the next clockwise on screen: a face that stops more than 0.01 mm before the two faces meet is run on to there. */
function corner(x: Arm, y: Arm): Tip[][] {
  const faces = [
    { arm: x, e: step(x.p, minus(normalA(x.u)), x.t / 2), side: x.end ? 'A' : 'B' },
    { arm: y, e: step(y.p, normalA(y.u), y.t / 2), side: y.end ? 'B' : 'A' },
  ] as const;
  const d = sub(faces[1].e, faces[0].e);
  const to = step(faces[0].e, x.u, (d.x * y.u.y - d.y * y.u.x) / (x.u.x * y.u.y - x.u.y * y.u.x));
  // sharper than about 23 degrees, or past the other end of a short wall: left square
  const square = dist(to, x.at) > 2.5 * Math.max(x.t, y.t) || [x, y].some(arm => dot(sub(to, arm.p), arm.u) > arm.l + 0.01);
  return faces.map(({ arm, e, side }): Tip[] =>
    !square && dot(sub(to, arm.p), arm.u) < -0.01 ? [{ side, to, piece: [arm.p, e, to, arm.at] }] : [],
  );
}

// shortcut: every end is compared with every wall, 5,000 walls take 4 s; index the walls by box when plans get that large.
export function joinWalls(walls: Wall[]): Map<Id, Joined> {
  const all = walls.map((w): Axis => ({ w, u: axis(w), l: dist(w.a, w.b), t: w.thickness }));
  const arms = all.flatMap(({ w, u, l, t }, i) =>
    ([0, 1] as const).map((end): Arm => {
      const [q, out] = end ? [w.b, u] : [w.a, minus(u)];
      // into a thinner wall the body does not run on: a corner of it would come out of the far face
      const wide = all.filter(m => t * Math.abs(dot(out, m.u)) <= m.t + 0.01);
      return { i, end, p: step(q, out, reach(wide, q, out)), at: step(q, out, reach(all, q, out)), u: minus(out), l, t };
    }),
  );
  const tips = all.map((): Tip[] => []);
  for (const first of arms) {
    const ends = arms.filter(o => dist(o.at, first.at) <= JOINT);
    if (ends[0] !== first) continue;
    const joint = [...all.flatMap(m => through(m, first.at)), ...ends];
    // of walls lying on each other only the thickest counts, of equal ones in the very same direction the first
    const hides = (y: Arm, x: Arm, before: boolean) => {
      const cosine = dot(x.u, y.u);
      return y.t > x.t ? cosine > SAME_COSINE : before && y.t === x.t && cosine > 1 - 1e-12;
    };
    const round = joint.filter((x, i) => !joint.some((y, j) => hides(y, x, j < i))).sort((x, y) => angle(x.u) - angle(y.u));
    round.forEach((x, k) => {
      const y = round[(k + 1) % round.length];
      const gap = (angle(y.u) - angle(x.u) + 4 * Math.PI) % (2 * Math.PI);
      if (gap >= BLUNT && gap <= STRAIGHT) return;
      corner(x, y).forEach((list, j) => tips[[x, y][j].i]?.push(...list));
    });
  }
  return new Map(
    all.map(({ w, u, t }, i) => {
      const [a, b] = [arms[2 * i].p, arms[2 * i + 1].p];
      const s = (p: Pt) => dot(sub(p, w.a), u);
      const face = (side: Side): [number, number] => {
        const to = tips[i].filter(tip => tip.side === side).map(tip => s(tip.to));
        return [Math.min(s(a), ...to), Math.max(s(b), ...to)];
      };
      return [w.id, { body: corners(a, b, t), tips: tips[i].map(tip => tip.piece), A: face('A'), B: face('B') }];
    }),
  );
}

/** All the pieces of the wall mass. */
export const massPieces = (walls: Wall[]): Pt[][] => [...joinWalls(walls).values()].flatMap(j => [j.body, ...j.tips]);
/** What to draw for every wall: its outline with the joints filled, or its plain rectangle when it was removed. */
export function wallOutlines(walls: Wall[]): Map<Id, Pt[]> {
  const joined = joinWalls(walls.filter(w => w.status !== 'removed'));
  return new Map(
    walls.map(w => {
      const j = joined.get(w.id);
      if (!j) return [w.id, corners(w.a, w.b, w.thickness)];
      return [w.id, j.tips.length ? rings(union([j.body, ...j.tips].map(r => polygon(r))))[0] : j.body];
    }),
  );
}
