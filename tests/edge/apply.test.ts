import { expect, it } from 'vitest';
import { apply } from '../../src/model/apply';
import { createHistory } from '../../src/model/history';
import { computeRooms } from '../../src/model/rooms';
import { ProjectSchema } from '../../src/model/schema';
import type { Action, Project, Pt } from '../../src/model/types';
import { boxProject } from '../fixtures/box';

const RUNS = Number(process.env.ETELIER_RUNS ?? 300);
const LIMIT = RUNS * 20;
const LENGTH = 30;

/** mulberry32: the same sequences on every run. */
const randomFrom = (seed: number) => () => {
  seed = (seed + 0x6d2b79f5) | 0;
  let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
  t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
  return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
};
const GEOMETRIC = ['x.addWall', 'x.setWall', 'x.deleteWall', 'x.splitWall', 'x.addSeparator', 'x.deleteSeparator', 'rescale'];

/** One action of any type, near the box's faces, with some garbage. */
function action(p: Project, r: () => number): Action {
  const s = p.existing;
  const pick = <T>(l: T[]): T => l[Math.floor(r() * l.length)];
  const whole = (a: number, b: number) => a + Math.floor(r() * (b - a + 1));
  const near = () => pick([0, 100, 200, 3200, 3250, 3300, 6200, 6300, 6400, 2000, 4200, 4300, whole(-500, 7000)]);
  const P = (): Pt => ({ x: near() + (r() < 0.2 ? (r() - 0.5) * 6 : 0), y: near() + (r() < 0.2 ? (r() - 0.5) * 6 : 0) });
  const id = (list: { id: string }[]) => (r() < 0.05 || !list.length ? 'nope' : pick(list).id);
  const n = (v: number) => (r() < 0.03 ? pick([NaN, Infinity, -1, 0, 1e7]) : v);
  const end = () => pick<{ a: Pt }>(s.walls.length ? s.walls : [{ a: P() }]).a;
  switch (whole(0, 22)) {
    case 0:
    case 1:
      return { type: 'x.addWall', a: P(), b: P(), thickness: n(pick([100, 200, 20, 1000, 19])) };
    case 2:
      return { type: 'x.deleteWall', id: id(s.walls) };
    case 3:
    case 4: {
      const e = end();
      return {
        type: 'x.setWall',
        id: id(s.walls),
        a: r() < 0.5 ? { x: e.x + whole(-300, 300), y: e.y + whole(-3, 3) } : undefined,
        b: r() < 0.3 ? P() : undefined,
        thickness: r() < 0.3 ? n(whole(20, 300)) : undefined,
      };
    }
    case 5:
      return { type: 'x.splitWall', id: id(s.walls), at: n(whole(0, 5000)) };
    case 6:
      return { type: 'x.addOpening', wallId: id(s.walls), offset: n(whole(-100, 4000)), width: n(whole(50, 1500)), kind: pick(['door', 'entry', 'window', 'passage'] as const) };
    case 7:
      return { type: 'x.setOpening', id: id(s.openings), offset: r() < 0.5 ? n(whole(0, 4000)) : undefined, width: r() < 0.5 ? n(whole(50, 1500)) : undefined };
    case 8:
      return { type: 'x.deleteOpening', id: id(s.openings) };
    case 9:
    case 10:
      return { type: 'x.addSeparator', a: P(), b: P() };
    case 11:
      return { type: 'x.deleteSeparator', id: id(s.separators) };
    case 12:
      return { type: 'x.setRoom', id: id(s.rooms), name: r() < 0.5 ? 'x'.repeat(whole(0, 210)) : undefined, inApartment: r() < 0.3 ? r() < 0.5 : undefined, outdoor: r() < 0.2 ? r() < 0.5 : undefined };
    case 13:
      return { type: 'x.keepName', room: id(s.rooms), part: id(s.rooms) };
    case 14:
      return { type: 'setMamad', room: pick([id(s.rooms), id(s.rooms), 'none', null]) };
    case 15:
      return { type: 'setName', name: 'n'.repeat(whole(0, 210)) };
    case 16:
      return { type: 'classify', wallId: id(s.walls), cls: pick(['fixed', 'changeable', 'unknown'] as const) };
    case 17:
      return { type: 'rescale', calibration: { ...p.calibration, mmPerPt: n(p.calibration.mmPerPt * pick([0.5, 1, 1.02, 2])) } };
    case 18:
      return { type: 'x.confirmOpenings', ids: s.openings.filter(() => r() < 0.5).map(o => o.id) };
    case 19:
      return { type: 'x.clearReview', id: pick([id(s.walls), id(s.openings)]) };
    case 20:
      return { type: 'setPlaster', plaster: pick(['none', 'line', 'inWall', 'unknown', 'both'] as never[]) };
    case 21:
      return { type: 'n.setColorLabel', hex: pick(['#808080', '#000000']), label: 'x'.repeat(whole(0, 210)) };
    default:
      return { type: pick(['approve', 'p.moveWall', 'setFinish', 'x.bogus', 'constructor']) } as never;
  }
}

it(
  'random action sequences on the box: accepted parse, refused change nothing, a second recompute changes nothing, undo and redo walk back and forth by identity',
  () => {
    const r = randomFrom(42);
    const reached = new Set<string>();
    // the first sequences start with one action per reason, so that every reason is reached at any RUNS
    const seeded: Action[][] = [
      [
        { type: 'x.addWall', a: { x: NaN, y: 0 }, b: { x: 1000, y: 0 }, thickness: 100 },
        { type: 'x.addWall', a: { x: 1000, y: 1000 }, b: { x: 1005, y: 1000 }, thickness: 100 },
        { type: 'x.addOpening', wallId: 'part', offset: 3500, width: 800, kind: 'door' },
        { type: 'setName', name: 'x'.repeat(201) },
        { type: 'x.bogus' } as never,
        { type: 'setMamad', room: 'room-b' },
        { type: 'x.setRoom', id: 'room-b', outdoor: true },
        { type: 'x.deleteWall', id: 'part' },
      ],
      [{ type: 'x.deleteWall', id: 'part' }],
    ];
    for (let seq = 0; seq < Math.max(seeded.length, Math.round(RUNS / LENGTH)); seq++) {
      // unfrozen: a mutation of the input must show as a difference, not as a TypeError reported as invalid-action
      let p: Project = { ...boxProject(), sourceColors: [{ hex: '#808080', label: '' }], ...(seq === 1 ? { approved: true, mamad: 'none' as const } : {}) };
      const h = createHistory(1000);
      h.push(p);
      const trail = [p];
      for (let i = 0; i < LENGTH; i++) {
        const a = seeded[seq]?.[i] ?? action(p, r);
        const before = structuredClone(p);
        const res = apply(p, a);
        expect(p).toEqual(before);
        reached.add(res.ok ? 'ok' : res.reason);
        if (!res.ok) {
          expect(Object.keys(res).sort()).toEqual(['ok', 'reason']);
          continue;
        }
        const ring = p.existing.rooms.find(x => x.isMamad);
        if (ring && a.type.startsWith('x.')) {
          const now = res.project.existing.rooms.find(x => x.id === ring.id)!;
          expect(now.boundary.length, JSON.stringify(a)).toBe(ring.boundary.length);
          ring.boundary.forEach((q, k) => expect(Math.hypot(q.x - now.boundary[k].x, q.y - now.boundary[k].y), JSON.stringify(a)).toBeLessThan(0.03));
          expect(now.holes.length).toBe(ring.holes.length);
        }
        const parsed = ProjectSchema.safeParse(res.project);
        expect(parsed.success, `${JSON.stringify(a)}: ${parsed.error?.issues[0]?.message}`).toBe(true);
        if (GEOMETRIC.includes(a.type) && res.project.existing !== p.existing) {
          const s = res.project.existing;
          const again = computeRooms(s, s.rooms);
          expect(again.changes).toEqual([]);
          expect(again.rooms.map(x => x.id).sort()).toEqual(s.rooms.map(x => x.id).sort());
        }
        p = res.project;
        h.push(p);
        trail.push(p);
      }
      for (let i = trail.length - 2; i >= 0; i--) expect(h.undo()).toBe(trail[i]);
      expect(h.undo()).toBe(null);
      for (let i = 1; i < trail.length; i++) expect(h.redo()).toBe(trail[i]);
      expect(h.redo()).toBe(null);
    }
    expect([...reached].sort()).toEqual(
      ['existing-approved', 'invalid-action', 'invalid-geometry', 'invalid-number', 'mamad-locked', 'mamad-outdoor', 'ok', 'opening-out-of-wall', 'text-too-long'],
    );
  },
  LIMIT,
);

it(
  'apply never throws: null, arrays, strings and __proto__ in every field of every action type',
  () => {
    const r = randomFrom(7);
    const junk = [null, undefined, [], [1, 2], '', 'room-a', '__proto__', 'constructor', 5, -0, NaN, {}, { x: 1 }, { x: 1, y: 2, z: 3 }, JSON.parse('{"__proto__":{"x":1}}')];
    const pick = <T>(l: T[]): T => l[Math.floor(r() * l.length)];
    const types = ['x.addWall', 'x.deleteWall', 'x.setWall', 'x.splitWall', 'x.addOpening', 'x.setOpening', 'x.deleteOpening', 'x.addSeparator', 'x.deleteSeparator', 'x.clearReview', 'x.confirmOpenings', 'x.setRoom', 'x.keepName', 'setMamad', 'setName', 'classify', 'rescale', 'setPlaster', 'n.setColorLabel'];
    const fields = ['a', 'b', 'thickness', 'id', 'at', 'wallId', 'offset', 'width', 'kind', 'ids', 'name', 'inApartment', 'outdoor', 'room', 'part', 'cls', 'calibration', 'plaster', 'hex', 'label'];
    const p: Project = { ...boxProject(), sourceColors: [{ hex: '#808080', label: '' }] };
    const before = structuredClone(p);
    for (let i = 0; i < RUNS * 3; i++) {
      const a: Record<string, unknown> = { type: pick(types) };
      for (const f of fields) if (r() < 0.5) a[f] = pick(junk);
      const res = apply(p, a as never);
      if (res.ok) expect(ProjectSchema.safeParse(res.project).success).toBe(true);
    }
    expect(p).toEqual(before);
    expect(({} as Record<string, unknown>).x).toBeUndefined();
  },
  LIMIT,
);
