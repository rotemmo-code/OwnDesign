# Log

Append-only. Newest at the bottom. Format: `## [YYYY-MM-DD] <type> | <title>`.

## [2026-11-19] plan | Phase 1 scope and approach approved
Read the PRD. The user chose: Phase 1 first, AI later through the OpenAI API, English-only UI, a new
cloud Supabase project. Plan approved: FastAPI + static frontend + Supabase with RLS.
Pages: [overview](overview.md), [decisions](decisions.md).

## [2026-11-19] infra | Supabase dev project created
New organisation `interior-design-platform` with project `interior-design-dev` (eu-central-1),
created with the Supabase CLI. Email confirmation switched off for development.
Pages: [architecture](architecture.md), [open-items](open-items.md).

## [2026-11-19] build | Phase 1 scaffold
Backend routes and geometry schemas, database schema with RLS, 2D plan editor, wizard and pages.
Commit `dd2cb52`. Pages: [architecture](architecture.md).

## [2026-11-19] design | UI aligned to the Stitch design system
The user asked mid-build to use the Stitch project "AI Interior Design Platform". Wizard and editor
follow its two matching screens; other pages follow its design system. Later-phase widgets left out.
Pages: [design](design.md).

## [2026-11-19] build | Dev Supabase wired, shared HTTP pool, E2E journeys, README
Integration tests against the real dev project, two browser journeys, run instructions.
Commit `c592463`. Pages: [testing](testing.md).

## [2026-11-19] security | Code review and security review, findings fixed
Independent code-review and security-review agents. No critical or high security finding. Fixed:
save-dialog bugs, keyboard placement, undo no-ops, vendored supabase-js with CSP, body-size cap for
chunked uploads, per-account quotas, one-owner unique index, suspended-studio writes, sequence grants.
Commit `f4ed029`. Pages: [security](security.md), [open-items](open-items.md).

## [2026-11-19] test | Phase 1 verified
Backend 41 passed (unit, integration, 2 browser E2E). Frontend 13 passed. Dev project left with no
test users or rows. Not tested: real touch devices, browsers other than Chromium.
Pages: [testing](testing.md).

## [2026-11-19] infra | GitHub repository created and made public
`main` and `dev` pushed to `github.com/JonathanZouari/OwnDesign`, default branch `main`. History
scanned for keys before pushing: none. Made public at the user's request.
Pages: [decisions](decisions.md).

## [2026-11-19] docs | CLAUDE.md and this wiki added
Working rules (plan first, Fable 5.2, E2E + regression + edge tests, security review at every stage,
commit per finished piece of code, subagents for specialist work) and the wiki seeded from Phase 1.
Model pinned in `.claude/settings.json`.
Pages: all.

## [2026-11-19] design | All Stitch screens pulled and compared with the app
The Stitch project had grown to eight screens; only two had been pulled. All eight (HTML and a
preview each) and two generated images are now in `design/stitch/`. Wizard and canvas were unchanged
in Stitch. The Stitch PRD document is a shortened copy of the repository PRD with nothing new.
Commit `c01e476`. Pages: [design](design.md).

## [2026-11-19] plan | Integrate the two Phase 1 screens, keep four as reference
Approved by the user: build the client portal and the studio dashboard now with real data only; keep
branding, dossier, AI consultant and renderings as design references until their phases.
Pages: [decisions](decisions.md), [open-items](open-items.md).

## [2026-11-19] build | Studio activity endpoint
`GET /v1/studios/{id}/audit`: latest 10 audit events, members only, read under RLS, metadata limited
to `version_no` and `author_role`. Test written first. Commit `faec162`.
Pages: [architecture](architecture.md).

## [2026-11-19] build | Client portal and studio dashboard rebuilt from Stitch
Built by the `ux-ui-designer` subagent. Portal: guest or account access, wizard or blank canvas,
invite greeting. Dashboard: metrics, project cards with plan thumbnails, search, invites, recent
activity. Code review (no critical or high) led to: a confirmation before a blank canvas replaces a
draft, previews loaded as cards come into view instead of for the first 12 only, invites shown from
the create response, and a fix for sidebar icons clipped by a descendant selector (wizard and editor
were affected too). Commit `173e359`. Pages: [design](design.md), [overview](overview.md).

## [2026-11-19] test | Portal and dashboard verified
Backend 43 passed, including 3 browser journeys; frontend 17 passed. New edge tests found a real
bug before commit: a long unbroken studio name widened the portal on a phone. Fixed in CSS.
Pages: [testing](testing.md).

## [2026-11-19] security | Review of the portal, dashboard and activity endpoint
`security-review` run on the three local commits before pushing. No finding. Checked: endpoint
authorization and RLS, response contents, plan geometry drawn as SVG in another user's browser,
text-only DOM building, the blank-canvas flow, the content security policy on both pages.
Noted, not fixed: audit event ids are sequential across studios.
Pages: [security](security.md), [open-items](open-items.md).

## [2026-11-19] docs | Workflow order corrected in CLAUDE.md
The `security-review` skill reviews local commits against `origin/main`, so the rule is now: commit,
review, then push. Pages: [security](security.md).

## [2026-11-23] build | Phase 2: brief, finishes, images, moodboard, AI consultant
Backend: three-plus migrations (tables, asset quota trigger, atomic consultant reservation), endpoints for
brief, finishes, assets, moodboard and consultant, tests first. Frontend: `design.html`, `consultant.html`
built by a general-purpose agent from the design system. Commits `90763ab`, `2c7278f`, `8a5bcc2`, `797dcec`,
`5466898`, `f50c0bb`. Pages: [overview](overview.md), [architecture](architecture.md), [decisions](decisions.md),
[design](design.md), [open-items](open-items.md).

## [2026-11-23] security | Review of the Phase 2 backend
Several findings fixed (suspended studios, upload race, consultant cap and context injection); see
[security](security.md).

## [2026-11-23] test | Phase 2 verified
Backend 94 passed, frontend 31 passed. Pages: [testing](testing.md).

## [2026-11-26] build | PDF importer added on the PDF-IMPORTER branch
A separate browser app under `pdf-importer/` (TypeScript, React, Vite, no backend), imported with its
history in `3a5b862`. Built so far: safe PDF reading, scale calibration, data model, room geometry.
Tests at import: 374 unit, 26 edge, 16 browser tests pass; regression needs private samples. Nothing in
`frontend/`, `backend/` or `supabase/` changed. Pages: [pdf-importer](pdf-importer.md),
[open-items](open-items.md), [index](index.md).

## [2026-11-26] decision | PDF importer keeps a Hebrew UI
The user decided the importer's screens stay in Hebrew, right to left, as an exception to the
English-only UI, for `pdf-importer/` only. Open item removed. Pages: [pdf-importer](pdf-importer.md),
[open-items](open-items.md).

## [2026-11-26] build | PDF importer: first screen (upload, page choice, zoom and pan)
Upload by drop or button, page buttons, the page redrawn sharp after each zoom, pan with the middle
button or space. An independent review found a redraw queue that could end the reader on a very heavy
page, readers and bitmaps not released, and a Firefox wheel step 33 times too small; all fixed and
re-reviewed. Tests: 387 unit, 26 edge, 126 browser. Not checked: Safari, Edge, a real screen reader, a
change of pixel density between monitors. Pages: [pdf-importer](pdf-importer.md).

## [2026-11-26] build | PDF importer: project file and autosave
Storage only, no buttons yet: serialize and check a project file (size limit 64 MB, zod schema,
embedded PDF checked), save through the File System Access API with a download fallback, and an
autosave draft in IndexedDB guarded by a Web Lock so one tab owns it. Three review rounds fixed real
loss paths: backups stopping after the first save, a second tab overwriting the first tab's draft,
and a wrong system clock deleting a draft. User decision: a draft older than 14 days is flagged and
asked about, never deleted silently. Tests: 428 unit, 26 edge, 202 browser. Not checked: Safari, the
native save dialog, a real full disk. Pages: [pdf-importer](pdf-importer.md).

## [2026-11-26] build | PDF importer: one checked transition for edits, undo, mamad lock
`apply(project, action)` accepts or refuses every edit of the existing state with a reason, never
mutates its input, and checks each accepted project against the file schema; history gives 100 undo
steps. User rules: the walls of the protected room (mamad) cannot be edited and nothing can be built
inside it while it is marked; its door and window can be corrected; two doors or two windows in one
mamad opening are valid. Review found a long wall could still reach into the mamad and a chain of
three overlapping doors was accepted; both fixed (the mamad's outline must come out unchanged).
Tests: 482 unit, 28 edge (30,000-step random walk), 202 browser. Pages: [pdf-importer](pdf-importer.md).

## [2026-11-26] build | PDF importer: only the mamad is locked, not the whole wall
User decision: a long wall that bounds the mamad and another room may be corrected outside the
mamad (split before the mamad's corner joint, far end moved along its line); along the mamad its
line, thickness and corner joints are kept, it cannot be deleted, and no wall may be laid along it.
Review found the corner joint could be uncovered and that the new rule blocked an ordinary edit of a
neighbouring wall; both fixed. Tests: 497 unit, 28 edge, 202 browser. Pages: [pdf-importer](pdf-importer.md).

## [2026-11-26] build | PDF importer: finish layers (plaster or cladding)
A finish of 1 to 200 mm per wall side and per free wall end, drawn as a strip that runs across
openings (user: a door or window is not the full height of the wall), mitred at corners, never along
a balcony; `roomAfterFinish` gives the net room, `roomMetrics` the gross one. The project file gained
two optional fields; earlier files still open. Review found that splitting a wall copied an end
finish to the cut, and that small joint edges were left bare (up to 0.007 m2 at 20 cm); both fixed.
Known limits are listed in the plan. Tests: 528 unit, 43 edge, 202 browser. Pages: [pdf-importer](pdf-importer.md).

## [2026-11-26] build | PDF importer: windows, entry door and outer walls locked by default
User rule: windows, the entry door, the mamad's door and window, and the outer walls are a given.
They are locked from the moment they exist; the only way to correct a detection error is a
deliberate release of that item, then confirm, which locks it again. Inner doors and inner walls stay
free. Approving the existing state needs everything confirmed and nothing released. The project file
gained two optional fields; earlier files open with these items locked. Review found a lining on an
outer wall's inside face was wrongly refused and that the locks cost 0.2 to 0.3 s per edit on a
1,000-wall plan; both fixed (now about 0.03 to 0.13 s). Tests: 557 unit, 43 edge, 202 browser.
Pages: [pdf-importer](pdf-importer.md).

## [2026-11-26] build | PDF importer: calibration screen and free measuring
The designer marks written dimensions (two snapped points and the number), the scale is fitted, and
nothing can be measured before a scale is accepted; continuing without full verification leaves a
permanent warning. User choices: marking at any zoom, the left button drags and a short click marks.
Review found the snap preview went stale after a zoom without a pointer move (the click landed about
7 cm off at 1:50) and a clip of 300,000 points crashed the page; both fixed, marks got an outline for
contrast. Tests: 579 unit, 43 edge, 248 browser. Not checked: real drawings, touchpads, Safari.
Pages: [pdf-importer](pdf-importer.md).

## [2026-11-26] test | PDF importer: calibration tried by the user on real drawings
Two blind tests: Claude chose dimensions and measured them from the file's geometry, the user marked
the same dimensions in the app; all nine agreed within 0.2 cm. One plan verified at 1:50 with a
constant offset of about 5 cm (written dimensions are net), the other at 1:50 with none. The first
attempt showed a gap: with contradicting dimensions the screen did not say which one differed.
Added: the signed difference on every row, and a mark on the one dimension that differs from the
others, worded as an invitation to check (in that first attempt the three that agreed were the wrong
ones). Review tightened the rule until random tests marked no correct row. Tests: 591 unit, 43 edge,
254 browser. Pages: [pdf-importer](pdf-importer.md).

## [2026-11-27] feature | PDF importer: editor screen, part 1 (walls, rooms, locks, undo)
The user tried three ways of drawing a wall in a throwaway try-out and chose two clicks on the
wall's centre line with a typed thickness, against the recommendation (corners of a face). To cover
its weak point the snap was measured on 16 private drawings (ids only): mean error 35 mm with the
whole page on screen, 6 mm zoomed in, so the tool asks to zoom in while a screen pixel covers more
than 5 mm, snaps midway between the two faces of a wall, and holds a free point to the axis. Also
from the user: a material per wall (a small model change), a plaster note, no lock icons (class and
lock are told by paint and words), buttons of one size, and one view-reset control. A hand-drawn
project starts with its outer walls open, because they are unknown until rooms are marked. Review:
six important findings fixed in two rounds (undo of a recalibration left the screen on the old
scale; two silent ways to unlock the protected room; the axis hold moved a snapped wall end by
60 mm; keyboard order). Tests: 623 unit, 43 edge, 354 browser. Not checked: real hands on real
drawings, a real Hebrew keyboard, screen readers, Edge, Safari, drawings of 480 walls and more.
Pages: [pdf-importer](pdf-importer.md).

## [2026-11-28] feature | PDF importer: editor screen, part 2 (openings, separators, finishes)

The editor now adds doors, windows and passages to a wall, separator lines between spaces, a split
tool, moves of a wall end or an opening edge by two clicks (a drag always pans), and finish layers
with net and gross areas. Windows, the entry door and openings on a protected-room wall are locked
from the moment they exist: a change is refused with a note until a deliberate release. Review:
three important findings fixed in one round (a locked outer wall could be lengthened along its own
line with no release; a wall holding a window could not be lengthened by a click; every pointer
move redrew all walls). A 500-wall draft keeps a preview frame under 50 ms in both browsers.
Tests: 637 unit, 43 edge, 418 browser. Not checked: real hands on real drawings, diagonal walls
with openings, Edge, Safari, screen readers, edits on drawings of 480 walls and more.
Pages: [pdf-importer](pdf-importer.md).
