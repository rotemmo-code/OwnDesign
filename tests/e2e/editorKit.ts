// The editor's E2E helpers for Task 11b, on the synthetic fixture: upload, calibrate by three written dimensions, draw.
import { expect, type Page, test } from '@playwright/test';
import { copy } from '../../src/copy';
import type { Plaster } from '../../src/model/types';
import type { Vec } from '../../src/shared';
import { DIMS, dimsPdf, type Mark, viewOf } from '../fixtures/dims';
import { PLAN_ORIGIN } from '../fixtures/makePdf';

export const c = copy.calibrate;
export const e = copy.editor;
export const K = (50 * 25.4) / 72; // mm per point at 1:50
export const O = { x: PLAN_ORIGIN[0] * K, y: PLAN_ORIGIN[1] * K }; // the apartment's corner in mm
export const canvas = (page: Page) => page.getByTestId('canvas');
export const message = (page: Page) => page.getByTestId('message');

declare global {
  interface Window {
    violations: string[];
  }
}
/** Every test: no policy violation, no request to another origin. */
export function watch() {
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
    expect((await page.evaluate(() => window.violations)) ?? []).toEqual([]);
    expect(external).toEqual([]);
  });
}

export const onScreen = (page: Page, [x, y]: Vec) =>
  canvas(page).evaluate((svg: SVGSVGElement, [x, y]) => {
    const at = new DOMPoint(x, y).matrixTransform(svg.getScreenCTM()!);
    return [at.x, at.y] as Vec;
  }, [x, y]);
export const viewBox = async (page: Page) => (await canvas(page).getAttribute('viewBox'))!.split(' ').map(Number);
/** A designer's click on a point of the fixture (mm from the apartment's corner): zoomed in about 3.7 times, then off by px. */
export async function clickMm(page: Page, mm: Vec, off: Vec = [0, 0]) {
  await page.getByRole('button', { name: copy.fit }).click();
  await canvas(page).evaluate(svg => svg.scrollIntoView({ block: 'center' }));
  await page.mouse.move(...(await onScreen(page, viewOf(50, mm))));
  for (let i = 0; i < 40 && (await viewBox(page))[2] >= 250; i++) await page.mouse.wheel(0, -100);
  await expect.poll(async () => (await viewBox(page))[2]).toBeLessThan(250);
  const [x, y] = await onScreen(page, viewOf(50, mm));
  await page.mouse.click(x + off[0], y + off[1]);
}
/** The pointer over a point of the fixture, at the view it is in. */
export const hoverMm = async (page: Page, mm: Vec) => page.mouse.move(...(await onScreen(page, viewOf(50, mm))));
async function markMm(page: Page, mark: Mark) {
  await clickMm(page, mark.a);
  await clickMm(page, mark.b);
  await page.getByLabel(c.written).fill(mark.text);
  await page.getByLabel(c.written).press('Enter');
  await expect(page.getByLabel(c.written)).toHaveCount(0);
}
/** Upload, answer the plaster question, mark 640 / 400 / 290 and go on at 1:50: the editor, on its measure tool. */
export async function start(page: Page, plaster: Plaster | null = 'line', size: [number, number] = [1440, 900]) {
  await page.setViewportSize({ width: size[0], height: size[1] });
  await page.goto('/');
  await page.getByTestId('upload').setInputFiles({ name: 'plan-7.pdf', mimeType: 'application/pdf', buffer: Buffer.from(dimsPdf()) });
  await expect(page.getByTestId('drawing').locator('canvas')).toHaveCount(2);
  if (plaster) await page.getByRole('button', { name: c.plaster[plaster], exact: true }).click();
  for (const mark of [DIMS.outer, DIMS.heightA, DIMS.roomB]) await markMm(page, mark);
  await page.getByRole('button', { name: c.go(50) }).click();
  await expect(page.getByRole('tab', { name: e.existing })).toBeVisible();
}
export const tool = (page: Page, name: string) => page.getByRole('group', { name: e.tools }).getByRole('button', { name, exact: true }).click();

/** The five walls of the fixture by their centre lines: ends in mm from the apartment's corner, thickness in cm. */
export const FIVE: [Vec, Vec, string][] = [
  [[0, 100], [6400, 100], '20'],
  [[100, 200], [100, 4200], '20'],
  [[0, 4300], [6400, 4300], '20'],
  [[6300, 200], [6300, 4200], '20'],
  [[3250, 200], [3250, 4200], '10'],
];
export async function drawWall(page: Page, [a, b, cm]: [Vec, Vec, string]) {
  await page.getByLabel(e.thickness).fill(cm);
  await clickMm(page, a);
  await clickMm(page, b);
}
export async function drawFive(page: Page, which = [0, 1, 2, 3, 4]) {
  await tool(page, e.wall);
  for (const i of which) await drawWall(page, FIVE[i]);
}
/** The box of each wall's outline as drawn, in mm from the apartment's corner. */
export const wallBoxes = (page: Page) =>
  page.locator('[data-wall]').evaluateAll((paths, o) =>
    paths.map(p => {
      const n = (p.getAttribute('d') ?? '').match(/-?\d+(\.\d+)?(e-?\d+)?/g)!.map(Number);
      const xs = n.filter((_, i) => i % 2 === 0).map(x => x - o.x);
      const ys = n.filter((_, i) => i % 2 === 1).map(y => y - o.y);
      return [Math.min(...xs), Math.min(...ys), Math.max(...xs), Math.max(...ys)].map(v => Math.round(v * 100) / 100);
    }), O);
/** The details panel of what the select tool takes at mm. */
export async function pick(page: Page, mm: Vec, testid: 'room-details' | 'wall-details' | 'opening-details') {
  await tool(page, e.select);
  await clickMm(page, mm);
  return page.getByTestId(testid);
}
/** The outer walls and the partition, the left room named and the apartment's; the split answered as it came. */
export async function twoRooms(page: Page) {
  await drawFive(page, [0, 1, 2, 3]);
  const r = await pick(page, [1700, 2200], 'room-details');
  await r.getByLabel(e.roomName).fill('סלון');
  await r.getByLabel(e.roomName).press('Enter');
  await r.getByLabel(e.inApartment).check();
  await tool(page, e.wall);
  await drawWall(page, FIVE[4]);
  await page.getByRole('button', { name: e.part(1, '12.00') }).click();
}
/** An opening by its two ends, in mm from the apartment's corner. */
export async function drawOpening(page: Page, toolName: string, a: Vec, b: Vec) {
  await tool(page, toolName);
  await clickMm(page, a);
  await clickMm(page, b);
}
