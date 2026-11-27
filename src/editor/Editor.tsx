import { type ReactNode, useEffect, useMemo, useRef, useState } from 'react';
import { copy } from '../copy';
import type { Action, Id, Plaster, Result } from '../model/types';
import type { ExtractedPage } from '../pdf/extract';
import type { Tool } from './Canvas';
import { derive, type Lock, Overlay } from './Overlay';
import { type Question, SidePanel } from './SidePanel';
import { snapIndex } from './snap';
import { type EditorCtx, type EditTool, type Selected, Toolbar, type ToolName, useDeleteTool, useSelectTool, useWallTool } from './Tools';
import { roomEvents, type Store } from './useProject';

const e = copy.editor;

/**
 * The editor of the existing state, as a tool of the page's one Canvas: its marks, its row of tools and its panel.
 * null until there is a project. It opens on the measure tool, which shows what the calibration found.
 */
export function useEditor({ store, page, plaster, measure, ptPerPx }: { store: Store; page: ExtractedPage; plaster: Plaster | null; measure: Tool; ptPerPx: number }) {
  // only the drawing's filled shapes: a wall's faces and ends are their edges, a hatch or a dimension line is not
  const fills = useMemo(() => snapIndex({ ...page, paths: page.paths.filter(p => p.fill) }), [page]);
  const [tool, setTool] = useState<ToolName>('measure');
  const [selected, setSelected] = useState<Selected>(null);
  const [message, setMessage] = useState('');
  const [question, setQuestion] = useState<Question | null>(null);
  const [mamadWas, setMamadWas] = useState<{ id: Id; name: string } | null>(null);
  const [strength, setStrength] = useState(100);
  const project = store.project;
  const k = project?.calibration.mmPerPt ?? 1;
  const derived = useMemo(() => project && derive(project), [project?.existing, project?.envelope, project?.wallClass]);
  // what the editor's own last action made; any other change (undo, redo, a load) leaves no message or question behind
  const ran = useRef<unknown>(null);
  useEffect(() => {
    if (!project || project === ran.current) return;
    setMessage('');
    const rooms = new Set(project.existing.rooms.map(r => r.id));
    setQuestion(q => (q && rooms.has(q.room) && (q.type === 'merge' || q.parts.every(part => rooms.has(part))) ? q : null));
  }, [project]);

  const run = (a: Action): Result => {
    const before = store.project!;
    const r = store.dispatch(a);
    if (r.ok) ran.current = r.project;
    if (!r.ok) {
      setMessage(copy.reason[r.reason] ?? e.reasonOther);
      return r;
    }
    const events = roomEvents(before.existing, r.project.existing, r.notice);
    const name = (id: Id) => before.existing.rooms.find(x => x.id === id)?.name || e.unnamed;
    const [split] = events.split;
    const [merge] = events.merge;
    // the answer to a question closes it; any other accepted edit closes it too, and the larger part keeps the name
    if (split) setQuestion({ type: 'split', room: split.room, parts: split.parts, name: name(split.room) });
    else if (merge) setQuestion({ type: 'merge', room: merge.room, names: merge.from.map(name).join(', ') });
    else setQuestion(null);
    setMessage(
      events.gone.length ? e.gone(events.gone.map(x => x.name || e.unnamed).join(', '))
      : r.notice === 'load-bearing-warning' ? e.loadBearing
      : r.notice === 'plaster-in-wall' ? e.plasterInWall
      : '',
    );
    if (selected && !(selected.kind === 'wall' ? r.project.existing.walls : r.project.existing.rooms).some(x => x.id === selected.id)) setSelected(null);
    return r;
  };
  const ctx: EditorCtx | null = project && derived && { project, derived, run, k, select: setSelected, say: setMessage };
  // the hooks run every time, with or without a project, so that their state keeps its place
  const stub = { project: null, derived: null } as unknown as EditorCtx;
  const select = useSelectTool(ctx ?? stub);
  const remove = useDeleteTool(ctx ?? stub);
  const wall = useWallTool(ctx ?? stub, fills, plaster, ptPerPx * k);
  if (!project || !derived || !ctx) return null;

  const tools: Record<ToolName, EditTool> = { select, wall, remove, measure };
  const active = tools[tool];
  const fix = (lock: Lock) => {
    if (lock === 'envelope') return void run({ type: 'x.releaseEnvelope' });
    const room = project.existing.rooms.find(r => r.isMamad);
    if (room && run({ type: 'setMamad', room: null }).ok) setMamadWas({ id: room.id, name: room.name || e.unnamed });
  };
  const confirmMamad = () => {
    if (!mamadWas) return;
    if (!project.existing.rooms.some(r => r.id === mamadWas.id)) return setMessage(e.mamadChanged);
    // kept: should an undo take the mark back again, the row asks again
    run({ type: 'setMamad', room: mamadWas.id });
  };
  const marks = (ptPerPx: number): ReactNode => (
    <Overlay
      project={project}
      derived={derived}
      k={k}
      ptPerPx={ptPerPx}
      selected={selected}
      preview={active.preview?.(ptPerPx)}
      marks={tool === 'measure' ? measure.marks(ptPerPx) : active.marks?.(ptPerPx)}
      parts={question?.type === 'split' ? question.parts : []}
    />
  );
  return {
    pick: active.pick,
    hover: active.hover,
    marks,
    strength,
    head: (
      <Toolbar
        tool={tool}
        onTool={next => {
          setTool(next);
          if (next !== 'select') setSelected(null);
        }}
        strength={strength}
        onStrength={setStrength}
      />
    ),
    panel: (
      <SidePanel
        c={ctx}
        selected={selected}
        message={message}
        question={question}
        onQuestionDone={() => setQuestion(null)}
        mamadWas={mamadWas}
        onFix={fix}
        onConfirmMamad={confirmMamad}
        tool={active.panel}
        plaster={plaster}
      />
    ),
  };
}
