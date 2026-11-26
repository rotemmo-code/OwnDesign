// Only types come from pdfjs-dist: main-thread code imports this file too and must not load pdf.js.
import type { PDFDocumentProxy, PDFPageProxy } from 'pdfjs-dist';
import { MAX_COLOURS, MAX_FILE_BYTES, MAX_PAGES, MAX_PATHS, MIN_VECTOR_PATHS } from '../limits';
import type { Vec } from '../shared';

type Pdfjs = typeof import('pdfjs-dist');

export type OpenError = 'empty' | 'too-large' | 'not-pdf' | 'locked' | 'corrupt' | 'too-many-pages' | 'too-complex' | 'image-only' | 'timeout' | 'failed';
type Refusal = { ok: false; code: OpenError };

export type SubPath = { pts: Vec[]; closed: boolean; curved: boolean };
/** Colours are '#rrggbb' in lower case, or 'pattern'. */
export type PathItem = {
  fill: boolean;
  stroke: boolean;
  evenOdd: boolean;
  subpaths: SubPath[];
  fillColor: string;
  strokeColor: string;
  lineWidth: number;
  dashed: boolean;
  layer: string | null;
  clipId: number;
};
export type Clip = { rings: Vec[][]; evenOdd: boolean };
export type Colour = { hex: string; uses: number };
export type ExtractedPage = {
  widthPt: number;
  heightPt: number;
  rotation: number;
  paths: PathItem[];
  /** clips[clipId] are the clips to intersect. clips[0] is the page rectangle alone, and every list starts with it. */
  clips: Clip[][];
  texts: { str: string; at: Vec; heightPt: number }[];
  layers: string[];
  colours: Colour[];
};

const refuse = (code: OpenError): Refusal => ({ ok: false, code });

export function checkPdfBytes(bytes: Uint8Array): 'empty' | 'too-large' | 'not-pdf' | null {
  if (bytes.length === 0) return 'empty';
  if (bytes.length > MAX_FILE_BYTES) return 'too-large';
  return new TextDecoder('latin1').decode(bytes.subarray(0, 1024)).includes('%PDF-') ? null : 'not-pdf';
}

// shortcut: nothing bounds what pdf.js unpacks before MAX_PATHS is checked, so a hostile file of a few KB can take gigabytes;
// build the deferred byte-level guard (Task 2) before files from unknown people are opened.
/** assets: absolute URL of the folder that holds cmaps/ and standard_fonts/, ending in '/'. Node tests leave it out. */
export async function openDocument(pdfjs: Pdfjs, bytes: Uint8Array, assets?: string): Promise<{ ok: true; doc: PDFDocumentProxy } | Refusal> {
  const code = checkPdfBytes(bytes);
  if (code) return refuse(code);
  const task = pdfjs.getDocument({
    data: bytes.slice(), // pdf.js detaches what it is given
    maxImageSize: 0, // no image is decoded while lines are read
    enableXfa: false,
    useWasm: false,
    useSystemFonts: false,
    disableFontFace: true, // a worker has no document.fonts
    verbosity: pdfjs.VerbosityLevel.ERRORS,
    // With useWorkerFetch off or a relative URL, texts that need these files come out empty without an error.
    ...(assets && { useWorkerFetch: true, cMapUrl: `${assets}cmaps/`, standardFontDataUrl: `${assets}standard_fonts/` }),
  });
  let refusal: OpenError;
  try {
    const doc = await task.promise;
    if (doc.numPages <= MAX_PAGES) return { ok: true, doc };
    refusal = 'too-many-pages';
  } catch (error) {
    refusal = error instanceof pdfjs.PasswordException ? 'locked' : 'corrupt';
  }
  await task.destroy();
  return refuse(refusal);
}

export async function extractPage(pdfjs: Pdfjs, doc: PDFDocumentProxy, pageNo: number): Promise<{ ok: true; page: ExtractedPage } | Refusal> {
  let page: PDFPageProxy | undefined;
  try {
    page = await doc.getPage(pageNo);
    const view = page.getViewport({ scale: 1 });
    if (!isFinitePoint([view.width, view.height])) return refuse('corrupt'); // no number that leaves is infinite
    const groups = await doc.getOptionalContentConfig();
    const operators = await page.getOperatorList({ annotationMode: pdfjs.AnnotationMode.DISABLE });
    const drawing = readPaths(pdfjs, operators, view, groups);
    if (!drawing) return refuse('too-complex');
    if (drawing.paths.length < MIN_VECTOR_PATHS) return refuse('image-only');
    const { items } = await page.getTextContent();
    const at = pointAt(pdfjs, view.transform);
    return {
      ok: true,
      page: {
        widthPt: view.width,
        heightPt: view.height,
        rotation: view.rotation,
        ...drawing,
        texts: items
          .flatMap(item => ('str' in item ? [{ str: item.str, at: at(item.transform[4], item.transform[5]), heightPt: item.height * view.userUnit }] : []))
          .filter(text => isFinitePoint(text.at) && Number.isFinite(text.heightPt)),
        layers: [...groups].flatMap(([, group]): string[] => group.name ?? []),
        colours: summariseColours(drawing.paths),
      },
    };
  } catch {
    return refuse('corrupt');
  } finally {
    page?.cleanup();
  }
}

type Matrix = number[];
type Box = [left: number, top: number, right: number, bottom: number];
type State = {
  ctm: Matrix;
  fill: string | null; // null is transparent
  stroke: string | null;
  width: number;
  dashed: boolean;
  clipId: number;
  fillAlpha: number;
  strokeAlpha: number;
  blend: string;
  masked: boolean; // under a soft mask
  knockout: boolean; // straight inside a knockout group
};
/** What the page starts with, and every group that is painted apart. */
const PLAIN = { fillAlpha: 1, strokeAlpha: 1, blend: 'source-over', masked: false, knockout: false };

const pointAt =
  (pdfjs: Pdfjs, matrix: Matrix) =>
  (x: number, y: number): Vec => {
    const point: Vec = [x, y];
    pdfjs.Util.applyTransform(point, matrix);
    return point;
  };

const isFinitePoint = ([x, y]: Vec) => Number.isFinite(x) && Number.isFinite(y);

/** The box of no point at all meets nothing. */
function boxOf(rings: Vec[][]): Box {
  const box: Box = [Infinity, Infinity, -Infinity, -Infinity];
  for (const ring of rings) {
    for (const [x, y] of ring) {
      box[0] = Math.min(box[0], x);
      box[1] = Math.min(box[1], y);
      box[2] = Math.max(box[2], x);
      box[3] = Math.max(box[3], y);
    }
  }
  return box;
}
const meet = (a: Box, b: Box): Box => [Math.max(a[0], b[0]), Math.max(a[1], b[1]), Math.min(a[2], b[2]), Math.min(a[3], b[3])];

/** The paths in drawing order, or null when the page paints more than MAX_PATHS of them. */
function readPaths(
  pdfjs: Pdfjs,
  { fnArray, argsArray }: Awaited<ReturnType<PDFPageProxy['getOperatorList']>>,
  view: ReturnType<PDFPageProxy['getViewport']>,
  groups: Awaited<ReturnType<PDFDocumentProxy['getOptionalContentConfig']>>,
): Pick<ExtractedPage, 'paths' | 'clips'> | null {
  const { OPS, Util } = pdfjs;
  const fillAndStroke = [OPS.fillStroke, OPS.eoFillStroke, OPS.closeFillStroke, OPS.closeEOFillStroke];
  const fills = new Set([OPS.fill, OPS.eoFill, ...fillAndStroke]);
  const strokes = new Set([OPS.stroke, OPS.closeStroke, ...fillAndStroke]);
  const evenOdds = new Set([OPS.eoFill, OPS.eoFillStroke, OPS.closeEOFillStroke]);

  let s: State = { ctm: view.transform, fill: '#000000', stroke: '#000000', width: 1, dashed: false, clipId: 0, ...PLAIN };
  const saved: State[] = [];
  const save = () => saved.push({ ...s });
  const restore = () => {
    const last = saved.pop();
    if (!last) return;
    s = last;
    pendingClip = null; // as pdf.js does
  };
  const setWidth = (width: number) => {
    if (Number.isFinite(width)) s.width = width; // a canvas ignores any other
  };
  const setDash = (dashes: unknown) => {
    s.dashed = Array.isArray(dashes) && dashes.some(d => d > 0);
  };

  const rectangle = ([left, top, right, bottom]: Box, matrix: Matrix): Vec[][] => {
    const at = pointAt(pdfjs, matrix);
    return [[at(left, top), at(right, top), at(right, bottom), at(left, bottom)].filter(isFinitePoint)]; // a point beyond all numbers is dropped
  };
  const pageBox: Box = [0, 0, view.width, view.height];
  const clips: Clip[][] = [[{ rings: rectangle(pageBox, [1, 0, 0, 1, 0, 0]), evenOdd: false }]];
  const clipBoxes = [pageBox];
  const addClip = (rings: Vec[][], evenOdd: boolean) => {
    // shortcut: clips inside clips cost the square of their depth, let a list name its parent if a real file nests thousands
    clips.push([...clips[s.clipId], { rings, evenOdd }]);
    clipBoxes.push(meet(clipBoxes[s.clipId], boxOf(rings)));
    s.clipId = clips.length - 1;
  };
  let pendingClip: { evenOdd: boolean } | null = null;

  // Marked content and groups, each holding what it inherits.
  let content: { visible: boolean; layer: string | null } = { visible: true, layer: null };
  const outer: (typeof content)[] = [];
  const enter = (inner: typeof content) => {
    outer.push(content);
    content = inner;
  };
  const leave = () => {
    content = outer.pop() ?? content;
  };

  const paths: PathItem[] = [];
  let painted = 0;
  let skipped = 0; // open forms and groups that are not entered

  for (let i = 0; i < fnArray.length; i++) {
    const op = fnArray[i];
    const args = argsArray[i];
    // pdf.js neither saves nor restores for a form on a layer that is off. Followed between W and its path only: elsewhere what comes after stays where the file puts it.
    if ((op === OPS.paintFormXObjectBegin || op === OPS.beginGroup) && !content.visible && (pendingClip || skipped)) {
      skipped++;
      continue;
    }
    if ((op === OPS.paintFormXObjectEnd || op === OPS.endGroup) && skipped) {
      skipped--;
      continue;
    }
    switch (op) {
      case OPS.save:
        save();
        break;
      case OPS.restore:
      case OPS.paintFormXObjectEnd:
        restore();
        break;
      case OPS.transform:
        s.ctm = Util.transform(s.ctm, args);
        break;
      case OPS.paintFormXObjectBegin: {
        const [matrix, bbox] = args;
        save();
        if (matrix) s.ctm = Util.transform(s.ctm, matrix);
        if (bbox) {
          addClip(rectangle(bbox, s.ctm), false);
          if (pendingClip) addClip([], false); // between W and its path pdf.js clips this form to nothing
        }
        break;
      }
      case OPS.beginGroup: {
        const [{ matrix, bbox, smask, isolated, knockout, needsIsolation, hasSoftMask, isGray }] = args;
        save();
        if (bbox) addClip(rectangle(bbox, matrix ? Util.transform(s.ctm, matrix) : s.ctm), false);
        enter(smask || s.fillAlpha === 0 ? { ...content, visible: false } : content);
        // pdf.js paints such a group straight onto the page. Any other starts afresh and is laid on the page with the fill alpha outside it.
        const direct = s.fillAlpha === 1 && s.blend === PLAIN.blend && !s.masked && !s.knockout && !knockout && !isGray && (!needsIsolation || (!isolated && !hasSoftMask));
        if (!direct) Object.assign(s, PLAIN, { knockout: !!knockout });
        break;
      }
      case OPS.endGroup:
        restore();
        leave();
        break;

      case OPS.setFillRGBColor:
        s.fill = args[0];
        break;
      case OPS.setStrokeRGBColor:
        s.stroke = args[0];
        break;
      case OPS.setFillColorN:
        s.fill = 'pattern';
        break;
      case OPS.setStrokeColorN:
        s.stroke = 'pattern';
        break;
      case OPS.setFillTransparent:
        s.fill = null;
        break;
      case OPS.setStrokeTransparent:
        s.stroke = null;
        break;
      case OPS.setLineWidth:
        setWidth(args[0]);
        break;
      case OPS.setDash:
        setDash(args[0]);
        break;
      case OPS.setGState:
        for (const [key, value] of args[0]) {
          if (key === 'LW') setWidth(value);
          else if (key === 'D') setDash(value?.[0]);
          else if (key === 'ca') s.fillAlpha = value;
          else if (key === 'CA') s.strokeAlpha = value;
          else if (key === 'BM') s.blend = value;
          else if (key === 'SMask') s.masked = value && content.visible; // on a layer that is off pdf.js has no mask to set
        }
        break;

      case OPS.beginMarkedContent:
        enter(content);
        break;
      case OPS.beginMarkedContentProps: {
        const group = args[0] === 'OC' ? args[1] : null; // a group, a membership of several groups by list or by expression, or neither
        const members: string[] = group?.ids ?? group?.expression?.flat(Infinity) ?? [];
        const layer = groups.getGroup(group?.id ?? members.find(id => groups.getGroup(id)))?.name;
        enter({ visible: content.visible && (!group || groups.isVisible(group)), layer: layer ?? content.layer });
        break;
      }
      case OPS.endMarkedContent:
        leave();
        break;

      // Text used as a clip (7 Tr) is not followed.
      case OPS.clip:
        pendingClip = { evenOdd: false };
        break;
      case OPS.eoClip:
        pendingClip = { evenOdd: true };
        break;
      case OPS.constructPath: {
        const [paint, [data]] = args;
        if ((fills.has(paint) || strokes.has(paint)) && ++painted > MAX_PATHS) return null;
        const subpaths = data ? subpathsOf(data, pointAt(pdfjs, s.ctm)) : [];
        const rings = subpaths.map(sub => sub.pts);
        const fill = fills.has(paint) && s.fill !== null && s.fillAlpha !== 0;
        const stroke = strokes.has(paint) && s.stroke !== null && s.strokeAlpha !== 0;
        const scaledWidth = s.width * Math.sqrt(Math.abs(s.ctm[0] * s.ctm[3] - s.ctm[1] * s.ctm[2]));
        const lineWidth = Number.isFinite(scaledWidth) ? scaledWidth : 0;
        // Only what can be seen is read: detection and snapping must not use lines the user does not see.
        if ((fill || stroke) && content.visible && touches(clipBoxes[s.clipId], boxOf(rings), stroke ? lineWidth / 2 : 0)) {
          paths.push({
            fill,
            stroke,
            evenOdd: evenOdds.has(paint),
            subpaths,
            fillColor: s.fill ?? '#000000',
            strokeColor: s.stroke ?? '#000000',
            lineWidth,
            dashed: s.dashed,
            layer: content.layer,
            clipId: s.clipId,
          });
        }
        if (pendingClip && data) addClip(rings, pendingClip.evenOdd); // without a path pdf.js clips nothing
        pendingClip = null;
        break;
      }
    }
  }
  return { paths, clips };
}

/** Whether the box, grown on every side, has a point in common with the clip's box. */
function touches(clip: Box, [left, top, right, bottom]: Box, grow: number): boolean {
  const [l, t, r, b] = meet(clip, [left - grow, top - grow, right + grow, bottom + grow]);
  return l <= r && t <= b;
}

// pdf.js does not export these codes. Its fifth one is for the quadratic curves of glyphs, which a page path never holds.
const MOVE = 0;
const LINE = 1;
const CURVE = 2;
const CLOSE = 4;
const CURVE_SEGMENTS = 8;

/** Follows a canvas: a point that is no number is dropped, and a path that begins without a move begins at its first point. */
function subpathsOf(data: Float32Array, at: (x: number, y: number) => Vec): SubPath[] {
  const subpaths: SubPath[] = [];
  const begin = (first: Vec): SubPath => {
    const begun = { pts: [at(...first)], closed: false, curved: false };
    subpaths.push(begun);
    return begun;
  };
  let sub: SubPath | null = null; // the open one
  let start: Vec | null = null;
  let pen: Vec | null = null;
  let i = 0;
  const take = (n: number) => data.subarray(i, (i += n));
  while (i < data.length) {
    const [op] = take(1);
    if (op === CLOSE) {
      if (sub) sub.closed = true;
      sub = null;
      pen = start;
      continue;
    }
    if (op !== MOVE && op !== LINE && op !== CURVE) throw new Error(`unknown path operator ${op}`);
    const points = take(op === CURVE ? 6 : 2);
    if (!points.every(Number.isFinite)) continue; // a coordinate beyond 32 bits arrives as Infinity: the point is dropped
    const [x1, y1, x2, y2, x3, y3] = points;
    if (op === MOVE || !pen) {
      start = pen = [x1, y1];
      sub = begin(pen);
      if (op !== CURVE) continue;
    }
    sub ??= begin(pen); // goes on after a close
    if (op === LINE) {
      pen = [x1, y1];
      sub.pts.push(at(...pen));
    } else {
      sub.curved = true;
      for (let k = 1; k <= CURVE_SEGMENTS; k++) {
        const t = k / CURVE_SEGMENTS;
        const u = 1 - t;
        const [a, b, c, d] = [u ** 3, 3 * u * u * t, 3 * u * t * t, t ** 3];
        sub.pts.push(at(a * pen[0] + b * x1 + c * x2 + d * x3, a * pen[1] + b * y1 + c * y2 + d * y3));
      }
      pen = [x3, y3];
    }
  }
  for (const each of subpaths) each.pts = each.pts.filter(isFinitePoint); // the matrix can take a point beyond all numbers too: dropped
  return subpaths.filter(({ pts }) => pts.length > 1);
}

const GRAY_SPREAD = 20; // largest minus smallest component; below it a colour reads as gray
const HUE_GAP = 15;
const SATURATION_GAP = 0.35;

function hsv(hex: string) {
  const [r, g, b] = [1, 3, 5].map(at => parseInt(hex.slice(at, at + 2), 16));
  const max = Math.max(r, g, b);
  const spread = max - Math.min(r, g, b);
  const sextant = max === r ? (g - b) / spread : max === g ? 2 + (b - r) / spread : 4 + (r - g) / spread;
  return { hue: sextant * 60, saturation: spread / max, spread };
}

/** The drawing's own colours, grays left out. Shades of one colour are one entry, shown as the shade used most. */
export function summariseColours(paths: PathItem[]): Colour[] {
  const uses = new Map<string, number>();
  for (const path of paths) {
    for (const hex of new Set([path.fill ? path.fillColor : 'pattern', path.stroke ? path.strokeColor : 'pattern'])) {
      if (hex !== 'pattern' && hsv(hex).spread >= GRAY_SPREAD) uses.set(hex, (uses.get(hex) ?? 0) + 1);
    }
  }
  const byUses = (a: Colour, b: Colour) => b.uses - a.uses || (a.hex < b.hex ? -1 : 1);
  const groups: Colour[] = [];
  for (const colour of Array.from(uses, ([hex, n]) => ({ hex, uses: n })).sort(byUses)) {
    const { hue, saturation } = hsv(colour.hex);
    const shade = groups.find(group => {
      const other = hsv(group.hex);
      const gap = Math.abs(other.hue - hue);
      return Math.min(gap, 360 - gap) <= HUE_GAP && Math.abs(other.saturation - saturation) <= SATURATION_GAP;
    });
    if (shade) shade.uses += colour.uses;
    else groups.push(colour);
  }
  return groups.sort(byUses).slice(0, MAX_COLOURS);
}
