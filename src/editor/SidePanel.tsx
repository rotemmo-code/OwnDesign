import { type InputHTMLAttributes, type ReactNode, useState } from 'react';
import { copy } from '../copy';
import { dist } from '../model/geo';
import { isInside } from '../model/kind';
import { faceLength, formatCm, formatM2, parseCm, roomsOnSide } from '../model/measure';
import type { Id, Plaster, WallClass, WallMaterial } from '../model/types';
import { Legend, paintText } from './Legend';
import type { Lock } from './Overlay';
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
  // once per side, never once per room: faces() is the costly part
  const beside = [...new Set([...roomsOnSide(s, id, 'A'), ...roomsOnSide(s, id, 'B')])];
  const length = beside.length ? Math.max(...beside.map(room => faceLength(s, room, id))) : dist(w.a, w.b);
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

function RoomDetails({ c, id, plaster, onFix }: { c: EditorCtx; id: Id; plaster: Plaster | null; onFix(lock: Lock): void }) {
  const room = c.project.existing.rooms.find(r => r.id === id);
  const m = c.derived.gross.get(id);
  if (!room || !m) return null;
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
        {/* taking the mark back is the mamad's "תיקון" (owner R14): its row with "אישור" follows */}
        <input type="checkbox" checked={room.isMamad} onChange={event => (event.target.checked ? c.run({ type: 'setMamad', room: id }) : onFix('mamad'))} /> {e.isMamad}
      </label>
      <p data-testid="measurement">
        <strong>{e.area(formatM2(m.areaMm2))}</strong> {copy.byDrawing}
      </p>
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
};

export function SidePanel({ c, selected, message, question, onQuestionDone, mamadWas, onFix, onConfirmMamad, tool, plaster }: Props) {
  const paints = [...new Set(c.derived.paints.values())];
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
      {selected?.kind === 'room' && <RoomDetails c={c} id={selected.id} plaster={plaster} onFix={onFix} />}
      <Legend paints={paints} />
    </div>
  );
}
