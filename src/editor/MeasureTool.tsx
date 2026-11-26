import { useState } from 'react';
import { fitCalibration } from '../calibrate/fit';
import { copy } from '../copy';
import { formatCm } from '../model/measure';
import type { Plaster } from '../model/types';
import type { Calibration, Vec } from '../shared';
import { DimLine, SnapMark } from './Calibrate';
import type { Tool } from './Canvas';
import { type SnapIndex, snapPoint } from './snap';

const m = copy.measure;

/** Two snapped points and the distance between them, by the drawing: the scale only, never the offset. */
export function useMeasure(index: SnapIndex, calibration: Calibration | null, plaster: Plaster | null, onAgain: () => void): Tool {
  const [line, setLine] = useState<{ a: Vec; b?: Vec } | null>(null);
  const [near, setNear] = useState<{ at: Vec; radius: number } | null>(null);
  const from = line && !line.b ? line.a : undefined;
  const hovered = near && snapPoint(near.at, index, near.radius, from);
  const cm = calibration && line?.b ? formatCm(calibration.mmPerPt * Math.hypot(line.b[0] - line.a[0], line.b[1] - line.a[1])) : '';
  return {
    pick: (at, radius) => {
      const { at: point } = snapPoint(at, index, radius, from);
      setLine(from ? { a: from, b: point } : { a: point });
    },
    hover: (at, radius) => setNear(at && { at, radius }),
    marks: ptPerPx => (
      <>
        {line && <DimLine a={line.a} b={line.b ?? hovered?.at ?? line.a} k={ptPerPx} label={cm || undefined} />}
        {hovered && <SnapMark snap={hovered} k={ptPerPx} />}
      </>
    ),
    panel: calibration && (
      <section aria-labelledby="measure-title">
        <h2 id="measure-title">{m.title}</h2>
        <p>{calibration.verified ? m.verified(calibration.scale, fitCalibration(calibration.dims, calibration.chosen).used.filter(Boolean).length) : m.unverified(calibration.scale)}</p>
        <p>{m.how}</p>
        <p aria-live="polite" data-testid="measured">
          {cm && (
            <>
              <strong>{m.result(cm)}</strong> {copy.byDrawing}
            </>
          )}
        </p>
        <p>{copy.plasterSentence[plaster ?? 'unknown']}</p>
        <button type="button" onClick={onAgain}>{m.again}</button>
      </section>
    ),
  };
}
