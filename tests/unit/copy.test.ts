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

it('the check list\'s strings read as the approved list has them (R45); the entry door\'s says how to draw it with the tools there are', () => {
  const e = copy.editor;
  expect([e.detailsTab, e.checkTab, e.progress(2, 5), ...Object.values(e.steps)]).toEqual(['פרטים', 'בדיקה לפני אישור', 'אושרו 2 מתוך 5', 'חללי הדירה', 'הממ"ד', 'דלת הכניסה', 'דלתות ומעברים', 'חלונות', 'קירות החוץ']);
  expect([e.roomsHow, e.noMamad, e.mamadIs('סלון'), e.show, e.confirmAll, e.noDoors, e.noWindows, e.item('דלת', 1, '80'), e.allOuter, e.outerHow, e.confirmed, e.notConfirmed]).toEqual([
    'סמנו אילו חללים שייכים לדירה.', 'אין ממ"ד', 'הממ"ד: סלון', 'הצגה', 'אישור הכול', 'אין דלתות בשרטוט.', 'אין חלונות בשרטוט.', 'דלת 1, 80 ס"מ', 'כל קירות החוץ', 'בדקו שקירות החוץ המסומנים נכונים, ואשרו.', 'אושר', 'לא אושר',
  ]);
  expect([e.suggest, e.acceptOne, e.acceptAll(3), e.suggestWhy, e.review, e.reviewed, e.colours, e.colourMeans('#c2327f'), e.colourExample, e.mamadQuestion]).toEqual([
    'הצעה: קבוע', 'קבלת ההצעה', 'קבלת כל ההצעות (3)', 'קירות עם חלון, קירות על גבול הדירה ועמודים מוצעים כקבועים.', 'לבדיקה', 'נבדק', 'צבעי השרטוט של הקבלן', 'מה מסמן הצבע #c2327f', 'למשל: טיח', 'איזה חלל הוא הממ"ד, או שאין',
  ]);
  expect(e.noEntry).toContain(e.door);
  expect(e.noEntry).toContain(e.openingKinds.entry);
});
