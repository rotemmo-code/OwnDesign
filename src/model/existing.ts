import { dist } from './geo';
import { computeRooms } from './rooms';
import {
  type Change,
  envelopeAllows,
  envelopeKept,
  envelopeLeaf,
  type Handlers,
  onLine,
  openingLock,
  openingsFit,
  refuse,
  separatorBoundsMamad,
  separatorEntersMamad,
  mamadAllows,
  mamadWallsKept,
  wallEntersMamad,
  wallFits,
} from './rules';
import { CAPS, LIMITS } from './schema';
import type { Id, Notice, Opening, Project, Pt, Room, RoomChange, State, Wall, WallMaterial } from './types';

const TOL = LIMITS.tolerance;
const num = (v: unknown): number => (typeof v === 'number' && Number.isFinite(v) ? v : refuse('invalid-number'));
/** A copy with x and y only, so that nothing else from the action reaches the project. */
function pt(p: unknown): Pt {
  const q = p as Partial<Pt> | null;
  const r = { x: num(q?.x), y: num(q?.y) };
  return Math.abs(r.x) > CAPS.coordinate || Math.abs(r.y) > CAPS.coordinate ? refuse('invalid-geometry') : r;
}
function text(t: unknown, least: number): string {
  if (typeof t !== 'string') return refuse('invalid-action');
  if (t.length > CAPS.name) refuse('text-too-long');
  return t.length < least ? refuse('invalid-action') : t;
}
const find = <T extends { id: Id }>(list: T[], id: unknown): T => list.find(x => x.id === id) ?? refuse('invalid-action');
const length = (w: { a: Pt; b: Pt }) => dist(w.a, w.b);
const MATERIALS: readonly unknown[] = ['gypsum', 'block', 'concrete', 'other'] satisfies WallMaterial[];
const material = (m: unknown): WallMaterial => (MATERIALS.includes(m) ? (m as WallMaterial) : refuse('invalid-action'));
const notice = (project: Project, n?: Notice): Change => (n === undefined ? { project } : { project, notice: n });
const withState = (p: Project, existing: State): Project => ({ ...p, existing });
const mamadLocked = (fact: boolean) => fact && refuse('mamad-locked');
/** The outer walls are locked unless the designer released them (8c). */
/** fact is asked only while the envelope is locked: it can be costly. */
const envelopeLocked = (p: Project, fact: () => boolean) => p.envelope !== 'released' && fact() && refuse('envelope-locked');
/** A wall that carries a locked window, entry door or mamad opening keeps its line and thickness (8c, rule 2). */
function openingsHold(s: State, old: Wall, w?: Wall) {
  const lock = s.openings.filter(o => o.wallId === old.id).map(o => openingLock(s, o)).find(r => r !== null);
  if (lock && (!w || !onLine(old, w))) refuse(lock);
}

/** mm: points this close are one point (rooms.ts). */
const HAIR = 0.03;
/** The same ring, whatever point it starts from and whichever way round it runs. */
function sameRing(f: Pt[], g: Pt[]): boolean {
  if (f.length !== g.length) return false;
  const start = g.findIndex(q => dist(q, f[0]) <= HAIR);
  if (start < 0) return false;
  const n = g.length;
  return [1, -1].some(step => f.every((p, i) => dist(p, g[(start + step * i + n * n) % n]) <= HAIR));
}
const sameRoom = (r: Room, q: Room | undefined) =>
  !!q && sameRing(r.boundary, q.boundary) && r.holes.length === q.holes.length && r.holes.every(h => q.holes.some(k => sameRing(h, k)));

/**
 * The recompute after a geometric change of the existing state: caps, the changed walls, the rooms, the mamad rules.
 * mustSplit: an added separator that cuts nothing is refused. mamadMayChange: only rescale, which scales everything;
 * otherwise the mamad's outline and holes must come out as they were (owner round 8), and so must the envelope while
 * it is locked (8c).
 */
export function rebuildExisting(
  p: Project,
  s: State,
  changed: Id[],
  { mustSplit = false, mamadMayChange = false }: { mustSplit?: boolean; mamadMayChange?: boolean } = {},
): Change {
  if (s.walls.length > CAPS.walls || s.separators.length > CAPS.separators) refuse('too-many');
  for (const id of changed) {
    const reason = wallFits(s, s.walls.find(w => w.id === id)!) ?? openingsFit(s, id, []);
    if (reason) refuse(reason);
  }
  let out: { rooms: Room[]; changes: RoomChange[] };
  try {
    out = computeRooms(s, s.rooms);
  } catch {
    return refuse('invalid-geometry');
  }
  const before = s.rooms.find(r => r.isMamad);
  if (before && !mamadMayChange && (!sameRoom(before, out.rooms.find(r => r.id === before.id)) || !mamadWallsKept(p.existing, s))) refuse('mamad-locked');
  const after = { ...s, rooms: out.rooms };
  if (p.envelope !== 'released' && !mamadMayChange && !envelopeKept(p.existing, after)) refuse('envelope-locked');
  const order = new Map(s.rooms.map((r, i) => [r.id, i]));
  let rooms = [...out.rooms].sort((x, y) => (order.get(x.id) ?? Infinity) - (order.get(y.id) ?? Infinity));
  let mamad = p.mamad;
  const marked = mamad === null || mamad === 'none' ? null : mamad;
  const gone = marked !== null && (!rooms.some(r => r.id === marked) || out.changes.some(c => c.type === 'merge' && c.from.includes(marked)));
  if (gone) {
    // M11: the question is asked again
    mamad = null;
    rooms = rooms.map(r => (r.isMamad ? { ...r, isMamad: false } : r));
  } else if (rooms.filter(r => r.isMamad).length > 1) refuse('mamad-split');
  if (mustSplit && !out.changes.some(c => c.type === 'split')) refuse('invalid-geometry');
  return notice({ ...p, existing: { ...s, rooms }, mamad }, out.changes.length ? { rooms: out.changes } : undefined);
}

const locked = (p: Project) => p.approved && refuse('existing-approved');

export const existingHandlers: Handlers = {
  'x.addWall': (p, a) => {
    locked(p);
    const s = p.existing;
    const w: Wall = { id: crypto.randomUUID(), a: pt(a.a), b: pt(a.b), thickness: num(a.thickness), finishA: null, finishB: null, source: 'manual', review: false };
    if (a.material !== undefined) w.material = material(a.material);
    mamadLocked(wallEntersMamad(s, w) || !mamadAllows.lay(s, w));
    envelopeLocked(p, () => !envelopeAllows.lay(s, w));
    return rebuildExisting(p, { ...s, walls: [...s.walls, w] }, [w.id]);
  },
  'x.deleteWall': (p, a) => {
    locked(p);
    const s = p.existing;
    const w = find(s.walls, a.id);
    mamadLocked(!mamadAllows.delete(s, w.id));
    envelopeLocked(p, () => !envelopeAllows.delete(s, w.id) || envelopeLeaf(s, w));
    openingsHold(s, w);
    const { [w.id]: _, ...wallClass } = p.wallClass;
    const next = { ...s, walls: s.walls.filter(x => x !== w), openings: s.openings.filter(o => o.wallId !== w.id) };
    return rebuildExisting({ ...p, wallClass }, next, []);
  },
  'x.setWall': (p, a) => {
    locked(p);
    const s = p.existing;
    const old = find(s.walls, a.id);
    const { material: _, ...bare } = old;
    const built: Wall = a.material === undefined ? old : a.material === null ? bare : { ...bare, material: material(a.material) };
    if (a.a === undefined && a.b === undefined && a.thickness === undefined) {
      if (a.material === undefined) return { project: p }; // nothing asked: nothing changes, not even the project object
      // what it is built of, not where: no lock, no recompute, nothing un-confirmed
      return { project: withState(p, { ...s, walls: s.walls.map(x => (x === old ? built : x)) }) };
    }
    const w: Wall = {
      ...built,
      a: a.a === undefined ? old.a : pt(a.a),
      b: a.b === undefined ? old.b : pt(a.b),
      thickness: a.thickness === undefined ? old.thickness : num(a.thickness),
    };
    const l = length(w);
    if (l < LIMITS.wallLength - TOL) refuse('invalid-geometry');
    // side A stays side A, so a finish never changes sides
    if ((w.b.x - w.a.x) * (old.b.x - old.a.x) + (w.b.y - w.a.y) * (old.b.y - old.a.y) <= 0) refuse('invalid-geometry');
    mamadLocked(!mamadAllows.set(s, old, w) || wallEntersMamad(s, w) || !mamadAllows.lay(s, w, old));
    envelopeLocked(p, () => !envelopeAllows.set(s, old, w) || !envelopeAllows.lay(s, w, old) || envelopeLeaf(s, old));
    openingsHold(s, old, w);
    // M13: when end a slides along the wall by shift, the openings stay where they are
    const shift = ((w.a.x - old.a.x) * (w.b.x - w.a.x) + (w.a.y - old.a.y) * (w.b.y - w.a.y)) / l;
    const openings = shift ? s.openings.map(o => (o.wallId === w.id ? { ...o, offset: o.offset - shift } : o)) : s.openings;
    return rebuildExisting(p, { ...s, walls: s.walls.map(x => (x === old ? w : x)), openings }, [w.id]);
  },
  'x.splitWall': (p, a) => {
    locked(p);
    const s = p.existing;
    const w = find(s.walls, a.id);
    const at = num(a.at);
    mamadLocked(!mamadAllows.split(s, w.id, at));
    envelopeLocked(p, () => !envelopeAllows.split(s, w.id, at) || envelopeLeaf(s, w));
    const l = length(w);
    if (at < LIMITS.wallLength - TOL || l - at < LIMITS.wallLength - TOL) refuse('invalid-geometry');
    const m = { x: w.a.x + ((w.b.x - w.a.x) * at) / l, y: w.a.y + ((w.b.y - w.a.y) * at) / l };
    // the new ends at m are joined: the end finishes stay where they were set
    const second: Wall = { ...w, id: crypto.randomUUID(), a: m, finishStart: null };
    const openings = s.openings.map(o => {
      if (o.wallId !== w.id || o.offset + o.width <= at + TOL) return o;
      return o.offset < at - TOL ? refuse('invalid-geometry') : { ...o, wallId: second.id, offset: Math.max(0, o.offset - at) };
    });
    const walls = s.walls.flatMap(x => (x === w ? [{ ...w, b: m, finishEnd: null }, second] : [x]));
    const wallClass = Object.hasOwn(p.wallClass, w.id) ? { ...p.wallClass, [second.id]: p.wallClass[w.id] } : p.wallClass;
    return rebuildExisting({ ...p, wallClass }, { ...s, walls, openings }, []);
  },
  'x.addOpening': (p, a) => {
    locked(p);
    const s = p.existing;
    const w = find(s.walls, a.wallId);
    const o: Opening = { id: crypto.randomUUID(), wallId: w.id, offset: num(a.offset), width: num(a.width), kind: a.kind, review: false, confirmed: true };
    return { project: withState(p, placed({ ...s, openings: [...s.openings, o] }, o)) };
  },
  'x.setOpening': (p, a) => {
    locked(p);
    const s = p.existing;
    const old = find(s.openings, a.id);
    const lock = openingLock(s, old);
    if (lock) refuse(lock);
    const o: Opening = {
      ...old,
      offset: a.offset === undefined ? old.offset : num(a.offset),
      width: a.width === undefined ? old.width : num(a.width),
      kind: a.kind ?? old.kind,
      confirmed: true,
    };
    return { project: withState(p, placed({ ...s, openings: s.openings.map(x => (x === old ? o : x)) }, o)) };
  },
  'x.deleteOpening': (p, a) => {
    locked(p);
    const o = find(p.existing.openings, a.id);
    const lock = openingLock(p.existing, o);
    if (lock) refuse(lock);
    return { project: withState(p, { ...p.existing, openings: p.existing.openings.filter(x => x !== o) }) };
  },
  'x.addSeparator': (p, a) => {
    locked(p);
    const line = { id: crypto.randomUUID(), a: pt(a.a), b: pt(a.b) };
    mamadLocked(separatorEntersMamad(p.existing, line));
    return rebuildExisting(p, { ...p.existing, separators: [...p.existing.separators, line] }, [], { mustSplit: true });
  },
  'x.deleteSeparator': (p, a) => {
    locked(p);
    const s = p.existing;
    const line = find(s.separators, a.id);
    mamadLocked(separatorBoundsMamad(s, line.id));
    return rebuildExisting(p, { ...s, separators: s.separators.filter(x => x !== line) }, []);
  },
  'x.clearReview': (p, a) => {
    locked(p);
    const s = p.existing;
    if (!s.walls.some(w => w.id === a.id) && !s.openings.some(o => o.id === a.id)) refuse('invalid-action');
    const walls = s.walls.map(w => (w.id === a.id ? { ...w, review: false } : w));
    return { project: withState(p, { ...s, walls, openings: s.openings.map(o => (o.id === a.id ? { ...o, review: false } : o)) }) };
  },
  'x.confirmOpenings': (p, a) => {
    locked(p);
    const s = p.existing;
    const ids = new Set(a.ids);
    if (!ids.size || [...ids].some(id => !s.openings.some(o => o.id === id))) refuse('invalid-action');
    // confirming locks again what was released
    const confirm = ({ released: _, ...o }: Opening): Opening => ({ ...o, confirmed: true, review: false });
    return { project: withState(p, { ...s, openings: s.openings.map(o => (ids.has(o.id) ? confirm(o) : o)) }) };
  },
  'x.releaseOpenings': (p, a) => {
    locked(p);
    const s = p.existing;
    const ids = new Set(a.ids);
    if (!ids.size || [...ids].some(id => !s.openings.some(o => o.id === id))) refuse('invalid-action');
    return { project: withState(p, { ...s, openings: s.openings.map(o => (ids.has(o.id) ? { ...o, released: true, confirmed: false } : o)) }) };
  },
  'x.confirmEnvelope': p => {
    locked(p);
    if (!p.existing.rooms.some(r => r.inApartment && !r.outdoor)) refuse('invalid-action');
    return { project: { ...p, envelope: 'confirmed' } };
  },
  'x.releaseEnvelope': p => {
    locked(p);
    return { project: { ...p, envelope: 'released' } };
  },
  'x.setRoom': (p, a) => {
    locked(p);
    const s = p.existing;
    const r = find(s.rooms, a.id);
    const n: Room = {
      ...r,
      name: a.name === undefined ? r.name : text(a.name, 0),
      inApartment: a.inApartment ?? r.inApartment,
      outdoor: a.outdoor ?? r.outdoor,
    };
    if (n.isMamad && n.outdoor) refuse('mamad-outdoor');
    const next = { ...s, rooms: s.rooms.map(x => (x === r ? n : x)) };
    const flipped = n.inApartment !== r.inApartment || n.outdoor !== r.outdoor;
    envelopeLocked(p, () => flipped && !envelopeKept(s, next));
    return { project: withState(p, next) };
  },
  'x.keepName': (p, a) => {
    locked(p);
    const s = p.existing;
    const [r, q] = [find(s.rooms, a.room), find(s.rooms, a.part)];
    if (r === q) refuse('invalid-action');
    // a mamad is never split, and a merge is answered with x.setRoom
    if (r.isMamad || q.isMamad) refuse('mamad-locked');
    // identity moves, the place stays: id and name change rooms
    const take = (x: Room, y: Room): Room => ({ ...x, id: y.id, name: y.name });
    const rooms = s.rooms.map(x => (x === r ? take(r, q) : x === q ? take(q, r) : x));
    return { project: withState(p, { ...s, rooms }) };
  },
  setMamad: (p, a) => {
    locked(p);
    const s = p.existing;
    const room = a.room;
    if (room !== null && room !== 'none' && find(s.rooms, room).outdoor) refuse('mamad-outdoor');
    const rooms = s.rooms.map(r => (r.isMamad === (r.id === room) ? r : { ...r, isMamad: r.id === room }));
    return { project: { ...p, mamad: room, existing: { ...s, rooms } } };
  },
  setName: (p, a) => ({ project: { ...p, name: text(a.name, 1) } }),
  setPlaster: (p, a) => ({ project: { ...p, plaster: a.plaster ?? refuse('invalid-action') } }),
  classify: (p, a) => {
    if (![p.existing, p.planned].some(s => s?.walls.some(w => w.id === a.wallId))) refuse('invalid-action');
    const first = a.cls === 'changeable' && !p.changeableWarningShown;
    const project = { ...p, wallClass: { ...p.wallClass, [a.wallId]: a.cls }, changeableWarningShown: p.changeableWarningShown || first };
    return notice(project, first ? 'load-bearing-warning' : undefined);
  },
  'n.setColorLabel': (p, a) => {
    if (!p.sourceColors.some(c => c.hex === a.hex)) refuse('invalid-action');
    const label = text(a.label, 0);
    return { project: { ...p, sourceColors: p.sourceColors.map(c => (c.hex === a.hex ? { ...c, label } : c)) } };
  },
  rescale: (p, a) => {
    locked(p);
    const mmPerPt = num(a.calibration?.mmPerPt);
    if (mmPerPt <= 0) refuse('invalid-number');
    const f = mmPerPt / p.calibration.mmPerPt;
    const q = { ...p, calibration: structuredClone(a.calibration) };
    if (f === 1) return { project: q };
    const P = (v: Pt): Pt => ({ x: v.x * f, y: v.y * f });
    const s = p.existing;
    const scaled: State = {
      walls: s.walls.map(w => ({ ...w, a: P(w.a), b: P(w.b), thickness: w.thickness * f })),
      openings: s.openings.map(o => ({ ...o, offset: o.offset * f, width: o.width * f })),
      separators: s.separators.map(x => ({ ...x, a: P(x.a), b: P(x.b) })),
      rooms: s.rooms.map(r => ({ ...r, boundary: r.boundary.map(P), holes: r.holes.map(h => h.map(P)) })),
    };
    // finishes are built thicknesses, not drawn ones; archived plans keep their own calibration
    return rebuildExisting({ ...q, clouds: p.clouds.map(c => ({ ...c, a: P(c.a), b: P(c.b) })) }, scaled, [], { mamadMayChange: true });
  },
};

/** The state with the opening o in it, when o fits its wall. */
function placed(next: State, o: Opening): State {
  if (o.width < 100) refuse('invalid-geometry');
  const reason = openingsFit(next, o.wallId, [o.id]);
  return reason ? refuse(reason) : next;
}
