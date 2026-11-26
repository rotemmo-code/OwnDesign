import { type ReactNode, useMemo, useState } from 'react';
import { calibrationOf, fitCalibration } from '../calibrate/fit';
import { copy } from '../copy';
import { parseCm } from '../model/measure';
import type { Plaster } from '../model/types';
import type { Calibration, Dim, Vec } from '../shared';
import type { Tool } from './Canvas';
import { type Snap, type SnapIndex, snapPoint } from './snap';

const c = copy.calibrate;
const length = ([ax, ay]: Vec, [bx, by]: Vec) => Math.hypot(bx - ax, by - ay);
const ACCEPTED = ['ok', 'ok-offset', 'other-standard', 'nonstandard'];

/** Where a click will land: a square on an end or a crossing, a circle on a line, a cross on nothing. k: view points per CSS pixel. */
export function SnapMark({ snap: { at: [x, y], to }, k }: { snap: Snap; k: number }) {
  const r = 5 * k;
  if (to === 'end' || to === 'cross') return <rect className="snap" x={x - r} y={y - r} width={2 * r} height={2 * r} />;
  if (to === 'line') return <circle className="snap" cx={x} cy={y} r={r} />;
  return <path className="snap" d={`M${x - r} ${y - r}L${x + r} ${y + r}M${x - r} ${y + r}L${x + r} ${y - r}`} />;
}

/** A marked distance: the line, its ends, and a label above its middle. */
export function DimLine({ a, b, k, label }: { a: Vec; b: Vec; k: number; label?: string }) {
  const r = 2.5 * k;
  return (
    <g className="dim">
      <line x1={a[0]} y1={a[1]} x2={b[0]} y2={b[1]} />
      <rect x={a[0] - r} y={a[1] - r} width={2 * r} height={2 * r} />
      <rect x={b[0] - r} y={b[1] - r} width={2 * r} height={2 * r} />
      {label && (
        <text x={(a[0] + b[0]) / 2} y={(a[1] + b[1]) / 2 - 6 * k} fontSize={14 * k}>
          {label}
        </text>
      )}
    </g>
  );
}

/** Marking written dimensions until a scale is accepted, or taken unverified through the button. */
export function useCalibrate(index: SnapIndex, plaster: Plaster | null, onPlaster: (answer: Plaster) => void, onDone: (calibration: Calibration) => void): Tool {
  const [chosen, setChosen] = useState<50 | 100>(50);
  const [dims, setDims] = useState<Dim[]>([]);
  const [draft, setDraft] = useState<{ a: Vec; b?: Vec } | null>(null);
  const [text, setText] = useState('');
  const [wrong, setWrong] = useState(false);
  const [near, setNear] = useState<{ at: Vec; radius: number } | null>(null);
  const fit = useMemo(() => fitCalibration(dims, chosen), [dims, chosen]);
  const from = draft && !draft.b ? draft.a : undefined;
  const hovered = near && snapPoint(near.at, index, near.radius, from);

  const add = () => {
    const writtenMm = parseCm(text, { min: 10, max: 100_000, decimals: 1 });
    if (writtenMm === null || !draft?.b) return setWrong(true);
    setDims([...dims, { a: draft.a, b: draft.b, writtenMm }]);
    setDraft(null);
    document.querySelector<SVGSVGElement>('svg[role="application"]')?.focus(); // the keyboard goes on marking
  };
  const finish = (how: 'accept' | 'unverified') => {
    const calibration = calibrationOf(dims, chosen, how);
    if (calibration) onDone(calibration);
  };
  const accepted = ACCEPTED.includes(fit.status);
  const k = accepted ? fit.mmPerPt : (chosen * 25.4) / 72;

  const result = (): ReactNode => {
    if (!dims.length) return null;
    const s = fit.scale;
    switch (fit.status) {
      case 'ok':
      case 'ok-offset':
        return (
          <>
            <p>{fit.status === 'ok' ? c.ok(s) : c.offset(s, fit.offsetMm)}</p>
            <button type="button" className="go" onClick={() => finish('accept')}>{c.go(s)}</button>
          </>
        );
      case 'other-standard':
      case 'nonstandard':
        return (
          <>
            <p>{fit.status === 'other-standard' ? c.otherStandard(s, chosen) : c.nonstandard(s)}</p>
            {fit.near && <p className="warn">{c.near(fit.near)}</p>}
            <button type="button" className="go" onClick={() => finish('accept')}>{c.confirm(s)}</button>
          </>
        );
      case 'invalid':
        return <p className="warn">{c.invalid(fit.problem!.index + 1, c.problem[fit.problem!.why])}</p>;
      case 'inconsistent':
        return <p className="warn">{c.inconsistent}</p>;
      default:
        return (
          <>
            <p className={fit.need === 'offset' ? 'warn' : undefined}>{c.need[fit.need === 'ambiguous' ? 'spread' : fit.need!]}</p>
            {fit.unverified && (
              <>
                <p>{c.noMoreNote(fit.unverified.scale)}</p>
                <button type="button" onClick={() => finish('unverified')}>{c.noMore}</button>
              </>
            )}
          </>
        );
    }
  };

  const panel = (
    <section aria-labelledby="calibrate-title">
      <h2 id="calibrate-title">{c.title}</h2>
      <div role="group" aria-label={c.scaleQuestion}>
        <span>{c.scaleQuestion}</span>
        {([50, 100] as const).map(s => (
          <button key={s} type="button" aria-pressed={chosen === s} onClick={() => setChosen(s)}>{c.scale(s)}</button>
        ))}
      </div>
      <div role="group" aria-label={c.plasterQuestion}>
        <span>{c.plasterQuestion}</span>
        {(['none', 'line', 'inWall', 'unknown'] as const).map(answer => (
          <button key={answer} type="button" aria-pressed={plaster === answer} onClick={() => onPlaster(answer)}>{c.plaster[answer]}</button>
        ))}
      </div>
      {draft?.b ? (
        <form
          onSubmit={event => {
            event.preventDefault();
            add();
          }}
        >
          <label>
            {c.written}{' '}
            <input
              autoFocus
              inputMode="decimal"
              dir="ltr"
              value={text}
              aria-invalid={wrong}
              aria-describedby="written-error"
              onChange={event => setText(event.target.value)}
              onKeyDown={event => event.key === 'Escape' && setDraft(null)}
            />
          </label>
          <button type="submit">{c.add}</button>
          <button type="button" onClick={() => setDraft(null)}>{c.cancel}</button>
          <p id="written-error" aria-live="assertive">{wrong ? c.badNumber : ''}</p>
        </form>
      ) : (
        <p aria-live="polite">
          {draft ? c.second : c.first}
          {draft && (
            <>
              {' '}
              <button type="button" onClick={() => setDraft(null)}>{c.cancel}</button>
            </>
          )}
        </p>
      )}
      {dims.length > 0 && (
        <ol aria-label={c.list}>
          {dims.map((dim, i) => (
            <li key={i} className={fit.problem?.index === i ? 'bad' : undefined}>
              <span>{c.row(dim.writtenMm, k * length(dim.a, dim.b))}</span>
              {!fit.used[i] && <span> {c.short}</span>}
              {fit.problem?.index === i && <strong> {c.problem[fit.problem.why]}</strong>}
              <button type="button" aria-label={c.removeLabel(i + 1)} onClick={() => setDims(dims.filter((_, j) => j !== i))}>{c.remove}</button>
            </li>
          ))}
        </ol>
      )}
      <div aria-live="polite" data-testid="fit">{result()}</div>
    </section>
  );

  return {
    pick: (at, radius) => {
      const { at: point } = snapPoint(at, index, radius, from);
      setDraft(from ? { a: from, b: point } : { a: point });
      setText('');
      setWrong(false);
    },
    hover: (at, radius) => setNear(at && { at, radius }),
    marks: ptPerPx => (
      <>
        {dims.map((dim, i) => <DimLine key={i} a={dim.a} b={dim.b} k={ptPerPx} label={String(i + 1)} />)}
        {draft && <DimLine a={draft.a} b={draft.b ?? hovered?.at ?? draft.a} k={ptPerPx} />}
        {hovered && !draft?.b && <SnapMark snap={hovered} k={ptPerPx} />}
      </>
    ),
    panel,
  };
}
