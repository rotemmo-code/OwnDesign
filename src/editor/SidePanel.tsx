import { type KeyboardEvent, type ReactNode, useMemo, useState } from 'react';
import { copy } from '../copy';
import { dist } from '../model/geo';
import { canFinish } from '../model/finish';
import { isInside } from '../model/kind';
import { faceLength, formatCm, formatM2, type Metrics, parseCm, roomsOnSide } from '../model/measure';
import type { FinishPlace, Id, Opening, Plaster, Pt, Reason, Wall, WallClass, WallMaterial } from '../model/types';
import type { Box } from '../pdf/render';
import { CheckList } from './CheckList';
import { CommitField } from './CommitField';
import { type ContractorColour, type Extra, Legend, paintText } from './Legend';
import type { Finished, Lock, Stretch } from './Overlay';
import { wallAt } from './snap';
import { COLOR } from '../theme';
import type { EditorCtx, Selected } from './Tools';

const e = copy.editor;

export type Question = { type: 'split'; room: Id; parts: Id[]; name: string } | { type: 'merge'; room: Id; from: Id[]; names: string };

function WallDetails({ c, id, onFix, suggested }: { c: EditorCtx; id: Id; onFix(lock: Lock): void; suggested: boolean }) {
  const s = c.project.existing;
  const w = s.walls.find(x => x.id === id);
  // once per side and once per state, not on every pointer move: faces() is the costly part (R26, R30)
  const sides = useMemo(() => {
    if (!w) return null;
    const rooms = { A: roomsOnSide(s, id, 'A'), B: roomsOnSide(s, id, 'B') };
    const beside = [...new Set([...rooms.A, ...rooms.B])];
    return { rooms, length: beside.length ? Math.max(...beside.map(room => faceLength(s, room, id))) : dist(w.a, w.b) };
  }, [s, id]);
  if (!w || !sides) return null;
  const { length } = sides;
  const lock = c.derived.locks.get(id);
  const cls: WallClass = c.project.wallClass[id] ?? 'unknown';
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
      <Review c={c} id={id} review={w.review} />
      <div role="group" aria-label={e.classLabel}>
        <span>
          {e.classLabel}: {e.classes[cls]}
        </span>
        {suggested && (
          <span data-testid="suggestion">
            {e.suggest} <button type="button" onClick={() => c.run({ type: 'classify', wallId: id, cls: 'fixed' })}>{e.acceptOne}</button>
          </span>
        )}
        {(['fixed', 'changeable', 'unknown'] as const).map(name => (
          <button key={name} type="button" aria-pressed={cls === name} onClick={() => cls !== name && c.run({ type: 'classify', wallId: id, cls: name })}>
            {e.classes[name]}
          </button>
        ))}
      </div>
      <Finishes c={c} w={w} sides={sides.rooms} />
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

/** mm: an end this close to another wall's body is joined to it. */
const JOINED_MM = 2;
const FIELD = { A: 'finishA', B: 'finishB', start: 'finishStart', end: 'finishEnd' } as const;
/**
 * The four finish fields of a wall: its two sides, named by the room each faces, and its two ends. A place where a finish
 * is not possible is disabled with the reason; a value kept there shows as not used (it is neither drawn nor counted).
 */
function Finishes({ c, w, sides }: { c: EditorCtx; w: Wall; sides: Record<'A' | 'B', Id[]> }) {
  const s = c.project.existing;
  // once per state, not on every pointer move
  const places = useMemo((): [FinishPlace, string, string, boolean][] => {
    const side = (place: 'A' | 'B') => {
      const room = s.rooms.find(r => sides[place].includes(r.id) && isInside(r));
      return room ? e.finishSide(room.name || e.unnamed) : e.finishNoRoom;
    };
    // canFinish gives no reason for an end: an end that meets another wall is joined, any other end stands where no room
    // of the apartment is (none drawn, or not ticked as the apartment's, or outdoors)
    const others = s.walls.filter(x => x.id !== w.id);
    const endWhy = (p: Pt) => (wallAt(p, others, JOINED_MM) ? e.endJoined : e.endNoRoom);
    return [
      ['A', side('A'), copy.reason['finish-outer-side']!, canFinish(s, w.id, 'A')],
      ['B', side('B'), copy.reason['finish-outer-side']!, canFinish(s, w.id, 'B')],
      ['start', e.finishStart, endWhy(w.a), canFinish(s, w.id, 'start')],
      ['end', e.finishEnd, endWhy(w.b), canFinish(s, w.id, 'end')],
    ];
  }, [s, w, sides]);
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

/** An item the detector doubts: the word לבדיקה, and נבדק (R36). */
const Review = ({ c, id, review }: { c: EditorCtx; id: Id; review: boolean }) =>
  review && (
    <p data-testid="review">
      {e.review} <button type="button" onClick={() => c.run({ type: 'x.clearReview', id })}>{e.reviewed}</button>
    </p>
  );

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
      <Review c={c} id={id} review={o.review} />
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

export type Tab = 'details' | 'check';
type Props = {
  c: EditorCtx;
  selected: Selected;
  message: string;
  question: Question | null;
  onQuestionDone(): void;
  /** The mamad, while its mark was taken back; fix: by its "תיקון", else the model cleared it. */
  mamadWas: { id: Id; name: string; fix: boolean } | null;
  onFix(lock: Lock): void;
  onConfirmMamad(): void;
  tool: ReactNode;
  plaster: Plaster | null;
  finished: Finished | null;
  /** Areas after the finishes, or up to the drawn walls (only while some finish exists). */
  net: boolean;
  onNet(net: boolean): void;
  tab: Tab;
  onTab(tab: Tab): void;
  onShow(sel: Selected, box: Box): void;
  colours: ContractorColour[];
  /** The walls suggested as fixed, computed a moment after an edit and only for the details tab (R48). */
  suggested: Set<Id>;
  /** What the outer walls' "אישור" locks, while the check tab is open; null until known. */
  stretches: Stretch[] | null;
};

const TABS: [Tab, string][] = [
  ['details', e.detailsTab],
  ['check', e.checkTab],
];

/** The message, the open questions and rows, then two tabs: the details of what is selected, and the check before approval. */
export function SidePanel(props: Props) {
  const { c, message, question, onQuestionDone, mamadWas, onConfirmMamad, tab, onTab } = props;
  // the tab pattern: arrows move to the other tab and open it, Home and End to the first and last (R41)
  const key = (event: KeyboardEvent<HTMLButtonElement>) => {
    const i = TABS.findIndex(([name]) => name === tab);
    const to = { ArrowLeft: i + 1, ArrowRight: i - 1, Home: 0, End: TABS.length - 1 }[event.key];
    if (to === undefined) return;
    event.preventDefault();
    const [name] = TABS[(to + TABS.length) % TABS.length];
    onTab(name);
    document.getElementById(`tab-${name}`)?.focus();
  };
  return (
    <div className="editor-panel">
      {/* the panel's text scrolls; the legend under it is always in view, in both tabs, and covers nothing (S1) */}
      <div className="panel-body">
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
          <p className="lock" data-testid="mamad-row">
            {/* a mark the model cleared (its room merged) was no "תיקון": it is marked again by hand */}
            {mamadWas.fix ? (
              <>
                {e.mamadOpen(mamadWas.name)} <button type="button" onClick={onConfirmMamad}>{e.confirm}</button>
              </>
            ) : (
              e.mamadChanged
            )}
          </p>
        )}
        <div role="tablist" className="panel-tabs" aria-label={e.panelTabs}>
          {TABS.map(([name, text]) => (
            <button key={name} id={`tab-${name}`} type="button" role="tab" aria-selected={tab === name} aria-controls="tab-panel" tabIndex={tab === name ? 0 : -1} onClick={() => onTab(name)} onKeyDown={key}>
              {text}
            </button>
          ))}
        </div>
        <div role="tabpanel" id="tab-panel" aria-labelledby={`tab-${tab}`}>
          {tab === 'check' ? <CheckList c={c} onFix={props.onFix} onShow={props.onShow} stretches={props.stretches} /> : <Details {...props} />}
        </div>
      </div>
      <PanelLegend {...props} />
    </div>
  );
}

/** The legend of every paint on the drawing; in the details tab with the suggestions too (R48). */
function PanelLegend({ c, finished, colours, suggested, tab, stretches }: Props) {
  const s = c.project.existing;
  const paints = [...new Set(c.derived.paints.values())];
  const anyFinish = !!finished && finished.strips.size > 0;
  // as OpeningShape paints them: a locked one on an outer or mamad wall, a locked one on an inner wall, a free one
  const kindOf = (o: Opening) => c.derived.kinds.get(o.wallId) ?? 'existing';
  const paintOf = (o: Opening): Extra => (!c.derived.openingLocks.get(o.id) ? 'opening-free' : kindOf(o) === 'existing' ? 'opening-locked-inner' : 'opening-locked');
  const openingPaints = new Set(s.openings.map(paintOf));
  const lockedKinds = new Set(s.openings.filter(o => paintOf(o) === 'opening-locked').map(kindOf));
  const extras: Extra[] = [
    ...(['opening-locked', 'opening-locked-inner', 'opening-free'] as const).filter(x => openingPaints.has(x)),
    ...(s.openings.some(o => o.released || !o.confirmed) ? (['unconfirmed'] as const) : []),
    ...(s.openings.some(o => o.review) || s.walls.some(w => w.review) ? (['review'] as const) : []),
    ...(tab === 'check' && stretches?.length ? (['outer'] as const) : []),
    ...(s.separators.length ? (['separator'] as const) : []),
    ...(anyFinish ? (['finish'] as const) : []),
  ];
  const acceptAll = () => c.runAll([...suggested].map(wallId => ({ type: 'classify', wallId, cls: 'fixed' }) as const));
  return (
    <Legend
      paints={paints}
      extras={extras}
      lockedColours={(['exterior', 'mamad'] as const).filter(k => lockedKinds.has(k)).map(k => COLOR[k])}
      suggest={tab === 'details' ? { n: suggested.size, onAccept: acceptAll } : undefined}
      colours={colours}
      onLabel={(hex, label) => c.run({ type: 'n.setColorLabel', hex, label }).ok}
    />
  );
}

/** The details tab: the tool's panel, what is selected, the areas' switch. */
function Details({ c, selected, onFix, tool, plaster, finished, net, onNet, suggested }: Props) {
  const anyFinish = !!finished && finished.strips.size > 0;
  return (
    <>
      {tool}
      {selected?.kind === 'wall' && <WallDetails c={c} id={selected.id} onFix={onFix} suggested={suggested.has(selected.id)} />}
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
    </>
  );
}
