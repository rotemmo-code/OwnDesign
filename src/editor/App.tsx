import { type DragEvent, useEffect, useMemo, useRef, useState } from 'react';
import { copy } from '../copy';
import { MAX_FILE_BYTES } from '../limits';
import type { Plaster } from '../model/types';
import type { ExtractedPage } from '../pdf/extract';
import { openPdf, type PdfSession } from '../pdf/openPdf';
import type { Picture } from '../pdf/render';
import type { Calibration } from '../shared';
import { pdfToBase64 } from '../storage/projectFile';
import { useCalibrate } from './Calibrate';
import { Canvas } from './Canvas';
import { useEditor } from './Editor';
import './editor.css';
import { useMeasure } from './MeasureTool';
import { snapIndex } from './snap';
import { Upload } from './Upload';
import { newProject, type Store, useProject } from './useProject';

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
  const bytes = useRef<ArrayBuffer | null>(null); // of the file open now: the project keeps a copy of the PDF
  const store = useProject();
  const project = store.project;
  const latest = useRef(store);
  latest.current = store;

  // Ctrl+Z, Ctrl+Y and Ctrl+Shift+Z, but not while typing: a field keeps its own undo
  useEffect(() => {
    const keys = (event: KeyboardEvent) => {
      const typing = event.target instanceof HTMLElement && (event.target.isContentEditable || event.target.matches('input, textarea, select'));
      if (typing || !(event.ctrlKey || event.metaKey) || event.altKey || !latest.current.project) return;
      const key = event.key.toLowerCase();
      if (key === 'z' && !event.shiftKey) latest.current.undo();
      else if (key === 'y' || (key === 'z' && event.shiftKey)) latest.current.redo();
      else return;
      event.preventDefault();
    };
    addEventListener('keydown', keys);
    return () => removeEventListener('keydown', keys);
  }, []);

  async function open(file: File) {
    const mine = ++turn.current;
    opening.current?.abort();
    const stop = (opening.current = new AbortController());
    session?.close();
    setSession(null);
    setShown(null);
    setCalibration(null);
    setPlaster(null);
    store.clear();
    bytes.current = null;
    setProblem('');
    setFileName(file.name);
    setBusy(true);
    let opened: Opened = { ok: false, code: 'too-large' };
    if (file.size <= MAX_FILE_BYTES)
      opened = await file
        .arrayBuffer()
        .then(read => openPdf((bytes.current = read), stop.signal))
        .catch(() => ({ ok: false, code: 'failed' }));
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
    store.clear();
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

  /** The first accepted scale makes the project; a later one scales what was drawn, or is refused and the old one stays. */
  async function calibrated(next: Calibration) {
    if (latest.current.project) {
      const scaled = latest.current.dispatch({ type: 'rescale', calibration: next });
      if (!scaled.ok) return setProblem(copy.reason[scaled.reason] ?? copy.editor.reasonOther);
      return setCalibration(next);
    }
    setCalibration(next);
    const mine = turn.current;
    const page = shown;
    if (!bytes.current || !page) return;
    const pdfBase64 = await pdfToBase64(bytes.current).catch(() => null);
    if (mine !== turn.current || pdfBase64 === null) return; // another file or page was asked for meanwhile
    latest.current.load(newProject({ fileName, pdfBase64, page: page.pageNo, calibration: next, plaster, colours: page.page.colours }));
  }
  function answerPlaster(answer: Plaster) {
    setPlaster(answer);
    if (latest.current.project) latest.current.dispatch({ type: 'setPlaster', plaster: answer });
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
        {project && <ProjectBar store={store} />}
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
          <Work key={shown.turn} shown={shown} draw={draw} calibration={calibration} onCalibration={next => void calibrated(next)} plaster={plaster} onPlaster={answerPlaster} store={store} />
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
  store: Store;
};

/** The project's name, its two states and undo, in the header once there is a project. */
function ProjectBar({ store }: { store: Store }) {
  const e = copy.editor;
  const project = store.project!;
  const take = (input: HTMLInputElement) => {
    const name = input.value;
    if (!name.trim()) input.value = project.name; // an empty name is not taken
    else if (name !== project.name) store.dispatch({ type: 'setName', name });
  };
  return (
    <>
      <label className="project-name">
        {e.name}{' '}
        <input key={project.name} defaultValue={project.name} maxLength={200} onBlur={event => take(event.currentTarget)} onKeyDown={event => event.key === 'Enter' && take(event.currentTarget)} />
      </label>
      <div role="tablist" aria-label={e.states}>
        <button type="button" role="tab" aria-selected="true">{e.existing}</button>
        <button type="button" role="tab" aria-selected="false" disabled>{e.planned}</button>
      </div>
      <button type="button" disabled={!store.canUndo} onClick={store.undo}>{e.undo}</button>
      <button type="button" disabled={!store.canRedo} onClick={store.redo}>{e.redo}</button>
    </>
  );
}

/** The page with the tool of the moment: calibration until a scale is accepted, then measuring. */
export function Work({ shown: { page, pageNo, picture }, draw, calibration, onCalibration, plaster, onPlaster, store }: WorkProps) {
  const index = useMemo(() => snapIndex(page), [page]);
  // While recalibrating, the calibration there is stays (and with it the warning) until a new one replaces it; nothing measures meanwhile.
  const [again, setAgain] = useState(false);
  const calibrate = useCalibrate(index, plaster, onPlaster, next => {
    setAgain(false);
    onCalibration(next);
  });
  const measure = useMeasure(index, calibration, plaster, () => setAgain(true));
  const editor = useEditor({ store, page, plaster, measure });
  const [resetTurn, setResetTurn] = useState(0);
  const [zoom, setZoom] = useState(100);
  // the editor once there is a project, and never while recalibrating
  const edit = calibration && !again ? editor : null;
  const tool = edit ?? (calibration && !again ? measure : calibrate);
  return (
    <>
      <Canvas page={page} pageNo={pageNo} picture={picture} draw={draw} onPick={tool.pick} onHover={tool.hover} strength={edit?.strength} resetTurn={resetTurn} onZoom={setZoom}>
        {tool.marks}
      </Canvas>
      {/* after the drawing in the keyboard's order, at the top on the screen */}
      <div className="view-row" dir="rtl">
        {edit?.head}
        <span className="reset">
          <button type="button" onClick={() => setResetTurn(n => n + 1)}>{copy.editor.reset}</button>{' '}
          <span aria-label={copy.editor.zoom} data-testid="zoom">{copy.editor.percent(Math.round(zoom))}</span>
        </span>
      </div>
      <aside dir="rtl" className="panel">
        {tool.panel}
      </aside>
    </>
  );
}
