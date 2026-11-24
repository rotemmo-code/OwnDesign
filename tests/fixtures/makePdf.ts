/** Page size and the apartment's outer top-left corner, in view points of the unrotated page. */
export const PLAN_PAGE = [842, 595] as const;
export const PLAN_ORIGIN = [120, 90] as const;

/**
 * objects[i] is the body of object i + 1; object 1 is the catalog. streams[n] is the data of object n,
 * whose body is then the stream dictionary; /Length is added when the dictionary has none.
 */
export function rawPdf(objects: string[], streams: Record<number, Uint8Array> = {}): Uint8Array {
  let pdf = '%PDF-1.7\n';
  let xref = `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n`;
  objects.forEach((body, i) => {
    xref += `${String(pdf.length).padStart(10, '0')} 00000 n \n`;
    const data = streams[i + 1];
    if (data) {
      const dict = body.includes('/Length') ? body : body.replace(/>>\s*$/,`/Length ${data.length}>>`);
      body = `${dict}\nstream\n${Buffer.from(data).toString('latin1')}\nendstream`;
    }
    pdf += `${i + 1} 0 obj\n${body}\nendobj\n`;
  });
  const trailer = `trailer\n<</Size ${objects.length + 1}/Root 1 0 R>>\nstartxref\n${pdf.length}\n%%EOF\n`;
  return new Uint8Array(Buffer.from(pdf + xref + trailer, 'latin1'));
}

type Layers = { walls: string; doors?: string; windows?: string };

const rect = ([x0, y0, x1, y1]: number[]) => `${x0} ${y0} ${x1 - x0} ${y1 - y0} re`;
const line = (x0: number, y0: number, x1: number, y1: number) => `${x0} ${y0} m ${x1} ${y1} l S`;
/** Quarter circle about x, y, from x + dx, y to x, y + dy. */
const arc = (x: number, y: number, dx: number, dy: number) => {
  const c = 0.5522847498;
  return `${x + dx} ${y} m ${x + dx} ${y + dy * c} ${x + dx * c} ${y + dy} ${x} ${y + dy} c S`;
};

// The apartment in mm from its outer top-left corner, y down, as [left, top, right, bottom]. One filled path per wall, open at its openings.
const WALLS = [
  [[0, 0, 1100, 200], [2300, 0, 6400, 200]], // top; window 1200 wide, centred over room A
  [[0, 4200, 4300, 4400], [5200, 4200, 6400, 4400]], // bottom; entry door 900 wide, centred in room B
  [[0, 200, 200, 4200]], // left
  [[6200, 200, 6400, 4200]], // right
  [[3200, 200, 3300, 1200], [3200, 2000, 3300, 4200]], // partition; door 800 wide, 1000 from the top inner face
];

/** Two-room apartment: A 3000 x 4000 on the left, B 2900 x 4000 on the right. Fits the page at 1:30 and smaller. */
export function planPdf(opts: {
  scale?: number;
  rotate?: 0 | 90 | 180 | 270;
  mediaBoxOrigin?: [number, number];
  layers?: boolean | Layers;
  pages?: number;
} = {}): Uint8Array {
  const { scale = 50, rotate = 0, mediaBoxOrigin: [x0, y0] = [0, 0], layers = false, pages = 1 } = opts;
  const [width, height] = PLAN_PAGE;
  const names: Partial<Layers> = layers === true ? { walls: 'hatch walls', doors: 'door', windows: 'window' } : layers || {};
  const on = (layer: keyof Layers, ops: string[]) => (names[layer] ? [`/OC /${layer} BDC`, ...ops, 'EMC'] : ops);
  const ptPerMm = 72 / 25.4 / scale;

  const content = [
    `1 0 0 -1 ${x0} ${y0 + height} cm .25 w`, // view points from here on
    `${rect([20, 20, width - 20, height - 20])} S`,
    ...Array.from({ length: 60 }, (_, i) => line(30 + 13 * i, 30, 30 + 13 * i, 40)),
    `${ptPerMm} 0 0 ${ptPerMm} ${PLAN_ORIGIN.join(' ')} cm 10 w .50196 g`, // mm from here on; gray #808080
    ...on('walls', WALLS.map(parts => `${parts.map(rect).join(' ')} f`)),
    ...on('doors', [arc(3200, 1200, -800, 800), arc(4300, 4200, 900, -900)]),
    ...on('windows', [line(1100, 50, 2300, 50), line(1100, 150, 2300, 150)]),
  ].join('\n');

  const groups = Object.entries(names).filter(([, name]) => name).map(([layer, name], i) => ({ layer, name, ref: `${4 + i} 0 R` }));
  const kids = Array.from({ length: pages }, (_, i) => `${4 + groups.length + i} 0 R`);
  const properties = groups.map(g => `/${g.layer} ${g.ref}`).join('');
  const ocProperties = groups.length ? `/OCProperties<</OCGs[${groups.map(g => g.ref).join(' ')}]/D<<>>>>` : '';
  return rawPdf(
    [
      `<</Type/Catalog/Pages 2 0 R${ocProperties}>>`,
      `<</Type/Pages/Count ${pages}/Kids[${kids.join(' ')}]>>`,
      '<<>>',
      ...groups.map(g => `<</Type/OCG/Name <${Buffer.from(`\ufeff${g.name}`, 'utf16le').swap16().toString('hex')}> >>`),
      ...kids.map(() => `<</Type/Page/Parent 2 0 R/MediaBox[${x0} ${y0} ${x0 + width} ${y0 + height}]/Rotate ${rotate}/Contents 3 0 R/Resources<</Properties<<${properties}>>>>>>`),
    ],
    { 3: Buffer.from(content, 'latin1') },
  );
}
