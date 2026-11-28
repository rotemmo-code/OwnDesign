import { expect, test } from '@playwright/test';
import type { Project, Wall } from '../../src/model/types';
import { boxProject } from '../fixtures/box';
import { e, onScreen, watch } from './editorKit';
import { serveProbe } from './probe';

// A draft as large as detection may bring: 500 walls (owner R30: an edit may take seconds there; a frame may not).
watch();

const CELL = 650;
function large(): Project {
  const walls: Wall[] = [];
  const wall = (ax: number, ay: number, bx: number, by: number, thickness: number): Wall => ({
    id: `w${walls.length}`, a: { x: ax, y: ay }, b: { x: bx, y: by }, thickness, finishA: null, finishB: null, source: 'manual', review: false,
  });
  for (let i = 0; i <= 15; i++)
    for (let j = 0; j < 15; j++) {
      const t = i === 0 || i === 15 ? 200 : 100;
      walls.push(wall(500 + j * CELL, 500 + i * CELL, 500 + (j + 1) * CELL, 500 + i * CELL, t));
      walls.push(wall(500 + i * CELL, 500 + j * CELL, 500 + i * CELL, 500 + (j + 1) * CELL, t));
    }
  for (let i = 0; walls.length < 500; i++) walls.push(wall(500 + i * 600, 10200, 800 + i * 600, 10200, 100));
  const p = boxProject();
  return { ...p, envelope: 'released', existing: { walls, openings: [], separators: [], rooms: [] } };
}

test('500 walls: a preview frame stays under 50 ms', async ({ page }) => {
  test.setTimeout(240_000);
  await page.setViewportSize({ width: 1440, height: 900 });
  await serveProbe(page);
  const project = large();
  expect(project.existing.walls).toHaveLength(500);
  await page.evaluate(async p => (await import(/* @vite-ignore */ '/probe.js' as string)).mount(p), project);
  const k = project.calibration.mmPerPt;
  const at = async (mm: [number, number]) => onScreen(page, [mm[0] / k, mm[1] / k]);
  await page.getByRole('group', { name: e.tools }).getByRole('button', { name: e.select, exact: true }).click();
  await expect(page.locator('[data-wall]')).toHaveCount(500, { timeout: 60_000 });
  const middle = 500 + 7 * CELL;
  await page.mouse.click(...(await at([middle + CELL / 2, middle]))); // a wall in the middle of the grid
  await expect(page.getByTestId('wall-details')).toBeVisible({ timeout: 60_000 });
  await page.mouse.click(...(await at([middle + CELL, middle]))); // its end
  await expect(page.getByTestId('step')).toHaveText(e.moveEnd);
  const from = await at([middle + CELL, middle]);
  await page.evaluate(() => {
    const w = window as unknown as { frames_: number[] };
    w.frames_ = [];
    let last = performance.now();
    const loop = (t: number) => {
      w.frames_.push(t - last);
      last = t;
      if (w.frames_.length < 600) requestAnimationFrame(loop);
    };
    requestAnimationFrame(loop);
  });
  for (let i = 0; i < 60; i++) await page.mouse.move(from[0] + i, from[1] + i / 2);
  await expect(page.getByTestId('wall-preview')).toBeVisible();
  const frames: number[] = await page.evaluate(() => (window as unknown as { frames_: number[] }).frames_.slice(2));
  console.log(`500 walls: ${frames.length} frames, the slowest ${Math.max(...frames).toFixed(1)} ms`);
  expect(Math.max(...frames)).toBeLessThan(50);
});

test('500 walls: the walls are not drawn again while a held end moves (their memo holds)', async ({ page }) => {
  test.setTimeout(240_000);
  await page.setViewportSize({ width: 1440, height: 900 });
  await serveProbe(page);
  const project = large();
  await page.evaluate(async p => (await import(/* @vite-ignore */ '/probe.js' as string)).mount(p), project);
  const k = project.calibration.mmPerPt;
  const at = async (mm: [number, number]) => onScreen(page, [mm[0] / k, mm[1] / k]);
  await page.getByRole('group', { name: e.tools }).getByRole('button', { name: e.select, exact: true }).click();
  await expect(page.locator('[data-wall]')).toHaveCount(500, { timeout: 60_000 });
  const middle = 500 + 7 * CELL;
  await page.mouse.click(...(await at([middle + CELL / 2, middle])));
  await expect(page.getByTestId('wall-details')).toBeVisible({ timeout: 60_000 });
  await page.mouse.click(...(await at([middle + CELL, middle])));
  await expect(page.getByTestId('step')).toHaveText(e.moveEnd);
  const renders = () => page.evaluate(() => (globalThis as unknown as { wallRenders: number }).wallRenders);
  const before = await renders();
  expect(before).toBeGreaterThan(0);
  const from = await at([middle + CELL, middle]);
  for (let i = 0; i < 30; i++) await page.mouse.move(from[0] + i, from[1] + i / 2);
  await expect(page.getByTestId('wall-preview')).toBeVisible();
  expect(await renders()).toBe(before);
});

test('500 walls with the check tab open: the tab opens in time, a preview frame stays under 50 ms and the walls are not drawn again (R43)', async ({ page }) => {
  test.setTimeout(240_000);
  await page.setViewportSize({ width: 1440, height: 900 });
  await serveProbe(page);
  const project = large();
  await page.evaluate(async p => (await import(/* @vite-ignore */ '/probe.js' as string)).mount(p), project);
  const k = project.calibration.mmPerPt;
  const at = async (mm: [number, number]) => onScreen(page, [mm[0] / k, mm[1] / k]);
  await page.getByRole('group', { name: e.tools }).getByRole('button', { name: e.select, exact: true }).click();
  await expect(page.locator('[data-wall]')).toHaveCount(500, { timeout: 60_000 });
  const middle = 500 + 7 * CELL;
  await page.mouse.click(...(await at([middle + CELL / 2, middle])));
  await expect(page.getByTestId('wall-details')).toBeVisible({ timeout: 60_000 });
  await page.mouse.click(...(await at([middle + CELL, middle])));
  await expect(page.getByTestId('step')).toHaveText(e.moveEnd);
  // the time from the click on the tab to its list on the screen
  const opened = await page.evaluate(async name => {
    const tab = [...document.querySelectorAll<HTMLButtonElement>('[role="tab"]')].find(b => b.textContent === name)!;
    const t0 = performance.now();
    tab.click();
    while (!document.querySelector('[data-testid="progress"]')) await new Promise(r => requestAnimationFrame(r));
    await new Promise(r => requestAnimationFrame(r));
    return performance.now() - t0;
  }, e.checkTab);
  console.log(`500 walls: the check tab opened in ${opened.toFixed(1)} ms`);
  const renders = () => page.evaluate(() => (globalThis as unknown as { wallRenders: number }).wallRenders);
  const before = await renders();
  const from = await at([middle + CELL, middle]);
  await page.evaluate(() => {
    const w = window as unknown as { frames_: number[] };
    w.frames_ = [];
    let last = performance.now();
    const loop = (t: number) => {
      w.frames_.push(t - last);
      last = t;
      if (w.frames_.length < 600) requestAnimationFrame(loop);
    };
    requestAnimationFrame(loop);
  });
  for (let i = 0; i < 60; i++) await page.mouse.move(from[0] + i, from[1] + i / 2);
  await expect(page.getByTestId('wall-preview')).toBeVisible(); // the held end survived the tab
  const frames: number[] = await page.evaluate(() => (window as unknown as { frames_: number[] }).frames_.slice(2));
  console.log(`500 walls, check tab open: ${frames.length} frames, the slowest ${Math.max(...frames).toFixed(1)} ms`);
  expect(Math.max(...frames)).toBeLessThan(50);
  expect(await renders()).toBe(before);
});

test('500 walls: the suggestions run after an edit has painted, never inside it (R48)', async ({ page }) => {
  test.setTimeout(240_000);
  await page.setViewportSize({ width: 1440, height: 900 });
  await serveProbe(page);
  const project = large();
  // the whole grid as the apartment, so that there is something to suggest
  const [lo, hi] = [500, 500 + 15 * CELL];
  const boundary = [{ x: lo, y: lo }, { x: hi, y: lo }, { x: hi, y: hi }, { x: lo, y: hi }];
  project.existing.rooms = [{ id: 'flat', name: '', boundary, holes: [], isMamad: false, inApartment: true, outdoor: false }];
  await page.evaluate(async p => (await import(/* @vite-ignore */ '/probe.js' as string)).mount(p), project);
  const k = project.calibration.mmPerPt;
  const at = async (mm: [number, number]) => onScreen(page, [mm[0] / k, mm[1] / k]);
  await page.getByRole('group', { name: e.tools }).getByRole('button', { name: e.select, exact: true }).click();
  await expect(page.locator('[data-wall]')).toHaveCount(500, { timeout: 60_000 });
  const middle = 500 + 7 * CELL;
  await page.mouse.click(...(await at([middle + CELL / 2, middle])));
  await expect(page.getByTestId('wall-details')).toBeVisible({ timeout: 60_000 });
  await expect(page.getByTestId('suggestions')).toBeVisible({ timeout: 60_000 }); // settled
  const calls = () => page.evaluate(() => ((globalThis as unknown as { suggestCalls?: number[] }).suggestCalls ?? []).slice());
  const before = (await calls()).length;
  const fixed = e.classes.fixed;
  // the edit: a click on קבוע, timed from the click to the moment its result is in the page
  const { start, painted } = await page.evaluate(async name => {
    const group = document.querySelector('[data-testid="wall-details"] [role="group"]')!;
    const button = [...group.querySelectorAll('button')].find(b => b.textContent === name)!;
    let done = 0;
    new MutationObserver((_, o) => {
      // the edit is on the screen once the frame after it is drawn: its animation frame callbacks run just before
      if (button.getAttribute('aria-pressed') === 'true') o.disconnect(), requestAnimationFrame(() => (done = performance.now()));
    }).observe(button, { attributes: true });
    const t0 = performance.now();
    button.click();
    while (!done) await new Promise(r => setTimeout(r, 5));
    return { start: t0, painted: done };
  }, fixed);
  await expect.poll(async () => (await calls()).length, { timeout: 60_000 }).toBeGreaterThan(before);
  const ran = (await calls())[before];
  console.log(`500 walls: a class edit took ${(painted - start).toFixed(0)} ms; the suggestions ran ${(ran - painted).toFixed(0)} ms after it`);
  expect(ran).toBeGreaterThan(painted);
  // for the report: with the whole grid as the apartment, the check tab and then its outer stretches (asked for after paint)
  await page.evaluate(() => new Promise(r => setTimeout(r, 50))); // the page is free again: the suggestions are done
  const { t0, shown } = await page.evaluate(async name => {
    const tab = [...document.querySelectorAll<HTMLButtonElement>('[role="tab"]')].find(b => b.textContent === name)!;
    const t0 = performance.now();
    tab.click();
    while (!document.querySelector('[data-testid="progress"]')) await new Promise(r => requestAnimationFrame(r));
    await new Promise(r => requestAnimationFrame(r));
    return { t0, shown: performance.now() };
  }, e.checkTab);
  await expect(page.locator('[data-highlight]').first()).toBeAttached({ timeout: 120_000 });
  const lit = await page.evaluate(() => performance.now());
  console.log(`500 walls as the apartment: the check tab showed in ${(shown - t0).toFixed(0)} ms, its outer stretches ${(lit - t0).toFixed(0)} ms after the click`);
});
