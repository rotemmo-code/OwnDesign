import { memo, type ReactNode } from 'react';
import { copy } from '../copy';
import { finishStrips, roomAfterFinish } from '../model/finish';
import { corners, dist, rings } from '../model/geo';
import { wallOutlines } from '../model/join';
import { wallKind } from '../model/kind';
import { formatCm, formatM2, type Metrics, roomMetrics } from '../model/measure';
import { envelopeLeaf, envelopeSpans, mamadSpan, openingLock } from '../model/rules';
import type { Id, Opening, Project, Pt, Reason, Room, State, Wall, WallClass } from '../model/types';
import { COLOR, type WallKind } from '../theme';
import { finishPaint, PaintDefs, type PaintIds, type PaintName, paintOf, usePaintIds, wallPaint } from './Legend';
import { alongWall } from './snap';

/** Why a wall cannot be changed now: it bounds the mamad, or it is an outer wall while the outer walls are locked. */
export type Lock = 'mamad' | 'envelope';
export type Derived = {
  outlines: Map<Id, Pt[]>;
  kinds: Map<Id, WallKind>;
  paints: Map<Id, PaintName>;
  locks: Map<Id, Lock>;
  /** Why an opening cannot be changed now (a window, the entry door, an opening on a mamad wall), as the model says. */
  openingLocks: Map<Id, Reason | null>;
  gross: Map<Id, Metrics>;
};
/** The finishes: their strips by wall, and every room's area after them (null: no finish faces the room). Costly: deferred. */
export type Finished = { strips: Map<Id, Pt[][]>; net: Map<Id, Metrics | null> };

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
    openingLocks: new Map(s.openings.map(o => [o.id, openingLock(s, o)])),
    gross: new Map(s.rooms.map(r => [r.id, roomMetrics(r, s.separators)])),
  };
}

export function deriveFinish(s: State): Finished {
  return {
    strips: new Map([...finishStrips(s)].map(([id, g]) => [id, rings(g)])),
    net: new Map(s.rooms.map(r => [r.id, roomAfterFinish(s, r.id)])),
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
const Walls = memo(function Walls({ state, derived, ids }: { state: State; derived: Derived; ids: PaintIds }) {
  return (
    <g data-testid="walls">
      {state.walls.map(w => (
        <path key={w.id} data-wall={w.id} data-paint={derived.paints.get(w.id)} d={pathOf(derived.outlines.get(w.id) ?? [])} strokeWidth="1.5" vectorEffect="non-scaling-stroke" {...wallPaint(derived.paints.get(w.id)!, ids)} />
      ))}
    </g>
  );
});

/**
 * An opening: a white gap across its wall, with a door's arc, a window's line, or nothing for a passage; the entry door's
 * arc is heavier. Locked: the colour of its wall's kind, on an inner wall the fixed colour (R32); free: the existing
 * colour; released or not confirmed: dashed (R22).
 */
function OpeningShape({ o, w, derived }: { o: Opening; w: Wall; derived: Derived }) {
  const [p, q] = [alongWall(w, o.offset), alongWall(w, o.offset + o.width)];
  const n = { x: -(q.y - p.y) / o.width, y: (q.x - p.x) / o.width };
  const locked = !!derived.openingLocks.get(o.id);
  const kind = derived.kinds.get(w.id) ?? 'existing';
  const colour = !locked ? COLOR.existing : kind === 'existing' ? COLOR.fixed : COLOR[kind];
  const dashed = o.released || !o.confirmed ? '5 4' : undefined;
  const line = { stroke: colour, strokeDasharray: dashed, vectorEffect: 'non-scaling-stroke' as const, fill: 'none' };
  return (
    <g data-opening={o.id} data-kind={o.kind} data-locked={locked} data-dashed={!!dashed} className="opening">
      <path d={pathOf(corners(p, q, w.thickness + 2))} {...line} fill={COLOR.paper} strokeWidth="1.5" />
      {o.kind === 'window' && <line x1={p.x} y1={p.y} x2={q.x} y2={q.y} {...line} strokeWidth="1.5" />}
      {(o.kind === 'door' || o.kind === 'entry') && (
        <path d={`M${p.x} ${p.y}L${p.x + n.x * o.width} ${p.y + n.y * o.width}A${o.width} ${o.width} 0 0 1 ${q.x} ${q.y}`} {...line} strokeWidth={o.kind === 'entry' ? 3 : 1.5} />
      )}
    </g>
  );
}

type Props = {
  project: Project;
  derived: Derived;
  /** The finishes, once computed; null until then. */
  finished: Finished | null;
  /** Areas after the finishes (owner: the default), or up to the drawn walls. */
  net: boolean;
  /** mm per view point, and view points per CSS pixel. */
  k: number;
  ptPerPx: number;
  selected: { kind: string; id: Id } | null;
  /** Drawn in mm over the walls and under the room labels. */
  preview?: ReactNode;
  /** Drawn in view points, under the room labels. */
  marks?: ReactNode;
  /** Parts of a split room, numbered for the question which keeps the name. */
  parts?: Id[];
};

/** The draft over the page, in mm. Room names and areas come last: nothing is drawn over them (owner R9). */
export function Overlay({ project, derived, finished, net, k, ptPerPx, selected, preview, marks, parts = [] }: Props) {
  const s = project.existing;
  const ids = usePaintIds();
  const px = ptPerPx * k; // mm per CSS pixel
  const walls = new Map(s.walls.map(w => [w.id, w]));
  const wall = selected?.kind === 'wall' ? walls.get(selected.id) : undefined;
  const room = selected?.kind === 'room' ? s.rooms.find(r => r.id === selected.id) : undefined;
  const opening = selected?.kind === 'opening' ? s.openings.find(o => o.id === selected.id) : undefined;
  const separator = selected?.kind === 'separator' ? s.separators.find(x => x.id === selected.id) : undefined;
  const area = (id: Id) => (net && finished?.net.get(id)) || derived.gross.get(id);
  const handle = (at: Pt, key: string) => <rect key={key} className="handle" data-handle={key} x={at.x - 5 * px} y={at.y - 5 * px} width={10 * px} height={10 * px} />;
  const label = (r: Room) => {
    const at = centreOf(r.boundary);
    const part = parts.indexOf(r.id);
    return (
      <g key={r.id} className="room-label" data-room={r.id} fontSize={14 * px} strokeWidth={4 * px}>
        {part >= 0 && <text x={at.x} y={at.y - 22 * px} fontWeight="700" fontSize={20 * px}>{part + 1}</text>}
        <text x={at.x} y={at.y - 4 * px} fontWeight="700">{r.name || copy.editor.unnamed}</text>
        <text x={at.x} y={at.y + 14 * px}>{copy.editor.m2(formatM2(area(r.id)?.areaMm2 ?? 0))}</text>
      </g>
    );
  };
  return (
    <>
      <g transform={`scale(${1 / k})`}>
        <PaintDefs ids={ids} size={20} />
        <Walls state={s} derived={derived} ids={ids} />
        {finished &&
          [...finished.strips].map(([id, list]) => (
            <path key={id} data-finish={id} d={list.map(pathOf).join('')} fillRule="evenodd" strokeWidth="1" vectorEffect="non-scaling-stroke" {...finishPaint(ids)} />
          ))}
        {s.openings.map(o => walls.get(o.wallId) && <OpeningShape key={o.id} o={o} w={walls.get(o.wallId)!} derived={derived} />)}
        {s.separators.map(x => (
          <line key={x.id} className="separator" data-separator={x.id} x1={x.a.x} y1={x.a.y} x2={x.b.x} y2={x.b.y} />
        ))}
        {wall && (
          <g className="selected-wall">
            <path className="selected" d={pathOf(derived.outlines.get(wall.id) ?? [])} />
            {handle(wall.a, 'a')}
            {handle(wall.b, 'b')}
          </g>
        )}
        {opening && walls.get(opening.wallId) && (
          <g className="selected-opening">
            <path className="selected" d={pathOf(corners(alongWall(walls.get(opening.wallId)!, opening.offset), alongWall(walls.get(opening.wallId)!, opening.offset + opening.width), walls.get(opening.wallId)!.thickness + 2))} />
            {handle(alongWall(walls.get(opening.wallId)!, opening.offset), 'start')}
            {handle(alongWall(walls.get(opening.wallId)!, opening.offset + opening.width), 'end')}
          </g>
        )}
        {separator && <line className="selected" x1={separator.a.x} y1={separator.a.y} x2={separator.b.x} y2={separator.b.y} />}
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
