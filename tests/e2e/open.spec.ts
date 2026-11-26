import { readFileSync } from 'node:fs';
import { expect, type Page, test } from '@playwright/test';
import { copy } from '../../src/copy';
import { MAX_FILE_BYTES, MAX_IMAGE_PIXELS, TIMEOUT_MS } from '../../src/limits';
import { COLOR, contrast } from '../../src/theme';
import { bytes, encryptedPdf, imageOnly, jsAction, manyPaths, onePage, ticks, truncated } from '../fixtures/hostile';
import { planPdf } from '../fixtures/makePdf';
import { COLOURS, coloured, special, twoPages, withImage } from '../fixtures/view';
import { describeSamples, type SampleId, samplePage, samplePath } from '../samples';

const READER = '**/assets/reader.worker-*.js';
const upload = (page: Page, pdf: Uint8Array, name = 'plan.pdf') => page.getByTestId('upload').setInputFiles({ name, mimeType: 'application/pdf', buffer: Buffer.from(pdf) });
const canvas = (page: Page) => page.getByTestId('canvas');
const alert = (page: Page) => page.getByRole('alert');

/** Opens a file and waits until its page is drawn sharp. */
async function open(page: Page, pdf: Uint8Array) {
  await page.goto('/');
  await upload(page, pdf);
  await sharp(page);
}
const pictures = (page: Page) => page.getByTestId('drawing').locator('canvas');
const sharp = (page: Page) => expect(pictures(page)).toHaveCount(2);
/** Waits for the redraw that follows a change of the view. */
async function redrawn(page: Page, change: () => Promise<unknown>) {
  const last = pictures(page).last();
  const before = await last.getAttribute('data-box');
  await change();
  await expect(last).not.toHaveAttribute('data-box', before!);
}

const viewBox = async (page: Page) => (await canvas(page).getAttribute('viewBox'))!.split(' ').map(Number);
/** Where a view point is in the window. */
const onScreen = (page: Page, x: number, y: number) =>
  canvas(page).evaluate((svg: SVGSVGElement, [x, y]) => {
    const at = new DOMPoint(x, y).matrixTransform(svg.getScreenCTM()!);
    return { x: at.x, y: at.y };
  }, [x, y]);
const onPage = (page: Page, x: number, y: number) =>
  canvas(page).evaluate((svg: SVGSVGElement, [x, y]) => {
    const at = new DOMPoint(x, y).matrixTransform(svg.getScreenCTM()!.inverse());
    return [at.x, at.y];
  }, [x, y]);
/** The colours on the screen of a strip of pixels that starts at a view point. */
async function pixels(page: Page, x: number, y: number, count = 1) {
  const at = await onScreen(page, x, y);
  const png = await page.screenshot({ clip: { x: Math.floor(at.x), y: Math.floor(at.y), width: count, height: 1 } });
  return page.evaluate(async data => {
    const bitmap = await createImageBitmap(new Blob([new Uint8Array(data)]));
    const context = new OffscreenCanvas(bitmap.width, 1).getContext('2d')!;
    context.drawImage(bitmap, 0, 0);
    const { data: rgba } = context.getImageData(0, 0, bitmap.width, 1);
    return Array.from({ length: bitmap.width }, (_, i) => `#${[...rgba.slice(i * 4, i * 4 + 3)].map(c => c.toString(16).padStart(2, '0')).join('')}`);
  }, [...png]);
}
const pixel = async (page: Page, x: number, y: number) => (await pixels(page, x, y))[0];

test('opens the fixture and shows the page', async ({ page }) => {
  await open(page, planPdf({ layers: true }));
  expect(await viewBox(page)).toEqual([0, 0, 842, 595]);
  await expect(page.getByRole('application', { name: copy.drawing(1) })).toBeVisible();
  await expect(alert(page)).toHaveText('');
  await expect(page.getByText('plan.pdf', { exact: true })).toBeVisible();
  await expect(page.getByTestId('upload')).toHaveValue(''); // the same file can be chosen again
  expect(await pixel(page, 125, 200)).toBe('#808080'); // the left wall: not mirrored
  expect(await pixel(page, 200, 200)).toBe('#ffffff'); // room A
  expect(await pixel(page, 717, 200)).toBe('#ffffff'); // where the left wall would be in a mirror
});

test('the picture lies exactly under the view points of a turned page that does not start at 0,0', async ({ page }) => {
  await open(page, planPdf({ rotate: 90, mediaBoxOrigin: [100, 100] }));
  expect(await viewBox(page)).toEqual([0, 0, 595, 842]);
  for (const [x, y, colour] of [[380, 125, '#808080'], [380, 122, '#808080'], [380, 129, '#808080'], [380, 118, '#ffffff'], [380, 134, '#ffffff']] as const) expect(await pixel(page, x, y), `${x},${y}`).toBe(colour);
});

test('every pixel of the picture is one of the screen, at any density', async ({ browser }) => {
  for (const deviceScaleFactor of [1, 1.25, 1.5, 1.75, 2, 3]) {
    const page = await browser.newPage({ deviceScaleFactor, viewport: { width: 1200, height: 700 } });
    await page.goto('/');
    await upload(page, planPdf({ pages: 20 })); // a header of two or more rows
    await page.getByRole('button', { name: copy.page(1), exact: true }).click();
    await sharp(page);
    for (const zoom of [0, 5]) {
      if (zoom) await redrawn(page, async () => { for (let i = 0; i < zoom; i++) await page.keyboard.press('+'); });
      const shot = await page.screenshot(); // the whole window: a part of it is scaled when its corner is not on a pixel
      const off = await canvas(page).evaluate(async (svg: SVGSVGElement, shot) => {
        const drawn = svg.parentElement!.querySelectorAll('canvas')[1];
        const read = (source: CanvasImageSource, width: number, height: number) => {
          const context = new OffscreenCanvas(width, height).getContext('2d')!;
          context.drawImage(source, 0, 0);
          return context.getImageData(0, 0, width, height).data;
        };
        const bitmap = await createImageBitmap(new Blob([new Uint8Array(shot)]));
        const seen = read(bitmap, bitmap.width, bitmap.height);
        const made = read(drawn, drawn.width, drawn.height);
        const box = drawn.getBoundingClientRect();
        const [left, top] = [box.left, box.top].map(at => Math.round(at * devicePixelRatio));
        let off = 0;
        const edge = 4 * Math.ceil(devicePixelRatio); // holds the line around the page and the mark of the focus
        for (let y = edge; y < drawn.height - edge; y++) for (let x = edge; x < drawn.width - edge; x++) for (let c = 0; c < 3; c++) if (seen[((y + top) * bitmap.width + x + left) * 4 + c] !== made[(y * drawn.width + x) * 4 + c]) off++;
        return off;
      }, [...shot]);
      expect(off, `density ${deviceScaleFactor}, zoom ${zoom}`).toBe(0);
    }
    await page.close();
  }
});

test('stays sharp when zoomed', async ({ page }) => {
  await open(page, planPdf());
  await page.mouse.move(...(Object.values(await onScreen(page, 131.3, 200)) as [number, number])); // the inner face of the left wall
  await redrawn(page, async () => { for (let i = 0; i < 12; i++) await page.mouse.wheel(0, -100); });
  const [, , width] = await viewBox(page);
  expect(842 / width).toBeCloseTo(Math.exp(12 * 0.22), 3); // about 14 times
  const strip = await pixels(page, 130.5, 200, 60);
  expect([strip[0], strip.at(-1)]).toEqual(['#808080', '#ffffff']);
  expect(strip.filter(c => c !== '#808080' && c !== '#ffffff').length).toBeLessThanOrEqual(1);
});

test('the wheel zooms about the cursor, between 2 pages wide and a 64th of one', async ({ page }) => {
  await open(page, planPdf());
  const { x, y } = await onScreen(page, 300, 150);
  const cursor = [Math.round(x), Math.round(y)] as const; // a wheel event has whole pixels
  const at = await onPage(page, ...cursor);
  await page.mouse.move(...cursor);
  for (const [notch, times, width] of [[-100, 1, 842 / Math.exp(0.22)], [100, 1, 842], [-1000, 1, 842 / Math.exp(0.22)], [50, 2, 842], [-100, 40, 842 / 64], [100, 60, 842 * 2]] as const) {
    for (let i = 0; i < times; i++) await page.mouse.wheel(0, notch);
    await expect.poll(async () => (await viewBox(page))[2]).toBeCloseTo(width, 1);
    (await onPage(page, ...cursor)).forEach((value, i) => expect(value).toBeCloseTo(at[i], 3));
  }
});

test('the browser keeps its own zoom out of the drawing and its own keys', async ({ page }) => {
  await open(page, planPdf());
  const taken = (type: 'wheel' | 'keydown', init: object) =>
    canvas(page).evaluate((svg, [type, init]) => !svg.dispatchEvent(new (type === 'wheel' ? WheelEvent : KeyboardEvent)(type as string, { bubbles: true, cancelable: true, ...(init as object) })), [type, init] as const);
  expect(await taken('wheel', { deltaY: 100, ctrlKey: true, clientX: 300, clientY: 300 })).toBe(true);
  for (const key of ['0', '+', '-', ' ', 'ArrowUp']) expect(await taken('keydown', { key })).toBe(true);
  for (const init of [{ key: '0', ctrlKey: true }, { key: '+', metaKey: true }, { key: 'ArrowLeft', altKey: true }, { key: 'Tab' }]) expect(await taken('keydown', init), JSON.stringify(init)).toBe(false);
});

test('a resized window is drawn again', async ({ page }) => {
  await open(page, planPdf());
  const width = () => pictures(page).last().evaluate((drawn: HTMLCanvasElement) => drawn.width);
  const before = await width();
  await page.setViewportSize({ width: 900, height: 500 });
  await expect.poll(width).toBeLessThan(before);
  expect(await pixel(page, 125, 200)).toBe('#808080');
});

test('a screen with more pixels than MAX_IMAGE_PIXELS gets a picture of no more', async ({ browser }) => {
  const page = await browser.newPage({ deviceScaleFactor: 3, viewport: { width: 2400, height: 1500 } });
  await open(page, planPdf());
  await redrawn(page, () => page.keyboard.press('+'));
  const size = await pictures(page).last().evaluate((drawn: HTMLCanvasElement) => drawn.width * drawn.height);
  expect(size).toBeLessThanOrEqual(MAX_IMAGE_PIXELS);
  expect(size).toBeGreaterThan(MAX_IMAGE_PIXELS * 0.99);
  expect(await pixel(page, 125, 200)).toBe('#808080');
  await page.close();
});

test('drags with the middle button, or with space and the left one; the left one alone does nothing', async ({ page }) => {
  await open(page, planPdf());
  const from = await onScreen(page, 300, 200);
  const drag = async (button: 'left' | 'middle') => {
    await page.mouse.move(from.x, from.y);
    await page.mouse.down({ button });
    await page.mouse.move(from.x + 60, from.y + 40, { steps: 3 });
    await page.mouse.up({ button });
    await page.mouse.move(from.x + 90, from.y, { steps: 2 }); // not dragging any more
    const to = await onPage(page, from.x + 60, from.y + 40);
    return to.map(Math.round);
  };
  expect(await drag('left')).not.toEqual([300, 200]);
  expect(await viewBox(page)).toEqual([0, 0, 842, 595]);
  expect(await drag('middle')).toEqual([300, 200]);
  await page.keyboard.press('0');
  await page.keyboard.down(' ');
  expect(await drag('left')).toEqual([300, 200]);
  await page.keyboard.up(' ');
  const still = await viewBox(page);
  await drag('left');
  expect(await viewBox(page)).toEqual(still);
});

test('the keyboard and the buttons zoom and move too', async ({ page }) => {
  await open(page, planPdf());
  await expect(canvas(page)).toBeFocused();
  const near = async (want: number[]) => (await viewBox(page)).forEach((value, i) => expect(value).toBeCloseTo(want[i], 6));
  await page.keyboard.press('+');
  await near([84.2, 59.5, 673.6, 476]);
  await page.keyboard.press('ArrowRight');
  await page.keyboard.press('ArrowDown');
  await near([151.56, 107.1, 673.6, 476]);
  await page.keyboard.press('ArrowLeft');
  await page.keyboard.press('ArrowUp');
  await page.keyboard.press('-');
  await near([0, 0, 842, 595]);
  await page.getByRole('button', { name: copy.zoomIn }).click();
  await near([84.2, 59.5, 673.6, 476]);
  await page.getByRole('button', { name: copy.zoomOut }).click();
  await near([0, 0, 842, 595]);
  await page.getByRole('button', { name: copy.zoomIn }).click();
  await page.getByRole('button', { name: copy.fit }).click();
  await near([0, 0, 842, 595]);
});

test('two-page file asks which page', async ({ page }) => {
  await page.goto('/');
  await upload(page, twoPages());
  await expect(page.getByRole('status')).toHaveText(copy.whichPage(2));
  await expect(canvas(page)).toHaveCount(0);
  for (const [n, box, colour] of [[2, [0, 0, 400, 600], '#0000ff'], [1, [0, 0, 600, 400], '#ff0000'], [2, [0, 0, 400, 600], '#0000ff']] as const) {
    await page.getByRole('button', { name: copy.page(n) }).click();
    await expect(page.getByRole('application', { name: copy.drawing(n) })).toBeVisible();
    await sharp(page);
    expect(await viewBox(page)).toEqual(box);
    expect(await pixel(page, 150, box[3] - 150)).toBe(colour);
    for (const other of [1, 2]) await expect(page.getByRole('button', { name: copy.page(other) })).toHaveAttribute('aria-pressed', String(other === n));
    await expect(page.getByRole('status')).toHaveText('');
  }
});

test('two pages asked for quickly: only the second ever shows', async ({ page }) => {
  await page.goto('/');
  await upload(page, twoPages('0 0 m 1 1 l S '.repeat(99_000)));
  await page.getByRole('button', { name: copy.page(1) }).click();
  await page.evaluate(label => {
    Object.assign(window, { seen: 0 });
    new MutationObserver(() => ((window as unknown as { seen: number }).seen += document.querySelectorAll(`[aria-label="${label}"]`).length)).observe(document.body, { childList: true, subtree: true });
  }, copy.drawing(1));
  await page.getByRole('button', { name: copy.page(2) }).click();
  await expect(page.getByRole('application', { name: copy.drawing(2) })).toBeVisible({ timeout: 15_000 });
  expect(await page.evaluate(() => (window as unknown as { seen: number }).seen)).toBe(0);
});

test('a page that is refused leaves the other pages to choose', async ({ page }) => {
  await page.goto('/');
  await upload(page, twoPages(''));
  await page.getByRole('button', { name: copy.page(1) }).click();
  await expect(alert(page)).toHaveText(copy.refused['image-only']);
  await expect(canvas(page)).toHaveCount(0);
  await page.getByRole('button', { name: copy.page(2) }).click();
  await sharp(page);
  await expect(alert(page)).toHaveText('');
});

const BAD: [keyof typeof copy.refused, () => Uint8Array][] = [
  ['empty', () => new Uint8Array(0)],
  ['too-large', () => new Uint8Array(MAX_FILE_BYTES + 1)],
  ['not-pdf', () => new Uint8Array(MAX_FILE_BYTES)],
  ['locked', () => encryptedPdf('secret')],
  ['corrupt', truncated],
  ['too-many-pages', () => planPdf({ pages: 21 })],
  ['too-complex', () => manyPaths(100_001)],
  ['image-only', imageOnly],
];
for (const [code, pdf] of BAD) {
  test(`${code}: its message and nothing else, and then a good file opens`, async ({ page }) => {
    await open(page, planPdf());
    await upload(page, pdf());
    await expect(alert(page)).toHaveText(copy.refused[code]);
    await expect(canvas(page)).toHaveCount(0);
    await expect(page.getByRole('status')).toHaveText('');
    await upload(page, twoPages());
    await expect(page.getByRole('status')).toHaveText(copy.whichPage(2));
    await expect(alert(page)).toHaveText('');
    await page.getByRole('button', { name: copy.page(1) }).click();
    await sharp(page);
  });
}

test('a page that cannot be drawn is refused', async ({ page }) => {
  await page.goto('/');
  await upload(page, special('0 0 50 50 re W* /F Do n')); // pdf.js throws between W* and n
  await expect(alert(page)).toHaveText(copy.refused.corrupt);
  await expect(canvas(page)).toHaveCount(0);
});

test('every refusal has its own words, and a scan has the exact ones', () => {
  expect(new Set(Object.values(copy.refused)).size).toBe(10);
  expect(copy.refused['image-only']).toBe('הקובץ הוא תמונה. תמונות אינן נתמכות עדיין');
});

test('a 21 MB file is refused before it is read', async ({ page }) => {
  await page.addInitScript(() => {
    Object.assign(window, { read: 0 });
    Blob.prototype.arrayBuffer = () => ((window as unknown as { read: number }).read++, Promise.reject(new Error('read')));
  });
  let readers = 0;
  await page.route(READER, route => (readers++, route.continue()));
  await page.goto('/');
  await upload(page, new Uint8Array(21 * 1024 * 1024));
  await expect(alert(page)).toHaveText(copy.refused['too-large']);
  expect([await page.evaluate(() => (window as unknown as { read: number }).read), readers]).toEqual([0, 0]);
});

test('a file that cannot be read from the disk is said to have failed', async ({ page }) => {
  await page.addInitScript(() => {
    Blob.prototype.arrayBuffer = () => Promise.reject(new DOMException('gone', 'NotReadableError'));
  });
  await page.goto('/');
  await upload(page, planPdf());
  await expect(alert(page)).toHaveText(copy.refused.failed);
});

test('a hanging file is stopped at the time limit', async ({ page }) => {
  await page.clock.install();
  await page.route(READER, route => route.fulfill({ contentType: 'text/javascript', body: 'onmessage = () => { for (;;); }' }));
  await page.goto('/');
  await upload(page, planPdf());
  await expect(page.getByRole('status')).toHaveText(copy.opening);
  await page.clock.runFor(TIMEOUT_MS - 100);
  await expect(page.getByRole('status')).toHaveText(copy.opening);
  await page.clock.runFor(200);
  await expect(alert(page)).toHaveText(copy.refused.timeout);
  await page.unroute(READER);
  await upload(page, planPdf());
  await page.clock.resume();
  await sharp(page);
});

test('a missing reader is said to have failed', async ({ page }) => {
  await page.route(READER, route => route.fulfill({ status: 404, body: '' }));
  await page.goto('/');
  await upload(page, planPdf());
  await expect(alert(page)).toHaveText(copy.refused.failed);
});

test('a drawing that hangs or fails while zooming keeps the page and says so', async ({ page }) => {
  await open(page, planPdf());
  await page.clock.install();
  await page.evaluate(() => {
    Worker.prototype.postMessage = () => {}; // nothing answers any more
  });
  await page.keyboard.press('+');
  await page.clock.runFor(TIMEOUT_MS + 1000);
  await expect(alert(page)).toHaveText(copy.notSharper);
  await expect(canvas(page)).toBeVisible();
});

test('a second file while the first is opening: only the second is shown', async ({ page }) => {
  await page.goto('/');
  await upload(page, manyPaths(100_000), 'first.pdf');
  await upload(page, twoPages(), 'second.pdf');
  await page.getByRole('button', { name: copy.page(1) }).click();
  await page.getByRole('button', { name: copy.page(2) }).click();
  await sharp(page);
  await page.waitForTimeout(1500);
  expect(await viewBox(page)).toEqual([0, 0, 400, 600]);
  await expect(page.getByText('first.pdf')).toHaveCount(0);
  expect(page.workers()).toHaveLength(1); // the first one's reader is gone
  await upload(page, planPdf());
  await expect.poll(() => viewBox(page)).toEqual([0, 0, 842, 595]);
  expect(page.workers()).toHaveLength(1);
});

test('a file dropped anywhere opens; two at once do not', async ({ page }) => {
  await page.goto('/');
  const drop = async (pdfs: Uint8Array[]) => {
    const dataTransfer = await page.evaluateHandle(files => {
      const transfer = new DataTransfer();
      files.forEach((data, i) => transfer.items.add(new File([new Uint8Array(data)], `${i}.pdf`, { type: 'application/pdf' })));
      return transfer;
    }, pdfs.map(pdf => [...pdf]));
    expect(await page.getByRole('main').evaluate((main, transfer) => main.dispatchEvent(new DragEvent('dragover', { dataTransfer: transfer, bubbles: true, cancelable: true })), dataTransfer)).toBe(false);
    expect(await page.getByRole('main').evaluate((main, transfer) => main.dispatchEvent(new DragEvent('drop', { dataTransfer: transfer, bubbles: true, cancelable: true })), dataTransfer)).toBe(false);
  };
  await drop([planPdf(), planPdf()]);
  await expect(alert(page)).toHaveText(copy.oneFile);
  await drop([planPdf()]);
  await sharp(page);
  await expect(alert(page)).toHaveText('');
});

test('opening and zooming raises no policy violation, asks nothing of another origin and runs nothing from the file', async ({ page, baseURL }) => {
  const asked: string[] = [];
  const said: string[] = [];
  page.on('request', request => { if (!request.url().startsWith(baseURL!) && !request.url().startsWith('blob:')) asked.push(request.url()); });
  page.on('console', message => { if (!message.text().includes('downloadable font')) said.push(message.text()); });
  page.on('pageerror', error => said.push(error.message));
  await page.addInitScript(() => {
    Object.assign(window, { violations: [] });
    document.addEventListener('securitypolicyviolation', e => (window as unknown as { violations: string[] }).violations.push(`${e.effectiveDirective} ${e.blockedURI}`));
  });
  await open(page, jsAction());
  await redrawn(page, () => page.keyboard.press('+'));
  expect([asked, said]).toEqual([[], []]);
  expect(await page.evaluate(() => [(window as unknown as { violations: string[] }).violations, 'pwned' in window])).toEqual([[], false]);
});

test('file text cannot inject markup', async ({ page }) => {
  const evil = '<img src=x onerror="window.pwned=1">';
  await page.goto('/');
  await upload(page, planPdf({ layers: { walls: evil, doors: evil } }), `${evil.replaceAll('"', '')}.pdf`);
  await sharp(page);
  await expect(page.locator('bdi')).toHaveText(`${evil.replaceAll('"', '')}.pdf`);
  await expect(page.locator('img')).toHaveCount(0);
  expect(await page.evaluate(() => 'pwned' in window)).toBe(false);
});

test('the colours of the file stay as they are, in a dark theme and in high contrast too', async ({ page }) => {
  for (const media of [{}, { colorScheme: 'dark' }, { forcedColors: 'active', colorScheme: 'dark' }] as const) {
    await page.emulateMedia(media);
    await open(page, coloured());
    for (const [i, hex] of COLOURS.entries()) expect(await pixel(page, 100 + 60 * i, 100), `${JSON.stringify(media)} ${hex}`).toBe(hex);
    expect(await pixel(page, 70, 100)).toBe('#ffffff');
  }
});

test('an image of MAX_IMAGE_PIXELS is drawn, one line more is left out', async ({ page }) => {
  await open(page, withImage(4096, 4096));
  expect(await pixel(page, 400, 200)).toBe('#000000');
  await open(page, withImage(4096, 4097));
  expect(await pixel(page, 400, 200)).toBe('#ffffff');
  await expect(alert(page)).toHaveText('');
});

test.describe('the picture shows what is read', () => {
  const SQUARES = '20 20 200 200 re 100 100 200 200 re f'; // overlapping: a hole from 100 to 220 under the even-odd rule
  for (const [name, content, form, points] of [
    ['a soft mask', '/M gs 1 0 0 rg 100 100 100 100 re f', '', { '120,250': '#ff0000', '180,250': '#ffffff' }],
    ['no annotation', '', '', { '530,70': '#ffffff' }],
    ['a form on a layer that is off leaves nothing behind', '/OC /Off BDC /F Do EMC 1 0 0 rg 100 100 50 50 re f', '1 0 0 1 200 100 cm 0 1 0 rg 0 0 9 9 re W n 0 0 5 5 re f', { '125,275': '#ff0000', '325,175': '#ffffff' }],
    ['an even-odd fill on a layer that is off leaves the next fill whole', `/OC /Off BDC 0 0 9 9 re f* EMC 1 0 0 rg ${SQUARES}`, '', { '160,240': '#ff0000' }],
    ['an even-odd fill outside its clip leaves the next fill whole', `q 0 0 9 9 re W n 300 300 9 9 re f* Q 1 0 0 rg ${SQUARES}`, '', { '160,240': '#ff0000' }],
    ['a dash', '/E gs 40 w 1 0 0 RG 100 200 m 300 200 l S', '', { '110,200': '#ff0000', '130,200': '#ffffff', '150,200': '#ff0000' }],
    ['a dash of null is drawn solid', '[9 9] 0 d /D gs 40 w 1 0 0 RG 100 200 m 300 200 l S', '', { '110,200': '#ff0000', '115,200': '#ff0000', '195,200': '#ff0000' }],
  ] as const) {
    test(name, async ({ page }) => {
      await open(page, special(content, form));
      for (const [at, colour] of Object.entries(points)) expect(await pixel(page, ...(at.split(',').map(Number) as [number, number])), at).toBe(colour);
    });
  }
});

test('the buttons are turquoise with white or turquoise words that can be read, and the focus shows', async ({ page }) => {
  const rgb = (hex: string) => `rgb(${[1, 3, 5].map(at => parseInt(hex.slice(at, at + 2), 16)).join(', ')})`;
  const look = (name: string) =>
    page.getByRole('button', { name, exact: true }).evaluate(button => ['color', 'background-color', 'border-top-color'].map(key => getComputedStyle(button).getPropertyValue(key)));
  const [turquoise, white] = [rgb(COLOR.dimension), rgb(COLOR.paper)];
  expect(contrast(COLOR.dimension, COLOR.paper)).toBeGreaterThanOrEqual(4.5); // AA for text of any size, both ways round
  await page.goto('/');
  const label = page.locator('label', { has: page.getByTestId('upload') });
  expect(await label.evaluate(upload => ['color', 'background-color'].map(key => getComputedStyle(upload).getPropertyValue(key)))).toEqual([white, turquoise]);
  await upload(page, twoPages());
  await page.getByRole('button', { name: copy.page(2) }).click();
  await sharp(page);
  expect(await look(copy.page(2))).toEqual([white, turquoise, turquoise]); // the page on screen
  for (const name of [copy.page(1), copy.zoomIn, copy.zoomOut, copy.fit]) expect(await look(name), name).toEqual([turquoise, white, turquoise]);
  await page.getByLabel(copy.upload).focus();
  for (const name of [copy.upload, copy.page(1), copy.page(2)]) {
    const focused = name === copy.upload ? label : page.getByRole('button', { name, exact: true });
    if (name !== copy.upload) await page.keyboard.press('Tab');
    expect(await focused.evaluate(element => ['outline-style', 'outline-width', 'outline-color'].map(key => getComputedStyle(element).getPropertyValue(key))), name).toEqual(['solid', '2px', rgb(COLOR.ink)]);
  }
  expect(contrast(COLOR.ink, COLOR.paper)).toBeGreaterThanOrEqual(3); // the ring against the white around it
});

test('the upload control, the page buttons, the drawing and the zoom have text labels, in the order of the keyboard', async ({ page }) => {
  await page.goto('/');
  await upload(page, twoPages());
  await page.getByRole('button', { name: copy.page(1) }).click();
  await sharp(page);
  const focused = () => page.evaluate(() => document.activeElement!.getAttribute('aria-label') ?? (document.activeElement as HTMLInputElement).labels?.[0]?.textContent?.trim() ?? document.activeElement!.textContent);
  await page.getByLabel(copy.upload).focus();
  const order = [await focused()];
  for (let i = 0; i < 6; i++) {
    await page.keyboard.press('Tab');
    order.push(await focused());
  }
  expect(order).toEqual([copy.upload, copy.page(1), copy.page(2), copy.drawing(1), copy.zoomIn, copy.zoomOut, copy.fit]);
  await expect(page.getByRole('navigation', { name: copy.pages })).toBeVisible();
  await expect(page.getByRole('group', { name: copy.zoom })).toBeVisible();
  await expect(canvas(page)).toHaveAccessibleDescription(copy.help);
});

describeSamples('samples', () => {
  for (const [id, box] of [['S01', [1684, 1191]], ['S11', [907, 1191]], ['S16', [1503, 1191]]] as [SampleId, number[]][]) {
    test(`${id} shows`, async ({ page }) => {
      await page.goto('/');
      await upload(page, readFileSync(samplePath(id)));
      if (samplePage(id) > 1) await page.getByRole('button', { name: copy.page(samplePage(id)), exact: true }).click();
      await sharp(page);
      (await viewBox(page)).slice(2).forEach((value, i) => expect(Math.round(value)).toBe(box[i]));
      const ink = await pictures(page).last().evaluate((drawn: HTMLCanvasElement) => {
        const { data } = drawn.getContext('2d')!.getImageData(0, 0, drawn.width, drawn.height);
        let dark = 0;
        for (let i = 0; i < data.length; i += 4) if (data[i] < 200) dark++;
        return dark / (data.length / 4);
      });
      expect(ink).toBeGreaterThan(0.005);
    });
  }
});
