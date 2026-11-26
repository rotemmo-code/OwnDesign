import { expect, it } from 'vitest';
import { createHistory } from '../../src/model/history';
import type { Project } from '../../src/model/types';
import { boxProject } from '../fixtures/box';

const named = (name: string): Project => ({ ...boxProject(), name });

it('undo then redo returns the same objects', () => {
  const h = createHistory();
  const [a, b, c] = ['a', 'b', 'c'].map(named);
  [a, b, c].forEach(p => h.push(p));
  expect([h.undo(), h.undo(), h.undo()]).toEqual([b, a, null]);
  expect(h.redo()).toBe(b);
  expect(h.redo()).toBe(c);
  expect(h.redo()).toBe(null);
  expect(h.undo()).toBe(b);
});

it('history keeps 100 steps', () => {
  const h = createHistory(100);
  const all = Array.from({ length: 102 }, (_, i) => named(`n${i}`));
  all.forEach(p => h.push(p));
  const back: (Project | null)[] = [];
  for (let i = 0; i < 101; i++) back.push(h.undo());
  expect(back[99]).toBe(all[1]);
  expect(back[100]).toBe(null);
});

it('a push after undo drops the redo branch; canUndo and canRedo follow', () => {
  const h = createHistory();
  expect([h.canUndo(), h.canRedo()]).toEqual([false, false]);
  h.push(named('a'));
  expect([h.canUndo(), h.canRedo()]).toEqual([false, false]);
  h.push(named('b'));
  expect([h.canUndo(), h.canRedo()]).toEqual([true, false]);
  h.undo();
  expect([h.canUndo(), h.canRedo()]).toEqual([false, true]);
  const c = named('c');
  h.push(c);
  expect([h.canUndo(), h.canRedo()]).toEqual([true, false]);
  expect(h.redo()).toBe(null);
  expect(h.undo()?.name).toBe('a');
});
