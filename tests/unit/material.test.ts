import { expect, it } from 'vitest';
import { apply } from '../../src/model/apply';
import { ProjectSchema } from '../../src/model/schema';
import type { Action, Project, Result } from '../../src/model/types';
import { createStore } from '../../src/editor/useProject';
import { boxProject } from '../fixtures/box';

/** apply, checking that the input is untouched and an accepted project parses. */
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
const wallOf = (p: Project, id: string) => p.existing.walls.find(w => w.id === id)!;

it('a wall is added with a material, or without one', () => {
  const p = ok(boxProject(), { type: 'x.addWall', a: { x: 200, y: 2000 }, b: { x: 3200, y: 2000 }, thickness: 100, material: 'gypsum' });
  expect(p.existing.walls.at(-1)!.material).toBe('gypsum');
  const q = ok(boxProject(), { type: 'x.addWall', a: { x: 200, y: 2000 }, b: { x: 3200, y: 2000 }, thickness: 100 });
  expect('material' in q.existing.walls.at(-1)!).toBe(false);
});

it('setting a material changes nothing else; null clears it; the rooms stay the same objects', () => {
  const p = boxProject();
  const set = ok(p, { type: 'x.setWall', id: 'part', material: 'block' });
  expect(wallOf(set, 'part')).toEqual({ ...wallOf(p, 'part'), material: 'block' });
  expect(set.existing.rooms).toBe(p.existing.rooms);
  const cleared = ok(set, { type: 'x.setWall', id: 'part', material: null });
  expect(wallOf(cleared, 'part')).toEqual(wallOf(p, 'part'));
});

it('a material can be set on a locked outer wall and a locked mamad wall without a release, and confirms or releases nothing', () => {
  const locked = ok({ ...boxProject(), envelope: 'confirmed' }, { type: 'setMamad', room: 'room-b' });
  expect(apply(locked, { type: 'x.setWall', id: 'top', thickness: 250 })).toEqual({ ok: false, reason: 'mamad-locked' });
  expect(apply(locked, { type: 'x.setWall', id: 'left', thickness: 250 })).toEqual({ ok: false, reason: 'envelope-locked' });
  const outer = ok(locked, { type: 'x.setWall', id: 'left', material: 'concrete' });
  const mamad = ok(outer, { type: 'x.setWall', id: 'right', material: 'concrete' });
  expect([wallOf(mamad, 'left').material, wallOf(mamad, 'right').material]).toEqual(['concrete', 'concrete']);
  expect(mamad.envelope).toBe('confirmed');
  expect(mamad.mamad).toBe('room-b');
  expect(mamad.existing.openings).toBe(locked.existing.openings);
});

it('a split gives both parts the material; geometry and material can change together', () => {
  const p = ok(boxProject(), { type: 'x.setWall', id: 'part', material: 'gypsum' });
  const split = ok(p, { type: 'x.splitWall', id: 'part', at: 500 });
  const parts = split.existing.walls.filter(w => w.a.x === 3250 && w.b.x === 3250);
  expect(parts.map(w => w.material)).toEqual(['gypsum', 'gypsum']);
  const both = ok(p, { type: 'x.setWall', id: 'part', thickness: 120, material: 'block' });
  expect([wallOf(both, 'part').thickness, wallOf(both, 'part').material]).toEqual([120, 'block']);
});

it('an unknown material is refused and changes nothing', () => {
  const p = boxProject();
  for (const material of ['wood', '', 'Gypsum', 1, {}] as unknown as 'gypsum'[]) {
    expect(apply(p, { type: 'x.setWall', id: 'part', material }), String(material)).toEqual({ ok: false, reason: 'invalid-action' });
    expect(apply(p, { type: 'x.addWall', a: { x: 200, y: 2000 }, b: { x: 3200, y: 2000 }, thickness: 100, material }).ok).toBe(false);
  }
});

it('undo takes a material back', () => {
  const store = createStore();
  store.load(boxProject());
  store.dispatch({ type: 'x.setWall', id: 'part', material: 'block' });
  expect(wallOf(store.project!, 'part').material).toBe('block');
  store.undo();
  expect('material' in wallOf(store.project!, 'part')).toBe(false);
});

it('the file: a wall without material parses, with one round-trips, with an unknown one is refused', () => {
  const p = boxProject();
  expect(ProjectSchema.safeParse(p).success).toBe(true);
  const withIt = ok(p, { type: 'x.setWall', id: 'part', material: 'other' });
  expect(ProjectSchema.parse(JSON.parse(JSON.stringify(withIt)))).toEqual(withIt);
  const bad = structuredClone(withIt) as unknown as { existing: { walls: { material: string }[] } };
  bad.existing.walls[4].material = 'wood';
  expect(ProjectSchema.safeParse(bad).success).toBe(false);
});

it('an x.setWall that changes nothing is no undo step', () => {
  const p = boxProject();
  const r = apply(p, { type: 'x.setWall', id: 'part' });
  expect(r.ok && r.project).toBe(p);
  const store = createStore();
  store.load(p);
  store.dispatch({ type: 'x.setWall', id: 'part' });
  expect(store.canUndo).toBe(false);
});
