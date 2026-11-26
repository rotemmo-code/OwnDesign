import { type DragEvent, useRef, useState } from 'react';
import { copy } from '../copy';
import { MAX_FILE_BYTES } from '../limits';
import type { ExtractedPage } from '../pdf/extract';
import { openPdf, type PdfSession } from '../pdf/openPdf';
import type { Picture } from '../pdf/render';
import { Canvas } from './Canvas';
import './editor.css';
import { Upload } from './Upload';

type Shown = { pageNo: number; page: ExtractedPage; picture: Picture };
type Opened = Awaited<ReturnType<typeof openPdf>>;

export function App() {
  const [fileName, setFileName] = useState('');
  const [session, setSession] = useState<PdfSession | null>(null);
  const [shown, setShown] = useState<Shown | null>(null);
  const [busy, setBusy] = useState(false);
  const [problem, setProblem] = useState('');
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
    setProblem('');
    setBusy(true);
    const { clientWidth, clientHeight } = drawing.current!;
    const read = await from.show(pageNo, Math.max(1, clientWidth * devicePixelRatio), Math.max(1, clientHeight * devicePixelRatio));
    if (mine !== turn.current) {
      if (read.ok) read.picture.bitmap.close(); // no longer wanted
      return;
    }
    setBusy(false);
    if (read.ok) return setShown({ pageNo, page: read.page, picture: read.picture });
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
      {/* ltr: the drawing never mirrors with the RTL page */}
      <div dir="ltr" data-testid="drawing" ref={drawing}>
        {shown && <Canvas {...shown} draw={draw} />}
      </div>
    </main>
  );
}
