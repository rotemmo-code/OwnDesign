import { expect, type Locator, type Page, test } from '@playwright/test';
import { copy } from '../../src/copy';
import type { Opening, Project } from '../../src/model/types';
import { COLOR } from '../../src/theme';
import { boxProject } from '../fixtures/box';
import { canvas, clickMm, drawFive, drawOpening, e, FIVE, drawWall, message, onScreen, pick, start, tool, twoRooms, wallBoxes, watch } from './editorKit';
import { serveProbe } from './probe';

// Task 11c: the check before approval (its six steps), the "fixed" suggestions and the contractor's colours.
watch();

const tab = (page: Page, name: string) => page.getByRole('tab', { name, exact: true });
const openCheck = (page: Page) => tab(page, e.checkTab).click();
const step = (page: Page, name: string) => page.locator(`[data-step="${name}"]`);
const items = (page: Page, name: string) => step(page, name).locator('li');
const button = (where: Locator, name: string) => where.getByRole('button', { name, exact: true });
const progress = (page: Page) => page.getByTestId('progress');
const mamadRow = (page: Page) => page.getByTestId('mamad-row');
const opening = (page: Page) => page.locator('[data-opening]');
/** Both rooms of the fixture are the apartment's; the left is סלון, the right has no name. */
async function bothRooms(page: Page) {
  await twoRooms(page);
  const right = await pick(page, [4700, 2200], 'room-details');
  await right.getByLabel(e.inApartment).check();
}
const inside = async (page: Page, item: Locator) => {
  const [a, b] = [(await item.boundingBox())!, (await canvas(page).boundingBox())!];
  return a.x >= b.x && a.y >= b.y && a.x + a.width <= b.x + b.width && a.y + a.height <= b.y + b.height;
};

test('the check list shows six steps in order and counts confirmed items; the count is read when it changes', async ({ page }) => {
  await start(page);
  await twoRooms(page);
  await drawOpening(page, e.window, [1100, 100], [2300, 100]);
  await drawOpening(page, e.door, [3250, 1200], [3250, 2000]);
  await openCheck(page);
  await expect(page.locator('[data-step] h3')).toHaveText([e.steps.rooms, e.steps.mamad, e.steps.entry, e.steps.doors, e.steps.windows, e.steps.envelope]);
  await expect(progress(page)).toHaveAttribute('aria-live', 'polite');
  // the two openings drawn by hand arrive confirmed; the outer walls are open and the mamad not answered
  await expect(progress(page)).toHaveText(e.progress(2, 4));
  await button(items(page, 'envelope').first(), e.confirm).click();
  await expect(progress(page)).toHaveText(e.progress(3, 4));
  await button(step(page, 'mamad'), e.noMamad).click();
  await expect(progress(page)).toHaveText(e.progress(4, 4));
});

test('the two tabs are a tab pattern: arrow keys move between them, aria-selected follows, the panel is labelled by its tab', async ({ page }) => {
  await start(page);
  await drawFive(page, [0, 1, 2, 3]);
  const [details, check] = [tab(page, e.detailsTab), tab(page, e.checkTab)];
  await expect(details).toHaveAttribute('aria-selected', 'true');
  await expect(check).toHaveAttribute('aria-selected', 'false');
  await expect(check).toHaveAttribute('tabindex', '-1');
  await details.focus();
  await page.keyboard.press('ArrowLeft');
  await expect(check).toBeFocused();
  await expect(check).toHaveAttribute('aria-selected', 'true');
  await expect(page.getByRole('tabpanel')).toHaveAttribute('aria-labelledby', (await check.getAttribute('id'))!);
  await expect(step(page, 'rooms')).toBeVisible();
  await page.keyboard.press('ArrowRight');
  await expect(details).toBeFocused();
  await expect(details).toHaveAttribute('aria-selected', 'true');
  await page.keyboard.press('End');
  await expect(check).toBeFocused();
  await page.keyboard.press('Home');
  await expect(details).toBeFocused();
  // the tabs come before their panel, on the screen and for the keyboard (R15)
  const order = await page.evaluate(() => {
    const [t, p] = [document.querySelector('[role="tablist"].panel-tabs')!, document.querySelector('[role="tabpanel"]')!];
    return !!(t.compareDocumentPosition(p) & Node.DOCUMENT_POSITION_FOLLOWING) && t.getBoundingClientRect().bottom <= p.getBoundingClientRect().top;
  });
  expect(order).toBe(true);
});

test('every button of the check tab has the one font size, the one height and at least the common width (R6, R41)', async ({ page }) => {
  await start(page);
  await bothRooms(page);
  await drawOpening(page, e.window, [1100, 100], [2300, 100]);
  await drawOpening(page, e.door, [3250, 1200], [3250, 2000]);
  await openCheck(page);
  await button(items(page, 'windows').first(), e.fix).click(); // a row with אישור too
  const sizes = await page.locator('button:visible').evaluateAll(list =>
    list.map(b => ({ text: b.textContent, font: getComputedStyle(b).fontSize, height: Math.round(b.getBoundingClientRect().height), width: b.getBoundingClientRect().width, clipped: b.scrollWidth > b.clientWidth + 1 })),
  );
  expect(sizes.length).toBeGreaterThan(10);
  expect(new Set(sizes.map(s => `${s.font} ${s.height}`))).toEqual(new Set([`${sizes[0].font} ${sizes[0].height}`]));
  for (const s of sizes) {
    expect(s.width, String(s.text)).toBeGreaterThanOrEqual(72 - 0.5); // 4.5rem
    expect(s.clipped, String(s.text)).toBe(false);
  }
});

test('rooms step: ticking a room marks it as the apartment\'s; with the outer walls locked an untick is refused with the note', async ({ page }) => {
  await start(page);
  await twoRooms(page);
  await openCheck(page);
  await expect(step(page, 'rooms')).toContainText(e.roomsHow);
  const right = step(page, 'rooms').getByRole('checkbox', { name: new RegExp(`^${e.unnamed}`) });
  await expect(right).toBeChecked(); // a part of the apartment's room, split off
  await right.uncheck();
  await expect(right).not.toBeChecked();
  await tab(page, e.detailsTab).click();
  const details = await pick(page, [4700, 2200], 'room-details');
  await expect(details.getByLabel(e.inApartment)).not.toBeChecked();
  await openCheck(page);
  await right.check();
  await expect(right).toBeChecked();
  await button(items(page, 'envelope').first(), e.confirm).click();
  await right.click(); // an untick: refused
  await expect(message(page)).toHaveText(copy.reason['envelope-locked']!);
  await expect(right).toBeChecked();
});

test('mamad step: a room or אין ממ"ד, and the answer is shown; while one is marked another choice is refused; after תיקון the next choice is the answer (R39)', async ({ page }) => {
  await start(page);
  await twoRooms(page);
  await openCheck(page);
  const mamad = step(page, 'mamad');
  const choice = (name: string | RegExp) => mamad.getByRole('group').getByRole('button', { name });
  await choice(new RegExp(`^${e.unnamed}`)).click();
  await expect(page.getByTestId('mamad-answer')).toHaveText(e.mamadIs(e.unnamed));
  await expect(choice(new RegExp(`^${e.unnamed}`))).toHaveAttribute('aria-pressed', 'true');
  await expect(progress(page)).toHaveText(e.progress(1, 2));
  for (const other of [/^סלון/, e.noMamad]) {
    await choice(other).click();
    await expect(message(page)).toHaveText(e.mamadTaken);
    await expect(page.getByTestId('mamad-answer')).toHaveText(e.mamadIs(e.unnamed));
  }
  await button(mamad, e.fix).click();
  await expect(mamadRow(page)).toContainText(e.mamadOpen(e.unnamed));
  await choice(e.noMamad).click();
  await expect(page.getByTestId('mamad-answer')).toHaveText(e.noMamad);
  await expect(choice(e.noMamad)).toHaveAttribute('aria-pressed', 'true');
  await expect(mamadRow(page)).toHaveCount(0); // an answer, not a release
  await choice(/^סלון/).click(); // אין ממ"ד locks nothing
  await expect(page.getByTestId('mamad-answer')).toHaveText(e.mamadIs('סלון'));
});

test('the release row names the room by its name now, after a rename while unmarked (R46)', async ({ page }) => {
  await start(page);
  await twoRooms(page);
  await openCheck(page);
  await step(page, 'mamad').getByRole('group').getByRole('button', { name: new RegExp(`^${e.unnamed}`) }).click();
  await button(step(page, 'mamad'), e.fix).click();
  await tab(page, e.detailsTab).click();
  const right = await pick(page, [4700, 2200], 'room-details');
  await right.getByLabel(e.roomName).fill('חדר שינה');
  await right.getByLabel(e.roomName).press('Enter');
  await expect(mamadRow(page)).toContainText(e.mamadOpen('חדר שינה'));
});

test('הצגה selects the item and brings it into view; the zoom follows; a half-drawn wall survives; איפוס תצוגה gives the whole page (R42)', async ({ page }) => {
  await start(page);
  await twoRooms(page);
  await drawOpening(page, e.door, [3250, 1200], [3250, 2000]);
  await tool(page, e.wall);
  await page.getByLabel(e.thickness).fill('10');
  await clickMm(page, [1000, 3000]); // the first end of a wall
  await page.getByRole('button', { name: copy.fit }).click();
  await expect(page.getByTestId('zoom')).toHaveText(`${e.zoom} 100%`);
  await openCheck(page);
  await button(items(page, 'doors').first(), e.show).click();
  await expect(page.locator('.selected-opening')).toHaveCount(1);
  await expect(page.getByTestId('zoom')).not.toHaveText(`${e.zoom} 100%`);
  expect(await inside(page, opening(page).first())).toBe(true);
  await clickMm(page, [2000, 3000]); // the second end: the wall begun before הצגה is drawn
  expect(await wallBoxes(page)).toHaveLength(6);
  await page.getByRole('button', { name: copy.fit }).click();
  await expect(canvas(page)).toHaveAttribute('viewBox', '0 0 842 595');
  await expect(page.getByTestId('zoom')).toHaveText(`${e.zoom} 100%`);
});

test('released items are drawn dashed and listed unconfirmed; אישור confirms one, אישור הכול all of a step', async ({ page }) => {
  await start(page);
  await twoRooms(page);
  for (const [a, b] of [[1100, 2300], [3600, 4400], [5000, 5800]]) await drawOpening(page, e.window, [a, 100], [b, 100]);
  await openCheck(page);
  const windows = items(page, 'windows');
  await expect(windows).toHaveCount(3);
  await expect(windows.nth(0)).toContainText(e.item(e.openingKinds.window, 1, '120'));
  for (let i = 0; i < 3; i++) {
    await expect(windows.nth(i).getByTestId('status')).toHaveText(e.confirmed);
    await expect(button(windows.nth(i), e.confirm)).toHaveCount(0); // locked and confirmed: only תיקון
    await expect(button(windows.nth(i), e.fix)).toHaveCount(1);
  }
  await expect(button(step(page, 'windows'), e.confirmAll)).toHaveCount(0);
  await button(windows.nth(1), e.fix).click();
  await button(windows.nth(2), e.fix).click();
  await expect(windows.nth(1).getByTestId('status')).toHaveText(e.notConfirmed);
  await expect(opening(page).nth(1)).toHaveAttribute('data-dashed', 'true');
  await expect(opening(page).nth(0)).toHaveAttribute('data-dashed', 'false');
  await button(windows.nth(1), e.confirm).click();
  await expect(windows.nth(1).getByTestId('status')).toHaveText(e.confirmed);
  await expect(opening(page).nth(1)).toHaveAttribute('data-dashed', 'false');
  await button(windows.nth(1), e.fix).click();
  await button(step(page, 'windows'), e.confirmAll).click();
  for (let i = 0; i < 3; i++) await expect(windows.nth(i).getByTestId('status')).toHaveText(e.confirmed);
  await expect(opening(page).filter({ has: page.locator('[stroke-dasharray]') })).toHaveCount(0);
  await expect(button(step(page, 'windows'), e.confirmAll)).toHaveCount(0);
});

test('מחיקה in the list deletes an inner door; a locked window asks for תיקון first; a door on the mamad gives its own instruction', async ({ page }) => {
  await start(page);
  await twoRooms(page);
  await drawOpening(page, e.window, [1100, 100], [2300, 100]);
  await drawOpening(page, e.door, [3250, 1200], [3250, 2000]);
  await openCheck(page);
  await button(items(page, 'doors').first(), e.remove).click();
  await expect(items(page, 'doors')).toHaveCount(0);
  await expect(opening(page)).toHaveCount(1);
  await button(items(page, 'windows').first(), e.remove).click();
  await expect(message(page)).toHaveText(copy.reason['window-locked']!);
  await expect(items(page, 'windows')).toHaveCount(1);
  await button(items(page, 'windows').first(), e.fix).click();
  await button(items(page, 'windows').first(), e.remove).click();
  await expect(items(page, 'windows')).toHaveCount(0);
  // a door on a wall of the mamad: locked, with the opening's own תיקון (R35)
  await step(page, 'mamad').getByRole('group').getByRole('button', { name: new RegExp(`^${e.unnamed}`) }).click();
  await drawOpening(page, e.door, [3250, 1200], [3250, 2000]);
  await button(items(page, 'doors').first(), e.remove).click();
  await expect(message(page)).toHaveText(e.mamadOpeningLocked);
  await expect(items(page, 'doors')).toHaveCount(1);
  await expect(button(items(page, 'doors').first(), e.fix)).toHaveCount(1);
});

test('a step with nothing drawn says so, and the entry door\'s says how to draw it', async ({ page }) => {
  await start(page);
  await drawFive(page, [0, 1, 2, 3]);
  await openCheck(page);
  await expect(step(page, 'entry')).toContainText(e.noEntry);
  await expect(step(page, 'doors')).toContainText(e.noDoors);
  await expect(step(page, 'windows')).toContainText(e.noWindows);
  await expect(step(page, 'rooms')).toContainText(e.roomsHow);
});

test('outer walls step highlights the outer walls and אישור locks them; then a locked wall\'s end does not move (R40, R31)', async ({ page }) => {
  await start(page);
  await drawFive(page, [0, 1, 2, 3]);
  const room = await pick(page, [1700, 2200], 'room-details');
  await room.getByLabel(e.inApartment).check();
  await expect(page.locator('[data-highlight]')).toHaveCount(0);
  await openCheck(page);
  await expect(page.locator('[data-highlight]')).toHaveCount(4);
  await expect(step(page, 'envelope')).toContainText(e.outerHow);
  const outer = items(page, 'envelope').first();
  await expect(outer).toContainText(e.allOuter);
  await expect(outer.getByTestId('status')).toHaveText(e.notConfirmed);
  await expect(button(outer, e.fix)).toHaveCount(0); // open: nothing to release
  await button(outer, e.confirm).click();
  await expect(outer.getByTestId('status')).toHaveText(e.confirmed);
  await expect(button(outer, e.confirm)).toHaveCount(0);
  await expect(button(outer, e.fix)).toHaveCount(1);
  await expect(page.getByText(e.envelopeOpen)).toHaveCount(0);
  await tab(page, e.detailsTab).click();
  await expect(page.locator('[data-highlight]')).toHaveCount(0);
  const before = await wallBoxes(page);
  await pick(page, [6300, 3000], 'wall-details');
  await clickMm(page, [6300, 4200]);
  await expect(message(page)).toHaveText(copy.reason['envelope-locked']!);
  expect(await wallBoxes(page)).toEqual(before);
  // its תיקון in the list opens them again
  await openCheck(page);
  await button(outer, e.fix).click();
  await expect(outer.getByTestId('status')).toHaveText(e.notConfirmed);
});

test('a suggestion: הצעה: קבוע with קבלת ההצעה on the window wall; קבלת כל ההצעות sets the outer walls fixed', async ({ page }) => {
  await start(page);
  await bothRooms(page);
  await drawOpening(page, e.window, [3250, 2600], [3250, 3400]); // a window in the partition
  const part = await pick(page, [3250, 1600], 'wall-details');
  await expect(part).toContainText(e.suggest);
  const legend = page.getByRole('region', { name: e.legend });
  await expect(legend).toContainText(e.suggestWhy);
  await expect(button(legend, e.acceptAll(5))).toBeVisible();
  await button(part, e.acceptOne).click();
  await expect(part.getByRole('button', { name: e.classes.fixed })).toHaveAttribute('aria-pressed', 'true');
  await expect(part).not.toContainText(e.suggest);
  await button(legend, e.acceptAll(4)).click();
  for (const at of [[3000, 100], [6300, 3000], [3000, 4300], [100, 3000]] as [number, number][]) {
    const w = await pick(page, at, 'wall-details');
    await expect(w.getByRole('button', { name: e.classes.fixed })).toHaveAttribute('aria-pressed', 'true');
    await expect(w).not.toContainText(e.suggest);
  }
  await expect(legend.getByRole('button', { name: /קבלת כל ההצעות/ })).toHaveCount(0);
});

test('a locked opening\'s legend swatch takes the colours of the walls it is on: on the mamad alone, the mamad colour (R46)', async ({ page }) => {
  await start(page);
  await twoRooms(page);
  const right = await pick(page, [4700, 2200], 'room-details');
  await right.getByLabel(e.isMamad).check();
  await drawOpening(page, e.door, [3250, 1200], [3250, 2000]);
  const swatch = page.locator('.legend [data-paint="opening-locked"] path');
  await expect(swatch).toHaveCount(1);
  await expect(swatch).toHaveAttribute('stroke', COLOR.mamad);
  await drawOpening(page, e.window, [100, 1000], [100, 2000]); // on the left wall, which bounds no mamad (the top one does)
  await expect.poll(() => swatch.evaluateAll(list => list.map(p => p.getAttribute('stroke')))).toEqual([COLOR.exterior, COLOR.mamad]);
});

test('the opening tool: a first click on no wall says so in words of its own, not the step\'s (R46)', async ({ page }) => {
  await start(page);
  await tool(page, e.wall);
  await drawWall(page, FIVE[4]);
  await tool(page, e.door);
  await clickMm(page, [1700, 2200]);
  await expect(message(page)).toHaveText(e.noWall);
  await expect(page.getByTestId('step')).toHaveText(e.openingFirst);
});

test('קבלת כל ההצעות is one step of the history: one ביטול פעולה and no wall is קבוע, one ביצוע שוב and all are (R47)', async ({ page }) => {
  await start(page);
  await bothRooms(page);
  await drawOpening(page, e.window, [3250, 2600], [3250, 3400]);
  const legend = page.getByRole('region', { name: e.legend });
  await button(legend, e.acceptAll(5)).click();
  await expect(legend.getByRole('button', { name: /קבלת כל ההצעות/ })).toHaveCount(0);
  const walls: [number, number][] = [[3000, 100], [6300, 3000], [3000, 4300], [100, 3000], [3250, 1600]];
  const classes = async () => {
    const out: string[] = [];
    for (const at of walls) {
      const w = await pick(page, at, 'wall-details');
      out.push((await w.getByRole('group', { name: e.classLabel }).getByRole('button', { pressed: true }).textContent()) ?? '');
    }
    return out;
  };
  await page.getByRole('button', { name: e.undo }).click();
  expect(await classes()).toEqual(Array(5).fill(e.classes.unknown));
  await page.getByRole('button', { name: e.redo }).click();
  expect(await classes()).toEqual(Array(5).fill(e.classes.fixed));
});

// ---- drafts, which drawing by hand cannot make: through the probe ----

function draft(): Project {
  const p = boxProject();
  const s = p.existing;
  const set = (id: string, o: Partial<Opening>) => s.openings.find(x => x.id === id) && Object.assign(s.openings.find(x => x.id === id)!, o);
  set('door', { confirmed: false, review: true });
  set('window', { confirmed: true, review: true }); // locked, confirmed, for review: אישור הכול must leave it alone
  set('entry', { confirmed: false });
  s.openings.push({ ...s.openings.find(x => x.id === 'window')!, id: 'window-2', offset: 3600, width: 1000, confirmed: false, review: false });
  s.walls.find(w => w.id === 'part')!.review = true;
  delete p.envelope; // as a draft arrives: locked and not confirmed
  return p;
}
async function mount(page: Page, project: Project, colours: { hex: string; uses: number }[] = []) {
  await page.setViewportSize({ width: 1440, height: 900 });
  await serveProbe(page);
  await page.evaluate(async ([p, c]) => (await import(/* @vite-ignore */ '/probe.js' as string)).mount(p, c), [project, colours] as const);
  await expect(page.locator('[data-wall]')).toHaveCount(project.existing.walls.length);
}

test('unconfirmed and review items from a draft are listed, drawn dashed with their marker; נבדק clears the marker; אישור הכול leaves a locked, confirmed item alone', async ({ page }) => {
  const project = draft();
  await mount(page, project);
  await openCheck(page);
  const [door, entry] = [items(page, 'doors').first(), items(page, 'entry').first()];
  await expect(door.getByTestId('status')).toHaveText(e.notConfirmed);
  await expect(door).toContainText(e.review);
  await expect(entry.getByTestId('status')).toHaveText(e.notConfirmed);
  await expect(page.locator('[data-opening="door"]')).toHaveAttribute('data-dashed', 'true');
  await expect(page.locator('[data-opening="window"]')).toHaveAttribute('data-dashed', 'true'); // for review
  await expect(page.locator('[data-review="part"]')).toHaveCount(1);
  await button(door, e.reviewed).click();
  await expect(door).not.toContainText(e.review);
  await expect(door.getByTestId('status')).toHaveText(e.notConfirmed);
  const windows = items(page, 'windows');
  await expect(windows.nth(0)).toContainText(e.review);
  await expect(button(windows.nth(0), e.confirm)).toHaveCount(0);
  await expect(windows.nth(1).getByTestId('status')).toHaveText(e.notConfirmed);
  await button(step(page, 'windows'), e.confirmAll).click();
  await expect(windows.nth(1).getByTestId('status')).toHaveText(e.confirmed);
  await expect(windows.nth(0)).toContainText(e.review); // not touched
  // נבדק on the locked window takes its word away and nothing else: it stays confirmed and locked
  await button(windows.nth(0), e.reviewed).click();
  await expect(windows.nth(0)).not.toContainText(e.review);
  await expect(windows.nth(0).getByTestId('status')).toHaveText(e.confirmed);
  await expect(button(windows.nth(0), e.fix)).toHaveCount(1);
  await expect(page.locator('[data-opening="window"]')).toHaveAttribute('data-locked', 'true');
  // the outer walls of a draft are locked and not confirmed
  const outer = items(page, 'envelope').first();
  await expect(outer.getByTestId('status')).toHaveText(e.notConfirmed);
  await expect(button(outer, e.fix)).toHaveCount(1);
  // a wall for review: its word and נבדק in its panel
  await tab(page, e.detailsTab).click();
  await page.getByRole('group', { name: e.tools }).getByRole('button', { name: e.select, exact: true }).click();
  const k = project.calibration.mmPerPt;
  await page.mouse.click(...(await onScreen(page, [3250 / k, 3000 / k])));
  const part = page.getByTestId('wall-details');
  await expect(part).toContainText(e.review);
  await button(part, e.reviewed).click();
  await expect(part).not.toContainText(e.review);
  await expect(page.locator('[data-review="part"]')).toHaveCount(0);
});

test('the contractor\'s colours are listed with their swatch; a typed meaning is kept and undone', async ({ page }) => {
  const project = { ...boxProject(), envelope: 'released' as const, sourceColors: [{ hex: '#c2327f', label: '' }, { hex: '#00aa00', label: 'בטון' }] };
  await mount(page, project, [{ hex: '#c2327f', uses: 5 }, { hex: '#00aa00', uses: 2 }]);
  const colours = page.locator('.legend details');
  await expect(colours.locator('summary')).toHaveText(e.colours);
  await colours.locator('summary').click();
  await expect(colours.locator('li')).toHaveCount(2);
  await expect(colours.locator('li').nth(0).locator('rect')).toHaveAttribute('fill', '#c2327f');
  const field = colours.getByLabel(e.colourMeans('#c2327f'));
  await expect(field).toHaveAttribute('placeholder', e.colourExample);
  await expect(colours.getByLabel(e.colourMeans('#00aa00'))).toHaveValue('בטון');
  await field.fill('טיח');
  await field.press('Enter');
  await expect(field).toHaveValue('טיח');
  await page.getByTestId('probe-undo').click();
  await expect(field).toHaveValue('');
  await page.getByTestId('probe-redo').click();
  await expect(field).toHaveValue('טיח');
});

test('a colour meaning with markup stays text; a colour that is not #rrggbb gets no swatch and no field', async ({ page }) => {
  const project = { ...boxProject(), envelope: 'released' as const, sourceColors: [{ hex: '#c2327f', label: '' }] };
  await mount(page, project, [{ hex: '#c2327f', uses: 5 }, { hex: 'url(#x)', uses: 2 }, { hex: '#C2327F', uses: 1 }]);
  const colours = page.locator('.legend details');
  await colours.locator('summary').click();
  await expect(colours.locator('li')).toHaveCount(3);
  for (const bad of [1, 2]) {
    await expect(colours.locator('li').nth(bad).locator('rect')).toHaveCount(0);
    await expect(colours.locator('li').nth(bad).locator('input')).toHaveCount(0);
  }
  await expect(colours.locator('li').nth(1)).toContainText('url(#x)');
  const markup = '<img src=x onerror="window.pwned=1"><b>טיח</b>';
  const field = colours.getByLabel(e.colourMeans('#c2327f'));
  await field.fill(markup);
  await field.press('Enter');
  await expect(field).toHaveValue(markup);
  await expect(page.locator('.legend img, .legend b')).toHaveCount(0);
  expect(await page.evaluate(() => (window as unknown as { pwned?: number }).pwned)).toBeUndefined();
});
