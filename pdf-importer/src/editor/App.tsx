import { type DragEvent, useMemo, useRef, useState } from 'react';
import { copy } from '../copy';
import { MAX_FILE_BYTES } from '../limits';
import type { Plaster } from '../model/types';
import type { ExtractedPage } from '../pdf/extract';
import { openPdf, type PdfSession } from '../pdf/openPdf';
import type { Picture } from '../pdf/render';
import type { Calibration } from '../shared';
import { useCalibrate } from './Calibrate';
import { Canvas } from './Canvas';
import './editor.css';
import { useMeasure } from './MeasureTool';
import { snapIndex } from './snap';
import { Upload } from './Upload';

/** turn: of the request that showed it, so that a page shown again starts afresh. */
type Shown = { pageNo: number; page: ExtractedPage; picture: Picture; turn: number };
type Opened = Awaited<ReturnType<typeof openPdf>>;

export function App() {
  const [fileName, setFileName] = useState('');
  const [session, setSession] = useState<PdfSession | null>(null);
  const [shown, setShown] = useState<Shown | null>(null);
  const [busy, setBusy] = useState(false);
  const [problem, setProblem] = useState('');
  /** null until a scale is accepted, or taken unverified through the button: nothing measures before. */
  const [calibration, setCalibration] = useState<Calibration | null>(null);
  const [plaster, setPlaster] = useState<Plaster | null>(null);
  const drawing = useRef<HTMLDivElement>(null);
  const turn = useRef(0); // of the last file or page asked for; the answer to an earlier one is dropped
  const opening = useRef<AbortController | null>(null); // ends the file before, even while it is still opening

  async function open(file: File) {
    const mine = ++turn.current;
    opening.current?.abort();
    const stop = (opening.current = new AbortController());
    session?.close();
    setSession(null);
    setShown(null);
    setCalibration(null);
    setPlaster(null);
    setProblem('');
    setFileName(file.name);
    setBusy(true);
    let opened: Opened = { ok: false, code: 'too-large' };
    if (file.size <= MAX_FILE_BYTES) opened = await file.arrayBuffer().then(bytes => openPdf(bytes, stop.signal)).catch(() => ({ ok: false, code: 'failed' }));
    if (mine !== turn.current) {
      if (opened.ok) opened.session.close();
      return;
    }
    setBusy(false);
    if (!opened.ok) return setProblem(copy.refused[opened.code]);
    setSession(opened.session);
    if (opened.session.pageCount === 1) await show(opened.session, 1);
  }

  async function show(from: PdfSession, pageNo: number) {
    const mine = ++turn.current;
    setShown(null);
    setCalibration(null);
    setProblem('');
    setBusy(true);
    const { clientWidth, clientHeight } = drawing.current!;
    const read = await from.show(pageNo, Math.max(1, clientWidth * devicePixelRatio), Math.max(1, clientHeight * devicePixelRatio));
    if (mine !== turn.current) {
      if (read.ok) read.picture.bitmap.close(); // no longer wanted
      return;
    }
    setBusy(false);
    if (read.ok) return setShown({ pageNo, page: read.page, picture: read.picture, turn: mine });
    setProblem(copy.refused[read.code]);
    if (read.code === 'timeout' || read.code === 'failed') {
      from.close(); // nothing more is asked of this reader
      setSession(null);
    }
  }

  async function draw(...part: Parameters<PdfSession['draw']>) {
    const mine = turn.current;
    const drawn = await session!.draw(...part);
    if (drawn.ok) return drawn.picture;
    if (mine === turn.current) setProblem(copy.notSharper);
    return null;
  }

  function drop(event: DragEvent) {
    event.preventDefault(); // else the browser leaves this page and opens the file
    const { files } = event.dataTransfer;
    if (files.length === 1) void open(files[0]);
    else if (files.length) setProblem(copy.oneFile);
  }

  const pages = session && session.pageCount > 1 ? Array.from({ length: session.pageCount }, (_, i) => i + 1) : [];
  const nothingYet = !session && !busy && !problem;
  return (
    <main className={nothingYet ? 'empty' : undefined} onDragOver={event => event.preventDefault()} onDrop={drop}>
      <title>{copy.title}</title>
      <header>
        {nothingYet && <p>{copy.start}</p>}
        <Upload onFile={file => void open(file)} />
        {nothingYet && <p>{copy.startLimits}</p>}
        <bdi>{fileName}</bdi>
        {pages.length > 0 && (
          <nav aria-label={copy.pages}>
            {pages.map(n => (
              <button key={n} type="button" aria-pressed={shown?.pageNo === n} onClick={() => void show(session!, n)}>
                {copy.page(n)}
              </button>
            ))}
          </nav>
        )}
      </header>
      <p role="status">{busy ? copy.opening : pages.length > 0 && !shown && !problem ? copy.whichPage(pages.length) : ''}</p>
      <p role="alert">{problem}</p>
      {calibration && !calibration.verified && <p className="unverified" aria-live="polite">{copy.unverified}</p>}
      {/* ltr: the drawing never mirrors with the RTL page */}
      <div dir="ltr" data-testid="drawing" ref={drawing}>
        {shown && (
          <Work key={shown.turn} shown={shown} draw={draw} calibration={calibration} onCalibration={setCalibration} plaster={plaster} onPlaster={setPlaster} />
        )}
      </div>
    </main>
  );
}

type WorkProps = {
  shown: Shown;
  draw: (...part: Parameters<PdfSession['draw']>) => Promise<Picture | null>;
  calibration: Calibration | null;
  onCalibration: (calibration: Calibration) => void;
  plaster: Plaster | null;
  onPlaster: (answer: Plaster) => void;
};

/** The page with the tool of the moment: calibration until a scale is accepted, then measuring. */
function Work({ shown: { page, pageNo, picture }, draw, calibration, onCalibration, plaster, onPlaster }: WorkProps) {
  const index = useMemo(() => snapIndex(page), [page]);
  // While recalibrating, the calibration there is stays (and with it the warning) until a new one replaces it; nothing measures meanwhile.
  const [again, setAgain] = useState(false);
  const calibrate = useCalibrate(index, plaster, onPlaster, next => {
    setAgain(false);
    onCalibration(next);
  });
  const measure = useMeasure(index, calibration, plaster, () => setAgain(true));
  const tool = calibration && !again ? measure : calibrate;
  return (
    <>
      <Canvas page={page} pageNo={pageNo} picture={picture} draw={draw} onPick={tool.pick} onHover={tool.hover}>
        {tool.marks}
      </Canvas>
      <aside dir="rtl" className="panel">
        {tool.panel}
      </aside>
    </>
  );
}
