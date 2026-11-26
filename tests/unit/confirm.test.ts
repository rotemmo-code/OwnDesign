import { expect, it } from 'vitest';
import { apply, Refused } from '../../src/model/apply';
import { rebuildExisting } from '../../src/model/existing';
import { createHistory } from '../../src/model/history';
import { computeRooms } from '../../src/model/rooms';
import { confirmationGaps, envelopeAllows, envelopeKept, envelopeSpans } from '../../src/model/rules';
import { ProjectSchema } from '../../src/model/schema';
import type { Action, Opening, Project, Pt, Result, State, Wall } from '../../src/model/types';
import { boxProject, wall } from '../fixtures/box';

const P = (x: number, y: number): Pt => ({ x, y });
function act(p: Project, a: Action): Result {
  const before = structuredClone(p);
  const r = apply(p, a);
  expect(p).toEqual(before);
  if (r.ok) expect(ProjectSchema.safeParse(r.project).success).toBe(true);
  return r;
}
const ok = (p: Project, a: Action) => {
  const r = act(p, a);
  if (!r.ok) throw new Error(`${a.type} refused: ${r.reason}`);
  return r.project;
};
const why = (p: Project, a: Action) => {
  const r = act(p, a);
  return r.ok ? 'ok' : r.reason;
};
const thrownBy = (f: () => unknown) => {
  try {
    f();
  } catch (e) {
    return e;
  }
  return undefined;
};
const freeEnvelope = (p: Project) => ok(p, { type: 'x.releaseEnvelope' });
const opening = (p: Project, id: string) => p.existing.openings.find(o => o.id === id)!;
const spans = (s: State, id: string) => envelopeSpans(s, id).map(k => [k.from, k.to, k.before, k.after]);
/** Where an opening starts and ends on the page. */
const place = (s: State, o: Opening) => {
  const w = s.walls.find(x => x.id === o.wallId)!;
  const l = Math.hypot(w.b.x - w.a.x, w.b.y - w.a.y);
  const at = (t: number) => [w.a.x + ((w.b.x - w.a.x) * t) / l, w.a.y + ((w.b.y - w.a.y) * t) / l].map(v => Math.round(v * 1000) / 1000);
  return [...at(o.offset), ...at(o.offset + o.width)];
};
const withRooms = (p: Project, change: (s: State) => State): Project => {
  const s = change(p.existing);
  return { ...p, existing: { ...s, rooms: computeRooms(s, p.existing.rooms).rooms } };
};

it('envelopeSpans: top 200-3200 and 3300-6200 with its corner joints, right 0-4000, the partition none', () => {
  const s = boxProject().existing;
  expect(spans(s, 'top')).toEqual([[200, 3200, 200, 100], [3300, 6200, 100, 200]]);
  expect(spans(s, 'right')).toEqual([[0, 4000, 200, 200]]);
  expect(spans(s, 'part')).toEqual([]);
});

it('envelopeSpans with room B outside the apartment: top only over A, the partition becomes an outer wall, right none', () => {
  const s: State = { ...boxProject().existing, rooms: boxProject().existing.rooms.map(r => (r.id === 'room-b' ? { ...r, inApartment: false } : r)) };
  expect(spans(s, 'top')).toEqual([[200, 3200, 200, 100]]);
  expect(spans(s, 'part')).toEqual([[0, 4000, 200, 200]]);
  expect(spans(s, 'right')).toEqual([]);
});

it('windows, the entry door and openings on mamad walls are locked from the start; an inner door is free', () => {
  const p = boxProject();
  expect(why(p, { type: 'x.setOpening', id: 'window', offset: 1000 })).toBe('window-locked');
  expect(why(p, { type: 'x.deleteOpening', id: 'window' })).toBe('window-locked');
  expect(why(p, { type: 'x.setOpening', id: 'entry', width: 1000 })).toBe('entry-door-locked');
  expect(why(p, { type: 'x.deleteOpening', id: 'entry' })).toBe('entry-door-locked');
  expect(why(p, { type: 'x.setOpening', id: 'door', offset: 1100 })).toBe('ok');
  const m = ok(p, { type: 'setMamad', room: 'room-b' });
  expect(why(m, { type: 'x.setOpening', id: 'door', offset: 1100 })).toBe('mamad-locked');
  expect(why(m, { type: 'x.deleteOpening', id: 'door' })).toBe('mamad-locked');
});

it('adding is not moving: a new window or entry door, also a mamad double, is allowed and locked at once', () => {
  const p = boxProject();
  const w = ok(p, { type: 'x.addOpening', wallId: 'right', offset: 1000, width: 1200, kind: 'window' });
  const id = w.existing.openings[3].id;
  expect(opening(w, id)).toMatchObject({ confirmed: true });
  expect(opening(w, id).released).toBeUndefined();
  expect(why(w, { type: 'x.setOpening', id, offset: 900 })).toBe('window-locked');
  const e = ok(p, { type: 'x.addOpening', wallId: 'left', offset: 1000, width: 900, kind: 'entry' });
  expect(why(e, { type: 'x.deleteOpening', id: e.existing.openings[3].id })).toBe('entry-door-locked');
  const m = ok(p, { type: 'setMamad', room: 'room-b' });
  const two = ok(m, { type: 'x.addOpening', wallId: 'part', offset: 1000, width: 800, kind: 'door' });
  expect(why(two, { type: 'x.setOpening', id: two.existing.openings[3].id, width: 700 })).toBe('mamad-locked');
});

it('release, correct, confirm: release unlocks and unconfirms, confirm locks again; three undo steps', () => {
  const p = boxProject();
  const h = createHistory();
  h.push(p);
  const r = ok(p, { type: 'x.releaseOpenings', ids: ['window'] });
  h.push(r);
  expect(opening(r, 'window')).toMatchObject({ released: true, confirmed: false });
  const c = ok(r, { type: 'x.setOpening', id: 'window', offset: 1000 });
  h.push(c);
  const done = ok(c, { type: 'x.confirmOpenings', ids: ['window'] });
  h.push(done);
  expect(opening(done, 'window').released).toBeUndefined();
  expect(opening(done, 'window')).toMatchObject({ offset: 1000, confirmed: true });
  expect(why(done, { type: 'x.setOpening', id: 'window', offset: 1100 })).toBe('window-locked');
  expect([h.undo(), h.undo(), h.undo()]).toEqual([c, r, p]);
});

it('x.releaseOpenings: empty or unknown -> invalid-action; after approval -> existing-approved', () => {
  const p = boxProject();
  expect(why(p, { type: 'x.releaseOpenings', ids: [] })).toBe('invalid-action');
  expect(why(p, { type: 'x.releaseOpenings', ids: ['window', 'nope'] })).toBe('invalid-action');
  const approved: Project = { ...p, approved: true, mamad: 'none' };
  expect(['x.releaseOpenings', 'x.releaseEnvelope', 'x.confirmEnvelope'].map(type => why(approved, { type, ids: ['window'] } as never))).toEqual([
    'existing-approved', 'existing-approved', 'existing-approved',
  ]);
});

it('kind changes: an inner door made a window is locked at once; a released window made a door stays released and editable', () => {
  const p = boxProject();
  const w = ok(p, { type: 'x.setOpening', id: 'door', kind: 'window' });
  expect(why(w, { type: 'x.setOpening', id: 'door', offset: 1100 })).toBe('window-locked');
  const e = ok(p, { type: 'x.setOpening', id: 'door', kind: 'entry' });
  expect(why(e, { type: 'x.setOpening', id: 'door', offset: 1100 })).toBe('entry-door-locked');
  const r = ok(ok(p, { type: 'x.releaseOpenings', ids: ['window'] }), { type: 'x.setOpening', id: 'window', kind: 'door' });
  expect(opening(r, 'window')).toMatchObject({ kind: 'door', released: true });
  expect(why(r, { type: 'x.setOpening', id: 'window', offset: 1000 })).toBe('ok');
  expect(confirmationGaps(r)).toContain('released');
});

it('clearing the mamad mark frees the doors on its former walls; its windows stay locked as windows', () => {
  const m = ok(ok(boxProject(), { type: 'setMamad', room: 'room-b' }), { type: 'x.addOpening', wallId: 'right', offset: 1000, width: 1200, kind: 'window' });
  const win = m.existing.openings[3].id;
  expect(why(m, { type: 'x.setOpening', id: win, offset: 900 })).toBe('mamad-locked');
  const plain = ok(m, { type: 'setMamad', room: null });
  expect(why(plain, { type: 'x.setOpening', id: 'door', offset: 1100 })).toBe('ok');
  expect(why(plain, { type: 'x.setOpening', id: win, offset: 900 })).toBe('window-locked');
});

it('the wall of a locked window: delete, a line or thickness change refused; its far end along the line and a split elsewhere allowed, the window in place', () => {
  const p = freeEnvelope(boxProject());
  expect(why(p, { type: 'x.deleteWall', id: 'top' })).toBe('window-locked');
  expect(why(p, { type: 'x.setWall', id: 'top', thickness: 220 })).toBe('window-locked');
  expect(why(p, { type: 'x.setWall', id: 'top', a: P(0, 105) })).toBe('window-locked');
  expect(why(p, { type: 'x.deleteWall', id: 'bottom' })).toBe('entry-door-locked');
  const was = place(p.existing, opening(p, 'window'));
  for (const a of [{ type: 'x.setWall', id: 'top', a: P(-50, 100) }, { type: 'x.splitWall', id: 'top', at: 3000 }] as Action[]) {
    const q = ok(p, a);
    expect(place(q.existing, opening(q, 'window'))).toEqual(was);
  }
  const free = ok(p, { type: 'x.releaseOpenings', ids: ['window'] });
  expect(why(free, { type: 'x.setWall', id: 'top', thickness: 220 })).toBe('ok');
});

it('the envelope is locked from the start: delete, thickness, off its line, a split -> envelope-locked; released they pass; confirm locks again', () => {
  const p = boxProject();
  const cases: Action[] = [
    { type: 'x.deleteWall', id: 'right' },
    { type: 'x.setWall', id: 'right', thickness: 300 },
    { type: 'x.setWall', id: 'right', thickness: 100 },
    { type: 'x.setWall', id: 'right', b: P(6305, 4200) },
    { type: 'x.setWall', id: 'right', b: P(6300, 4150) },
    { type: 'x.splitWall', id: 'right', at: 2000 },
    { type: 'x.splitWall', id: 'left', at: 100 },
  ];
  expect(cases.map(a => why(p, a))).toEqual(cases.map(() => 'envelope-locked'));
  const free = freeEnvelope(p);
  expect(free.envelope).toBe('released');
  expect(cases.map(a => why(free, a))).toEqual(cases.map(() => 'ok'));
  const again = ok(free, { type: 'x.confirmEnvelope' });
  expect(again.envelope).toBe('confirmed');
  expect(cases.map(a => why(again, a))).toEqual(cases.map(() => 'envelope-locked'));
  expect(why(p, { type: 'x.setWall', id: 'right', b: P(6300, 5000) })).toBe('ok');
});

it('still allowed with the envelope locked: an inner wall to an outer face, deleting the partition, a door on an outer wall, a finish, a new window', () => {
  const p = boxProject();
  const allowed: Action[] = [
    { type: 'x.addWall', a: P(200, 2000), b: P(3200, 2000), thickness: 100 },
    { type: 'x.addWall', a: P(200, 2000), b: P(3250, 2000), thickness: 100 },
    { type: 'x.deleteWall', id: 'part' },
    { type: 'x.addOpening', wallId: 'right', offset: 2000, width: 800, kind: 'door' },
    { type: 'x.addOpening', wallId: 'right', offset: 500, width: 1200, kind: 'window' },
    { type: 'setFinish', state: 'existing', wallId: 'right', side: 'B', mm: 20 },
  ];
  expect(allowed.map(a => why(p, a))).toEqual(allowed.map(() => 'ok'));
  const door = ok(p, allowed[3]);
  expect(why(door, { type: 'x.setOpening', id: door.existing.openings[3].id, offset: 2100 })).toBe('ok');
  const back = ok(ok(p, { type: 'x.deleteWall', id: 'part' }), { type: 'x.addWall', a: P(3250, 200), b: P(3250, 4200), thickness: 100 });
  expect(back.existing.rooms).toHaveLength(2);
});

it('an inner wall does not become outer, nor an outer one inner: x.setRoom flips -> envelope-locked; released they pass', () => {
  const p = boxProject();
  const flips: Action[] = [
    { type: 'x.setRoom', id: 'room-b', inApartment: false },
    { type: 'x.setRoom', id: 'room-a', outdoor: true },
  ];
  expect(flips.map(a => why(p, a))).toEqual(['envelope-locked', 'envelope-locked']);
  expect(why(p, { type: 'x.setRoom', id: 'room-a', name: 'Living' })).toBe('ok');
  const free = freeEnvelope(p);
  expect(flips.map(a => why(free, a))).toEqual(['ok', 'ok']);
  const out = ok(ok(free, flips[0]), { type: 'x.confirmEnvelope' });
  expect(why(out, { type: 'x.setRoom', id: 'room-b', inApartment: true })).toBe('envelope-locked');
});

it('room B outside the apartment: only top over A and its joints are locked; top splits at 3300 and its part over B is editable', () => {
  const p = ok(ok(freeEnvelope(boxProject()), { type: 'x.setRoom', id: 'room-b', inApartment: false }), { type: 'x.confirmEnvelope' });
  expect(why(p, { type: 'x.splitWall', id: 'top', at: 3250 })).toBe('envelope-locked');
  const split = ok(p, { type: 'x.splitWall', id: 'top', at: 3300 });
  const far = split.existing.walls[1].id;
  expect(why(split, { type: 'x.setWall', id: far, thickness: 220 })).toBe('ok');
  expect(why(split, { type: 'x.deleteWall', id: 'right' })).toBe('ok');
  expect(why(split, { type: 'x.deleteWall', id: 'part' })).toBe('envelope-locked');
});

it('the guard on its own: an outer wall thickened outward keeps its inside face and is refused; a closed shaft under 0.25 m2 makes outer walls', () => {
  const p = boxProject();
  const thick = { ...p.existing, walls: p.existing.walls.map(w => (w.id === 'right' ? wall('right', 6350, 200, 6350, 4200, 300) : w)) };
  expect(thrownBy(() => rebuildExisting(p, thick, ['right']))).toEqual(new Refused('envelope-locked'));
  expect(envelopeKept(p.existing, thick.walls === p.existing.walls ? p.existing : { ...thick, rooms: computeRooms(thick, p.existing.rooms).rooms })).toBe(false);
  const shaft: [number, number, number, number][] = [[1000, 1000, 1400, 1000], [1400, 1000, 1400, 1400], [1400, 1400, 1000, 1400], [1000, 1400, 1000, 1000]];
  let q = p;
  const answers = shaft.map(([x0, y0, x1, y1]) => {
    const r = act(q, { type: 'x.addWall', a: P(x0, y0), b: P(x1, y1), thickness: 100 });
    if (r.ok) q = r.project;
    return r.ok ? 'ok' : r.reason;
  });
  expect(answers).toEqual(['ok', 'ok', 'ok', 'envelope-locked']);
});

it('a column standing on an outer wall\'s inner face: added and removed with the envelope locked', () => {
  const p = boxProject();
  const col = ok(p, { type: 'x.addWall', a: P(1150, 200), b: P(1150, 500), thickness: 300 });
  const id = col.existing.walls[5].id;
  expect(spans(col.existing, 'top').length).toBe(3);
  expect(why(col, { type: 'x.deleteWall', id })).toBe('ok');
});

it('an envelope bounded by a separator: a balcony cut off room A by a line; the line and the flag are locked with the envelope', () => {
  const free = freeEnvelope(boxProject());
  const cut = ok(free, { type: 'x.addSeparator', a: P(200, 3000), b: P(3200, 3000) });
  const balcony = cut.existing.rooms[2].id;
  const p = ok(ok(cut, { type: 'x.setRoom', id: balcony, outdoor: true }), { type: 'x.confirmEnvelope' });
  expect(spans(p.existing, 'part').length).toBe(1);
  expect(why(p, { type: 'x.deleteSeparator', id: p.existing.separators[0].id })).toBe('envelope-locked');
  expect(why(p, { type: 'x.setRoom', id: balcony, outdoor: false })).toBe('envelope-locked');
  expect(why(freeEnvelope(p), { type: 'x.deleteSeparator', id: p.existing.separators[0].id })).toBe('ok');
});

it('rescale with everything locked: accepted, the released flags and the envelope state kept', () => {
  const p = ok(ok(boxProject(), { type: 'x.releaseOpenings', ids: ['door'] }), { type: 'x.releaseEnvelope' });
  const r = ok(p, { type: 'rescale', calibration: { ...p.calibration, mmPerPt: p.calibration.mmPerPt * 2 } });
  expect([r.envelope, opening(r, 'door').released, opening(r, 'window').released]).toEqual(['released', true, undefined]);
  const locked = ok(boxProject(), { type: 'rescale', calibration: { ...p.calibration, mmPerPt: p.calibration.mmPerPt * 2 } });
  expect(locked.envelope).toBeUndefined();
});

it('a mamad wall that is also an outer wall: mamad-locked comes first', () => {
  const m = ok(boxProject(), { type: 'setMamad', room: 'room-b' });
  expect(why(m, { type: 'x.deleteWall', id: 'right' })).toBe('mamad-locked');
  expect(why(m, { type: 'x.setWall', id: 'right', thickness: 300 })).toBe('mamad-locked');
});

it('x.confirmEnvelope needs an indoor room', () => {
  const none = { ...boxProject(), existing: { ...boxProject().existing, rooms: boxProject().existing.rooms.map(r => ({ ...r, inApartment: false })) } };
  expect(why(none, { type: 'x.confirmEnvelope' })).toBe('invalid-action');
  expect(why(boxProject(), { type: 'x.confirmEnvelope' })).toBe('ok');
});

it('confirmationGaps: what approval still waits for', () => {
  const p = boxProject();
  expect(confirmationGaps(p)).toEqual(['envelope-unconfirmed']);
  const unconfirmed: Project = { ...p, existing: { ...p.existing, openings: p.existing.openings.map(o => (o.id === 'window' ? { ...o, confirmed: false } : o)) } };
  expect(confirmationGaps(unconfirmed)).toEqual(['envelope-unconfirmed', 'opening-unconfirmed']);
  const released = ok(ok(p, { type: 'x.releaseEnvelope' }), { type: 'x.releaseOpenings', ids: ['door'] });
  expect(confirmationGaps(released)).toEqual(['released', 'envelope-unconfirmed', 'opening-unconfirmed']);
  expect(confirmationGaps(ok(p, { type: 'x.confirmEnvelope' }))).toEqual([]);
  // an opening on a wall with no apartment room on either side does not count
  const outside = withRooms(p, s => ({ ...s, walls: [...s.walls, wall('far', 20000, 0, 24000, 0, 200)], openings: [...s.openings, { id: 'o9', wallId: 'far', offset: 100, width: 800, kind: 'door', review: false, confirmed: false }] }));
  expect(confirmationGaps(ok(outside, { type: 'x.confirmEnvelope' }))).toEqual([]);
});

it('a wall laid back to back against an outer wall from outside does not take the outer wall out of the envelope', () => {
  const p = boxProject();
  const twin = ok(p, { type: 'x.addWall', a: P(6500, 200), b: P(6500, 4200), thickness: 200 });
  expect(spans(twin.existing, 'right')).toEqual([[0, 4000, 200, 200]]);
  expect(why(twin, { type: 'x.deleteWall', id: 'right' })).toBe('envelope-locked');
});

it("a balcony's own walls are outer walls even where nothing lies beyond them", () => {
  const s: State = { ...boxProject().existing, rooms: boxProject().existing.rooms.map(r => (r.id === 'room-b' ? { ...r, outdoor: true } : r)) };
  expect(spans(s, 'right')).toEqual([[0, 4000, 200, 200]]);
  expect(spans(s, 'part')).toEqual([[0, 4000, 200, 200]]);
});

it('envelopeAllows on its own: the pre-checks refuse without the guard', () => {
  const s = boxProject().existing;
  const right = s.walls[1];
  expect(envelopeAllows.delete(s, 'right')).toBe(false);
  expect(envelopeAllows.delete(s, 'part')).toBe(true);
  expect(envelopeAllows.set(s, right, { ...right, thickness: 300 })).toBe(false);
  expect(envelopeAllows.set(s, right, { ...right, b: P(6300, 4150) })).toBe(false);
  expect(envelopeAllows.set(s, right, { ...right, b: P(6300, 5000) })).toBe(true);
  expect(envelopeAllows.lay(s, wall('n', 6300, 1000, 6300, 2000, 100))).toBe(false);
  expect(envelopeAllows.lay(s, wall('n', 6500, 1000, 6500, 2000, 200))).toBe(true);
  expect(envelopeAllows.split(s, 'right', 2000)).toBe(false);
  expect(envelopeAllows.split(s, 'part', 2000)).toBe(true);
});

// ---- fix round 1 ----
it('a lining against an outer wall\'s inside face is an ordinary inner edit: added and removed with the envelope locked', () => {
  const p = boxProject();
  const linings: Action[] = [
    { type: 'x.addWall', a: P(1000, 225), b: P(2000, 225), thickness: 50 },
    { type: 'x.addWall', a: P(6170, 1000), b: P(6170, 3000), thickness: 60 },
    { type: 'x.addWall', a: P(250, 4150), b: P(1500, 4150), thickness: 100 },
    { type: 'x.addWall', a: P(4000, 230), b: P(4600, 230), thickness: 60 },
  ];
  for (const a of linings) {
    const q = ok(p, a);
    const id = q.existing.walls[q.existing.walls.length - 1].id;
    expect(why(q, { type: 'x.deleteWall', id })).toBe('ok');
    expect(why(q, { type: 'x.setWall', id, thickness: 40 })).toBe('ok');
  }
});

it('behind a lining the outer wall itself stays locked', () => {
  const q = ok(ok(boxProject(), { type: 'x.releaseOpenings', ids: ['window'] }), { type: 'x.addWall', a: P(1000, 225), b: P(2000, 225), thickness: 50 });
  expect(why(q, { type: 'x.deleteWall', id: 'top' })).toBe('envelope-locked');
  expect(why(q, { type: 'x.setWall', id: 'top', thickness: 220 })).toBe('envelope-locked');
  expect(why(q, { type: 'x.setWall', id: 'top', a: P(0, 105) })).toBe('envelope-locked');
  expect(why(q, { type: 'x.splitWall', id: 'top', at: 1500 })).toBe('envelope-locked');
});

it('a lining inside the mamad is an inner wall in the mamad; one on the neighbour\'s side of a mamad wall is fine', () => {
  const a = ok(boxProject(), { type: 'setMamad', room: 'room-a' });
  expect(why(a, { type: 'x.addWall', a: P(1000, 225), b: P(2000, 225), thickness: 50 })).toBe('mamad-locked');
  const b = ok(boxProject(), { type: 'setMamad', room: 'room-b' });
  const q = ok(b, { type: 'x.addWall', a: P(3175, 1000), b: P(3175, 2000), thickness: 50 });
  expect(why(q, { type: 'x.deleteWall', id: q.existing.walls[5].id })).toBe('ok');
});

it('apply refuses a wall laid along an outer wall\'s body, added or moved there (the pre-check is the only protection)', () => {
  const p = boxProject();
  expect(why(p, { type: 'x.addWall', a: P(1000, 0), b: P(2000, 0), thickness: 200 })).toBe('envelope-locked');
  expect(why(p, { type: 'x.addWall', a: P(6300, 1000), b: P(6300, 2000), thickness: 100 })).toBe('envelope-locked');
  const far = ok(p, { type: 'x.addWall', a: P(1000, -1500), b: P(2000, -1500), thickness: 200 });
  const id = far.existing.walls[5].id;
  expect(why(far, { type: 'x.setWall', id, a: P(1000, 0), b: P(2000, 0) })).toBe('envelope-locked');
  expect(why(freeEnvelope(far), { type: 'x.setWall', id, a: P(1000, 0), b: P(2000, 0) })).toBe('ok');
  const rel = ok(p, { type: 'x.releaseOpenings', ids: ['window'] });
  expect(why(rel, { type: 'x.splitWall', id: 'top', at: 1500 })).toBe('envelope-locked');
  expect(why(rel, { type: 'x.setWall', id: 'top', a: P(150, 100) })).toBe('envelope-locked');
});

it('the outer leaf: a wall with no indoor room beside it laid against the facade is locked with the envelope', () => {
  const p = boxProject();
  const leaf = ok(p, { type: 'x.addWall', a: P(1000, -25), b: P(2000, -25), thickness: 50 });
  const id = leaf.existing.walls[5].id;
  const edits: Action[] = [
    { type: 'x.deleteWall', id },
    { type: 'x.setWall', id, thickness: 40 },
    { type: 'x.setWall', id, a: P(500, -25) },
    { type: 'x.splitWall', id, at: 500 },
  ];
  expect(edits.map(a => why(leaf, a))).toEqual(edits.map(() => 'envelope-locked'));
  expect(edits.map(a => why(freeEnvelope(leaf), a))).toEqual(edits.map(() => 'ok'));
  const away = ok(p, { type: 'x.addWall', a: P(1000, -500), b: P(2000, -500), thickness: 50 });
  expect(why(away, { type: 'x.deleteWall', id: away.existing.walls[5].id })).toBe('ok');
});
