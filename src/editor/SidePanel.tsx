import { type InputHTMLAttributes, type ReactNode, useMemo, useState } from 'react';
import { copy } from '../copy';
import { dist } from '../model/geo';
import { canFinish } from '../model/finish';
import { isInside } from '../model/kind';
import { faceLength, formatCm, formatM2, type Metrics, parseCm, roomsOnSide } from '../model/measure';
import type { FinishPlace, Id, Opening, Plaster, Reason, Wall, WallClass, WallMaterial } from '../model/types';
import { type Extra, Legend, paintText } from './Legend';
import type { Finished, Lock } from './Overlay';
import type { EditorCtx, Selected } from './Tools';

const e = copy.editor;

export type Question = { type: 'split'; room: Id; parts: Id[]; name: string } | { type: 'merge'; room: Id; from: Id[]; names: string };

/**
 * A text field that takes what is typed on Enter or on leaving it. It keeps the focus; what is refused goes back to the
 * stored value; a stored value changed elsewhere (undo, say) shows at once.
 */
export function CommitField({ value, onCommit, ...rest }: { value: string; onCommit(text: string): boolean } & Omit<InputHTMLAttributes<HTMLInputElement>, 'value' | 'onChange'>) {
  const [text, setText] = useState(value);
  const [stored, setStored] = useState(value);
  if (stored !== value) {
    // adjusting to a new stored value while rendering, as React advises, rather than in an effect
    setStored(value);
    setText(value);
  }
  const take = () => {
    if (text !== value && !onCommit(text)) setText(value);
  };
  return <input {...rest} value={text} onChange={event => setText(event.target.value)} onBlur={take} onKeyDown={event => event.key === 'Enter' && take()} />;
}

function WallDetails({ c, id, onFix }: { c: EditorCtx; id: Id; onFix(lock: Lock): void }) {
  const s = c.project.existing;
  const w = s.walls.find(x => x.id === id);
  if (!w) return null;
  const lock = c.derived.locks.get(id);
  const cls: WallClass = c.project.wallClass[id] ?? 'unknown';
  // once per side and once per state, not on every pointer move: faces() is the costly part (R26, R30)
  const length = useMemo(() => {
    const beside = [...new Set([...roomsOnSide(s, id, 'A'), ...roomsOnSide(s, id, 'B')])];
    return beside.length ? Math.max(...beside.map(room => faceLength(s, room, id))) : dist(w.a, w.b);
  }, [s, id]);
  return (
    <section aria-labelledby="selected-title" data-testid="wall-details">
      <h2 id="selected-title">{paintText(c.derived.paints.get(id)!)}</h2>
      {lock ? (
        <p className="lock" data-testid="lock">
          {lock === 'envelope' ? e.envelopeLocked : e.mamadLocked}{' '}
          <button type="button" onClick={() => onFix(lock)}>{e.fix}</button>
        </p>
      ) : (
        <p data-testid="lock">{e.free}</p>
      )}
      <p>
        {e.length}: <strong>{e.cm(formatCm(length))}</strong> {copy.byDrawing}
      </p>
      <label>
        {e.thickness}{' '}
        <CommitField
          key={id}
          dir="ltr"
          inputMode="decimal"
          value={String(w.thickness / 10)}
          onCommit={text => {
            const mm = parseCm(text, { min: 20, max: 1000, decimals: 1 });
            if (mm === null) return (c.say(e.badThickness), false);
            return mm === w.thickness || c.run({ type: 'x.setWall', id, thickness: mm }).ok;
          }}
        />
      </label>
      <div role="group" aria-label={e.classLabel}>
        <span>
          {e.classLabel}: {e.classes[cls]}
        </span>
        {(['fixed', 'changeable', 'unknown'] as const).map(name => (
          <button key={name} type="button" aria-pressed={cls === name} onClick={() => cls !== name && c.run({ type: 'classify', wallId: id, cls: name })}>
            {e.classes[name]}
          </button>
        ))}
      </div>
      <Finishes c={c} w={w} />
      <label>
        {e.material}{' '}
        <select value={w.material ?? ''} onChange={event => c.run({ type: 'x.setWall', id, material: (event.target.value || null) as WallMaterial | null })}>
          <option value="">{e.noMaterial}</option>
          {(Object.keys(e.materials) as WallMaterial[]).map(m => (
            <option key={m} value={m}>
              {e.materials[m]}
            </option>
          ))}
        </select>
      </label>
    </section>
  );
}

const FIELD = { A: 'finishA', B: 'finishB', start: 'finishStart', end: 'finishEnd' } as const;
/**
 * The four finish fields of a wall: its two sides, named by the room each faces, and its two ends. A place where a finish
 * is not possible is disabled with the reason; a value kept there shows as not used (it is neither drawn nor counted).
 */
function Finishes({ c, w }: { c: EditorCtx; w: Wall }) {
  const s = c.project.existing;
  // once per state, not on every pointer move
  const places = useMemo((): [FinishPlace, string, string, boolean][] => {
    const side = (place: 'A' | 'B') => {
      const ids = roomsOnSide(s, w.id, place);
      const room = s.rooms.find(r => ids.includes(r.id) && isInside(r));
      return room ? e.finishSide(room.name || e.unnamed) : e.finishNoRoom;
    };
    return [
      ['A', side('A'), copy.reason['finish-outer-side']!, canFinish(s, w.id, 'A')],
      ['B', side('B'), copy.reason['finish-outer-side']!, canFinish(s, w.id, 'B')],
      ['start', e.finishStart, e.endJoined, canFinish(s, w.id, 'start')],
      ['end', e.finishEnd, e.endJoined, canFinish(s, w.id, 'end')],
    ];
  }, [s, w.id]);
  return (
    <fieldset className="finishes">
      <legend>{e.finish}</legend>
      {places.map(([place, label, why, on]) => {
        const mm = w[FIELD[place]] ?? null;
        return (
          <label key={place} data-place={place}>
            {label}{' '}
            <CommitField
              key={w.id}
              dir="ltr"
              inputMode="decimal"
              disabled={!on}
              value={mm === null ? '' : String(mm / 10)}
              onCommit={text => {
                const next = text.trim() === '' ? null : parseCm(text, { min: 1, max: 200, decimals: 1 });
                if (next === null && text.trim() !== '') return (c.say(e.badFinish), false);
                return next === mm || c.run({ type: 'setFinish', state: 'existing', wallId: w.id, side: place, mm: next }).ok;
              }}
            />
            {!on && <span className="why"> {mm === null ? why : e.notUsed}</span>}
          </label>
        );
      })}
    </fieldset>
  );
}

const LOCK_TEXT: Partial<Record<Reason, string>> = { 'window-locked': e.windowLocked, 'entry-door-locked': e.entryLocked, 'mamad-locked': e.mamadOpeningLocked };

/** An opening: its kind, its width, and its lock in words, with "תיקון", or "אישור" once released (owner R22, R23). */
function OpeningDetails({ c, id }: { c: EditorCtx; id: Id }) {
  const o = c.project.existing.openings.find(x => x.id === id);
  if (!o) return null;
  const lock = c.derived.openingLocks.get(id);
  return (
    <section aria-labelledby="selected-title" data-testid="opening-details">
      <h2 id="selected-title">{e.openingKinds[o.kind]}</h2>
      {lock ? (
        <p className="lock" data-testid="lock">
          {LOCK_TEXT[lock] ?? copy.reason[lock]}{' '}
          <button type="button" onClick={() => c.run({ type: 'x.releaseOpenings', ids: [id] })}>{e.fix}</button>
        </p>
      ) : o.released ? (
        <p className="lock" data-testid="lock">
          {e.openingOpen} <button type="button" onClick={() => c.run({ type: 'x.confirmOpenings', ids: [id] })}>{e.confirm}</button>
        </p>
      ) : (
        <p data-testid="lock">{e.free}</p>
      )}
      <div role="group" aria-label={e.openingKind}>
        <span>{e.openingKind}</span>
        {(['door', 'entry', 'window', 'passage'] as Opening['kind'][]).map(kind => (
          <button key={kind} type="button" aria-pressed={o.kind === kind} onClick={() => o.kind !== kind && c.run({ type: 'x.setOpening', id, kind })}>
            {e.openingKinds[kind]}
          </button>
        ))}
      </div>
      <label>
        {e.widthField}{' '}
        <CommitField
          key={id}
          dir="ltr"
          inputMode="decimal"
          value={String(Math.round(o.width) / 10)} // to the mm: a width from clicks is not a round number
          onCommit={text => {
            const mm = parseCm(text, { min: 10, max: 1_000_000, decimals: 1 });
            if (mm === null) return (c.say(e.badLength), false);
            return mm === o.width || c.run({ type: 'x.setOpening', id, width: mm }).ok;
          }}
        />
      </label>
      <p>
        {e.widthLabel}: <strong>{e.cm(formatCm(o.width))}</strong> {copy.byDrawing}
      </p>
    </section>
  );
}

function RoomDetails({ c, id, plaster, onFix, finished }: { c: EditorCtx; id: Id; plaster: Plaster | null; onFix(lock: Lock): void; finished: Finished | null }) {
  const room = c.project.existing.rooms.find(r => r.id === id);
  const gross = c.derived.gross.get(id);
  if (!room || !gross) return null;
  const net = finished?.net.get(id) ?? null;
  const m: Metrics = net ?? gross;
  return (
    <section aria-labelledby="selected-title" data-testid="room-details">
      <h2 id="selected-title">{e.room}</h2>
      <label>
        {e.roomName}{' '}
        <CommitField key={id} value={room.name} onCommit={name => c.run({ type: 'x.setRoom', id, name }).ok} />
      </label>
      <label>
        <input type="checkbox" checked={room.inApartment} onChange={event => c.run({ type: 'x.setRoom', id, inApartment: event.target.checked })} /> {e.inApartment}
      </label>
      <label>
        <input type="checkbox" checked={room.outdoor} onChange={event => c.run({ type: 'x.setRoom', id, outdoor: event.target.checked })} /> {e.outdoor}
      </label>
      <label>
        {/* taking the mark back is the mamad's "תיקון" (owner R14); while another room is the mamad the mark does not move (R18);
            with none marked, a tick is the "אישור" for this room (R19) */}
        <input
          type="checkbox"
          checked={room.isMamad}
          onChange={event =>
            !event.target.checked ? onFix('mamad')
            : c.project.existing.rooms.some(r => r.isMamad) ? c.say(e.mamadTaken)
            : c.run({ type: 'setMamad', room: id })
          }
        />{' '}
        {e.isMamad}
      </label>
      {net ? (
        <p data-testid="measurement">
          {e.resultWall}: <strong>{e.area(formatM2(gross.areaMm2))}</strong> {copy.byDrawing}
          <br />
          {e.resultNet}: <strong>{e.area(formatM2(net.areaMm2))}</strong> {copy.byDrawing}
        </p>
      ) : (
        <p data-testid="measurement">
          <strong>{e.area(formatM2(m.areaMm2))}</strong> {copy.byDrawing}
        </p>
      )}
      <p data-testid="measurement">
        {m.rect ? e.size(formatCm(m.rect.l), formatCm(m.rect.w)) : e.edges(m.edges.map(x => formatCm(x.mm)).join(', '))} {copy.byDrawing}
      </p>
      <p>{copy.plasterSentence[plaster ?? 'unknown']}</p>
    </section>
  );
}

function Asked({ c, question, onDone }: { c: EditorCtx; question: Question; onDone(): void }) {
  const [name, setName] = useState(() => c.project.existing.rooms.find(r => r.id === question.room)?.name ?? '');
  if (question.type === 'split') {
    const area = (id: Id) => formatM2(c.derived.gross.get(id)?.areaMm2 ?? 0);
    return (
      <section className="question" aria-live="polite">
        <p>{e.split(question.name)}</p>
        {question.parts.map((part, i) => (
          <button key={part} type="button" onClick={() => (part === question.room ? onDone() : c.run({ type: 'x.keepName', room: question.room, part }))}>
            {e.part(i + 1, area(part))}
          </button>
        ))}
      </section>
    );
  }
  return (
    <form className="question" aria-live="polite" onSubmit={event => (event.preventDefault(), c.run({ type: 'x.setRoom', id: question.room, name }))}>
      <label>
        {e.merge(question.names)} <input value={name} onChange={event => setName(event.target.value)} />
      </label>
      <button type="submit">{e.save}</button>
    </form>
  );
}

type Props = {
  c: EditorCtx;
  selected: Selected;
  message: string;
  question: Question | null;
  onQuestionDone(): void;
  /** The mamad, while its mark was taken back to correct its walls. */
  mamadWas: { id: Id; name: string } | null;
  onFix(lock: Lock): void;
  onConfirmMamad(): void;
  tool: ReactNode;
  plaster: Plaster | null;
  finished: Finished | null;
  /** Areas after the finishes, or up to the drawn walls (only while some finish exists). */
  net: boolean;
  onNet(net: boolean): void;
};

export function SidePanel({ c, selected, message, question, onQuestionDone, mamadWas, onFix, onConfirmMamad, tool, plaster, finished, net, onNet }: Props) {
  const s = c.project.existing;
  const paints = [...new Set(c.derived.paints.values())];
  const anyFinish = !!finished && finished.strips.size > 0;
  const locks = s.openings.map(o => !!c.derived.openingLocks.get(o.id));
  const extras: Extra[] = [
    ...(locks.some(Boolean) ? (['opening-locked'] as const) : []),
    ...(locks.some(x => !x) ? (['opening-free'] as const) : []),
    ...(s.openings.some(o => o.released || !o.confirmed) ? (['unconfirmed'] as const) : []),
    ...(s.separators.length ? (['separator'] as const) : []),
    ...(anyFinish ? (['finish'] as const) : []),
  ];
  return (
    <div className="editor-panel">
      {/* always there, empty unless something is said: a live region that appears with its text is not always read */}
      <p aria-live="polite" className="message" data-testid="message">{message}</p>
      {question && <Asked key={`${question.type}-${question.room}`} c={c} question={question} onDone={onQuestionDone} />}
      {c.project.envelope === 'released' && c.project.existing.rooms.some(isInside) && (
        <p className="lock">
          {e.envelopeOpen} <button type="button" onClick={() => c.run({ type: 'x.confirmEnvelope' })}>{e.confirm}</button>
        </p>
      )}
      {/* while the mark is taken back: after "אישור", or an undo of the release, no room is left unmarked */}
      {mamadWas && !c.project.existing.rooms.some(r => r.isMamad) && (
        <p className="lock">
          {e.mamadOpen(mamadWas.name)} <button type="button" onClick={onConfirmMamad}>{e.confirm}</button>
        </p>
      )}
      {tool}
      {selected?.kind === 'wall' && <WallDetails c={c} id={selected.id} onFix={onFix} />}
      {selected?.kind === 'opening' && <OpeningDetails c={c} id={selected.id} />}
      {selected?.kind === 'room' && <RoomDetails c={c} id={selected.id} plaster={plaster} onFix={onFix} finished={net ? finished : null} />}
      {/* the areas' statement and switch, only while some finish exists */}
      {anyFinish && (
        <div role="group" aria-label={e.areas} className="areas">
          <span data-testid="areas-statement">{net ? e.net : e.gross}</span>
          <button type="button" aria-pressed={net} onClick={() => onNet(true)}>{e.netButton}</button>
          <button type="button" aria-pressed={!net} onClick={() => onNet(false)}>{e.grossButton}</button>
        </div>
      )}
      <Legend paints={paints} extras={extras} />
    </div>
  );
}
