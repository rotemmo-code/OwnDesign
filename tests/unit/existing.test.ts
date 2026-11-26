import { expect, it } from 'vitest';
import { apply, Refused } from '../../src/model/apply';
import { rebuildExisting } from '../../src/model/existing';
import { roomMetrics } from '../../src/model/measure';
import { computeRooms } from '../../src/model/rooms';
import { mamadAllows, mamadSpan, mamadWallsKept, separatorBoundsMamad, suggestedFixed, wallBoundsMamad, wallEntersMamad } from '../../src/model/rules';
import { ProjectSchema } from '../../src/model/schema';
import type { Action, Project, Pt, Result, State, Wall } from '../../src/model/types';
import { boxProject, wall } from '../fixtures/box';

const P = (x: number, y: number): Pt => ({ x, y });
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
const m2 = (p: Project, id: string) => {
  const room = p.existing.rooms.find(r => r.id === id)!;
  return Number((roomMetrics(room, p.existing.separators).areaMm2 / 1e6).toFixed(2));
};
const areas = (p: Project) => p.existing.rooms.map(r => m2(p, r.id)).sort((a, b) => a - b);
const addWall = (a: Pt, b: Pt, thickness = 100): Action => ({ type: 'x.addWall', a, b, thickness });
const across: Action = addWall(P(200, 2000), P(3200, 2000));
const separator: Action = { type: 'x.addSeparator', a: P(200, 2000), b: P(3200, 2000) };
const box: [Pt, Pt][] = [
  [P(1000, 1000), P(2000, 1000)],
  [P(2000, 1000), P(2000, 2000)],
  [P(2000, 2000), P(1000, 2000)],
  [P(1000, 2000), P(1000, 1000)],
];
const mamadOn = (room: string, p = boxProject()) => ok(p, { type: 'setMamad', room }).project;
const unmarked = (p: Project) => ok(p, { type: 'setMamad', room: null }).project;
const withWalls = (p: Project, walls: Wall[]): Project => {
  const s = { ...p.existing, walls };
  return { ...p, existing: { ...s, rooms: computeRooms(s, p.existing.rooms).rooms } };
};
const sep = (p: Project) => p.existing.separators[0].id;

it('every x.* action, setMamad and rescale work before approval and return existing-approved after', () => {
  const p = boxProject();
  const actions: Action[] = [
    addWall(P(3300, 2000), P(6200, 2000)),
    { type: 'x.deleteWall', id: 'part' },
    { type: 'x.setWall', id: 'part', thickness: 120 },
    { type: 'x.splitWall', id: 'part', at: 2000 },
    { type: 'x.addOpening', wallId: 'right', offset: 100, width: 800, kind: 'window' },
    { type: 'x.setOpening', id: 'door', width: 700 },
    { type: 'x.deleteOpening', id: 'door' },
    separator,
    { type: 'x.clearReview', id: 'part' },
    { type: 'x.confirmOpenings', ids: ['door'] },
    { type: 'x.setRoom', id: 'room-a', name: 'Living' },
    { type: 'x.keepName', room: 'room-a', part: 'room-b' },
    { type: 'setMamad', room: 'room-b' },
    { type: 'rescale', calibration: { ...p.calibration, mmPerPt: p.calibration.mmPerPt * 1.01 } },
  ];
  const cut = ok(p, separator).project;
  const all = [...actions, { type: 'x.deleteSeparator', id: sep(cut) } as Action];
  expect(all.map(a => why(a.type === 'x.deleteSeparator' ? cut : p, a))).toEqual(all.map(() => 'ok'));
  const approved = (q: Project): Project => ({ ...q, approved: true, mamad: 'none' });
  expect(all.map(a => why(approved(a.type === 'x.deleteSeparator' ? cut : p), a))).toEqual(all.map(() => 'existing-approved'));
});

it('classify, setName, setPlaster and n.setColorLabel work after approval', () => {
  const p: Project = { ...boxProject(), approved: true, mamad: 'none', sourceColors: [{ hex: '#808080', label: '' }] };
  const actions: Action[] = [
    { type: 'classify', wallId: 'part', cls: 'fixed' },
    { type: 'setName', name: 'n' },
    { type: 'setPlaster', plaster: 'line' },
    { type: 'n.setColorLabel', hex: '#808080', label: 'walls' },
  ];
  expect(actions.map(a => why(p, a))).toEqual(['ok', 'ok', 'ok', 'ok']);
});

it('the first classify to changeable gives load-bearing-warning, the second none; an unknown wall -> invalid-action', () => {
  const first = ok(boxProject(), { type: 'classify', wallId: 'part', cls: 'changeable' });
  expect(first.notice).toBe('load-bearing-warning');
  expect(first.project.changeableWarningShown).toBe(true);
  expect(first.project.wallClass).toEqual({ part: 'changeable' });
  const second = ok(first.project, { type: 'classify', wallId: 'top', cls: 'changeable' });
  expect(second.notice).toBeUndefined();
  expect(why(boxProject(), { type: 'classify', wallId: 'nope', cls: 'fixed' })).toBe('invalid-action');
});

it('splitWall at 2000: 6 walls, both parts with the class, the door stays on the first; at 900 the door moves to the second at offset 100', () => {
  const p = ok(boxProject(), { type: 'classify', wallId: 'part', cls: 'fixed' }).project;
  const r = ok(p, { type: 'x.splitWall', id: 'part', at: 2000 });
  const s = r.project.existing;
  expect(s.walls).toHaveLength(6);
  const second = s.walls[5];
  expect(s.walls.find(w => w.id === 'part')).toMatchObject({ a: P(3250, 200), b: P(3250, 2200) });
  expect(second).toMatchObject({ a: P(3250, 2200), b: P(3250, 4200), thickness: 100 });
  expect(r.project.wallClass).toEqual({ part: 'fixed', [second.id]: 'fixed' });
  expect(s.openings.find(o => o.id === 'door')).toMatchObject({ wallId: 'part', offset: 1000 });
  expect(r.notice).toBeUndefined();
  expect(s.rooms.map(x => x.id)).toEqual(['room-a', 'room-b']);
  expect(areas(r.project)).toEqual([11.6, 12]);
  const at900 = ok(boxProject(), { type: 'x.splitWall', id: 'part', at: 900 }).project;
  expect(at900.existing.openings.find(o => o.id === 'door')).toMatchObject({ wallId: at900.existing.walls[5].id, offset: 100 });
  expect(at900.wallClass).toEqual({});
  const classed = ok(p, { type: 'x.splitWall', id: 'part', at: 900 }).project;
  expect(classed.wallClass[classed.existing.walls[5].id]).toBe('fixed');
});

it('splitWall through the door, or leaving a part under 10 mm -> invalid-geometry', () => {
  expect(why(boxProject(), { type: 'x.splitWall', id: 'part', at: 1400 })).toBe('invalid-geometry');
  expect(why(boxProject(), { type: 'x.splitWall', id: 'part', at: 9.9 })).toBe('invalid-geometry');
  expect(why(boxProject(), { type: 'x.splitWall', id: 'part', at: 3990.1 })).toBe('invalid-geometry');
  expect(why(boxProject(), { type: 'x.splitWall', id: 'part', at: 10 })).toBe('ok');
});

it('deleting a wall deletes its openings and its class', () => {
  const p = ok(boxProject(), { type: 'classify', wallId: 'part', cls: 'fixed' }).project;
  const r = ok(p, { type: 'x.deleteWall', id: 'part' });
  expect(r.project.existing.openings.map(o => o.id)).toEqual(['window', 'entry']);
  expect(r.project.wallClass).toEqual({});
  expect(r.notice).toEqual({ rooms: [{ type: 'merge', room: 'room-a', from: ['room-a', 'room-b'] }] });
});

it('rejects degenerate geometry and changes nothing', () => {
  const p = boxProject();
  const cases: Action[] = [
    addWall(P(1000, 1000), P(1009.9, 1000)),
    addWall(P(1000, 1000), P(2000, 1000), 19),
    addWall(P(1000, 1000), P(2000, 1000), 1001),
    addWall(P(3250, 200), P(3250, 4200)),
    addWall(P(3250, 4200), P(3250, 200)),
    addWall(P(3251, 200), P(3251, 4200)),
    addWall(P(3250, 200), P(3250, 4200), 120),
    addWall(P(3250, 200), P(3250, 2200)),
    addWall(P(3250, 1000), P(3250, 1010)),
    addWall(P(-500, 100), P(7000, 100), 200),
  ];
  expect(cases.map(a => why(p, a))).toEqual(cases.map(() => 'invalid-geometry'));
});

it('half overlapping, a T to a face and a crossing wall are accepted', () => {
  const p = boxProject();
  expect([addWall(P(3250, 2200), P(3250, 6200)), across, addWall(P(2000, 2000), P(4500, 2000))].map(a => why(p, a))).toEqual(['ok', 'ok', 'ok']);
});

it('openings: up to the end fits, touching fits; past the end or negative -> opening-out-of-wall; width 99 or overlap -> invalid-geometry; added and set are confirmed', () => {
  const p = boxProject();
  const add = (offset: number, width: number): Action => ({ type: 'x.addOpening', wallId: 'part', offset, width, kind: 'door' });
  expect([add(3200, 800), add(1800, 800), add(3300, 800), add(-1, 800), add(2500, 99), add(1700, 800)].map(a => why(p, a))).toEqual([
    'ok', 'ok', 'opening-out-of-wall', 'opening-out-of-wall', 'invalid-geometry', 'invalid-geometry',
  ]);
  expect(why(p, { type: 'x.addOpening', wallId: 'nope', offset: 0, width: 800, kind: 'door' })).toBe('invalid-action');
  const added = ok(p, add(3200, 800)).project.existing.openings[3];
  expect(added).toMatchObject({ wallId: 'part', offset: 3200, width: 800, kind: 'door', review: false, confirmed: true });
  const doubted: Project = { ...p, existing: { ...p.existing, openings: p.existing.openings.map(o => ({ ...o, review: true, confirmed: false })) } };
  const set = ok(doubted, { type: 'x.setOpening', id: 'door', kind: 'passage' }).project.existing.openings[0];
  expect(set).toMatchObject({ kind: 'passage', review: true, confirmed: true, offset: 1000, width: 800 });
  expect(why(p, { type: 'x.setOpening', id: 'door', offset: 3300 })).toBe('opening-out-of-wall');
  expect(why(p, { type: 'x.deleteOpening', id: 'nope' })).toBe('invalid-action');
});

it('setWall: end a 500 down keeps the door in place, offset 500; shortened under the door -> opening-out-of-wall; reversed -> invalid-geometry', () => {
  const p = boxProject();
  const moved = ok(p, { type: 'x.setWall', id: 'part', a: P(3250, 700) }).project.existing;
  expect(moved.openings.find(o => o.id === 'door')!.offset).toBe(500);
  expect(why(p, { type: 'x.setWall', id: 'part', b: P(3250, 1500) })).toBe('opening-out-of-wall');
  expect(why(p, { type: 'x.setWall', id: 'part', a: P(3250, 4200), b: P(3250, 200) })).toBe('invalid-geometry');
  expect(why(p, { type: 'x.setWall', id: 'nope', thickness: 120 })).toBe('invalid-action');
});

it('numbers: NaN, Infinity, "1", a null point -> invalid-number; 2e6 -> invalid-geometry', () => {
  const p = boxProject();
  const cases: Action[] = [
    addWall(P(NaN, 0), P(1000, 0)),
    addWall(P(0, 0), P(Infinity, 0)),
    addWall({ x: '1', y: 0 } as never, P(1000, 0)),
    addWall(null as never, P(1000, 0)),
    addWall(P(0, 0), P(1000, 0), NaN),
    { type: 'x.splitWall', id: 'part', at: NaN },
    { type: 'x.addOpening', wallId: 'part', offset: Infinity, width: 800, kind: 'door' },
  ];
  expect(cases.map(a => why(p, a))).toEqual(cases.map(() => 'invalid-number'));
  expect(why(p, addWall(P(2e6, 0), P(2e6 + 1000, 0)))).toBe('invalid-geometry');
});

it('a wall across room A: split notice, room-a keeps 6.45, the new part 5.25', () => {
  const r = ok(boxProject(), across);
  const fresh = r.project.existing.rooms.find(x => !['room-a', 'room-b'].includes(x.id))!;
  expect(r.notice).toEqual({ rooms: [{ type: 'split', room: 'room-a', parts: ['room-a', fresh.id] }] });
  expect([m2(r.project, 'room-a'), m2(r.project, fresh.id)]).toEqual([6.45, 5.25]);
  expect(fresh).toMatchObject({ name: '', inApartment: true, outdoor: false, isMamad: false });
});

it('a separator at y 2000: 6.60 and 5.40; deleting it merges back with a merge notice', () => {
  const r = ok(boxProject(), separator);
  expect(areas(r.project)).toEqual([5.4, 6.6, 11.6]);
  const fresh = r.project.existing.rooms[2].id;
  expect(r.notice).toEqual({ rooms: [{ type: 'split', room: 'room-a', parts: ['room-a', fresh] }] });
  const back = ok(r.project, { type: 'x.deleteSeparator', id: sep(r.project) });
  expect(back.notice).toEqual({ rooms: [{ type: 'merge', room: 'room-a', from: ['room-a', fresh] }] });
  expect(areas(back.project)).toEqual([11.6, 12]);
});

it('a separator that cuts nothing is refused', () => {
  const p = boxProject();
  const line = (a: Pt, b: Pt): Action => ({ type: 'x.addSeparator', a, b });
  const cut = ok(p, separator).project;
  expect(why(cut, separator)).toBe('invalid-geometry');
  const cases = [
    line(P(200, 2000), P(3195, 2000)),
    line(P(3200, 200), P(3200, 4200)),
    line(P(3250, 200), P(3250, 4200)),
    line(P(-3000, -3000), P(-1000, -1000)),
    line(P(500, 500), P(500.5, 500)),
  ];
  expect(cases.map(a => why(p, a))).toEqual(cases.map(() => 'invalid-geometry'));
  const both = ok(p, line(P(200, 2000), P(6200, 2000)));
  expect(both.notice && typeof both.notice === 'object' && both.notice.rooms.map(c => c.type)).toEqual(['split', 'split']);
});

it('mamad-locked: walls bounding the mamad cannot be deleted, moved or split, and nothing changes', () => {
  const p = mamadOn('room-b');
  const cases: Action[] = [
    { type: 'x.deleteWall', id: 'part' },
    { type: 'x.setWall', id: 'part', thickness: 120 },
    { type: 'x.setWall', id: 'right', a: P(6300, 250) },
    { type: 'x.splitWall', id: 'part', at: 2000 },
    { type: 'x.deleteWall', id: 'top' },
  ];
  expect(cases.map(a => why(p, a))).toEqual(cases.map(() => 'mamad-locked'));
  expect(cases.map(a => why(unmarked(p), a))).toEqual(cases.map(() => 'ok'));
});

it('mamad-locked: no wall and no separator inside the mamad; a wall up to its outer face or its centre line from the neighbour is fine', () => {
  const p = mamadOn('room-a');
  const inside: Action[] = [
    across,
    ...box.map(([a, b]) => addWall(a, b)),
    separator,
    { type: 'x.addSeparator', a: P(200, 2000), b: P(6200, 2000) },
    addWall(P(3199, 2000), P(6200, 2000)),
  ];
  expect(inside.map(a => why(p, a))).toEqual(inside.map(() => 'mamad-locked'));
  const b = mamadOn('room-b');
  expect([addWall(P(200, 2000), P(3200, 2000)), addWall(P(200, 2000), P(3250, 2000))].map(a => why(b, a))).toEqual(['ok', 'ok']);
  expect(why(b, addWall(P(200, 2000), P(3301, 2000)))).toBe('mamad-locked');
  expect(why(b, { type: 'x.addSeparator', a: P(200, 2000), b: P(3200, 2000) })).toBe('ok');
  expect(inside.map(a => why(unmarked(p), a))).toEqual(inside.map(() => 'ok'));
});

it('mamad-locked: a wall moved into the mamad, and the separator that bounds it', () => {
  const p = ok(ok(boxProject(), separator).project, { type: 'setMamad', room: 'room-a' }).project;
  expect(separatorBoundsMamad(p.existing, sep(p))).toBe(true);
  expect(why(p, { type: 'x.deleteSeparator', id: sep(p) })).toBe('mamad-locked');
  expect(why(unmarked(p), { type: 'x.deleteSeparator', id: sep(p) })).toBe('ok');
  const q = mamadOn('room-a');
  const stub = ok(unmarked(q), addWall(P(4000, 1000), P(5000, 1000))).project;
  const marked = mamadOn('room-a', stub);
  const id = marked.existing.walls[5].id;
  expect(why(marked, { type: 'x.setWall', id, a: P(2000, 1000) })).toBe('mamad-locked');
  expect(why(marked, { type: 'x.setWall', id, a: P(4100, 1000) })).toBe('ok');
});

it('openings on a mamad wall still work in the existing state', () => {
  const p = mamadOn('room-b');
  expect(why(p, { type: 'x.addOpening', wallId: 'right', offset: 100, width: 800, kind: 'window' })).toBe('ok');
  expect(why(p, { type: 'x.setOpening', id: 'door', offset: 1100 })).toBe('ok');
  expect(why(p, { type: 'x.deleteOpening', id: 'door' })).toBe('ok');
  expect(why(p, { type: 'x.confirmOpenings', ids: ['door'] })).toBe('ok');
});

it('wallBoundsMamad: a face on the mamad\'s outline; not a corner touch, not the far side of a neighbour', () => {
  // 2 x 2 rooms of 3000, one wall per cell edge; the top-left room is the mamad
  const walls: Wall[] = [];
  for (let i = 0; i <= 2; i++)
    for (let j = 0; j < 2; j++) {
      walls.push(wall(`h${i}${j}`, j * 3000, i * 3000, (j + 1) * 3000, i * 3000, 100));
      walls.push(wall(`v${i}${j}`, i * 3000, j * 3000, i * 3000, (j + 1) * 3000, 100));
    }
  const s: State = { walls, openings: [], separators: [], rooms: [] };
  s.rooms = computeRooms(s, []).rooms;
  const corner = s.rooms.find(r => r.boundary.some(q => q.x === 50 && q.y === 50))!;
  s.rooms = s.rooms.map(r => ({ ...r, isMamad: r === corner }));
  const bounding = walls.filter(w => wallBoundsMamad(s, w.id)).map(w => w.id).sort();
  expect(bounding).toEqual(['h00', 'h10', 'v00', 'v10']);
  expect(wallBoundsMamad({ ...s, rooms: s.rooms.map(r => ({ ...r, isMamad: false })) }, 'h00')).toBe(false);
});

it('7D backstop: a recompute that would split the mamad -> mamad-split', () => {
  const p = mamadOn('room-a');
  const s = { ...p.existing, walls: [...p.existing.walls, wall('cut', 200, 2000, 3200, 2000, 100)] };
  let thrown: unknown;
  try {
    rebuildExisting(p, s, ['cut'], { mamadMayChange: true });
  } catch (e) {
    thrown = e;
  }
  expect(thrown).toEqual(new Refused('mamad-split'));
});

it('M11: a merge that includes the mamad, or a mamad that is gone, clears the mark and opens the question', () => {
  for (const room of ['room-a', 'room-b']) {
    const p = mamadOn(room);
    const s = { ...p.existing, walls: p.existing.walls.filter(w => w.id !== 'part'), openings: p.existing.openings.filter(o => o.wallId !== 'part') };
    const r = rebuildExisting(p, s, [], { mamadMayChange: true });
    expect(r.project.mamad).toBeNull();
    expect(r.project.existing.rooms.some(x => x.isMamad)).toBe(false);
    expect(ProjectSchema.safeParse(r.project).success).toBe(true);
  }
  const p = mamadOn('room-a');
  const open = rebuildExisting(p, { ...p.existing, walls: p.existing.walls.filter(w => w.id !== 'left') }, [], { mamadMayChange: true });
  expect([open.project.mamad, open.project.existing.rooms.map(r => r.id)]).toEqual([null, ['room-b']]);
});

it('after setMamad null, deleting and redrawing the partition splits without a mark', () => {
  const p = unmarked(mamadOn('room-a'));
  const gone = ok(p, { type: 'x.deleteWall', id: 'part' }).project;
  const again = ok(gone, addWall(P(3250, 200), P(3250, 4200)));
  expect(again.project.mamad).toBeNull();
  expect(again.notice && typeof again.notice === 'object' && again.notice.rooms[0].type).toBe('split');
});

it('keepName swaps id and name; with the mamad -> mamad-locked, after setMamad null it works; the same room or an unknown one -> invalid-action', () => {
  const split = ok(boxProject(), across).project;
  const other = split.existing.rooms.find(r => !['room-a', 'room-b'].includes(r.id))!;
  const k = ok(split, { type: 'x.keepName', room: 'room-a', part: other.id }).project;
  expect([m2(k, 'room-a'), m2(k, other.id)]).toEqual([5.25, 6.45]);
  expect([k.existing.rooms.find(r => r.id === 'room-a')!.name, k.existing.rooms.find(r => r.id === other.id)!.name]).toEqual(['A', '']);
  const m = mamadOn('room-b');
  expect(why(m, { type: 'x.keepName', room: 'room-b', part: 'room-a' })).toBe('mamad-locked');
  expect(why(m, { type: 'x.keepName', room: 'room-a', part: 'room-b' })).toBe('mamad-locked');
  const sw = ok(unmarked(m), { type: 'x.keepName', room: 'room-b', part: 'room-a' }).project;
  expect(sw.existing.rooms.map(r => [r.id, r.name, r.boundary[0].x])).toEqual([['room-b', 'B', 200], ['room-a', 'A', 3300]]);
  expect(why(m, { type: 'x.keepName', room: 'room-a', part: 'room-a' })).toBe('invalid-action');
  expect(why(m, { type: 'x.keepName', room: 'room-a', part: 'nope' })).toBe('invalid-action');
});

it('mamad-outdoor: setMamad on a balcony, outdoor on the mamad; keepName cannot move the mark at all', () => {
  const balcony = ok(boxProject(), { type: 'x.setRoom', id: 'room-a', outdoor: true }).project;
  expect(why(balcony, { type: 'setMamad', room: 'room-a' })).toBe('mamad-outdoor');
  expect(why(mamadOn('room-b'), { type: 'x.setRoom', id: 'room-b', outdoor: true })).toBe('mamad-outdoor');
  expect(why(mamadOn('room-b', balcony), { type: 'x.keepName', room: 'room-b', part: 'room-a' })).toBe('mamad-locked');
});

it('setMamad: a room, none, null (question open again); an unknown room -> invalid-action', () => {
  const p = mamadOn('room-a');
  expect([p.mamad, p.existing.rooms.map(r => r.isMamad)]).toEqual(['room-a', [true, false]]);
  const none = ok(p, { type: 'setMamad', room: 'none' }).project;
  expect([none.mamad, none.existing.rooms.map(r => r.isMamad)]).toEqual(['none', [false, false]]);
  expect(unmarked(p).mamad).toBeNull();
  expect(why(p, { type: 'setMamad', room: 'nope' })).toBe('invalid-action');
});

it('setName: 200 ok, 201 text-too-long, empty invalid-action; a room name of 201 -> text-too-long', () => {
  const p = boxProject();
  expect([200, 201, 0].map(n => why(p, { type: 'setName', name: 'x'.repeat(n) }))).toEqual(['ok', 'text-too-long', 'invalid-action']);
  expect(why(p, { type: 'setName', name: 5 as never })).toBe('invalid-action');
  expect(why(p, { type: 'x.setRoom', id: 'room-a', name: 'x'.repeat(201) })).toBe('text-too-long');
  expect(ok(p, { type: 'x.setRoom', id: 'room-a', name: '', inApartment: false }).project.existing.rooms[0]).toMatchObject({ name: '', inApartment: false });
});

it('rescale by 2: 6000 x 8000, separator and cloud doubled, finishA 20 unchanged, calibration stored, plannedArchive the same object', () => {
  const base = boxProject();
  const p0: Project = { ...base, clouds: [{ id: 'c1', a: P(10, 10), b: P(20, 30), note: '', source: 'manual' }] };
  const p1 = ok(p0, { type: 'x.addSeparator', a: P(3300, 2000), b: P(6200, 2000) }).project;
  const p: Project = { ...p1, existing: { ...p1.existing, walls: p1.existing.walls.map(w => (w.id === 'part' ? { ...w, finishA: 20 } : w)) } };
  const calibration = { ...p.calibration, mmPerPt: p.calibration.mmPerPt * 2 };
  const r = ok(p, { type: 'rescale', calibration });
  const s = r.project.existing;
  expect(roomMetrics(s.rooms.find(x => x.id === 'room-a')!, s.separators).rect).toEqual({ l: 8000, w: 6000 });
  expect(s.separators[0]).toMatchObject({ a: P(6600, 4000), b: P(12400, 4000) });
  expect(r.project.clouds[0]).toMatchObject({ a: P(20, 20), b: P(40, 60) });
  expect(s.walls.find(w => w.id === 'part')).toMatchObject({ finishA: 20, thickness: 200 });
  expect(s.openings.find(o => o.id === 'door')).toMatchObject({ offset: 2000, width: 1600 });
  expect(r.project.calibration).toEqual(calibration);
  expect(r.project.plannedArchive).toBe(p.plannedArchive);
  expect(r.notice).toBeUndefined();
  expect(s.rooms.map(x => x.id)).toEqual(p.existing.rooms.map(x => x.id));
});

it('rescale: a thickness over 1000 or a coordinate over 1e6 -> invalid-geometry; mmPerPt 0, -1, NaN -> invalid-number; an extra key -> invalid-action', () => {
  const p = boxProject();
  const by = (f: number) => ({ type: 'rescale', calibration: { ...p.calibration, mmPerPt: p.calibration.mmPerPt * f } }) as Action;
  const thick: Project = { ...p, existing: { ...p.existing, walls: p.existing.walls.map(w => (w.id === 'top' ? { ...w, thickness: 600 } : w)) } };
  expect(why(thick, by(2))).toBe('invalid-geometry');
  expect(why(p, by(200))).toBe('invalid-geometry');
  expect([0, -1, NaN].map(f => why(p, by(f)))).toEqual(['invalid-number', 'invalid-number', 'invalid-number']);
  expect(why(p, { type: 'rescale', calibration: { ...p.calibration, evil: 1 } as never })).toBe('invalid-action');
  expect(why(p, by(1))).toBe('ok');
});

it('rescale recomputes: a 1.5 mm gap that becomes 3 mm opens room A', () => {
  const p = boxProject();
  const gap = withWalls(p, p.existing.walls.map(w => (w.id === 'left' ? { ...w, a: P(100, 4198.5) } : w)));
  expect(gap.existing.rooms.map(r => r.id).sort()).toEqual(['room-a', 'room-b']);
  const r = ok(gap, { type: 'rescale', calibration: { ...p.calibration, mmPerPt: p.calibration.mmPerPt * 2 } });
  expect(r.project.existing.rooms.map(x => x.id)).toEqual(['room-b']);
});

it('caps: the 5,001st wall -> too-many within 50 ms; a wall that makes room 1,001 -> too-many; the 1,001st separator', () => {
  const p = boxProject();
  const many = Array.from({ length: 4995 }, (_, i) => wall(`z${i}`, 10000 + (i % 70) * 300, 10000 + Math.floor(i / 70) * 300, 10100 + (i % 70) * 300, 10000 + Math.floor(i / 70) * 300, 20));
  const full: Project = { ...p, existing: { ...p.existing, walls: [...p.existing.walls, ...many] } };
  const t = performance.now();
  expect(why(full, addWall(P(0, 9000), P(1000, 9000)))).toBe('too-many');
  expect(performance.now() - t).toBeLessThan(50);
  const lines = Array.from({ length: 1000 }, (_, i) => ({ id: `s${i}`, a: P(-5000 - i, -5000), b: P(-5000 - i, -4000) }));
  expect(why({ ...p, existing: { ...p.existing, separators: lines } }, separator)).toBe('too-many');
  // 1,000 rooms of 1 m; one more wall would make 1,001
  const grid: Wall[] = [];
  for (let i = 0; i <= 25; i++) grid.push(wall(`gx${i}`, 0, i * 1000, 40000, i * 1000, 100));
  for (let j = 0; j <= 40; j++) grid.push(wall(`gy${j}`, j * 1000, 0, j * 1000, 25000, 100));
  const s: State = { walls: grid, openings: [], separators: [], rooms: [] };
  s.rooms = computeRooms(s, []).rooms;
  expect(s.rooms).toHaveLength(1000);
  expect(why({ ...p, existing: s }, addWall(P(500, 0), P(500, 1000)))).toBe('too-many');
}, 30_000);

it('suggestedFixed: the window wall, the envelope and a 20 x 30 cm column, not the partition; a classed wall is not listed', () => {
  const p = boxProject();
  const col = withWalls(p, [...p.existing.walls, wall('col', 1000, 1000, 1300, 1000, 200)]);
  expect(suggestedFixed(col)).toEqual(['top', 'right', 'bottom', 'left', 'col']);
  expect(suggestedFixed({ ...col, wallClass: { top: 'changeable', right: 'fixed', left: 'unknown' } })).toEqual(['bottom', 'left', 'col']);
});

it('confirmOpenings: two at once, review cleared; empty or one unknown -> invalid-action; clearReview on a wall and on an opening', () => {
  const b = boxProject();
  const p: Project = {
    ...b,
    existing: { ...b.existing, walls: b.existing.walls.map(w => ({ ...w, review: true })), openings: b.existing.openings.map(o => ({ ...o, review: true, confirmed: false })) },
  };
  const c = ok(p, { type: 'x.confirmOpenings', ids: ['door', 'window'] }).project.existing.openings;
  expect(c.map(o => [o.confirmed, o.review])).toEqual([[true, false], [true, false], [false, true]]);
  expect(why(p, { type: 'x.confirmOpenings', ids: [] })).toBe('invalid-action');
  expect(why(p, { type: 'x.confirmOpenings', ids: ['door', 'nope'] })).toBe('invalid-action');
  expect(ok(p, { type: 'x.clearReview', id: 'part' }).project.existing.walls.find(w => w.id === 'part')!.review).toBe(false);
  expect(ok(p, { type: 'x.clearReview', id: 'entry' }).project.existing.openings.find(o => o.id === 'entry')).toMatchObject({ review: false, confirmed: false });
  expect(why(p, { type: 'x.clearReview', id: 'nope' })).toBe('invalid-action');
});

it('n.setColorLabel and setPlaster: unknown hex, label of 201, plaster "both"', () => {
  const p: Project = { ...boxProject(), sourceColors: [{ hex: '#808080', label: '' }] };
  expect(ok(p, { type: 'n.setColorLabel', hex: '#808080', label: 'walls' }).project.sourceColors).toEqual([{ hex: '#808080', label: 'walls' }]);
  expect(why(p, { type: 'n.setColorLabel', hex: '#000000', label: 'x' })).toBe('invalid-action');
  expect(why(p, { type: 'n.setColorLabel', hex: '#808080', label: 'x'.repeat(201) })).toBe('text-too-long');
  expect(ok(p, { type: 'setPlaster', plaster: 'inWall' }).project.plaster).toBe('inWall');
  expect(why(p, { type: 'setPlaster', plaster: 'both' as never })).toBe('invalid-action');
  expect(why(p, { type: 'setPlaster', plaster: null as never })).toBe('invalid-action');
  expect(why({ ...p, plaster: 'line', approved: true, mamad: 'none' }, { type: 'setPlaster', plaster: null as never })).toBe('invalid-action');
});

it('rooms keep order and ids through a recompute that changes nothing', () => {
  const r = ok(boxProject(), { type: 'x.setWall', id: 'part', thickness: 100 });
  expect(r.project.existing.rooms.map(x => x.id)).toEqual(['room-a', 'room-b']);
  expect(r.notice).toBeUndefined();
});

it.each(['x.bogus', 'constructor', '__proto__', 'toString', 'hasOwnProperty', 'p.moveWall', 'p.restore', 'setFinish', 'approve', 'n.addCloud'])(
  '%s -> invalid-action',
  type => {
    expect(why(boxProject(), { type } as never)).toBe('invalid-action');
  },
);

it('null, a number and an object without a type -> invalid-action', () => {
  for (const a of [null, undefined, 5, 'x.addWall', {}, { type: 5 }]) expect(act(boxProject(), a as never)).toEqual({ ok: false, reason: 'invalid-action' });
});

it('mamad double openings: two doors or two windows share a span on a mamad wall; a third, a door over a window, a passage, or any pair elsewhere -> invalid-geometry', () => {
  const p = mamadOn('room-b');
  const add = (q: Project, wallId: string, offset: number, width: number, kind: 'door' | 'entry' | 'window' | 'passage'): Action => ({ type: 'x.addOpening', wallId, offset, width, kind });
  const two = ok(p, add(p, 'part', 1000, 800, 'door')).project;
  expect(two.existing.openings.filter(o => o.wallId === 'part').map(o => [o.offset, o.width, o.confirmed])).toEqual([[1000, 800, true], [1000, 800, true]]);
  const w1 = ok(p, add(p, 'right', 1000, 1200, 'window')).project;
  const w2 = ok(w1, add(w1, 'right', 1000, 1200, 'window')).project;
  expect(w2.existing.openings.filter(o => o.wallId === 'right')).toHaveLength(2);
  expect(why(two, add(two, 'part', 1200, 400, 'door'))).toBe('invalid-geometry');
  expect(why(w1, add(w1, 'right', 1100, 800, 'door'))).toBe('invalid-geometry');
  expect(why(p, add(p, 'part', 1000, 800, 'passage'))).toBe('invalid-geometry');
  expect(why(p, add(p, 'bottom', 1200, 900, 'door'))).toBe('ok');
  const left = ok(p, add(p, 'left', 1000, 800, 'door')).project;
  expect(why(left, add(left, 'left', 1000, 800, 'door'))).toBe('invalid-geometry');
  expect(why(boxProject(), add(boxProject(), 'part', 1000, 800, 'door'))).toBe('invalid-geometry');
  expect(why(p, add(p, 'part', 1400, 800, 'door'))).toBe('ok');
});

it('mamad double openings after the mark is cleared: the pair stays; moving one of them -> invalid-geometry, other openings still move; rescale keeps both', () => {
  const two = ok(mamadOn('room-b'), { type: 'x.addOpening', wallId: 'part', offset: 1000, width: 800, kind: 'door' }).project;
  const second = two.existing.openings[3].id;
  const plain = unmarked(two);
  expect(plain.existing.openings.filter(o => o.wallId === 'part')).toHaveLength(2);
  expect(why(plain, { type: 'x.setOpening', id: second, offset: 1100 })).toBe('invalid-geometry');
  expect(why(plain, { type: 'x.setOpening', id: second, offset: 2500 })).toBe('ok');
  expect(why(plain, { type: 'x.setOpening', id: 'window', offset: 1200 })).toBe('ok');
  expect(why(plain, { type: 'x.setWall', id: 'part', thickness: 120 })).toBe('ok');
  expect(why(two, { type: 'x.splitWall', id: 'part', at: 3000 })).toBe('mamad-locked');
  const big = ok(two, { type: 'rescale', calibration: { ...two.calibration, mmPerPt: two.calibration.mmPerPt * 2 } }).project;
  expect(big.existing.openings.filter(o => o.wallId === 'part').map(o => [o.offset, o.width])).toEqual([[2000, 1600], [2000, 1600]]);
});

it('splitWall just after a door\'s start moves the door to offset 0 of the second part, and that part stays editable', () => {
  const r = ok(boxProject(), { type: 'x.splitWall', id: 'part', at: 1000.005 }).project;
  const second = r.existing.walls[5].id;
  expect(r.existing.openings.find(o => o.id === 'door')).toMatchObject({ wallId: second, offset: 0 });
  expect(why(r, { type: 'x.addOpening', wallId: second, offset: 900, width: 100, kind: 'door' })).toBe('ok');
  expect(why(r, { type: 'x.setWall', id: second, thickness: 120 })).toBe('ok');
});

it('mamad-locked: the mamad keeps its exact outline; a long thin wall, a shallow poke and a 0.3 mm sliver are refused', () => {
  const b = mamadOn('room-b');
  const cases = [addWall(P(-900000, 2000), P(3700, 2000), 20), addWall(P(-6800, 2000), P(3305, 2000), 20), addWall(P(200, 2000), P(3300.3, 2000))];
  expect(cases.map(a => why(b, a))).toEqual(cases.map(() => 'mamad-locked'));
  expect(cases.map(a => why(unmarked(b), a))).toEqual(cases.map(() => 'ok'));
  const body = (x0: number, x1: number, t: number) => wall('w', x0, 2000, x1, 2000, t);
  expect([body(-900000, 3700, 20), body(-6800, 3305, 20), body(200, 3300.3, 100), body(200, 3200, 100), body(200, 3300, 100), body(200, 3300.005, 100)].map(w => wallEntersMamad(b.existing, w))).toEqual([
    true, true, true, false, false, false,
  ]);
  expect(why(b, addWall(P(200, 2000), P(3200, 2000)))).toBe('ok');
  expect(why(b, addWall(P(200, 2000), P(3250, 2000)))).toBe('ok');
});

it('mamad-locked: a free-standing wall inside the mamad, and any edit that changes its outline', () => {
  const b = mamadOn('room-b');
  expect(why(b, addWall(P(4500, 1500), P(5000, 1500), 200))).toBe('mamad-locked');
  // behind the pre-check: the recompute itself refuses a change of the mamad's outline (a 20 mm wall 10 mm into it)
  const s = { ...b.existing, walls: [...b.existing.walls, wall('stub', 3300, 3000, 3300, 3500, 20)] };
  let thrown: unknown;
  try {
    rebuildExisting(b, s, ['stub']);
  } catch (e) {
    thrown = e;
  }
  expect(thrown).toEqual(new Refused('mamad-locked'));
  // a column in the mamad, moved 50 mm: the same number of holes, another hole
  const col = withWalls(boxProject(), [...boxProject().existing.walls, wall('col', 4500, 2000, 4800, 2000, 200)]);
  const m = mamadOn('room-b', col);
  expect(m.existing.rooms.find(r => r.id === 'room-b')!.holes).toHaveLength(1);
  const moved = { ...m.existing, walls: m.existing.walls.map(w => (w.id === 'col' ? wall('col', 4550, 2000, 4850, 2000, 200) : w)) };
  thrown = undefined;
  try {
    rebuildExisting(m, moved, ['col']);
  } catch (e) {
    thrown = e;
  }
  expect(thrown).toEqual(new Refused('mamad-locked'));
  expect(why(m, { type: 'x.setWall', id: 'col', a: P(4550, 2000) })).toBe('mamad-locked');
});

it('mamad double openings: a double needs half of the narrower width; an opening overlaps one other at most', () => {
  const p = mamadOn('room-b');
  const add = (q: Project, offset: number, width: number): Action => ({ type: 'x.addOpening', wallId: 'part', offset, width, kind: 'door' });
  const bare: Project = { ...p, existing: { ...p.existing, openings: p.existing.openings.filter(o => o.id !== 'door') } };
  const a1 = ok(bare, add(bare, 0, 800)).project;
  const a2 = ok(a1, add(a1, 400, 800)).project;
  expect(why(a2, add(a2, 800, 800))).toBe('invalid-geometry');
  const one = ok(bare, add(bare, 1000, 800)).project;
  expect(why(one, add(one, 1799, 800))).toBe('invalid-geometry');
  expect(why(one, add(one, 1400, 800))).toBe('ok');
  expect(why(one, add(one, 1400.5, 800))).toBe('invalid-geometry');
  expect(why(one, add(one, 1000, 800))).toBe('ok');
  expect(why(one, add(one, 1000, 900))).toBe('ok');
  expect(why(one, add(one, 200, 900))).toBe('invalid-geometry');
  const apart = ok(ok(bare, add(bare, 0, 800)).project, add(bare, 1000, 800)).project;
  expect(why(apart, add(apart, 400, 1000))).toBe('invalid-geometry');
});

// ---- follow-up: only the mamad is locked, not the whole wall (owner) ----
const mamadRoom = (p: Project) => p.existing.rooms.find(r => r.isMamad)!;
const sameOutline = (p: Project, q: Project) => {
  const [r, k] = [mamadRoom(p), mamadRoom(q)];
  expect(k.id).toBe(r.id);
  expect(k.boundary).toHaveLength(r.boundary.length);
  r.boundary.forEach((pt, i) => expect(Math.hypot(pt.x - k.boundary[i].x, pt.y - k.boundary[i].y)).toBeLessThan(0.03));
  expect(k.holes).toHaveLength(r.holes.length);
};
const thrownBy = (f: () => unknown) => {
  try {
    f();
  } catch (e) {
    return e;
  }
  return undefined;
};

it('mamadSpan: where a wall\'s face is the mamad\'s edge, and how far the walls meeting it there reach', () => {
  const p = mamadOn('room-b');
  expect(mamadSpan(p.existing, 'top')).toEqual({ from: 3300, to: 6200, before: 100, after: 200 });
  expect(mamadSpan(p.existing, 'bottom')).toEqual({ from: 200, to: 3100, before: 200, after: 100 });
  expect(mamadSpan(p.existing, 'right')).toEqual({ from: 0, to: 4000, before: 200, after: 200 });
  expect(mamadSpan(p.existing, 'left')).toBeNull();
  expect(mamadSpan(boxProject().existing, 'top')).toBeNull();
});

it('a wall that runs past the mamad: the far end moves along its line and the wall splits outside the span', () => {
  const p = mamadOn('room-b');
  const cases: Action[] = [
    { type: 'x.setWall', id: 'top', a: P(-50, 100) },
    { type: 'x.setWall', id: 'bottom', b: P(-100, 4300) },
    { type: 'x.setWall', id: 'top', a: P(500, 100) },
    { type: 'x.splitWall', id: 'top', at: 3200 },
    { type: 'x.splitWall', id: 'top', at: 1000 },
  ];
  for (const a of cases) sameOutline(p, ok(p, a).project);
  expect(why(p, { type: 'x.splitWall', id: 'top', at: 3200.5 })).toBe('mamad-locked');
});

it('after a split outside the span the far part is an ordinary wall; the near part stays locked', () => {
  const p = ok(mamadOn('room-b'), { type: 'x.splitWall', id: 'top', at: 3200 }).project;
  // the second part follows the first in the list
  const near = p.existing.walls[1].id;
  expect(p.existing.walls[1]).toMatchObject({ a: P(3200, 100), b: P(6400, 100) });
  expect(p.existing.walls.find(w => w.id === 'top')).toMatchObject({ a: P(0, 100), b: P(3200, 100) });
  const far: Action[] = [
    { type: 'x.setWall', id: 'top', a: P(0, 120), b: P(3200, 120) },
    { type: 'x.setWall', id: 'top', thickness: 240 },
    { type: 'x.deleteWall', id: 'top' },
  ];
  expect(far.map(a => why(p, a))).toEqual(['ok', 'ok', 'ok']);
  const nearCases: Action[] = [
    { type: 'x.setWall', id: near, a: P(3200, 120), b: P(6400, 120) },
    { type: 'x.setWall', id: near, thickness: 240 },
    { type: 'x.deleteWall', id: near },
  ];
  expect(nearCases.map(a => why(p, a))).toEqual(nearCases.map(() => 'mamad-locked'));
});

it('still mamad-locked: delete, thicker, thinner, an end off the line, shortening into the span, a split inside it or in its corner joint', () => {
  const p = mamadOn('room-b');
  const cases: Action[] = [
    { type: 'x.deleteWall', id: 'right' },
    { type: 'x.setWall', id: 'right', thickness: 300 },
    { type: 'x.setWall', id: 'right', thickness: 100 },
    { type: 'x.setWall', id: 'top', a: P(0, 105) },
    { type: 'x.setWall', id: 'right', b: P(6305, 4200) },
    { type: 'x.setWall', id: 'top', b: P(6190, 100) },
    { type: 'x.setWall', id: 'bottom', a: P(6090, 4300) },
    { type: 'x.splitWall', id: 'top', at: 4000 },
    { type: 'x.splitWall', id: 'top', at: 3250 },
    { type: 'x.splitWall', id: 'right', at: 100 },
  ];
  expect(cases.map(a => why(p, a))).toEqual(cases.map(() => 'mamad-locked'));
  expect(cases.map(a => why(unmarked(p), a)).filter(r => r !== 'ok')).toEqual([]);
});

it('a short mamad wall extended 1 m past its corner along its line is accepted, and the mamad keeps its outline', () => {
  const p = mamadOn('room-b');
  const r = ok(p, { type: 'x.setWall', id: 'right', a: P(6300, -800) });
  sameOutline(p, r.project);
  expect(why(p, { type: 'x.setWall', id: 'right', a: P(6300, -800), thickness: 220 })).toBe('mamad-locked');
});

it('a mamad span in the middle of a wall: splits and ends outside it pass, inside it and in the joints do not', () => {
  const walls = [wall('top', 0, 100, 9600, 100, 200), wall('right', 9500, 200, 9500, 4200, 200), wall('bottom', 9600, 4300, 0, 4300, 200), wall('left', 100, 4200, 100, 200, 200), wall('p1', 3250, 200, 3250, 4200, 100), wall('p2', 6350, 200, 6350, 4200, 100)];
  const s: State = { walls, openings: [], separators: [], rooms: [] };
  s.rooms = computeRooms(s, []).rooms.map(r => ({ ...r, inApartment: true }));
  const middle = s.rooms.find(r => r.boundary.some(q => q.x === 3300 && q.y === 200))!;
  const p = mamadOn(middle.id, { ...boxProject(), existing: s });
  expect(mamadSpan(p.existing, 'top')).toEqual({ from: 3300, to: 6300, before: 100, after: 100 });
  const yes: Action[] = [
    { type: 'x.splitWall', id: 'top', at: 3200 },
    { type: 'x.splitWall', id: 'top', at: 6400 },
    { type: 'x.setWall', id: 'top', a: P(-500, 100), b: P(10000, 100) },
    { type: 'x.setWall', id: 'top', a: P(3200, 100) },
  ];
  for (const a of yes) sameOutline(p, ok(p, a).project);
  const no: Action[] = [
    { type: 'x.splitWall', id: 'top', at: 3250 },
    { type: 'x.splitWall', id: 'top', at: 4000 },
    { type: 'x.splitWall', id: 'top', at: 6350 },
    { type: 'x.setWall', id: 'top', a: P(3300, 100) },
    { type: 'x.setWall', id: 'top', a: P(3310, 100) },
    { type: 'x.setWall', id: 'top', b: P(6290, 100) },
  ];
  expect(no.map(a => why(p, a))).toEqual(no.map(() => 'mamad-locked'));
});

it('the guard after the recompute: a mamad wall thickened outward keeps the inside face and is still refused; a split part counts as the wall', () => {
  const p = mamadOn('room-b');
  const thick = { ...p.existing, walls: p.existing.walls.map(w => (w.id === 'right' ? wall('right', 6350, 200, 6350, 4200, 300) : w)) };
  expect(thrownBy(() => rebuildExisting(p, thick, ['right']))).toEqual(new Refused('mamad-locked'));
  const thin = { ...p.existing, walls: p.existing.walls.map(w => (w.id === 'right' ? wall('right', 6250, 200, 6250, 4200, 100) : w)) };
  expect(thrownBy(() => rebuildExisting(p, thin, ['right']))).toEqual(new Refused('mamad-locked'));
  const renamed = { ...p.existing, walls: p.existing.walls.map(w => (w.id === 'right' ? wall('r2', 6300, 200, 6300, 4200, 200) : w)) };
  expect(thrownBy(() => rebuildExisting(p, renamed, ['r2']))).toBeUndefined();
});

it('a hidden duplicate under a mamad wall: the same body is locked, a thinner one inside it may go', () => {
  const two = withWalls(boxProject(), [...boxProject().existing.walls, wall('part2', 3250, 200, 3250, 4200, 100), wall('inner', 3250, 200, 3250, 4200, 60)]);
  const p = mamadOn('room-b', two);
  expect(why(p, { type: 'x.deleteWall', id: 'part2' })).toBe('mamad-locked');
  sameOutline(p, ok(p, { type: 'x.deleteWall', id: 'inner' }).project);
});

it('mamadAllows and mamadWallsKept on their own: the pre-check and the guard each refuse without the other', () => {
  const p = mamadOn('room-b');
  const s = p.existing;
  const top = s.walls[0];
  const right = s.walls[1];
  expect(mamadAllows.set(s, top, { ...top, b: P(6190, 100) })).toBe(false);
  expect(mamadAllows.set(s, top, { ...top, a: P(3310, 100) })).toBe(false);
  expect(mamadAllows.set(s, right, { ...right, thickness: 220 })).toBe(false);
  expect(mamadAllows.set(s, top, { ...top, a: P(-50, 100) })).toBe(true);
  const swap = (w: Wall) => ({ ...s, walls: s.walls.map(x => (x.id === w.id ? w : x)) });
  expect(mamadWallsKept(s, swap({ ...right, thickness: 220 }))).toBe(false);
  expect(mamadWallsKept(s, swap({ ...right, a: P(6300, -800) }))).toBe(true);
  const pieces = { ...s, walls: [...s.walls.filter(w => w.id !== 'top'), wall('t1', 0, 100, 4000, 100, 200), wall('t2', 4010, 100, 6400, 100, 200)] };
  expect(mamadWallsKept(s, pieces)).toBe(false);
  const joined = { ...s, walls: [...s.walls.filter(w => w.id !== 'top'), wall('t1', 0, 100, 4000, 100, 200), wall('t2', 4000, 100, 6400, 100, 200)] };
  expect(mamadWallsKept(s, joined)).toBe(true);
});

// ---- follow-up fix round 1: the corner joint, keepName, a wall along a mamad wall ----
const noWindow = (p: Project): Project => ({ ...p, existing: { ...p.existing, openings: p.existing.openings.filter(o => o.id !== 'window') } });

it("the mamad's corner joint stays covered: an end may not move into it", () => {
  const p = noWindow(mamadOn('room-b'));
  const top = (x: number): Action => ({ type: 'x.setWall', id: 'top', a: P(x, 100) });
  expect([top(3300), top(3250), top(3201)].map(a => why(p, a))).toEqual(['mamad-locked', 'mamad-locked', 'mamad-locked']);
  sameOutline(p, ok(p, top(3200)).project);
  sameOutline(p, ok(p, top(500)).project);
  expect(why(p, { type: 'x.setWall', id: 'right', b: P(6300, 4150) })).toBe('mamad-locked');
  expect(why(p, { type: 'x.setWall', id: 'right', b: P(6300, 5000) })).toBe('ok');
});

it('split at the margin, in either order: the near part covers the joint and stays locked, the far part may go', () => {
  const p = noWindow(mamadOn('room-b'));
  const split = ok(p, { type: 'x.splitWall', id: 'top', at: 3200 }).project;
  const near = split.existing.walls[1].id;
  const moveNear: Action = { type: 'x.setWall', id: near, a: P(3300, 100) };
  expect(why(split, moveNear)).toBe('mamad-locked');
  expect(why(split, { type: 'x.deleteWall', id: near })).toBe('mamad-locked');
  const farGone = ok(split, { type: 'x.deleteWall', id: 'top' }).project;
  sameOutline(p, farGone);
  expect(why(farGone, moveNear)).toBe('mamad-locked');
  expect(why(farGone, { type: 'x.deleteWall', id: near })).toBe('mamad-locked');
});

it('mamadWallsKept asks for the corner joints too', () => {
  const p = mamadOn('room-b');
  const s = p.existing;
  const shorter = { ...s, walls: s.walls.map(w => (w.id === 'top' ? { ...w, a: P(3300, 100) } : w)) };
  expect(mamadWallsKept(s, shorter)).toBe(false);
  expect(mamadAllows.set(s, s.walls[0], { ...s.walls[0], a: P(3300, 100) })).toBe(false);
  const atMargin = { ...s, walls: s.walls.map(w => (w.id === 'top' ? { ...w, a: P(3200, 100) } : w)) };
  expect(mamadWallsKept(s, atMargin)).toBe(true);
});

it('no wall along a mamad wall: the far part laid over the near part, or a wall inside the mamad wall, is refused', () => {
  const p = noWindow(mamadOn('room-b'));
  const split = ok(p, { type: 'x.splitWall', id: 'top', at: 3200 }).project;
  expect(why(split, { type: 'x.setWall', id: 'top', b: P(4500, 100) })).toBe('mamad-locked');
  expect(why(split, { type: 'x.setWall', id: 'top', b: P(3100, 100) })).toBe('ok');
  expect(why(p, addWall(P(4000, 100), P(5000, 100)))).toBe('mamad-locked');
  expect(why(p, addWall(P(6300, 1000), P(6300, 1500)))).toBe('mamad-locked');
  expect(why(unmarked(split), { type: 'x.setWall', id: 'top', b: P(4500, 100) })).toBe('ok');
});

it('still allowed next to a mamad wall: a T from the neighbour, a diagonal to its outer corner, a wall laid against its outer face', () => {
  const p = mamadOn('room-b');
  const cases = [addWall(P(200, 2000), P(3250, 2000)), addWall(P(7400, -1000), P(6400, 0)), addWall(P(6500, 1000), P(6500, 3000), 200), addWall(P(4000, -100), P(5000, -100), 200)];
  for (const a of cases) sameOutline(p, ok(p, a).project);
});

// ---- follow-up fix round 2: lay judges what an edit adds ----
it('a wall that already overlaps a mamad wall\'s joint stays editable; only a grown overlap is refused', () => {
  const base = boxProject();
  const walls = [
    ...base.existing.walls.filter(w => w.id !== 'top'),
    wall('top-a', 0, 100, 3300, 100, 200),
    wall('top-b', 3200, 100, 6400, 100, 200),
  ];
  const plain: Project = { ...base, existing: { ...base.existing, openings: base.existing.openings.filter(o => o.wallId !== 'top') } };
  const p = mamadOn('room-b', withWalls(plain, walls));
  expect(wallBoundsMamad(p.existing, 'top-a')).toBe(false);
  sameOutline(p, ok(p, { type: 'x.setWall', id: 'top-a', a: P(-50, 100) }).project);
  sameOutline(p, ok(p, { type: 'x.setWall', id: 'top-a', thickness: 220 }).project);
  expect(why(p, { type: 'x.setWall', id: 'top-a', b: P(3400, 100) })).toBe('mamad-locked');
  expect(why(p, { type: 'x.deleteWall', id: 'top-a' })).toBe('ok');
  // a thinner wall on the joint, thickened: its overlap grows, refused
  const thin = mamadOn('room-b', withWalls(plain, walls.map(w => (w.id === 'top-a' ? { ...w, thickness: 100 } : w))));
  expect(why(thin, { type: 'x.setWall', id: 'top-a', thickness: 200 })).toBe('mamad-locked');
  expect(why(p, addWall(P(3250, 100), P(3400, 100), 200))).toBe('mamad-locked');
});
