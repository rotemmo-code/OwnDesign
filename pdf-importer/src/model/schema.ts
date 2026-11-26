import { z } from 'zod';
import { MAX_FILE_BYTES, MAX_PAGES } from '../limits';
import type { Project, Pt } from './types';

// Otherwise zod tries whether it may turn text into code, and the CSP reports the attempt as a violation.
z.config({ jitless: true });

/** Limits of a project file. The model refuses what would exceed them, so that every saved file opens again. */
export const CAPS = {
  walls: 5_000,
  openings: 5_000,
  separators: 1_000,
  rooms: 1_000,
  /** Of one room. */
  holes: 200,
  /** Of one ring. */
  points: 2_000,
  archive: 200,
  dims: 200,
  clouds: 500,
  colors: 32,
  /** Characters; also of a colour's label. */
  name: 200,
  /** Characters. */
  note: 500,
  /** mm, either side of 0. */
  coordinate: 1e6,
} as const;
/** Limits of single values, in mm. The model's actions use the same ones. */
export const LIMITS = {
  wallLength: 10,
  thicknessMin: 20,
  thicknessMax: 1_000,
  finishMax: 200,
  separatorLength: 1,
  /** Taken off the least lengths, so that exactly 10 mm passes at every angle. */
  tolerance: 0.01,
} as const;

const mm = z.number().min(-CAPS.coordinate).max(CAPS.coordinate);
const positive = z.number().positive().max(CAPS.coordinate);
const pt = z.strictObject({ x: mm, y: mm });
const vec = z.tuple([mm, mm]);
const name = z.string().max(CAPS.name);
// 'none' is an answer to the mamad question; 'constructor' is found on every object that lacks it.
const id = z
  .string()
  .regex(/^[a-z0-9-]{1,40}$/)
  .refine(s => s !== 'none' && s !== 'constructor', 'reserved id');
const long = (least: number) => (line: { a: Pt; b: Pt }) =>
  Math.hypot(line.b.x - line.a.x, line.b.y - line.a.y) >= least - LIMITS.tolerance;
const unique = (values: string[]) => new Set(values).size === values.length;

const status = z.enum(['kept', 'removed', 'new', 'moved']).optional();
const finish = z.number().int().min(1).max(LIMITS.finishMax).nullable();
const wall = z
  .strictObject({
    id,
    a: pt,
    b: pt,
    thickness: z.number().min(LIMITS.thicknessMin).max(LIMITS.thicknessMax),
    finishA: finish,
    finishB: finish,
    finishStart: finish.optional(),
    finishEnd: finish.optional(),
    source: z.enum(['detected', 'manual']),
    review: z.boolean(),
    status,
    from: z.strictObject({ a: pt, b: pt }).optional(),
  })
  .refine(long(LIMITS.wallLength), 'wall too short');
const opening = z.strictObject({
  id,
  wallId: id,
  offset: mm,
  width: positive,
  kind: z.enum(['door', 'entry', 'window', 'passage']),
  review: z.boolean(),
  confirmed: z.boolean(),
  released: z.boolean().optional(),
  status,
  fromOffset: mm.optional(),
});
const separator = z.strictObject({ id, a: pt, b: pt }).refine(long(LIMITS.separatorLength), 'separator too short');
const ring = z.array(pt).min(3).max(CAPS.points);
const room = z
  .strictObject({
    id,
    name,
    boundary: ring,
    holes: z.array(ring).max(CAPS.holes),
    isMamad: z.boolean(),
    inApartment: z.boolean(),
    outdoor: z.boolean(),
  })
  .refine(r => !(r.isMamad && r.outdoor), 'the mamad cannot be outdoors');
const state = z
  .strictObject({
    walls: z.array(wall).max(CAPS.walls),
    openings: z.array(opening).max(CAPS.openings),
    separators: z.array(separator).max(CAPS.separators),
    rooms: z.array(room).max(CAPS.rooms),
  })
  .refine(s => unique([...s.walls, ...s.openings, ...s.separators, ...s.rooms].map(x => x.id)), 'id used twice')
  .refine(s => {
    const walls = new Set(s.walls.map(w => w.id));
    return s.openings.every(o => walls.has(o.wallId));
  }, 'opening without a wall')
  .refine(s => s.rooms.filter(r => r.isMamad).length <= 1, 'more than one mamad');
const existingState = state.refine(
  s =>
    s.walls.every(w => w.status === undefined && w.from === undefined) &&
    s.openings.every(o => o.status === undefined && o.fromOffset === undefined),
  'planned change in the existing state',
);
const plannedState = state.refine(
  s => [...s.walls, ...s.openings].every(x => x.status !== undefined),
  'planned item without a status',
);
const wallClass = z.record(id, z.enum(['fixed', 'changeable', 'unknown']));
const calibration = z.strictObject({
  scale: positive,
  mmPerPt: positive,
  offsetMm: mm,
  chosen: z.literal([50, 100]),
  dims: z.array(z.strictObject({ a: vec, b: vec, writtenMm: mm })).max(CAPS.dims),
  verified: z.boolean(),
});

export const ProjectSchema = z
  .strictObject({
    version: z.literal(1),
    name,
    pdfBase64: z.base64().max(Math.ceil(MAX_FILE_BYTES / 3) * 4),
    page: z.number().int().min(1).max(MAX_PAGES),
    calibration,
    plaster: z.enum(['none', 'line', 'inWall', 'unknown']).nullable(),
    wallClass,
    existing: existingState,
    approved: z.boolean(),
    mamad: z.union([z.literal('none'), id]).nullable(),
    planned: plannedState.nullable(),
    // precision: what toISOString writes; without it the decimals have no limit
    plannedArchive: z
      .array(z.strictObject({ savedAt: z.iso.datetime({ precision: 3 }), state: plannedState, wallClass, calibration }))
      .max(CAPS.archive),
    changeableWarningShown: z.boolean(),
    envelope: z.enum(['released', 'confirmed']).optional(),
    clouds: z
      .array(z.strictObject({ id, a: pt, b: pt, note: z.string().max(CAPS.note), source: z.enum(['manual', 'suggested']) }))
      .max(CAPS.clouds)
      .refine(clouds => unique(clouds.map(c => c.id)), 'cloud id used twice'),
    sourceColors: z
      .array(z.strictObject({ hex: z.string().regex(/^#[0-9a-f]{6}$/), label: name }))
      .max(CAPS.colors)
      .refine(colors => unique(colors.map(c => c.hex)), 'colour listed twice'),
  })
  .refine(p => {
    const answer = p.mamad === 'none' ? null : p.mamad;
    const marked = p.existing.rooms.find(r => r.isMamad)?.id ?? null;
    return marked === answer && (p.planned === null || p.planned.rooms.some(r => r.isMamad) === (answer !== null));
  }, 'the mamad does not match the rooms')
  .refine(p => p.planned === null || p.approved, 'a plan without an approved existing state')
  .refine(p => !p.approved || p.mamad !== null, 'approved without an answer about the mamad');

/** Compile-time: the schema and the types are the same type, optional fields included. */
type Same<A, B> = (<T>() => T extends A ? 1 : 2) extends <T>() => T extends B ? 1 : 2 ? true : false;
export const schemaMatchesTypes: Same<z.infer<typeof ProjectSchema>, Project> = true;
