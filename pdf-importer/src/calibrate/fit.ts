import type { Calibration, Dim, Vec } from '../shared';

export type FitStatus = 'ok' | 'ok-offset' | 'other-standard' | 'nonstandard' | 'need-more' | 'inconsistent' | 'invalid';

/** A consumer reads `status` first: on a refusal the three numbers are NaN, never believable values. */
export type Fit = {
  status: FitStatus;
  scale: number;
  mmPerPt: number;
  offsetMm: number;
  /** Drawn minus written, one per entry of `dims`. Accepted: after the offset, except for an unused dimension. Refused: at the chosen scale. */
  residualsMm: number[];
  /** False: written value under 1 m, so the dimension is listed but not used for the scale. */
  used: boolean[];
  /** offset: one scale explains the dimensions, but its constant offset is outside OFFSET_OK, so more dimensions cannot help. */
  need?: 'count' | 'long' | 'spread' | 'ambiguous' | 'offset';
  /** A nonstandard scale within 3 % of this standard one. */
  near?: 50 | 100;
  /** The first bad entry of `dims`; only with `invalid`. */
  problem?: { index: number; why: 'duplicate' | 'zero-length' | 'bad-number' };
  /** Present exactly when the user may press "no more dimensions in the drawing". */
  unverified?: { scale: 50 | 100; mmPerPt: number; offsetMm: number };
};

/** A scale is verified only with this many used dimensions, and with one more when they have a constant offset. */
const MIN_DIMS = 3;
/** No dimension of SHORT or more fits both, whatever the offset, so their order does not matter. */
const STANDARD = [50, 100] as const;
// Millimetres unless noted.
const MAX_OFFSET = 100; // the offsets of the scales that are looked for; only OFFSET_OK is accepted
const LONG = 3000;
const SHORT = 1000;
/** Smallest tolerance of a dimension, and the limit of a free fit. */
const FLOOR = 10;
/**
 * The largest error one dimension can carry without being a mistake: 5 for writing whole centimetres and 6 for the
 * spread of the drawing's constant offset. With it the true scale is always among the scales that `pinned` looks at, so
 * an accepted scale is at most PIN wrong; with less, noise alone would hide the true one.
 */
const NOISE = 11;
/** How far from the accepted scale another scale may still explain the dimensions. */
const PIN = 0.0125;
const NEAR = 0.03;
const SAME_PT = 0.5; // points: two ends this close are one end
/** Added to every limit, so that rounding in the arithmetic does not push a value that lies exactly on it outside. */
const EPS = 1e-6;
const RATIO_EPS = 1e-9; // the same for NEAR, which is a ratio
/** The constant offsets that are accepted, and offered behind the "no more dimensions" button. Outside them one more dimension is needed. */
const OFFSET_OK: readonly [number, number] = [-10, 80];

const mmPerPtAt = (scale: number) => (scale * 25.4) / 72;
const distance = ([ax, ay]: Vec, [bx, by]: Vec) => Math.hypot(bx - ax, by - ay);
const samePoint = (p: Vec, q: Vec) => distance(p, q) <= SAME_PT;
const mean = (xs: number[]) => xs.reduce((a, b) => a + b, 0) / xs.length;
const within = (residuals: number[], limits: number[]) => residuals.every((r, i) => Math.abs(r) <= limits[i] + EPS);

function firstProblem(dims: Dim[]): Fit['problem'] {
  for (let index = 0; index < dims.length; index++) {
    const { a, b, writtenMm } = dims[index];
    if (![...a, ...b, writtenMm].every(Number.isFinite) || writtenMm <= 0) return { index, why: 'bad-number' };
    if (samePoint(a, b)) return { index, why: 'zero-length' };
    const repeats = dims
      .slice(0, index)
      .some(other => (samePoint(a, other.a) && samePoint(b, other.b)) || (samePoint(a, other.b) && samePoint(b, other.a)));
    if (repeats) return { index, why: 'duplicate' };
  }
  return undefined;
}

/**
 * The lowest and the highest scale (mm per point) for which some offset of at most MAX_OFFSET leaves every dimension
 * within its limit, or null when there is none. Each dimension bounds the scale alone, each pair whatever the offset is.
 */
function scaleRange(d: number[], w: number[], limits: number[]): [lowest: number, highest: number] | null {
  const reach = limits.map(limit => limit + EPS);
  let lowest = -Infinity;
  let highest = Infinity;
  for (let i = 0; i < d.length; i++) {
    lowest = Math.max(lowest, (w[i] - reach[i] - MAX_OFFSET) / d[i]);
    highest = Math.min(highest, (w[i] + reach[i] + MAX_OFFSET) / d[i]);
    for (let j = 0; j < d.length; j++) {
      const gap = d[i] - d[j];
      const slack = reach[i] + reach[j];
      if (gap > 0) {
        lowest = Math.max(lowest, (w[i] - w[j] - slack) / gap);
        highest = Math.min(highest, (w[i] - w[j] + slack) / gap);
      } else if (w[i] - w[j] > slack) return null; // not longer, yet written longer
    }
  }
  return lowest <= highest ? [lowest, highest] : null;
}

export function fitCalibration(dims: Dim[], chosen: 50 | 100): Fit {
  const lengths = dims.map(dim => distance(dim.a, dim.b));
  const used = dims.map(dim => dim.writtenMm >= SHORT);
  const raw = (k: number) => lengths.map((length, i) => k * length - dims[i].writtenMm);
  const refuse = (status: FitStatus, extra: Partial<Fit> = {}): Fit => ({
    status, scale: NaN, mmPerPt: NaN, offsetMm: NaN, residualsMm: raw(mmPerPtAt(chosen)), used, ...extra,
  });
  const problem = firstProblem(dims);
  if (problem) return refuse('invalid', { problem });

  // From here on only the used dimensions count.
  const usedAt = dims.flatMap((_, i) => (used[i] ? [i] : []));
  const d = usedAt.map(i => lengths[i]);
  const w = usedAt.map(i => dims[i].writtenMm);
  const n = d.length;
  const tolerances = w.map(written => Math.max(FLOOR, 0.005 * written));
  const residuals = (k: number, c: number) => d.map((length, i) => k * length - w[i] - c);
  const accept = (status: FitStatus, k: number, c: number, extra: Partial<Fit> = {}): Fit => ({
    status, scale: (k * 72) / 25.4, mmPerPt: k, offsetMm: c, residualsMm: raw(k).map((r, i) => (used[i] ? r - c : r)), used, ...extra,
  });
  /** No other scale that also explains the dimensions is more than PIN away from k. */
  const pinned = (k: number, c: number): boolean => {
    const limit = Math.max(NOISE, ...residuals(k, c).map(Math.abs));
    const range = scaleRange(d, w, d.map(() => limit));
    return range !== null && range[1] / k <= 1 + PIN && k / range[0] <= 1 + PIN;
  };
  const button = (scale: 50 | 100, offsetMm: number): Partial<Fit> => ({ unverified: { scale, mmPerPt: mmPerPtAt(scale), offsetMm } });

  /** The offset with which the dimensions fit a standard scale within the tolerance: 0, a constant one, or none. */
  const offsetAt = (scale: 50 | 100): number | undefined => {
    const k = mmPerPtAt(scale);
    if (within(residuals(k, 0), tolerances)) return 0;
    const c = mean(residuals(k, 0));
    return Math.abs(c) <= MAX_OFFSET + EPS && within(residuals(k, c), tolerances) ? c : undefined;
  };
  const plausible = (c: number) => c >= OFFSET_OK[0] - EPS && c <= OFFSET_OK[1] + EPS;

  if (n < MIN_DIMS) {
    const scale = Math.max(...w) >= LONG ? STANDARD.find(s => offsetAt(s) === 0) : undefined;
    return refuse('need-more', { need: 'count', ...(scale ? button(scale, 0) : {}) });
  }
  if (Math.max(...w) < LONG) return refuse('need-more', { need: 'long' });

  for (const scale of STANDARD) {
    const k = mmPerPtAt(scale);
    const c = offsetAt(scale);
    if (c === undefined) continue;
    const enough = c === 0 || n > MIN_DIMS; // an offset is one more unknown
    if (enough && plausible(c) && pinned(k, c)) return accept(scale !== chosen ? 'other-standard' : c === 0 ? 'ok' : 'ok-offset', k, c);
    if (enough && pinned(k, c)) return refuse('need-more', { need: 'offset' }); // the scale is certain, its offset is not accepted: more dimensions cannot help
    return refuse('need-more', { need: enough ? 'spread' : 'count', ...(plausible(c) ? button(scale, c) : {}) });
  }

  const floors = d.map(() => FLOOR);
  const sum = (term: (i: number) => number) => d.reduce((total, _, i) => total + term(i), 0);
  const k0 = sum(i => d[i] * w[i]) / sum(i => d[i] ** 2);
  const scaleOnly = within(residuals(k0, 0), floors);
  const dm = mean(d);
  const wm = mean(w);
  const k1 = sum(i => (d[i] - dm) * (w[i] - wm)) / sum(i => (d[i] - dm) ** 2);
  const c1 = k1 * dm - wm;
  const scaleAndOffset = n > MIN_DIMS && Math.abs(c1) <= MAX_OFFSET + EPS && within(residuals(k1, c1), floors);
  const nonstandard = (k: number, c: number): Fit => {
    if (!pinned(k, c)) return refuse('need-more', { need: 'spread' });
    if (!plausible(c)) return refuse('need-more', { need: 'offset' });
    const near = STANDARD.find(s => Math.abs(k / mmPerPtAt(s) - 1) <= NEAR + RATIO_EPS);
    return accept('nonstandard', k, c, near ? { near } : {});
  };
  if (scaleOnly) {
    if (scaleAndOffset && Math.abs(k1 - k0) / k1 > 0.005) return refuse('need-more', { need: 'ambiguous' });
    return nonstandard(k0, 0);
  }
  if (scaleAndOffset) return nonstandard(k1, c1);
  // Three that some scale and offset explain: one more dimension can tell. Nothing can help when none does.
  return n === MIN_DIMS && scaleRange(d, w, tolerances) !== null ? refuse('need-more', { need: 'count' }) : refuse('inconsistent');
}

const ACCEPTED: readonly FitStatus[] = ['ok', 'ok-offset', 'other-standard', 'nonstandard'];

/**
 * The only way to a Calibration. 'accept': verified, when the fit of these very dimensions accepts a scale. 'unverified': through the
 * "no more dimensions" button, only when the fit offers it, with the numbers it offers. null otherwise.
 */
export function calibrationOf(dims: Dim[], chosen: 50 | 100, how: 'accept' | 'unverified'): Calibration | null {
  const fit = fitCalibration(dims, chosen);
  if (how === 'unverified') return fit.unverified ? { ...fit.unverified, chosen, dims, verified: false } : null;
  return ACCEPTED.includes(fit.status) ? { scale: fit.scale, mmPerPt: fit.mmPerPt, offsetMm: fit.offsetMm, chosen, dims, verified: true } : null;
}
