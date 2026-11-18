# StageSheet — Development Plan

Planning docs for StageSheet, the offline-first setlist manager that prints
black-on-white A4 sheets. These files are versioned with the code and replace
the earlier drafts that lived outside the repo (now removed).

| Doc | Contents |
| --- | --- |
| `docs/plans/development-plan.md` | Constraints, stack decisions, phases, QA strategy, risks (this file) |
| `docs/plans/upcoming-features.md` | Per-feature specs and the prioritized backlog |
| `docs/status.md` | Implemented-vs-missing feature status (mirrors the plans) |

Maintenance rules:

1. Plans are updated in the same commit as the change they describe. Never
   reference paths outside the repo.
2. Phase/feature status must match reality. Update this file and
   `docs/status.md` together.
3. The serialized data contract lives in `SKILL.md`. Feature specs extend it;
   they never fork it, so there is only one contract to keep in sync.

## Hard constraints

1. **Print output is plain black-on-white on A4 paper.** No dark-stage or
   high-contrast theme for the sheet itself.
2. UI chrome may have its own theme, but `<div id="setlist-sheet">` — preview,
   print, and every export — is always white background, black text.
3. All exports paginate to A4 (210 × 297 mm, `@page { size: A4 }`).
4. Setlist duration is computed in Rust, never only in the UI.
5. All storage stays under `<app_data_dir>/stagesheet/`; the frontend `fs`
   capability is scoped to `$APPDATA/stagesheet/**`.

## Stack decisions

| Decision | Choice | Status |
| --- | --- | --- |
| App shell | Tauri v2, vanilla TypeScript + Vite (no UI framework) | **Done** |
| Rust core | Shared `stagesheet_lib` crate: `lib.rs` (mobile + desktop) called by `main.rs` | **Done** |
| Rust deps | serde + serde_json, uuid (v4), chrono, thiserror, tokio | **Done** |
| Storage | JSON files under `<app_data_dir>/stagesheet/` (songs.json, setlists/, logos/) | **Done** |
| Plugins | `tauri-plugin-fs`, `tauri-plugin-dialog`, `tauri-plugin-opener` | **Done** |
| Mobile share | No official Tauri v2 plugin; verify a community crate only when the feature is built | Deferred (P2) |
| Export | DOM raster (`html-to-image`) + `jspdf` A4; pure-Rust vector PDF (`typst`) post-MVP | **Done** (Phase 5a, Feature 6) |

The data model itself is pinned in `SKILL.md`; this plan intentionally does not
duplicate the struct definitions.

## Phases

### Phase 1 — Scaffolding + early mobile split — Done

- Tauri v2 vanilla-TS scaffold; `lib.rs`/`main.rs` split verified immediately
  (the expensive-to-retrofit piece was moved to the front on purpose).
- `tauri android init` / `ios init` deferred: needs JDK/Android SDK, and iOS
  initialization is macOS-only. `src-tauri/gen/` does not exist yet.

### Phase 2 — Models + unit tests — Done

- Models per `SKILL.md`, with serde defaults/aliases so first-draft JSON still
  loads (tested by `migrates_first_draft_json`).
- Tests: serde round-trips, legacy migration, reorder bounds, duration with
  breaks, logo alignment parsing, plain-file-name traversal rejection.

### Phase 3 — Storage + IPC — Done

- JSON storage with temp-file + rename writes serialized by a tokio mutex.
- Capability scoped to `$APPDATA/stagesheet/**`; dialog open/save; no shell,
  no network.
- Full command list from `SKILL.md`; every command async, `Result<T, AppError>`.
- Logos validated by content (PNG/JPEG magic bytes, SVG root tag), 5 MiB cap,
  UUID file names, absolute paths never persisted.

### Phase 4 — UI — Done

- Song library with instant search + one-click add; header inputs; break
  insertion; up/down + drag reorder; inline BPM/key/duration/notes editing;
  logo upload with width/alignment controls; live A4 preview.
- The app runs degraded without the backend (`backendAvailable = false`), which
  later makes browser-only e2e tests feasible (see QA strategy).

### Phase 5 — A4 print + export — Done (physical-paper QA in Phase 6)

Done: A4 black-on-white preview, native print via `window.print()`,
`thead`/`tfoot` marked for repetition on print (Chromium is expected to repeat
them; WebKitGTK does not — see Feature 5's engine note), `break-inside: avoid`,
single-A4 cap with auto-fit table zoom (min 50%, applied and mirrored in the
fit label), plus per-setlist multiple-page mode (`page_mode`) with preview page
boundaries and an approximate page count (preview limitations found in real use
→ Features 10–11 in `upcoming-features.md`). PDF/PNG export ships as a 300 dpi
raster with full-height capture, sliced A4 pages, repeated header/footer, and
`Page N / M`; the native print path remains the text-sharp paper route.
The implemented print CSS uses explicit layout resets (`display: none` on
chrome, static positioning for the sheet) rather than the original `visibility`
trick — this is the reference approach; do not regress it.

#### Phase 5a — Export spike — Done

Goal: prove or kill the `html-to-image` raster approach in WebKitGTK **before**
any remaining feature is built on export expectations. `html-to-image`
rasterizes via SVG `foreignObject`, which has a history of fidelity problems in
WebKitGTK (font handling, CSS support, blank renders).

Steps:

1. Spike branch; add `html-to-image` + `jspdf` as dependencies.
2. Rasterize `#setlist-sheet` at ~300 dpi (A4 = 2480 × 3508 px) for a long
   setlist that includes a logo; produce a PNG and a sliced multi-page PDF.
3. Verify: fonts render (no fallback faces), the logo inlines (no blank box),
   strict black/white output, no canvas-taint or CSP errors, export completes
   in a couple of seconds, PDF page size is exactly A4.
4. Record results in a temporary spike note; delete it and the harness once the
   exporter has shipped.

Exit criteria: an A4 PDF that opens with correct dimensions and legible text at
100% zoom, **or** a documented fallback decision (PNG-only export plus the OS
"print to PDF" dialog for documents; vector PDF via `typst` post-MVP).

Accepted trade-off: raster export means exported text is bitmap. The native
print path prints live DOM text and stays the text-sharp path for paper.

Result: **GO (conditional)** for `html-to-image` + `jspdf` in WebKitGTK with a
preparation step (full-height capture + slicing, data-URL logo, warm-up raster,
colgroup workaround, header/footer decision). Findings were folded into
`SKILL.md` and the Feature 6 implementation; the spike note and untracked
harness were removed when the exporter shipped.

### Phase 6 — Cross-OS polish + QA/release — In progress

- Minimal frontend test harness (see QA strategy) and 44px touch targets. CI
  (`.github/workflows/ci.yml`) already runs the frontend build and Rust tests.
- Sheet correctness fixes from real use: Feature 10 done (per-combination
  column widths + header alignment); Feature 11 done (paginated
  preview/print frames). Both outrank new tooling.
- Library/setlist tooling slice: Features 12, 13, 14, 15, 16, 17, 18, and 19
  are Done. In-place library song editing, setlist duplication as a preset base,
  artist records + logos, the in-memory library artist filter, the setlist
  artist + per-artist picker + library lock, break-second precision, and the
  effective logo width control shipped. Duplication copies the setlist artist
  and shares the logo file. The only remaining overflow tool is the
  split-setlist helper. Specced next (Todo): Feature 20 (artist-first landing
  page + per-artist scoping). Feature 21 (print/export toolbar
  consolidation) is Done.
- `tauri android init` / `ios init` on provisioned machines; native share.
- Print QA on real A4 (checklist below), backup/restore, app versioning,
  signing/release automation (tracked in the roadmap, P3).

## QA strategy

**Rust gate:** `cargo test` in `src-tauri` (list in `SKILL.md`). Note: the
`tauri` crate needs the `webkit2gtk-4.1` system libraries to compile even for
pure model/storage tests, so the gate is environment-dependent (README lists
the packages; `.github/workflows/ci.yml` installs them on `ubuntu-latest`). If
that becomes a recurring blocker, split `models`/`storage`/`error` into a
dependency-light crate so the core tests compile anywhere; deferred until it
actually hurts.

**Frontend gate:** `npm run build` (TypeScript strict + Vite production bundle).
Both gates run in CI on every push to `main` and every pull request.

**Planned minimal harness (Phase 6):** Playwright smoke tests against the
production frontend in a plain browser. No Tauri IPC is needed because the app
already runs degraded (`backendAvailable = false`): cover sheet rendering, the
auto-fit loop and fit indicator, item add/remove/reorder, break insertion, and
assertions that `@page { size: A4 }` exists and `#setlist-sheet` stays
black-on-white. Plus Vitest units for `format.ts` (`parseDuration`,
`formatDuration`, `formatRuntime`). Keep the harness small; paper QA stays
manual by design. Feature 18 has landed with its manual QA (button location
at full and narrowed widths, confirm for persisted/draft setlists, cancel
keeps everything, post-delete selection + logo cleanup). The library/setlist
tooling specs carry their manual QA matrices (edit validation + id stability,
song + setlist duplicate fidelity, break conversion, artist CRUD + adoption,
filter combinations, lock gating + backup round trip); harness coverage
follows the same pattern once built.

**Print QA checklist (manual, real A4, per engine — WebKitGTK now;
WebView2/WKWebView when available):**

- Short setlist (8 songs) and long setlist (25 songs + 2 breaks at min fit).
- Logo present/absent × grayscale toggle.
- Rows never split across pages. In multiple-page mode every printed page
  carries its own header and footer (paginated frames, Feature 11), so
  repetition no longer depends on the engine's `thead`/`tfoot` support —
  record the result per engine to confirm.
- Multiple-page mode (`page_mode`): printed page count matches the on-screen
  frame count within ±1.

## Risks

| Risk | Mitigation |
| --- | --- |
| `html-to-image` fidelity in WebKitGTK (SVG foreignObject) | Phase 5a spike verified the raster path with the prep step; cross-engine and physical-paper QA remain in Phase 6; PNG fallback and vector PDF via `typst` stay post-MVP options |
| Print pagination differs per engine | Repeated thead/tfoot + `break-inside: avoid` already implemented; manual paper QA per engine |
| `cargo test` needs webkit2gtk system libs locally and in CI | README prerequisite; `.github/workflows/ci.yml` installs the packages; optional dependency-light test crate if blocked |
| Temp+rename writes have no `fsync`; a crash can lose the newest write (Windows does remove+rename, widening the window) | Accepted for MVP; backup/restore (P1) gives users an escape hatch; add fsync if data loss is ever reported |
| `songs.json` degrades past ~1000 songs / slow search | Trigger to migrate to SQLite (P3) |
| Count-based column presets drifted for some toggle combos | Fixed by Feature 10: per-combination widths summing to 100% + alignment QA matrix |
| Tall-sheet + overlay preview reads as cut-off text | Feature 11: paginated A4 frames with repeated header/footer for preview and print |
| `zoom` in print CSS is WebKit/Blink-only | All Tauri engines are WebKit-family; revisit only if a plain-browser build is ever shipped |

## Status log

- 2026-11: Phases 1–4 done; A4 preview + native print + single-page auto-fit
  done (commits `ed09df4`, `db7f279`). Planning docs moved into the repo.
- 2026-11-17: Features 1–5 shipped (tuning, break labels, comments, sheet
  column toggles, multiple-page mode); Phase 5a export spike closed GO
  (conditional). Feature 6 shipped the PDF/PNG exporter (full-height raster,
  data-URL logo, colgroup workaround, repeated header/footer, page numbers,
  open-after-export) and removed the spike note/harness. The single-page fit loop
  now divides the painted table height by the preview scale so the applied zoom
  and overfull warning are window-width independent. Physical-paper QA and
  cross-engine status remain Phase 6.
- 2026-11-17: P1 CI gate added (`.github/workflows/ci.yml`): `npm ci` +
  `npm run build` + `npm run test:rust` on `ubuntu-latest` with the Tauri Linux
  packages, npm/Cargo caching, no secrets, bundles, signing, or mobile builds.
- 2026-11-17: Plan cleanup from real use: header/body misalignment with some
  toggles off (count-based `.cols-4`/`.cols-minimal` presets don't sum to 100%
  for all combos) and multi-page preview reading as cut-off text (dashed
  overlays, no repeated header/footer). Tracked as Features 10 (widths
  rebalance + alignment matrix) and 11 (paginated preview/print frames);
  both P0, above new tooling.
- 2026-11-17: Features 12–15 specced (library/setlist tooling, Todo):
  in-place library song editing, setlist duplication as a preset base,
  in-memory artist filter, then a toggleable per-setlist artist lock.
  `upcoming-features.md` cleaned up in the same pass: shipped Features 1–11
  condensed to summaries (contract facts live in `SKILL.md`), full specs kept
  for the Todo slice, backlog reprioritized.
- 2026-11-17: German user feedback folded into the plan as Features 14–18:
  managed artists (name + logo) that songs and setlists reference by id,
  record-based library filter, setlist artist with a per-artist setlist
  picker + lock, break durations with second precision (11-second breaks),
  and Delete-clarity (Delete moves next to Save, away from Add Break; the
  label stays Delete, the confirm already exists). Features 14–16 form a build chain;
  12, 13, 17, 18 are independent. Former free-text artist filter/lock specs
  rewritten onto artist records; library-canonical song data locked as a
  decision (no propagation of library edits into setlists).
- 2026-11-17: Feature 10 shipped (per-combination column presets summing to
  100%, colgroup-only widths, header/body alignment symmetry). Feature 11
  (paginated preview/print frames) remains Todo.
- 2026-11-18: Feature 11 shipped (measured A4 page frames with cloned header
  and footer in preview and print; frame count equals exported PDF page
  count). Both P0 sheet-correctness items from real use are now done;
  physical-paper QA and cross-engine checks remain on the Phase 6 checklist.
- 2026-11-18: Feature 12 shipped (inline library song editor with the add
  form's validation and bounds, stable-id upsert through `save_song`, active
  search/sort/tuning filter preserved, Cancel/Escape discard without touching
  the cache, copy-semantics status line). Drafts and validation markers survive
  unrelated library re-renders; an idle hidden row cancels with a status
  announcement, while a hidden row during a save resolves on outcome (success
  closes normally, failure marks the draft retry-pending so it survives later
  hidden renders and returns with a titled retry notice). Failed/discard
  statuses name the song. Saves lock the fields and a retry clears
  retry-pending with a titled “Saving…” status. Focus restoration is
  ownership-aware, Ctrl/Cmd+S routes to the active song form, row deletion is
  blocked while that song is saving, Add-to-library requests are single-flight,
  a successful Add preserves a focused inline editor’s caret, and Add failures
  name the attempted title. Back up/Restore refuse while a library write is in
  flight or an inline draft (including failed) is open, and both lock library
  rows/Add while they own the snapshot; Restore re-enables them when it
  finishes (after adopting on success or on the failure path). Setlist
  editor/header actions stay unlocked, and a setlist draft edited during restore
  may be replaced by the adopted state. A successful Add focuses its title when
  the Add form still owns focus (including page-lost focus when no editor draft
  exists), or when it owned focus at submit, focus remains page-lost, and no
  inline editor focus target exists; otherwise a focused inline field/button and
  selection are restored, with outside focus cancelling any deferred restore. No
  Rust, IPC, storage, backup-file format, or contract change. Features 13–17
  remain Todo.
- 2026-11-18: Feature 17 shipped (break lengths in seconds). `Break.duration_secs`
  replaces `duration_mins` with a serialized-seconds-only shape; deserialization
  still accepts legacy minute JSON × 60 (seconds win when both exist, u32
  saturation keeps oversized old values loadable) and the frontend normalizer
  does the same for backup restore. Validation stays save-only at
  `0..=36000` seconds. The editor uses an `mm:ss` field (`maxlength` 6) with
  the song-duration invalid/status pattern and Save commits valid field text
  before re-checking the rendered fields (including Ctrl/Cmd+S while the field
  still has focus); the sheet, editor meta, preview, print, and export share
  `formatBreakDuration` (`11 sec` / `10 min` / `1 min 5 sec`). Totals keep
  `formatRuntime`. No print/export structure change. At that point Features
  13–16 were Todo; 15 → 16 remain the artist-chain steps after Feature 14.
- 2026-11-18: Feature 14 shipped (artist records with logos). `artists.json`
  plus `list_artists` / `save_artist` / `delete_artist`, shared logo pool and a
  reference-aware `remove_logo`; `Song.artist_id` with name-snapshot fallback
  and legacy-text resolution, plus the declared `Setlist.artist_id` for
  Feature 16. The library pane gained an Artists section (thumbnails, resolved
  counts, shared create/edit form, confirmed delete with best-effort reference
  cleanup and per-record reporting) and both song forms use record dropdowns
  with a "Keep text" option. Renames never rewrite songs/setlists; the
  `resolveSetlistLogo` chain is ready for Feature 16. Backup adds an additive
  schema-1 `artists` array and restores artists → songs → setlists. Follow-up
  review hardening: backup/restore treat non-pristine artist forms as drafts and
  re-check after reading the restore file; artist edit visuals sync
  immediately; logo imports lock artist Save; artist delete refuses during
  library song writes/drafts and locks library rows while clearing references.
  Features 13, 15, and 16 remain Todo.
- 2026-11-18: Feature 15 shipped (in-memory library artist filter). The
  `.library-controls` row gained a labeled **Artist** select (`All artists`
  default, 44px target, resolved counts in the option text) backed by
  `artistFilter: string | null` (`null` = all, an artist id, or `"none"` for
  No artist). It is view-only: never persisted, never dirties a setlist, and
  never enters the backup envelope. `libraryArtistBucket()` shares
  `resolveArtistForSong()` identity with the Artists counts, so id-backed and
  same-named legacy-text songs group together, while unmatched non-empty legacy
  text stays under All artists and in search. Filtering runs before the
  existing sort and combines with instant search and Has tuning; empty states
  name the active constraint (`No songs by “<name>” match that search.` /
  `No songs by “<name>” yet.`, with No-artist equivalents). Options rebuild on
  every library render, covering add/edit/duplicate/delete/restore and artist
  create/rename/delete, and a deleted selection resets to All artists. Feature
  12's draft retention, hidden-row cancellation, save locking, focus, and row
  layout behavior is unchanged. No Rust, IPC, storage, or contract change.
  Features 13 and 16 remain Todo; 16 follows.
- 2026-11-18: Feature 16 shipped (setlist artist + per-artist setlist picker +
  library lock). The editor gained an Artist select (`No artist` = unlocked,
  dirty + persisted, dangling ids unlocked), and the header gained a view-only
  Artist picker that filters the setlist select by saved `artist_id`, keeps the
  open setlist available, shows a zero-match placeholder, and pre-assigns New.
  A live setlist artist A narrows the library to A through
  `resolveArtistForSong()` identity (id plus matching legacy text), forces and
  disables the Feature 15 Artist select with a note, and restores the previous
  in-memory selection on unlock. Library adds outside A are refused with
  `“<title>” is not by <A> — switch the setlist artist to add it.`; breaks stay
  allowed, existing items are untouched, and the summary carries `· A` plus a
  non-matching count. Preview, print, and export share `resolveSetlistLogo()`
  (own → artist → placeholder) through the existing logo URL/data-URL and
  export width plumbing; the Logo controls still edit the setlist's own config.
  `normalizeArtistId()` covers load/clone/adopt/save/restore, the backup schema
  stays 1, and the Feature 14 Rust tests already cover with/without the field,
  legacy loading, and dangling ids. Feature 13 remains Todo and will copy
  `artist_id`.
- 2026-11-18: Feature 13 shipped (duplicate setlist as a preset base). The
  header gained **Duplicate** beside **Delete** (44px `btn`, `type="button"`);
  it saves a dirty editor first like Print, aborts with the save error or the
  standard backend-unavailable message, and writes a new `Setlist` through
  `save_setlist`. `cloneSetlist()` deep-copies items (song snapshot ids stay
  values), venue, date, logo config, `sheet_options`, `page_mode`, and
  `artist_id`; the logo `file_name` is shared. Titles use
  `X` → `X (copy)` → `X (copy 2)`: the source is trimmed, an existing suffix is
  stripped, and a blank title falls back to `Untitled setlist`; candidates
  compare trimmed, case-insensitively over stored setlist titles. Success
  selects the clean copy in the header (even outside the per-artist filter) and
  reports `Duplicated “<title>” as “<copy title>”.` No confirmation was added.
  Shared-logo deletion needs no new code: `deleteCurrent` (and `remove_logo`)
  skip files still referenced by another setlist. No Rust, IPC, storage,
  backup-schema, sheet/colgroup/frame/print-CSS, raster, CSP, or capability
  change. The split-setlist helper remains the open overflow item.
- 2026-11-18: New user feedback specced as Features 19–20 (Todo): the
  setlist editor's width slider will control the currently displayed logo
  (artist width editable in place via `save_artist`, an uploaded own logo
  adopting the effective size/alignment, removal falling back to the band
  logo), and an artist-first mode will gate startup behind artist
  creation/selection with per-artist song libraries and setlists
  (`artist_id` mandatory on save with legacy records unfiled until
  assigned; Feature 15's library select, Feature 16's lock chrome, and the
  per-setlist editor Artist select are superseded). The split-setlist
  helper stays open behind both.
- 2026-11-18: Print/export toolbar feedback specced as Feature 21 (Todo):
  Print moves beside the export buttons, `Export PDF`/`Export PNG` merge
  into one Export button with an in-place PDF/PNG menu (keyboard-operable,
  Escape returns focus), and the `.print-hint` pill becomes a
  `title` tooltip on the Print button. Print stays one-click
  `window.print()`; no exporter, raster, or print-output change.
- 2026-11-18: Feature 19 shipped (effective logo width control). The Logo
  width slider edits the displayed logo: own/placeholder stay input-driven
  on `setlist.logo.width_mm`, the artist path commits `artist.logo.width_mm`
  via `save_artist` on `change` without dirtying the setlist (one in-flight
  save, Feature 14 guards, slider revert on refusal/failure, shared-size
  status). Uploading an own logo adopts the displayed width/alignment;
  removal falls back to the artist logo with the slider following. The Logo
  fieldset shows `Setlist logo` / `<name> logo (artist)` / `No logo yet`;
  the Artist-section note is retired. No Rust, IPC, storage, backup-schema,
  sheet/colgroup/frame/print-CSS, raster, CSP, or capability change.
  Features 20–21 remain Todo.
- 2026-11-18: Feature 21 shipped (print/export toolbar consolidation). Print
  moved from the header into the preview toolbar first; Export PDF/Export PNG
  merged into one Export button with an in-place PDF/PNG menu (keyboard:
  Enter/Space opens, arrows navigate, Escape returns focus; the button and
  its entries lock while a capture runs). The Ctrl/⌘+P pill is gone; the
  Print button carries it as a hover tooltip. No Rust, IPC, storage,
  backup-schema, sheet/colgroup/frame/print-CSS, raster, CSP, or capability
  change. Feature 20 remains Todo.
