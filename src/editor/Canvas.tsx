import { type ReactNode, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { copy } from '../copy';
import type { ExtractedPage } from '../pdf/extract';
import type { Box, Picture } from '../pdf/render';
import type { Vec } from '../shared';
import { layout, moved, type Size, visiblePart, wheelFactor, whole, zoomed } from './view';

const NOTCH = 1.25; // one zoom step
const REST_MS = 120; // without a change before the picture is drawn again
const CLICK_PX = 5; // a left press that moves less is a click, one that moves more is a drag
const SNAP_PX = 8; // the snap radius on the screen

/** What a redraw covers. */
type Part = { box: Box; scale: number };

/** What a tool gives the drawing: what a click and the pointer do, its marks over the page (given view points per CSS pixel), its panel. */
export type Tool = { pick(at: Vec, radiusPt: number): void; hover(at: Vec | null, radiusPt: number): void; marks(ptPerPx: number): ReactNode; panel: ReactNode };

type Props = {
  page: ExtractedPage;
  pageNo: number;
  picture: Picture; // the whole page
  /** Draws a part of the page again; null when that failed. */
  draw(box: Box, scale: number): Promise<Picture | null>;
  /** A click, or Enter at the centre of the view: the point and the snap radius, in view points. */
  onPick?(at: Vec, radiusPt: number): void;
  /** Where the pointer is, for the snap preview; null when it left the drawing. */
  onHover?(at: Vec | null, radiusPt: number): void;
  /** In view points; a function gets view points per CSS pixel, for marks of one size on the screen. */
  children?: ReactNode | ((ptPerPx: number) => ReactNode);
  /** The contractor's page from 20 to 100 % strength under the draft; never saved. */
  strength?: number;
  /** A new number puts the whole page back in the frame, centred: what "כל העמוד" and the key 0 do too. */
  resetTurn?: number;
  /** The zoom in percent: 100 = the whole page fits the frame. */
  onZoom?(percent: number): void;
};

/** The page, and over it whatever is drawn in view points. */
export function Canvas({ page, pageNo, picture, draw, onPick, onHover, children, strength = 100, resetTurn = 0, onZoom }: Props) {
  const frame = useRef<HTMLDivElement>(null);
  const svg = useRef<SVGSVGElement>(null);
  const [view, setView] = useState<Box>(() => whole(page));
  const [size, setSize] = useState<Size>([1, 1]);
  const [sharp, setSharp] = useState<Picture | null>(null);
  const [grab, setGrab] = useState(false); // space is down over the drawing
  const [keyed, setKeyed] = useState(false); // the keyboard moved the view last: show the point that Enter places
  const [dragging, setDragging] = useState(false);
  const pointer = useRef<{ clientX: number; clientY: number } | null>(null); // over the drawing, else null
  const space = useRef(false);
  const hovered = useRef(false);
  const tabbed = useRef<EventTarget | null>(null); // the control the keyboard moved the focus to
  const held = useRef<Vec | null>(null); // the point of the page under the pointer, while it is dragged
  const pressed = useRef<{ x: number; y: number; at: Vec } | null>(null); // a left press, not yet a click or a drag
  // One redraw at a time, and then only of the newest view: a slow page takes seconds for each.
  const queue = useRef<{ busy: boolean; next: Part | null; gone: boolean }>({ busy: false, next: null, gone: false });

  const pointAt = (event: { clientX: number; clientY: number }): Vec => {
    const { x, y } = new DOMPoint(event.clientX, event.clientY).matrixTransform(svg.current!.getScreenCTM()!.inverse());
    return [x, y];
  };
  const radius = () => SNAP_PX / svg.current!.getScreenCTM()!.a; // CSS pixels per view point
  const zoom = (factor: number) => setView(old => zoomed(old, page, [old[0] + old[2] / 2, old[1] + old[3] / 2], factor));
  const move = (dx: number, dy: number) => setView(old => moved(old, [dx, dy]));
  /** The one whole-page view: the reset button, "כל העמוד" and the key 0. */
  const fit = () => setView(whole(page));
  useEffect(() => void (resetTurn && fit()), [resetTurn]);
  useEffect(() => onZoom?.((page.widthPt / view[2]) * 100), [view, onZoom]);

  useLayoutEffect(() => {
    const measure = () => {
      const { width, height } = frame.current!.getBoundingClientRect();
      setSize([width * devicePixelRatio, height * devicePixelRatio]);
    };
    const observer = new ResizeObserver(measure);
    try {
      observer.observe(frame.current!, { box: 'device-pixel-content-box' }); // also when the window moves to a screen of another density
    } catch {
      observer.observe(frame.current!);
    }
    measure();
    return () => observer.disconnect();
  }, []);

  useEffect(() => {
    const element = svg.current!;
    element.focus({ preventScroll: true });
    const wheel = (event: WheelEvent) => {
      event.preventDefault(); // else Ctrl and the wheel zoom the whole window; React listens too passively for this
      const at = pointAt(event);
      const factor = wheelFactor(event);
      setView(old => zoomed(old, page, at, factor));
    };
    // Over the drawing, space drags, also right after a button was clicked, and presses no button. It stays with a field and with a
    // control the keyboard moved to. :focus-visible is read on focusin: Chromium gives it to a clicked button too once a key is down.
    const focused = ({ target }: FocusEvent) => (tabbed.current = target instanceof Element && target.matches(':focus-visible') ? target : null);
    const keeps = (target: EventTarget | null) =>
      target !== svg.current && (target === tabbed.current || (target instanceof HTMLElement && (target.isContentEditable || target.matches('input, textarea, select'))));
    const keys = (event: KeyboardEvent) => {
      if (event.key !== ' ' || (event.type === 'keydown' ? !hovered.current || keeps(event.target) : !space.current)) return;
      event.preventDefault();
      setGrab((space.current = event.type === 'keydown'));
    };
    const away = () => setGrab((space.current = false));
    element.addEventListener('wheel', wheel, { passive: false });
    addEventListener('focusin', focused);
    addEventListener('keydown', keys);
    addEventListener('keyup', keys);
    addEventListener('blur', away);
    return () => {
      element.removeEventListener('wheel', wheel);
      removeEventListener('focusin', focused);
      removeEventListener('keydown', keys);
      removeEventListener('keyup', keys);
      removeEventListener('blur', away);
      queue.current.gone = true;
    };
  }, []);

  async function sharpen(part: Part) {
    const wait = queue.current;
    wait.next = part;
    if (wait.busy) return;
    wait.busy = true;
    try {
      for (let todo: Part | null = part; todo && !wait.gone; todo = wait.next) {
        wait.next = null;
        const drawn = await draw(todo.box, todo.scale);
        if (drawn && wait.gone) drawn.bitmap.close();
        else if (drawn) setSharp(drawn);
      }
    } finally {
      wait.busy = false; // a draw that throws must not stop the next views
    }
  }

  // The view moved under a pointer that did not: what a click there takes has changed, and the preview must show it, in the same frame.
  useLayoutEffect(() => {
    if (pointer.current && !held.current) onHover?.(pointAt(pointer.current), radius());
  }, [view, size]);

  useEffect(() => {
    const part = visiblePart(view, size, page);
    if (!part) return;
    const timer = setTimeout(() => void sharpen(part), REST_MS);
    return () => clearTimeout(timer);
  }, [view, size]);

  const ptPerPx = devicePixelRatio / layout(view, size).scale;
  return (
    <>
      <div className="frame" ref={frame} style={strength === 100 ? undefined : { ['--plan' as string]: strength / 100 }}>
        <PagePicture picture={picture} view={view} size={size} />
        {sharp && <PagePicture picture={sharp} view={view} size={size} />}
        <svg
          ref={svg}
          data-testid="canvas"
          className={grab || dragging ? 'grab' : undefined}
          viewBox={view.join(' ')}
          role="application"
          aria-label={copy.drawing(pageNo)}
          aria-describedby="canvas-help"
          tabIndex={0}
          onPointerEnter={() => (hovered.current = true)}
          onPointerLeave={() => {
            hovered.current = false;
            pointer.current = null;
            onHover?.(null, 0);
          }}
          onPointerDown={event => {
            if (event.button !== 0 && event.button !== 1) return;
            event.currentTarget.setPointerCapture(event.pointerId);
            if (event.button === 0 && !space.current) return void (pressed.current = { x: event.clientX, y: event.clientY, at: pointAt(event) });
            event.preventDefault(); // the middle button would start the browser's own scrolling
            held.current = pointAt(event);
            setDragging(true);
          }}
          onPointerMove={event => {
            setKeyed(false);
            pointer.current = { clientX: event.clientX, clientY: event.clientY };
            const down = pressed.current;
            if (down && Math.hypot(event.clientX - down.x, event.clientY - down.y) >= CLICK_PX) {
              held.current = down.at; // the press becomes a drag of the point it began on
              pressed.current = null;
              setDragging(true);
            }
            if (!held.current) return onHover?.(pointAt(event), radius());
            const [x, y] = pointAt(event);
            move(held.current[0] - x, held.current[1] - y);
          }}
          onPointerUp={() => {
            if (pressed.current) onPick?.(pressed.current.at, radius());
            held.current = pressed.current = null;
            setDragging(false);
          }}
          onPointerCancel={() => {
            held.current = pressed.current = null;
            setDragging(false);
          }}
          onKeyDown={event => {
            const step = event.shiftKey ? 100 : 10; // Shift moves a hundredth of the view
            const does: Partial<Record<string, () => void>> = {
              '+': () => zoom(NOTCH),
              '=': () => zoom(NOTCH),
              '-': () => zoom(1 / NOTCH),
              '0': fit,
              ArrowLeft: () => move(-view[2] / step, 0),
              ArrowRight: () => move(view[2] / step, 0),
              ArrowUp: () => move(0, -view[3] / step),
              ArrowDown: () => move(0, view[3] / step),
              Enter: () => onPick?.([view[0] + view[2] / 2, view[1] + view[3] / 2], radius()),
            };
            const act = does[event.key];
            if (!act || event.ctrlKey || event.metaKey || event.altKey) return;
            event.preventDefault();
            setKeyed(true);
            act();
          }}
        >
          <rect className="edge" width={page.widthPt} height={page.heightPt} />
          <g data-testid="overlay">{typeof children === 'function' ? children(ptPerPx) : children}</g>
          {onPick && keyed && <Aim view={view} arm={10 * ptPerPx} />}
        </svg>
      </div>
      <div className="tools">
        <div role="group" aria-label={copy.zoom} dir="rtl">
          <button type="button" onClick={() => zoom(NOTCH)}>{copy.zoomIn}</button>
          <button type="button" onClick={() => zoom(1 / NOTCH)}>{copy.zoomOut}</button>
          <button type="button" onClick={fit}>{copy.fit}</button>
        </div>
        <p id="canvas-help" dir="rtl">{copy.help}</p>
      </div>
    </>
  );
}

/**
 * A picture of the page, in its place under the svg whatever the view has become since it was drawn. The canvas takes the bitmap over:
 * one copy in memory, freed with the canvas or with the next picture. So a picture can be shown once only.
 */
function PagePicture({ picture: { bitmap, box }, view, size }: { picture: Picture; view: Box; size: Size }) {
  const canvas = useRef<HTMLCanvasElement>(null);
  const [width, height] = useMemo(() => [bitmap.width, bitmap.height], [bitmap]); // a bitmap that was taken over has no size
  useLayoutEffect(() => {
    Object.assign(canvas.current!, { width, height }); // the bitmap does not set them
    const context = canvas.current!.getContext('bitmaprenderer')!;
    context.transferFromImageBitmap(bitmap);
    return () => context.transferFromImageBitmap(null);
  }, [bitmap]);
  const { scale, originX, originY } = layout(view, size);
  // A transform, because left, top, width and height are rounded to whole CSS pixels.
  const css = (pixels: number) => pixels / devicePixelRatio;
  const transform = `translate(${css(originX + box[0] * scale)}px, ${css(originY + box[1] * scale)}px) scale(${css((box[2] * scale) / width)}, ${css((box[3] * scale) / height)})`;
  return <canvas ref={canvas} style={{ transform }} data-box={box.join(' ')} aria-hidden="true" />;
}

/** The point that Enter places: the centre of the view, shown while the keyboard moved the view last. */
function Aim({ view: [x, y, width, height], arm }: { view: Box; arm: number }) {
  const [cx, cy] = [x + width / 2, y + height / 2];
  return <path className="aim" d={`M${cx - arm} ${cy}H${cx + arm}M${cx} ${cy - arm}V${cy + arm}`} aria-hidden="true" />;
}
