import { expect, type Page, test } from '@playwright/test';
import { copy } from '../../src/copy';
import type { Vec } from '../../src/shared';
import { DIMS, dimsPdf, type Mark, viewOf } from '../fixtures/dims';
import { describeSamples } from '../samples';

const c = copy.calibrate;
const m = copy.measure;
const canvas = (page: Page) => page.getByTestId('canvas');
const fitBox = (page: Page) => page.getByTestId('fit');
const field = (page: Page) => page.getByLabel(c.written);
const measurePanel = (page: Page) => page.getByRole('region', { name: m.title });
const calibratePanel = (page: Page) => page.getByRole('region', { name: c.title });
const warning = (page: Page) => page.getByText(copy.unverified, { exact: true });

async function open(page: Page, pdf = dimsPdf(), width = 1280, height = 800) {
  await page.setViewportSize({ width, height });
  await page.goto('/');
  await page.getByTestId('upload').setInputFiles({ name: 'plan.pdf', mimeType: 'application/pdf', buffer: Buffer.from(pdf) });
  await expect(page.getByTestId('drawing').locator('canvas')).toHaveCount(2);
}
/** Where a view point is in the window. */
const onScreen = (page: Page, [x, y]: Vec) =>
  canvas(page).evaluate((svg: SVGSVGElement, [x, y]) => {
    const at = new DOMPoint(x, y).matrixTransform(svg.getScreenCTM()!);
    return [at.x, at.y] as Vec;
  }, [x, y]);
const viewBox = async (page: Page) => (await canvas(page).getAttribute('viewBox'))!.split(' ').map(Number);
/** As a designer does: the wheel zooms in over the point (about 3.7 times), then a click. */
async function clickMm(page: Page, scale: number, mm: Vec, zoom = true) {
  if (zoom) {
    await page.getByRole('button', { name: copy.fit }).click();
    await page.mouse.move(...(await onScreen(page, viewOf(scale, mm))));
    for (let i = 0; i < 6; i++) await page.mouse.wheel(0, -100);
    await expect.poll(async () => (await viewBox(page))[2]).toBeLessThan(250);
  }
  await page.mouse.click(...(await onScreen(page, viewOf(scale, mm))));
  if (zoom) await page.getByRole('button', { name: copy.fit }).click(); // the second click gave the focus to the number field
}
async function markMm(page: Page, scale: number, mark: Mark, typed = mark.text) {
  await clickMm(page, scale, mark.a);
  await clickMm(page, scale, mark.b);
  await field(page).fill(typed);
  await field(page).press('Enter');
  await expect(field(page)).toHaveCount(0);
}
async function measureMm(page: Page, scale: number, a: Vec, b: Vec) {
  await clickMm(page, scale, a);
  await clickMm(page, scale, b);
  return page.getByTestId('measured').innerText();
}
const goButtons = (page: Page) => page.getByRole('button', { name: /המשך|אישור|אין עוד מידות/ });

test('nothing measures before a scale is accepted', async ({ page }) => {
  await open(page);
  const nothingMeasures = async (state: string, buttons: string[]) => {
    await expect(measurePanel(page), state).toHaveCount(0);
    await expect(page.getByTestId('measured'), state).toHaveCount(0);
    await expect(warning(page), state).toHaveCount(0);
    expect(await goButtons(page).allInnerTexts(), state).toEqual(buttons);
  };
  await nothingMeasures('none', []);
  await canvas(page).click({ position: { x: 300, y: 300 } });
  await canvas(page).click({ position: { x: 400, y: 300 } });
  await nothingMeasures('two clicks', []);
  await page.getByRole('button', { name: c.cancel }).click();
  await markMm(page, 50, DIMS.roomB);
  await markMm(page, 50, DIMS.part120);
  await expect(fitBox(page)).toContainText(c.need.count);
  await nothingMeasures('count', []);
  await markMm(page, 50, DIMS.part250);
  await expect(fitBox(page)).toContainText(c.need.long);
  await nothingMeasures('long', []);
  for (let i = 3; i >= 1; i--) await page.getByRole('button', { name: c.removeLabel(i) }).click();
  for (const mark of [DIMS.roomA, DIMS.roomB, DIMS.heightA]) await markMm(page, 50, mark);
  await expect(fitBox(page)).toContainText(c.need.spread);
  await nothingMeasures('spread', [c.noMore]);
  await markMm(page, 50, DIMS.roomA);
  await expect(fitBox(page)).toContainText(c.invalid(4, c.problem.duplicate));
  await nothingMeasures('invalid', []);
  await page.getByRole('button', { name: c.removeLabel(4) }).click();
  await markMm(page, 50, DIMS.outer, '700');
  await expect(fitBox(page)).toContainText(c.inconsistent);
  await nothingMeasures('inconsistent', []);
  for (let i = 4; i >= 1; i--) await page.getByRole('button', { name: c.removeLabel(i) }).click();
  for (const mark of [DIMS.roomA, DIMS.roomB, DIMS.heightA, DIMS.outer]) await markMm(page, 50, mark, String(Number(mark.text) - 9));
  await expect(fitBox(page)).toContainText(c.need.offset);
  await nothingMeasures('offset', []);
});

test('640, 400, 290 at 1:50 -> 1:50 verified; measuring room A shows 300 ס"מ לפי השרטוט and the plaster sentence', async ({ page }) => {
  await open(page);
  for (const mark of [DIMS.outer, DIMS.heightA, DIMS.roomB]) await markMm(page, 50, mark);
  await expect(fitBox(page)).toHaveText(c.ok(50) + c.go(50));
  await page.getByRole('button', { name: c.go(50) }).click();
  await expect(calibratePanel(page)).toHaveCount(0);
  await expect(measurePanel(page)).toContainText(m.verified(50, 3));
  await expect(warning(page)).toHaveCount(0);
  expect(await measureMm(page, 50, [200, 2500], [3200, 2530])).toBe(`${m.result('300')} ${copy.byDrawing}`);
  await expect(measurePanel(page)).toContainText(copy.plasterSentence.unknown);
});

test('300, 290, 400 ask for one more of another length, and offer the button at 1:50', async ({ page }) => {
  await open(page);
  for (const mark of [DIMS.roomA, DIMS.roomB, DIMS.heightA]) await markMm(page, 50, mark);
  await expect(fitBox(page)).toHaveText(c.need.spread + c.noMoreNote(50) + c.noMore);
  await expect(page.getByRole('list', { name: c.list }).getByRole('listitem')).toHaveText([
    `${c.row(3000, 3000)}${c.remove}`, `${c.row(2900, 2900)}${c.remove}`, `${c.row(4000, 4000)}${c.remove}`,
  ]);
});

test('drawn at 1:122.5 with 1:50 chosen: four dimensions -> 1:122.5 that must be confirmed; room A then measures 300', async ({ page }) => {
  await open(page, dimsPdf(122.5));
  await expect(page.getByRole('button', { name: c.scale(50) })).toHaveAttribute('aria-pressed', 'true');
  for (const mark of [DIMS.roomA, DIMS.roomB, DIMS.heightA]) await markMm(page, 122.5, mark);
  await expect(fitBox(page)).not.toContainText(c.confirm(122.5));
  await markMm(page, 122.5, DIMS.outer);
  await expect(fitBox(page)).toHaveText(c.nonstandard(122.5) + c.confirm(122.5));
  await page.getByRole('button', { name: c.confirm(122.5) }).click();
  expect(await measureMm(page, 122.5, [200, 2500], [3200, 2500])).toContain(m.result('300'));
});

test('drawn at 1:100 with 1:50 chosen: 1:100 must be confirmed', async ({ page }) => {
  await open(page, dimsPdf(100));
  for (const mark of [DIMS.outer, DIMS.heightA, DIMS.roomB]) await markMm(page, 100, mark);
  await expect(fitBox(page)).toHaveText(c.otherStandard(100, 50) + c.confirm(100));
  await page.getByRole('button', { name: c.confirm(100) }).click();
  await expect(measurePanel(page)).toContainText(m.verified(100, 3));
});

test('drawn at 1:51: the confirm warns that it is near 1:50', async ({ page }) => {
  await open(page, dimsPdf(51));
  for (const mark of [DIMS.outer, DIMS.heightA, DIMS.roomB, DIMS.part120]) await markMm(page, 51, mark);
  await expect(fitBox(page)).toHaveText(c.nonstandard(51) + c.near(50) + c.confirm(51));
});

test('written 5 cm under the drawing: verified with an offset of 5.0 ס"מ; room A still measures 300', async ({ page }) => {
  await open(page);
  for (const mark of [DIMS.outer, DIMS.heightA, DIMS.roomB, DIMS.roomA]) await markMm(page, 50, mark, String(Number(mark.text) - 5));
  await expect(fitBox(page)).toHaveText(c.offset(50, 50) + c.go(50));
  await page.getByRole('button', { name: c.go(50) }).click();
  expect(await measureMm(page, 50, [200, 2500], [3200, 2500])).toContain(m.result('300'));
});

test('written 9 cm under the drawing: cannot be calibrated, says so, no button', async ({ page }) => {
  await open(page);
  for (const mark of [DIMS.outer, DIMS.heightA, DIMS.roomB, DIMS.roomA]) await markMm(page, 50, mark, String(Number(mark.text) - 9));
  await expect(fitBox(page)).toHaveText(c.need.offset);
  await expect(goButtons(page)).toHaveCount(0);
});

test('a mistyped dimension shows the warning; deleting it and marking it again verifies', async ({ page }) => {
  await open(page);
  await markMm(page, 50, DIMS.outer);
  await markMm(page, 50, DIMS.heightA, '440');
  await markMm(page, 50, DIMS.roomB);
  await expect(fitBox(page)).toHaveText(c.inconsistent);
  await page.getByRole('button', { name: c.removeLabel(2) }).click();
  await markMm(page, 50, DIMS.heightA);
  await expect(fitBox(page)).toHaveText(c.ok(50) + c.go(50));
});

test('the same dimension twice is named with its reason; the other marks stay', async ({ page }) => {
  await open(page);
  for (const mark of [DIMS.outer, DIMS.heightA, DIMS.outer]) await markMm(page, 50, mark);
  await expect(fitBox(page)).toHaveText(c.invalid(3, c.problem.duplicate));
  const rows = page.getByRole('list', { name: c.list }).getByRole('listitem');
  await expect(rows).toHaveCount(3);
  await expect(rows.nth(2)).toContainText(c.problem.duplicate);
  await page.getByRole('button', { name: c.removeLabel(3) }).click();
  await expect(rows).toHaveCount(2);
  await expect(fitBox(page)).toHaveText(c.need.count + c.noMoreNote(50) + c.noMore);
});

test('12,5 / abc / 1e9 / -300 / nothing are refused in the field, and nothing is added', async ({ page }) => {
  await open(page);
  await clickMm(page, 50, DIMS.outer.a);
  await clickMm(page, 50, DIMS.outer.b);
  for (const typed of ['12,5', 'abc', '1e9', '-300', '', '312 ס"מ']) {
    await field(page).fill(typed);
    await field(page).press('Enter');
    await expect(page.getByText(c.badNumber), typed).toBeVisible();
    await expect(field(page)).toHaveAttribute('aria-invalid', 'true');
  }
  await expect(page.getByRole('list', { name: c.list })).toHaveCount(0);
  await field(page).fill('640.5');
  await field(page).press('Enter');
  await expect(page.getByRole('list', { name: c.list }).getByRole('listitem')).toHaveText([`${c.row(6405, 6400)}${c.remove}`]);
});

test('an 80 cm dimension stays listed as not used', async ({ page }) => {
  await open(page);
  for (const mark of [DIMS.outer, DIMS.heightA, DIMS.roomB, DIMS.door]) await markMm(page, 50, mark);
  await expect(page.getByRole('list', { name: c.list }).getByRole('listitem').nth(3)).toHaveText(`${c.row(800, 800)} ${c.short}${c.remove}`);
  await expect(fitBox(page)).toHaveText(c.ok(50) + c.go(50));
  await page.getByRole('button', { name: c.go(50) }).click();
  await expect(measurePanel(page)).toContainText(m.verified(50, 3)); // the 80 cm one was not used
});

test('one 640: the button continues at 1:50 unverified; the warning stays after measuring, zooming and during recalibration, until a verified scale replaces it', async ({ page }) => {
  await open(page);
  await markMm(page, 50, DIMS.outer);
  await expect(fitBox(page)).toHaveText(c.need.count + c.noMoreNote(50) + c.noMore);
  await page.getByRole('button', { name: c.noMore }).click();
  await expect(warning(page)).toBeVisible();
  await expect(warning(page)).toHaveAttribute('aria-live', 'polite');
  await expect(measurePanel(page)).toContainText(m.unverified(50));
  expect(await measureMm(page, 50, [200, 2500], [3200, 2500])).toContain(m.result('300'));
  await expect(warning(page)).toBeVisible();
  await page.getByRole('button', { name: copy.zoomIn }).click();
  await page.mouse.move(...(await onScreen(page, [400, 300])));
  await page.mouse.wheel(0, -300);
  await expect(warning(page)).toBeVisible();
  await page.getByRole('button', { name: m.again }).click();
  await expect(calibratePanel(page)).toBeVisible();
  await expect(measurePanel(page)).toHaveCount(0); // nothing measures while recalibrating
  await expect(warning(page)).toBeVisible(); // the unverified scale is still the one there is
  await expect(page.getByRole('list', { name: c.list }).getByRole('listitem')).toHaveCount(1); // the marks are kept
  await markMm(page, 50, DIMS.heightA);
  await expect(warning(page)).toBeVisible();
  await markMm(page, 50, DIMS.roomB);
  await page.getByRole('button', { name: c.go(50) }).click();
  await expect(measurePanel(page)).toContainText(m.verified(50, 3));
  await expect(warning(page)).toHaveCount(0);
});

test('the button carries 1:100 when the dimensions say so, and its note says 1:100', async ({ page }) => {
  await open(page, dimsPdf(100));
  await markMm(page, 100, DIMS.outer);
  await expect(fitBox(page)).toHaveText(c.need.count + c.noMoreNote(100) + c.noMore);
  await page.getByRole('button', { name: c.noMore }).click();
  await expect(measurePanel(page)).toContainText(m.unverified(100));
});

test('the left button drags; a click with a 3 px wobble places a point; the middle button and space still drag', async ({ page }) => {
  await open(page);
  const status = calibratePanel(page).locator('p[aria-live]'); // not role=status: the app's own status line keeps that role
  const [x, y] = await onScreen(page, [600, 400]);
  const before = await viewBox(page);
  await page.mouse.move(x, y);
  await page.mouse.down();
  await page.mouse.move(x + 60, y + 40, { steps: 4 });
  expect(await canvas(page).evaluate(svg => getComputedStyle(svg).cursor)).toBe('grab');
  await page.mouse.up();
  expect(await canvas(page).evaluate(svg => getComputedStyle(svg).cursor)).toBe('crosshair');
  const dragged = await viewBox(page);
  expect(dragged[0]).toBeLessThan(before[0] - 30);
  await expect(status).toHaveText(c.first);
  await page.mouse.move(x, y);
  await page.mouse.down();
  await page.mouse.move(x + 3, y, { steps: 2 });
  await page.mouse.up();
  expect(await viewBox(page)).toEqual(dragged);
  await expect(status).toContainText(c.second);
  for (const button of ['middle', 'space'] as const) {
    const from = await viewBox(page);
    if (button === 'space') await page.keyboard.down(' ');
    await page.mouse.move(x, y);
    await page.mouse.down({ button: button === 'middle' ? 'middle' : 'left' });
    await page.mouse.move(x - 60, y, { steps: 4 });
    await page.mouse.up({ button: button === 'middle' ? 'middle' : 'left' });
    if (button === 'space') await page.keyboard.up(' ');
    expect((await viewBox(page))[0], button).toBeGreaterThan(from[0] + 30);
    await expect(status, button).toContainText(c.second); // no point was placed
  }
});

test('keyboard only: Tab to the drawing, zoom, move, Enter places both ends at the centre, type, Enter adds; Escape cancels', async ({ page }) => {
  await open(page);
  await page.getByTestId('upload').focus();
  await page.keyboard.press('Tab');
  await expect(canvas(page)).toBeFocused();
  /** Zooms in and moves the view until its centre is within a hundredth of the view of the point, by keys only. */
  const centreOn = async ([x, y]: Vec) => {
    await page.keyboard.press('0');
    for (let i = 0; i < 6; i++) await page.keyboard.press('+');
    const [left, top, width, height] = await viewBox(page);
    for (const [gap, step, less, more] of [[x - left - width / 2, width, 'ArrowLeft', 'ArrowRight'], [y - top - height / 2, height, 'ArrowUp', 'ArrowDown']] as const) {
      const key = gap < 0 ? less : more;
      const tenths = Math.trunc(Math.abs(gap) / (step / 10));
      for (let i = 0; i < tenths; i++) await page.keyboard.press(key);
      const hundredths = Math.round((Math.abs(gap) - tenths * (step / 10)) / (step / 100));
      for (let i = 0; i < hundredths; i++) await page.keyboard.press(`Shift+${key}`);
    }
  };
  await centreOn(viewOf(50, DIMS.outer.a));
  await expect(canvas(page).locator('.aim')).toHaveCount(1);
  await page.keyboard.press('Enter');
  await centreOn(viewOf(50, DIMS.outer.b));
  await page.keyboard.press('Enter');
  await expect(field(page)).toBeFocused();
  await page.keyboard.type('640');
  await page.keyboard.press('Enter');
  await expect(page.getByRole('list', { name: c.list }).getByRole('listitem')).toHaveText([`${c.row(6400, 6400)}${c.remove}`]);
  await expect(canvas(page)).toBeFocused();
  await page.keyboard.press('Enter');
  await page.keyboard.press('Enter');
  await expect(field(page)).toBeFocused();
  await page.keyboard.press('Escape');
  await expect(field(page)).toHaveCount(0);
  await expect(page.getByRole('list', { name: c.list }).getByRole('listitem')).toHaveCount(1);
});

test('a new page and a new file start calibration afresh, without the warning', async ({ page }) => {
  await page.goto('/');
  await page.getByTestId('upload').setInputFiles({ name: 'plan.pdf', mimeType: 'application/pdf', buffer: Buffer.from(dimsPdf(50, 2)) });
  for (const next of ['page', 'file'] as const) {
    await page.getByRole('button', { name: copy.page(1), exact: true }).click();
    await expect(page.getByTestId('drawing').locator('canvas')).toHaveCount(2);
    await markMm(page, 50, DIMS.outer);
    await page.getByRole('button', { name: c.noMore }).click();
    await expect(warning(page)).toBeVisible();
    if (next === 'page') await page.getByRole('button', { name: copy.page(2), exact: true }).click();
    else await page.getByTestId('upload').setInputFiles({ name: 'plan.pdf', mimeType: 'application/pdf', buffer: Buffer.from(dimsPdf(50, 2)) });
    if (next === 'file') await page.getByRole('button', { name: copy.page(2), exact: true }).click();
    await expect(calibratePanel(page), next).toBeVisible();
    await expect(warning(page), next).toHaveCount(0);
    await expect(page.getByRole('list', { name: c.list }), next).toHaveCount(0);
  }
});

test('the hover mark sits exactly on the crossing of a tick before the click, also when the whole page is shown', async ({ page }) => {
  await open(page);
  const mark = canvas(page).locator('.ink .snap');
  const centre = () => mark.evaluate((r: SVGRectElement) => [r.x.baseVal.value + r.width.baseVal.value / 2, r.y.baseVal.value + r.height.baseVal.value / 2]);
  const [x, y] = viewOf(50, DIMS.roomA.a);
  for (const zoomed of [false, true]) {
    if (zoomed) {
      await page.mouse.move(...(await onScreen(page, [x, y])));
      for (let i = 0; i < 6; i++) await page.mouse.wheel(0, -100);
    } else expect(await viewBox(page)).toEqual([0, 0, 842, 595]);
    const [sx, sy] = await onScreen(page, [x, y]);
    await page.mouse.move(sx + 1, sy + 1); // across the tick, as a hand comes near
    await expect(mark).toHaveCount(1);
    expect(await mark.evaluate(element => element.tagName)).toBe('rect');
    await expect(canvas(page).locator('.halo .snap')).toHaveCount(1); // a paper-coloured outline under it, so it reads on a grey wall
    const [cx, cy] = await centre();
    expect(cx, String(zoomed)).toBeCloseTo(x, 4);
    expect(cy, String(zoomed)).toBeCloseTo(y, 4);
  }
  await page.mouse.move(2, 2); // off the drawing: no mark
  await expect(mark).toHaveCount(0);
});

test('at 1200 px the panel is beside the drawing, at 390 px under it, with no sideways scroll; the drawing is not mirrored', async ({ page }) => {
  for (const width of [1200, 390]) {
    await open(page, dimsPdf(), width, 800);
    const frame = (await page.locator('.frame').boundingBox())!;
    const panel = (await calibratePanel(page).boundingBox())!;
    if (width === 1200) expect(panel.x, 'beside').toBeGreaterThanOrEqual(frame.x + frame.width - 1);
    else expect(panel.y, 'under').toBeGreaterThan(frame.y + frame.height);
    expect(await page.evaluate(() => document.documentElement.scrollWidth - innerWidth), String(width)).toBe(0);
    const [left] = await onScreen(page, viewOf(50, DIMS.outer.a));
    const [right] = await onScreen(page, viewOf(50, DIMS.outer.b));
    expect(left, String(width)).toBeLessThan(right);
  }
});

test('the plaster answer changes the sentence next to the measurement and not the number', async ({ page }) => {
  await open(page);
  await expect(page.getByRole('group', { name: c.plasterQuestion }).getByRole('button', { pressed: true })).toHaveCount(0);
  for (const mark of [DIMS.outer, DIMS.heightA, DIMS.roomB]) await markMm(page, 50, mark);
  await page.getByRole('button', { name: c.plaster.none, exact: true }).click();
  await page.getByRole('button', { name: c.go(50) }).click();
  expect(await measureMm(page, 50, [200, 2500], [3200, 2500])).toContain(m.result('300'));
  await expect(measurePanel(page)).toContainText(copy.plasterSentence.none);
  await page.getByRole('button', { name: m.again }).click();
  await page.getByRole('button', { name: c.plaster.inWall, exact: true }).click();
  await page.getByRole('button', { name: c.go(50) }).click();
  expect(await measureMm(page, 50, [200, 2500], [3200, 2500])).toContain(m.result('300'));
  await expect(measurePanel(page)).toContainText(copy.plasterSentence.inWall);
});

test('marking at whole-page size without zooming, on the exact marks, verifies at 1:50', async ({ page }) => {
  await open(page);
  for (const mark of [DIMS.outer, DIMS.heightA, DIMS.roomB]) {
    expect(await viewBox(page)).toEqual([0, 0, 842, 595]);
    await clickMm(page, 50, mark.a, false);
    await clickMm(page, 50, mark.b, false);
    await field(page).fill(mark.text);
    await field(page).press('Enter');
  }
  await expect(fitBox(page)).toHaveText(c.ok(50) + c.go(50));
});

test('the preview always shows what a click takes: after the wheel, a zoom button and an arrow key, without a pointer move', async ({ page }) => {
  await open(page);
  const preview = canvas(page).locator('.ink .snap');
  const placed = canvas(page).locator('.ink .dim rect').first();
  const centre = (shape: typeof preview) =>
    shape.evaluate((element: SVGGraphicsElement) => {
      const { x, y, width, height } = element.getBBox();
      return [x + width / 2, y + height / 2];
    });
  const [x, y] = await onScreen(page, viewOf(50, DIMS.roomA.a));
  await page.mouse.move(x + 5, y);
  expect(await preview.evaluate(element => element.tagName)).toBe('rect'); // an end or a crossing of the mark
  const changes: [string, () => Promise<unknown>][] = [
    ['wheel', async () => { for (let i = 0; i < 4; i++) await page.mouse.wheel(0, -100); }],
    ['zoom button', async () => { await page.getByRole('button', { name: copy.zoomIn }).focus(); await page.keyboard.press('Enter'); }],
    ['arrow key', async () => { await canvas(page).focus(); await page.keyboard.press('Shift+ArrowRight'); }],
  ];
  for (const [name, change] of changes) {
    const view = await viewBox(page);
    await change();
    await expect.poll(() => viewBox(page), name).not.toEqual(view);
    await expect.poll(() => centre(preview), name).not.toEqual([]);
    const shown = await centre(preview);
    await page.mouse.down();
    await page.mouse.up();
    const took = await centre(placed);
    expect(took[0], name).toBeCloseTo(shown[0], 3); // getBBox is single precision; a stale preview was 4 pt off
    expect(took[1], name).toBeCloseTo(shown[1], 3);
    await calibratePanel(page).getByRole('button', { name: c.cancel }).focus();
    await page.keyboard.press('Enter');
    await expect(placed, name).toHaveCount(0);
  }
});

test('Escape and both cancel buttons give the focus back to the drawing', async ({ page }) => {
  await open(page);
  const [x, y] = await onScreen(page, [400, 300]);
  await page.mouse.click(x, y);
  await calibratePanel(page).getByRole('button', { name: c.cancel }).click();
  await expect(canvas(page)).toBeFocused();
  for (const how of ['Escape', 'cancel'] as const) {
    await page.mouse.click(x, y);
    await page.mouse.click(x + 40, y);
    await expect(field(page)).toBeFocused();
    if (how === 'Escape') await page.keyboard.press('Escape');
    else await calibratePanel(page).getByRole('button', { name: c.cancel }).click();
    await expect(field(page), how).toHaveCount(0);
    await expect(canvas(page), how).toBeFocused();
  }
});

const rows = (page: Page) => page.getByRole('list', { name: c.list }).getByRole('listitem');

test("the owner's case: three drawn 2.5 cm larger and one 5.2 cm -> that one is marked; deleting it and marking a fitting one verifies", async ({ page }) => {
  await open(page);
  for (const [mark, typed] of [[DIMS.outer, '637.5'], [DIMS.heightA, '397.5'], [DIMS.roomB, '287.5'], [DIMS.roomA, '294.8']] as const) await markMm(page, 50, mark, typed);
  await expect(fitBox(page)).toHaveText(c.inconsistent);
  await expect(rows(page).nth(3)).toContainText(c.odd);
  await expect(rows(page).nth(3)).toContainText('⁦+5.2⁩');
  await expect(rows(page).nth(3)).toHaveClass('bad');
  for (const i of [0, 1, 2]) {
    await expect(rows(page).nth(i), String(i)).not.toContainText(c.odd);
    await expect(rows(page).nth(i), String(i)).toContainText('⁦+2.5⁩');
  }
  await page.getByRole('button', { name: c.removeLabel(4) }).click();
  await markMm(page, 50, DIMS.part120, '117.5');
  await expect(fitBox(page)).toHaveText(c.offset(50, 25) + c.go(50));
  await expect(page.getByText(c.odd)).toHaveCount(0);
});

test('two bad dimensions out of five: nothing is marked', async ({ page }) => {
  await open(page);
  for (const [mark, typed] of [[DIMS.outer, '637.5'], [DIMS.heightA, '397.5'], [DIMS.roomB, '287.5'], [DIMS.roomA, '294.8'], [DIMS.part120, '114']] as const) await markMm(page, 50, mark, typed);
  await expect(fitBox(page)).toHaveText(c.inconsistent);
  await expect(rows(page)).toHaveCount(5);
  await expect(page.getByText(c.odd)).toHaveCount(0);
  await expect(page.locator('li.bad')).toHaveCount(0);
});

test('every row shows drawn minus written, signed, before any scale is accepted too: +5.2, -1.0, 0.0', async ({ page }) => {
  await open(page);
  for (const [typed, shown] of [['294.8', '+5.2'], ['301', '-1.0'], ['300', '0.0']]) {
    await markMm(page, 50, DIMS.roomA, typed);
    await expect(fitBox(page), typed).toContainText(c.need.count);
    await expect(rows(page), typed).toHaveText([`${c.row(Number(typed) * 10, 3000)}${c.remove}`]);
    await expect(rows(page), typed).toContainText(`הפרש ⁦${shown}⁩`);
    await page.getByRole('button', { name: c.removeLabel(1) }).click();
  }
});

describeSamples('samples', () => {
  // Needs the points of Task 13's truth files; until they exist it is skipped.
  test.skip('S14 with 1:50 chosen is caught; the scale lands between 1:121 and 1:124', () => {});
});
