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

it('every Reason the existing state can give has its own text; a lock is said with נעול, never מוגן', () => {
  const reasons = ['envelope-locked', 'mamad-locked', 'window-locked', 'entry-door-locked', 'mamad-split', 'mamad-outdoor', 'opening-out-of-wall', 'finish-range',
    'finish-outer-side', 'finish-no-room-left', 'invalid-geometry', 'invalid-number', 'invalid-action', 'text-too-long', 'too-many'] as const;
  for (const r of reasons) expect(copy.reason[r], r).toMatch(/\S/);
  expect(new Set(reasons.map(r => copy.reason[r])).size).toBe(reasons.length);
  const all = JSON.stringify(copy) + Object.values(copy.editor).filter(v => typeof v === 'function').map(f => (f as (...a: string[]) => string)('א', 'ב')).join();
  expect(all).not.toContain('מוגן');
  for (const r of ['envelope-locked', 'mamad-locked', 'window-locked', 'entry-door-locked'] as const) expect(copy.reason[r]).toMatch(/נעול/);
});

it('the wall tool button and the undo pair read as the owner asked', () => {
  expect([copy.editor.wall, copy.editor.undo, copy.editor.redo, copy.fit]).toEqual(['הוסף קיר', 'ביטול פעולה', 'ביצוע שוב', 'איפוס תצוגה']);
  expect(Object.values(copy.editor.materials)).toEqual(['גבס', 'בלוק', 'בטון', 'אחר']);
});
