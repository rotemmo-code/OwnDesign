import { copy } from '../copy';
import type { WallClass } from '../model/types';
import { COLOR, KIND_STYLE, type WallKind } from '../theme';

/**
 * What a wall is painted as (owner, round 12: told by paint, no marks). Outer and mamad walls, and planned kinds, by their
 * kind; an inner wall by its class: fixed dark, changeable in the existing colour, unknown lighter with a dashed outline.
 */
export type PaintName = WallKind | 'fixed' | 'unknown';
export type Paint = { fill: string; stroke: string; strokeDasharray?: string; fillOpacity?: number };

export const paintOf = (kind: WallKind, cls: WallClass): PaintName => (kind !== 'existing' ? kind : cls === 'changeable' ? 'existing' : cls);

/** The SVG hatch patterns the paints use; colours from COLOR only. */
export function PaintDefs() {
  return (
    <defs>
      <pattern id="hatch-added" patternUnits="userSpaceOnUse" width="8" height="8" patternTransform="rotate(45)">
        <line x1="0" y1="0" x2="0" y2="8" stroke={COLOR.added} strokeWidth="3" />
      </pattern>
    </defs>
  );
}

export function wallPaint(name: PaintName): Paint {
  if (name === 'fixed') return { fill: COLOR.fixed, stroke: COLOR.fixed };
  if (name === 'unknown') return { fill: COLOR.existing, fillOpacity: 0.35, stroke: COLOR.existing, strokeDasharray: '6 4' };
  const style = KIND_STYLE[name];
  return {
    fill: style.fill === 'solid' ? COLOR[name] : style.fill === 'hatch' ? `url(#hatch-${name})` : 'none',
    stroke: COLOR[name],
    ...(style.dashed ? { strokeDasharray: '6 4' } : {}),
  };
}

export const paintText = (name: PaintName): string =>
  name === 'fixed' ? copy.editor.paints.fixed : name === 'unknown' ? copy.editor.paints.unknown : name === 'existing' ? copy.editor.paints.changeable : copy.editor.kinds[name];

const ORDER: PaintName[] = ['exterior', 'mamad', 'fixed', 'existing', 'unknown', 'moved', 'added', 'removed'];

/** Every paint on the drawing, each with a swatch drawn with the same paint and its words. */
export function Legend({ paints }: { paints: PaintName[] }) {
  const shown = ORDER.filter(name => paints.includes(name));
  return (
    <section className="legend" aria-labelledby="legend-title">
      <h2 id="legend-title">{copy.editor.legend}</h2>
      <ul>
        {shown.map(name => (
          <li key={name} data-paint={name}>
            <svg width="32" height="16" aria-hidden="true">
              <PaintDefs />
              <rect x="1" y="2" width="30" height="12" strokeWidth="1.5" {...wallPaint(name)} />
            </svg>
            <span>{paintText(name)}</span>
          </li>
        ))}
      </ul>
    </section>
  );
}
