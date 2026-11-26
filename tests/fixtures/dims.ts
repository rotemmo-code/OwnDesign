import type { Vec } from '../../src/shared';
import { PLAN_ORIGIN, PLAN_PAGE, rawPdf } from './makePdf';

/**
 * The two-room plan of makePdf with written dimensions as a contractor draws them: a thin line that runs 1.5 mm (on paper) past
 * each end, a tick of 2.5 mm across each end, and the number. Rooms: A 3000 x 4000 on the left, B 2900 x 4000 on the right.
 */
const WALLS = [[0, 0, 1100, 200], [2300, 0, 6400, 200], [0, 4200, 4300, 4400], [5200, 4200, 6400, 4400], [0, 200, 200, 4200], [6200, 200, 6400, 4200], [3200, 200, 3300, 1200], [3200, 2000, 3300, 4200]];
/** Ends in mm from the apartment's outer top-left corner, y down, and the number written. `ext`: where its extension lines start. */
export type Mark = { a: Vec; b: Vec; text: string; ext?: number };
export const DIMS = {
  roomA: { a: [200, 3000], b: [3200, 3000], text: '300' },
  roomB: { a: [3300, 3000], b: [6200, 3000], text: '290' },
  heightA: { a: [1700, 200], b: [1700, 4200], text: '400' },
  outer: { a: [0, 4900], b: [6400, 4900], text: '640', ext: 4450 },
  door: { a: [3500, 1200], b: [3500, 2000], text: '80' },
  part120: { a: [200, 3600], b: [1400, 3600], text: '120' },
  part250: { a: [3300, 3600], b: [5800, 3600], text: '250' },
} satisfies Record<string, Mark>;

/** The view point of a point in mm, on a page drawn at 1:scale. */
export const viewOf = (scale: number, [x, y]: Vec): Vec => {
  const k = 72 / 25.4 / scale;
  return [PLAN_ORIGIN[0] + x * k, PLAN_ORIGIN[1] + y * k];
};

/** Every page the same: the plan at 1:scale with all of DIMS. */
export function dimsPdf(scale = 50, pages = 1): Uint8Array {
  const k = 72 / 25.4 / scale;
  const rect = ([x0, y0, x1, y1]: number[]) => `${x0} ${y0} ${x1 - x0} ${y1 - y0} re`;
  const ops = [
    `1 0 0 -1 0 ${PLAN_PAGE[1]} cm .25 w`, // view points from here on
    `${rect([20, 20, PLAN_PAGE[0] - 20, PLAN_PAGE[1] - 20])} S`,
    ...Array.from({ length: 60 }, (_, i) => `${30 + 13 * i} 30 m ${30 + 13 * i} 40 l S`), // a title block: more than 50 lines
    `${k} 0 0 ${k} ${PLAN_ORIGIN.join(' ')} cm .50196 g`, // mm from here on
    ...WALLS.map(wall => `${rect(wall)} f`),
    `0 G 0 g ${0.18 / k} w`,
  ];
  for (const { a, b, text, ext } of Object.values(DIMS) as Mark[]) {
    const length = Math.hypot(b[0] - a[0], b[1] - a[1]);
    const [ux, uy] = [(b[0] - a[0]) / length, (b[1] - a[1]) / length];
    const past = 1.5 * scale; // 1.5 mm on paper
    ops.push(`${a[0] - ux * past} ${a[1] - uy * past} m ${b[0] + ux * past} ${b[1] + uy * past} l S`);
    for (const [x, y] of [a, b]) {
      const t = (1.25 * scale) / Math.SQRT2;
      ops.push(`${x - t} ${y + t} m ${x + t} ${y - t} l S`);
      if (ext !== undefined) ops.push(`${x} ${ext} m ${x} ${y + past} l S`);
    }
    const [h, mx, my] = [2.5 * scale, (a[0] + b[0]) / 2, (a[1] + b[1]) / 2];
    const at = Math.abs(uy) > Math.abs(ux) ? `0 ${-h} ${-h} 0 ${mx - 0.8 * scale} ${my + h}` : `${h} 0 0 ${-h} ${mx - h} ${my - 0.8 * scale}`;
    ops.push(`BT /F1 1 Tf ${at} Tm (${text}) Tj ET`);
  }
  const kids = Array.from({ length: pages }, (_, i) => `${5 + i} 0 R`);
  return rawPdf(
    [
      '<</Type/Catalog/Pages 2 0 R>>',
      `<</Type/Pages/Count ${pages}/Kids[${kids.join(' ')}]>>`,
      '<<>>',
      '<</Type/Font/Subtype/Type1/BaseFont/Helvetica>>',
      ...kids.map(() => `<</Type/Page/Parent 2 0 R/MediaBox[0 0 ${PLAN_PAGE.join(' ')}]/Contents 3 0 R/Resources<</Font<</F1 4 0 R>>>>>>`),
    ],
    { 3: new Uint8Array(Buffer.from(ops.join('\n'), 'latin1')) },
  );
}
