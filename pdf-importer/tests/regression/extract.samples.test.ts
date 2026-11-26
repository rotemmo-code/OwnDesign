import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import * as pdfjs from 'pdfjs-dist/legacy/build/pdf.mjs';
import { expect, it } from 'vitest';
import { MAX_COLOURS } from '../../src/limits';
import { extractPage, openDocument } from '../../src/pdf/extract';
import { ALL_16_PAGES, describeSamples, samplePage, samplePath, SAMPLES_DIR, type SampleId } from '../samples';

// Numbers only, here and in the baseline: file names, layer names and texts of the samples are confidential.
async function readSample(id: SampleId) {
  let pdf: Uint8Array;
  try {
    pdf = new Uint8Array(readFileSync(samplePath(id)));
  } catch {
    throw new Error(`${id} cannot be read`); // the system's message would hold the file name
  }
  const start = performance.now();
  const opened = await openDocument(pdfjs, pdf);
  if (!opened.ok) throw new Error(`${id}: ${opened.code}`);
  const extracted = await extractPage(pdfjs, opened.doc, samplePage(id));
  if (!extracted.ok) throw new Error(`${id}: ${extracted.code}`);
  return { page: extracted.page, ms: performance.now() - start };
}

const read = new Map<SampleId, ReturnType<typeof readSample>>();
function sample(id: SampleId) {
  if (!read.has(id)) read.set(id, readSample(id));
  return read.get(id)!;
}

const baselineFile = path.join(SAMPLES_DIR, 'regression', 'extract.json');

describeSamples('extract', () => {
  const all = { timeout: 60_000 };

  it.each(ALL_16_PAGES)('%s matches its baseline', all, async id => {
    const { page } = await sample(id);
    const counts = {
      paths: page.paths.length,
      fills: page.paths.filter(p => p.fill).length,
      strokes: page.paths.filter(p => p.stroke).length,
      clips: page.clips.length,
      texts: page.texts.length,
      layers: page.layers.length,
      colours: page.colours.length,
    };
    const baseline: Record<string, typeof counts> = existsSync(baselineFile) ? JSON.parse(readFileSync(baselineFile, 'utf8')) : {};
    if (!baseline[id]) {
      mkdirSync(path.dirname(baselineFile), { recursive: true });
      writeFileSync(baselineFile, JSON.stringify({ ...baseline, [id]: counts }, null, 1));
    }
    expect(counts).toEqual(baseline[id] ?? counts);
  });

  it('S01: rotation 270, 1684 x 1191, 109 paths on the layer whose name holds hatch and wall', all, async () => {
    const { page } = await sample('S01');
    expect([page.rotation, Math.round(page.widthPt), Math.round(page.heightPt)]).toEqual([270, 1684, 1191]);
    expect(page.paths.filter(p => p.layer && /hatch/i.test(p.layer) && /wall/i.test(p.layer)).length).toBe(109);
  });

  it('S16: 14,616 paths', all, async () => {
    expect((await sample('S16')).page.paths.length).toBe(14_616);
  });

  it('S11 to S16 list 1 to 12 colours', all, async () => {
    for (const id of ['S11', 'S12', 'S13', 'S14', 'S15', 'S16'] as const) {
      const listed = (await sample(id)).page.colours.length;
      expect(listed, id).toBeGreaterThanOrEqual(1);
      expect(listed, id).toBeLessThanOrEqual(MAX_COLOURS);
    }
  });

  it('each page opens and extracts in under 3 s', all, async () => {
    for (const id of ALL_16_PAGES) expect((await sample(id)).ms, id).toBeLessThan(3000);
  });
});
