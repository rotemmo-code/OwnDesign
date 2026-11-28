import { expect, type Page, test } from '@playwright/test';
import { copy } from '../../src/copy';
import { COLOR } from '../../src/theme';
import { viewOf } from '../fixtures/dims';
import { canvas, clickMm, drawFive, drawOpening, drawWall, e, FIVE, hoverMm, K, message, O, onScreen, pick, start, tool, twoRooms, wallBoxes, watch } from './editorKit';

// Task 11b: openings, separators, splitting, moves of wall ends and opening edges, finishes and net areas.
watch();

const opening = (page: Page) => page.locator('[data-opening]');
const step = (page: Page) => page.getByTestId('step');
const label = (page: Page, name: string) => page.locator('[data-room]').filter({ hasText: name });
/** The four outer walls and the room they close, marked as the apartment's; the outer walls stay open. */
async function oneRoom(page: Page) {
  await drawFive(page, [0, 1, 2, 3]);
  const r = await pick(page, [1700, 2200], 'room-details');
  await r.getByLabel(e.inApartment).check();
}
/** One wall's box, its end where a free click put it: within 3 mm, a screen pixel when zoomed in (Firefox clicks on whole pixels). */
const expectBox = (boxes: number[][], want: number[]) => {
  expect(boxes).toHaveLength(1);
  boxes[0].forEach((v, i) => expect(Math.abs(v - want[i]), String(i)).toBeLessThan(3));
};
const lockOf = (page: Page) => page.getByTestId('opening-details').getByTestId('lock');
const widthField = (page: Page) => page.getByTestId('opening-details').getByLabel(e.widthField);

test('the tool row holds every tool, in one size, before the drawing', async ({ page }) => {
  await start(page);
  const names = [e.select, e.wall, e.door, e.window, e.passage, e.separator, e.splitTool, e.remove, copy.measure.title];
  const row = page.getByRole('group', { name: e.tools });
  await expect(row.getByRole('button')).toHaveText(names);
  const sizes = await page.locator('button:visible').evaluateAll(list => list.map(b => `${getComputedStyle(b).fontSize} ${Math.round(b.getBoundingClientRect().height)}`));
  expect(new Set(sizes)).toEqual(new Set([sizes[0]]));
  expect(await row.evaluate((g, svg) => !!(g.compareDocumentPosition(svg!) & Node.DOCUMENT_POSITION_FOLLOWING), await canvas(page).elementHandle())).toBe(true);
});

test('an opening by two clicks on the wall, the kind chosen first; its width can be typed', async ({ page }) => {
  await start(page);
  await drawFive(page);
  await drawOpening(page, e.window, [1100, 100], [2300, 100]);
  await expect(opening(page)).toHaveAttribute('data-kind', 'window');
  const win = await pick(page, [1700, 100], 'opening-details');
  await expect(win.getByRole('heading')).toHaveText(e.openingKinds.window);
  await expect(widthField(page)).toHaveValue('120');
  await drawOpening(page, e.door, [3250, 1200], [3250, 2000]);
  await pick(page, [3250, 1600], 'opening-details');
  await expect(widthField(page)).toHaveValue('80');
  await widthField(page).fill('90');
  await widthField(page).press('Enter');
  await expect(widthField(page)).toHaveValue('90');
  await expect(message(page)).toHaveText('');
});

test('a door of the default 80 cm by one click and Enter', async ({ page }) => {
  await start(page);
  await drawFive(page);
  await tool(page, e.door);
  await clickMm(page, [3250, 1200]);
  await expect(step(page)).toHaveText(e.openingSecond);
  await page.getByLabel(e.widthField).press('Enter');
  await pick(page, [3250, 1600], 'opening-details');
  await expect(widthField(page)).toHaveValue('80');
});

test('the second click on another wall is refused with a note; the first stays', async ({ page }) => {
  await start(page);
  await drawFive(page);
  await tool(page, e.door);
  await clickMm(page, [3250, 1200]);
  await clickMm(page, [1500, 100]);
  await expect(message(page)).toHaveText(e.otherWall);
  await expect(opening(page)).toHaveCount(0);
  await clickMm(page, [3250, 2000]);
  await expect(opening(page)).toHaveCount(1);
});

test('the opening tool: a first click on no wall says what to do; a first click on a wall undo took away counts for nothing', async ({ page }) => {
  await start(page);
  await tool(page, e.wall);
  await drawWall(page, FIVE[4]);
  await tool(page, e.door);
  await clickMm(page, [1700, 2200]);
  await expect(message(page)).toHaveText(e.noWall);
  await clickMm(page, [3250, 1200]);
  await expect(step(page)).toHaveText(e.openingSecond);
  await page.keyboard.press('Control+z');
  expect(await wallBoxes(page)).toEqual([]);
  await expect(step(page)).toHaveText(e.openingFirst);
  await page.getByLabel(e.widthField).press('Enter');
  await expect(opening(page)).toHaveCount(0);
});

test('a window and an entry door are locked as soon as they are drawn: a change is refused; תיקון, a new width, אישור', async ({ page }) => {
  await start(page);
  await drawFive(page);
  await drawOpening(page, e.window, [1100, 100], [2300, 100]);
  await pick(page, [1700, 100], 'opening-details');
  await expect(lockOf(page)).toContainText(e.windowLocked);
  await widthField(page).fill('100');
  await widthField(page).press('Enter');
  await expect(message(page)).toHaveText(copy.reason['window-locked']!);
  await expect(message(page)).toHaveAttribute('aria-live', 'polite');
  await expect(widthField(page)).toHaveValue('120');
  await lockOf(page).getByRole('button', { name: e.fix }).click();
  await expect(lockOf(page)).toContainText(e.openingOpen);
  await expect(opening(page)).toHaveAttribute('data-dashed', 'true');
  await widthField(page).fill('100');
  await widthField(page).press('Enter');
  await expect(widthField(page)).toHaveValue('100');
  await lockOf(page).getByRole('button', { name: e.confirm }).click();
  await expect(lockOf(page)).toContainText(e.windowLocked);
  await expect(opening(page)).toHaveAttribute('data-dashed', 'false');
  // an edge moved, or a delete, on the locked window: nothing changes and the note says why (R23)
  await clickMm(page, [1100, 100]);
  await expect(step(page)).toHaveText(e.moveEdge);
  await clickMm(page, [900, 100]);
  await expect(message(page)).toHaveText(copy.reason['window-locked']!);
  await page.keyboard.press('Escape');
  await expect(widthField(page)).toHaveValue('100');
  await tool(page, e.remove);
  await clickMm(page, [1700, 100]);
  await expect(message(page)).toHaveText(copy.reason['window-locked']!);
  await expect(opening(page)).toHaveCount(1);
  // a door turned into the entry door locks at once; turning it back needs תיקון
  await drawOpening(page, e.door, [4300, 4300], [5200, 4300]);
  const door = await pick(page, [4750, 4300], 'opening-details');
  await expect(door.getByTestId('lock')).toHaveText(e.free);
  await door.getByRole('button', { name: e.openingKinds.entry, exact: true }).click();
  await expect(door.getByTestId('lock')).toContainText(e.entryLocked);
  await door.getByRole('button', { name: e.openingKinds.door, exact: true }).click();
  await expect(message(page)).toHaveText(copy.reason['entry-door-locked']!);
  await expect(door.getByRole('heading')).toHaveText(e.openingKinds.entry);
  expect(await page.locator('body').innerText()).not.toContain('מוגן');
});

test('openings are painted by their lock: locked in their outer wall\'s colour or, on an inner wall, the fixed colour; free in the existing colour; the legend names each', async ({ page }) => {
  await start(page);
  await oneRoom(page);
  await tool(page, e.wall);
  await drawWall(page, FIVE[4]);
  await page.getByRole('button', { name: e.part(1, '12.00') }).click();
  const legend = page.getByRole('region', { name: e.legend });
  await drawOpening(page, e.window, [1100, 100], [2300, 100]); // locked, on an outer wall
  await expect(legend).not.toContainText(e.lockedInnerOpening);
  await drawOpening(page, e.door, [3800, 100], [4600, 100]); // free, on an outer wall
  await drawOpening(page, e.window, [3250, 2600], [3250, 3400]); // locked, on an inner wall (R32)
  const windows = page.locator('[data-opening][data-kind="window"]'); // in the order drawn
  await expect(page.locator('[data-opening][data-kind="door"] path').first()).toHaveAttribute('stroke', COLOR.existing);
  await expect(windows.nth(0).locator('path').first()).toHaveAttribute('stroke', COLOR.exterior);
  await expect(windows.nth(1).locator('path').first()).toHaveAttribute('stroke', COLOR.fixed);
  await expect(legend).toContainText(e.lockedOpening);
  await expect(legend).toContainText(e.lockedInnerOpening);
  await expect(legend).toContainText(e.freeOpening);
});

test('an inner door is free: its edge moved and its width typed without תיקון; one undo step each', async ({ page }) => {
  await start(page);
  await drawFive(page);
  await drawOpening(page, e.door, [3250, 1200], [3250, 2000]);
  await pick(page, [3250, 1600], 'opening-details');
  await clickMm(page, [3250, 1200]); // its first edge
  await expect(step(page)).toHaveText(e.moveEdge);
  await clickMm(page, [3250, 1100]); // no corner there: where the click was, to a screen pixel
  await expect.poll(async () => Math.abs(Number(await widthField(page).inputValue()) - 90)).toBeLessThan(0.5);
  await page.keyboard.press('Control+z');
  await expect(widthField(page)).toHaveValue('80');
  await page.keyboard.press('Control+y');
  await expect(widthField(page)).not.toHaveValue('80');
  await widthField(page).fill('85');
  await widthField(page).press('Enter');
  await expect(widthField(page)).toHaveValue('85');
});

test('two doors in one mamad opening are accepted, a third is refused', async ({ page }) => {
  await start(page);
  await twoRooms(page);
  const right = await pick(page, [4700, 2200], 'room-details');
  await right.getByLabel(e.isMamad).check();
  await drawOpening(page, e.door, [3250, 1200], [3250, 2000]);
  await drawOpening(page, e.door, [3250, 1200], [3250, 2000]);
  await expect(opening(page)).toHaveCount(2);
  await drawOpening(page, e.door, [3250, 1200], [3250, 2000]);
  await expect(message(page)).toHaveText(copy.reason['invalid-geometry']!);
  await expect(opening(page)).toHaveCount(2);
});

test('an opening on a mamad wall: an attempt shows the one instruction that works; תיקון, a new width, אישור (R35)', async ({ page }) => {
  await start(page);
  await twoRooms(page);
  const right = await pick(page, [4700, 2200], 'room-details');
  await right.getByLabel(e.isMamad).check();
  await drawOpening(page, e.door, [3250, 1200], [3250, 2000]);
  await pick(page, [3250, 1600], 'opening-details');
  await expect(lockOf(page)).toContainText(e.mamadOpeningLocked);
  await widthField(page).fill('70');
  await widthField(page).press('Enter');
  await expect(message(page)).toHaveText(e.mamadOpeningLocked);
  await expect(widthField(page)).toHaveValue('80');
  await tool(page, e.remove);
  await clickMm(page, [3250, 1600]);
  await expect(message(page)).toHaveText(e.mamadOpeningLocked);
  await expect(opening(page)).toHaveCount(1);
  await pick(page, [3250, 1600], 'opening-details');
  await lockOf(page).getByRole('button', { name: e.fix }).click();
  await expect(lockOf(page)).toContainText(e.openingOpen);
  await widthField(page).fill('70');
  await widthField(page).press('Enter');
  await expect(widthField(page)).toHaveValue('70');
  await lockOf(page).getByRole('button', { name: e.confirm }).click();
  await expect(lockOf(page)).toContainText(e.mamadOpeningLocked);
  await expect((await pick(page, [4700, 2200], 'room-details')).getByLabel(e.isMamad)).toBeChecked(); // the mark stays
});

test('a separator from face to face splits a room; deleting it merges back; a click with no face near is refused', async ({ page }) => {
  await start(page);
  await oneRoom(page);
  await tool(page, e.separator);
  await clickMm(page, [1700, 2200]);
  await expect(message(page)).toHaveText(e.noFace);
  await clickMm(page, [200, 2000]);
  await expect(step(page)).toHaveText(e.separatorSecond);
  await clickMm(page, [6200, 2000]);
  await expect(page.locator('[data-separator]')).toHaveCount(1);
  await expect(page.getByText(/התחלק\. איזה חלק ישמור על השם/)).toBeVisible();
  await expect(page.locator('[data-room]')).toHaveCount(2);
  await tool(page, e.remove);
  await clickMm(page, [3000, 2000]);
  await expect(page.locator('[data-separator]')).toHaveCount(0);
  await expect(page.getByText(/התאחדו לחלל אחד/)).toBeVisible();
  await expect(page.locator('[data-room]')).toHaveCount(1);
});

test('a separator inside the mamad is refused', async ({ page }) => {
  await start(page);
  await twoRooms(page);
  const right = await pick(page, [4700, 2200], 'room-details');
  await right.getByLabel(e.isMamad).check();
  await tool(page, e.separator);
  await clickMm(page, [3300, 3000]);
  await clickMm(page, [6200, 3000]);
  await expect(message(page)).toHaveText(copy.reason['mamad-locked']!);
  await expect(page.locator('[data-separator]')).toHaveCount(0);
});

test('the split tool cuts a wall in two; both parts keep its class and its material', async ({ page }) => {
  await start(page);
  await tool(page, e.wall);
  await page.getByLabel(e.material).selectOption({ label: e.materials.block });
  await drawWall(page, FIVE[0]);
  const w = await pick(page, [3000, 100], 'wall-details');
  await w.getByRole('button', { name: e.classes.fixed }).click();
  await tool(page, e.splitTool);
  await clickMm(page, [2000, 100]);
  const parts = (await wallBoxes(page)).sort((p, q) => p[0] - q[0]);
  expect(parts).toHaveLength(2);
  [[0, 0, 2000, 200], [2000, 0, 6400, 200]].forEach((want, i) => expectBox([parts[i]], want)); // cut where the click was
  for (const at of [[1000, 100], [4000, 100]] as [number, number][]) {
    const part = await pick(page, at, 'wall-details');
    await expect(part.getByRole('button', { name: e.classes.fixed })).toHaveAttribute('aria-pressed', 'true');
    await expect(part.getByLabel(e.material)).toHaveValue('block');
  }
});

test('picking up a wall end previews the move and the next click places it; Escape cancels; one undo returns it', async ({ page }) => {
  await start(page);
  await tool(page, e.wall);
  await drawWall(page, FIVE[4]);
  await pick(page, [3250, 3000], 'wall-details');
  await clickMm(page, [3250, 4200]);
  await expect(step(page)).toHaveText(e.moveEnd);
  await hoverMm(page, [3250, 3500]);
  await expect(page.getByTestId('wall-preview')).toBeVisible();
  await page.keyboard.press('Escape');
  await expect(page.getByTestId('wall-preview')).toHaveCount(0);
  expect(await wallBoxes(page)).toEqual([[3200, 200, 3300, 4200]]);
  await clickMm(page, [3250, 4200]);
  await clickMm(page, [3250, 3000]);
  expectBox(await wallBoxes(page), [3200, 200, 3300, 3000]);
  await page.keyboard.press('Control+z');
  expect(await wallBoxes(page)).toEqual([[3200, 200, 3300, 4200]]);
});

test('a half-done move survives איפוס תצוגה and a zoom', async ({ page }) => {
  await start(page);
  await tool(page, e.wall);
  await drawWall(page, FIVE[4]);
  await pick(page, [3250, 3000], 'wall-details');
  await clickMm(page, [3250, 4200]);
  await page.getByRole('button', { name: copy.fit }).click();
  await page.mouse.move(...(await onScreen(page, viewOf(50, [3250, 2000]))));
  await page.mouse.wheel(0, -100);
  await expect(step(page)).toHaveText(e.moveEnd);
  await clickMm(page, [3250, 3000]);
  expectBox(await wallBoxes(page), [3200, 200, 3300, 3000]);
});

test('typing 250 moves the selected wall end to 250 cm; a bad length changes nothing and says why', async ({ page }) => {
  await start(page);
  await tool(page, e.wall);
  await drawWall(page, FIVE[4]);
  await pick(page, [3250, 3000], 'wall-details');
  await clickMm(page, [3250, 4200]);
  const length = page.getByLabel(e.wallLength);
  for (const bad of ['', 'abc', '12,5', '-1', '1e9']) {
    await length.fill(bad);
    await length.press('Enter');
    await expect(message(page), bad).toHaveText(e.badLength);
  }
  expect(await wallBoxes(page)).toEqual([[3200, 200, 3300, 4200]]);
  await length.fill('250');
  await length.press('Enter');
  expect(await wallBoxes(page)).toEqual([[3200, 200, 3300, 2700]]);
});

test('typing a length on a wall beside rooms takes the longest room face: the end moves by the difference', async ({ page }) => {
  await start(page);
  await twoRooms(page);
  const before = await wallBoxes(page);
  await pick(page, [3000, 100], 'wall-details');
  await clickMm(page, [6400, 100]); // its end b; the faces shown are 300 and 290 cm
  await page.getByLabel(e.wallLength).fill('310');
  await page.getByLabel(e.wallLength).press('Enter');
  const after = await wallBoxes(page);
  expect(Math.abs(after[0][2] - before[0][2] - 100)).toBeLessThan(0.5);
  expect([after[0][0], after[0][1], after[0][3]]).toEqual([before[0][0], before[0][1], before[0][3]]);
});

test('a locked outer wall: its end is not moved by a click nor by a typed length, and the note says why; after תיקון it moves (R31)', async ({ page }) => {
  await start(page);
  await oneRoom(page);
  const before = await wallBoxes(page);
  const right = () => pick(page, [6300, 3000], 'wall-details');
  const fix = async () => (await right()).getByTestId('lock').getByRole('button', { name: e.fix }).click();
  await page.getByRole('button', { name: e.confirm }).click(); // the outer walls lock
  // a click on the end handle of the locked wall holds nothing
  await right();
  await expect(message(page)).toHaveText('');
  await clickMm(page, [6300, 4200]);
  await expect(message(page)).toHaveText(copy.reason['envelope-locked']!);
  await expect(message(page)).toHaveAttribute('aria-live', 'polite');
  await expect(page.getByLabel(e.wallLength)).toHaveCount(0);
  await clickMm(page, [6600, 4800]);
  expect(await wallBoxes(page)).toEqual(before);
  // an end held while the outer walls were open, then the outer walls confirmed: the typed length is refused
  await fix();
  await expect(message(page)).toHaveText('');
  await clickMm(page, [6300, 4200]);
  await expect(step(page)).toHaveText(e.moveEnd);
  await page.getByRole('button', { name: e.confirm }).click();
  await page.getByLabel(e.wallLength).fill('500');
  await page.getByLabel(e.wallLength).press('Enter');
  await expect(message(page)).toHaveText(copy.reason['envelope-locked']!);
  expect(await wallBoxes(page)).toEqual(before);
  // תיקון: it moves as any wall
  await fix();
  await clickMm(page, [6300, 4200]);
  await expect(step(page)).toHaveText(e.moveEnd);
  await clickMm(page, [6300, 4800]);
  expect(Math.abs((await wallBoxes(page))[3][3] - 4800)).toBeLessThan(3);
});

test('a wall that holds a locked window: a click one pixel off its line moves the end along the line; the window stays', async ({ page }) => {
  await start(page);
  await oneRoom(page); // the outer walls stay open
  await drawOpening(page, e.window, [1100, 100], [2300, 100]);
  const win = page.locator('[data-opening] path').first();
  const was = await win.getAttribute('d');
  const before = await wallBoxes(page);
  await pick(page, [3000, 100], 'wall-details');
  await clickMm(page, [6400, 100]);
  await expect(step(page)).toHaveText(e.moveEnd);
  await clickMm(page, [6800, 100], [0, 1]);
  await expect(message(page)).toHaveText('');
  const after = await wallBoxes(page);
  expect(Math.abs(after[0][2] - 6800)).toBeLessThan(3);
  expect([after[0][1], after[0][3]]).toEqual([before[0][1], before[0][3]]);
  await expect(win).toHaveAttribute('d', was!);
});

test('a free end moved one pixel off its axis stays on the axis, as in the wall tool (R33)', async ({ page }) => {
  await start(page);
  await tool(page, e.wall);
  await drawWall(page, FIVE[4]);
  await pick(page, [3250, 3000], 'wall-details');
  await clickMm(page, [3250, 200]);
  await expect(step(page)).toHaveText(e.moveEnd);
  await clickMm(page, [3250, -600], [1, 0]); // above the drawing: nothing to snap to
  const [box] = await wallBoxes(page);
  expect([box[0], box[2]]).toEqual([3200, 3300]);
  // where the click was, within one screen pixel (Firefox clicks on whole pixels; at this zoom a pixel is about 4 mm)
  const mmPerPx = await canvas(page).evaluate((svg: SVGSVGElement, k) => k / svg.getScreenCTM()!.a, K);
  expect(Math.abs(box[1] + 600)).toBeLessThanOrEqual(mmPerPx);
});

test('a finish of 2 cm on one side changes only that side\'s room and shows קיר and אחרי גימור', async ({ page }) => {
  await start(page);
  await twoRooms(page);
  const right = await pick(page, [4700, 2200], 'room-details');
  await right.getByLabel(e.inApartment).check();
  const w = await pick(page, [3250, 3000], 'wall-details');
  await w.getByLabel(e.finishSide('סלון')).fill('2');
  await w.getByLabel(e.finishSide('סלון')).press('Enter');
  const left = await pick(page, [1700, 2200], 'room-details');
  await expect(left.getByTestId('measurement').first()).toContainText(`${e.resultWall}: ${e.area('12.00')}`);
  await expect(left.getByTestId('measurement').first()).toContainText(`${e.resultNet}: ${e.area('11.92')}`);
  const other = await pick(page, [4700, 2200], 'room-details');
  await expect(other.getByTestId('measurement').first()).toHaveText(`${e.area('11.60')} ${copy.byDrawing}`);
});

test('exterior wall: finish inside accepted, outside field disabled with a reason', async ({ page }) => {
  await start(page);
  await oneRoom(page);
  const w = await pick(page, [100, 3000], 'wall-details');
  const outside = w.locator('label', { hasText: e.finishNoRoom });
  await expect(outside.locator('input')).toBeDisabled();
  await expect(outside).toContainText(copy.reason['finish-outer-side']!);
  const inside = w.getByLabel(e.finishSide(e.unnamed));
  await inside.fill('1.5');
  await inside.press('Enter');
  await expect(inside).toHaveValue('1.5');
  await expect(message(page)).toHaveText('');
});

test('a free wall end takes an end finish; a joined end and a free end outside the apartment are disabled, each with its reason', async ({ page }) => {
  await start(page);
  await drawFive(page, [0, 1, 2, 3]); // the room is not yet ticked as the apartment's
  await page.getByLabel(e.thickness).fill('10');
  await clickMm(page, [100, 2000]); // from the middle of the left wall
  await clickMm(page, [1500, 2000]); // to a free end in the room
  const w = await pick(page, [800, 2000], 'wall-details');
  const start_ = w.locator('label', { hasText: e.finishStart });
  const free = w.locator('label', { hasText: e.finishEnd });
  await expect(free.locator('input')).toBeDisabled();
  await expect(free).toContainText(e.endNoRoom);
  await expect(start_).toContainText(e.endJoined);
  const r = await pick(page, [2500, 3000], 'room-details');
  await r.getByLabel(e.inApartment).check();
  await pick(page, [800, 2000], 'wall-details');
  await expect(start_.locator('input')).toBeDisabled();
  await expect(start_).toContainText(e.endJoined);
  await expect(free).not.toContainText(e.endNoRoom);
  await expect(free).not.toContainText(e.endJoined);
  const end = w.getByLabel(e.finishEnd);
  await expect(end).toBeEnabled();
  await end.fill('1');
  await end.press('Enter');
  await expect(end).toHaveValue('1');
});

test('a finish kept where it no longer applies shows לא בשימוש and counts nothing', async ({ page }) => {
  await start(page);
  await twoRooms(page);
  const w = await pick(page, [3250, 3000], 'wall-details');
  await w.getByLabel(e.finishSide('סלון')).fill('2');
  await w.getByLabel(e.finishSide('סלון')).press('Enter');
  await expect(label(page, 'סלון')).toContainText('11.92');
  const left = await pick(page, [1700, 2200], 'room-details');
  await left.getByLabel(e.outdoor).check();
  await expect(label(page, 'סלון')).toContainText('12.00');
  const again = await pick(page, [3250, 3000], 'wall-details');
  await expect(again.locator('label', { hasText: e.notUsed }).locator('input')).toHaveValue('2');
});

test('a finish is a hatched strip in the finish colour, across a door too; nothing is drawn over a room\'s label', async ({ page }) => {
  await start(page);
  await twoRooms(page);
  await drawOpening(page, e.door, [3250, 1200], [3250, 2000]);
  const w = await pick(page, [3250, 3000], 'wall-details');
  await w.getByLabel(e.finishSide('סלון')).fill('2');
  await w.getByLabel(e.finishSide('סלון')).press('Enter');
  const strip = page.locator('[data-finish]');
  await expect(strip).toHaveCount(1);
  await expect(strip).toHaveAttribute('fill', /^url\(#hatch-finish/);
  await expect(strip).toHaveAttribute('stroke', COLOR.finish);
  const box = await strip.evaluate((p, o) => {
    const n = (p.getAttribute('d') ?? '').match(/-?\d+(\.\d+)?/g)!.map(Number);
    const ys = n.filter((_, i) => i % 2 === 1).map(y => y - o.y);
    return [Math.min(...ys), Math.max(...ys)];
  }, O);
  expect(box[0]).toBeLessThan(1200); // across the door's gap, 1200 to 2000
  expect(box[1]).toBeGreaterThan(2000);
  // R27: no shape painted after a label meets its box
  const over = await page.evaluate(() => {
    const svg = document.querySelector('[data-testid="canvas"]')!;
    const labels = [...svg.querySelectorAll('[data-room] text')];
    const shapes = [...svg.querySelectorAll('path, rect, circle, line, text, polygon')].filter(x => !x.closest('[data-room]'));
    const meet = (a: DOMRect, b: DOMRect) => a.left < b.right && b.left < a.right && a.top < b.bottom && b.top < a.bottom;
    return labels.flatMap(l => shapes.filter(x => l.compareDocumentPosition(x) & Node.DOCUMENT_POSITION_FOLLOWING && meet(l.getBoundingClientRect(), x.getBoundingClientRect())).map(x => x.tagName));
  });
  expect(over).toEqual([]);
  // R26: two sets of patterns, no id twice
  const ids = await page.locator('[id]').evaluateAll(list => list.map(x => x.id));
  expect(ids.length).toBe(new Set(ids).size);
});

test('areas are net with their statement; the switch shows gross; with no finish neither shows', async ({ page }) => {
  await start(page);
  await twoRooms(page);
  await expect(page.getByRole('group', { name: e.areas })).toHaveCount(0);
  const w = await pick(page, [3250, 3000], 'wall-details');
  await w.getByLabel(e.finishSide('סלון')).fill('2');
  await w.getByLabel(e.finishSide('סלון')).press('Enter');
  const areas = page.getByRole('group', { name: e.areas });
  await expect(areas.getByTestId('areas-statement')).toHaveText(e.net);
  await expect(label(page, 'סלון')).toContainText('11.92');
  await areas.getByRole('button', { name: e.grossButton }).click();
  await expect(areas.getByTestId('areas-statement')).toHaveText(e.gross);
  await expect(label(page, 'סלון')).toContainText('12.00');
});

test('a bad finish changes nothing and says why; an empty field takes the finish away', async ({ page }) => {
  await start(page);
  await twoRooms(page);
  const w = await pick(page, [3250, 3000], 'wall-details');
  const field = w.getByLabel(e.finishSide('סלון'));
  for (const bad of ['0', '20.1', 'abc', '1,5', '1e1']) {
    await field.fill(bad);
    await field.press('Enter');
    await expect(message(page), bad).toHaveText(e.badFinish);
    await expect(field).toHaveValue('');
  }
  await field.fill('2');
  await field.press('Enter');
  await expect(page.locator('[data-finish]')).toHaveCount(1);
  await field.fill('');
  await field.press('Enter');
  await expect(page.locator('[data-finish]')).toHaveCount(0);
});

test('the plaster-in-wall warning shows when a finish is added and the drawing includes plaster', async ({ page }) => {
  await start(page, 'inWall');
  await twoRooms(page);
  const w = await pick(page, [3250, 3000], 'wall-details');
  await w.getByLabel(e.finishSide('סלון')).fill('1');
  await w.getByLabel(e.finishSide('סלון')).press('Enter');
  await expect(message(page)).toHaveText(e.plasterInWall);
});

test('the opening, separator and split tools ask to zoom in when zoomed out', async ({ page }) => {
  await start(page);
  for (const name of [e.door, e.window, e.passage, e.separator, e.splitTool]) {
    await tool(page, name);
    await page.getByRole('button', { name: copy.fit }).click();
    await expect(page.getByTestId('zoom-hint'), name).toHaveText(e.zoomHint);
  }
});

test('the delete tool takes an opening and a separator too', async ({ page }) => {
  await start(page);
  await oneRoom(page);
  await drawOpening(page, e.passage, [3000, 4300], [3800, 4300]);
  await tool(page, e.separator);
  await clickMm(page, [200, 2000]);
  await clickMm(page, [6200, 2000]);
  await tool(page, e.remove);
  await clickMm(page, [3400, 4300]);
  await expect(opening(page)).toHaveCount(0);
  await clickMm(page, [3000, 2000]);
  await expect(page.locator('[data-separator]')).toHaveCount(0);
});
