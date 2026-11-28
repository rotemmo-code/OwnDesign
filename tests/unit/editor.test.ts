import { expect, it } from 'vitest';
import { copy } from '../../src/copy';
import { createStore, newProject, releasedAfter, rescaled, roomEvents } from '../../src/editor/useProject';
import { apply } from '../../src/model/apply';
import { ProjectSchema } from '../../src/model/schema';
import type { Action, Project } from '../../src/model/types';
import type { Calibration } from '../../src/shared';
import { boxProject, rect } from '../fixtures/box';

const calibration: Calibration = { scale: 50, mmPerPt: (50 * 25.4) / 72, offsetMm: 0, chosen: 50, dims: [], verified: true };
const made = (fileName: string) => newProject({ fileName, pdfBase64: 'JVBERi0=', page: 2, calibration, plaster: null, colours: [{ hex: '#ff0000', uses: 3 }, { hex: 'pattern', uses: 1 }] });
/** The box with its outer walls open, as a hand-drawn project starts. */
const open = (): Project => ({ ...boxProject(), envelope: 'released' });
const addPartition: Action = { type: 'x.addWall', a: { x: 200, y: 2000 }, b: { x: 3200, y: 2000 }, thickness: 100 };

it('newProject: the file name without its extension, cut to 200; plaster and colours carried with empty labels; outer walls open; passes ProjectSchema', () => {
  const p = made('plan-7.pdf');
  expect(p.name).toBe('plan-7');
  expect(made(`${'x'.repeat(300)}.pdf`).name).toBe('x'.repeat(200));
  expect(made('.pdf').name).toBe(copy.editor.untitled);
  expect(p.plaster).toBeNull();
  expect(p.page).toBe(2);
  expect(p.sourceColors).toEqual([{ hex: '#ff0000', label: '' }]);
  expect(p.envelope).toBe('released');
  expect(ProjectSchema.safeParse(p).success).toBe(true);
});

it('store: an accepted action is pushed; a refused one returns its reason and changes nothing', () => {
  const store = createStore();
  expect(store.dispatch(addPartition)).toEqual({ ok: false, reason: 'invalid-action' }); // no project yet
  expect(store.load(open())).toBeNull();
  const before = store.project;
  expect(store.dispatch({ type: 'x.deleteWall', id: 'nowhere' })).toEqual({ ok: false, reason: 'invalid-action' });
  expect(store.project).toBe(before);
  expect(store.canUndo).toBe(false);
  expect(store.dispatch(addPartition).ok).toBe(true);
  expect(store.project).not.toBe(before);
  expect(store.canUndo).toBe(true);
});

it('store: undo and redo walk five actions; canUndo and canRedo follow; a new action drops what was undone', () => {
  const store = createStore();
  store.load(open());
  const seen = [store.project];
  for (const name of ['a', 'b', 'c', 'd', 'e']) {
    store.dispatch({ type: 'setName', name });
    seen.push(store.project);
  }
  for (let i = 4; i >= 0; i--) {
    store.undo();
    expect(store.project).toBe(seen[i]);
  }
  expect(store.canUndo).toBe(false);
  store.undo();
  expect(store.project).toBe(seen[0]);
  for (let i = 1; i <= 5; i++) {
    store.redo();
    expect(store.project).toBe(seen[i]);
  }
  expect(store.canRedo).toBe(false);
  store.undo();
  store.dispatch({ type: 'setName', name: 'f' });
  expect(store.canRedo).toBe(false);
});

it('store: dirty after an edit; markSaved(p) clears it only while p is the current project', () => {
  const store = createStore();
  store.load(open());
  expect(store.dirty).toBe(false);
  store.dispatch({ type: 'setName', name: 'a' });
  expect(store.dirty).toBe(true);
  const written = store.project!;
  store.dispatch({ type: 'setName', name: 'b' }); // an edit while it was written
  store.markSaved(written);
  expect(store.dirty).toBe(true);
  store.undo();
  expect(store.dirty).toBe(false);
  store.markSaved(store.project!);
  expect(store.dirty).toBe(false);
});

it('store: load refuses what the schema refuses and keeps the current project; a good load restarts history and is clean', () => {
  const store = createStore();
  store.load(open());
  store.dispatch({ type: 'setName', name: 'kept' });
  const kept = store.project;
  expect(store.load({ ...open(), page: 0 })).not.toBeNull();
  expect(store.load({ ...open(), version: 2 } as unknown as Project)).not.toBeNull();
  expect(store.project).toBe(kept);
  expect(store.load(open())).toBeNull();
  expect([store.canUndo, store.canRedo, store.dirty]).toEqual([false, false, false]);
  store.clear();
  expect(store.project).toBeNull();
});

it('store: load recomputes rooms; ids, names and flags follow by overlap', () => {
  const p = open();
  const moved = { ...p, existing: { ...p.existing, rooms: p.existing.rooms.map(r => (r.id === 'room-a' ? { ...r, boundary: rect(205, 200, 3200, 4200) } : r)) } };
  const store = createStore();
  store.load(moved);
  const a = store.project!.existing.rooms.find(r => r.id === 'room-a')!;
  expect(a.boundary).toEqual(rect(200, 200, 3200, 4200));
  expect([a.name, a.inApartment]).toEqual(['A', true]);
});

it('subscribers hear every change, and the snapshot is a new object each time', () => {
  const store = createStore();
  let heard = 0;
  const stop = store.subscribe(() => heard++);
  const first = store.getSnapshot();
  store.load(open());
  store.dispatch({ type: 'setName', name: 'a' });
  store.undo();
  expect(heard).toBe(3);
  expect(store.getSnapshot()).not.toBe(first);
  stop();
  store.redo();
  expect(heard).toBe(3);
});

it('roomEvents: split parts, merge sources, and a room that is gone', () => {
  const p = open();
  const added = apply(p, addPartition);
  if (!added.ok) throw new Error(added.reason);
  const split = roomEvents(p.existing, added.project.existing, added.notice);
  expect(split.split).toHaveLength(1);
  expect(split.split[0].room).toBe('room-a');
  expect(split.gone).toEqual([]);
  const partition = added.project.existing.walls.at(-1)!.id;
  const removed = apply(added.project, { type: 'x.deleteWall', id: partition });
  if (!removed.ok) throw new Error(removed.reason);
  const merged = roomEvents(added.project.existing, removed.project.existing, removed.notice);
  expect(merged.merge).toHaveLength(1);
  expect(merged.gone).toEqual([]);
  const gone = apply(p, { type: 'x.deleteWall', id: 'left' });
  if (!gone.ok) throw new Error(gone.reason);
  expect(roomEvents(p.existing, gone.project.existing, gone.notice).gone.map(r => r.id)).toEqual(['room-a']);
});

it('rescaled: a later scale scales what was drawn; a refusal is passed on and nothing changes', () => {
  const store = createStore();
  store.load(open());
  expect(rescaled(store, { ...calibration, mmPerPt: calibration.mmPerPt * 1.05 })).toBeNull();
  expect(store.project!.existing.walls.find(w => w.id === 'part')!.a.x).toBeCloseTo(3250 * 1.05, 6);
  const refusing = { dispatch: () => ({ ok: false as const, reason: 'invalid-geometry' as const }) };
  expect(rescaled(refusing, calibration)).toBe('invalid-geometry');
  expect(rescaled(store, { ...calibration, mmPerPt: -1 })).toBe('invalid-number');
});

it('released: the mamad whose mark was taken back, read from the history; nothing before the first mark or after a load', () => {
  const store = createStore();
  store.load(open());
  expect(store.released).toBeNull();
  store.dispatch({ type: 'setMamad', room: 'room-b' });
  expect(store.released).toBeNull();
  store.dispatch({ type: 'setMamad', room: null }); // "תיקון"
  expect(store.released).toEqual({ id: 'room-b', name: 'B', fix: true });
  store.dispatch({ type: 'setName', name: 'meanwhile' });
  expect(store.released).toEqual({ id: 'room-b', name: 'B', fix: true });
  store.dispatch({ type: 'setMamad', room: 'room-b' }); // "אישור"
  expect(store.released).toBeNull();
  store.undo();
  expect(store.released).toEqual({ id: 'room-b', name: 'B', fix: true });
  store.undo();
  store.undo();
  expect(store.released).toBeNull(); // the mark itself
  store.undo();
  expect(store.released).toBeNull(); // before it: nothing was ever released
  store.redo();
  store.redo();
  expect(store.released).toEqual({ id: 'room-b', name: 'B', fix: true });
  store.load(open());
  expect(store.released).toBeNull();
});

it('released: the answer אין ממ"ד after a release is an answer, not a release (R39); undo brings the release back', () => {
  const store = createStore();
  store.load(open());
  store.dispatch({ type: 'setMamad', room: 'room-b' });
  store.dispatch({ type: 'setMamad', room: null }); // "תיקון"
  expect(store.released).toEqual({ id: 'room-b', name: 'B', fix: true });
  store.dispatch({ type: 'setMamad', room: 'none' });
  expect(store.project!.mamad).toBe('none');
  expect(store.released).toBeNull();
  store.undo();
  expect(store.released).toEqual({ id: 'room-b', name: 'B', fix: true });
  store.load(open());
  store.dispatch({ type: 'setMamad', room: 'none' }); // answered with no release before it
  expect(store.released).toBeNull();
});

it('releasedAfter: a mark the model clears (a merge) is no release by "תיקון"; a mark kept or an answer given ends a release', () => {
  const marked = (p: Project, id: string | null): Project => ({ ...p, mamad: id, existing: { ...p.existing, rooms: p.existing.rooms.map(r => ({ ...r, isMamad: r.id === id })) } });
  const p = open();
  const fix = { type: 'setMamad', room: null } as const;
  const other = { type: 'x.deleteWall', id: 'part' } as const;
  expect(releasedAfter(marked(p, 'room-b'), marked(p, null), fix, null)).toEqual({ id: 'room-b', name: 'B', fix: true });
  expect(releasedAfter(marked(p, 'room-b'), marked(p, null), other, null)).toEqual({ id: 'room-b', name: 'B', fix: false });
  const was = { id: 'room-b', name: 'B', fix: true };
  expect(releasedAfter(marked(p, null), marked(p, null), other, was)).toBe(was); // carried while nothing is marked
  expect(releasedAfter(marked(p, null), marked(p, 'room-a'), { type: 'setMamad', room: 'room-a' }, was)).toBeNull();
  expect(releasedAfter(marked(p, null), { ...marked(p, null), mamad: 'none' }, { type: 'setMamad', room: 'none' }, was)).toBeNull();
});

it('dispatchAll: n walls classed in one step: one undo returns all, one redo re-applies all, the earlier history stays (R47)', () => {
  const store = createStore();
  store.load(open());
  store.dispatch({ type: 'setName', name: 'before' });
  const ids = ['top', 'right', 'bottom', 'left'];
  const r = store.dispatchAll(ids.map(wallId => ({ type: 'classify', wallId, cls: 'fixed' }) as const));
  expect(r.ok).toBe(true);
  const cls = () => ids.map(id => store.project!.wallClass[id] ?? 'unknown');
  expect(cls()).toEqual(['fixed', 'fixed', 'fixed', 'fixed']);
  store.undo();
  expect(cls()).toEqual(['unknown', 'unknown', 'unknown', 'unknown']);
  expect(store.project!.name).toBe('before');
  store.redo();
  expect(cls()).toEqual(['fixed', 'fixed', 'fixed', 'fixed']);
  store.undo();
  store.undo(); // the step before the batch is still there
  expect(store.project!.name).toBe('box');
  expect(store.canUndo).toBe(false);
});

it('dispatchAll: a refusal anywhere changes nothing and pushes nothing; an empty list is refused', () => {
  const store = createStore();
  store.load(open());
  const before = store.project;
  expect(store.dispatchAll([{ type: 'classify', wallId: 'top', cls: 'fixed' }, { type: 'classify', wallId: 'nope', cls: 'fixed' }])).toEqual({ ok: false, reason: 'invalid-action' });
  expect(store.project).toBe(before);
  expect(store.canUndo).toBe(false);
  expect(store.dispatchAll([]).ok).toBe(false);
});
