import { readdirSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { expect, it } from 'vitest';
import { COLOR, contrast, KIND_STYLE, type WallKind } from '../../src/theme';

const KINDS = Object.keys(KIND_STYLE) as WallKind[];

it('contrast is the WCAG ratio, whichever way round', () => {
  expect(contrast('#000000', '#FFFFFF')).toBeCloseTo(21, 5);
  expect(contrast('#FFFFFF', '#777777')).toBeCloseTo(4.478, 3); // the classic grey that just fails 4.5
  expect(contrast('#777777', '#FFFFFF')).toBeCloseTo(4.478, 3);
  expect(contrast('#FF0000', '#0000FF')).toBeCloseTo(2.149, 3);
});

it('every wall, finish and dimension colour has contrast of at least 3 on paper; ink and dimension at least 4.5', () => {
  for (const name of [...KINDS, 'finish', 'dimension'] as const) expect(contrast(COLOR[name], COLOR.paper), name).toBeGreaterThanOrEqual(3);
  for (const name of ['ink', 'dimension'] as const) expect(contrast(COLOR[name], COLOR.paper), name).toBeGreaterThanOrEqual(4.5);
});

it('the eight colours are all different, and added, moved and removed also differ in fill or dash', () => {
  expect(KINDS).toHaveLength(6);
  expect(new Set([...KINDS, 'finish', 'dimension'].map(name => COLOR[name as WallKind])).size).toBe(8);
  expect(new Set([KIND_STYLE.added, KIND_STYLE.moved, KIND_STYLE.removed].map(s => JSON.stringify(s))).size).toBe(3);
});

it('kept and moved walls are solid, an added wall is hatched, a removed wall is an empty dashed outline', () => {
  for (const kind of ['existing', 'exterior', 'mamad', 'moved'] as const) expect(KIND_STYLE[kind], kind).toEqual({ fill: 'solid', dashed: false });
  expect(KIND_STYLE.added).toEqual({ fill: 'hatch', dashed: false });
  expect(KIND_STYLE.removed).toEqual({ fill: 'none', dashed: true });
});

it('no colour literal exists in src/ outside theme.ts, src/pdf/ and src/detect/', () => {
  const literal = /#(?:[\da-f]{8}|[\da-f]{6}|[\da-f]{3,4})\b|\b(?:rgb|hsl)a?\(/gi;
  expect('#fff #1F4E79 #80808080 rgb(1 hsla(2'.match(literal)).toHaveLength(5);
  expect('#root'.match(literal)).toBeNull();
  const src = path.join(import.meta.dirname, '../../src');
  // src/pdf/ and src/detect/ name the drawing's own grays
  const files = readdirSync(src, { recursive: true, encoding: 'utf8' }).filter(f => /\.(tsx?|css)$/.test(f) && f !== 'theme.ts' && !/^(pdf|detect)[\\/]/.test(f));
  expect(files).toContain('main.tsx');
  expect(files).toContain(path.join('editor', 'App.tsx'));
  expect(files.flatMap(f => (readFileSync(path.join(src, f), 'utf8').match(literal) ?? []).map(m => `${f}: ${m}`))).toEqual([]);
});
