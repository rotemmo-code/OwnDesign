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

it('the first instruction and the odd row read exactly as the owner approved', () => {
  expect(copy.calibrate.first).toBe('סמנו מידה שכתובה בשרטוט: לחצו על סימן הקצה הראשון שלה, ואחר כך על השני. כשהסמן הופך לריבוע, הוא על נקודה מדויקת.');
  expect(copy.calibrate.odd).toBe('המידה הזו שונה מהאחרות. בדקו אותה. אם היא נכונה, בדקו את האחרות.');
});
