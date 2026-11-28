// Bundled by probe.ts. Mounts the page's Work with a blank page and a store holding the project given, in place of the app.
import { useEffect } from 'react';
import { createRoot } from 'react-dom/client';
import { Work } from '../../src/editor/App';
import { useProject } from '../../src/editor/useProject';
import type { Project } from '../../src/model/types';
import type { ExtractedPage } from '../../src/pdf/extract';
import type { Picture } from '../../src/pdf/render';

function Probe({ project, page, picture }: { project: Project; page: ExtractedPage; picture: Picture }) {
  const store = useProject();
  useEffect(() => void store.load(project), []);
  return (
    <main>
      <div dir="ltr" data-testid="drawing">
        <Work shown={{ pageNo: 1, page, picture, turn: 1 }} draw={async () => null} calibration={project.calibration} onCalibration={() => {}} plaster={project.plaster} onPlaster={() => {}} store={store} />
      </div>
    </main>
  );
}

/** Replaces the app on this page with the editor over the project; resolves once it shows. */
export async function mount(project: Project) {
  const [width, height] = [842, 595];
  const page: ExtractedPage = { widthPt: width, heightPt: height, rotation: 0, paths: [], clips: [[{ rings: [[[0, 0], [width, 0], [width, height], [0, height]]], evenOdd: false }]], texts: [], layers: [], colours: [] };
  const canvas = new OffscreenCanvas(width, height);
  const context = canvas.getContext('2d')!;
  context.fillStyle = 'white';
  context.fillRect(0, 0, width, height);
  const picture: Picture = { bitmap: canvas.transferToImageBitmap(), box: [0, 0, width, height] };
  document.getElementById('root')?.remove();
  const host = document.createElement('div');
  document.body.append(host);
  createRoot(host).render(<Probe project={project} page={page} picture={picture} />);
}
