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

describe('oddOne never marks a correct row', () => {
  it('a free scale that absorbs the bad dimension does not count: the review case marks nothing', () => {
    const five = dims([2085, 2091], [1655, 1650], [2572, 2579], [6073, 6144], [2595, 2590]);
    expect(fitCalibration(five, 50).status).toBe('inconsistent');
    expect(oddOne(five, 50)).toBeNull();
  });
  it('only the dimensions the fit uses count towards four: 640, 400, a wrong 290 and an 80 cm one mark nothing', () => {
    const set = dims([6400, 6400], [4000, 4000], [2900, 3100], [800, 800]);
    expect(fitCalibration(set, 50).used.filter(Boolean)).toHaveLength(3);
    expect(oddOne(set, 50)).toBeNull();
  });
  it("the owner's first attempt (155/157.1, 340/342.4, 341/344.1, 198/203.2): the 198 row, as the rule says", () => {
    expect(oddOne(dims([1571, 1550], [3424, 3400], [3441, 3410], [2032, 1980]), 50)).toBe(3);
  });
  it('seeded: one dimension wrong by 3 to 30 cm; whenever a row is marked it is the wrong one', () => {
    let seed = 20261126;
    const random = () => (seed = (seed * 16807) % 2147483647) / 2147483647;
    let [inconsistent, marked, wrong] = [0, 0, 0];
    for (let set = 0; set < 4000; set++) {
      const scale = set % 2 ? 100 : 50;
      const k = (scale * 25.4) / 72;
      const offset = set % 4 < 2 ? 0 : Math.round(-10 + random() * 90);
      const n = 4 + Math.floor(random() * 3);
      const bad = Math.floor(random() * n);
      const set_ = Array.from({ length: n }, (_, i): Dim => {
        const written = 10 * Math.round(100 + random() * 600); // whole cm, 1 to 7 m
        const error = i === bad ? (random() < 0.5 ? -1 : 1) * (30 + random() * 270) : 0;
        const drawn = written + offset + error + (random() * 2 - 1) * 11; // clicks scattered by up to the fit's noise
        return { a: [0, 20 * i], b: [drawn / k, 20 * i], writtenMm: written };
      });
      if (fitCalibration(set_, scale).status !== 'inconsistent') continue;
      inconsistent++;
      const odd = oddOne(set_, scale);
      if (odd === null) continue;
      marked++;
      if (odd !== bad) wrong++;
    }
    console.log(`seeded: ${inconsistent} inconsistent, ${marked} marked, ${wrong} marked wrongly`);
    expect(wrong).toBe(0);
    expect(marked).toBeGreaterThan(0);
  });
});
