import { existingHandlers } from './existing';
import { type Change, type Handler, type Handlers, Refused } from './rules';
import { ProjectSchema } from './schema';
import type { Action, Project, Reason, Result } from './types';

export { type Change, type Handler, Refused, refuse } from './rules';

const HANDLERS: Handlers = { ...existingHandlers };

/** The reason for the first thing the file schema refuses. */
function reasonOf(issue: { code: string; origin?: string; expected?: string }): Reason {
  if (issue.code === 'too_big' && issue.origin === 'array') return 'too-many';
  if (issue.code === 'too_big' && issue.origin === 'string') return 'text-too-long';
  if (issue.code === 'invalid_type' && issue.expected === 'number') return 'invalid-number';
  if (issue.code === 'custom' || issue.origin === 'number') return 'invalid-geometry';
  return 'invalid-action';
}

/**
 * The only way the project changes. Pure apart from new ids; never throws; the input is never changed and must itself
 * pass ProjectSchema. Every accepted project passes it too, so that a saved file always opens again.
 */
export function apply(project: Project, action: Action): Result {
  const type = (action as { type?: unknown } | null)?.type;
  // hasOwn: 'constructor' or 'toString' would otherwise find Object's own functions
  if (typeof type !== 'string' || !Object.hasOwn(HANDLERS, type)) return { ok: false, reason: 'invalid-action' };
  let change: Change;
  try {
    change = (HANDLERS[type as Action['type']] as Handler<Action['type']>)(project, action);
  } catch (e) {
    return { ok: false, reason: e instanceof Refused ? e.reason : 'invalid-action' };
  }
  const next = change.project;
  // an archive this action did not touch was valid in the input; checking it again costs up to 0.3 s
  const checked = ProjectSchema.safeParse(next.plannedArchive === project.plannedArchive ? { ...next, plannedArchive: [] } : next);
  if (!checked.success) return { ok: false, reason: reasonOf(checked.error.issues[0]) };
  return change.notice === undefined ? { ok: true, project: next } : { ok: true, project: next, notice: change.notice };
}
