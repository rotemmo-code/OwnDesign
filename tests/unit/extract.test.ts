import type { PDFDocumentLoadingTask, PDFDocumentProxy } from 'pdfjs-dist';
import * as pdfjs from 'pdfjs-dist/legacy/build/pdf.mjs';
import { describe, expect, it, vi } from 'vitest';
import { extractPage, openDocument, summariseColours, type PathItem } from '../../src/pdf/extract';
import type { Vec } from '../../src/shared';
import { bytes, encryptedPdf, onePage, ticks, truncated } from '../fixtures/hostile';
import { planPdf } from '../fixtures/makePdf';

const { OPS } = pdfjs;

async function open(pdf: Uint8Array) {
  const opened = await openDocument(pdfjs, pdf);
  if (!opened.ok) throw new Error(opened.code);
  return opened.doc;
}

async function read(pdf: Uint8Array, pageNo = 1) {
  const extracted = await extractPage(pdfjs, await open(pdf), pageNo);
  if (!extracted.ok) throw new Error(extracted.code);
  return extracted.page;
}

/** The paths of this content. It follows 60 ticks, because a page with fewer than 50 paths is refused. */
async function drawn(content: string, parts?: Parameters<typeof onePage>[1]) {
  const page = await read(onePage(ticks(60) + content, parts));
  return { page, paths: page.paths.slice(60) };
}

const points = (path: PathItem) => path.subpaths.flatMap(s => s.pts);

/** A page whose operator list is made up here, for what no page content was found to produce. It starts with 60 lines. */
function made(operators: [fn: number, args: unknown[]][], cleanup = () => {}) {
  const line: [number, unknown[]] = [OPS.constructPath, [OPS.stroke, [Float32Array.of(0, 1, 1, 1, 9, 9)], null]];
  const list = [...Array<typeof line>(60).fill(line), ...operators];
  const page = {
    getViewport: () => ({ width: 100, height: 100, rotation: 0, userUnit: 1, transform: [1, 0, 0, 1, 0, 0] }),
    getOperatorList: async () => ({ fnArray: list.map(([fn]) => fn), argsArray: list.map(([, args]) => args) }),
    getTextContent: async () => ({ items: [] }),
    cleanup,
  };
  const doc = { getPage: async () => page, getOptionalContentConfig: async () => new Map() };
  return extractPage(pdfjs, doc as unknown as PDFDocumentProxy, 1);
}

function near(got: Vec[], want: Vec[]) {
  expect(got).toHaveLength(want.length);
  got.forEach((p, i) => p.forEach((v, axis) => expect(v, `point ${i}`).toBeCloseTo(want[i][axis], 3)));
}

const GROUPS = {
  resources: '/Properties<</A 5 0 R/B 6 0 R>>',
  objects: ['<</Type/OCG/Name(a)>>', '<</Type/OCG/Name(b)>>'],
};
const FORM = { resources: '/XObject<</F 5 0 R>>' };

describe('opening', () => {
  /** openDocument with a pdf.js that remembers what it was asked. */
  async function watched(pdf: Uint8Array, assets?: string) {
    const asked: { source: object; task: PDFDocumentLoadingTask }[] = [];
    const getDocument: typeof pdfjs.getDocument = source => {
      const task = pdfjs.getDocument(source);
      asked.push({ source: source as object, task });
      return task;
    };
    const opened = await openDocument({ ...pdfjs, getDocument }, pdf, assets);
    return { opened, ...asked[0] };
  }

  it('gives pdf.js exactly the approved options', async () => {
    const safe = { maxImageSize: 0, enableXfa: false, useWasm: false, useSystemFonts: false, disableFontFace: true, verbosity: pdfjs.VerbosityLevel.ERRORS };
    const data = expect.any(Uint8Array);
    expect((await watched(planPdf())).source).toEqual({ data, ...safe });
    expect((await watched(planPdf(), 'https://example.invalid/pdfjs/')).source).toEqual({
      data,
      ...safe,
      useWorkerFetch: true,
      cMapUrl: 'https://example.invalid/pdfjs/cmaps/',
      standardFontDataUrl: 'https://example.invalid/pdfjs/standard_fonts/',
    });
  });

  it('a refused file is let go, an opened one is kept', async () => {
    for (const pdf of [truncated(), encryptedPdf('secret'), planPdf({ pages: 21 })]) expect((await watched(pdf)).task.destroyed).toBe(true);
    expect((await watched(planPdf())).task.destroyed).toBe(false);
  });

  it('a page is let go after reading, also when it is refused', async () => {
    const cleanup = vi.fn();
    expect((await made([], cleanup)).ok).toBe(true);
    expect(cleanup).toHaveBeenCalledTimes(1);
    expect((await made([[OPS.constructPath, [OPS.stroke, [Float32Array.of(9)], null]]], cleanup)).ok).toBe(false);
    expect(cleanup).toHaveBeenCalledTimes(2);
  });
});

describe('planPdf', () => {
  it('reads the gray wall fills of planPdf', async () => {
    const page = await read(planPdf());
    expect([page.widthPt, page.heightPt, page.rotation]).toEqual([842, 595, 0]);
    expect(page.paths).toHaveLength(70);
    expect(page.paths.filter(p => p.fill && p.fillColor === '#808080')).toHaveLength(5);
    expect(page.paths[0]).toMatchObject({ fill: false, stroke: true, strokeColor: '#000000', lineWidth: 0.25, dashed: false, layer: null });
    expect(page.clips).toEqual([[{ rings: [[[0, 0], [842, 0], [842, 595], [0, 595]]], evenOdd: false }]]);
    expect(page.paths.every(p => p.clipId === 0)).toBe(true);
    expect([page.texts, page.layers, page.colours]).toEqual([[], [], []]);
  });

  it('converts points to mm at 1:50', async () => {
    const partition = (await read(planPdf())).paths.filter(p => p.fill)[4];
    const [a, b] = partition.subpaths[0].pts;
    expect(Math.abs((b[0] - a[0]) * 17.638889 - 100)).toBeLessThan(0.01);
  });

  it('reads layer names', async () => {
    const page = await read(planPdf({ layers: true }));
    expect(page.layers).toEqual(['hatch walls', 'door', 'window']);
    expect(['hatch walls', 'door', 'window', null].map(layer => page.paths.filter(p => p.layer === layer).length)).toEqual([5, 2, 2, 61]);
  });

  it('maps a point through MediaBox offset and rotation', async () => {
    const page = await read(planPdf({ rotate: 90, mediaBoxOrigin: [100, 100] }));
    expect([page.widthPt, page.heightPt, page.rotation]).toEqual([595, 842, 90]);
    near([points(page.paths.filter(p => p.fill)[2])[0]], [[493.6614, 120]]);
  });

  it.each([0, 90, 180, 270] as const)('line widths do not depend on the rotation: %i', async rotate => {
    const { paths } = await read(planPdf({ rotate }));
    expect(paths[0].lineWidth).toBeCloseTo(0.25, 6); // the frame
    expect(paths.at(-1)!.lineWidth).toBeCloseTo(0.566929, 6); // a window line: 10 mm at 1:50
  });
});

describe('layers', () => {
  it('the innermost layer wins and other marked content has none', async () => {
    const { paths } = await drawn('/OC /A BDC /OC /B BDC 0 0 9 9 re f EMC /Span BMC 0 0 8 8 re f EMC /Span <</MCID 1>> BDC 0 0 8 8 re f EMC 0 0 8 8 re f EMC /Span <</MCID 0>> BDC 0 0 7 7 re f EMC', {
      ...GROUPS,
      catalog: '/OCProperties<</OCGs[5 0 R 6 0 R]/D<<>>>>',
    });
    expect(paths.map(p => p.layer)).toEqual(['b', 'a', 'a', 'a', null]);
  });

  it('a layer that is off is not read', async () => {
    const { page, paths } = await drawn('/OC /A BDC 0 0 9 9 re f EMC /OC /B BDC 0 0 8 8 re f /OC /A BDC 0 0 8 8 re f EMC EMC 0 0 7 7 re f', {
      ...GROUPS,
      catalog: '/OCProperties<</OCGs[5 0 R 6 0 R]/D<</OFF[6 0 R]>>>>',
    });
    expect(paths.map(p => p.layer)).toEqual(['a', null]);
    expect(page.layers).toEqual(['a', 'b']);
  });

  it('a layer without a name is not listed', async () => {
    const page = await read(onePage(ticks(60), { ...GROUPS, catalog: '/OCProperties<</OCGs[5 0 R 6 0 R]/D<<>>>>', objects: ['<</Type/OCG>>', '<</Type/OCG/Name(b)>>'] }));
    expect(page.layers).toEqual(['b']);
  });

  it('a clip set on a layer that is off still clips what follows', async () => {
    const { paths } = await drawn('q /OC /B BDC 0 0 5 5 re W n EMC 20 20 5 5 re f 1 1 2 2 re f Q', {
      ...GROUPS,
      catalog: '/OCProperties<</OCGs[5 0 R 6 0 R]/D<</OFF[6 0 R]>>>>',
    });
    expect(paths).toHaveLength(1);
  });

  it('a membership takes the name of its first group and is off when its policy says so', async () => {
    const { paths } = await drawn('/OC /M BDC 0 0 9 9 re f EMC /OC /N BDC 0 0 8 8 re f EMC', {
      resources: '/Properties<</M 7 0 R/N 8 0 R>>',
      catalog: '/OCProperties<</OCGs[5 0 R 6 0 R]/D<</OFF[6 0 R]>>>>',
      objects: [...GROUPS.objects, '<</Type/OCMD/OCGs[5 0 R 6 0 R]/P/AnyOn>>', '<</Type/OCMD/OCGs[5 0 R 6 0 R]/P/AllOn>>'],
    });
    expect(paths.map(p => p.layer)).toEqual(['a']);
  });

  it('a membership by expression takes the name of the first group in it and is off when it says so', async () => {
    const { paths } = await drawn('/OC /M BDC 0 0 9 9 re f EMC /OC /N BDC 0 0 8 8 re f EMC /OC /O BDC 0 0 7 7 re f EMC', {
      resources: '/Properties<</M 7 0 R/N 8 0 R/O 9 0 R>>',
      catalog: '/OCProperties<</OCGs[5 0 R 6 0 R]/D<<>>>>',
      objects: [...GROUPS.objects, '<</Type/OCMD/VE[/Or[/And[/Not 5 0 R]]6 0 R]>>', '<</Type/OCMD/VE[/And 6 0 R 5 0 R]>>', '<</Type/OCMD/VE[/Not 6 0 R]>>'],
    });
    expect(paths.map(p => p.layer)).toEqual(['a', 'b']);
  });
});

describe('forms, groups and clips', () => {
  it('applies the form XObject matrix and its BBox', async () => {
    const { page, paths } = await drawn('0 0 10 10 re f q 3 w /F Do 0 0 20 20 re S Q', {
      ...FORM,
      objects: ['<</Type/XObject/Subtype/Form/BBox[0 0 10 10]/Matrix[2 0 0 2 10 10]>>'],
      streams: { 5: bytes('0 0 10 10 re f 50 50 5 5 re f') },
    });
    expect(paths).toHaveLength(3); // the square at 50,50 lies outside the BBox
    near(points(paths[0]), [[0, 400], [10, 400], [10, 390], [0, 390]]);
    near(points(paths[1]), [[10, 390], [30, 390], [30, 370], [10, 370]]);
    expect(page.clips[paths[1].clipId]).toHaveLength(2);
    near(points(paths[2]), [[0, 400], [20, 400], [20, 380], [0, 380]]);
    expect([paths[2].clipId, paths[2].lineWidth]).toEqual([0, 3]);
  });

  it('a transparency group clips to its BBox; a soft mask is not read', async () => {
    const group = await drawn('q 3 w /F Do 0 0 20 20 re S Q', {
      ...FORM,
      objects: ['<</Type/XObject/Subtype/Form/BBox[0 0 10 10]/Matrix[1 0 0 1 20 0]/Group<</S/Transparency>>>>'],
      streams: { 5: bytes('0 0 10 10 re f 50 50 5 5 re f') },
    });
    expect(group.paths).toHaveLength(2);
    near(points(group.paths[0]), [[20, 400], [30, 400], [30, 390], [20, 390]]);
    expect([group.paths[1].clipId, group.paths[1].lineWidth]).toEqual([0, 3]);

    const mask = await drawn('/G gs 0 0 7 7 re f', {
      resources: '/ExtGState<</G<</SMask<</S/Luminosity/G 5 0 R>>>>>>',
      objects: ['<</Type/XObject/Subtype/Form/BBox[0 0 50 50]/Group<</S/Transparency/CS/DeviceGray>>>>'],
      streams: { 5: bytes('0 0 50 50 re f 1 1 m 2 2 l S') },
    });
    expect(mask.paths).toHaveLength(1);
    near(points(mask.paths[0]), [[0, 400], [7, 400], [7, 393], [0, 393]]);
  });

  it('keeps a non-rectangular clip as a polygon, nested clips add up, Q drops them', async () => {
    const { page, paths } = await drawn('q 0 0 m 100 0 l 0 100 l h W n 0 0 50 50 re f q 0 0 10 10 re W* n 0 0 5 5 re f Q 1 1 5 5 re f Q 2 2 5 5 re f');
    expect(paths.map(p => p.clipId)).toEqual([1, 2, 1, 0]);
    expect(page.clips.map(list => list.length)).toEqual([1, 2, 3]);
    near(page.clips[1][1].rings[0], [[0, 400], [100, 400], [0, 300]]);
    expect(page.clips[2].map(c => c.evenOdd)).toEqual([false, false, true]);
  });

  it('a clip that is also painted takes effect after the paint', async () => {
    const { paths } = await drawn('q 0 0 50 50 re W f 1 1 5 5 re f Q');
    expect(paths.map(p => p.clipId)).toEqual([0, 1]);
  });

  it('Q, the end of a form and the end of a group drop a clip that no path has closed', async () => {
    const afterQ = await drawn('q 0 0 50 50 re W Q 100 100 50 50 re f 200 200 50 50 re f 300 300 50 50 re f');
    expect(afterQ.paths.map(p => p.clipId)).toEqual([0, 0, 0]);
    expect(afterQ.paths.map(p => p.subpaths.length)).toEqual([2, 1, 1]); // the rectangle before W is painted with the next path
    for (const group of ['', '/Group<</S/Transparency>>']) {
      const { paths } = await drawn('/F Do 100 100 50 50 re f 200 200 50 50 re f', {
        ...FORM,
        objects: [`<</Type/XObject/Subtype/Form/BBox[0 0 600 400]${group}>>`],
        streams: { 5: bytes('0 0 50 50 re W') },
      });
      expect(paths.map(p => p.clipId)).toEqual([0, 0]);
    }
    // a Q too many restores nothing, so the clip stays
    const tooMany = await drawn('0 0 50 50 re W Q 100 100 50 50 re f 200 200 50 50 re f');
    expect(tooMany.paths).toHaveLength(1);
  });

  it('a form with a BBox, drawn between W and its path, is hidden; without a BBox the clip waits for its first path', async () => {
    const form = async (bbox: string) => {
      const { paths } = await drawn('0 0 50 50 re W /F Do 100 100 50 50 re f', {
        ...FORM,
        objects: [`<</Type/XObject/Subtype/Form${bbox}>>`],
        streams: { 5: bytes('10 10 50 50 re f 200 200 30 30 re f') },
      });
      return paths.map(p => [p.clipId, p.subpaths.length]);
    };
    expect(await form('/BBox[0 0 600 400]')).toEqual([[0, 2]]);
    expect(await form('')).toEqual([[0, 1], [0, 2]]);
  });

  // What pdf.js shows of a fill (F) and a stroke (S) inside a group, by the alpha and blend outside it. Seen in Chromium and Firefox.
  const ALPHA = { '/ca 1': 'FS', '/ca 0': '', '/ca 0/CA 0': '', '/ca 0/CA .5': '', '/ca .5/CA 0': 'FS', '/CA 0/BM/Multiply': 'FS' };
  const DIRECT = { ...ALPHA, '/CA 0': 'F', '/CA 0/BM/Normal': 'F' }; // painted straight onto the page, so the stroke alpha outside counts
  const APART = { ...ALPHA, '/CA 0': 'FS', '/CA 0/BM/Normal': 'FS' };
  const seen = async (outside: string, group: string, inside = '') => {
    const { paths } = await drawn('/Z gs /F Do', {
      resources: `/XObject<</F 5 0 R>>/ExtGState<</Z<<${outside}>>>>`,
      objects: [
        `<</Type/XObject/Subtype/Form/BBox[0 0 600 400]/Resources<</ExtGState<</One<</ca 1/CA 1>>/Mul<</BM/Multiply>>/Mask<</SMask<</S/Luminosity/G 6 0 R>>>>>>>>${group}>>`,
        '<</Type/XObject/Subtype/Form/BBox[0 0 600 400]/Group<</S/Transparency/CS/DeviceGray>>>>',
      ],
      streams: { 5: bytes(`${inside} 0 0 9 9 re f 0 0 m 9 9 l S`), 6: bytes('1 g 0 0 600 400 re f') },
    });
    return paths.map(p => (p.fill ? 'F' : '') + (p.stroke ? 'S' : '')).join('');
  };
  it.each<[string, string, string, Record<string, string>]>([
    ['a group', '/Group<</S/Transparency>>', '', DIRECT],
    ['a group with a blend in it', '/Group<</S/Transparency>>', '/Mul gs', DIRECT],
    ['a group with a soft mask in it', '/Group<</S/Transparency>>', '/Mask gs', APART],
    ['an isolated group', '/Group<</S/Transparency/I true>>', '', DIRECT],
    ['an isolated group with a blend in it', '/Group<</S/Transparency/I true>>', '/Mul gs', APART],
    ['a knockout group', '/Group<</S/Transparency/K true>>', '', APART],
    ['a gray group', '/Group<</S/Transparency/CS/DeviceGray>>', '', APART],
    ['a group that sets its own alpha', '/Group<</S/Transparency>>', '/One gs', APART],
  ])('%s is hidden by a fill alpha of 0 and starts afresh when pdf.js paints it apart', async (_name, group, inside, want) => {
    for (const [outside, shown] of Object.entries(want)) expect(await seen(outside, group, inside), outside).toBe(shown);
  });

  it('a form that is no group keeps the alpha outside it, and after a group that alpha is back', async () => {
    expect(await seen('/ca 0', '')).toBe('S');
    expect(await seen('/ca .5/CA 0', '')).toBe('F');
    const { paths } = await drawn('/Z gs /F Do 0 0 9 9 re B', {
      resources: '/XObject<</F 5 0 R>>/ExtGState<</Z<</ca .5/CA 0>>>>',
      objects: ['<</Type/XObject/Subtype/Form/BBox[0 0 600 400]/Group<</S/Transparency>>>>'],
      streams: { 5: bytes('0 0 m 9 9 l S') },
    });
    expect(paths.map(p => [p.fill, p.stroke])).toEqual([[false, true], [true, false]]);
  });

  it('a group under a soft mask or inside a knockout group is painted apart', async () => {
    const XOBJECTS = '/XObject<</F 5 0 R/K 6 0 R/P 9 0 R/L 10 0 R>>';
    const group = (extra = '') => `<</Type/XObject/Subtype/Form/BBox[0 0 600 400]/Group<</S/Transparency${extra}>>/Resources<<${XOBJECTS}/ExtGState<</Z<</CA 0>>>>>>>>`;
    const resources = `${XOBJECTS}/ExtGState<</Z<</CA 0>>/M<</SMask<</S/Luminosity/G 7 0 R>>>>/N<</SMask/None>>>>/Properties<</Off 8 0 R>>`;
    const catalog = '/OCProperties<</OCGs[8 0 R]/D<</OFF[8 0 R]>>>>';
    const objects = [group(), group('/K true'), group('/CS/DeviceGray'), '<</Type/OCG/Name(off)>>', group(), group('/K true')];
    const streams = { 5: bytes('0 0 m 9 9 l S'), 6: bytes('/Z gs /F Do'), 7: bytes('1 g 0 0 600 400 re f'), 9: bytes('/Z gs /F Do'), 10: bytes('/P Do') };
    const draw = async (content: string) => (await drawn(content, { resources, catalog, objects, streams })).paths.length;
    expect(await draw('/Z gs /F Do')).toBe(0);
    expect(await draw('/M gs /Z gs /F Do')).toBe(1);
    expect(await draw('/M gs /N gs /Z gs /F Do')).toBe(0);
    expect(await draw('/OC /Off BDC /M gs EMC /Z gs /F Do')).toBe(0);
    expect(await draw('/K Do')).toBe(1);
    expect(await draw('/L Do')).toBe(0); // in a group inside the knockout group
  });

  it('what lies wholly outside its clip or the page is not read; what crosses is', async () => {
    const { paths } = await drawn('q 0 0 10 10 re W n 20 20 5 5 re f 5 5 20 20 re f 0 0 90 90 re W n 50 50 5 5 re f Q 700 0 9 9 re f 0 450 9 9 re f 590 0 30 9 re f');
    near(paths.map(p => points(p)[0]), [[5, 395], [590, 400]]);
    // a stroke reaches half its width further than its points, a fill does not; a line of no width is still a line
    const lines = await drawn('4 w -1 50 m -1 90 l S -3 50 m -3 90 l S -6 50 5 9 re f 0 w 5 50 m 5 90 l S');
    near(lines.paths.map(p => points(p)[0]), [[-1, 350], [5, 350]]);
  });

  it('a clip without a path changes nothing; a clip of one point hides what follows until Q', async () => {
    const without = await drawn('q W n 0 0 5 5 re f Q q W* n 0 0 5 5 re f Q');
    expect(without.paths.map(p => p.clipId)).toEqual([0, 0]);
    const onePoint = await drawn('q 5 5 m W n 0 0 9 9 re f Q 0 0 6 6 re f');
    expect(onePoint.paths.map(p => points(p)[2])).toEqual([[6, 394]]);
  });

  it('a Q or an end too many is ignored', async () => {
    const { paths } = await drawn('3 w Q Q 0 0 m 9 9 l S');
    expect(paths.map(p => [p.lineWidth, p.clipId])).toEqual([[3, 0]]);
    const extracted = await made([[OPS.endMarkedContent, []], [OPS.endGroup, []], [OPS.constructPath, [OPS.fill, [Float32Array.of(0, 1, 1, 1, 9, 9)], null]]]);
    if (!extracted.ok) throw new Error(extracted.code);
    expect(extracted.page.paths).toHaveLength(61);
  });

  it('a CropBox is the page and UserUnit scales it', async () => {
    const page = await read(
      onePage(`${ticks(60, 110, 110)}100 100 m 300 300 l S BT /F 12 Tf 1 0 0 1 150 250 Tm (X) Tj ET`, {
        page: '/CropBox[100 100 300 300]/UserUnit 2',
        resources: '/Font<</F<</Type/Font/Subtype/Type1/BaseFont/Helvetica>>>>',
      }),
    );
    expect([page.widthPt, page.heightPt]).toEqual([400, 400]);
    near(points(page.paths.at(-1)!), [[0, 400], [400, 0]]);
    expect(page.texts).toEqual([{ str: 'X', at: [100, 100], heightPt: 24 }]);
  });
});

describe('paths', () => {
  it('flattens a curve to 8 segments', async () => {
    const { paths } = await drawn('0 0 m 0 100 100 100 100 0 c 100 100 200 100 200 0 c S');
    const [curve] = paths[0].subpaths;
    expect([curve.pts.length, curve.curved, curve.closed]).toEqual([17, true, false]);
    near([0, 2, 4, 8, 12, 16].map(i => curve.pts[i]), [[0, 400], [15.625, 343.75], [50, 325], [100, 400], [150, 325], [200, 400]]);
  });

  it('closed and open subpaths', async () => {
    const { paths } = await drawn('0 0 m 9 0 l 9 9 l s 0 0 m 9 0 l 9 9 l S 0 0 9 9 re S 0 0 9 0 re S 1 2 m 5 5 l h 6 6 l S 3 3 m S');
    expect(paths.map(p => p.subpaths.map(s => [s.pts.length, s.closed]))).toEqual([[[3, true]], [[3, false]], [[4, true]], [[2, true]], [[2, true], [2, false]]]);
    near([paths[4].subpaths[1].pts[0]], [[1, 398]]); // after h drawing goes on from the start
    expect(paths.flatMap(p => p.subpaths).some(s => s.curved)).toBe(false);
  });

  it('every move begins a subpath, after an open one and after a closed one', async () => {
    const { paths } = await drawn('0 0 m 9 0 l 20 0 m 29 0 l 40 0 m 49 0 l 49 9 l h 60 0 m 69 0 l S');
    expect(paths[0].subpaths.map(s => [s.pts.length, s.closed, s.curved])).toEqual([[2, false, false], [2, false, false], [3, true, false], [2, false, false]]);
    near(paths[0].subpaths.map(s => s.pts[0]), [[0, 400], [20, 400], [40, 400], [60, 400]]);
  });

  it('a path without a starting point starts where a canvas starts it', async () => {
    const { paths } = await drawn('5 m 300 100 l 400 100 l S 100 100 200 300 300 100 c S 300 100 l 400 100 l 400 200 l h 500 300 l S h 300 100 l 400 100 l S 300 100 l S');
    expect(paths).toHaveLength(4); // the last has one point only
    near(points(paths[0]), [[300, 300], [400, 300]]);
    expect(paths[1].subpaths[0].pts).toHaveLength(9);
    near([points(paths[1])[0], points(paths[1])[8]], [[100, 300], [300, 300]]); // the first control point
    expect(paths[2].subpaths.map(s => s.closed)).toEqual([true, false]);
    near(points(paths[2]), [[300, 300], [400, 300], [400, 200], [300, 300], [500, 100]]);
    near(points(paths[3]), [[300, 300], [400, 300]]);
  });

  it('all eight painting operators', async () => {
    const { paths } = await drawn(['S', 's', 'f', 'f*', 'B', 'B*', 'b', 'b*', 'n'].map(op => `0 0 m 9 0 l 9 9 l ${op}`).join(' '));
    expect(paths.map(p => [p.fill, p.stroke, p.evenOdd].map(Number).join(''))).toEqual(['010', '010', '100', '101', '110', '111', '110', '111']);
    expect(new Set(paths.flatMap(p => [p.fillColor, p.strokeColor]))).toEqual(new Set(['#000000'])); // until a colour is set
  });

  it('line width, dash, ExtGState and invisible paint', async () => {
    const { paths } = await drawn('q 2 0 0 2 0 0 cm 3 w 0 0 m 9 9 l S Q [3 1] 0 d 0 0 m 9 9 l S [] 0 d /G gs 0 0 m 9 9 l S /H gs 0 0 m 9 9 l S 0 0 9 9 re f 0 0 9 9 re B', {
      resources: '/ExtGState<</G<</LW 7/D[[2 2] 0]>>/H<</ca 0/CA 0>>>>',
    });
    expect(paths.map(p => [p.lineWidth, p.dashed])).toEqual([[6, false], [1, true], [7, true]]);
  });

  it('a line turned by any angle keeps its width', async () => {
    const { paths } = await drawn('3 w 0.6 0.8 -0.8 0.6 100 100 cm 0 0 m 9 9 l S');
    expect(paths[0].lineWidth).toBeCloseTo(3, 6);
  });

  it('alpha 0 hides only the fill or only the stroke', async () => {
    const { paths } = await drawn('q /F gs 0 0 9 9 re B Q /S gs 0 0 9 9 re B', { resources: '/ExtGState<</F<</ca 0>>/S<</CA 0>>>>' });
    expect(paths.map(p => [p.fill, p.stroke])).toEqual([[false, true], [true, false]]);
  });

  it('a pattern fill is called pattern', async () => {
    const { paths } = await drawn('/Pattern cs /P scn 0 0 50 50 re f /Pattern CS /P SCN 0 0 50 50 re S', {
      resources: '/Pattern<</P 5 0 R>>',
      objects: ['<</PatternType 1/PaintType 1/TilingType 1/BBox[0 0 5 5]/XStep 5/YStep 5/Resources<<>>>>'],
      streams: { 5: bytes('0 0 m 5 5 l S') },
    });
    expect(paths.map(p => [p.fillColor, p.strokeColor])).toEqual([['pattern', '#000000'], ['pattern', 'pattern']]);
  });

  it('transparent paint is not read and leaves a plain colour behind', async () => {
    const shape: [number, unknown[]] = [OPS.constructPath, [OPS.fillStroke, [Float32Array.of(0, 1, 1, 1, 9, 1, 1, 9, 9, 4)], null]];
    const extracted = await made([[OPS.setFillTransparent, []], shape, [OPS.setFillRGBColor, ['#ff0000']], [OPS.setStrokeTransparent, []], shape]);
    if (!extracted.ok) throw new Error(extracted.code);
    expect(extracted.page.paths.slice(60).map(p => [p.fill, p.fillColor, p.stroke, p.strokeColor])).toEqual([
      [false, '#000000', true, '#000000'],
      [true, '#ff0000', false, '#000000'],
    ]);
  });

  it('a path operator pdf.js never sends for a page refuses the page', async () => {
    const quadratic = Float32Array.of(0, 1, 1, 3, 5, 9, 9, 1);
    expect(await made([[OPS.constructPath, [OPS.stroke, [quadratic], null]]])).toEqual({ ok: false, code: 'corrupt' });
  });

  it('a point too large for a number is left out', async () => {
    const huge = '9'.repeat(45);
    const { page, paths } = await drawn(`0 0 m ${huge} 0 l 9 9 l S ${huge} 0 m 5 5 l S q 0 0 m 50 0 l 50 50 l ${huge} 50 l 0 50 l h W n 1 1 5 5 re f Q`);
    expect(paths.map(p => p.subpaths.map(s => s.pts.length))).toEqual([[2], [4]]);
    expect([...paths.flatMap(points), ...page.clips.flat().flatMap(c => c.rings).flat()].flat().every(Number.isFinite)).toBe(true);
    expect(page.clips[1][1].rings[0]).toHaveLength(4);

    // a curve with such a point is left out whole, and the next one starts where the last point was
    const curves = await drawn(`0 0 m 5 5 l ${huge} 1 2 2 3 3 c 9 9 l S 0 0 m 5 5 l ${huge} 1 2 2 3 3 c 15 5 25 5 35 5 c S`);
    expect(curves.paths.map(p => [p.subpaths[0].curved, points(p).length])).toEqual([[false, 3], [true, 10]]);
    near([points(curves.paths[1])[2]], [[8.75, 395]]);

    const scale = `1${'0'.repeat(300)}`; // x or y alone leaves the range of a number
    const scaled = await drawn(`q ${scale} 0 0 1 0 0 cm 0 1 m 99999999999 2 l 0 3 l S Q q 1 0 0 ${scale} 0 0 cm 1 0 m 2 99999999999 l 3 0 l S Q`);
    expect(scaled.paths.map(p => points(p).length)).toEqual([2, 2]);
    expect(scaled.paths.flatMap(points).flat().every(Number.isFinite)).toBe(true);
  });

  it('no number that leaves is infinite: widths, texts, points and clips', async () => {
    const huge = '9'.repeat(400);
    const scale = `1${'0'.repeat(200)}`;
    const { page, paths } = await drawn(
      `2 w ${huge} w 0 0 m 9 9 l S /G gs 0 0 m 9 9 l S q ${scale} 0 0 ${scale} 0 0 cm 0 0 m 0 0 l S Q
       BT /F 12 Tf 1 0 0 1 ${huge} 300 Tm (far) Tj ET BT /F ${huge} Tf 1 0 0 1 10 300 Tm (tall) Tj ET BT /F 12 Tf 1 0 0 1 10 200 Tm (kept) Tj ET`,
      { resources: `/Font<</F<</Type/Font/Subtype/Type1/BaseFont/Helvetica>>>>/ExtGState<</G<</LW ${huge}>>>>` },
    );
    expect(paths.map(p => p.lineWidth)).toEqual([2, 2, 0]); // a canvas keeps its width when it is given none
    expect(page.texts).toEqual([{ str: 'kept', at: [10, 200], heightPt: 12 }]);
    const finite = (value: unknown): boolean => (typeof value === 'number' ? Number.isFinite(value) : typeof value !== 'object' || value === null || Object.values(value).every(finite));
    expect(finite(page)).toBe(true);
  });

  it('a form placed beyond all numbers hides its content', async () => {
    const { page, paths } = await drawn('/F Do', {
      ...FORM,
      objects: [`<</Type/XObject/Subtype/Form/BBox[0 0 10 10]/Matrix[${'9'.repeat(400)} 0 0 1 0 0]>>`],
      streams: { 5: bytes('0 0 10 10 re f') },
    });
    expect(paths).toEqual([]);
    expect(page.clips.flat().flatMap(c => c.rings).flat(2).every(Number.isFinite)).toBe(true);
  });

  it('a dash or an alpha that is no number does not refuse the page or hide the path', async () => {
    const { paths } = await drawn('[3] 0 d /D gs 0 0 9 9 re B [3] 0 d /N gs /A gs 0 0 9 9 re B', { resources: '/ExtGState<</D<</D[/x 0]>>/N<</D null>>/A<</ca/x/CA/x>>>>' });
    expect(paths.map(p => [p.fill, p.stroke, p.dashed])).toEqual([[true, true, false], [true, true, false]]);
  });

  it('annotations are not read', async () => {
    const { paths } = await drawn('0 0 9 9 re f', {
      page: '/Annots[<</Type/Annot/Subtype/Square/Rect[0 0 50 50]/F 4/AP<</N 5 0 R>>>>]',
      objects: ['<</Type/XObject/Subtype/Form/BBox[0 0 50 50]>>'],
      streams: { 5: bytes('0 0 50 50 re f') },
    });
    expect(paths).toHaveLength(1);
  });

  it('text items', async () => {
    const { page } = await drawn('BT /F 12 Tf 1 0 0 1 100 300 Tm (Bedroom) Tj 0 -50 Td (2) Tj ET q .5 0 0 .5 0 0 cm BT /F 12 Tf 1 0 0 1 100 300 Tm (Small) Tj ET Q', {
      resources: '/Font<</F<</Type/Font/Subtype/Type1/BaseFont/Helvetica>>>>',
    });
    expect(page.texts).toEqual([
      { str: 'Bedroom', at: [100, 100], heightPt: 12 },
      { str: '2', at: [100, 150], heightPt: 12 },
      { str: 'Small', at: [50, 250], heightPt: 6 },
    ]);
  });

  it('an image is not decoded while lines are read', async () => {
    const doc = await open(
      onePage(`${ticks(60)}q 9 0 0 9 0 0 cm /I Do Q BI /W 2 /H 2 /BPC 8 /CS /G ID abcd EI`, {
        resources: '/XObject<</I 5 0 R>>',
        objects: ['<</Type/XObject/Subtype/Image/Width 8/Height 8/BitsPerComponent 8/ColorSpace/DeviceGray>>'],
        streams: { 5: new Uint8Array(64) },
      }),
    );
    const { fnArray } = await (await doc.getPage(1)).getOperatorList();
    expect(fnArray.filter(fn => fn === OPS.constructPath)).toHaveLength(60);
    expect(fnArray.filter(fn => fn === OPS.paintImageXObject || fn === OPS.paintInlineImageXObject)).toEqual([]);
  });

  it('the caller keeps its bytes', async () => {
    const pdf = planPdf();
    const { length } = pdf;
    await read(pdf);
    expect(pdf).toHaveLength(length);
  });
});

describe('colours', () => {
  const filled = (uses: [hex: string, n: number][]) =>
    uses.flatMap(([fillColor, n]) => Array<PathItem>(n).fill({ fill: true, stroke: false, evenOdd: false, subpaths: [], fillColor, strokeColor: '#000000', lineWidth: 1, dashed: false, layer: null, clipId: 0 }));
  const hexes = (uses: [string, number][]) => summariseColours(filled(uses)).map(c => c.hex);

  it('colours: one use per path and colour; gray, white, n, pattern, unpainted and off the page do not count', async () => {
    const { page } = await drawn(
      '0 0 1 rg 1 0 0 RG 0 0 m 9 9 l S 1 0 0 rg 0 0 9 9 re f 0 0 9 9 re B .5 g 0 0 9 9 re f 1 g 0 0 9 9 re f 0 0 1 rg 0 0 9 9 re n 0 1 0 rg 700 0 9 9 re f /Pattern cs /P scn 0 0 9 9 re f',
      { resources: '/Pattern<</P 5 0 R>>', objects: ['<</PatternType 1/PaintType 1/TilingType 1/BBox[0 0 5 5]/XStep 5/YStep 5/Resources<<>>>>'], streams: { 5: bytes('0 0 m 5 5 l S') } },
    );
    expect(page.colours).toEqual([{ hex: '#ff0000', uses: 3 }]);
    expect(page.paths.filter(p => p.fill && p.fillColor === 'pattern')).toHaveLength(1);
  });

  it('colours: a path that fills and strokes counts for both', async () => {
    const { page } = await drawn('1 0 0 rg 0 0 1 RG 0 0 9 9 re B 0 0 9 9 re f');
    expect(page.colours).toEqual([{ hex: '#ff0000', uses: 2 }, { hex: '#0000ff', uses: 1 }]);
  });

  it('colours: shades of one colour are one entry, shown as the most used shade', () => {
    expect(summariseColours(filled([['#046004', 529], ['#063906', 578], ['#037f03', 478], ['#9a5c25', 137], ['#029802', 138]]))).toEqual([
      { hex: '#063906', uses: 1723 },
      { hex: '#9a5c25', uses: 137 },
    ]);
  });

  it('colours: a pale tint and another hue stay apart', () => {
    expect(hexes([['#9a5c25', 105], ['#c1a281', 22], ['#847d72', 19], ['#0000ff', 10], ['#ff0000', 7]])).toEqual(['#9a5c25', '#c1a281', '#0000ff', '#ff0000']);
    expect(summariseColours(filled([['#0000ff', 122], ['#4a9b55', 121], ['#36723e', 116], ['#00a600', 4]]))).toEqual([
      { hex: '#4a9b55', uses: 237 },
      { hex: '#0000ff', uses: 122 },
      { hex: '#00a600', uses: 4 },
    ]);
  });

  it('colours: spread 19 is gray, 20 is a colour; hue wraps at 0; ties go by hex; at most 12', () => {
    expect(hexes([['#332d28', 3], ['#646464', 9], ['#000000', 9], ['#ffffff', 9], ['#776464', 9]])).toEqual([]);
    expect(hexes([['#786464', 1]])).toEqual(['#786464']);
    expect(summariseColours(filled([['#ff0010', 2], ['#ff1000', 1]]))).toEqual([{ hex: '#ff0010', uses: 3 }]);
    expect(summariseColours(filled([['#ff00f0', 2], ['#f000ff', 1]]))).toEqual([{ hex: '#ff00f0', uses: 3 }]);
    expect(hexes([['#00ff00', 2], ['#0000ff', 2]])).toEqual(['#0000ff', '#00ff00']);
    expect(summariseColours(filled([['#037f03', 2], ['#029802', 2]]))).toEqual([{ hex: '#029802', uses: 4 }]);
    const pure = (hue: number) => `#${[0, 8, 4].map(n => Math.round(255 * (0.5 - 0.5 * Math.max(-1, Math.min(((n + hue / 30) % 12) - 3, 9 - ((n + hue / 30) % 12), 1)))).toString(16).padStart(2, '0')).join('')}`;
    const fourteen = Array.from({ length: 14 }, (_, i): [string, number] => [pure(i * 25), 14 - i]);
    expect(summariseColours(filled(fourteen)).map(c => c.uses)).toEqual([14, 13, 12, 11, 10, 9, 8, 7, 6, 5, 4, 3]);
  });

  it('colours: one entry up to a hue gap of 15 degrees and a saturation gap of 0.35', () => {
    expect(hexes([['#ff0000', 2], ['#ff3f00', 1]])).toEqual(['#ff0000']); // 14.8 degrees
    expect(hexes([['#ff0000', 2], ['#ff4000', 1]])).toEqual(['#ff0000', '#ff4000']); // 15.1
    expect(hexes([['#ff0000', 2], ['#ff5959', 1]])).toEqual(['#ff0000']); // 0.349
    expect(hexes([['#ff0000', 2], ['#ff5a5a', 1]])).toEqual(['#ff0000', '#ff5a5a']); // 0.353
  });
});
