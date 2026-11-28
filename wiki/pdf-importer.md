# PDF importer

A contributed feature on the `PDF-IMPORTER` branch: a static browser app that opens a contractor's
vector PDF of an apartment and turns it into editable walls, openings and rooms with real
measurements. Source: [`../pdf-importer/`](../pdf-importer/README.md).

## How it relates to the product

- **It is separate.** Everything is under `pdf-importer/`. Nothing in `frontend/`, `backend/` or
  `supabase/` is changed, and the importer has no backend: a file never leaves the browser.
- **Different stack from `frontend/`:** TypeScript, React and a Vite build, where the product's
  frontend is plain ES modules with no build step. Units are millimetres; the product's plan
  (`frontend/js/plan.js`) uses centimetres.
- **Scope conflict with the PRD.** `Interior_Design_AI_PRD_EN.md` section 3.3 lists "automatic
  PDF/image floor-plan conversion" as not approved. The importer is a course contribution on its own
  branch; merging it into the product needs that decision reconsidered (see
  [open-items](open-items.md)).
- **Hebrew UI, right to left.** Decided by the user on 2026-11-26: the importer's screens stay in
  Hebrew for the designer it is built with. This is an exception to the product's English-only UI
  ([decisions](decisions.md)) and applies to `pdf-importer/` only.
- **Planned link to the editor:** an export of the recognised plan in the product's plan format
  (walls, openings, rooms, centimetres), so it can be opened in `frontend/editor.html`. Not built.

## What is built

| Part | Files |
|---|---|
| PDF read in a worker, vector paths with clips, colours and layers | `pdf-importer/src/pdf/` |
| First screen: upload, page choice, the page drawn sharp again after every zoom, pan | `pdf-importer/src/editor/`, `pdf-importer/src/pdf/render.ts` |
| Scale calibration from the drawing's written dimensions | `pdf-importer/src/calibrate/fit.ts` |
| Calibration screen: dimensions marked on the drawing with snapping, the scale fitted and confirmed, free measuring to check; a permanent warning when the scale is not fully verified | `pdf-importer/src/editor/Calibrate.tsx`, `MeasureTool.tsx`, `snap.ts` |
| Project data model and project-file schema (zod) | `pdf-importer/src/model/types.ts`, `schema.ts` |
| Wall joints, room finding, gap closing up to 2 mm, room split, measurements, wall kind | `pdf-importer/src/model/geo.ts`, `join.ts`, `rooms.ts`, `measure.ts`, `kind.ts` |
| One checked transition for every edit of the existing state: reasons for refusals, undo, and a lock that keeps the protected room (mamad) unchanged | `pdf-importer/src/model/apply.ts`, `existing.ts`, `rules.ts`, `history.ts` |
| Finish layers (plaster or cladding) per wall side and free wall end; the room that is left after them (net against gross) | `pdf-importer/src/model/finish.ts` |
| Project file (open, save, download) and an autosave draft in IndexedDB; an old draft is never deleted without asking | `pdf-importer/src/storage/` |
| Editor screen, part 1: walls drawn by their centre line with a typed thickness and a material, rooms with name and area, paint and legend per wall kind and class (no lock icons), locks with a note and a deliberate release, undo and redo, one view-reset control with the zoom percentage | `pdf-importer/src/editor/Editor.tsx`, `Tools.tsx`, `Overlay.tsx`, `SidePanel.tsx`, `Legend.tsx`, `useProject.ts` |
| Editor screen, part 2: doors, windows and passages on a wall, separator lines between spaces, splitting a wall, moving a wall end or an opening edge by two clicks, finish layers (plaster or cladding) with net and gross areas; locked openings and locked wall ends refuse a change with a note | `pdf-importer/src/editor/Tools.tsx`, `Overlay.tsx`, `SidePanel.tsx`, `Legend.tsx`, `snap.ts` |
| Editor screen, part 3: the guided check before approval in six steps (apartment rooms, protected room, entry door, doors and passages, windows, outer walls) with show, confirm, release and delete per item and a progress line; suggestions to class walls as fixed, accepted one by one or all in one undo step; the contractor's colours with a typed meaning | `pdf-importer/src/editor/CheckList.tsx`, `SidePanel.tsx`, `Legend.tsx`, `useProject.ts`, `view.ts` |

Not built yet: the approval itself, the
save buttons, wall detection, the planned state, PDF output. Image-only (scanned) PDFs are out of scope.

## How it is developed

Each task is planned, approved by the user, built test-first by one agent, then reviewed by a
separate agent (spec, correctness, security) before it is merged. Review rounds found and fixed real
defects, for example a diagonal wall touching another only by a corner that left two rooms merged.

## Tests

`cd pdf-importer && npm ci && npm run verify`: typecheck, unit, edge, regression and browser tests
(Chromium and Firefox), then `npm audit`. After the third part of the editor screen was merged: 645 unit, 43 edge and
470 browser tests pass; the 20 regression tests need private sample drawings and skip without them.

## Privacy

The real drawings used for regression are private and are not in the repository; tests use synthetic
drawings. Before every push the branch is scanned for words taken from the sample files.
