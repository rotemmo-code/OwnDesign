import type { Project } from './types';

/** Undo and redo over whole projects. Push the starting project first, then every accepted one. */
export function createHistory(limit = 100) {
  const past: Project[] = [];
  let future: Project[] = [];
  return {
    push(p: Project): void {
      past.push(p);
      future = [];
      if (past.length > limit + 1) past.shift();
    },
    undo(): Project | null {
      if (past.length < 2) return null;
      future.push(past.pop()!);
      return past[past.length - 1];
    },
    redo(): Project | null {
      const p = future.pop();
      if (!p) return null;
      past.push(p);
      return p;
    },
    canUndo: (): boolean => past.length > 1,
    canRedo: (): boolean => future.length > 0,
  };
}
