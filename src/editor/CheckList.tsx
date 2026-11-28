import { memo, type ReactNode } from 'react';
import { copy } from '../copy';
import { corners } from '../model/geo';
import { formatCm, formatM2, roomsOnSide } from '../model/measure';
import type { Id, Opening, Project, Pt, Room } from '../model/types';
import type { Box } from '../pdf/render';
import type { Lock, Stretch } from './Overlay';
import { alongWall } from './snap';
import type { EditorCtx, Selected } from './Tools';

const e = copy.editor;

type Props = {
  c: EditorCtx;
  onFix(lock: Lock): void;
  /** Select the item and fit the view to its box, in view points. */
  onShow(sel: Selected, box: Box): void;
  /** What the outer walls' "אישור" locks (R50); null while it is worked out, a moment after the tab opens. */
  stretches: Stretch[] | null;
};

/** The box of some points in mm, in view points. */
const boxOf = (points: Pt[], k: number): Box => {
  const xs = points.map(p => p.x / k);
  const ys = points.map(p => p.y / k);
  const [x, y] = [Math.min(...xs), Math.min(...ys)];
  return [x, y, Math.max(...xs) - x, Math.max(...ys) - y];
};
const Button = ({ text, onClick }: { text: string; onClick(): void }) => (
  <button type="button" onClick={onClick}>
    {text}
  </button>
);
const done = (o: Opening) => o.confirmed && !o.released;
/**
 * What the progress line counts (R49): what holds approval back in Task 12, as the model's confirmationGaps reads it,
 * and the mamad's answer. An opening beside a room of the apartment, or one released anywhere; the outer walls; the
 * mamad. "All" exactly when confirmationGaps is empty and the mamad is answered.
 */
export function checkProgress(p: Project): { n: number; m: number; counted: Set<Id> } {
  const s = p.existing;
  const apartment = new Set(s.rooms.filter(r => r.inApartment).map(r => r.id));
  const beside = (o: Opening) => (['A', 'B'] as const).some(side => roomsOnSide(s, o.wallId, side).some(id => apartment.has(id)));
  const counted = s.openings.filter(o => o.released || beside(o));
  const answered = s.rooms.some(r => r.isMamad) || p.mamad === 'none';
  const n = counted.filter(done).length + (p.envelope === 'confirmed' ? 1 : 0) + (answered ? 1 : 0);
  return { n, m: counted.length + 2, counted: new Set(counted.map(o => o.id)) };
}
const roomText = (c: EditorCtx, r: Room) => `${r.name || e.unnamed} ${e.m2(formatM2(c.derived.gross.get(r.id)?.areaMm2 ?? 0))}`;

/**
 * The check before approval (7E): six steps, each through the same actions as the details tab, so that a locked item
 * refuses with its note until "תיקון" (R38). "אישור הכול" confirms only what is unconfirmed or released.
 */
function List({ c, onFix, onShow, stretches }: Props) {
  const p = c.project;
  const s = p.existing;
  const marked = s.rooms.find(r => r.isMamad);
  const progress = checkProgress(p);
  const walls = new Map(s.walls.map(w => [w.id, w]));
  // the gap, and a door's swing too (as OpeningShape draws it)
  const openingBox = (o: Opening) => {
    const w = walls.get(o.wallId)!;
    const [a, b] = [alongWall(w, o.offset), alongWall(w, o.offset + o.width)];
    const n = { x: -(b.y - a.y), y: b.x - a.x }; // the width long, across the wall
    const swing = o.kind === 'door' || o.kind === 'entry' ? [{ x: a.x + n.x, y: a.y + n.y }, { x: b.x + n.x, y: b.y + n.y }] : [];
    return boxOf([...corners(a, b, w.thickness), ...swing], c.k);
  };
  // while a room is the mamad its mark does not move (R18); after its "תיקון" a choice is the answer (R19, R39)
  const choose = (room: Id | 'none') => (marked ? marked.id !== room && c.say(e.mamadTaken) : p.mamad !== room && c.run({ type: 'setMamad', room })); // the answer again changes nothing (M3)
  const openings = (kinds: Opening['kind'][], empty: string) => {
    const list = s.openings.filter(o => kinds.includes(o.kind));
    const open = list.filter(o => !done(o)).map(o => o.id);
    if (!list.length) return <p>{empty}</p>;
    return (
      <>
        <ul>
          {list.map(o => {
            const n = s.openings.filter(x => x.kind === o.kind).indexOf(o) + 1;
            const lock = c.derived.openingLocks.get(o.id);
            return (
              <li key={o.id} data-item={o.id}>
                {e.item(e.openingKinds[o.kind], n, formatCm(o.width))}{' '}
                {progress.counted.has(o.id) ? <span data-testid="status">{done(o) ? e.confirmed : e.notConfirmed}</span> : <span data-testid="not-needed">{e.notNeeded}</span>}
                {o.review && <span data-testid="review"> {e.review}</span>}
                <span className="row">
                  <Button text={e.show} onClick={() => onShow({ kind: 'opening', id: o.id }, openingBox(o))} />
                  {!done(o) && <Button text={e.confirm} onClick={() => c.run({ type: 'x.confirmOpenings', ids: [o.id] })} />}
                  {lock && <Button text={e.fix} onClick={() => c.run({ type: 'x.releaseOpenings', ids: [o.id] })} />}
                  <Button text={e.remove} onClick={() => c.run({ type: 'x.deleteOpening', id: o.id })} />
                  {o.review && <Button text={e.reviewed} onClick={() => c.run({ type: 'x.clearReview', id: o.id })} />}
                </span>
              </li>
            );
          })}
        </ul>
        {open.length > 0 && (
          <p className="row">
            <Button text={e.confirmAll} onClick={() => c.run({ type: 'x.confirmOpenings', ids: open })} />
          </p>
        )}
      </>
    );
  };
  const step = (name: keyof typeof e.steps, body: ReactNode) => (
    <section data-step={name} aria-labelledby={`step-${name}`}>
      <h3 id={`step-${name}`}>{e.steps[name]}</h3>
      {body}
    </section>
  );
  return (
    <div className="check" data-testid="check">
      <p aria-live="polite" data-testid="progress">
        <strong>{e.progress(progress.n, progress.m)}</strong>
      </p>
      {step(
        'rooms',
        <>
          <p>{s.rooms.length ? e.roomsHow : e.noRooms}</p>
          <ul>
            {s.rooms.map(r => (
              <li key={r.id} data-item={r.id}>
                <label>
                  <input type="checkbox" checked={r.inApartment} onChange={event => c.run({ type: 'x.setRoom', id: r.id, inApartment: event.target.checked })} /> {roomText(c, r)}
                </label>{' '}
                <Button text={e.show} onClick={() => onShow({ kind: 'room', id: r.id }, boxOf(r.boundary, c.k))} />
              </li>
            ))}
          </ul>
        </>,
      )}
      {step(
        'mamad',
        <>
          <p data-testid="mamad-answer">{marked ? e.mamadIs(marked.name || e.unnamed) : p.mamad === 'none' ? e.noMamad : ''}</p>
          <div role="group" aria-label={e.mamadQuestion}>
            <span>{e.mamadQuestion}</span>
            {s.rooms.map(r => (
              <button key={r.id} type="button" aria-pressed={r.isMamad} onClick={() => choose(r.id)}>
                {roomText(c, r)}
              </button>
            ))}
            <button type="button" aria-pressed={!marked && p.mamad === 'none'} onClick={() => choose('none')}>
              {e.noMamad}
            </button>
          </div>
          {marked && (
            <p className="row">
              <Button text={e.fix} onClick={() => onFix('mamad')} />
            </p>
          )}
        </>,
      )}
      {step('entry', openings(['entry'], e.noEntry))}
      {step('doors', openings(['door', 'passage'], e.noDoors))}
      {step('windows', openings(['window'], e.noWindows))}
      {step(
        'envelope',
        <>
          <p>{e.outerHow}</p>
          {stretches?.length === 0 && <p>{e.noOuter}</p>}
          {!!stretches?.length && (
            <ul>
              <li data-item="envelope">
                {e.allOuter} <span data-testid="status">{p.envelope === 'confirmed' ? e.confirmed : e.notConfirmed}</span>
                <span className="row">
                  <Button text={e.show} onClick={() => onShow(null, boxOf(stretches.flatMap(x => x.ring), c.k))} />
                  {p.envelope !== 'confirmed' && <Button text={e.confirm} onClick={() => c.run({ type: 'x.confirmEnvelope' })} />}
                  {p.envelope !== 'released' && <Button text={e.fix} onClick={() => onFix('envelope')} />}
                </span>
              </li>
            </ul>
          )}
        </>,
      )}
    </div>
  );
}

/** Drawn again only when the project, what is derived from it or the selection changes: not on a pointer move (R43). */
export const CheckList = memo(List, (a, b) => a.c.project === b.c.project && a.c.derived === b.c.derived && a.c.selected === b.c.selected && a.stretches === b.stretches);
