import type { Box } from '../pdf/render';
import type { Vec } from '../shared';

// A view is what the svg's viewBox holds: the part of the page it shows, in view points.
type Page = { widthPt: number; heightPt: number };
/** Screen pixels. */
export type Size = [width: number, height: number];

const CLOSEST = 1 / 64; // of the page's width
const FURTHEST = 2;

export const whole = (page: Page): Box => [0, 0, page.widthPt, page.heightPt];
export const moved = ([x, y, width, height]: Box, [dx, dy]: Vec): Box => [x + dx, y + dy, width, height];

/** The point at stays where it is on the screen. */
export function zoomed([x, y, width, height]: Box, page: Page, [atX, atY]: Vec, factor: number): Box {
  const k = Math.min(FURTHEST * page.widthPt, Math.max(CLOSEST * page.widthPt, width / factor)) / width;
  return [atX - (atX - x) * k, atY - (atY - y) * k, width * k, height * k];
}

/** How a view lies on the screen, as the svg lays it: screen pixels per point, and where the page's corner is. */
export function layout([x, y, width, height]: Box, [screenWidth, screenHeight]: Size) {
  const scale = Math.min(screenWidth / width, screenHeight / height);
  return { scale, originX: (screenWidth - width * scale) / 2 - x * scale, originY: (screenHeight - height * scale) / 2 - y * scale };
}

/** What a picture has to cover: the visible part of the page, out to whole screen pixels, so that each of its pixels is one of the screen's. */
export function visiblePart(view: Box, size: Size, page: Page): { box: Box; scale: number } | null {
  const { scale, originX, originY } = layout(view, size);
  const [screenWidth, screenHeight] = size;
  const left = Math.max(0, Math.floor(originX));
  const top = Math.max(0, Math.floor(originY));
  const right = Math.ceil(Math.min(screenWidth, originX + page.widthPt * scale));
  const bottom = Math.ceil(Math.min(screenHeight, originY + page.heightPt * scale));
  if (right <= left || bottom <= top) return null;
  return { box: [(left - originX) / scale, (top - originY) / scale, (right - left) / scale, (bottom - top) / scale], scale };
}
