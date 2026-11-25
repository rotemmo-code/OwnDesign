import { afterAll, expect, it } from 'vitest';
import type { Project, State } from '../../src/model/types';
import { boxProject, rect, wall } from '../fixtures/box';

// Counts every time text is turned into code while the schema is loaded, built and used.
const real = { Function: globalThis.Function, eval: globalThis.eval };
let codeFromText = 0;
const counted = <T extends object>(target: T): T =>
  new Proxy(target, {
    construct(f, args) {
      codeFromText++;
      return Reflect.construct(f as unknown as new () => object, args);
    },
    apply(f, self, args) {
      codeFromText++;
      return Reflect.apply(f as unknown as () => unknown, self, args);
    },
  });
Object.assign(globalThis, { Function: counted(real.Function), eval: counted(real.eval) });
afterAll(() => Object.assign(globalThis, real));
const { CAPS, LIMITS, ProjectSchema, schemaMatchesTypes } = await import('../../src/model/schema');

/** Whether a box project still parses after a change; the change may break its type on purpose. */
type Change = (p: any) => unknown;
const ok = (change: Change = () => {}): boolean => {
  const p = boxProject();
  change(p);
  return ProjectSchema.safeParse(p).success;
};
/** One answer per value. */
const each = <T>(values: T[], change: (value: T) => Change) => values.map(value => ok(change(value)));
const many = <T>(count: number, make: (i: number) => T): T[] => Array.from({ length: count }, (_, i) => make(i));
const line = (id: string, length: number) => ({ id, a: { x: 0, y: 0 }, b: { x: length, y: 0 } });
const cloud = (id: string, note = '') => ({ ...line(id, 9), note, source: 'suggested' });
const marked = (state: State, ...ids: string[]) => state.rooms.forEach(r => (r.isMamad = ids.includes(r.id)));
const items = (state: State) => [...state.walls, ...state.openings];
/** The existing state as startPlanned copies it. */
const plan = (p: Project): State => {
  const state = structuredClone(p.existing);
  for (const item of items(state)) item.status = 'kept';
  return state;
};
/** Approved, with room B as the mamad in both states. */
const withPlan: Change = p => {
  p.approved = true;
  p.mamad = 'room-b';
  marked(p.existing, 'room-b');
  p.planned = plan(p);
};
const archived = (p: Project) => ({ savedAt: new Date(0).toISOString(), state: plan(p), wallClass: {}, calibration: structuredClone(p.calibration) });

/** Every optional field and every list in use. */
function fullProject(): Project {
  const p = boxProject();
  withPlan(p);
  const planned = p.planned!;
  Object.assign(planned.walls[4], { status: 'moved', from: { a: { x: 1, y: 2 }, b: { x: 3, y: 4 } }, finishA: 20, finishB: 1, source: 'detected', review: true });
  planned.openings[0] = { ...planned.openings[0], status: 'moved', fromOffset: 900, confirmed: false };
  planned.separators.push(line('line', 1000));
  planned.rooms[0].holes.push(rect(1000, 1000, 1300, 1200));
  planned.rooms[0].outdoor = true;
  return {
    ...p,
    calibration: { ...p.calibration, dims: [{ a: [0, 0], b: [100, 50], writtenMm: 1970 }], verified: false },
    plaster: 'inWall',
    wallClass: { part: 'changeable', top: 'fixed', left: 'unknown' },
    plannedArchive: [{ ...archived(p), state: structuredClone(planned), wallClass: { part: 'changeable' }, calibration: { scale: 100, mmPerPt: (100 * 25.4) / 72, offsetMm: 30, chosen: 100, dims: [], verified: true } }],
    changeableWarningShown: true,
    clouds: [{ ...line('cloud', 9), note: 'x', source: 'manual' }],
    sourceColors: [{ hex: '#c0ffee', label: 'x' }],
  };
}

it('boxProject parses to an equal project', () => {
  expect(ProjectSchema.parse(boxProject())).toEqual(boxProject());
  expect(ProjectSchema.parse(JSON.parse(JSON.stringify(fullProject())))).toEqual(fullProject());
  expect(schemaMatchesTypes).toBe(true);
});

it('rejects NaN, Infinity, 1e6 + 1, a string where a number is expected, extra keys at every level', () => {
  // a value that passes, so that the others are refused for what they are
  const places: [good: number, put: (p: any, value: unknown) => unknown][] = [
    [5, (p, v) => (p.existing.walls[0].a.x = v)],
    [5, (p, v) => (p.existing.walls[0].b.y = v)],
    [100, (p, v) => (p.existing.walls[0].thickness = v)],
    [5, (p, v) => (p.existing.openings[0].offset = v)],
    [5, (p, v) => (p.existing.openings[0].width = v)],
    [5, (p, v) => (withPlan(p), (p.planned.openings[0].fromOffset = v))],
    [5, (p, v) => (p.existing.rooms[0].boundary[0].x = v)],
    [50, (p, v) => (p.calibration.scale = v)],
    [17, (p, v) => (p.calibration.mmPerPt = v)],
    [5, (p, v) => (p.calibration.offsetMm = v)],
    [5, (p, v) => (p.calibration.dims = [{ a: [0, v], b: [1, 1], writtenMm: 1 }])],
    [5, (p, v) => (p.calibration.dims = [{ a: [0, 0], b: [1, 1], writtenMm: v }])],
    [5, (p, v) => (p.clouds = [{ ...cloud('c'), a: { x: v, y: 0 } }])],
    [5, (p, v) => (p.existing.separators = [{ ...line('s', 9), a: { x: v, y: 0 } }])],
    [5, (p, v) => (withPlan(p), (p.planned.walls[0].from = { a: { x: v, y: 0 }, b: { x: 1, y: 1 } }))],
  ];
  for (const [i, [good, put]] of places.entries()) {
    expect(ok(p => put(p, good)), `place ${i}`).toBe(true);
    for (const value of [NaN, Infinity, -Infinity, 1e6 + 1, '5', null, true]) expect(ok(p => put(p, value)), `place ${i}, ${value}`).toBe(false);
  }
  expect(each([1e6, -1e6, 0, 0.1], v => p => (p.existing.walls[0].a.x = v))).toEqual([true, true, true, true]);
  expect(each([-1e6 - 1], v => p => (p.existing.walls[0].a.x = v))).toEqual([false]);

  const objects: ((p: any) => object)[] = [
    p => p,
    p => p.calibration,
    p => (p.calibration.dims = [{ a: [0, 0], b: [1, 1], writtenMm: 1 }])[0],
    p => p.existing,
    p => p.existing.walls[0],
    p => p.existing.walls[0].a,
    p => (withPlan(p), (p.planned.walls[0].from = { a: { x: 0, y: 0 }, b: { x: 1, y: 1 } })),
    p => p.existing.openings[0],
    p => (p.existing.separators = [line('s', 9)])[0],
    p => p.existing.rooms[0],
    p => p.existing.rooms[0].boundary[0],
    p => (p.clouds = [cloud('c')])[0],
    p => (p.sourceColors = [{ hex: '#abcdef', label: '' }])[0],
    p => (p.plannedArchive = [archived(p)])[0],
  ];
  for (const [i, pick] of objects.entries()) {
    expect(ok(p => pick(p)), `object ${i}`).toBe(true);
    expect(ok(p => Object.assign(pick(p), { extra: 1 })), `object ${i}`).toBe(false);
  }
});

it('rejects 5,001 walls, 5,001 openings, 1,001 rooms, 1,001 separators; accepts the cap', () => {
  const walls = (count: number): Change => p => Object.assign(p.existing, { walls: many(count, i => wall(`w${i}`, 0, 0, 100, 0, 100)), openings: [] });
  const openings = (count: number): Change => p => (p.existing.openings = many(count, i => ({ ...p.existing.openings[0], id: `o${i}` })));
  const rooms = (count: number): Change => p => (p.existing.rooms = many(count, i => ({ ...p.existing.rooms[0], id: `r${i}` })));
  const separators = (count: number): Change => p => (p.existing.separators = many(count, i => line(`s${i}`, 9)));
  expect([CAPS.walls, CAPS.openings, CAPS.rooms, CAPS.separators]).toEqual([5000, 5000, 1000, 1000]);
  expect(each([5000, 5001], walls)).toEqual([true, false]);
  expect(each([5000, 5001], openings)).toEqual([true, false]);
  expect(each([1000, 1001], rooms)).toEqual([true, false]);
  expect(each([1000, 1001], separators)).toEqual([true, false]);
});

it('a name of 200 characters passes, of 201 or 300 does not, for the project and for a room', () => {
  expect(each([0, 200, 201, 300], n => p => (p.name = 'x'.repeat(n)))).toEqual([true, true, false, false]);
  expect(each([0, 200, 201, 300], n => p => (p.existing.rooms[0].name = 'x'.repeat(n)))).toEqual([true, true, false, false]);
  expect(each([1, null, undefined], v => p => (p.name = v))).toEqual([false, false, false]);
});

it.each(['none', 'constructor', '', 'A', 'a b', '__proto__', 'x'.repeat(41)])('refuses the id %s', id => {
  expect(ok(p => (p.existing.walls[3].id = id))).toBe(false); // no opening names this wall
  expect(ok(p => (p.existing.openings[0].id = id))).toBe(false);
  expect(ok(p => (p.existing.openings[0].wallId = id))).toBe(false);
  expect(ok(p => (p.existing.rooms[0].id = id))).toBe(false);
  expect(ok(p => (p.existing.separators = [line(id, 9)]))).toBe(false);
  expect(ok(p => (p.clouds = [cloud(id)]))).toBe(false);
  expect(ok(p => (p.existing.walls[3].id = 'x'.repeat(40)))).toBe(true);
  expect(ok(p => (p.existing.walls[3].id = '3f2504e0-4f89-41d3-9a0c-0305e82c3301'))).toBe(true);
});

it('a line break hides nothing: ids, class keys and colours are matched whole', () => {
  for (const text of ['a\nB', 'B\na', 'a\n', '\na']) {
    expect(ok(p => (p.existing.walls[3].id = text))).toBe(false);
    expect(ok(p => (p.wallClass = { [text]: 'fixed' }))).toBe(false);
  }
  for (const hex of ['#abcdef\nx', 'x\n#abcdef', '#abcdef\n', '\n#abcdef']) expect(ok(p => (p.sourceColors = [{ hex, label: '' }]))).toBe(false);
});

it('refuses a reserved or malformed key in wallClass; __proto__ never reaches the result', () => {
  expect(each(['fixed', 'changeable', 'unknown', 'soft', '', null], v => p => (p.wallClass = { top: v }))).toEqual([true, true, true, false, false, false]);
  expect(each(['none', 'constructor', 'TOP', 'a b', 'x'.repeat(41)], k => p => (p.wallClass = { [k]: 'fixed' }))).toEqual([false, false, false, false, false]);
  expect(each([[], null, 'fixed'], v => p => (p.wallClass = v))).toEqual([false, false, false]);
  // JSON.parse makes a real key of this name, which an assignment would not
  const evil = '{"__proto__":{"approved":true}}';
  for (const result of [
    ProjectSchema.safeParse({ ...boxProject(), wallClass: JSON.parse(evil) }),
    ProjectSchema.safeParse(Object.defineProperty(boxProject(), '__proto__', { value: { approved: true }, enumerable: true })),
  ]) {
    const data = result.success ? result.data : boxProject();
    expect(Object.getPrototypeOf(data)).toBe(Object.prototype);
    expect(Object.getPrototypeOf(data.wallClass)).toBe(Object.prototype);
    expect([Object.hasOwn(data, '__proto__'), Object.hasOwn(data.wallClass, '__proto__')]).toEqual([false, false]);
  }
  expect(({} as { approved?: boolean }).approved).toBeUndefined();
});

it('refuses an id used twice in one state, whatever the kinds; the same id in both states is fine', () => {
  expect(ok(p => (p.existing.walls[3].id = 'top'))).toBe(false);
  expect(ok(p => (p.existing.openings[1].id = 'door'))).toBe(false);
  expect(ok(p => (p.existing.rooms[1].id = 'room-a'))).toBe(false);
  expect(ok(p => (p.existing.separators = [line('s', 9), line('s', 8)]))).toBe(false);
  expect(ok(p => (p.existing.openings[0].id = 'top'))).toBe(false);
  expect(ok(p => (p.existing.rooms[0].id = 'door'))).toBe(false);
  expect(ok(p => (p.existing.separators = [line('room-a', 9)]))).toBe(false);
  expect(ok(withPlan)).toBe(true);
  expect(ok(p => (withPlan(p), (p.planned.walls[3].id = 'top')))).toBe(false);
  expect(ok(p => (p.plannedArchive = [archived(p)]))).toBe(true);
  expect(ok(p => (p.plannedArchive = [archived(p)])[0].state.separators.push(line('top', 9)))).toBe(false);
});

it('refuses an opening whose wall is missing', () => {
  expect(ok(p => (p.existing.openings[0].wallId = 'nope'))).toBe(false);
  expect(ok(p => (p.existing.openings[0].wallId = 'room-a'))).toBe(false);
  expect(ok(p => p.existing.walls.splice(4, 1))).toBe(false);
  expect(ok(p => (withPlan(p), p.planned.walls.splice(4, 1)))).toBe(false);
});

it('wall length from 10 mm, thickness 20 to 1000, separator from 1 mm', () => {
  expect(LIMITS).toEqual({ wallLength: 10, thicknessMin: 20, thicknessMax: 1000, finishMax: 200, separatorLength: 1, tolerance: 0.01 });
  expect(each([0, 9.9, 9.9895, 9.9905, 10], length => p => p.existing.walls.push(wall('n', 0, 0, length, 0, 100)))).toEqual([false, false, false, true, true]);
  expect(each([6, 8], y => p => p.existing.walls.push(wall('n', 0, 0, 6, y, 100)))).toEqual([false, true]); // 8.5 and 10 mm
  expect(ok(p => p.existing.walls.push(wall('n', 3001.37, 2000.77, 3011.369950654929, 2000.8014149483274, 100)))).toBe(true); // 10 mm at an odd angle
  expect(each([0, 19, 20, 100.5, 1000, 1001, -100], t => p => p.existing.walls.push(wall('n', 0, 0, 100, 0, t)))).toEqual([false, false, true, true, true, false, false]);
  expect(each([0, 0.9, 0.9895, 0.9905, 1], length => p => p.existing.separators.push(line('s', length)))).toEqual([false, false, false, true, true]);
});

it('openings: confirmed is required, width is above 0, where one may lie is for the model to say', () => {
  expect(each([true, false], v => p => (p.existing.openings[0].confirmed = v))).toEqual([true, true]);
  expect(ok(p => delete p.existing.openings[0].confirmed)).toBe(false);
  expect(each([0, -1, 0.1], width => p => (p.existing.openings[0].width = width))).toEqual([false, false, true]);
  expect(each([-1, 0, 90_000], offset => p => (p.existing.openings[0].offset = offset))).toEqual([true, true, true]);
  expect(each([-1, 0], offset => p => (withPlan(p), (p.planned.openings[0].fromOffset = offset)))).toEqual([true, true]);
});

it('the kind of an opening and the source of a wall are words of their lists', () => {
  expect(each(['door', 'entry', 'window', 'passage', 'gate', null], kind => p => (p.existing.openings[0].kind = kind))).toEqual([true, true, true, true, false, false]);
  expect(each(['detected', 'manual', 'other', null], source => p => (p.existing.walls[0].source = source))).toEqual([true, true, false, false]);
});

it('a yes or no is true or false and nothing else', () => {
  const places: ((p: any, value: unknown) => unknown)[] = [
    (p, v) => (p.existing.walls[0].review = v),
    (p, v) => (p.existing.openings[0].review = v),
    (p, v) => (p.existing.openings[0].confirmed = v),
    (p, v) => (p.existing.rooms[0].isMamad = v),
    (p, v) => (p.existing.rooms[0].inApartment = v),
    (p, v) => (p.existing.rooms[0].outdoor = v),
    (p, v) => (p.calibration.verified = v),
    (p, v) => (p.approved = v),
    (p, v) => (p.changeableWarningShown = v),
  ];
  for (const [i, put] of places.entries()) {
    expect(ok(p => put(p, false)), `place ${i}`).toBe(true);
    // with the answer none nothing but the value is wrong; with room-a the same holds for a mark read as true
    for (const mamad of ['none', 'room-a'])
      for (const value of [0, 1, '', 'true', 'false', null, undefined]) expect(ok(p => ((p.mamad = mamad), put(p, value))), `place ${i}, ${value}`).toBe(false);
  }
});

it('status, from and fromOffset belong to a plan, and every planned wall and opening has a status', () => {
  const from = { a: { x: 0, y: 0 }, b: { x: 1, y: 1 } };
  const states = ['kept', 'removed', 'new', 'moved'];
  for (const list of ['walls', 'openings'] as const) {
    expect(each([...states, null], status => p => (p.existing[list][0].status = status)), list).toEqual(Array(5).fill(false));
    expect(each([...states, 'gone', null], status => p => (withPlan(p), (p.planned[list][0].status = status))), list).toEqual([true, true, true, true, false, false]);
    expect(ok(p => (withPlan(p), delete p.planned[list][0].status)), list).toBe(false);
    expect(ok(p => delete (p.plannedArchive = [archived(p)])[0].state[list][0].status), list).toBe(false);
  }
  expect(ok(p => (p.existing.walls[0].from = from))).toBe(false);
  expect(each([0, 5], offset => p => (p.existing.openings[0].fromOffset = offset))).toEqual([false, false]);
  expect(ok(p => (withPlan(p), (p.planned.walls[0].from = from)))).toBe(true);
  expect(ok(p => (withPlan(p), (p.planned.openings[0].fromOffset = 5)))).toBe(true);
  // beside a plan too
  expect(ok(p => (withPlan(p), (p.existing.walls[0].status = 'kept')))).toBe(false);
  expect(ok(p => (withPlan(p), (p.existing.walls[0].from = from)))).toBe(false);
});

it('finish: null and 1 to 200 whole mm', () => {
  for (const side of ['finishA', 'finishB'])
    expect(each([null, 1, 200, 0, 201, 2.5, -1, '20', undefined], v => p => (p.existing.walls[0][side] = v)), side).toEqual([true, true, true, false, false, false, false, false, false]);
});

it('an outline has 3 to 2,000 points, holes too', () => {
  const ring = (count: number) => many(count, i => ({ x: i, y: 0 }));
  expect(each([0, 2, 3, 2000, 2001], n => p => (p.existing.rooms[0].boundary = ring(n)))).toEqual([false, false, true, true, false]);
  expect(each([0, 2, 3, 2000, 2001], n => p => (p.existing.rooms[0].holes = [ring(n)]))).toEqual([false, false, true, true, false]);
  expect(each([0, 200, 201], n => p => (p.existing.rooms[0].holes = many(n, () => rect(0, 0, 1, 1))))).toEqual([true, true, false]);
});

it('calibration: verified is required, chosen is 50 or 100, scale is positive', () => {
  const dim = { a: [0, 0], b: [1, 1], writtenMm: 1 };
  // the project's, and the one an archived plan was saved with
  const places: ((p: any) => any)[] = [p => p.calibration, p => (p.plannedArchive = [archived(p)])[0].calibration];
  for (const at of places) {
    expect(each([true, false, undefined, 'true', 1], v => p => (at(p).verified = v))).toEqual([true, true, false, false, false]);
    expect(ok(p => delete at(p).verified)).toBe(false);
    expect(each([50, 100, 75, '50'], v => p => (at(p).chosen = v))).toEqual([true, true, false, false]);
    for (const key of ['scale', 'mmPerPt']) expect(each([0.1, 0, -1], v => p => (at(p)[key] = v)), key).toEqual([true, false, false]);
    expect(each([-80, 100], v => p => (at(p).offsetMm = v))).toEqual([true, true]);
    expect(each([0, 200, 201], n => p => (at(p).dims = many(n, () => dim)))).toEqual([true, true, false]);
    expect(each([[0], [0, 0, 0], { x: 0, y: 0 }], a => p => (at(p).dims = [{ ...dim, a }]))).toEqual([false, false, false]);
    expect(each([-1, 0, 1970], writtenMm => p => (at(p).dims = [{ ...dim, writtenMm }]))).toEqual([true, true, true]); // which ones count is for the fit to say
    expect(ok(p => (at(p).extra = 1))).toBe(false);
  }
  expect(each([undefined, null, {}], calibration => p => (p.calibration = calibration))).toEqual([false, false, false]);
});

it('plaster: four answers or null', () => {
  expect(each(['none', 'line', 'inWall', 'unknown', null], v => p => (p.plaster = v))).toEqual([true, true, true, true, true]);
  expect(each(['both', '', undefined, 0], v => p => (p.plaster = v))).toEqual([false, false, false, false]);
});

it('clouds: note up to 500, at most 500 of them, no id twice, two corners', () => {
  expect(each([0, 500, 501], n => p => (p.clouds = [cloud('c', 'x'.repeat(n))]))).toEqual([true, true, false]);
  expect(each([0, 500, 501], n => p => (p.clouds = many(n, i => cloud(`c${i}`))))).toEqual([true, true, false]);
  expect(ok(p => (p.clouds = [cloud('c'), cloud('c')]))).toBe(false);
  expect(ok(p => (p.clouds = [cloud('top')]))).toBe(true); // a cloud belongs to no state
  expect(each(['manual', 'suggested', 'other', undefined], source => p => (p.clouds = [{ ...cloud('c'), source }]))).toEqual([true, true, false, false]);
  expect(each(['a', 'b'], corner => p => (p.clouds = [{ ...cloud('c'), [corner]: undefined }]))).toEqual([false, false]);
});

it('sourceColors: #rrggbb in lower case, at most 32, none twice, label up to 200', () => {
  const color = (i: number) => ({ hex: `#0000${String(i + 10)}`, label: '' });
  expect(each([0, 32, 33], n => p => (p.sourceColors = many(n, color)))).toEqual([true, true, false]);
  expect(ok(p => (p.sourceColors = [color(1), color(1)]))).toBe(false);
  const hex = (value: string): Change => p => (p.sourceColors = [{ hex: value, label: '' }]);
  expect(ok(hex('#abcdef'))).toBe(true);
  expect(each(['#ABCDEF', '#abc', 'abcdef', 'red', '#abcdefa', ' #abcdef', '#abcdeg'], hex)).toEqual(Array(7).fill(false));
  expect(each([200, 201], n => p => (p.sourceColors = [{ hex: '#abcdef', label: 'x'.repeat(n) }]))).toEqual([true, false]);
});

it('mamad: an id names a marked room; none and null mean no marked room, in both states', () => {
  expect(ok(p => ((p.mamad = 'room-b'), marked(p.existing, 'room-b')))).toBe(true);
  expect(ok(p => (p.mamad = 'room-b'))).toBe(false);
  expect(ok(p => ((p.mamad = 'room-a'), marked(p.existing, 'room-b')))).toBe(false);
  expect(ok(p => ((p.mamad = 'gone'), marked(p.existing, 'room-b')))).toBe(false);
  expect(ok(p => ((p.mamad = 'top'), marked(p.existing, 'room-b')))).toBe(false); // a wall's id
  for (const answer of ['none', null]) {
    expect(ok(p => (p.mamad = answer)), String(answer)).toBe(true);
    expect(ok(p => ((p.mamad = answer), marked(p.existing, 'room-b'))), String(answer)).toBe(false);
  }
  const noMamad: Change = p => (withPlan(p), (p.mamad = 'none'), marked(p.existing), marked(p.planned));
  expect(ok(noMamad)).toBe(true);
  expect(ok(p => (noMamad(p), marked(p.planned, 'room-b')))).toBe(false); // marked in the plan only
  expect(ok(withPlan)).toBe(true);
  expect(ok(p => (withPlan(p), marked(p.planned)))).toBe(false);
  expect(ok(p => (withPlan(p), marked(p.existing)))).toBe(false);
  expect(each([undefined, 1, 'A B'], v => p => (p.mamad = v))).toEqual([false, false, false]);
});

it('two marked rooms in one state are refused (a mamad is never split, 7D)', () => {
  const both = ['room-a', 'room-b'];
  expect(ok(p => ((p.mamad = 'room-b'), marked(p.existing, ...both)))).toBe(false);
  expect(ok(p => (withPlan(p), marked(p.planned, ...both)))).toBe(false);
  const archive = (...ids: string[]): Change => p => {
    p.plannedArchive = [archived(p)];
    marked(p.plannedArchive[0].state, ...ids);
  };
  expect(ok(archive())).toBe(true);
  expect(ok(archive('room-a'))).toBe(true); // an old plan keeps its own mamad
  expect(ok(archive(...both))).toBe(false);
});

it('the mamad is not outdoors; a plan needs an approved existing state', () => {
  expect(ok(p => (p.existing.rooms[0].outdoor = true))).toBe(true);
  expect(ok(p => ((p.mamad = 'room-b'), marked(p.existing, 'room-b'), (p.existing.rooms[0].outdoor = true)))).toBe(true);
  expect(ok(p => ((p.mamad = 'room-b'), marked(p.existing, 'room-b'), (p.existing.rooms[1].outdoor = true)))).toBe(false);
  expect(ok(p => (withPlan(p), (p.planned.rooms[1].outdoor = true)))).toBe(false);
  expect(ok(p => (withPlan(p), (p.approved = false)))).toBe(false);
});

it('an approved project has answered the mamad question', () => {
  expect(ok(p => (p.approved = true))).toBe(false);
  expect(ok(p => ((p.approved = true), (p.mamad = 'none')))).toBe(true);
  expect(ok(p => ((p.approved = true), (p.mamad = 'room-b'), marked(p.existing, 'room-b')))).toBe(true);
  expect(ok(p => (withPlan(p), (p.mamad = null), marked(p.existing), marked(p.planned)))).toBe(false);
});

it('version 2, page 0, 21 and 1.5, text that is not base64, and a PDF over the cap are refused', () => {
  expect(each([1, 2, 0, '1', undefined], v => p => (p.version = v))).toEqual([true, false, false, false, false]);
  expect(each([1, 20, 0, 21, 1.5, '1'], v => p => (p.page = v))).toEqual([true, true, false, false, false, false]);
  expect(each(['', 'AAAA', 'AAA=', 'AA==', 'ab+/', 'a+/A0z9=', 'a+/A0w=='], v => p => (p.pdfBase64 = v))).toEqual(Array(7).fill(true));
  // what atob refuses, and what it only tolerates (a missing =, white space)
  const bad = ['A', 'AA', 'AAA', 'A=', 'AA=', 'A===', 'AAAA=', 'AAAA==', 'AAAA====', '====', '=AAA', 'A=A=', 'ab_-', 'a b', 'a\n', 'AAA=\n', 'A A A=', '<b>1', '\u00e9AAA'];
  for (const text of bad) expect(ok(p => (p.pdfBase64 = text)), text).toBe(false);
  expect(each([27_962_028, 27_962_032], n => p => (p.pdfBase64 = 'A'.repeat(n)))).toEqual([true, false]); // 20 MiB in base64
  expect(each([null, [], 'x', 1, undefined], v => p => (p.existing = v))).toEqual([false, false, false, false, false]);
  expect([null, [], 'x', 1, undefined].map(v => ProjectSchema.safeParse(v).success)).toEqual([false, false, false, false, false]);
});

it('archive: 200 entries, each a full state', () => {
  expect(each([0, 200, 201], n => p => (p.plannedArchive = many(n, () => archived(p))))).toEqual([true, true, false]);
  expect(ok(p => (p.plannedArchive = [{ ...archived(p), state: {} }]))).toBe(false);
  expect(ok(p => (p.plannedArchive = [{ ...archived(p), wallClass: { none: 'fixed' } }]))).toBe(false);
  const savedAt = (value: unknown): Change => p => (p.plannedArchive = [{ ...archived(p), savedAt: value }]);
  expect(each([new Date().toISOString(), '2028-02-29T23:59:59.999Z'], savedAt)).toEqual([true, true]);
  const digits = '0'.repeat(30_000_000); // an ISO time may have any number of decimals
  const bad = [String(new Date(0)), '', '2026-11-25', '2026-11-25T10:00Z', '2026-11-25T10:00:00.000', '2026-11-25T10:00:00.000+02:00', '2026-11-25T10:00:00.000Z\n', '2026-02-29T10:00:00.000Z', '2026-11-25T24:00:00.000Z', 'x' + digits, `2026-11-25T10:00:00.${digits}Z`, undefined, null, 0];
  expect(each(bad, savedAt)).toEqual(Array(bad.length).fill(false));
  expect(each([undefined, null, {}], calibration => p => (p.plannedArchive = [{ ...archived(p), calibration }]))).toEqual([false, false, false]);
  expect(ok(p => delete (p.plannedArchive = [archived(p)] as any)[0].calibration)).toBe(false);
});

it('never calls Function or eval (the CSP forbids both)', () => {
  expect(codeFromText).toBe(0);
  Reflect.construct(globalThis.Function, ['return 1']); // the counter works
  Reflect.apply(globalThis.eval, undefined, ['1']);
  expect(codeFromText).toBe(2);
});
