import { type ReactNode, useEffect, useState } from 'react';
import { copy } from '../copy';
import { parseCm } from '../model/measure';
import type { Action, Id, Plaster, Project, Pt, Result, WallMaterial } from '../model/types';
import type { Vec } from '../shared';
import { SnapMark } from './Calibrate';
import type { Derived } from './Overlay';
import { WallPreview } from './Overlay';
import { type CentreSnap, pickAt, secondEnd, type Snap, type SnapIndex, snapCentre } from './snap';

const e = copy.editor;

export type ToolName = 'select' | 'wall' | 'remove' | 'measure';
export type Selected = { kind: 'wall' | 'room'; id: Id } | null;
export type EditorCtx = {
  project: Project;
  derived: Derived;
  /** Through the store; a refusal is said in the message line. */
  run(a: Action): Result;
  /** mm per view point. */
  k: number;
  select(s: Selected): void;
  say(text: string): void;
};
/** What the editor's tools give the drawing: marks in mm (under the room labels) and in view points, and their panel. */
export type EditTool = {
  pick(at: Vec, radiusPt: number): void;
  hover(at: Vec | null, radiusPt: number): void;
  preview?(ptPerPx: number): ReactNode;
  marks?(ptPerPx: number): ReactNode;
  panel: ReactNode;
};

const TOOLS: [ToolName, string][] = [
  ['select', e.select],
  ['wall', e.wall],
  ['remove', e.remove],
  ['measure', copy.measure.title],
];

export function Toolbar({ tool, onTool, strength, onStrength }: { tool: ToolName; onTool(t: ToolName): void; strength: number; onStrength(n: number): void }) {
  return (
    <>
      <div role="group" aria-label={e.tools} className="toolbar">
        {TOOLS.map(([name, text]) => (
          <button key={name} type="button" aria-pressed={tool === name} onClick={() => onTool(name)}>
            {text}
          </button>
        ))}
      </div>
      <label className="strength">
        {e.strength}{' '}
        <input type="range" min="20" max="100" step="10" value={strength} onChange={event => onStrength(Number(event.target.value))} />{' '}
        <span>{e.percent(strength)}</span>
      </label>
    </>
  );
}

const toMm = (k: number, [x, y]: Vec): Pt => ({ x: x * k, y: y * k });

/** A click picks a wall, else the room under it. */
export function useSelectTool(c: EditorCtx): EditTool {
  return {
    pick: (at, r) => c.select(pickAt(toMm(c.k, at), c.project.existing, r * c.k)),
    hover: () => {},
    panel: <p>{e.selectHow}</p>,
  };
}

/** A click deletes the wall under it; the model refuses a locked one. */
export function useDeleteTool(c: EditorCtx): EditTool {
  return {
    pick: (at, r) => {
      const hit = pickAt(toMm(c.k, at), c.project.existing, r * c.k);
      if (hit?.kind !== 'wall') return;
      if (c.run({ type: 'x.deleteWall', id: hit.id }).ok) c.select(null);
    },
    hover: () => {},
    panel: <p>{e.removeHow}</p>,
  };
}

const SNAP_SHAPE: Record<string, Snap['to']> = { wall: 'end', end: 'end', between: 'line' };
/** mm of the apartment under one screen pixel above which the wall tool asks to zoom in. */
export const ZOOM_HINT_MM = 5;

/**
 * A wall by its centre line (owner, round 13): a click at the middle of each end, the thickness typed. Between the two
 * clicks the body follows the pointer at that thickness, so that it can be seen to cover the drawn wall.
 */
export function useWallTool(c: EditorCtx, fills: SnapIndex, plaster: Plaster | null, mmPerPx: number): EditTool {
  const [first, setFirst] = useState<Vec | null>(null);
  // where the pointer is and where a click there would land: snapped once per move, not once per drawing
  const [near, setNear] = useState<CentreSnap | null>(null);
  const [text, setText] = useState('10');
  const [material, setMaterial] = useState<WallMaterial | ''>('');
  useEffect(() => {
    const escape = (event: KeyboardEvent) => event.key === 'Escape' && setFirst(null);
    addEventListener('keydown', escape);
    return () => removeEventListener('keydown', escape);
  }, []);
  const thickness = parseCm(text, { min: 20, max: 1000, decimals: 1 });
  // the centre-line ends of the walls already drawn (none before there is a project)
  const ends: Vec[] = (c.project?.existing.walls ?? []).flatMap(w => [[w.a.x / c.k, w.a.y / c.k], [w.b.x / c.k, w.b.y / c.k]] as Vec[]);
  const land = (at: Vec, r: number) => snapCentre(at, fills, r, c.k, ends);
  // a snapped end stays where it snapped; only a free point is held to an axis
  const second = (snap: CentreSnap): Vec => (first ? secondEnd(first, snap) : snap.at);
  return {
    pick: (at, r) => {
      if (thickness === null) return c.say(e.badThickness);
      const snap = land(at, r);
      if (!first) return setFirst(snap.at);
      const result = c.run({ type: 'x.addWall', a: toMm(c.k, first), b: toMm(c.k, second(snap)), thickness, ...(material ? { material } : {}) });
      if (result.ok) setFirst(null);
    },
    hover: (at, r) => setNear(at && land(at, r)),
    preview: ptPerPx => {
      if (!first || !near || thickness === null) return null;
      return <WallPreview a={toMm(c.k, first)} b={toMm(c.k, second(near))} thickness={thickness} k={c.k} ptPerPx={ptPerPx} />;
    },
    marks: ptPerPx => near && <SnapMark snap={{ at: second(near), to: near.to && SNAP_SHAPE[near.to] }} k={ptPerPx} />,
    panel: (
      <section aria-labelledby="wall-tool-title" className="wall-tool">
        <h2 id="wall-tool-title">{e.wall}</h2>
        <p aria-live="polite" data-testid="step">
          <strong>{first ? e.wallSecond : e.wallFirst}</strong>
        </p>
        {/* owner R17: zoomed out, a click lands less well (40 % caught something else, measured) */}
        <p aria-live="polite" data-testid="zoom-hint">{mmPerPx > ZOOM_HINT_MM ? e.zoomHint : ''}</p>
        <label>
          {e.thickness}{' '}
          <input dir="ltr" inputMode="decimal" value={text} aria-invalid={thickness === null} onChange={event => setText(event.target.value)} />
        </label>
        <p data-testid="plaster-note">{e.plasterNote[plaster ?? 'unknown']}</p>
        <label>
          {e.material}{' '}
          <select value={material} onChange={event => setMaterial(event.target.value as WallMaterial | '')}>
            <option value="">{e.noMaterial}</option>
            {(Object.keys(e.materials) as WallMaterial[]).map(m => (
              <option key={m} value={m}>
                {e.materials[m]}
              </option>
            ))}
          </select>
        </label>
      </section>
    ),
  };
}
