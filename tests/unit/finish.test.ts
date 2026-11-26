import { expect, it } from 'vitest';
import { apply } from '../../src/model/apply';
import { canFinish, finishStrips, roomAfterFinish } from '../../src/model/finish';
import { area } from '../../src/model/geo';
import { roomMetrics } from '../../src/model/measure';
import { computeRooms } from '../../src/model/rooms';
import { ProjectSchema } from '../../src/model/schema';
import type { Action, FinishAction, Project, Result, State, Wall } from '../../src/model/types';
import { boxApartment, boxProject, wall } from '../fixtures/box';

/** apply, checking the three properties: input untouched, refusal carries nothing, every accepted project parses. */
function act(p: Project, a: Action): Result {
  const before = structuredClone(p);
  const r = apply(p, a);
  expect(p).toEqual(before);
  if (r.ok) expect(ProjectSchema.safeParse(r.project).success).toBe(true);
  else expect(Object.keys(r).sort()).toEqual(['ok', 'reason']);
  return r;
}
const ok = (p: Project, a: Action) => {
  const r = act(p, a);
  if (!r.ok) throw new Error(`${a.type} refused: ${r.reason}`);
  return r;
};
const why = (p: Project, a: Action) => {
  const r = act(p, a);
  return r.ok ? 'ok' : r.reason;
};
const fin = (wallId: string, side: FinishAction['side'], mm: number | null, state: FinishAction['state'] = 'existing'): FinishAction => ({
  type: 'setFinish',
  state,
  wallId,
  side,
  mm,
});
/** Each finish in turn on the existing state. */
const finished = (p: Project, ...list: [string, FinishAction['side'], number | null][]) => list.reduce((q, [id, side, mm]) => ok(q, fin(id, side, mm)).project, p);
const near = (value: number, expected: number, tolerance = 0.01) =>
  expect(Math.abs(value - expected), `${value}, not ${expected}`).toBeLessThanOrEqual(tolerance);
const gross = (s: State, id: string) => roomMetrics(s.rooms.find(r => r.id === id)!, s.separators).areaMm2;
const net = (s: State, id: string) => roomAfterFinish(s, id)!.areaMm2;
const strip = (s: State, id: string) => area(finishStrips(s).get(id)!);
/** The box with more walls, its rooms computed, every room inside the apartment. */
function boxWith(...extra: Wall[]): Project {
  const s0 = boxApartment();
  const s = { ...s0, walls: [...s0.walls, ...extra] };
  return { ...boxProject(), existing: { ...s, rooms: computeRooms(s, s.rooms).rooms.map(r => ({ ...r, inApartment: true })) } };
}
const newRoom = (p: Project) => p.existing.rooms.find(r => r.id !== 'room-a' && r.id !== 'room-b')!;
/** An approved project with a plan that is a copy of the existing state. */
function withPlan(p = boxProject()): Project {
  const s = structuredClone(p.existing);
  const planned: State = { ...s, walls: s.walls.map(w => ({ ...w, status: 'kept' })), openings: s.openings.map(o => ({ ...o, status: 'kept' })) };
  return { ...p, approved: true, mamad: 'none', planned };
}

it('2 cm on the partition, side facing room A: A after finish is 2980 x 4000 = 11.92 m2; A by wall still 12.00', () => {
  const s = ok(boxProject(), fin('part', 'B', 20)).project.existing;
  near(net(s, 'room-a'), 11_920_000);
  expect(roomAfterFinish(s, 'room-a')!.rect).toEqual({ l: 4000, w: 2980 });
  near(gross(s, 'room-a'), 12_000_000);
});

it('room B is unchanged to the mm2 by a finish on the A side', () => {
  const p = boxProject();
  const s = ok(p, fin('part', 'B', 20)).project.existing;
  expect(roomAfterFinish(s, 'room-b')).toBeNull();
  expect(gross(s, 'room-b')).toBe(gross(p.existing, 'room-b'));
});

it('wall geometry, thickness and class are identical after setFinish', () => {
  const p = ok(boxProject(), { type: 'classify', wallId: 'part', cls: 'fixed' }).project;
  const q = ok(p, fin('part', 'B', 20)).project;
  const [before, after] = [p, q].map(x => x.existing.walls.find(w => w.id === 'part')!);
  expect({ ...after, finishB: null }).toEqual(before);
  expect(after.finishB).toBe(20);
  expect(q.wallClass).toBe(p.wallClass);
  expect(q.existing.rooms).toBe(p.existing.rooms);
  expect(q.existing.walls.filter(w => w.id !== 'part')).toEqual(p.existing.walls.filter(w => w.id !== 'part'));
  q.existing.walls.filter(w => w.id !== 'part').forEach((w, i) => expect(w).toBe(p.existing.walls.filter(x => x.id !== 'part')[i]));
});

it('the finish runs across the door, over the whole face: strips area === 20 * 4000', () => {
  const s = ok(boxProject(), fin('part', 'B', 20)).project.existing;
  near(strip(s, 'part'), 20 * 4000);
  near(net(s, 'room-a'), 11_920_000); // measured with the door closed
});

it('adding, moving or deleting an opening on a finished wall changes neither the strips nor the net room', () => {
  const p = ok(boxProject(), fin('part', 'B', 20)).project;
  const seen = (q: Project) => [strip(q.existing, 'part'), net(q.existing, 'room-a')];
  const added = ok(p, { type: 'x.addOpening', wallId: 'part', offset: 2500, width: 900, kind: 'passage' }).project;
  const moved = ok(p, { type: 'x.setOpening', id: 'door', offset: 2000, width: 1000 }).project;
  const deleted = ok(p, { type: 'x.deleteOpening', id: 'door' }).project;
  for (const q of [added, moved, deleted]) expect(seen(q)).toEqual(seen(p));
});

it('a face over two rooms: top B 20 gives A 3000 x 3980 and B 2900 x 3980; strip 118,000 across the window', () => {
  const s = ok(boxProject(), fin('top', 'B', 20)).project.existing;
  near(net(s, 'room-a'), 3000 * 3980);
  near(net(s, 'room-b'), 2900 * 3980);
  near(strip(s, 'top'), (3000 + 2900) * 20);
});

it('inner corner: all four faces of A at 20 give 2960 x 3960 = 11,721,600, each corner square taken once', () => {
  const s = finished(boxProject(), ['top', 'B', 20], ['part', 'B', 20], ['bottom', 'B', 20], ['left', 'B', 20]).existing;
  near(net(s, 'room-a'), 11_721_600);
  expect(roomAfterFinish(s, 'room-a')!.rect).toEqual({ l: 3960, w: 2960 });
});

it('outer corner: two finished faces run on into each other', () => {
  const p = boxWith(wall('h', 200, 1100, 1300, 1100, 200), wall('v', 1200, 200, 1200, 1200, 200));
  const g = gross(p.existing, 'room-a');
  near(g, 10_900_000);
  expect(p.existing.rooms.find(r => r.id === 'room-a')!.boundary).toHaveLength(6);
  near(g - net(finished(p, ['h', 'B', 20]).existing, 'room-a'), 22_000);
  const both = finished(p, ['h', 'B', 20], ['v', 'A', 20]).existing;
  near(g - net(both, 'room-a'), 42_400); // 22,000 + 20,000 + the 20 x 20 corner
  expect(roomAfterFinish(both, 'room-a')!.edges).toHaveLength(6);
  near(g - net(finished(p, ['h', 'B', 20], ['v', 'A', 30]).existing, 'room-a'), 52_600);
});

it('exterior wall: inner side accepted, outer side -> finish-outer-side', () => {
  const p = boxProject();
  expect(why(p, fin('top', 'A', 20))).toBe('finish-outer-side');
  expect(why(p, fin('top', 'B', 20))).toBe('ok');
  expect([canFinish(p.existing, 'top', 'A'), canFinish(p.existing, 'top', 'B')]).toEqual([false, true]);
});

it('balcony: a side facing only a balcony is refused; a face partly along it is drawn only along the room', () => {
  const p0 = boxWith(wall('bal', 3300, 3000, 6200, 3000, 100));
  const low = newRoom(p0);
  const p = { ...p0, existing: { ...p0.existing, rooms: p0.existing.rooms.map(r => (r === low ? { ...r, outdoor: true } : r)) } };
  expect(why(p, fin('bal', 'B', 20))).toBe('finish-outer-side');
  expect(why(p, fin('bal', 'A', 20))).toBe('ok');
  const s = ok(p, fin('right', 'B', 20)).project.existing;
  near(strip(s, 'right'), 2750 * 20);
  expect(roomAfterFinish(s, low.id)).toBeNull();
});

it('allowed on fixed, unknown and mamad walls; the mamad room is unchanged', () => {
  let p = ok(boxProject(), { type: 'setMamad', room: 'room-a' }).project;
  p = ok(p, { type: 'classify', wallId: 'part', cls: 'fixed' }).project;
  const q = finished(p, ['part', 'B', 20], ['top', 'B', 20], ['left', 'B', 20]);
  expect(q.existing.rooms).toBe(p.existing.rooms);
  expect(why(q, fin('left', 'A', 20))).toBe('finish-outer-side');
});

it('finish moves with its wall', () => {
  const p = ok(boxProject(), fin('part', 'B', 20)).project;
  const s = ok(p, { type: 'x.setWall', id: 'part', a: { x: 3500, y: 200 }, b: { x: 3500, y: 4200 } }).project.existing;
  near(net(s, 'room-a'), 3230 * 4000);
  near(strip(s, 'part'), 20 * 4000);
});

it('removing the finish (null) returns roomAfterFinish to null; null on an outer side is accepted', () => {
  const p = ok(boxProject(), fin('part', 'B', 20)).project;
  expect(roomAfterFinish(ok(p, fin('part', 'B', null)).project.existing, 'room-a')).toBeNull();
  expect(why(p, fin('top', 'A', null))).toBe('ok');
});

it('column 300 x 200: sides 20 take 12,000; ends at 20 too take 21,600; A 20, B 30, ends 20 take 25,000; A and ends 14,800', () => {
  const p = boxWith(wall('col', 4500, 2200, 4800, 2200, 200));
  const g = gross(p.existing, 'room-b');
  const off = (...list: [string, FinishAction['side'], number][]) => g - net(finished(p, ...list).existing, 'room-b');
  near(off(['col', 'A', 20], ['col', 'B', 20]), 12_000);
  near(off(['col', 'A', 20], ['col', 'B', 20], ['col', 'start', 20], ['col', 'end', 20]), 21_600);
  near(off(['col', 'A', 20], ['col', 'B', 30], ['col', 'start', 20], ['col', 'end', 20]), 25_000);
  near(off(['col', 'A', 20], ['col', 'start', 20], ['col', 'end', 20]), 14_800);
  const s = finished(p, ['col', 'start', 20]).existing;
  near(strip(s, 'col'), 200 * 20);
});

it('a room stored with its rings the other way round gives the same net area', () => {
  const p = finished(boxWith(wall('col', 4500, 2200, 4800, 2200, 200)), ['col', 'A', 20], ['part', 'A', 20]);
  const s = p.existing;
  const turned = { ...s, rooms: s.rooms.map(r => ({ ...r, boundary: [...r.boundary].reverse(), holes: r.holes.map(h => [...h].reverse()) })) };
  near(net(turned, 'room-b'), net(s, 'room-b'), 1e-6);
});

it('one straight edge over two walls in line takes the finish of each wall only along that wall', () => {
  const s0 = boxApartment();
  const walls = [...s0.walls.filter(w => w.id !== 'top'), wall('t1', 0, 100, 1700, 100, 200), wall('t2', 1700, 100, 6400, 100, 200)];
  const s = { ...s0, walls, openings: s0.openings.filter(o => o.wallId !== 'top') };
  const p: Project = { ...boxProject(), existing: { ...s, rooms: computeRooms(s, s.rooms).rooms } };
  expect(p.existing.rooms.find(r => r.id === 'room-a')!.boundary).toHaveLength(4);
  const q = finished(p, ['t1', 'B', 20]).existing;
  near(gross(q, 'room-a') - net(q, 'room-a'), 1500 * 20);
  near(strip(q, 't1'), 1500 * 20);
});

it('a strip is never drawn outside its room: 200 mm stored on a 150 mm corridor draws 2900 x 150', () => {
  const p = boxWith(wall('k', 3300, 4000, 6200, 4000, 100));
  const s = { ...p.existing, walls: p.existing.walls.map(w => (w.id === 'k' ? { ...w, finishB: 200 } : w)) };
  near(strip(s, 'k'), 2900 * 150);
  expect(roomAfterFinish(s, newRoom(p).id)!.areaMm2).toBe(0);
});

it('a wall that stops in the room: its free end takes a finish, its joined end refuses', () => {
  const p = boxWith(wall('stub', 3300, 2200, 4300, 2200, 100));
  const g = gross(p.existing, 'room-b');
  expect([canFinish(p.existing, 'stub', 'start'), canFinish(p.existing, 'stub', 'end')]).toEqual([false, true]);
  expect(why(p, fin('stub', 'start', 20))).toBe('finish-outer-side');
  near(g - net(finished(p, ['stub', 'A', 20], ['stub', 'B', 20]).existing, 'room-b'), 40_000);
  near(g - net(finished(p, ['stub', 'A', 20], ['stub', 'B', 20], ['stub', 'end', 20]).existing, 'room-b'), 42_800);
});

it('an end finish stored on an end that is not free is kept and neither drawn nor counted', () => {
  const p0 = finished(boxWith(wall('stub', 3300, 2200, 4300, 2200, 100)), ['stub', 'A', 20], ['stub', 'B', 20]);
  const p = { ...p0, existing: { ...p0.existing, walls: p0.existing.walls.map(w => (w.id === 'stub' ? { ...w, finishStart: 20 } : w)) } };
  expect(ProjectSchema.safeParse(p).success).toBe(true);
  expect(net(p.existing, 'room-b')).toBe(net(p0.existing, 'room-b'));
  expect(strip(p.existing, 'stub')).toBe(strip(p0.existing, 'stub'));
});

it('a separator: each part loses its own piece, the separator edge is not listed', () => {
  const p = ok(boxProject(), { type: 'x.addSeparator', a: { x: 200, y: 2000 }, b: { x: 3200, y: 2000 } }).project;
  const s = finished(p, ['part', 'B', 20], ['left', 'B', 20]).existing;
  const parts = s.rooms.filter(r => r.id !== 'room-b').map(r => roomAfterFinish(s, r.id)!);
  expect(parts.map(m => Math.round(m.areaMm2)).sort()).toEqual([5_328_000, 6_512_000]);
  expect(parts.map(m => m.edges.length)).toEqual([3, 3]);
});

it('finish in one state leaves the other', () => {
  const p = withPlan();
  const q = ok(p, fin('part', 'B', 20, 'planned')).project;
  expect(q.existing).toBe(p.existing);
  expect(q.planned!.walls.find(w => w.id === 'part')!.finishB).toBe(20);
  near(net(q.planned!, 'room-a'), 11_920_000);
  const r = ok(q, fin('part', 'B', 30)).project;
  expect(r.planned).toBe(q.planned);
  expect(r.existing.walls.find(w => w.id === 'part')!.finishB).toBe(30);
});

it("'planned' without a plan -> existing-not-approved; removed planned wall, unknown wall, side, state -> invalid-action", () => {
  expect(why(boxProject(), fin('part', 'B', 20, 'planned'))).toBe('existing-not-approved');
  const p = withPlan();
  const removed = { ...p, planned: { ...p.planned!, walls: p.planned!.walls.map(w => (w.id === 'part' ? { ...w, status: 'removed' as const } : w)) } };
  expect(why(removed, fin('part', 'B', 20, 'planned'))).toBe('invalid-action');
  for (const a of [fin('nope', 'B', 20), fin('part', 'C' as never, 20), fin('part', 'constructor' as never, 20), fin('part', 'B', 20, 'x' as never)])
    expect(why(boxProject(), a)).toBe('invalid-action');
});

it('inWall gives plaster-in-wall on every accepted finish, not on null; none, line, unknown and null give no notice', () => {
  const inWall = { ...boxProject(), plaster: 'inWall' as const };
  expect(ok(inWall, fin('part', 'B', 20)).notice).toBe('plaster-in-wall');
  expect(ok(inWall, fin('part', 'B', null)).notice).toBeUndefined();
  for (const plaster of ['none', 'line', 'unknown', null] as const) expect(ok({ ...boxProject(), plaster }, fin('part', 'B', 20)).notice).toBeUndefined();
});

it('accepted after approval in both states', () => {
  const p = withPlan();
  expect(why(p, fin('part', 'B', 20))).toBe('ok');
  expect(why(p, fin('part', 'B', 20, 'planned'))).toBe('ok');
});

it('end finishes in the file: absent parses as before, null and 1 to 200 whole mm, a round trip keeps them', () => {
  const p = boxProject();
  expect(Object.hasOwn(p.existing.walls[0], 'finishStart')).toBe(false);
  expect(ProjectSchema.safeParse(p).success).toBe(true);
  for (const field of ['finishStart', 'finishEnd'] as const)
    expect(
      [null, 1, 200, undefined, 0, 201, 2.5, -1, '20'].map(v => {
        const q = boxProject();
        (q.existing.walls[0] as Record<string, unknown>)[field] = v;
        return ProjectSchema.safeParse(q).success;
      }),
      field,
    ).toEqual([true, true, true, true, false, false, false, false, false]);
  const s = finished(boxWith(wall('col', 4500, 2200, 4800, 2200, 200)), ['col', 'start', 20], ['col', 'end', 35]);
  const back = ProjectSchema.parse(JSON.parse(JSON.stringify(s)));
  expect(back.existing.walls.find(w => w.id === 'col')).toMatchObject({ finishStart: 20, finishEnd: 35 });
});
