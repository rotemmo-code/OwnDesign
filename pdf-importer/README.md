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
| Project data model and file schema | `src/model/types.ts`, `schema.ts` |
| Wall joints, rooms, gap closing, measurements, wall kind | `src/model/geo.ts`, `join.ts`, `rooms.ts`, `measure.ts`, `kind.ts` |
| Project file (open, save, download) and autosave draft in the browser | `src/storage/` |

Not built yet: the calibration and editor screens, the save buttons, wall detection, the planned state, PDF output.
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
