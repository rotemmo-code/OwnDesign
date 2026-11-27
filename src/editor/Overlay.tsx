import { memo, type ReactNode } from 'react';
import { copy } from '../copy';
import { dist } from '../model/geo';
import { wallOutlines } from '../model/join';
import { wallKind } from '../model/kind';
import { formatCm, formatM2, type Metrics, roomMetrics } from '../model/measure';
import { envelopeLeaf, envelopeSpans, mamadSpan } from '../model/rules';
import type { Id, Project, Pt, Room, State, WallClass } from '../model/types';
import { COLOR, type WallKind } from '../theme';
import { type PaintName, paintOf, wallPaint } from './Legend';

/** Why a wall cannot be changed now: it bounds the mamad, or it is an outer wall while the outer walls are locked. */
export type Lock = 'mamad' | 'envelope';
export type Derived = { outlines: Map<Id, Pt[]>; kinds: Map<Id, WallKind>; paints: Map<Id, PaintName>; locks: Map<Id, Lock>; gross: Map<Id, Metrics> };

/**
 * Everything drawn that the model computes, once per project. Only what the model's own rules say: the editor shows
 * the locks, the model decides. shortcut: recomputed in full on every edit (1 to 6 s at 480 walls and more, owner R10);
 * reuse the walls far from an edit before detection drafts ship (Tasks 15 / 22).
 */
export function derive(p: Project): Derived {
  const s = p.existing;
  const kinds = new Map(s.walls.map(w => [w.id, wallKind(s, w.id)]));
  const cls = (id: Id): WallClass => p.wallClass[id] ?? 'unknown';
  const locks = new Map<Id, Lock>();
  for (const w of s.walls) {
    if (kinds.get(w.id) === 'mamad' && mamadSpan(s, w.id)) locks.set(w.id, 'mamad');
    else if (p.envelope !== 'released' && (envelopeSpans(s, w.id).length > 0 || envelopeLeaf(s, w))) locks.set(w.id, 'envelope');
  }
  return {
    outlines: wallOutlines(s.walls),
    kinds,
    paints: new Map(s.walls.map(w => [w.id, paintOf(kinds.get(w.id)!, cls(w.id))])),
    locks,
    gross: new Map(s.rooms.map(r => [r.id, roomMetrics(r, s.separators)])),
  };
}

const pathOf = (ring: Pt[]) => (ring.length ? `M${ring.map(p => `${p.x} ${p.y}`).join('L')}Z` : '');
export const centreOf = (ring: Pt[]): Pt => {
  // the middle of the ring's box: a label inside a plain room; good enough for a label
  const xs = ring.map(p => p.x);
  const ys = ring.map(p => p.y);
  return { x: (Math.min(...xs) + Math.max(...xs)) / 2, y: (Math.min(...ys) + Math.max(...ys)) / 2 };
};

/** The walls, drawn again only when the state, their paint or their outline changes. */
const Walls = memo(function Walls({ state, derived }: { state: State; derived: Derived }) {
  return (
    <g data-testid="walls">
      {state.walls.map(w => (
        <path key={w.id} data-wall={w.id} data-paint={derived.paints.get(w.id)} d={pathOf(derived.outlines.get(w.id) ?? [])} strokeWidth="1.5" vectorEffect="non-scaling-stroke" {...wallPaint(derived.paints.get(w.id)!)} />
      ))}
    </g>
  );
});

type Props = {
  project: Project;
  derived: Derived;
  /** mm per view point, and view points per CSS pixel. */
  k: number;
  ptPerPx: number;
  selected: { kind: 'wall' | 'room'; id: Id } | null;
  /** Drawn in mm over the walls and under the room labels. */
  preview?: ReactNode;
  /** Drawn in view points, under the room labels. */
  marks?: ReactNode;
  /** Parts of a split room, numbered for the question which keeps the name. */
  parts?: Id[];
};

/** The draft over the page, in mm. Room names and areas come last: nothing is drawn over them (owner R9). */
export function Overlay({ project, derived, k, ptPerPx, selected, preview, marks, parts = [] }: Props) {
  const s = project.existing;
  const px = ptPerPx * k; // mm per CSS pixel
  const wall = selected?.kind === 'wall' ? s.walls.find(w => w.id === selected.id) : undefined;
  const room = selected?.kind === 'room' ? s.rooms.find(r => r.id === selected.id) : undefined;
  const label = (r: Room) => {
    const at = centreOf(r.boundary);
    const part = parts.indexOf(r.id);
    return (
      <g key={r.id} className="room-label" data-room={r.id} fontSize={14 * px} strokeWidth={4 * px}>
        {part >= 0 && <text x={at.x} y={at.y - 22 * px} fontWeight="700" fontSize={20 * px}>{part + 1}</text>}
        <text x={at.x} y={at.y - 4 * px} fontWeight="700">{r.name || copy.editor.unnamed}</text>
        <text x={at.x} y={at.y + 14 * px}>{formatM2(derived.gross.get(r.id)?.areaMm2 ?? 0)} מ"ר</text>
      </g>
    );
  };
  return (
    <>
      <g transform={`scale(${1 / k})`}>
        <Walls state={s} derived={derived} />
        {wall && <path className="selected" d={pathOf(derived.outlines.get(wall.id) ?? [])} />}
        {room && (
          <g className="selected-room">
            <path className="selected" d={pathOf(room.boundary)} />
            {derived.gross.get(room.id)?.edges.map((e, i) => (
              <text key={i} className="edge-length" x={(e.a.x + e.b.x) / 2} y={(e.a.y + e.b.y) / 2} fontSize={13 * px} strokeWidth={3 * px}>
                {formatCm(e.mm)}
              </text>
            ))}
          </g>
        )}
        {preview}
      </g>
      {marks}
      <g transform={`scale(${1 / k})`} fill={COLOR.ink}>
        {s.rooms.map(label)}
      </g>
    </>
  );
}

/** The wall the tool is drawing: its body at the typed thickness, and "length × thickness" beside it, in cm. */
export function WallPreview({ a, b, thickness, k, ptPerPx }: { a: Pt; b: Pt; thickness: number; k: number; ptPerPx: number }) {
  const l = dist(a, b);
  if (!l) return null;
  const n = { x: (-(b.y - a.y) / l) * (thickness / 2), y: ((b.x - a.x) / l) * (thickness / 2) };
  const body = [
    { x: a.x + n.x, y: a.y + n.y },
    { x: b.x + n.x, y: b.y + n.y },
    { x: b.x - n.x, y: b.y - n.y },
    { x: a.x - n.x, y: a.y - n.y },
  ];
  const px = ptPerPx * k;
  return (
    <g className="wall-preview" data-testid="wall-preview">
      <path d={pathOf(body)} />
      <text x={b.x + 12 * px} y={b.y - 12 * px} fontSize={15 * px} strokeWidth={3 * px}>{`${(l / 10).toFixed(1)} × ${(thickness / 10).toFixed(1)}`}</text>
    </g>
  );
}
