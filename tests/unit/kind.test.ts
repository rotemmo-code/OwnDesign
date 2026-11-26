import { expect, it } from 'vitest';
import { isExterior, isInside, wallKind } from '../../src/model/kind';
import { computeRooms } from '../../src/model/rooms';
import type { State, Status } from '../../src/model/types';
import { boxApartment, wall } from '../fixtures/box';

/** The box apartment after a change. */
const box = (change: (s: State) => unknown = () => {}): State => {
  const s = boxApartment();
  change(s);
  return s;
};
const room = (s: State, id: string) => s.rooms.find(r => r.id === id)!;
const kinds = (s: State) => Object.fromEntries(s.walls.map(w => [w.id, wallKind(s, w.id)]));
const outer = { top: 'exterior', right: 'exterior', bottom: 'exterior', left: 'exterior' };

it('box apartment: the four outer walls are exterior, the partition is existing', () => {
  expect(kinds(box())).toEqual({ ...outer, part: 'existing' });
});

it('before any room is marked as the apartment every wall is existing', () => {
  const s = box(s => s.rooms.forEach(r => (r.inApartment = false)));
  expect(new Set(Object.values(kinds(s)))).toEqual(new Set(['existing']));
});

it('marking room B as the mamad makes its four walls mamad, the partition included', () => {
  const s = box(s => (room(s, 'room-b').isMamad = true));
  expect(kinds(s)).toEqual({ top: 'mamad', right: 'mamad', bottom: 'mamad', left: 'exterior', part: 'mamad' });
});

it('precedence: removed, added, moved, mamad, exterior, existing', () => {
  const top = (status: Status | undefined, mamad: boolean) =>
    wallKind(
      box(s => {
        s.walls[0].status = status;
        room(s, 'room-a').isMamad = mamad;
      }),
      'top',
    );
  expect((['removed', 'new', 'moved', 'kept', undefined] as const).map(status => top(status, true))).toEqual(['removed', 'added', 'moved', 'mamad', 'mamad']);
  expect((['removed', 'new', 'moved', 'kept', undefined] as const).map(status => top(status, false))).toEqual(['removed', 'added', 'moved', 'exterior', 'exterior']);
  expect(kinds(box(s => (s.walls[4].status = 'moved')))).toEqual({ ...outer, part: 'moved' }); // of this wall, not of another
  expect(wallKind(box(s => (room(s, 'room-a').isMamad = true)), 'part')).toBe('mamad');
  expect(wallKind(box(), 'part')).toBe('existing');
});

it('a wall with no room on either side is existing', () => {
  expect(wallKind(box(s => s.walls.push(wall('x', 9000, 0, 9000, 2000, 100))), 'x')).toBe('existing');
  expect(wallKind(box(), 'nope')).toBe('existing');
});

it('a kept wall with from set keeps the kind it had before', () => {
  const s = box(s => Object.assign(s.walls[0], { status: 'kept', from: { a: { x: 0, y: 0 }, b: { x: 1, y: 0 } } }));
  expect(wallKind(s, 'top')).toBe('exterior');
});

it('a wall beside a room outside the apartment is exterior', () => {
  expect(wallKind(box(s => (room(s, 'room-b').inApartment = false)), 'part')).toBe('exterior');
});

it("a balcony: the wall to the room and the balcony's own walls are exterior, also when the balcony belongs to the apartment", () => {
  for (const inApartment of [true, false]) {
    const s = box(s => Object.assign(room(s, 'room-b'), { outdoor: true, inApartment }));
    expect(kinds(s)).toEqual({ ...outer, part: 'exterior' });
  }
});

it('a wall between two balconies is exterior; the mamad wins over the balcony', () => {
  expect(wallKind(box(s => s.rooms.forEach(r => (r.outdoor = true))), 'part')).toBe('exterior');
  const s = box(s => {
    room(s, 'room-b').outdoor = true;
    room(s, 'room-a').isMamad = true;
  });
  expect(wallKind(s, 'part')).toBe('mamad');
});

it('isInside is an apartment room that is not outdoors; isExterior ignores the status', () => {
  const flags = [[true, false], [true, true], [false, false], [false, true]] as const;
  const inside = flags.map(([inApartment, outdoor]) => isInside({ ...boxApartment().rooms[0], inApartment, outdoor }));
  expect(inside).toEqual([true, false, false, false]);
  for (const status of ['kept', 'new', 'moved'] as const) expect(isExterior(box(s => (s.walls[0].status = status)), 'top')).toBe(true);
  expect([isExterior(box(), 'top'), isExterior(box(), 'part'), isExterior(box(s => (room(s, 'room-b').outdoor = true)), 'part')]).toEqual([true, false, true]);
});

it('the kind depends on the given state only, so an archived plan keeps its colours', () => {
  const archived = box(s => (room(s, 'room-b').isMamad = true));
  expect([wallKind(archived, 'part'), wallKind(box(), 'part')]).toEqual(['mamad', 'existing']);
});

it('a room cut in two by a separator, one part outdoors', () => {
  const s = box(s => (s.separators = [{ id: 's', a: { x: 3300, y: 1200 }, b: { x: 6200, y: 1200 } }]));
  s.rooms = computeRooms(s, s.rooms).rooms;
  const part = s.rooms.find(r => r.id !== 'room-a' && r.id !== 'room-b')!;
  part.outdoor = true;
  expect(kinds(s)).toEqual({ ...outer, part: 'exterior' }); // the partition also bounds the outdoor part
});
