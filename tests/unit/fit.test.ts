import { describe, expect, it } from 'vitest';
import type { Dim, Vec } from '../../src/shared';
import { calibrationOf, fitCalibration, type Fit } from '../../src/calibrate/fit';

// Every value is synthetic. A dimension is written [drawn mm, written mm]; `at` draws it at one scale (mm per point).
type Pair = [drawn: number, written: number];
const mmPerPt = (scale: number) => (scale * 25.4) / 72;
const K50 = mmPerPt(50);
const K100 = mmPerPt(100);
const K118 = mmPerPt(118); // far from a standard scale

let row = 0; // every dimension gets its own line of the page
const dimOf = (drawnMm: number, writtenMm: number, k = K50): Dim => ({ a: [0, 20 * ++row], b: [drawnMm / k, 20 * row], writtenMm });
const at = (k: number, ...pairs: Pair[]) => pairs.map(([drawn, written]) => dimOf(drawn, written, k));
const fit = (dims: Dim[], chosen: 50 | 100 = 50) => fitCalibration(dims, chosen);
const fit50 = (...pairs: Pair[]) => fit(at(K50, ...pairs));
const fit118 = (...pairs: Pair[]) => fit(at(K118, ...pairs));
const exact = (...lengths: number[]) => lengths.map((length): Pair => [length, length]);
const offsetBy = (c: number, ...lengths: number[]) => lengths.map((length): Pair => [length + c, length]);
/** Four pinned lengths with a mean offset of exactly `c`, the last one 8 mm below the others: without an offset they do not fit. */
const meanOffset = (c: number): Pair[] => [[5000 + c + 2, 5000], [4000 + c + 2, 4000], [3000 + c + 2, 3000], [1000 + c - 6, 1000]];

/** Everything a fit says except its numbers. */
const answer = (f: Fit) =>
  [f.status, f.need, f.near && `near ${f.near}`, f.unverified && `button ${f.unverified.scale}`].filter(Boolean).join(' ');

/**
 * The answers to the same dimensions at 400 places of the page: moved, turned, ends swapped, in another order.
 * The lengths then differ by rounding only. `stored` is how the coordinates are kept: 64-bit, or 32-bit as in a PDF path.
 */
function answersAnywhere(k: number, pairs: Pair[], stored = (x: number) => x): string[] {
  let seed = 1;
  const random = () => (seed = (seed * 16807) % 2147483647) / 2147483647;
  const answers = Array.from({ length: 400 }, () => {
    const dims = pairs.map(([drawn, writtenMm]): Dim => {
      const start: Vec = [2000 * random(), 2000 * random()];
      const angle = 2 * Math.PI * random();
      const a: Vec = [stored(start[0]), stored(start[1])];
      const b: Vec = [stored(start[0] + (drawn / k) * Math.cos(angle)), stored(start[1] + (drawn / k) * Math.sin(angle))];
      return random() < 0.5 ? { a, b, writtenMm } : { a: b, b: a, writtenMm };
    });
    return answer(fit(random() < 0.5 ? dims : dims.reverse()));
  });
  return [...new Set(answers)];
}

describe('standard scales', () => {
  const four: Pair[] = [[3051, 3050], [4371, 4370], [2411, 2410], [1461, 1460]];
  it('dimensions that fit: the scale, no offset, and what is left of each dimension', () => {
    expect(fit50(...four)).toStrictEqual({
      status: 'ok', scale: expect.closeTo(50, 9), mmPerPt: expect.closeTo(17.638889, 6), offsetMm: 0,
      residualsMm: four.map(() => expect.closeTo(1, 6)), used: [true, true, true, true],
    });
  });
  it('a constant offset is reported, not stretched into the scale; the residuals are what is left after it', () => {
    expect(fit50([3098, 3050], [4419, 4370], [2459, 2410], [1509, 1460])).toStrictEqual({      // drawn minus written: 48, 49, 49, 49
      status: 'ok-offset', scale: expect.closeTo(50, 9), mmPerPt: expect.closeTo(K50, 9), offsetMm: expect.closeTo(48.75, 6),
      residualsMm: [-0.75, 0.25, 0.25, 0.25].map(r => expect.closeTo(r, 6)), used: [true, true, true, true],
    });
  });
  it('the offset is the mean, however small', () => {
    expect(fit50([5050, 5000], [4050, 4000], [3050, 3000], [2056, 2000]).offsetMm).toBeCloseTo(51.5, 6);
    expect(fit50([4995.1, 5000], [3995.1, 4000], [3015.05, 3000], [995.11, 1000])).toMatchObject({ status: 'ok-offset', offsetMm: expect.closeTo(0.09, 6) });   // without it 3015.05 is over its 15 mm
  });
  it('a drawing at the other standard scale is named, whichever was chosen', () => {
    expect(fit(at(K100, ...four), 50)).toMatchObject({ status: 'other-standard', scale: expect.closeTo(100, 9), mmPerPt: expect.closeTo(35.277778, 6), offsetMm: 0 });
    expect(fit(at(K50, ...four), 100)).toMatchObject({ status: 'other-standard', scale: expect.closeTo(50, 9), mmPerPt: expect.closeTo(K50, 9) });
    expect(answer(fit(at(K100, ...four), 100))).toBe('ok');
  });
  it('an offset at 1:100', () => {
    expect(answer(fit(at(K100, ...offsetBy(50, 5000, 4000, 3000, 1000)), 100))).toBe('ok-offset');
    expect(fit(at(K100, ...offsetBy(50, 5000, 4000, 3000, 1000)), 50)).toMatchObject({ status: 'other-standard', offsetMm: expect.closeTo(50, 6) });
  });
  it('vertical and slanted dimensions are measured along their whole length', () => {
    const standing = (mm: number): Dim => ({ a: [100, 100], b: [100, 100 + mm / K50], writtenMm: mm });
    const slanted = (mm: number): Dim => ({ a: [400, 100], b: [400 + (0.6 * mm) / K50, 100 + (0.8 * mm) / K50], writtenMm: mm });
    expect(answer(fit([standing(5000), slanted(4000), dimOf(3000, 3000), { ...standing(1500), a: [700, 100], b: [700, 100 + 1500 / K50] }]))).toBe('ok');
  });
  it('a dimension may be wrong by 1 cm or 0.5 %, whichever is more', () => {
    const others = exact(6000, 4500, 1500);
    for (const [drawn, written] of [[2010, 2000], [1990, 2000], [1010, 1000], [990, 1000], [4020, 4000], [3980, 4000], [3015, 3000], [5025, 5000]])
      expect(answer(fit50([drawn, written], ...others)), `${drawn}/${written}`).toBe('ok');
    for (const [drawn, written] of [[2010.0005, 2000], [1989.9, 2000], [1010.1, 1000], [4020.1, 4000], [3015.1, 3000], [5025.1, 5000]])
      expect(answer(fit50([drawn, written], ...others)), `${drawn}/${written}`).not.toBe('ok');
    expect(fit50([6080, 6000], [5050, 5000], [3050, 3000], [1050, 1000])).toMatchObject({ status: 'ok-offset', offsetMm: expect.closeTo(57.5, 6) });   // 22.5 mm at 6 m, after the offset
  });
  it('an offset of -1 to 8 cm is accepted, 0.1 mm more is not: then the drawing cannot be calibrated', () => {
    for (const c of [-10, 30, 80]) expect(fit50(...meanOffset(c)), String(c)).toMatchObject({ status: 'ok-offset', offsetMm: expect.closeTo(c, 6) });
    for (const c of [-10.1, 80.1, -50, 95]) expect(answer(fit50(...meanOffset(c))), String(c)).toBe('need-more offset');
  });
  it('an offset of exactly 10 cm cannot be calibrated, above it the dimensions contradict each other', () => {
    expect(answer(fit50(...offsetBy(100, 5000, 4000, 3000, 1000)))).toBe('need-more offset');
    expect(answer(fit50(...offsetBy(-100, 5000, 4000, 3000, 1000)))).toBe('need-more offset');
    expect(answer(fit50(...offsetBy(100.1, 5000, 4000, 3000, 1000)))).toBe('inconsistent');
    expect(answer(fit50(...offsetBy(-100.1, 5000, 4000, 3000, 1000)))).toBe('inconsistent');
  });
  it('an offset that one dimension does not follow is not an offset', () => {
    expect(answer(fit50([5050, 5000], [4050, 4000], [3050, 3000], [1090, 1000]))).toBe('inconsistent');
  });
});

describe('pinned: no other scale that explains the dimensions is more than 1.25 % away', () => {
  it('two lengths 1783 mm apart pin the scale, 1782 do not; then one more is asked for, or the button pressed', () => {
    expect(answer(fit50(...exact(5000, 4400, 3900, 3217)))).toBe('ok');
    const unpinned = fit50(...exact(5000, 4400, 3900, 3218));
    expect(answer(unpinned)).toBe('need-more spread button 50');
    expect(unpinned.unverified).toEqual({ scale: 50, mmPerPt: expect.closeTo(K50, 9), offsetMm: 0 });
  });
  it('a length of 8992 mm pins the scale alone, 8991 does not', () => {
    expect(answer(fit50(...exact(8992, 8700, 8500, 8300)))).toBe('ok');
    expect(answer(fit50(...exact(8991, 8700, 8500, 8300)))).toBe('need-more spread button 50');
    expect(answer(fit50(...offsetBy(-10, 9691, 9400, 9200, 9000)))).toBe('ok');                                          // drawn 1 cm short: a larger scale is possible
    expect(answer(fit50(...offsetBy(-10, 9690, 9400, 9200, 9000)))).toBe('need-more spread button 50');
  });
  it('both directions count: the other scale may be too large or too small', () => {
    expect(answer(fit50([4995, 5000], [3005, 3000], [3205, 3200], [3405, 3400]))).toBe('need-more spread button 50');   // up to 1.6 % larger, 0.6 % smaller
    expect(answer(fit50([5005, 5000], [2995, 3000], [3195, 3200], [3395, 3400]))).toBe('need-more spread button 50');   // the other way round
  });
  it('a dimension that fits badly widens the search, whichever way it is off', () => {
    expect(answer(fit50(...exact(5000, 4000, 3500, 3100)))).toBe('ok');
    expect(answer(fit50([5000, 5000], [4014, 4000], [3500, 3500], [3100, 3100]))).toBe('need-more spread button 50');
    expect(answer(fit50([5000, 5000], [3986, 4000], [3500, 3500], [3100, 3100]))).toBe('need-more spread button 50');
  });
  it('an exact 1:49.5 drawing is not accepted as 1:50', () => {
    expect(fit(at(mmPerPt(49.5), ...exact(5000, 3000, 2000, 1100)))).toMatchObject({ status: 'nonstandard', scale: expect.closeTo(49.5, 6), near: 50 });
    expect(answer(fit(at(mmPerPt(49.5), ...exact(5000, 4400, 3900, 3250))))).toBe('need-more spread button 50');         // looks like 1:50 with a 4 cm offset
  });

  // One dimension may be wrong by 11 mm: 5 for writing whole centimetres and 6 of scatter. Each set looks like 1:50 with smaller errors, but with such errors (and an offset of 0 to 8 cm) the scale named here explains it as well.
  it.each<[string, string, Pair[]]>([
    ['1:51.69', 'need-more spread button 50', [[2349.96, 2340], [2340.04, 2350], [2990.05, 3000]]],
    ['1:53.30', 'need-more count', [[2740.02, 2830], [2710.39, 2820], [2899.65, 3000]]],
    ['1:51.69', 'need-more spread button 50', [[2349.9998, 2340], [2340.0002, 2350], [2019.9998, 2010], [2990.0002, 3000]]],
    ['1:53.48', 'need-more spread', [[2590.0198, 2680], [2580.0202, 2690], [2890.0202, 3000], [2290.0198, 2380]]],
    ['1:48.06', 'need-more spread', [[2559.9446, 2470], [2549.8198, 2440], [3109.9442, 3000], [2100.069, 2010]]],
  ])('not accepted while %s explains the dimensions too -> %s', (_, expected, pairs) => {
    expect(answer(fit50(...pairs))).toBe(expected);
  });
  it('one dimension does not have the offset of the three others: 1:50 is not seen, and no other scale is accepted', () => {
    expect(answer(fit50([3143, 3080], [3184, 3130], [2104, 2100], [2803, 2750]))).toBe('need-more spread');              // the best free fit is 1:47.45 with an offset of -10 cm
  });
});

describe('fewer than three dimensions: never verified, the user may continue with a warning', () => {
  const two: Pair[] = [[3051, 3050], [4371, 4370]];
  it('one or two that fit a standard scale without an offset: the button', () => {
    for (const pairs of [two.slice(1), two]) expect(answer(fit50(...pairs)), String(pairs.length)).toBe('need-more count button 50');
    expect(fit50(two[1])).toStrictEqual({
      status: 'need-more', need: 'count', scale: NaN, mmPerPt: NaN, offsetMm: NaN, residualsMm: [expect.closeTo(1, 6)], used: [true],
      unverified: { scale: 50, mmPerPt: expect.closeTo(K50, 9), offsetMm: 0 },
    });
  });
  it('the button carries the scale that was found, not the one that was chosen', () => {
    for (const pairs of [two, two.slice(0, 1)]) {
      expect(fit(at(K100, ...pairs), 50).unverified, String(pairs.length)).toEqual({ scale: 100, mmPerPt: expect.closeTo(35.277778, 6), offsetMm: 0 });
      expect(fit(at(K50, ...pairs), 100).unverified, String(pairs.length)).toEqual({ scale: 50, mmPerPt: expect.closeTo(K50, 9), offsetMm: 0 });
    }
  });
  it('one of them must be written as 3 m or more', () => {
    expect(answer(fit50([3000, 3000]))).toBe('need-more count button 50');
    expect(answer(fit50([3000, 3000], [1000, 1000]))).toBe('need-more count button 50');
    expect(answer(fit50([3009, 2999.9]))).toBe('need-more count');
    expect(answer(fit50(...exact(2999.9, 2500)))).toBe('need-more count');
  });
  it('the tolerance is the one of a verified scale', () => {
    expect(answer(fit50([5025, 5000]))).toBe('need-more count button 50');
    expect(answer(fit50([5025.1, 5000]))).toBe('need-more count');
  });
  it('no button with an offset, a scale that is not standard, or a contradiction', () => {
    expect(answer(fit50([4050, 4000]))).toBe('need-more count');
    expect(answer(fit50([4050, 4000], [3050, 3000]))).toBe('need-more count');
    expect(answer(fit118(...exact(5000, 3000)))).toBe('need-more count');
    expect(answer(fit50([6000, 6000], [4000, 4400]))).toBe('need-more count');
  });
  it('no dimensions at all', () => {
    expect(fit([])).toStrictEqual({ status: 'need-more', need: 'count', scale: NaN, mmPerPt: NaN, offsetMm: NaN, residualsMm: [], used: [] });
  });
});

describe('three dimensions: enough without an offset, one more is needed with one', () => {
  it('without an offset they are verified like four', () => {
    expect(answer(fit50(...exact(5000, 4000, 3217)))).toBe('ok');
    expect(answer(fit50(...exact(5000, 4000, 3218)))).toBe('need-more spread button 50');
    expect(answer(fit(at(K100, ...exact(5000, 4000, 3217)), 50))).toBe('other-standard');
    expect(answer(fit(at(K100, ...exact(5000, 4000, 3218)), 50))).toBe('need-more spread button 100');
    expect(fit118(...exact(5000, 3000, 1000))).toMatchObject({ status: 'nonstandard', scale: expect.closeTo(118, 6), offsetMm: 0 });
    expect(answer(fit118(...exact(5000, 4400, 3900)))).toBe('need-more spread');
    expect(fit118([5000, 4992], [3500, 3508], [1500, 1500])).toMatchObject({ status: 'nonstandard', offsetMm: 0 });      // an offset explains them better, but three dimensions cannot tell
  });
  it('with a constant offset of -1 to 8 cm one more is asked for, and the button carries the offset', () => {
    const f = fit50([5050, 5000], [5060, 5010], [4960, 4910]);
    expect(answer(f)).toBe('need-more count button 50');
    expect(f.unverified!.offsetMm).toBeCloseTo(50, 6);
    expect(answer(fit50(...offsetBy(50, 6000, 3000, 1000)))).toBe('need-more count button 50');                          // even when they are far apart
    expect(answer(fit(at(K100, ...offsetBy(50, 6000, 3000, 1000)), 50))).toBe('need-more count button 100');
    const widths = [3000, 3100, 3200];
    const drawn = (...extra: number[]) => fit50(...extra.map((e, i): Pair => [widths[i] + e, widths[i]]));
    expect(drawn(-16, -7, -7).unverified).toEqual({ scale: 50, mmPerPt: expect.closeTo(K50, 9), offsetMm: expect.closeTo(-10, 6) });
    expect(drawn(86, 77, 77).unverified).toEqual({ scale: 50, mmPerPt: expect.closeTo(K50, 9), offsetMm: expect.closeTo(80, 6) });
    expect(answer(drawn(-16.1, -7.1, -7.1))).toBe('need-more count');
    expect(answer(drawn(86.1, 77.1, 77.1))).toBe('need-more count');
    expect(answer(fit50(...offsetBy(101, 5000, 3000, 1000)))).toBe('need-more count');
    expect(answer(fit118(...offsetBy(50, 5000, 3000, 1000)))).toBe('need-more count');                                   // a scale that is not standard: never the button
  });
  it('one of them must be written as 3 m or more', () => {
    expect(answer(fit50(...exact(2999.9, 2500, 1200)))).toBe('need-more long');
    expect(answer(fit50(...exact(3000, 2400, 1100)))).toBe('ok');
  });
  it('three that contradict each other are refused at once', () => {
    expect(answer(fit50([3051, 3050], [4371, 4870], [2411, 2410]))).toBe('inconsistent');                                // 4370 typed as 4870
    expect(answer(fit50([6000, 6000], [4000, 4400], [2900, 2900]))).toBe('inconsistent');                                // 4000 typed as 4400
    expect(answer(fit50([5000, 5000], [5000, 5200], [5000, 5000]))).toBe('inconsistent');                                // the same length, written 20 cm apart
    expect(answer(fit50([5000, 4990], [5014, 5050], [3000, 3000]))).toBe('need-more count');                             // not the same length, so possible
    expect(answer(fit50([5000, 4960], [5000, 5009], [3000, 3000]))).toBe('need-more count');                             // the same length, 49 mm apart: just possible
    expect(answer(fit50([5000, 4955], [5000, 5020], [3000, 3000]))).toBe('inconsistent');                                // 65 mm apart: not possible
    expect(answer(fit50([2000, 2000], [2500, 2525], [3000, 3000]))).toBe('need-more count');                             // 2525 is just possible
    expect(answer(fit50([2000, 2000], [2500, 2526], [3000, 3000]))).toBe('inconsistent');
    expect(answer(fit50([1858.25, 1880], [2731.24, 2710], [3899.39, 3890]))).toBe('inconsistent');                       // the limits differ: 1 cm, 1.36 cm, 1.95 cm
    expect(answer(fit50([5050, 5000], [4050, 4000], [3000, 3000]))).toBe('need-more count');                             // one does not follow the others, but it can be explained
  });
});

describe('four or more that are not enough', () => {
  it('none is written as 3 m or more', () => {
    expect(answer(fit50(...exact(2999.9, 2400, 1700, 1100)))).toBe('need-more long');
    expect(answer(fit50(...exact(3000, 2400, 1700, 1100)))).toBe('ok');
    expect(answer(fit50(...exact(5000, 2400, 1700, 1100)))).toBe('ok');
  });
  it('similar lengths: the button carries the scale that was found, not the one that was chosen', () => {
    const similar = exact(3000, 3200, 3400, 3100);
    for (const [k, chosen, scale] of [[K50, 50, 50], [K100, 50, 100], [K50, 100, 50], [K100, 100, 100]] as const)
      expect(answer(fit(at(k, ...similar), chosen)), `${scale} while ${chosen} is chosen`).toBe(`need-more spread button ${scale}`);
    expect(fit(at(K100, ...similar), 50).unverified!.mmPerPt).toBeCloseTo(35.277778, 6);
  });
  it('the button is offered for an offset of -1 to 8 cm', () => {
    const offset = (extra: number[]) => fit50(...[3000, 3100, 3200, 3300].map((written, i): Pair => [written + extra[i], written]));
    expect(offset([50, 50, 50, 50]).unverified).toEqual({ scale: 50, mmPerPt: expect.closeTo(K50, 9), offsetMm: expect.closeTo(50, 6) });
    expect(answer(offset([-16, -8, -8, -8]))).toBe('need-more spread button 50');                                        // -10
    expect(answer(offset([86, 78, 78, 78]))).toBe('need-more spread button 50');                                         // 80
    expect(answer(offset([-16.1, -8.1, -8.1, -8.1]))).toBe('need-more spread');
    expect(answer(offset([86.1, 78.1, 78.1, 78.1]))).toBe('need-more spread');
    expect(answer(offset([-31, -31, -31, -31]))).toBe('need-more spread');
    expect(answer(offset([95, 95, 95, 95]))).toBe('need-more spread');
  });
  it('a scale that is not standard never has the button', () => {
    expect(answer(fit118(...exact(5000, 4400, 3900, 3250)))).toBe('need-more spread');
    expect(answer(fit118(...offsetBy(50, 5000, 4400, 3900, 3250)))).toBe('need-more spread');
  });
  it('one mistyped value among four', () => {
    expect(answer(fit50([3051, 3050], [4371, 4870], [2411, 2410], [3001, 3000]))).toBe('inconsistent');
    expect(answer(fit50([5000, 5000], [5000, 5200], [5000, 5000], [3000, 3000]))).toBe('inconsistent');
    expect(answer(fit118([5000, 5000], [4000, 4400], [2900, 2900], [1500, 1500]))).toBe('inconsistent');
  });
  it('a refused fit has no numbers, only what is left of each dimension at the chosen scale', () => {
    const typo: Pair[] = [[3051, 3050], [4371, 4870], [2411, 2410], [3001, 3000]];
    expect(fit(at(K50, ...typo), 50)).toStrictEqual({
      status: 'inconsistent', scale: NaN, mmPerPt: NaN, offsetMm: NaN, residualsMm: [1, -499, 1, 1].map(r => expect.closeTo(r, 6)), used: [true, true, true, true],
    });
    expect(fit(at(K50, ...typo), 100).residualsMm).toEqual([3052, 3872, 2412, 3002].map(r => expect.closeTo(r, 6)));
  });
});

describe('a scale that is not standard', () => {
  it('four dimensions far apart: the scale, with an offset of -1 to 8 cm or none', () => {
    expect(fit118(...exact(5000, 4000, 3000, 1000))).toStrictEqual({
      status: 'nonstandard', scale: expect.closeTo(118, 6), mmPerPt: expect.closeTo(K118, 9), offsetMm: 0,
      residualsMm: [0, 0, 0, 0].map(r => expect.closeTo(r, 6)), used: [true, true, true, true],
    });
    for (const c of [50, 80]) expect(fit118(...offsetBy(c, 5000, 4000, 3000, 1000)), String(c)).toMatchObject({ status: 'nonstandard', scale: expect.closeTo(118, 6), offsetMm: expect.closeTo(c, 6) });
    for (const c of [80.1, -60, 100, -100]) expect(answer(fit118(...offsetBy(c, 5000, 4000, 3000, 1000))), String(c)).toBe('need-more offset');
    for (const c of [100.1, -100.1]) expect(answer(fit118(...offsetBy(c, 5000, 4000, 3000, 1000))), String(c)).toBe('inconsistent');
  });
  it('an offset of -1 cm is accepted, 0.1 mm more cannot be calibrated', () => {
    const bent = (c: number): Pair[] => [[6000, 5991 - c], [5000, 5009 - c], [4000, 4009 - c], [3000, 2991 - c]];        // 9 mm off in turn, so that a scale without an offset does not fit
    expect(fit118(...bent(-10))).toMatchObject({ status: 'nonstandard', scale: expect.closeTo(118, 6), offsetMm: expect.closeTo(-10, 6) });
    expect(answer(fit118(...bent(-10.1)))).toBe('need-more offset');
  });
  it('a scale without an offset is the least-squares one', () => {
    expect(fit118([5000, 4995], [2500, 2510], [4000, 4000], [2000, 2000])).toMatchObject({                                // residuals 5, -10, 0, 0
      status: 'nonstandard', scale: expect.closeTo(118, 6), offsetMm: 0, residualsMm: [5, -10, 0, 0].map(r => expect.closeTo(r, 6)),
    });
    expect(fit118([5000, 4992], [2500, 2508], [4000, 4000], [2000, 2000]).scale).toBeCloseTo((118 * 51230000) / 51250000, 6);
  });
  it('every dimension must fit within 1 cm, the 0.5 % of a standard scale does not count', () => {
    const bent = (by: number, c = 0): Pair[] => [[6000, 6000 - c - by], [5000, 5000 - c + by], [4000, 4000 - c + by], [3000, 3000 - c - by]];
    for (const c of [0, 50]) {
      expect(answer(fit118(...bent(10, c))), String(c)).toBe('nonstandard');
      expect(answer(fit118(...bent(10.1, c))), String(c)).toBe('inconsistent');
      expect(answer(fit118(...bent(14, c))), String(c)).toBe('inconsistent');
    }
  });
  it('within 3 % of a standard scale the user is warned', () => {
    for (const [scale, near] of [[97, 100], [103, 100], [48.5, 50], [51.5, 50]] as const)
      for (const chosen of [50, 100] as const) expect(answer(fit(at(mmPerPt(scale), ...exact(5000, 4000, 3000, 1000)), chosen)), String(scale)).toBe(`nonstandard near ${near}`);
    for (const scale of [96.99, 103.01, 48.495, 51.505, 75]) expect(answer(fit(at(mmPerPt(scale), ...exact(5000, 4000, 3000, 1000)))), String(scale)).toBe('nonstandard');
  });
  it('scale and offset cannot be told apart when the two explanations differ by more than 0.5 %', () => {
    for (const sign of [1, -1]) {
      const drawn = (...lengths: number[]) => fit118(...lengths.map((length): Pair => [length, length - 20 * sign]));
      expect(answer(drawn(2500, 3700, 4100, 4900)), String(sign)).toBe('need-more ambiguous');                             // 0.5003 %
      expect(drawn(2100, 3500, 3700, 5300), String(sign)).toMatchObject({ status: 'nonstandard', offsetMm: 0 });           // 0.4997 %: the scale without an offset
    }
  });
});

describe('the same dimensions give the same answer wherever they lie on the page', () => {
  it.each<[string, string, Pair[]]>([
    ['a dimension exactly at its tolerance', 'ok', [[2010, 2000], [4020, 4000], [6000, 6000], [1500, 1500]]],
    ['an offset of exactly 8 cm', 'ok-offset', offsetBy(80, 5000, 4000, 3000, 1000)],
    ['an offset of exactly -1 cm', 'ok-offset', meanOffset(-10)],
    ['an offset of exactly 10 cm', 'need-more offset', offsetBy(100, 5000, 4000, 3000, 1000)],
    ['an offset of exactly -10 cm', 'need-more offset', offsetBy(-100, 5000, 4000, 3000, 1000)],
    ['an offset of exactly -1 cm on the button', 'need-more spread button 50', [[2984, 3000], [3092, 3100], [3192, 3200], [3292, 3300]]],
    ['an offset of exactly 8 cm on the button', 'need-more spread button 50', [[3086, 3000], [3178, 3100], [3278, 3200], [3378, 3300]]],
    ['an offset of exactly 8 cm, three dimensions', 'need-more count button 50', offsetBy(80, 5000, 3000, 1000)],
    ['an offset of exactly 10 cm, three similar lengths', 'need-more count', offsetBy(100, 8400, 8750, 7790)],
    ['equal lengths written 523, 525, 524 cm', 'need-more spread button 50', [[5240, 5230], [5240, 5250], [5240, 5240]]],
    ['equal lengths written 523, 525, 524, 524 cm', 'need-more spread button 50', [[5240, 5230], [5240, 5250], [5240, 5240], [5240, 5240]]],
    ['equal lengths written exactly 22 mm apart', 'need-more spread button 50', [[5240, 5229], [5240, 5251], [5240, 5240], [5240, 5240]]],
    ['equal lengths written 28 mm apart and two others', 'need-more spread button 50', [[5000, 4986], [5000, 5014], [3000, 2986], [3200, 3186]]],
    ['equal lengths that contradict each other', 'inconsistent', [[5000, 5000], [5000, 5200], [5000, 5000]]],
    ['dimensions that only one scale explains', 'need-more count', [[1000, 1000], [1400, 1421], [3000, 3000]]],
    ['four dimensions that only one scale explains', 'ok', [[3015, 3000], [4000, 4015], [5015, 5000], [6000, 6015]]],
  ])('%s -> %s', (_, expected, pairs) => {
    expect(answersAnywhere(K50, pairs)).toEqual([expected]);
  });
  it('equal lengths, with the coordinates stored as 32-bit numbers', () => {
    expect(answersAnywhere(K50, [[5240, 5230], [5240, 5250], [5240, 5240]], Math.fround)).toEqual(['need-more spread button 50']);
    expect(answersAnywhere(K50, [[5240, 5230], [5240, 5250], [5240, 5240], [5240, 5240]], Math.fround)).toEqual(['need-more spread button 50']);
    expect(answersAnywhere(K50, [[5000, 5000], [5000, 5200], [5000, 5000]], Math.fround)).toEqual(['inconsistent']);
  });
  it.each<[string, string, number, Pair[]]>([
    ['3 % under 1:100', 'nonstandard near 100', 97, exact(5000, 4000, 3000, 1000)],
    ['3 % over 1:100', 'nonstandard near 100', 103, exact(5000, 4000, 3000, 1000)],
    ['3 % under 1:50', 'nonstandard near 50', 48.5, exact(5000, 4000, 3000, 1000)],
    ['3 % over 1:50', 'nonstandard near 50', 51.5, exact(5000, 4000, 3000, 1000)],
    ['1 cm from a scale without an offset', 'nonstandard', 118, [[5000, 4995], [2500, 2510], [4000, 4000], [2000, 2000]]],
    ['1 cm from a scale with an offset', 'nonstandard', 118, [[6000, 5940], [5000, 4960], [4000, 3960], [3000, 2940]]],
    ['a scale and an offset of exactly 8 cm', 'nonstandard', 118, offsetBy(80, 5000, 4000, 3000, 1000)],
    ['a scale and an offset of exactly 10 cm', 'need-more offset', 118, offsetBy(100, 5000, 4000, 3000, 1000)],
    ['four equal lengths at a scale that is not standard', 'need-more spread', 118, exact(5000, 5000, 5000, 5000)],
  ])('%s -> %s', (_, expected, scale, pairs) => {
    expect(answersAnywhere(mmPerPt(scale), pairs)).toEqual([expected]);
  });
});

describe('short dimensions: listed, never refused, not used', () => {
  it('80 cm stays in the list with its residual', () => {
    const f = fit50([3051, 3050], [4371, 4370], [2411, 2410], [1461, 1460], [800, 800]);
    expect(f).toMatchObject({ status: 'ok', used: [true, true, true, true, false] });
    expect(f.residualsMm[4]).toBeCloseTo(0, 6);
  });
  it('a door without plaster in a drawing with a 5 cm offset does not disturb the fit, and no offset is taken off it', () => {
    const f = fit50([810, 800], ...offsetBy(50, 5000, 4000, 3000, 1000));
    expect(f).toMatchObject({ status: 'ok-offset', offsetMm: expect.closeTo(50, 6), used: [false, true, true, true, true] });
    expect(f.residualsMm).toEqual([10, 0, 0, 0, 0].map(r => expect.closeTo(r, 6)));
  });
  it('a short dimension does not count towards three, or towards four with an offset, and may contradict the others', () => {
    expect(fit50([3051, 3050], [4371, 4370], [800, 900])).toMatchObject({ status: 'need-more', need: 'count', used: [true, true, false] });
    expect(fit50(...offsetBy(50, 5000, 3000, 1000), [800, 900])).toMatchObject({ status: 'need-more', need: 'count', used: [true, true, true, false] });
  });
  it('1000 mm is used, 999 mm is not: the written value decides', () => {
    expect(fit50(...exact(5000, 4000, 3000, 2000, 1000, 999)).used).toEqual([true, true, true, true, true, false]);
    expect(fit50([1010, 999], [995, 1000], ...exact(5000, 4000, 3000, 2000)).used).toEqual([false, true, true, true, true, true]);
  });
});

describe('bad dimensions: the first is named, with the reason', () => {
  const good = () => [dimOf(3051, 3050), dimOf(4371, 4370), dimOf(2411, 2410), dimOf(1461, 1460)];
  const line = (a: Vec, b: Vec, writtenMm = 4370): Dim => ({ a, b, writtenMm });
  const L = 4371 / K50;

  it('nothing is computed', () => {
    const f = fit([...good(), { ...dimOf(1000, 1000), writtenMm: NaN }]);
    expect(f).toMatchObject({ status: 'invalid', problem: { index: 4, why: 'bad-number' }, scale: NaN, mmPerPt: NaN, offsetMm: NaN });
    expect(answer(f)).toBe('invalid');
  });
  it.each([NaN, Infinity, -Infinity, 0, -1, -3000])('a written value of %s', writtenMm => {
    expect(fit([...good(), { ...dimOf(1000, 1000), writtenMm }]).problem).toEqual({ index: 4, why: 'bad-number' });
  });
  it('a written value of 1 mm is short, not a mistake', () => {
    expect(fit([...good(), dimOf(1000, 1)])).toMatchObject({ status: 'ok', used: [true, true, true, true, false] });
  });
  it.each<[string, Partial<Dim>]>([
    ['a.x', { a: [NaN, 0] }], ['a.y', { a: [0, Infinity] }], ['b.x', { b: [-Infinity, 0] }], ['b.y', { b: [0, NaN] }],
  ])('a coordinate that is not a number: %s', (_, wrong) => {
    expect(fit([{ ...dimOf(4371, 4370), ...wrong }, ...good()]).problem).toEqual({ index: 0, why: 'bad-number' });
  });
  it('two ends on the same point, or within half a point', () => {
    for (const apart of [0, 0.4, 0.5]) expect(fit([...good(), line([5, 5], [5 + apart, 5])]).problem, String(apart)).toEqual({ index: 4, why: 'zero-length' });
    expect(fit([...good(), line([5, 5], [5.501, 5], 500)]).problem).toBeUndefined();
  });
  it('the same two points again, in either direction and with any value, within half a point', () => {
    const first = line([100, 700], [100 + L, 700]);
    const repeated: Dim[] = [
      { ...first }, { ...first, writtenMm: 4400 }, line(first.b, first.a), line(first.b, first.a, 4400),
      line([100.4, 700], [100 + L, 700.4]), line([100.5, 700], [100 + L, 700]), line([100, 700], [100 + L - 0.5, 700]), line([100 + L, 700.3], [100.3, 700]),
    ];
    for (const again of repeated) expect(fit([first, ...good(), again]).problem, JSON.stringify(again)).toEqual({ index: 5, why: 'duplicate' });
    expect(fit([...good(), dimOf(800, 800), { ...first }, first]).problem).toEqual({ index: 6, why: 'duplicate' });
  });
  it('a short dimension can be a duplicate too', () => {
    const door = dimOf(800, 800);
    expect(fit([...good(), door, { ...door }]).problem).toEqual({ index: 5, why: 'duplicate' });
  });
  it('one shared end is no duplicate, and neither is a line more than half a point away', () => {
    const first = line([100, 700], [100 + L, 700]);
    const other: Dim[] = [
      line([100, 700], [100, 700 + L]), line([100, 700 + L], [100, 700]), line([100 + L, 700], [100 + L, 700 + L]), line([100 + L, 700 + L], [100 + L, 700]),
      line([100.501, 700], [100 + L + 0.501, 700]), line([100, 701.5], [100 + L, 701.5]), line([100.501, 700], [100 + L, 700]), line([100, 700], [100 + L, 700.501]),
    ];
    for (const next of other) expect(fit([first, next, dimOf(3051, 3050), dimOf(2411, 2410), dimOf(1461, 1460)]).problem, JSON.stringify(next)).toBeUndefined();
  });
  it('several problems: the first in the list', () => {
    const list = good();
    const bad = line([9, 9], [9, 9]);
    expect(fit([list[0], bad, ...list.slice(1), { ...list[0] }]).problem).toEqual({ index: 1, why: 'zero-length' });
    expect(fit([list[0], { ...list[1] }, list[1], { ...list[2], writtenMm: 0 }]).problem).toEqual({ index: 2, why: 'duplicate' });
  });
  it('a dimension with several problems: bad number, then zero length, then duplicate', () => {
    const first = line([100, 700], [100.6, 700], 500);
    expect(fit([first, line([100.3, 700], [100.4, 700])]).problem).toEqual({ index: 1, why: 'zero-length' });
    expect(fit([first, line([100.3, 700], [100.4, 700], -1)]).problem).toEqual({ index: 1, why: 'bad-number' });
    expect(fit([first, { ...first, writtenMm: 0 }]).problem).toEqual({ index: 1, why: 'bad-number' });
  });
});

it('the dimensions are not changed, and a frozen list is fine', () => {
  const dims = at(K50, ...exact(5000, 4000, 3000, 1000), [800, 800]);
  const before = structuredClone(dims);
  for (const dim of dims) [dim.a, dim.b, dim].forEach(Object.freeze);
  Object.freeze(dims);
  expect(answer(fit(dims))).toBe('ok');
  expect(dims).toEqual(before);
});

describe('a constant offset outside -1..8 cm (Task 6): the scale is certain, the drawing still cannot be calibrated', () => {
  it('pinned -> need-more offset and no button; a fifth dimension does not change it', () => {
    expect(fit50(...offsetBy(90, 5000, 4000, 3000, 1000))).toMatchObject({ status: 'need-more', need: 'offset', scale: NaN, mmPerPt: NaN, offsetMm: NaN });
    expect(fit50(...offsetBy(90, 5000, 4000, 3000, 1000)).unverified).toBeUndefined();
    expect(answer(fit50(...offsetBy(90, 5000, 4000, 3000, 1000, 6000)))).toBe('need-more offset');
    expect(answer(fit50(...offsetBy(-20, 5000, 4000, 3000, 1000)))).toBe('need-more offset');
    expect(answer(fit118(...offsetBy(90, 5000, 4000, 3000, 1000)))).toBe('need-more offset');
  });
  it('offsets of 8 and -1 cm are still accepted; similar lengths with 9 cm still ask for more', () => {
    expect(answer(fit50(...offsetBy(80, 5000, 4000, 3000, 1000)))).toBe('ok-offset');
    expect(answer(fit50(...meanOffset(-10)))).toBe('ok-offset');
    expect(answer(fit50(...offsetBy(90, 5000, 5010, 4910, 4950)))).toBe('need-more spread');
    expect(answer(fit50(...offsetBy(90, 5000, 3000, 1000)))).toBe('need-more count');
  });
});

describe('calibrationOf: the only way to a calibration', () => {
  const dimsAt = (k: number, ...pairs: Pair[]) => at(k, ...pairs);
  it('an accepted fit gives a verified calibration with its own numbers and the very dimensions', () => {
    const cases: [Dim[], 50 | 100, string][] = [
      [dimsAt(K50, ...exact(5000, 4000, 3000, 1000)), 50, 'ok'],
      [dimsAt(K50, ...offsetBy(50, 5000, 4000, 3000, 1000)), 50, 'ok-offset'],
      [dimsAt(K100, ...exact(5000, 4000, 3000, 1000)), 50, 'other-standard'],
      [dimsAt(K118, ...exact(5000, 4000, 3000, 1000)), 50, 'nonstandard'],
    ];
    for (const [dims, chosen, status] of cases) {
      const f = fitCalibration(dims, chosen);
      expect(f.status).toBe(status);
      expect(calibrationOf(dims, chosen, 'accept'), status).toStrictEqual({ scale: f.scale, mmPerPt: f.mmPerPt, offsetMm: f.offsetMm, chosen, dims, verified: true });
      expect(calibrationOf(dims, chosen, 'unverified'), status).toBeNull();
    }
  });
  it('every refusal gives none; the button only where the fit offers it, with its numbers', () => {
    const cases: [Dim[], string][] = [
      [[], 'need-more count'],
      [dimsAt(K50, ...exact(5000)), 'need-more count button 50'],
      [dimsAt(K50, ...exact(2000, 1500, 1200)), 'need-more long'],
      [dimsAt(K50, ...exact(5000, 5000, 5000, 5000)), 'need-more spread button 50'],
      [dimsAt(K118, ...exact(5000, 5000, 5000, 5000)), 'need-more spread'],
      [dimsAt(mmPerPt(75), [1015, 1000], [2015, 2000], [2515, 2500], [3015, 3000]), 'need-more ambiguous'],
      [dimsAt(K50, ...offsetBy(90, 5000, 4000, 3000, 1000)), 'need-more offset'],
      [dimsAt(K50, [6000, 6000], [4000, 4400], [2900, 2900]), 'inconsistent'],
      [[dimOf(5000, 5000), { a: [9, 9], b: [9, 9], writtenMm: 3000 }, dimOf(3000, 3000)], 'invalid'],
    ];
    for (const [dims, expected] of cases) {
      const f = fitCalibration(dims, 50);
      expect(answer(f)).toBe(expected);
      expect(calibrationOf(dims, 50, 'accept'), expected).toBeNull();
      const button = calibrationOf(dims, 50, 'unverified');
      if (!f.unverified) expect(button, expected).toBeNull();
      else expect(button, expected).toStrictEqual({ ...f.unverified, chosen: 50, dims, verified: false });
      if (button) expect([button.scale, button.mmPerPt, button.offsetMm].every(Number.isFinite)).toBe(true);
    }
  });
  it('the button keeps the chosen scale apart from the scale it carries', () => {
    const dims = dimsAt(K100, ...exact(5000));
    expect(calibrationOf(dims, 50, 'unverified')).toMatchObject({ scale: 100, chosen: 50, mmPerPt: expect.closeTo(35.277778, 6), verified: false });
  });
});
