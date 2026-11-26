import { describe, expect, it } from 'vitest';
import { fitCalibration } from '../../src/calibrate/fit';
import { copy } from '../../src/copy';
import { oddOne } from '../../src/editor/Calibrate';
import type { Dim } from '../../src/shared';

// Every value is synthetic. A dimension is [drawn mm, written mm] at 1:50, each on its own line of the page.
const K50 = (50 * 25.4) / 72;
let row = 0;
const dims = (...pairs: [number, number][]): Dim[] => pairs.map(([drawn, writtenMm]) => ({ a: [0, 20 * ++row], b: [drawn / K50, 20 * row], writtenMm }));

describe('the difference on each row', () => {
  it('drawn minus written, in cm with one decimal and a sign, isolated so that it reads right to left', () => {
    expect(copy.calibrate.row(1980, 2032)).toBe('כתוב 198 ס"מ, בשרטוט 203.2 ס"מ, הפרש ⁦+5.2⁩');
    expect(copy.calibrate.row(3000, 2990)).toBe('כתוב 300 ס"מ, בשרטוט 299.0 ס"מ, הפרש ⁦-1.0⁩');
    expect(copy.calibrate.row(3000, 3000)).toBe('כתוב 300 ס"מ, בשרטוט 300.0 ס"מ, הפרש ⁦0.0⁩');
    expect(copy.calibrate.row(3000, 3000.4)).toBe('כתוב 300 ס"מ, בשרטוט 300.0 ס"מ, הפרש ⁦0.0⁩'); // no sign on a zero
    expect(copy.calibrate.row(3000, 2999.6)).toContain('⁦0.0⁩');
  });
});

describe('oddOne: the one dimension the others do not explain', () => {
  it("the owner's four: three drawn 2 to 3 cm larger, the fourth 5.2 cm -> the fourth", () => {
    const four = dims([1571, 1550], [3424, 3400], [3441, 3410], [2032, 1980]);
    expect(fitCalibration(four, 50).status).toBe('inconsistent');
    expect(oddOne(four, 50)).toBe(3);
  });
  it('the same at 1:100 chosen, and wherever the odd one stands in the list', () => {
    expect(oddOne(dims([2032, 1980], [1571, 1550], [3424, 3400], [3441, 3410]), 100)).toBe(0);
  });
  it('two bad ones out of five -> nothing is marked', () => {
    expect(oddOne(dims([6400, 6375], [4000, 3975], [2900, 2875], [3000, 2948], [1200, 1140]), 50)).toBeNull();
  });
  it('three dimensions -> nothing is marked, even when they contradict each other', () => {
    const three = dims([6000, 6000], [4000, 4400], [2900, 2900]);
    expect(fitCalibration(three, 50).status).toBe('inconsistent');
    expect(oddOne(three, 50)).toBeNull();
  });
  it('a fit that is not inconsistent -> nothing is marked', () => {
    expect(oddOne(dims([6400, 6400], [4000, 4000], [2900, 2900], [3000, 3000]), 50)).toBeNull();
  });
  it('more than one dimension could be the odd one -> nothing is marked', () => {
    // Three of the four removals leave a set that 1:50 with a constant offset explains: none of them is the odd one.
    const set = dims([5050, 5000], [7020, 7000], [2020, 2000], [6060, 6000]);
    expect(fitCalibration(set, 50).status).toBe('inconsistent');
    const fits = [0, 1, 2, 3].map(i => fitCalibration(set.filter((_, j) => j !== i), 50));
    expect(fits.filter(f => f.unverified || ['ok', 'ok-offset', 'other-standard', 'nonstandard'].includes(f.status)).length).toBeGreaterThan(1);
    expect(oddOne(set, 50)).toBeNull();
  });
});
