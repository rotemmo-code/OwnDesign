import { expect, it } from 'vitest';
import { copy } from '../../src/copy';

it('an offset that rounds to 0.0 cm is said as a plain verified scale', () => {
  expect(copy.calibrate.offset(50, 0.49)).toBe(copy.calibrate.ok(50));
  expect(copy.calibrate.offset(50, -0.49)).toBe(copy.calibrate.ok(50));
  expect(copy.calibrate.offset(50, 0.09)).toBe(copy.calibrate.ok(50));
  expect(copy.calibrate.offset(50, 0.5)).toContain('0.1');
  expect(copy.calibrate.offset(50, 52)).toContain('גדול');
  expect(copy.calibrate.offset(50, -8)).toContain('קטן');
});
