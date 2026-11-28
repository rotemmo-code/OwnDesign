import { expect, it } from 'vitest';
import { framed, moved, visiblePart, wheelFactor, whole, zoomed } from '../../src/editor/view';

const PAGE = { widthPt: 842, heightPt: 595 };
const near = (got: readonly number[] | undefined, want: number[]) => {
  expect(got).toHaveLength(want.length);
  want.forEach((value, i) => expect(got![i]).toBeCloseTo(value, 6));
};

it('the whole page', () => {
  near(whole(PAGE), [0, 0, 842, 595]);
});

it('zooms about a point, which keeps its place in the view', () => {
  near(zoomed(whole(PAGE), PAGE, [421, 297.5], 1.25), [84.2, 59.5, 673.6, 476]);
  near(zoomed([84.2, 59.5, 673.6, 476], PAGE, [421, 297.5], 1 / 1.25), [0, 0, 842, 595]);
  near(zoomed(whole(PAGE), PAGE, [0, 0], 2), [0, 0, 421, 297.5]);
  near(zoomed(whole(PAGE), PAGE, [842, 595], 2), [421, 297.5, 421, 297.5]);
});

it('stops at a 64th of the page and at twice its width', () => {
  near(zoomed(whole(PAGE), PAGE, [421, 297.5], 1e9), [421 - 421 / 64, 297.5 - 297.5 / 64, 842 / 64, 595 / 64]);
  near(zoomed(whole(PAGE), PAGE, [421, 297.5], 1e-9), [-421, -297.5, 1684, 1190]);
});

it('moves', () => {
  near(moved([1, 2, 30, 40], [5, -6]), [6, -4, 30, 40]);
});

it('the visible part ends on whole screen pixels', () => {
  const part = visiblePart(whole(PAGE), [1200, 604], PAGE)!; // the page is as high as the screen and starts at pixel 172.63
  expect(part.scale).toBeCloseTo(604 / 595, 9);
  near(part.box, [-0.622516556, 0, 843.245033, 595]);
  for (const size of [843.245033 * part.scale, 595 * part.scale]) expect(size).toBeCloseTo(Math.round(size), 3); // 856 x 604 pixels
  near(visiblePart(whole(PAGE), [842, 700.5], PAGE)!.box, [0, -0.75, 842, 596]); // the page begins at pixel 52.75 and ends at 647.75
  near(visiblePart([100, 100, 84.2, 59.5], [842, 595], PAGE)!.box, [100, 100, 84.2, 59.5]); // inside the page: all of the screen
  near(visiblePart([-100, -50, 842, 595], [842, 595], PAGE)!.box, [0, 0, 742, 545]); // its corner inside the screen
  near(visiblePart([800, 500, 842, 595], [842, 595], PAGE)!.box, [800, 500, 42, 95]); // its other corner
});

it('nothing of the page is on the screen', () => {
  for (const view of [[842, 0, 842, 595], [-842, 0, 842, 595], [0, 595, 842, 595], [0, -595, 842, 595]] as [number, number, number, number][]) expect(visiblePart(view, [842, 595], PAGE)).toBeNull();
});

it('one notch of the wheel is one step, in pixels, in lines or in pages', () => {
  expect(wheelFactor({ deltaY: -100, deltaMode: 0 })).toBeCloseTo(Math.exp(0.22), 9); // Chromium
  expect(wheelFactor({ deltaY: -3, deltaMode: 1 })).toBeCloseTo(Math.exp(0.22), 9); // Firefox: three lines
  expect(wheelFactor({ deltaY: 1, deltaMode: 2 })).toBeCloseTo(Math.exp(-0.22), 9); // a page: no more than a notch
  expect(wheelFactor({ deltaY: -1000, deltaMode: 0 })).toBeCloseTo(Math.exp(0.22), 9);
  expect(wheelFactor({ deltaY: 10, deltaMode: 0 })).toBeCloseTo(Math.exp(-0.022), 9); // a touchpad, a little at a time
  expect(wheelFactor({ deltaY: 0, deltaMode: 0 })).toBe(1);
});

it('framed: a box with half its larger side around it, centred on it; a tiny box gets at least a 16th of the page (R42)', () => {
  near(framed([200, 100, 100, 50], PAGE), [150, 50, 200, 150]);
  near(framed([400, 300, 0, 0], PAGE), [400 - 842 / 32, 300 - 842 / 32, 842 / 16, 842 / 16]);
  near(framed([400, 300, 10, 2], PAGE), [405 - 842 / 32, 301 - 842 / 32, 842 / 16, 842 / 16]);
  near(framed([0, 0, 842, 595], PAGE), [-421, -421, 1684, 1437]); // a box as large as the page: twice the width, no more
});
