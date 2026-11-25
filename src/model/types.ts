import type { Calibration } from '../shared';

/** 1 to 40 of a-z, 0-9 and -, never 'none' or 'constructor'. New ids are crypto.randomUUID(). */
export type Id = string;
/** mm; origin at the page's top-left, y down. */
export type Pt = { x: number; y: number };
/** No entry in wallClass means 'unknown'; only 'changeable' unlocks. */
export type WallClass = 'fixed' | 'changeable' | 'unknown';
/** Planned state only. */
export type Status = 'kept' | 'removed' | 'new' | 'moved';
/** A is the left hand when walking from a to b on screen: its normal is (u.y, -u.x), u the direction of a -> b. */
export type Side = 'A' | 'B';
export type StateName = 'existing' | 'planned';
/** Whether the contractor's walls include plaster: no, as a separate line, inside the wall's thickness, not known. */
export type Plaster = 'none' | 'line' | 'inWall' | 'unknown';

/** a and b are the wall's physical ends on its centre line; its body is the rectangle of a, b and thickness. */
export type Wall = {
  id: Id;
  a: Pt;
  b: Pt;
  thickness: number;
  finishA: number | null;
  finishB: number | null;
  source: 'detected' | 'manual';
  review: boolean;
  status?: Status;
  /**
   * Planned state: the ends before the first planned change. Set for a moved wall, and for a neighbour that only
   * grew or shrank (its status stays 'kept').
   */
  from?: { a: Pt; b: Pt };
};
/** A span of its wall, offset measured from a. The wall does not break at it. */
export type Opening = {
  id: Id;
  wallId: Id;
  offset: number;
  width: number;
  kind: 'door' | 'entry' | 'window' | 'passage';
  /** The detector doubts it. */
  review: boolean;
  /** The designer approved place, size and kind; manual ones are confirmed. */
  confirmed: boolean;
  status?: Status;
  fromOffset?: number;
};
/** Zero width: it splits a closed room and closes nothing. */
export type Separator = { id: Id; a: Pt; b: Pt };
/** Rings have no repeated point and run clockwise on screen from their topmost, then leftmost point. */
export type Room = {
  id: Id;
  name: string;
  boundary: Pt[];
  holes: Pt[][];
  /** This room is the mamad of its state; at most one room is. */
  isMamad: boolean;
  inApartment: boolean;
  /** A balcony. */
  outdoor: boolean;
};
export type State = { walls: Wall[]; openings: Opening[]; separators: Separator[]; rooms: Room[] };

/** A remark for the contractor: two corners of a red cloud, and a note. Its number is its place in the list, from 1. */
export type Cloud = { id: Id; a: Pt; b: Pt; note: string; source: 'manual' | 'suggested' };
/** A colour of the contractor's drawing, and what the designer says it means. */
export type SourceColor = { hex: string; label: string };

export type Project = {
  version: 1;
  name: string;
  pdfBase64: string;
  page: number;
  calibration: Calibration;
  /** null: not answered. */
  plaster: Plaster | null;
  /** One per project, shared by both states. */
  wallClass: Record<Id, WallClass>;
  existing: State;
  approved: boolean;
  /** The answer to the question which room is the mamad. null: not answered. */
  mamad: Id | 'none' | null;
  planned: State | null;
  plannedArchive: { savedAt: string; state: State; wallClass: Record<Id, WallClass> }[];
  changeableWarningShown: boolean;
  clouds: Cloud[];
  sourceColors: SourceColor[];
};

export type RoomChange =
  /** room: the old id, which the larger part keeps. parts: all of them, larger first. */
  | { type: 'split'; room: Id; parts: Id[] }
  /** room: the merged room. from: the old ids. */
  | { type: 'merge'; room: Id; from: Id[] };

export type Reason =
  | 'existing-approved'
  | 'existing-not-approved'
  | 'approval-blocked'
  | 'archive-read-only'
  | 'window-locked'
  | 'mamad-locked'
  | 'mamad-split'
  | 'mamad-outdoor'
  | 'wall-fixed'
  | 'wall-unknown'
  | 'entry-door-locked'
  | 'door-in-locked-wall'
  | 'has-doors'
  | 'has-window'
  | 'neighbor-locked'
  | 'crosses-wall'
  | 'deletes-room'
  | 'opening-out-of-wall'
  | 'opens-gap'
  | 'opens-apartment'
  | 'class-conflicts-with-plan'
  | 'class-conflicts-with-split'
  | 'finish-range'
  | 'finish-outer-side'
  | 'finish-no-room-left'
  | 'invalid-geometry'
  | 'invalid-number'
  | 'invalid-action'
  | 'text-too-long'
  | 'too-many';
export type Notice = 'load-bearing-warning' | 'plaster-in-wall' | { rooms: RoomChange[] };
export type Result = { ok: true; project: Project; notice?: Notice } | { ok: false; reason: Reason };

export type Action =
  | { type: 'x.addWall'; a: Pt; b: Pt; thickness: number }
  | { type: 'x.deleteWall'; id: Id }
  | { type: 'x.setWall'; id: Id; a?: Pt; b?: Pt; thickness?: number }
  | { type: 'x.splitWall'; id: Id; at: number }
  | { type: 'x.addOpening'; wallId: Id; offset: number; width: number; kind: Opening['kind'] }
  | { type: 'x.setOpening'; id: Id; offset?: number; width?: number; kind?: Opening['kind'] }
  | { type: 'x.deleteOpening'; id: Id }
  | { type: 'x.addSeparator'; a: Pt; b: Pt }
  | { type: 'x.deleteSeparator'; id: Id }
  | { type: 'x.clearReview'; id: Id }
  | { type: 'x.confirmOpenings'; ids: Id[] }
  | { type: 'x.setRoom'; id: Id; name?: string; inApartment?: boolean; outdoor?: boolean }
  /** The answer to a split: part takes the id and name of room, and the other way round. */
  | { type: 'x.keepName'; room: Id; part: Id }
  /** null opens the question again. */
  | { type: 'setMamad'; room: Id | 'none' | null }
  | { type: 'setName'; name: string }
  | { type: 'classify'; wallId: Id; cls: WallClass }
  /** Everything drawn is scaled by the new mmPerPt over the old one. */
  | { type: 'rescale'; calibration: Calibration }
  | { type: 'setPlaster'; plaster: Plaster }
  | PlannedAction
  | FinishAction
  | LifecycleAction
  | AnnotationAction;
export type PlannedAction =
  | { type: 'p.moveWall'; id: Id; distance: number }
  | { type: 'p.removeWall'; id: Id; withDoors: boolean; mergedName: string }
  | { type: 'p.addWall'; a: Pt; b: Pt; thickness?: number }
  | { type: 'p.setNewWall'; id: Id; thickness: number }
  | { type: 'p.splitWall'; id: Id; at: number }
  | { type: 'p.addDoor'; wallId: Id; offset: number; width?: number }
  | { type: 'p.removeDoor'; id: Id }
  | { type: 'p.moveDoor'; id: Id; offset: number }
  | { type: 'p.setNewDoor'; id: Id; width: number }
  | { type: 'p.addSeparator'; a: Pt; b: Pt }
  | { type: 'p.deleteSeparator'; id: Id }
  | { type: 'p.setRoom'; id: Id; name: string }
  | { type: 'p.keepName'; room: Id; part: Id };
export type FinishAction = { type: 'setFinish'; state: StateName; wallId: Id; side: Side; mm: number | null };
export type LifecycleAction = { type: 'approve' } | { type: 'reopen' } | { type: 'startPlanned' };
export type AnnotationAction =
  | { type: 'n.addCloud'; a: Pt; b: Pt; note: string; source: Cloud['source'] }
  | { type: 'n.setCloud'; id: Id; a?: Pt; b?: Pt; note?: string }
  | { type: 'n.deleteCloud'; id: Id }
  | { type: 'n.setColorLabel'; hex: string; label: string };
