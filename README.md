# PDF importer: contractor drawing to editable floor plan

A static browser app that opens a contractor's **vector PDF** of an apartment and turns it into
editable walls, openings and rooms with real measurements, for an interior designer. Nothing leaves
the browser: there is no backend, no upload and no account.

It lives in its own folder and does not touch the rest of the repository.

## Status

Work in progress. Built and reviewed so far:

| Part | Where |
|---|---|
| Safe PDF reading in a worker, vector path extraction | `src/pdf/` |
| First screen: upload, page choice, sharp page with zoom and pan | `src/editor/`, `src/pdf/render.ts` |
| Scale calibration from written dimensions | `src/calibrate/` |
| Calibration screen: mark written dimensions with snapping, fit the scale, measure freely to check | `src/editor/Calibrate.tsx`, `MeasureTool.tsx`, `snap.ts` |
| Project data model and file schema | `src/model/types.ts`, `schema.ts` |
| Wall joints, rooms, gap closing, measurements, wall kind | `src/model/geo.ts`, `join.ts`, `rooms.ts`, `measure.ts`, `kind.ts` |
| Every edit of the existing state through one checked transition, with reasons for refusals, locks by default (windows, entry door, outer walls, mamad) with deliberate release, and undo | `src/model/apply.ts`, `existing.ts`, `rules.ts`, `history.ts` |
| Finish layers (plaster or cladding) per wall side and free wall end, and the room that is left (net) | `src/model/finish.ts` |
| Project file (open, save, download) and autosave draft in the browser | `src/storage/` |
| Editor screen, part 1: draw walls by their centre line with a typed thickness, wall material, rooms with name and area, paint and legend per wall kind and class, locks with a note and a deliberate release, undo and redo, one view-reset control | `src/editor/Editor.tsx`, `Tools.tsx`, `Overlay.tsx`, `SidePanel.tsx`, `Legend.tsx`, `useProject.ts` |
| Editor screen, part 2: doors, windows and passages on a wall, separator lines between spaces, splitting a wall, moving a wall end or an opening edge by two clicks, finish layers (plaster or cladding) with net and gross areas; locked openings and locked wall ends refuse a change with a note | `src/editor/Tools.tsx`, `Overlay.tsx`, `SidePanel.tsx`, `Legend.tsx`, `snap.ts` |
| Editor screen, part 3: the guided check before approval in six steps (apartment rooms, protected room, entry door, doors and passages, windows, outer walls) with show, confirm, release and delete per item and a progress line; suggestions to class walls as fixed, accepted one by one or all in one undo step; the contractor's colours with a typed meaning | `src/editor/CheckList.tsx`, `SidePanel.tsx`, `Legend.tsx`, `useProject.ts`, `view.ts` |

Not built yet: the approval itself, the save buttons,
wall detection, the planned state, PDF output.
Scanned (image-only) PDFs are out of scope for this version.

## Run

Node 24.

```sh
npm ci
npm run dev        # the app on http://localhost:5173
npm run verify     # typecheck, unit, edge, regression, browser tests, npm audit
```

The first browser test run needs `npx playwright install chromium firefox`.

## Sample drawings

The real drawings used for regression tests are private and are not in this repository. Tests that
need them skip themselves when the folder is absent; everything else runs on synthetic drawings
built by the tests. To run with your own files, point `ETELIER_SAMPLES` at a folder holding a
`manifest.json` (`{ "S01": { "file": "name.pdf", "page": 1 }, ... }`).

## Stack

TypeScript, React, Vite, pdf.js (in a worker), jsts for geometry, zod for the project file,
Vitest and Playwright. The page runs under a strict Content-Security-Policy.
