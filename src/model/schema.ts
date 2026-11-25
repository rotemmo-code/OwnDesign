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
const long = (least: number) => (line: { a: Pt; b: Pt }) => Math.hypot(line.b.x - line.a.x, line.b.y - line.a.y) >= least;
const unique = (values: string[]) => new Set(values).size === values.length;

/**
 * Stops at the first bad item. zod would keep an issue for each of them: a hostile file could fill the memory, and from
 * about 120,000 issues safeParse throws instead of answering.
 */
function take<S extends z.ZodType>(item: S, values: Iterable<unknown>, ctx: z.RefinementCtx): z.output<S>[] {
  const taken: z.output<S>[] = [];
  for (const value of values) {
    const result = item.safeParse(value);
    if (!result.success) {
      ctx.addIssue('invalid item');
      break;
    }
    taken.push(result.data);
  }
  return taken;
}
const list = <S extends z.ZodType>(item: S, max: number) =>
  z
    .array(z.unknown())
    .max(max)
    .transform((values, ctx) => take(item, values, ctx));

const status = z.enum(['kept', 'removed', 'new', 'moved']).optional();
const finish = z.number().int().min(1).max(200).nullable();
const wall = z
  .strictObject({
    id,
    a: pt,
    b: pt,
    thickness: z.number().min(20).max(1000),
    finishA: finish,
    finishB: finish,
    source: z.enum(['detected', 'manual']),
    review: z.boolean(),
    status,
    from: z.strictObject({ a: pt, b: pt }).optional(),
  })
  .refine(long(10), 'wall shorter than 10 mm');
const opening = z.strictObject({
  id,
  wallId: id,
  offset: mm,
  width: positive,
  kind: z.enum(['door', 'entry', 'window', 'passage']),
  review: z.boolean(),
  status,
  fromOffset: mm.optional(),
});
const separator = z.strictObject({ id, a: pt, b: pt }).refine(long(1), 'separator shorter than 1 mm');
const ring = z.array(pt).min(3).max(CAPS.points);
const room = z
  .strictObject({
    id,
    name,
    boundary: ring,
    holes: list(ring, CAPS.holes),
    isMamad: z.boolean(),
    inApartment: z.boolean(),
    outdoor: z.boolean(),
  })
  .refine(r => !(r.isMamad && r.outdoor), 'the mamad cannot be outdoors');
const state = z
  .strictObject({
    walls: list(wall, CAPS.walls),
    openings: list(opening, CAPS.openings),
    separators: list(separator, CAPS.separators),
    rooms: list(room, CAPS.rooms),
  })
  .refine(s => unique([...s.walls, ...s.openings, ...s.separators, ...s.rooms].map(x => x.id)), 'id used twice')
  .refine(s => {
    const walls = new Set(s.walls.map(w => w.id));
    return s.openings.every(o => walls.has(o.wallId));
  }, 'opening without a wall')
  .refine(s => s.rooms.filter(r => r.isMamad).length <= 1, 'more than one mamad');
const classEntry = z.tuple([id, z.enum(['fixed', 'changeable', 'unknown'])]);
const wallClass = z
  .record(z.string(), z.unknown())
  .transform((classes, ctx) => Object.fromEntries(take(classEntry, Object.entries(classes), ctx)));

export const ProjectSchema = z
  .strictObject({
    version: z.literal(1),
    name,
    pdfBase64: z
      .string()
      .max(Math.ceil(MAX_FILE_BYTES / 3) * 4)
      .regex(/^[A-Za-z0-9+/]*={0,2}$/),
    page: z.number().int().min(1).max(MAX_PAGES),
    calibration: z.strictObject({
      scale: positive,
      mmPerPt: positive,
      offsetMm: mm,
      chosen: z.literal([50, 100]),
      dims: list(z.strictObject({ a: vec, b: vec, writtenMm: mm }), CAPS.dims),
      verified: z.boolean(),
    }),
    plaster: z.enum(['none', 'line', 'inWall', 'unknown']).nullable(),
    wallClass,
    existing: state,
    approved: z.boolean(),
    mamad: z.union([z.literal('none'), id]).nullable(),
    planned: state.nullable(),
    plannedArchive: list(z.strictObject({ savedAt: z.string().max(40), state, wallClass }), CAPS.archive),
    changeableWarningShown: z.boolean(),
    clouds: list(
      z.strictObject({ id, a: pt, b: pt, note: z.string().max(CAPS.note), source: z.enum(['manual', 'suggested']) }),
      CAPS.clouds,
    ).refine(clouds => unique(clouds.map(c => c.id)), 'cloud id used twice'),
    sourceColors: list(z.strictObject({ hex: z.string().regex(/^#[0-9a-f]{6}$/), label: name }), CAPS.colors).refine(
      colors => unique(colors.map(c => c.hex)),
      'colour listed twice',
    ),
  })
  .refine(p => {
    const answer = p.mamad === 'none' ? null : p.mamad;
    const marked = p.existing.rooms.find(r => r.isMamad)?.id ?? null;
    return marked === answer && (p.planned === null || p.planned.rooms.some(r => r.isMamad) === (answer !== null));
  }, 'the mamad does not match the rooms')
  .refine(p => p.planned === null || p.approved, 'a plan without an approved existing state');

/** Compile-time: the schema and the types are the same type, optional fields included. */
type Same<A, B> = (<T>() => T extends A ? 1 : 2) extends <T>() => T extends B ? 1 : 2 ? true : false;
export const schemaMatchesTypes: Same<z.infer<typeof ProjectSchema>, Project> = true;
