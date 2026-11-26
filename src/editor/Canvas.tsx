import { type ReactNode, useEffect, useLayoutEffect, useRef, useState } from 'react';
import { copy } from '../copy';
import type { ExtractedPage } from '../pdf/extract';
import type { Box, Picture } from '../pdf/render';
import type { Vec } from '../shared';
import { layout, moved, type Size, visiblePart, whole, zoomed } from './view';

const NOTCH = 1.25; // one zoom step
const REST_MS = 120; // without a change before the picture is drawn again

type Props = {
  page: ExtractedPage;
  pageNo: number;
  picture: Picture; // the whole page
  /** Draws a part of the page again; null when that failed. */
  draw(box: Box, scale: number): Promise<Picture | null>;
  children?: ReactNode;
};

/** The page, and over it whatever is drawn in view points. */
export function Canvas({ page, pageNo, picture, draw, children }: Props) {
  const frame = useRef<HTMLDivElement>(null);
  const svg = useRef<SVGSVGElement>(null);
  const [view, setView] = useState<Box>(() => whole(page));
  const [size, setSize] = useState<Size>([1, 1]);
  const [sharp, setSharp] = useState<Picture | null>(null);
  const [space, setSpace] = useState(false);
  const held = useRef<Vec | null>(null); // the point of the page under the pointer, while it is dragged

  const pointAt = (event: { clientX: number; clientY: number }): Vec => {
    const { x, y } = new DOMPoint(event.clientX, event.clientY).matrixTransform(svg.current!.getScreenCTM()!.inverse());
    return [x, y];
  };
  const zoom = (factor: number) => setView(old => zoomed(old, page, [old[0] + old[2] / 2, old[1] + old[3] / 2], factor));
  const move = (dx: number, dy: number) => setView(old => moved(old, [dx, dy]));

  useLayoutEffect(() => {
    const measure = () => {
      const { width, height } = frame.current!.getBoundingClientRect();
      setSize([width * devicePixelRatio, height * devicePixelRatio]);
    };
    const observer = new ResizeObserver(measure);
    observer.observe(frame.current!);
    measure();
    return () => observer.disconnect();
  }, []);

  useEffect(() => {
    const element = svg.current!;
    element.focus({ preventScroll: true });
    const wheel = (event: WheelEvent) => {
      event.preventDefault(); // else Ctrl and the wheel zoom the whole window; React listens too passively for this
      const at = pointAt(event);
      const factor = Math.exp(-Math.max(-100, Math.min(100, event.deltaY)) * 0.0022);
      setView(old => zoomed(old, page, at, factor));
    };
    element.addEventListener('wheel', wheel, { passive: false });
    return () => element.removeEventListener('wheel', wheel);
  }, []);

  useEffect(() => {
    const part = visiblePart(view, size, page);
    if (!part) return;
    let stale = false;
    const timer = setTimeout(async () => {
      const drawn = await draw(part.box, part.scale);
      if (stale) drawn?.bitmap.close();
      else if (drawn) setSharp(drawn);
    }, REST_MS);
    return () => {
      stale = true;
      clearTimeout(timer);
    };
  }, [view, size]);
  useEffect(() => () => sharp?.bitmap.close(), [sharp]);

  return (
    <>
      <div className="frame" ref={frame}>
        <PagePicture picture={picture} view={view} size={size} />
        {sharp && <PagePicture picture={sharp} view={view} size={size} />}
        <svg
          ref={svg}
          data-testid="canvas"
          className={space ? 'grab' : undefined}
          viewBox={view.join(' ')}
          role="application"
          aria-label={copy.drawing(pageNo)}
          aria-describedby="canvas-help"
          tabIndex={0}
          onPointerDown={event => {
            if (event.button !== 1 && !(event.button === 0 && space)) return;
            event.preventDefault();
            event.currentTarget.setPointerCapture(event.pointerId);
            held.current = pointAt(event);
          }}
          onPointerMove={event => {
            if (!held.current) return;
            const [x, y] = pointAt(event);
            move(held.current[0] - x, held.current[1] - y);
          }}
          onPointerUp={() => (held.current = null)}
          onPointerCancel={() => (held.current = null)}
          onKeyDown={event => {
            const does: Partial<Record<string, () => void>> = {
              ' ': () => setSpace(true),
              '+': () => zoom(NOTCH),
              '=': () => zoom(NOTCH),
              '-': () => zoom(1 / NOTCH),
              '0': () => setView(whole(page)),
              ArrowLeft: () => move(-view[2] / 10, 0),
              ArrowRight: () => move(view[2] / 10, 0),
              ArrowUp: () => move(0, -view[3] / 10),
              ArrowDown: () => move(0, view[3] / 10),
            };
            const act = does[event.key];
            if (!act || event.ctrlKey || event.metaKey || event.altKey) return;
            event.preventDefault();
            act();
          }}
          onKeyUp={event => event.key === ' ' && setSpace(false)}
          onBlur={() => setSpace(false)}
        >
          <rect className="edge" width={page.widthPt} height={page.heightPt} />
          <g data-testid="overlay">{children}</g>
        </svg>
      </div>
      <div className="tools">
        <div role="group" aria-label={copy.zoom} dir="rtl">
          <button type="button" onClick={() => zoom(NOTCH)}>{copy.zoomIn}</button>
          <button type="button" onClick={() => zoom(1 / NOTCH)}>{copy.zoomOut}</button>
          <button type="button" onClick={() => setView(whole(page))}>{copy.fit}</button>
        </div>
        <p id="canvas-help" dir="rtl">{copy.help}</p>
      </div>
    </>
  );
}

/** A picture of the page, in its place under the svg whatever the view has become since it was drawn. */
function PagePicture({ picture: { bitmap, box }, view, size }: { picture: Picture; view: Box; size: Size }) {
  const canvas = useRef<HTMLCanvasElement>(null);
  useLayoutEffect(() => {
    Object.assign(canvas.current!, { width: bitmap.width, height: bitmap.height });
    canvas.current!.getContext('2d')!.drawImage(bitmap, 0, 0);
  }, [bitmap]);
  const { scale, originX, originY } = layout(view, size);
  // A transform, because left, top, width and height are rounded to whole CSS pixels.
  const css = (pixels: number) => pixels / devicePixelRatio;
  const transform = `translate(${css(originX + box[0] * scale)}px, ${css(originY + box[1] * scale)}px) scale(${css((box[2] * scale) / bitmap.width)}, ${css((box[3] * scale) / bitmap.height)})`;
  return <canvas ref={canvas} style={{ transform }} data-box={box.join(' ')} aria-hidden="true" />;
}
