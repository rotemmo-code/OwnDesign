import { type Browser, expect, type Page, test } from '@playwright/test';
import { copy } from '../../src/copy';
import type { Plaster } from '../../src/model/types';
import type { Vec } from '../../src/shared';
import { COLOR } from '../../src/theme';
import { DIMS, dimsPdf, type Mark, viewOf } from '../fixtures/dims';
import { PLAN_ORIGIN } from '../fixtures/makePdf';

// The editor of the existing state (Task 11a), on the synthetic fixture, calibrated by three written dimensions.
const c = copy.calibrate;
const e = copy.editor;
const K = (50 * 25.4) / 72; // mm per point at 1:50
const O = { x: PLAN_ORIGIN[0] * K, y: PLAN_ORIGIN[1] * K }; // the apartment's corner in mm
const canvas = (page: Page) => page.getByTestId('canvas');
const field = (page: Page) => page.getByLabel(c.written);
const message = (page: Page) => page.getByTestId('message');

declare global {
  interface Window {
    violations: string[];
    pwned?: number;
  }
}
const external: string[] = [];
test.beforeEach(async ({ page, baseURL }) => {
  external.length = 0;
  page.on('request', r => void (!r.url().startsWith(baseURL!) && !r.url().startsWith('blob:') && !r.url().startsWith('data:') && external.push(r.url())));
  await page.addInitScript(() => {
    window.violations = [];
    document.addEventListener('securitypolicyviolation', event => window.violations.push(`${event.effectiveDirective} ${event.blockedURI}`));
  });
});
test.afterEach(async ({ page }) => {
  expect((await page.evaluate(() => window.violations)) ?? []).toEqual([]); // undefined on a page the test did not open
  expect(external).toEqual([]);
});

const onScreen = (page: Page, [x, y]: Vec) =>
  canvas(page).evaluate((svg: SVGSVGElement, [x, y]) => {
    const at = new DOMPoint(x, y).matrixTransform(svg.getScreenCTM()!);
    return [at.x, at.y] as Vec;
  }, [x, y]);
const viewBox = async (page: Page) => (await canvas(page).getAttribute('viewBox'))!.split(' ').map(Number);
/** A designer's click on a point of the fixture (mm from the apartment's corner): zoomed in about 3.7 times, then off by px. */
async function clickMm(page: Page, mm: Vec, off: Vec = [0, 0]) {
  await page.getByRole('button', { name: copy.fit }).click();
  await canvas(page).evaluate(svg => svg.scrollIntoView({ block: 'center' })); // a narrow window scrolls
  await page.mouse.move(...(await onScreen(page, viewOf(50, mm))));
  // Chromium divides a wheel notch by the browser zoom: turn until zoomed in
  for (let i = 0; i < 40 && (await viewBox(page))[2] >= 250; i++) await page.mouse.wheel(0, -100);
  await expect.poll(async () => (await viewBox(page))[2]).toBeLessThan(250);
  const [x, y] = await onScreen(page, viewOf(50, mm));
  await page.mouse.click(x + off[0], y + off[1]);
}
async function markMm(page: Page, mark: Mark) {
  await clickMm(page, mark.a);
  await clickMm(page, mark.b);
  await field(page).fill(mark.text);
  await field(page).press('Enter');
  await expect(field(page)).toHaveCount(0);
}
/** Upload, answer the plaster question, mark 640 / 400 / 290 and go on at 1:50: the editor, on its measure tool. */
async function start(page: Page, plaster: Plaster | null = 'line', size: [number, number] = [1440, 900]) {
  await page.setViewportSize({ width: size[0], height: size[1] });
  await page.goto('/');
  await page.getByTestId('upload').setInputFiles({ name: 'plan-7.pdf', mimeType: 'application/pdf', buffer: Buffer.from(dimsPdf()) });
  await expect(page.getByTestId('drawing').locator('canvas')).toHaveCount(2);
  if (plaster) await page.getByRole('button', { name: c.plaster[plaster], exact: true }).click();
  for (const mark of [DIMS.outer, DIMS.heightA, DIMS.roomB]) await markMm(page, mark);
  await page.getByRole('button', { name: c.go(50) }).click();
  await expect(page.getByRole('tab', { name: e.existing })).toBeVisible();
}
const tool = (page: Page, name: string) => page.getByRole('group', { name: e.tools }).getByRole('button', { name, exact: true }).click();
const thickness = (page: Page) => page.getByLabel(e.thickness);

/** The five walls of the fixture by their centre lines: ends in mm from the apartment's corner, thickness in cm. */
const FIVE: [Vec, Vec, string][] = [
  [[0, 100], [6400, 100], '20'],
  [[100, 200], [100, 4200], '20'],
  [[0, 4300], [6400, 4300], '20'],
  [[6300, 200], [6300, 4200], '20'],
  [[3250, 200], [3250, 4200], '10'],
];
async function drawWall(page: Page, [a, b, cm]: [Vec, Vec, string], off: Vec = [0, 0]) {
  await thickness(page).fill(cm);
  await clickMm(page, a, off);
  await clickMm(page, b, off);
}
async function drawFive(page: Page, count = 5) {
  await tool(page, e.wall);
  for (const w of FIVE.slice(0, count)) await drawWall(page, w);
}
/** The box of each wall's outline as drawn, in mm from the apartment's corner. */
const wallBoxes = (page: Page) =>
  page.locator('[data-wall]').evaluateAll((paths, o) =>
    paths.map(p => {
      const n = (p.getAttribute('d') ?? '').match(/-?\d+(\.\d+)?(e-?\d+)?/g)!.map(Number);
      const xs = n.filter((_, i) => i % 2 === 0).map(x => x - o.x);
      const ys = n.filter((_, i) => i % 2 === 1).map(y => y - o.y);
      return [Math.min(...xs), Math.min(...ys), Math.max(...xs), Math.max(...ys)].map(v => Math.round(v * 100) / 100);
    }), O);
/** The room panel of the room at mm, through the select tool. */
async function room(page: Page, mm: Vec) {
  await tool(page, e.select);
  await clickMm(page, mm);
  return page.getByTestId('room-details');
}
async function wall(page: Page, mm: Vec) {
  await tool(page, e.select);
  await clickMm(page, mm);
  return page.getByTestId('wall-details');
}
const split = (page: Page) => page.getByText(/התחלק\. איזה חלק ישמור על השם/);
/** Both rooms closed, the split answered as it came (the larger part keeps the name). */
async function twoRooms(page: Page) {
  await drawFive(page, 4);
  const r = await room(page, [1700, 2200]);
  await r.getByLabel(e.roomName).fill('סלון');
  await r.getByLabel(e.roomName).press('Enter');
  await r.getByLabel(e.inApartment).check();
  await tool(page, e.wall);
  await drawWall(page, FIVE[4]);
  await expect(split(page)).toBeVisible();
}

test('the editor appears only after a scale is accepted, starts on the measure tool, and is hidden while recalibrating', async ({ page }) => {
  await page.goto('/');
  await page.getByTestId('upload').setInputFiles({ name: 'plan.pdf', mimeType: 'application/pdf', buffer: Buffer.from(dimsPdf()) });
  await expect(page.getByTestId('drawing').locator('canvas')).toHaveCount(2);
  await expect(page.getByRole('group', { name: e.tools })).toHaveCount(0);
  await expect(page.getByRole('tab', { name: e.existing })).toHaveCount(0);
  for (const mark of [DIMS.outer, DIMS.heightA, DIMS.roomB]) await markMm(page, mark);
  await expect(page.getByRole('group', { name: e.tools })).toHaveCount(0);
  await page.getByRole('button', { name: c.go(50) }).click();
  await expect(page.getByRole('group', { name: e.tools }).getByRole('button', { name: copy.measure.title })).toHaveAttribute('aria-pressed', 'true');
  await expect(page.getByRole('region', { name: copy.measure.title })).toContainText(copy.measure.verified(50, 3));
  await tool(page, e.wall);
  await drawWall(page, FIVE[0]);
  await tool(page, copy.measure.title);
  await page.getByRole('button', { name: copy.measure.again }).click();
  await expect(page.getByRole('group', { name: e.tools })).toHaveCount(0);
  await expect(page.getByRole('region', { name: c.title })).toBeVisible();
  await page.getByRole('button', { name: c.go(50) }).click();
  await expect(page.getByRole('group', { name: e.tools })).toBeVisible();
  expect(await wallBoxes(page)).toEqual([[0, 0, 6400, 200]]);
});

test('drawing the five fixture walls by hand, two clicks each, yields rooms of 12.00 and 11.60 m2', async ({ page }) => {
  await start(page);
  await drawFive(page);
  expect(await wallBoxes(page)).toEqual([
    [0, 0, 6400, 200],
    [0, 100, 200, 4300], // run on to the centre line of the wall it meets: that joint is filled
    [0, 4200, 6400, 4400],
    [6200, 100, 6400, 4300],
    [3200, 100, 3300, 4300],
  ]);
  await expect(await room(page, [1700, 2200])).toContainText(e.area('12.00'));
  await expect(await room(page, [4700, 2200])).toContainText(e.area('11.60'));
});

test('a click 3 px off the centre lands on it where a snap exists; where none does, the wall is where the clicks were; near an axis it is held to it', async ({ page }) => {
  await start(page);
  await tool(page, e.wall);
  await drawWall(page, FIVE[0], [0, 3]);
  await drawWall(page, FIVE[4], [3, 0]);
  expect(await wallBoxes(page)).toEqual([[0, 0, 6400, 200], [3200, 100, 3300, 4200]]);
  // nothing drawn here: the wall follows the clicks, and 1 degree off the horizontal is held to it
  await page.keyboard.press('Control+z');
  await page.keyboard.press('Control+z');
  await thickness(page).fill('10');
  await clickMm(page, [8000, 2000]);
  await clickMm(page, [10000, 2000 + 2000 * Math.tan(Math.PI / 180)]);
  const [box] = await wallBoxes(page);
  expect(box[3] - box[1]).toBeCloseTo(100, 6); // horizontal: as thick as typed, no taller
  expect(Math.abs((box[1] + box[3]) / 2 - 2000)).toBeLessThan(5); // where the first click was, within a screen pixel
  expect(Math.abs(box[0] - 8000)).toBeLessThan(5); // its first end where that click was
  expect(Math.abs(box[2] - 10000)).toBeLessThan(5);
});

test('between the two clicks the wall body follows the pointer with its length × thickness; Escape cancels', async ({ page }) => {
  await start(page);
  await tool(page, e.wall);
  await thickness(page).fill('20');
  await clickMm(page, [0, 100]);
  await expect(page.getByTestId('step')).toHaveText(e.wallSecond);
  await page.getByRole('button', { name: copy.fit }).click();
  await page.mouse.move(...(await onScreen(page, viewOf(50, [6400, 100]))));
  await expect(page.getByTestId('wall-preview')).toContainText('640.0 × 20.0');
  await page.keyboard.press('Escape');
  await expect(page.getByTestId('wall-preview')).toHaveCount(0);
  await expect(page.getByTestId('step')).toHaveText(e.wallFirst);
  expect(await wallBoxes(page)).toEqual([]);
});

test('a bad thickness changes nothing and says why', async ({ page }) => {
  await start(page);
  await tool(page, e.wall);
  for (const bad of ['', '12,5', 'abc', '1e9', '-3', '1', '101']) {
    await thickness(page).fill(bad);
    await clickMm(page, [0, 100]);
    await expect(message(page), bad).toHaveText(e.badThickness);
    await expect(page.getByTestId('step')).toHaveText(e.wallFirst);
  }
  expect(await wallBoxes(page)).toEqual([]);
  // the same on a wall's own field
  await drawWall(page, FIVE[0]);
  const details = await wall(page, [3000, 100]);
  for (const bad of ['', 'abc', '1e9', '1']) {
    await details.getByLabel(e.thickness).fill(bad);
    await details.getByLabel(e.thickness).press('Enter');
    await expect(message(page)).toHaveText(e.badThickness);
  }
  expect(await wallBoxes(page)).toEqual([[0, 0, 6400, 200]]);
});

test('the wall tool says what the plaster answer means for the thickness', async ({ browser }) => {
  for (const [plaster, text] of [['none', e.plasterNote.none], ['line', e.plasterNote.line], ['inWall', e.plasterNote.inWall], ['unknown', e.plasterNote.unknown], [null, e.plasterNote.unknown]] as const) {
    const page = await (browser as Browser).newPage();
    await start(page, plaster);
    await tool(page, e.wall);
    await expect(page.getByTestId('plaster-note')).toHaveText(text);
    await page.close();
  }
});

test('a split asks which part keeps the name; undo undoes the answer first, then the wall', async ({ page }) => {
  await start(page);
  await twoRooms(page);
  await expect(split(page)).toContainText('סלון');
  const parts = page.getByRole('button', { name: /^חלק \d/ });
  await expect(parts).toHaveCount(2);
  // the right part, the smaller, takes the name
  await page.getByRole('button', { name: e.part(2, '11.60') }).click();
  await expect(split(page)).toHaveCount(0);
  await expect(page.locator('[data-room]').filter({ hasText: 'סלון' })).toContainText('11.60');
  await page.getByRole('button', { name: e.undo }).click();
  await expect(page.locator('[data-room]').filter({ hasText: 'סלון' })).toContainText('12.00');
  await page.getByRole('button', { name: e.undo }).click();
  await expect(page.locator('[data-room]')).toHaveCount(1);
});

test('deleting the partition merges the rooms and asks for a name', async ({ page }) => {
  await start(page);
  await twoRooms(page);
  await tool(page, e.remove);
  await clickMm(page, [3250, 3000]);
  const asked = page.getByText(/התאחדו לחלל אחד/);
  await expect(asked).toBeVisible();
  await page.getByLabel(/התאחדו לחלל אחד/).fill('חדר גדול');
  await page.getByRole('button', { name: e.save }).click();
  await expect(page.locator('[data-room]')).toHaveCount(1);
  await expect(page.locator('[data-room]')).toContainText('חדר גדול');
  await expect(page.locator('[data-room]')).toContainText('24.00'); // the two rooms and the partition's floor
});

test('deleting a wall of a room outside the apartment names the room that is no longer closed; undo brings it back', async ({ page }) => {
  await start(page);
  await drawFive(page, 4);
  const r = await room(page, [1700, 2200]);
  await r.getByLabel(e.roomName).fill('מטבח');
  await r.getByLabel(e.roomName).press('Enter');
  await tool(page, e.remove);
  await clickMm(page, [100, 3000]);
  await expect(message(page)).toHaveText(e.gone('מטבח'));
  await expect(page.locator('[data-room]')).toHaveCount(0);
  await page.keyboard.press('Control+z');
  await expect(page.locator('[data-room]')).toContainText('מטבח');
});

for (const plaster of ['none', 'line', 'inWall', 'unknown', null] as const)
  test(`the wall-only note is on screen next to the measurements: ${plaster ?? 'unanswered'}`, async ({ page }) => {
    await start(page, plaster);
    await drawFive(page, 4);
    await expect(await room(page, [1700, 2200])).toContainText(copy.plasterSentence[plaster ?? 'unknown']);
  });

test('every measurement carries לפי השרטוט', async ({ page }) => {
  await start(page);
  await drawFive(page, 4);
  const r = await room(page, [1700, 2200]);
  for (const line of await r.getByTestId('measurement').allInnerTexts()) expect(line).toContain(copy.byDrawing);
  await expect(r.getByTestId('measurement').first()).toContainText(e.area('24.00'));
  await expect(r.getByTestId('measurement').last()).toContainText('600 × 400');
  await expect(await wall(page, [3000, 100])).toContainText(`${e.length}: ${e.cm('600')} ${copy.byDrawing}`);
});

test('classifying a wall as changeable shows the load-bearing text once, not the second time', async ({ page }) => {
  await start(page);
  await tool(page, e.wall);
  await drawWall(page, FIVE[0]);
  await drawWall(page, FIVE[1]);
  const first = await wall(page, [3000, 100]);
  await first.getByRole('button', { name: e.classes.changeable }).click();
  await expect(message(page)).toHaveText(e.loadBearing);
  const second = await wall(page, [100, 3000]);
  await second.getByRole('button', { name: e.classes.changeable }).click();
  await expect(message(page)).toHaveText('');
});

test('a class is told by paint and by words: fixed dark, changeable solid, unknown light and dashed; no mark at all', async ({ page }) => {
  await start(page);
  await tool(page, e.wall);
  await drawWall(page, FIVE[4]);
  const path = page.locator('[data-wall]');
  await expect(path).toHaveAttribute('fill', COLOR.existing);
  await expect(path).toHaveAttribute('fill-opacity', '0.35');
  await expect(path).toHaveAttribute('stroke-dasharray', '6 4');
  const details = await wall(page, [3250, 3000]);
  await expect(details).toContainText(`${e.classLabel}: ${e.classes.unknown}`);
  await expect(details.getByTestId('lock')).toHaveText(e.free);
  await details.getByRole('button', { name: e.classes.fixed }).click();
  await expect(path).toHaveAttribute('fill', COLOR.fixed);
  await expect(path).not.toHaveAttribute('stroke-dasharray', /./);
  await expect(details).toContainText(`${e.classLabel}: ${e.classes.fixed}`);
  await details.getByRole('button', { name: e.classes.changeable }).click();
  await expect(path).toHaveAttribute('fill', COLOR.existing);
  await expect(path).not.toHaveAttribute('fill-opacity', /./);
  // no padlock, shield or question mark anywhere: nothing drawn as a picture
  await expect(page.getByRole('img')).toHaveCount(0);
  await expect(canvas(page).locator('[data-testid="overlay"] text')).toHaveCount(0); // no room yet, so no text at all
});

test('every tool button and field has a text label', async ({ page }) => {
  await start(page);
  for (const name of [e.select, e.wall, e.remove, copy.measure.title]) await expect(page.getByRole('group', { name: e.tools }).getByRole('button', { name, exact: true })).toBeVisible();
  for (const name of [e.undo, e.redo, copy.zoomIn, copy.zoomOut, copy.fit]) await expect(page.getByRole('button', { name })).toBeVisible();
  await expect(page.getByLabel(e.strength)).toBeVisible();
  await expect(page.getByLabel(e.name)).toBeVisible();
  await tool(page, e.wall);
  await expect(page.getByLabel(e.thickness)).toBeVisible();
  await expect(page.getByLabel(e.material)).toBeVisible();
});

test('exterior, mamad and existing walls take their theme colours; undo of marking the mamad returns them', async ({ page }) => {
  await start(page);
  await twoRooms(page);
  await page.getByRole('button', { name: e.part(1, '12.00') }).click();
  const fill = (n: number) => page.locator('[data-wall]').nth(n).getAttribute('fill');
  // both parts are the apartment's: the four outer walls outer, the partition an inner wall (unknown: light, dashed)
  for (const n of [0, 1, 2, 3]) expect(await fill(n)).toBe(COLOR.exterior);
  expect(await fill(4)).toBe(COLOR.existing);
  const right = await room(page, [4700, 2200]);
  await right.getByLabel(e.isMamad).check();
  await expect.poll(() => fill(4)).toBe(COLOR.mamad);
  expect(await fill(3)).toBe(COLOR.mamad);
  expect(await fill(1)).toBe(COLOR.exterior);
  await page.getByRole('button', { name: e.undo }).click();
  await expect.poll(() => fill(4)).toBe(COLOR.existing);
  expect(await fill(3)).toBe(COLOR.exterior);
});

test('the legend is visible and lists exactly the paints on screen, each with its words', async ({ page }) => {
  await start(page, 'line', [1440, 700]);
  await tool(page, e.wall);
  await drawWall(page, FIVE[4]);
  const legend = page.getByRole('region', { name: e.legend });
  await expect(legend.locator('li')).toHaveText([e.paints.unknown]);
  const details = await wall(page, [3250, 3000]);
  await details.getByRole('button', { name: e.classes.fixed }).click();
  await expect(legend.locator('li')).toHaveText([e.paints.fixed]);
  await tool(page, e.wall);
  await drawWall(page, FIVE[0]);
  await expect(legend.locator('li')).toHaveText([e.paints.fixed, e.paints.unknown]);
  await expect(legend).toBeInViewport();
  await page.locator('.panel').evaluate(panel => panel.scrollTo(0, panel.scrollHeight));
  await expect(legend).toBeInViewport();
});

test('undo and redo walk through five actions, by the buttons and by Ctrl+Z and Ctrl+Y, but not while typing text', async ({ page }) => {
  await start(page);
  await drawFive(page); // five actions
  const count = () => page.locator('[data-wall]').count();
  await page.getByRole('button', { name: e.undo }).click();
  expect(await count()).toBe(4);
  for (let i = 0; i < 4; i++) await page.keyboard.press('Control+z');
  expect(await count()).toBe(0);
  await expect(page.getByRole('button', { name: e.undo })).toBeDisabled();
  await page.getByRole('button', { name: e.redo }).click();
  await page.keyboard.press('Control+y');
  await page.keyboard.press('Control+y');
  expect(await count()).toBe(3);
  await page.keyboard.press('Control+Shift+z');
  await page.keyboard.press('Control+Shift+z');
  expect(await count()).toBe(5);
  await expect(page.getByRole('button', { name: e.redo })).toBeDisabled();
  await page.keyboard.press('Control+z');
  expect(await count()).toBe(4);
  // in a text field Ctrl+Z is the field's own
  await page.getByLabel(e.name).focus();
  await page.keyboard.press('Control+z');
  expect(await count()).toBe(4);
  // after a click on a checkbox, a select or the slider it is the drawing's
  await page.getByLabel(e.strength).focus();
  await page.keyboard.press('Control+z');
  expect(await count()).toBe(3);
});

test('Ctrl+Z and Ctrl+Y follow the printed letter on a Latin layout and the place of the key on a Hebrew one', async ({ page }) => {
  await start(page);
  await drawFive(page, 2);
  const count = () => page.locator('[data-wall]').count();
  const press = (key: string, code: string) =>
    page.evaluate(([key, code]) => document.body.dispatchEvent(new KeyboardEvent('keydown', { key, code, ctrlKey: true, bubbles: true, cancelable: true })), [key, code]);
  await page.locator('body').click({ position: { x: 1, y: 1 } });
  await press('ז', 'KeyZ');
  expect(await count()).toBe(1);
  await press('ט', 'KeyY');
  expect(await count()).toBe(2);
  // a Latin layout goes by the printed letter (owner R20): Z where QWERTY has W, as on AZERTY; and W in Z's place does nothing
  await press('z', 'KeyW');
  expect(await count()).toBe(1);
  await press('w', 'KeyZ');
  expect(await count()).toBe(1);
  await press('y', 'KeyZ');
  expect(await count()).toBe(2);
});

test('the drawing is not mirrored in the right-to-left page', async ({ page }) => {
  await start(page);
  await twoRooms(page);
  const left = await page.locator('[data-room]').filter({ hasText: 'סלון' }).boundingBox();
  const right = await page.locator('[data-room]').filter({ hasNotText: 'סלון' }).boundingBox();
  expect(left!.x).toBeLessThan(right!.x);
});

test('an outer wall is locked: a delete changes nothing and says so in the word נעול; תיקון, delete, undo, אישור locks and confirms', async ({ page }) => {
  await start(page);
  await twoRooms(page);
  await page.getByRole('button', { name: e.part(1, '12.00') }).click();
  await expect(page.getByText(e.envelopeOpen)).toBeVisible(); // drawn by hand, the outer walls start open
  await page.getByRole('button', { name: e.confirm }).click();
  const before = await wallBoxes(page);
  await tool(page, e.remove);
  await clickMm(page, [100, 3000]);
  await expect(message(page)).toHaveText(copy.reason['envelope-locked']!);
  await expect(message(page)).toHaveAttribute('aria-live', 'polite');
  expect(await wallBoxes(page)).toEqual(before);
  const details = await wall(page, [100, 3000]);
  await expect(details.getByTestId('lock')).toContainText(e.envelopeLocked);
  await details.getByRole('button', { name: e.fix }).click();
  await expect(page.getByText(e.envelopeOpen)).toBeVisible();
  await tool(page, e.remove);
  await clickMm(page, [100, 3000]);
  expect(await wallBoxes(page)).toHaveLength(4);
  await page.keyboard.press('Control+z');
  expect(await wallBoxes(page)).toEqual(before);
  await page.getByRole('button', { name: e.confirm }).click();
  await expect(page.getByText(e.envelopeOpen)).toHaveCount(0);
  await tool(page, e.remove);
  await clickMm(page, [100, 3000]);
  await expect(message(page)).toHaveText(copy.reason['envelope-locked']!);
  expect(await page.locator('body').innerText()).not.toContain('מוגן');
});

test('a mamad wall is locked: תיקון clears the mark, the wall can change, אישור marks the same room again; no wall can be laid inside it', async ({ page }) => {
  await start(page);
  await twoRooms(page);
  await page.getByRole('button', { name: e.part(1, '12.00') }).click();
  const mamad = await room(page, [4700, 2200]);
  await mamad.getByLabel(e.isMamad).check();
  await tool(page, e.wall);
  await thickness(page).fill('10');
  await clickMm(page, [3300, 2000]);
  await clickMm(page, [6200, 2000]);
  await expect(message(page)).toHaveText(copy.reason['mamad-locked']!);
  const details = await wall(page, [3250, 3000]);
  await expect(details.getByTestId('lock')).toContainText(e.mamadLocked);
  await details.getByLabel(e.thickness).fill('25');
  await details.getByLabel(e.thickness).press('Enter');
  await expect(message(page)).toHaveText(copy.reason['mamad-locked']!);
  await details.getByRole('button', { name: e.fix }).click();
  await expect(page.getByText(e.mamadOpen(e.unnamed))).toBeVisible();
  const again = await wall(page, [3250, 3000]);
  await again.getByLabel(e.thickness).fill('25');
  await again.getByLabel(e.thickness).press('Enter');
  await expect(message(page)).toHaveText('');
  await page.getByText(e.mamadOpen(e.unnamed)).getByRole('button', { name: e.confirm }).click();
  await expect(page.locator('[data-wall]').nth(4)).toHaveAttribute('fill', COLOR.mamad);
});

test('a material is chosen in the wall tool and kept, read and changed in the panel, on a locked outer wall without a release', async ({ page }) => {
  await start(page);
  await tool(page, e.wall);
  await page.getByLabel(e.material).selectOption({ label: e.materials.block });
  await drawWall(page, FIVE[0]);
  await drawWall(page, FIVE[1]);
  await expect(page.getByLabel(e.material)).toHaveValue('block');
  const details = await wall(page, [3000, 100]);
  await expect(details.getByLabel(e.material)).toHaveValue('block');
  await twoRoomsAfter(page);
  const outer = await wall(page, [100, 3000]);
  await expect(outer.getByTestId('lock')).toContainText(e.envelopeLocked);
  await outer.getByLabel(e.material).selectOption({ label: e.materials.concrete });
  await expect(message(page)).toHaveText('');
  await expect(outer.getByLabel(e.material)).toHaveValue('concrete');
  await outer.getByLabel(e.material).selectOption({ label: e.noMaterial });
  await expect(outer.getByLabel(e.material)).toHaveValue('');
  await page.keyboard.press('Control+z');
  await expect(outer.getByLabel(e.material)).toHaveValue('concrete');
});
/** The other two outer walls, and the room marked as the apartment's: its outer walls lock. */
async function twoRoomsAfter(page: Page) {
  await tool(page, e.wall);
  await drawWall(page, FIVE[2]);
  await drawWall(page, FIVE[3]);
  const r = await room(page, [1700, 2200]);
  await r.getByLabel(e.inApartment).check();
  await page.getByRole('button', { name: e.confirm }).click(); // the outer walls lock
}

test('the plan strength slider fades the contractor\'s page only, 20 to 100, starts at 100 and again at 100 on another page', async ({ page }) => {
  await start(page);
  const slider = page.getByLabel(e.strength);
  await expect(slider).toHaveValue('100');
  await expect(slider).toHaveAttribute('min', '20');
  await expect(slider).toHaveAttribute('max', '100');
  const opacity = (selector: string) => page.locator(selector).first().evaluate(el => getComputedStyle(el).opacity);
  expect(await opacity('.frame canvas')).toBe('1');
  await slider.fill('30');
  await expect.poll(() => opacity('.frame canvas')).toBe('0.3');
  expect(await opacity('.frame svg')).toBe('1');
});

test('markup in a room name or the project name shows as text and runs nothing', async ({ page }) => {
  const evil = '<img src=x onerror=window.pwned=1>';
  await start(page);
  await page.getByLabel(e.name).fill(evil);
  await page.getByLabel(e.name).press('Enter');
  await drawFive(page, 4);
  const r = await room(page, [1700, 2200]);
  await r.getByLabel(e.roomName).fill(evil);
  await r.getByLabel(e.roomName).press('Enter');
  await expect(page.locator('[data-room]')).toContainText(evil);
  await expect(page.getByLabel(e.name)).toHaveValue(evil);
  expect(await page.locator('img').count()).toBe(0);
  expect(await page.evaluate(() => window.pwned)).toBeUndefined();
});

test('an empty project name is not taken; the field returns to the name; the default is the file name', async ({ page }) => {
  await start(page);
  await expect(page.getByLabel(e.name)).toHaveValue('plan-7');
  await page.getByLabel(e.name).fill('   ');
  await page.getByLabel(e.name).press('Enter');
  await expect(page.getByLabel(e.name)).toHaveValue('plan-7');
  await expect(page.getByRole('button', { name: e.undo })).toBeDisabled();
});

test('recalibrating keeps the drawn walls on the page and puts the new plaster answer in the sentence', async ({ page }) => {
  await start(page, 'none');
  await drawFive(page, 4);
  const before = await wallBoxes(page);
  await tool(page, copy.measure.title);
  await page.getByRole('button', { name: copy.measure.again }).click();
  await page.getByRole('button', { name: c.plaster.inWall, exact: true }).click();
  await page.getByRole('button', { name: c.go(50) }).click();
  expect(await wallBoxes(page)).toEqual(before);
  await expect(await room(page, [1700, 2200])).toContainText(copy.plasterSentence.inWall);
  await tool(page, e.wall);
  await expect(page.getByTestId('plaster-note')).toHaveText(e.plasterNote.inWall);
});

test('nothing is drawn over a room\'s name and area, not even a wall being drawn across it', async ({ page }) => {
  await start(page);
  await twoRooms(page);
  await tool(page, e.wall);
  await thickness(page).fill('50');
  await clickMm(page, [200, 2100]);
  await page.getByRole('button', { name: copy.fit }).click();
  await page.mouse.move(...(await onScreen(page, viewOf(50, [6200, 2100]))));
  await expect(page.getByTestId('wall-preview')).toBeVisible();
  // the labels take no clicks (they would hide the room from the select tool): let them be found for this check only
  await page.locator('[data-room] text').evaluateAll(texts => texts.forEach(t => ((t as SVGElement).style.pointerEvents = 'auto')));
  for (const label of await page.locator('[data-room] text').all()) {
    const box = (await label.boundingBox())!;
    const top = await page.evaluate(([x, y]) => document.elementFromPoint(x, y)?.closest('[data-room]') !== null, [box.x + box.width / 2, box.y + box.height / 2]);
    expect(top).toBe(true);
  }
});

test('every button on every screen has one font size and one height', async ({ page }) => {
  const same = async (where: string) => {
    const sizes = await page.locator('button:visible, .upload:visible').evaluateAll(list => list.map(b => `${getComputedStyle(b).fontSize} ${Math.round(b.getBoundingClientRect().height)}`));
    expect(sizes.length, where).toBeGreaterThan(0);
    expect(new Set(sizes), `${where}: ${sizes.join(', ')}`).toEqual(new Set([sizes[0]]));
  };
  await page.goto('/');
  await same('upload');
  await page.getByTestId('upload').setInputFiles({ name: 'plan.pdf', mimeType: 'application/pdf', buffer: Buffer.from(dimsPdf()) });
  await expect(page.getByTestId('drawing').locator('canvas')).toHaveCount(2);
  await markMm(page, DIMS.outer);
  await same('calibration');
  await markMm(page, DIMS.heightA);
  await markMm(page, DIMS.roomB);
  await page.getByRole('button', { name: c.go(50) }).click();
  await same('editor, measure');
  await tool(page, e.wall);
  await drawWall(page, FIVE[0]);
  await wall(page, [3000, 100]);
  await same('editor, a wall chosen');
});

// ---- the view (owner R7) ----
const readView = (page: Page) =>
  page.evaluate(() => {
    const svg = document.querySelector<SVGSVGElement>('[data-testid="canvas"]')!;
    const m = svg.getScreenCTM()!;
    const f = document.querySelector('.frame')!.getBoundingClientRect();
    return { box: svg.getAttribute('viewBox'), a: m.a, e: m.e, f: m.f, fw: f.width, fh: f.height, fl: f.left, ft: f.top };
  });
async function zoomAndPan(page: Page) {
  await page.mouse.move(...(await onScreen(page, viewOf(50, [3200, 2200]))));
  for (let i = 0; i < 7; i++) await page.mouse.wheel(0, -100);
  await expect(page.getByTestId('zoom')).not.toHaveText(/ 100%$/);
  const box = (await canvas(page).boundingBox())!;
  await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
  await page.mouse.down();
  await page.mouse.move(box.x + box.width / 2 + 150, box.y + box.height / 2 + 90, { steps: 5 });
  await page.mouse.up();
}
async function reset(page: Page) {
  await page.getByRole('button', { name: copy.fit }).click();
  await expect(canvas(page)).toHaveAttribute('viewBox', '0 0 842 595');
  await expect(page.getByTestId('zoom')).toHaveText(`${e.zoom} 100%`); // the words for a screen reader, the number on the screen
}
const clickAt = async (page: Page, mm: Vec) => page.mouse.click(...(await onScreen(page, viewOf(50, mm))));

test('איפוס תצוגה and the key 0 give back the whole page, centred, at 100 %, on the editor and on the calibration screen', async ({ page }) => {
  await start(page);
  await zoomAndPan(page);
  await reset(page);
  const v = await readView(page);
  const a = Math.min(v.fw / 842, v.fh / 595);
  expect(v.a).toBeCloseTo(a, 6);
  expect(v.e).toBeCloseTo(v.fl + (v.fw - 842 * a) / 2, 2);
  expect(v.f).toBeCloseTo(v.ft + (v.fh - 595 * a) / 2, 2);
  await zoomAndPan(page);
  await canvas(page).focus();
  await page.keyboard.press('0');
  expect(await readView(page)).toEqual(v);
  // the calibration screen has it too
  await tool(page, copy.measure.title);
  await page.getByRole('button', { name: copy.measure.again }).click();
  await zoomAndPan(page);
  await reset(page);
});

test('a wall drawn after a reset has the same coordinates as before, at two window sizes; a half-drawn wall survives the reset', async ({ page }) => {
  await start(page);
  await tool(page, e.wall);
  await thickness(page).fill('20');
  await reset(page);
  await clickAt(page, [0, 100]);
  await clickAt(page, [6400, 100]);
  expect(await wallBoxes(page)).toEqual([[0, 0, 6400, 200]]);
  for (const [w, h] of [[1440, 900], [800, 600]]) {
    await page.setViewportSize({ width: w, height: h });
    await page.getByRole('button', { name: e.undo }).click();
    expect(await wallBoxes(page)).toEqual([]);
    await zoomAndPan(page);
    await reset(page);
    await clickAt(page, [0, 100]);
    await zoomAndPan(page);
    await reset(page);
    await expect(page.getByTestId('step')).toHaveText(e.wallSecond);
    await clickAt(page, [6400, 100]);
    expect(await wallBoxes(page), `${w} x ${h}`).toEqual([[0, 0, 6400, 200]]);
  }
});

test('narrow and short windows and a 300 % browser zoom: no sideways scroll, the panel never over the plan, the plan at least 280 px, every control reachable', async ({ browser }) => {
  for (const [label, options] of [
    ['375 x 700', { viewport: { width: 375, height: 700 } }],
    ['375 x 400', { viewport: { width: 375, height: 400 } }],
    ['1440 x 400', { viewport: { width: 1440, height: 400 } }],
    ['300 %', { viewport: { width: 482, height: 287 }, deviceScaleFactor: 3 }],
  ] as const) {
    const context = await (browser as Browser).newContext(options);
    const page = await context.newPage();
    await page.addInitScript(() => {
      window.violations = [];
      document.addEventListener('securitypolicyviolation', event => window.violations.push(event.effectiveDirective));
    });
    await start(page, 'line', [options.viewport.width, options.viewport.height]);
    await tool(page, e.wall);
    const m = await page.evaluate(() => {
      const f = document.querySelector('.frame')!.getBoundingClientRect();
      const p = document.querySelector('.panel')!.getBoundingClientRect();
      return {
        sideways: document.documentElement.scrollWidth - document.documentElement.clientWidth,
        overlap: Math.max(0, Math.min(f.right, p.right) - Math.max(f.left, p.left)) * Math.max(0, Math.min(f.bottom, p.bottom) - Math.max(f.top, p.top)),
        height: f.height,
      };
    });
    expect(m.sideways, label).toBeLessThanOrEqual(0);
    expect(m.overlap, label).toBe(0);
    expect(m.height, label).toBeGreaterThanOrEqual(279.5);
    for (const name of [e.wall, e.undo, copy.fit]) {
      const button = page.getByRole('button', { name, exact: true });
      await button.scrollIntoViewIfNeeded();
      const reachable = await button.evaluate(b => {
        const r = b.getBoundingClientRect();
        const top = document.elementFromPoint(r.left + r.width / 2, r.top + r.height / 2);
        return r.left >= 0 && r.right <= innerWidth + 0.5 && !!top && b.contains(top);
      });
      expect(reachable, `${label}: ${name}`).toBe(true);
    }
    await page.getByTestId('step').scrollIntoViewIfNeeded();
    await expect(page.getByTestId('step')).toBeInViewport();
    await drawWall(page, FIVE[0]);
    expect(await wallBoxes(page), label).toEqual([[0, 0, 6400, 200]]);
    expect(await page.evaluate(() => window.violations), label).toEqual([]);
    await context.close();
  }
});

// ---- fix round 1 ----
test('one view control, after the drawing; the editor\'s tools before it: the keyboard\'s order is the order on the screen', async ({ page }) => {
  await start(page);
  await expect(page.getByRole('button', { name: copy.fit })).toHaveCount(1);
  const order = await page.evaluate(([tools, fit]) => {
    const group = document.querySelector(`[role="group"][aria-label="${tools}"]`)!;
    const svg = document.querySelector('[data-testid="canvas"]')!;
    const reset = [...document.querySelectorAll('button')].find(b => b.textContent === fit)!;
    const before = (a: Element, b: Element) => !!(a.compareDocumentPosition(b) & Node.DOCUMENT_POSITION_FOLLOWING);
    const top = (x: Element) => x.getBoundingClientRect().top;
    return { domToolsFirst: before(group, svg), domResetAfter: before(svg, reset), screenToolsAbove: top(group) < top(svg), screenResetBelow: top(reset) > top(svg) };
  }, [e.tools, copy.fit]);
  expect(order).toEqual({ domToolsFirst: true, domResetAfter: true, screenToolsAbove: true, screenResetBelow: true });
  await expect(page.locator('#canvas-help')).toContainText('0 לאיפוס התצוגה');
});

test('undo of a recalibration and of a plaster answer takes both back everywhere: walls, measuring, the plaster lines', async ({ page }) => {
  await start(page, 'none');
  await tool(page, e.wall);
  await drawWall(page, FIVE[0]);
  await tool(page, copy.measure.title);
  await page.getByRole('button', { name: copy.measure.again }).click();
  await page.getByRole('button', { name: c.plaster.inWall, exact: true }).click();
  for (let i = 3; i >= 1; i--) await page.getByRole('button', { name: c.removeLabel(i) }).click();
  // written 5 % longer than drawn: a scale of about 1:47.6, and every wall 5 % longer in mm
  for (const [mark, text] of [[DIMS.outer, '672'], [DIMS.heightA, '420'], [DIMS.roomB, '304.5']] as const) await markMm(page, { ...mark, text });
  await page.getByRole('button', { name: /והמשך|^המשך/ }).click();
  const width = async () => { const [b] = await wallBoxes(page); return Math.round(b[2] - b[0]); };
  expect(await width()).toBe(6720);
  await tool(page, e.wall);
  await expect(page.getByTestId('plaster-note')).toHaveText(e.plasterNote.inWall);
  await page.keyboard.press('Control+z'); // the new scale
  expect(await width()).toBe(6400);
  await tool(page, copy.measure.title);
  await expect(page.getByRole('region', { name: copy.measure.title })).toContainText(copy.measure.verified(50, 3));
  await page.keyboard.press('Control+z'); // the plaster answer
  await tool(page, e.wall);
  await expect(page.getByTestId('plaster-note')).toHaveText(e.plasterNote.none);
});

/** Both rooms, the right one marked as the mamad. */
async function withMamad(page: Page) {
  await twoRooms(page);
  await page.getByRole('button', { name: e.part(1, '12.00') }).click();
  const right = await room(page, [4700, 2200]);
  await right.getByLabel(e.isMamad).check();
}
const mamadRow = (page: Page) => page.getByText(e.mamadOpen(e.unnamed));

test('the mamad\'s release row follows undo and redo, both ways', async ({ page }) => {
  await start(page);
  await withMamad(page);
  const details = await wall(page, [3250, 3000]);
  await details.getByRole('button', { name: e.fix }).click();
  await expect(mamadRow(page)).toBeVisible();
  await page.keyboard.press('Control+z'); // the mark is back: nothing to confirm
  await expect(mamadRow(page)).toHaveCount(0);
  await page.keyboard.press('Control+y');
  await expect(mamadRow(page)).toBeVisible();
  await mamadRow(page).getByRole('button', { name: e.confirm }).click();
  await expect(mamadRow(page)).toHaveCount(0);
  await page.keyboard.press('Control+z'); // the mark is gone again: the row asks again
  await expect(mamadRow(page)).toBeVisible();
});

test('unticking זה הממ"ד is the mamad\'s תיקון: its row with אישור appears', async ({ page }) => {
  await start(page);
  await withMamad(page);
  const right = await room(page, [4700, 2200]);
  await right.getByLabel(e.isMamad).uncheck();
  await expect(mamadRow(page)).toBeVisible();
  await mamadRow(page).getByRole('button', { name: e.confirm }).click();
  await expect(right.getByLabel(e.isMamad)).toBeChecked();
});

test('when the room that was the mamad is gone at אישור, the panel says to mark it again', async ({ page }) => {
  await start(page);
  await withMamad(page);
  const details = await wall(page, [3250, 3000]);
  await details.getByRole('button', { name: e.fix }).click();
  await tool(page, e.remove);
  await clickMm(page, [3250, 3000]); // the partition: the two rooms are one
  await page.getByRole('button', { name: e.save }).click();
  await mamadRow(page).getByRole('button', { name: e.confirm }).click();
  await expect(message(page)).toHaveText(e.mamadChanged);
});

test('the measure tool\'s result carries לפי השרטוט too', async ({ page }) => {
  await start(page);
  await clickMm(page, [200, 2500]);
  await clickMm(page, [3200, 2500]);
  await expect(page.getByTestId('measured')).toHaveText(`${copy.measure.result('300')} ${copy.byDrawing}`);
});

test('nothing is drawn over a room\'s name and area: no shape painted after a label meets its box', async ({ page }) => {
  await start(page);
  await twoRooms(page);
  await room(page, [1700, 2200]); // a selected room: its outline and edge lengths
  await tool(page, e.wall);
  await thickness(page).fill('50');
  await clickMm(page, [200, 2100]);
  await page.getByRole('button', { name: copy.fit }).click();
  await page.mouse.move(...(await onScreen(page, viewOf(50, [6200, 2100]))));
  await expect(page.getByTestId('wall-preview')).toBeVisible();
  const over = await page.evaluate(() => {
    const svg = document.querySelector('[data-testid="canvas"]')!;
    const labels = [...svg.querySelectorAll('[data-room] text')];
    const shapes = [...svg.querySelectorAll('path, rect, circle, line, text, polygon')].filter(x => !x.closest('[data-room]'));
    const meet = (a: DOMRect, b: DOMRect) => a.left < b.right && b.left < a.right && a.top < b.bottom && b.top < a.bottom;
    // a shape painted after a label, and over it
    return labels.flatMap(label =>
      shapes.filter(x => label.compareDocumentPosition(x) & Node.DOCUMENT_POSITION_FOLLOWING && meet(label.getBoundingClientRect(), x.getBoundingClientRect())).map(x => x.outerHTML.slice(0, 40)),
    );
  });
  expect(over).toEqual([]);
  // and the preview does cross a label's box, so the test means something
  const crosses = await page.evaluate(() => {
    const p = document.querySelector('[data-testid="wall-preview"] path')!.getBoundingClientRect();
    return [...document.querySelectorAll('[data-room] text')].some(t => { const r = t.getBoundingClientRect(); return r.left < p.right && p.left < r.right && r.top < p.bottom && p.top < r.bottom; });
  });
  expect(crosses).toBe(true);
});

test('the plan strength starts again at 100 on another page', async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.goto('/');
  await page.getByTestId('upload').setInputFiles({ name: 'plan.pdf', mimeType: 'application/pdf', buffer: Buffer.from(dimsPdf(50, 2)) });
  const calibrate = async (n: number) => {
    await page.getByRole('button', { name: copy.page(n), exact: true }).click();
    await expect(page.getByTestId('drawing').locator('canvas')).toHaveCount(2);
    for (const mark of [DIMS.outer, DIMS.heightA, DIMS.roomB]) await markMm(page, mark);
    await page.getByRole('button', { name: c.go(50) }).click();
  };
  await calibrate(1);
  await page.getByLabel(e.strength).fill('30');
  await expect.poll(() => page.locator('.frame canvas').first().evaluate(x => getComputedStyle(x).opacity)).toBe('0.3');
  await calibrate(2);
  await expect(page.getByLabel(e.strength)).toHaveValue('100');
  expect(await page.locator('.frame canvas').first().evaluate(x => getComputedStyle(x).opacity)).toBe('1');
});

test('zoomed out, the wall tool asks to zoom in first; zoomed in, it does not; it never blocks drawing', async ({ page }) => {
  await start(page);
  await tool(page, e.wall);
  await page.getByRole('button', { name: copy.fit }).click();
  await expect(page.getByTestId('zoom-hint')).toHaveText(e.zoomHint); // about 13 mm of the apartment per screen pixel here
  await page.mouse.move(...(await onScreen(page, viewOf(50, [3200, 2200]))));
  for (let i = 0; i < 4; i++) await page.mouse.wheel(0, -100); // about 2.4 times: about 5.5 mm per pixel, still too far
  await expect(page.getByTestId('zoom-hint')).toHaveText(e.zoomHint);
  await page.mouse.wheel(0, -100);
  await page.mouse.wheel(0, -100);
  await expect(page.getByTestId('zoom-hint')).toHaveText('');
  await page.getByRole('button', { name: copy.fit }).click();
  await thickness(page).fill('20');
  await clickAt(page, [0, 100]);
  await clickAt(page, [6400, 100]);
  expect(await wallBoxes(page)).toEqual([[0, 0, 6400, 200]]);
});

test('Enter keeps the focus in a name field; a refused thickness goes back to the wall\'s; the question and the message leave with an undo', async ({ page }) => {
  await start(page);
  await page.getByLabel(e.name).fill('בית');
  await page.getByLabel(e.name).press('Enter');
  expect(await page.evaluate(() => document.activeElement?.getAttribute('maxlength'))).toBe('200');
  await twoRooms(page);
  await page.keyboard.press('Control+z'); // the partition: its question goes with it
  await expect(split(page)).toHaveCount(0);
  await tool(page, e.wall);
  await drawWall(page, FIVE[4]);
  await page.getByRole('button', { name: e.part(1, '12.00') }).click();
  const details = await wall(page, [3250, 3000]);
  const field = details.getByLabel(e.thickness);
  await field.fill('abc');
  await field.press('Enter');
  await expect(message(page)).toHaveText(e.badThickness);
  await expect(field).toHaveValue('10');
  await expect(field).toBeFocused();
  await tool(page, e.remove);
  await clickMm(page, [100, 3000]);
  await expect(message(page)).not.toHaveText('');
  await page.keyboard.press('Control+z');
  await expect(message(page)).toHaveText('');
});

// ---- fix round 2 ----
test('an undo of a merge takes its question away; the rooms keep their names', async ({ page }) => {
  await start(page);
  await twoRooms(page);
  await page.getByRole('button', { name: e.part(1, '12.00') }).click();
  await tool(page, e.remove);
  await clickMm(page, [3250, 3000]);
  await expect(page.getByText(/התאחדו לחלל אחד/)).toBeVisible();
  await page.keyboard.press('Control+z');
  await expect(page.locator('[data-room]')).toHaveCount(2);
  await expect(page.getByText(/התאחדו לחלל אחד/)).toHaveCount(0);
  await expect(page.locator('[data-room]').filter({ hasText: 'סלון' })).toHaveCount(1);
});

test('renaming the project leaves the load-bearing warning and a gone room\'s sentence on screen', async ({ page }) => {
  await start(page);
  await drawFive(page, 4);
  const first = await wall(page, [3000, 100]);
  await first.getByRole('button', { name: e.classes.changeable }).click();
  await expect(message(page)).toHaveText(e.loadBearing);
  await page.getByLabel(e.name).fill('בית אחר');
  await page.getByLabel(e.name).press('Enter');
  await page.waitForTimeout(300);
  await expect(message(page)).toHaveText(e.loadBearing);
  await tool(page, e.remove);
  await clickMm(page, [100, 3000]);
  await expect(message(page)).toHaveText(e.gone(e.unnamed));
  await page.getByLabel(e.name).fill('בית שלישי');
  await page.getByLabel(e.name).press('Enter');
  await page.waitForTimeout(300);
  await expect(message(page)).toHaveText(e.gone(e.unnamed));
});

test('no release row where she never released: mark, תיקון, אישור, then undo three times', async ({ page }) => {
  await start(page);
  await withMamad(page);
  const details = await wall(page, [3250, 3000]);
  await details.getByRole('button', { name: e.fix }).click();
  await mamadRow(page).getByRole('button', { name: e.confirm }).click();
  await expect(mamadRow(page)).toHaveCount(0);
  for (let i = 0; i < 3; i++) await page.keyboard.press('Control+z');
  await expect(page.locator('[data-wall]').nth(4)).not.toHaveAttribute('fill', COLOR.mamad);
  await expect(mamadRow(page)).toHaveCount(0);
});
