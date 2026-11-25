import type { Opening, Project, Pt, Room, State, Wall } from '../../src/model/types';

/** Corners of an upright rectangle, clockwise on screen from its top-left. */
export const rect = (x0: number, y0: number, x1: number, y1: number): Pt[] => [
  { x: x0, y: y0 },
  { x: x1, y: y0 },
  { x: x1, y: y1 },
  { x: x0, y: y1 },
];

export const wall = (id: string, x1: number, y1: number, x2: number, y2: number, thickness: number): Wall => ({
  id,
  a: { x: x1, y: y1 },
  b: { x: x2, y: y2 },
  thickness,
  finishA: null,
  finishB: null,
  source: 'manual',
  review: false,
});

const opening = (id: string, wallId: string, offset: number, width: number, kind: Opening['kind']): Opening => ({
  id,
  wallId,
  offset,
  width,
  kind,
  review: false,
  confirmed: true,
});

const room = (id: string, name: string, boundary: Pt[]): Room => ({
  id,
  name,
  boundary,
  holes: [],
  isMamad: false,
  inApartment: true,
  outdoor: false,
});

/**
 * The planPdf apartment in mm from its outer top-left corner. Walls end where planPdf draws them;
 * the outer walls run clockwise, so their side A is outside.
 */
export const boxApartment = (): State => ({
  walls: [
    wall('top', 0, 100, 6400, 100, 200),
    wall('right', 6300, 200, 6300, 4200, 200),
    wall('bottom', 6400, 4300, 0, 4300, 200),
    wall('left', 100, 4200, 100, 200, 200),
    wall('part', 3250, 200, 3250, 4200, 100),
  ],
  openings: [
    opening('door', 'part', 1000, 800, 'door'),
    opening('window', 'top', 1100, 1200, 'window'),
    opening('entry', 'bottom', 1200, 900, 'entry'),
  ],
  separators: [],
  rooms: [room('room-a', 'A', rect(200, 200, 3200, 4200)), room('room-b', 'B', rect(3300, 200, 6200, 4200))],
});

export const boxProject = (): Project => ({
  version: 1,
  name: 'box',
  pdfBase64: 'JVBERi0=', // %PDF-
  page: 1,
  calibration: { scale: 50, mmPerPt: (50 * 25.4) / 72, offsetMm: 0, chosen: 50, dims: [], verified: true },
  plaster: null,
  wallClass: {},
  existing: boxApartment(),
  approved: false,
  mamad: null,
  planned: null,
  plannedArchive: [],
  changeableWarningShown: false,
  clouds: [],
  sourceColors: [],
});
