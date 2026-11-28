import { type ReactNode, useEffect, useState } from 'react';
import { copy } from '../copy';
import { dist } from '../model/geo';
import { faceLength, parseCm, roomsOnSide } from '../model/measure';
import type { Action, Id, Opening, Plaster, Project, Pt, Result, Wall, WallMaterial } from '../model/types';
import type { Vec } from '../shared';
import { SnapMark } from './Calibrate';
import type { Derived } from './Overlay';
import { WallPreview } from './Overlay';
import { alongWall, type CentreSnap, offsetOn, openingFoot, pickAt, secondEnd, type Snap, type SnapIndex, snapCentre, snapFace, snapPoint, wallAt } from './snap';
import { corners } from '../model/geo';

const e = copy.editor;

export type ToolName = 'select' | 'wall' | 'door' | 'window' | 'passage' | 'separator' | 'split' | 'remove' | 'measure';
export type Selected = { kind: 'wall' | 'room' | 'opening' | 'separator'; id: Id } | null;
export type EditorCtx = {
  project: Project;
  derived: Derived;
  /** Through the store; a refusal is said in the message line. */
  run(a: Action): Result;
  /** mm per view point. */
  k: number;
  selected: Selected;
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
  ['door', e.door],
  ['window', e.window],
  ['passage', e.passage],
  ['separator', e.separator],
  ['split', e.splitTool],
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
const toPt = (k: number, p: Pt): Vec => [p.x / k, p.y / k];
const SNAP_SHAPE: Record<string, Snap['to']> = { wall: 'end', end: 'end', between: 'line' };
/** mm of the apartment under one screen pixel above which the drawing tools ask to zoom in. */
export const ZOOM_HINT_MM = 5;
/** Owner R17: zoomed out, a click lands less well (40 % caught something else, measured). Never blocks drawing. */
const ZoomHint = ({ mmPerPx }: { mmPerPx: number }) => <p aria-live="polite" data-testid="zoom-hint">{mmPerPx > ZOOM_HINT_MM ? e.zoomHint : ''}</p>;
const Step = ({ text }: { text: string }) => (
  <p aria-live="polite" data-testid="step">
    <strong>{text}</strong>
  </p>
);
/** Escape drops what a tool holds half done. */
function useEscape(drop: () => void) {
  useEffect(() => {
    const escape = (event: KeyboardEvent) => event.key === 'Escape' && drop();
    addEventListener('keydown', escape);
    return () => removeEventListener('keydown', escape);
  }, []);
}
const wallOf = (c: EditorCtx, id: Id) => c.project.existing.walls.find(w => w.id === id);
/** The face length the panel shows: toward the longest room face, else the centre line. */
export function shownLength(c: EditorCtx, w: Wall): number {
  const s = c.project.existing;
  const beside = [...new Set([...roomsOnSide(s, w.id, 'A'), ...roomsOnSide(s, w.id, 'B')])];
  return beside.length ? Math.max(...beside.map(room => faceLength(s, room, w.id))) : dist(w.a, w.b);
}
/** The centre-line ends of the walls already drawn, but one, in view points. */
const endsOf = (c: EditorCtx, but?: Id): Vec[] =>
  (c.project?.existing.walls ?? []).filter(w => w.id !== but).flatMap(w => [toPt(c.k, w.a), toPt(c.k, w.b)]);

type Held = { kind: 'end'; wall: Id; end: 'a' | 'b' } | { kind: 'edge'; opening: Id; edge: 'start' | 'end' } | null;

/**
 * A click picks an opening, a wall, a separator, else the room under it. On the chosen wall its two ends, on the chosen
 * opening its two edges, are handles: a click on one holds it, the next click places it, one action (owner R25). The end
 * of a wall locked by the outer walls or the mamad does not move (R31); the end of a wall that carries a locked opening
 * moves along the wall's own line only (the model's openingsHold); a free end is held to an axis as in the wall tool
 * (R33). While an end is held, a typed length places it.
 */
export function useSelectTool(c: EditorCtx, fills: SnapIndex): EditTool {
  const [held, setHeld] = useState<Held>(null);
  const [near, setNear] = useState<Pt | null>(null);
  const [text, setText] = useState('');
  useEscape(() => setHeld(null));
  // shortcut: guard in the editor, move into src/model/rules.ts in Task 12
  const endLocked = (w: Wall): boolean => {
    const lock = c.derived.locks.get(w.id);
    if (lock) c.say(copy.reason[lock === 'envelope' ? 'envelope-locked' : 'mamad-locked'] ?? e.reasonOther);
    return !!lock;
  };
  // where the held end or edge would go for a pointer at at: snapped once per move
  const place = (at: Vec, r: number): Pt | null => {
    if (held?.kind === 'end') {
      const w = wallOf(c, held.wall);
      if (!w) return null;
      const snap = snapCentre(at, fills, r, c.k, endsOf(c, w.id));
      const holdsLock = c.project.existing.openings.some(o => o.wallId === w.id && c.derived.openingLocks.get(o.id));
      if (holdsLock) return alongWall(w, offsetOn(w, toMm(c.k, snap.at)));
      return toMm(c.k, secondEnd(toPt(c.k, w[held.end === 'a' ? 'b' : 'a']), snap));
    }
    if (held?.kind === 'edge') {
      const o = c.project.existing.openings.find(x => x.id === held.opening);
      const w = o && wallOf(c, o.wallId);
      return w ? alongWall(w, offsetOn(w, toMm(c.k, snapped(at, fills, r)))) : null;
    }
    return null;
  };
  const moveEnd = (to: Pt) => {
    if (held?.kind !== 'end') return;
    const w = wallOf(c, held.wall);
    if (!w || endLocked(w)) return setHeld(null);
    if (c.run({ type: 'x.setWall', id: held.wall, [held.end]: to }).ok) setHeld(null);
  };
  const moveEdge = (to: Pt) => {
    if (held?.kind !== 'edge') return;
    const o = c.project.existing.openings.find(x => x.id === held.opening);
    const w = o && wallOf(c, o.wallId);
    if (!o || !w) return setHeld(null);
    const t = offsetOn(w, to);
    const [from, till] = held.edge === 'start' ? [t, o.offset + o.width] : [o.offset, t];
    if (c.run({ type: 'x.setOpening', id: o.id, offset: Math.min(from, till), width: Math.abs(till - from) }).ok) setHeld(null);
  };
  const typedLength = () => {
    if (held?.kind !== 'end') return;
    const w = wallOf(c, held.wall);
    const mm = parseCm(text, { min: 10, max: 1_000_000, decimals: 1 });
    if (!w || mm === null) return c.say(e.badLength);
    // the length typed is the face length shown: the end moves by the difference, along the wall
    const delta = mm - shownLength(c, w);
    const l = dist(w.a, w.b);
    const u = { x: (w.b.x - w.a.x) / l, y: (w.b.y - w.a.y) / l };
    const sign = held.end === 'b' ? 1 : -1;
    moveEnd({ x: w[held.end].x + sign * u.x * delta, y: w[held.end].y + sign * u.y * delta });
  };
  const preview = (ptPerPx: number) => {
    if (!held || !near) return null;
    if (held.kind === 'end') {
      const w = wallOf(c, held.wall);
      if (!w) return null;
      const moved = { ...w, [held.end]: near };
      return <WallPreview a={moved.a} b={moved.b} thickness={w.thickness} k={c.k} ptPerPx={ptPerPx} />;
    }
    const o = c.project.existing.openings.find(x => x.id === held.opening);
    const w = o && wallOf(c, o.wallId);
    if (!o || !w) return null;
    const t = offsetOn(w, near);
    const [from, till] = held.edge === 'start' ? [t, o.offset + o.width] : [o.offset, t];
    return <SpanPreview w={w} from={Math.min(from, till)} till={Math.max(from, till)} k={c.k} ptPerPx={ptPerPx} />;
  };
  return {
    pick: (at, r) => {
      const to = place(at, r);
      if (held?.kind === 'end' && to) return moveEnd(to);
      if (held?.kind === 'edge' && to) return moveEdge(to);
      const hit = pickAt(toMm(c.k, at), c.project.existing, r * c.k, c.selected);
      if (hit?.kind === 'end' || hit?.kind === 'edge') {
        const w = hit.kind === 'end' && wallOf(c, hit.wall);
        if (w && endLocked(w)) return;
        setText('');
        return setHeld(hit);
      }
      c.select(hit && { kind: hit.kind, id: hit.id });
    },
    hover: (at, r) => setNear(at && place(at, r)),
    preview,
    panel: held ? (
      <section aria-labelledby="move-title" className="move">
        <h2 id="move-title">{e.select}</h2>
        <Step text={held.kind === 'end' ? e.moveEnd : e.moveEdge} />
        {held.kind === 'end' && (
          <label>
            {e.wallLength}{' '}
            <input autoFocus dir="ltr" inputMode="decimal" value={text} onChange={event => setText(event.target.value)} onKeyDown={event => event.key === 'Enter' && typedLength()} />
          </label>
        )}
      </section>
    ) : (
      <p>{e.selectHow}</p>
    ),
  };
}

/** A drawing point near at (an end or a crossing of the drawing's filled shapes, where an opening's gap ends), else at. */
const snapped = (at: Vec, fills: SnapIndex, r: number): Vec => {
  const s = snapPoint(at, fills, r);
  return s.to === 'end' || s.to === 'cross' ? s.at : at;
};

/** A stretch of a wall, as an opening of it would be: its gap and its width in cm. */
function SpanPreview({ w, from, till, k, ptPerPx }: { w: Wall; from: number; till: number; k: number; ptPerPx: number }) {
  if (till - from <= 0) return null;
  const [p, q] = [alongWall(w, from), alongWall(w, till)];
  const px = ptPerPx * k;
  const ring = corners(p, q, w.thickness + 2);
  return (
    <g className="wall-preview" data-testid="opening-preview">
      <path d={`M${ring.map(x => `${x.x} ${x.y}`).join('L')}Z`} />
      <text x={q.x + 12 * px} y={q.y - 12 * px} fontSize={15 * px} strokeWidth={3 * px}>{((till - from) / 10).toFixed(1)}</text>
    </g>
  );
}

/**
 * An opening of one kind: a click on the wall where it starts and one where it ends, both put on the centre line of the
 * wall under the first click; a second click on another wall is refused (owner R24). Or one click and a typed width.
 */
export function useOpeningTool(c: EditorCtx, fills: SnapIndex, kind: Opening['kind'], mmPerPx: number): EditTool {
  const [first, setFirst] = useState<{ wall: Id; t: number } | null>(null);
  const [near, setNear] = useState<number | null>(null);
  const [text, setText] = useState('80');
  useEscape(() => setFirst(null));
  const wall = first && wallOf(c, first.wall);
  const along = (w: Wall, at: Vec, r: number) => openingFoot(w, at, fills, r, c.k);
  const add = (from: number, till: number) => {
    if (!first) return;
    const result = c.run({ type: 'x.addOpening', wallId: first.wall, offset: Math.min(from, till), width: Math.abs(till - from), kind });
    if (result.ok) setFirst(null);
  };
  const typed = () => {
    const mm = parseCm(text, { min: 10, max: 1_000_000, decimals: 1 });
    if (mm === null) return c.say(e.badLength);
    if (!first || !wall) return;
    // toward the pointer, else along the wall from a to b
    const sign = near !== null && near < first.t ? -1 : 1;
    add(first.t, first.t + sign * mm);
  };
  const title = kind === 'door' ? e.door : kind === 'window' ? e.window : e.passage;
  return {
    pick: (at, r) => {
      const under = wallAt(toMm(c.k, at), c.project.existing.walls, r * c.k);
      // a first click whose wall is gone (undone) counts for nothing
      if (!first || !wall) {
        const w = under && wallOf(c, under);
        if (!w) return c.say(e.openingFirst);
        return setFirst({ wall: w.id, t: along(w, at, r) });
      }
      if (under && under !== first.wall) return c.say(e.otherWall);
      add(first.t, along(wall, at, r));
    },
    hover: (at, r) => setNear(at && wall ? along(wall, at, r) : null),
    preview: ptPerPx => first && wall && near !== null && <SpanPreview w={wall} from={Math.min(first.t, near)} till={Math.max(first.t, near)} k={c.k} ptPerPx={ptPerPx} />,
    panel: (
      <section aria-labelledby="opening-tool-title">
        <h2 id="opening-tool-title">{title}</h2>
        <Step text={wall ? e.openingSecond : e.openingFirst} />
        <ZoomHint mmPerPx={mmPerPx} />
        <label>
          {e.widthField}{' '}
          <input dir="ltr" inputMode="decimal" value={text} onChange={event => setText(event.target.value)} onKeyDown={event => event.key === 'Enter' && typed()} />
        </label>
      </section>
    ),
  };
}

/** A separator from a face of a wall to a face across: each click on the nearest face within reach, else refused (R24). */
export function useSeparatorTool(c: EditorCtx, mmPerPx: number): EditTool {
  const [first, setFirst] = useState<Pt | null>(null);
  const [near, setNear] = useState<Pt | null>(null);
  useEscape(() => setFirst(null));
  const face = (at: Vec, r: number) => snapFace(toMm(c.k, at), c.derived.outlines.values(), r * c.k);
  return {
    pick: (at, r) => {
      const p = face(at, r);
      if (!p) return c.say(e.noFace);
      if (!first) return setFirst(p);
      if (c.run({ type: 'x.addSeparator', a: first, b: p }).ok) setFirst(null);
    },
    hover: (at, r) => setNear(at && face(at, r)),
    preview: () => first && near && <line className="separator-preview" data-testid="separator-preview" x1={first.x} y1={first.y} x2={near.x} y2={near.y} />,
    marks: ptPerPx => near && <SnapMark snap={{ at: toPt(c.k, near), to: 'line' }} k={ptPerPx} />,
    panel: (
      <section aria-labelledby="separator-tool-title">
        <h2 id="separator-tool-title">{e.separator}</h2>
        <Step text={first ? e.separatorSecond : e.separatorFirst} />
        <ZoomHint mmPerPx={mmPerPx} />
      </section>
    ),
  };
}

/** A click on a wall cuts it in two there; both parts keep its class and material (the model's split). */
export function useSplitTool(c: EditorCtx, mmPerPx: number): EditTool {
  return {
    pick: (at, r) => {
      const p = toMm(c.k, at);
      const id = wallAt(p, c.project.existing.walls, r * c.k);
      const w = id && wallOf(c, id);
      if (w && c.run({ type: 'x.splitWall', id: w.id, at: offsetOn(w, p) }).ok) c.select(null);
    },
    hover: () => {},
    panel: (
      <section aria-labelledby="split-tool-title">
        <h2 id="split-tool-title">{e.splitTool}</h2>
        <Step text={e.splitHow} />
        <ZoomHint mmPerPx={mmPerPx} />
      </section>
    ),
  };
}

/** A click deletes the opening, wall or separator under it; the model refuses a locked one. */
export function useDeleteTool(c: EditorCtx): EditTool {
  return {
    pick: (at, r) => {
      const hit = pickAt(toMm(c.k, at), c.project.existing, r * c.k);
      const action: Action | null =
        hit?.kind === 'wall' ? { type: 'x.deleteWall', id: hit.id }
        : hit?.kind === 'opening' ? { type: 'x.deleteOpening', id: hit.id }
        : hit?.kind === 'separator' ? { type: 'x.deleteSeparator', id: hit.id }
        : null;
      if (action && c.run(action).ok) c.select(null);
    },
    hover: () => {},
    panel: <p>{e.removeHow}</p>,
  };
}

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
  useEscape(() => setFirst(null));
  const thickness = parseCm(text, { min: 20, max: 1000, decimals: 1 });
  const land = (at: Vec, r: number) => snapCentre(at, fills, r, c.k, endsOf(c));
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
        <Step text={first ? e.wallSecond : e.wallFirst} />
        <ZoomHint mmPerPx={mmPerPx} />
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
