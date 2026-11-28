import { useId, useMemo } from 'react';
import { copy } from '../copy';
import { CommitField } from './CommitField';
import type { WallClass } from '../model/types';
import { COLOR, KIND_STYLE, type WallKind } from '../theme';

/**
 * What a wall is painted as (owner, round 12: told by paint, no marks). Outer and mamad walls, and planned kinds, by their
 * kind; an inner wall by its class: fixed dark, changeable in the existing colour, unknown lighter with a dashed outline.
 */
export type PaintName = WallKind | 'fixed' | 'unknown';
export type Paint = { fill: string; stroke: string; strokeDasharray?: string; fillOpacity?: number };
/** The ids of one set of patterns: each set mounted gets its own, so that two sets never share an id (R26). */
export type PaintIds = { added: string; finish: string };

export const paintOf = (kind: WallKind, cls: WallClass): PaintName => (kind !== 'existing' ? kind : cls === 'changeable' ? 'existing' : cls);

/** The same object for the life of the component: the memoised walls compare their props by identity. */
export function usePaintIds(): PaintIds {
  const raw = useId();
  return useMemo(() => {
    const id = raw.replace(/[^a-zA-Z0-9]/g, '');
    return { added: `hatch-added-${id}`, finish: `hatch-finish-${id}` };
  }, [raw]);
}

/** The SVG hatch patterns the paints use; colours from COLOR only. size: the hatch's spacing in the user units where it is used. */
export function PaintDefs({ ids, size = 8 }: { ids: PaintIds; size?: number }) {
  return (
    <defs>
      <pattern id={ids.added} patternUnits="userSpaceOnUse" width={size} height={size} patternTransform="rotate(45)">
        <line x1="0" y1="0" x2="0" y2={size} stroke={COLOR.added} strokeWidth={size * 0.375} />
      </pattern>
      <pattern id={ids.finish} patternUnits="userSpaceOnUse" width={size} height={size} patternTransform="rotate(-45)">
        <rect width={size} height={size} fill={COLOR.paper} />
        <line x1="0" y1="0" x2="0" y2={size} stroke={COLOR.finish} strokeWidth={size * 0.375} />
      </pattern>
    </defs>
  );
}

export function wallPaint(name: PaintName, ids: PaintIds): Paint {
  if (name === 'fixed') return { fill: COLOR.fixed, stroke: COLOR.fixed };
  if (name === 'unknown') return { fill: COLOR.existing, fillOpacity: 0.35, stroke: COLOR.existing, strokeDasharray: '6 4' };
  const style = KIND_STYLE[name];
  return {
    fill: style.fill === 'solid' ? COLOR[name] : style.fill === 'hatch' ? `url(#${ids.added})` : 'none',
    stroke: COLOR[name],
    ...(style.dashed ? { strokeDasharray: '6 4' } : {}),
  };
}
export const finishPaint = (ids: PaintIds): Paint => ({ fill: `url(#${ids.finish})`, stroke: COLOR.finish });

export const paintText = (name: PaintName): string =>
  name === 'fixed' ? copy.editor.paints.fixed : name === 'unknown' ? copy.editor.paints.unknown : name === 'existing' ? copy.editor.paints.changeable : copy.editor.kinds[name];

const ORDER: PaintName[] = ['exterior', 'mamad', 'fixed', 'existing', 'unknown', 'moved', 'added', 'removed'];
/** The other things on the drawing that have a paint of their own (R22). */
export type Extra = 'opening-locked' | 'opening-locked-inner' | 'opening-free' | 'unconfirmed' | 'review' | 'separator' | 'finish';
const EXTRAS: Extra[] = ['opening-locked', 'opening-locked-inner', 'opening-free', 'unconfirmed', 'review', 'separator', 'finish'];
const ARC = 'M3 13H13A10 10 0 0 0 3 3Z';

/** lockedColours: the colours of the walls that hold a locked opening (outer, mamad), one arc each (R46). */
function ExtraSwatch({ extra, ids, lockedColours }: { extra: Extra; ids: PaintIds; lockedColours: string[] }) {
  if (extra === 'separator') return <line x1="2" y1="8" x2="30" y2="8" stroke={COLOR.ink} strokeWidth="1" />;
  if (extra === 'finish') return <rect x="1" y="2" width="30" height="12" strokeWidth="1.5" {...finishPaint(ids)} />;
  if (extra === 'review') return <rect x="1" y="2" width="30" height="12" fill="none" stroke={COLOR.ink} strokeWidth="1.5" strokeDasharray="3 2" />;
  if (extra === 'opening-locked') return <>{lockedColours.map((stroke, i) => <path key={stroke} d={ARC} transform={`translate(${i * 16} 0)`} fill="none" stroke={stroke} strokeWidth="1.5" />)}</>;
  const stroke = { 'opening-locked-inner': COLOR.fixed, 'opening-free': COLOR.existing, unconfirmed: COLOR.ink }[extra];
  return <path d={ARC} fill="none" stroke={stroke} strokeWidth="1.5" strokeDasharray={extra === 'unconfirmed' ? '3 2' : undefined} />;
}
const extraText = (extra: Extra) =>
  ({ 'opening-locked': copy.editor.lockedOpening, 'opening-locked-inner': copy.editor.lockedInnerOpening, 'opening-free': copy.editor.freeOpening, unconfirmed: copy.editor.unconfirmed, review: copy.editor.review, separator: copy.editor.separatorLegend, finish: copy.editor.finishLegend })[extra];

/** A colour of the contractor's drawing. label: what she says it means; absent for one that cannot be labelled. */
export type ContractorColour = { hex: string; label?: string };
const HEX = /^#[0-9a-f]{6}$/;

type LegendProps = {
  paints: PaintName[];
  extras?: Extra[];
  lockedColours?: string[];
  /** The walls suggested as fixed, with the one action that accepts them all (in the class area). */
  suggest?: { n: number; onAccept(): void };
  colours?: ContractorColour[];
  onLabel?(hex: string, label: string): boolean;
};

/**
 * Every paint on the drawing, each with a swatch drawn with the same paint and its words; the suggestions; the
 * contractor's colours, a swatch only for #rrggbb (any other text is never a colour on the page).
 */
export function Legend({ paints, extras = [], lockedColours = [COLOR.exterior], suggest, colours = [], onLabel }: LegendProps) {
  const ids = usePaintIds();
  const shown = ORDER.filter(name => paints.includes(name));
  return (
    <section className="legend" aria-labelledby="legend-title">
      <h2 id="legend-title">{copy.editor.legend}</h2>
      {/* one set of patterns for all the swatches */}
      <svg width="0" height="0" aria-hidden="true" className="defs">
        <PaintDefs ids={ids} />
      </svg>
      <ul>
        {shown.map(name => (
          <li key={name} data-paint={name}>
            <svg width="32" height="16" aria-hidden="true">
              <rect x="1" y="2" width="30" height="12" strokeWidth="1.5" {...wallPaint(name, ids)} />
            </svg>
            <span>{paintText(name)}</span>
          </li>
        ))}
        {EXTRAS.filter(x => extras.includes(x)).map(extra => (
          <li key={extra} data-paint={extra}>
            <svg width="32" height="16" aria-hidden="true">
              <ExtraSwatch extra={extra} ids={ids} lockedColours={lockedColours} />
            </svg>
            <span>{extraText(extra)}</span>
          </li>
        ))}
      </ul>
      {suggest && suggest.n > 0 && (
        <p data-testid="suggestions">
          {copy.editor.suggestWhy}{' '}
          <button type="button" onClick={suggest.onAccept}>{copy.editor.acceptAll(suggest.n)}</button>
        </p>
      )}
      {colours.length > 0 && (
        <details>
          <summary>{copy.editor.colours}</summary>
          <ul>
            {colours.map(({ hex, label }) => (
              <li key={hex}>
                {HEX.test(hex) && (
                  <svg width="32" height="16" aria-hidden="true">
                    <rect x="1" y="2" width="30" height="12" fill={hex} stroke={COLOR.ink} strokeWidth="1" />
                  </svg>
                )}
                {HEX.test(hex) && label !== undefined && onLabel ? (
                  <label>
                    {copy.editor.colourMeans(hex)} <CommitField value={label} maxLength={200} placeholder={copy.editor.colourExample} onCommit={text => onLabel(hex, text)} />
                  </label>
                ) : (
                  <bdi dir="ltr">{hex}</bdi>
                )}
              </li>
            ))}
          </ul>
        </details>
      )}
    </section>
  );
}
