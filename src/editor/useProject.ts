import { useState, useSyncExternalStore } from 'react';
import { copy } from '../copy';
import { apply } from '../model/apply';
import { createHistory } from '../model/history';
import { computeRooms } from '../model/rooms';
import { ProjectSchema } from '../model/schema';
import type { Action, Id, Notice, Plaster, Project, Reason, Result, Room, State } from '../model/types';
import type { Colour } from '../pdf/extract';
import type { Calibration } from '../shared';

export type Store = {
  project: Project | null;
  /** The only caller of apply. A refused action changes nothing. */
  dispatch(a: Action): Result;
  undo(): void;
  redo(): void;
  canUndo: boolean;
  canRedo: boolean;
  /** The project is not the last one saved or loaded. */
  dirty: boolean;
  /** Task 12: the project that was written; an edit made while it was written stays dirty. */
  markSaved(saved: Project): void;
  /** The file schema first, then the rooms computed again from the walls; history starts afresh. null: loaded. */
  load(p: Project): Reason | null;
  clear(): void;
};

export type ProjectStore = Store & { subscribe(fn: () => void): () => void; getSnapshot(): Store };

/** The project with its history, outside React, so that it can be tested without a page. */
export function createStore(): ProjectStore {
  let history = createHistory();
  let saved: Project | null = null;
  const listeners = new Set<() => void>();
  const methods = {
    dispatch(a: Action): Result {
      if (!snapshot.project) return { ok: false, reason: 'invalid-action' };
      const r = apply(snapshot.project, a);
      if (r.ok && r.project !== snapshot.project) {
        history.push(r.project);
        set(r.project);
      }
      return r;
    },
    undo() {
      const p = history.undo();
      if (p) set(p);
    },
    redo() {
      const p = history.redo();
      if (p) set(p);
    },
    markSaved(p: Project) {
      saved = p;
      set(snapshot.project);
    },
    load(p: Project): Reason | null {
      if (!ProjectSchema.safeParse(p).success) return 'invalid-action';
      let rooms: Room[];
      try {
        rooms = computeRooms(p.existing, p.existing.rooms).rooms;
      } catch {
        return 'invalid-geometry';
      }
      const q = { ...p, existing: { ...p.existing, rooms } };
      history = createHistory();
      history.push(q);
      saved = q;
      set(q);
      return null;
    },
    clear() {
      history = createHistory();
      saved = null;
      set(null);
    },
  };
  // a new object on every change: React compares snapshots by identity
  let snapshot: Store = { ...methods, project: null, canUndo: false, canRedo: false, dirty: false };
  function set(project: Project | null) {
    snapshot = { ...methods, project, canUndo: history.canUndo(), canRedo: history.canRedo(), dirty: project !== saved };
    for (const fn of listeners) fn();
  }
  return {
    ...methods,
    get project() {
      return snapshot.project;
    },
    get canUndo() {
      return snapshot.canUndo;
    },
    get canRedo() {
      return snapshot.canRedo;
    },
    get dirty() {
      return snapshot.dirty;
    },
    subscribe(fn: () => void) {
      listeners.add(fn);
      return () => void listeners.delete(fn);
    },
    getSnapshot: () => snapshot,
  };
}

/** The project of the page, with its history: one store for the life of the component. */
export function useProject(): Store {
  const [store] = useState(createStore);
  return useSyncExternalStore(store.subscribe, store.getSnapshot);
}

/** A new project for the page shown, at the first accepted calibration. */
export function newProject(o: { fileName: string; pdfBase64: string; page: number; calibration: Calibration; plaster: Plaster | null; colours: Colour[] }): Project {
  return {
    version: 1,
    name: o.fileName.replace(/\.[^.]*$/, '').slice(0, 200) || copy.editor.untitled,
    pdfBase64: o.pdfBase64,
    page: o.page,
    calibration: o.calibration,
    plaster: o.plaster,
    wallClass: {},
    existing: { walls: [], openings: [], separators: [], rooms: [] },
    approved: false,
    mamad: null,
    planned: null,
    plannedArchive: [],
    changeableWarningShown: false,
    // Drawn by hand, the outer walls come into being as rooms are marked as the apartment's, and a locked envelope refuses
    // exactly that (8c): so they start open, and the designer's "אישור" locks and confirms them.
    envelope: 'released',
    clouds: [],
    sourceColors: o.colours.filter(c => /^#[0-9a-f]{6}$/.test(c.hex)).map(c => ({ hex: c.hex, label: '' })),
  };
}

export type RoomEvents = { split: { room: Id; parts: Id[] }[]; merge: { room: Id; from: Id[] }[]; gone: Room[] };
/** What an accepted edit did to the rooms: splits and merges from its notice, and the rooms that are gone (no longer closed). */
export function roomEvents(before: State, after: State, notice?: Notice): RoomEvents {
  const changes = notice && typeof notice === 'object' ? notice.rooms : [];
  const split = changes.flatMap(c => (c.type === 'split' ? [{ room: c.room, parts: c.parts }] : []));
  const merge = changes.flatMap(c => (c.type === 'merge' ? [{ room: c.room, from: c.from }] : []));
  const ids = new Set(after.rooms.map(r => r.id));
  const merged = new Set(merge.flatMap(m => m.from));
  return { split, merge, gone: before.rooms.filter(r => !ids.has(r.id) && !merged.has(r.id)) };
}

/** A later accepted scale: what was drawn is scaled with it. null, or why the model refused it (the old scale then stays). */
export function rescaled(store: Pick<Store, 'dispatch'>, next: Calibration): Reason | null {
  const r = store.dispatch({ type: 'rescale', calibration: next });
  return r.ok ? null : r.reason;
}
