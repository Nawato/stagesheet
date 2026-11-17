# StageSheet — Upcoming Features Plan

Per-feature specs for what ships next, ordered by priority. The current data
contract lives in `SKILL.md`; these specs extend it and must update it in the
same commit. Statuses: **Todo** / **In progress** / **Done**.

Context: `Song` today is `{ title, artist, bpm, key, tuning, duration_secs,
notes }` (`src-tauri/src/models.rs`, `src/types.ts`). Setlist items store Song
*copies* (deliberate: editing the library never rewrites saved setlists). The
sheet defaults to a single A4 page with auto-fit shrink (`--sheet-fit`, min
50%), implemented in `main.ts` (`fitSheetToPage`) and `print.css`; per-setlist
`page_mode` (Feature 5) opts into multiple pages instead. Column widths come
from per-combination presets in `app.css` (Feature 10; each sums to 100%);
multi-page preview and print use measured A4 page frames (Feature 11).

Decisions locked in: tuning is a **free-text optional field** (same pattern as
`key`), not a preset picker or per-instrument map.

## Cross-cutting: validation hardening (shipped with Feature 2) — Done

`Setlist::validate()` now walks every item, so break items are validated at the
same boundary as songs and the logo config. All bounds are enforced in Rust:

- Break `duration_mins` within `0..=600` (error otherwise; the UI clamps the
  same range).
- Break `label` (Feature 2) ≤ 24 chars after trim.
- `Song.notes` and `Break.note` (Feature 3's "Comment") ≤ 140 chars after trim.

Back-compat rule: validation runs **on save only**. Old files with over-long
values still load; their next save fails with a clear message, and the UI
`maxlength`/`max` attributes prevent new violations. No silent truncation.

## Feature 1: Song tuning (free text) — Done

Status: shipped. The column is shown when the setlist's `show_tuning` toggle is
on *and* at least one song in the setlist has tuning set.

### Spec

- New field `Song.tuning: Option<String>` — e.g. `E Std`, `Drop D`, `Capo 2`, `Eb`.
- Displayed on the printed sheet so players see retunes before the song starts.
- Library search includes tuning (today: title, artist, key).

### Data model + validation

- Rust (`models.rs`): `#[serde(default)] pub tuning: Option<String>`, trimmed,
  empty → `None`, max 24 chars (`validate()` error otherwise — keeps A4 rows
  sane).
- TS (`types.ts`): `tuning: string | null`. Keep both files in sync (they are
  the on-disk JSON contract).
- Migration: missing field deserializes to `None`; no data rewrite needed.
- Because setlist items hold Song copies, retuning a library song does not
  rewrite saved setlists (same as key/BPM today) — intended, already documented.

### UI

- Library "Add to library" form: `Tuning` text input, `maxlength=24`,
  placeholder `E Std`.
- Editor "Edit details" per song row: same Tuning field next to Key; live sheet
  update.
- Search predicate gains `song.tuning`.

### Sheet + print

- New conditional `Tuning` column: rendered **only if ≥1 song in the setlist
  has tuning set**, otherwise today's 5-column layout is untouched.
- Rebalanced `<colgroup>` when present: index 6%, song 50%, key 9%, tuning 10%,
  bpm 9%, time 16% (today's baseline is 7/55/10/10/18). Em-dash `—` for songs
  without tuning (matches key/BPM style). Verify widths on the Phase 6 QA
  setlists before calling it done.
- Print CSS inherits black-on-white + `break-inside: avoid` automatically; no
  new print rules except column widths.
- Width risk is bounded by the 24-char validation; height risk is absorbed by
  the existing auto-fit loop. QA must include a 20+ song setlist with tuning on
  every row at min fit.

### Tests + QA

- Rust: serde round-trip with/without tuning; old JSON (no field) loads as
  `None`; validation rejects >24 chars and trims whitespace.
- Frontend (manual per QA checklist): add/search/edit tuning; sheet shows/hides
  the column; print preview on A4; `tsc --noEmit` + `vite build` clean.
- Docs: update `SKILL.md` schema block with `tuning`.

### Build order

1. Rust model + validation + tests.
2. TS types + library form + editor field + search.
3. Sheet conditional column + widths (honor the `show_tuning` toggle from
   Feature 4).
4. QA + `SKILL.md` + this file status + commit.

## Feature 2: Customizable break block — Done

Shipped: `Break` gained an optional trimmed `label` (max 24 chars), the editor
has a Label field plus Minutes and Comment, and the sheet/editor render
`[label] · [duration] · [comment]` with `Break` as the fallback label. The
Rust-side break bounds from validation hardening landed in the same change.

Status: the scaffolded break shape was kept and the UX extended — no migration
needed beyond the serde default for `label`.

- **Length input stays**: minutes number field (0–600), already in the editor;
  the bound moves into Rust `validate()` (see validation hardening above).
- **Custom label**: new optional free-text `label: Option<String>` on the
  `Break` variant, `#[serde(default)]`, default render `"Break"`
  (e.g. `Intermission`, `Encore`, `Changeover`). Max 24 chars, same
  trim/empty→None pattern as other fields. Keep `duration_mins: u32` — the
  bound lives in `validate()`, not in the integer width.
- **Comment**: the existing `note` field is the break's comment — unified with
  the song comment UX in Feature 3 (labeled "Comment" in the UI).
- Sheet: break row renders `[label] · [duration] · [comment]`, label bold,
  keeping the current dashed-row style. Label + comment respect the toggles in
  Feature 4 (duration is structural, always shown).
- TS: add `label?: string | null` to the `Break` variant in `types.ts`; existing
  JSON without it stays valid.

## Feature 3: Comment field on songs + breaks — Done

Status: complete. `Song.notes` and `Break.note` stay serialized under their
original names, are labeled **"Comment"** in the library form and both editor
panels, carry `maxlength=140`, and are rejected on save when longer than 140
chars after trim (shipped with Feature 2). Song comments render under the title
and break comments inline when the setlist's Comment toggle is on; blank values
emit no element.

- Keep serialized names (`notes` / `note`) for JSON back-compat; label both
  **"Comment"** in the library form and editor so users find the same concept
  twice.
- Song comment renders under the title in the song cell (current behavior).
  Break comment renders inline in the break row (current behavior).
- New bound: max 140 chars each (Rust `validate()` + UI `maxlength`) so one
  verbose note can't blow the single-A4 budget; the height remainder is
  absorbed by auto-fit. Longer text belongs in rehearsal docs, not on the stand.
- Legacy caveat: a saved setlist with a >140-char note loads fine, but its next
  save fails validation until the note is trimmed — the status line explains
  it. Accepted; no silent truncation.
- Both gated by the Comment toggle (Feature 4).

## Feature 4: Toggleable sheet blocks — Done

Status: shipped. `SheetOptions` is persisted per setlist with all five blocks
defaulting to visible; old files and partial objects load unchanged. The editor
has a "Sheet columns" checkbox group above the preview (44px targets); each
change marks the setlist dirty and re-renders preview and print from the same
options. `sheet.ts` builds the visible columns, header, `<colgroup>`, and
colspans dynamically, and the table uses the width presets below. The Comment
toggle gates song comments, break comments, **and the break label** (there is no
separate label toggle); break duration always renders. The tempo toggle is
labeled "Tempo (BPM)" while the narrow printed heading stays `BPM`.

Goal: every optional info block can be switched on/off per setlist; off = not
on the page (preview, print, and export all follow).

### Data model

- New `SheetOptions` struct persisted on `Setlist`:
  `show_key, show_tuning, show_tempo (BPM), show_duration (Time), show_comment`.
- Serde wiring (get this right or old files change appearance):
  - `Setlist.sheet_options` carries a **field-level** `#[serde(default)]`, so a
    missing field deserializes to `SheetOptions::default()`.
  - `SheetOptions` implements `Default` with **all fields `true`** and carries a
    **container-level** `#[serde(default)]`, so missing subfields are filled
    from the all-true Default — old and partial files render exactly as today.
  - Never add field-level bool defaults inside `SheetOptions`; those silently
    mean `false` for partial objects.
- Title/venue/date header and song titles always stay.

### UI + sheet

- Editor UI: a "Sheet columns" toggle group (checkboxes, 44px targets) above
  the preview; options persist per setlist and mark it dirty like any edit.
- `sheet.ts`: build the column list, header row, and `<colgroup>` dynamically
  from options; the song-cell artist line always shows; notes/comment lines
  render only if `show_comment`; break comment only if `show_comment`; the
  tuning column only if `show_tuning` **and** ≥1 song has tuning (refines
  Feature 1's rule).
- Column widths per visible set via preset classes on the table (starting
  values, verify on paper during QA):
  - `.cols-5` (today's baseline): index 7 / song 55 / key 10 / bpm 10 / time 18
  - `.cols-5-tuning` (Feature 1): 6 / 50 / 9 / 10 / 9 / 16
  - `.cols-minimal` (title + time only): 8 / 72 / 20
- Known issue at the time (resolved by Feature 10): the count-based `.cols-4`
  and `.cols-minimal` presets did not sum to 100% for every toggle combination
  (e.g. key+bpm = 92%), so header/body alignment drifted when some toggles were
  off. Feature 10 replaced them with per-combination presets.
- UI wording: label BPM as **"Tempo (BPM)"** to match band vocabulary.

## Feature 5: Multi-page A4 mode — Done (implemented; physical-paper QA pending)

Status: implemented. `Setlist.page_mode` persists per setlist (`Single` default,
so old files are unchanged), the editor has a Page layout Single/Multiple
segmented control above the preview (44px targets, marks the setlist dirty), and
both the preview and `window.print()` follow the mode. Multiple mode renders
measured A4 page frames with a repeated brand header and footer (Feature 11;
originally natural-height dashes) and an exact page count; single mode keeps the
`--sheet-fit` cap and warns when the measured fit drops below 70%. The fit loop
measures the table height relative to
the preview's `--sheet-scale` (see the 2026-11 review fix), so the required zoom
and the overfull warning no longer change with the window width. PDF export adds
page `N / M` numbering (Feature 6). Physical-paper QA (25 songs + 2 breaks on
A4, WebKitGTK first) remains on the Phase 6 checklist.

**Engine note (accepted/deferred):** WebKitGTK's print path does not repeat
`<thead>`/`<tfoot>` groups (WebKit bug 17205, still open); Chromium-based
engines are expected to. The CSS keeps `display: table-header-group` /
`table-footer-group` for engines that support it. Treat repetition and page-count
results as engine-dependent and record them during the Phase 6 physical-A4 QA –
do not commit a repro claim without the artifact. PDF export (Feature 6)
composites captured header/footer crops on every page, so it does not depend on
engine repetition.

Problem: single-page auto-shrink bottoms out at 50% (~6pt body) — still
overfull means clipped, illegible output. Multi-page is the legibility escape
hatch.

### Mechanism (previously under-specified — this is the reference)

- Data: `Setlist.page_mode: PageMode` with a field-level `#[serde(default)]`;
  `enum PageMode { #[default] Single, Multiple }` serializes as `"Single"` /
  `"Multiple"`. TS mirror: `page_mode: "Single" | "Multiple"` (optional on
  load) normalized by `withPageModeDefaults()`.
- **Single** (default): the sheet stays a fixed A4 page (`max-height: 271mm`
  content cap, `overflow: hidden`) and `--sheet-fit` zooms `.sheet-table` inside
  it, clamped to 50–100%. The zoom must not live on `#setlist-sheet`: zooming
  the fixed box scales the clip boundary with the content, so it never reveals
  more rows. The applied value is measured from the painted table height and
  written back to `--sheet-fit`, so the preview label always matches the real
  zoom; at the 50% floor the sheet may still clip and the label says so.
- **Multiple**: `--sheet-fit: 1`, the fit step is skipped, and both stylesheets
  get an escape hatch via a class kept in sync by the JS:
  `#setlist-sheet.multipage { height: auto; max-height: none; overflow:
  visible; }` (the print copy keeps the `!important`s). The base `!important`
  rules stay in place for single mode. `height: auto` is required because the
  screen stylesheet pins the sheet to 297mm; without it the taller table would
  still clip instead of paginating. `break-inside: avoid` keeps rows intact
  across pages. The `thead`/`tfoot` repeat rules remain for supporting engines,
  but WebKitGTK's print path does not repeat them (see the engine note above).
- Screen preview: the sheet renders at 100% zoom (`--sheet-fit: 1`) in the
  scroll area. Feature 11 replaced the original dashed separator overlay and
  "≈ N pages" meta label with measured A4 page frames: preview, print, and
  export all use the same row grouping, and the label reports the actual frame
  count.
- Legibility guard: when the applied single-page auto-fit drops below ~70%, the
  preview meta suggests switching (`A4 · single page · auto-fit 66% — try
  multiple pages`). The percentage is the actual applied table zoom (measured
  from the painted height and clamped to the 50% floor); if the table still
  overflows at 50%, the label says it is still overfull and points at multiple
  pages.
- Both `window.print()` and the PDF export (Feature 6) respect the mode. Page
  `N / M` numbering ships only in the PDF export path (no engine we target
  renders `counter(page)` in `@page` margin boxes).
- QA: 25 songs + 2 breaks in multi mode on real A4 (WebKitGTK first): rows
  never split and the printed page count matches the frame count. Header/footer
  repetition was engine-dependent before Feature 11; it is now real per-frame
  content.

## Feature 6: PDF/PNG export + direct print — Done

Status: implemented. The Phase 5a verdict was **GO (conditional)** for
`html-to-image` + `jspdf` in WebKitGTK given the preparation step below; that
prep ships in `src/exporter.ts`. The temporary spike note and harness were
removed once the exporter landed.

What shipped:

- **Full-height capture, never `--sheet-fit`.** Export prep temporarily applies
  the `.multipage` layout (`height: auto; max-height: none; overflow: visible;
  --sheet-fit: 1`), removes the preview transform, captures the whole sheet at
  2480 px wide (300 dpi A4), then restores the DOM. Single and multiple mode
  export the same natural-height content; a short setlist becomes one slice.
- **Column-width workaround.** The clone collapses every `<col>` width to 0 px in
  WebKitGTK, so prep removes the `<colgroup>` and inserts a hidden zero-height
  first row carrying the measured cell widths (keeping the designed fixed
  layout). The colgroup, table style, sheet classes, inline styles, and logo
  state are restored afterwards.
- **Export-only data-URL logo.** `storedLogoDataUrl()` in `logo.ts` reads the
  same scoped fs bytes and base64-encodes them; the live preview keeps its blob
  URL. No CSP or fs-capability change. Logos are forced to grayscale for the
  raster regardless of the preview toggle.
- **Warm-up.** A throwaway small `toCanvas` runs once per session to avoid the
  WebKitGTK first-capture blank-logo race.
- **PDF.** `new jsPDF({ unit: "mm", format: "a4", orientation: "portrait",
  compress: true })`, header + slice + footer images per page plus a vector
  page number, exactly 210 × 297 mm. Slices cut at A4 height minus the
  captured header/footer heights and snap to row tops. The header and
  footer are composited on **every** page (raw slices would repeat neither, and
  WebKitGTK's native print path does not repeat `thead`/`tfoot` either), and
  `Page N / M` is stamped into the bottom margin. All sheet text is bitmap;
  `window.print()` remains the text-sharp path. If the header/footer ever leave
  less than 30 mm of content, the exporter falls back to raw 271 mm slices
  rather than dropping rows.
- **PNG.** The same full-sheet raster as one file. A sheet shorter than A4 is
  padded to a 2480 × 3508 px (300 dpi A4) PNG; a long sheet stays tall. A sheet
  whose natural height would exceed WebKit's canvas limit is downscaled
  proportionally so the whole content exports at a lower effective dpi (normal
  setlists stay at 300 dpi).
- **Direct print + export-then-print.** The existing one-click Print button
  (`window.print()`, Ctrl/⌘ + P) is unchanged; export does not try to print
  silently. The preview toolbar adds **Export PDF**, **Export PNG**, and an
  **Open after export** checkbox. After writing, the checkbox opens the file
  through `tauri-plugin-opener` in the system viewer (where the OS print dialog
  lives). The capability is scoped to `$HOME/**`, `$TEMP/**`, and the app-data
  folder; the save dialog itself extends the fs scope to the chosen file. A file
  saved outside those trees still writes, but the automatic open reports a clear
  error instead of silently doing nothing.
- **Current state, not last save.** Export renders the current editor state
  through the same `sheet.ts` path, so `page_mode` and `sheet_options` are
  reflected exactly. The save dialog defaults to the Downloads folder with a
  sanitized `<title>.pdf` / `.png` name.

Verified during implementation in the Phase 5a engine (WebKitGTK 2.54, temporary
harness, no binaries committed): 2480 px captures, strictly grayscale output,
zero CSP violations, DOM restore byte-for-byte, PDFs reported by `pdfinfo` as
595.28 × 841.89 pt (A4) with repeated header/footer and page numbers, and
roughly 1.5–2 s for a 3-page PDF (≈0.7 s for a PNG). Physical-paper QA and
cross-engine (WebView2/WKWebView) verification remain on the Phase 6 checklist.

Out of scope: selectable/vector PDF text (`typst` post-MVP), silent printing
(no Tauri API; every paper path ends in an OS dialog), and PNG export of
individually paginated pages (the PNG is the full sheet by design).

## Feature 7: Backup/restore — Done

Status: implemented. The library pane has **Back up** and **Restore** actions
that read/write one human-readable JSON file through the dialog-scoped fs
permission. No new Tauri commands and no capability widening: export builds the
envelope from `list_songs` / `list_setlists`; restore re-saves records through
`save_song` / `save_setlist` so Rust validation and serde defaults stay
authoritative.

Envelope (`src/backup.ts`, `BACKUP_SCHEMA_VERSION = 1`):

```json
{
  "schema_version": 1,
  "exported_at": "2026-11-17T18:30:00.000Z",
  "songs": [ /* Song[] with tuning, comments */ ],
  "setlists": [ /* Setlist[] with items, sheet_options, page_mode, logo config */ ]
}
```

What shipped:

- **Export**: saving a dirty editor first (same rule as Print) keeps the backup
  consistent; the save dialog defaults to Downloads with a timestamped
  `stagesheet-backup-YYYYMMDD-HHmm.json` name.
- **Restore**: reads UTF-8 JSON, requires `schema_version` and array payloads,
  and normalizes records with the same defaults as serde (`sheet_options` all
  true, `page_mode` Single, legacy `logo_config` alias, case-insensitive logo
  alignment). A `schema_version` newer than the build supports is rejected with
  an "update StageSheet" message; `migrateEnvelope()` is the extension point for
  older versions. Structurally malformed records are skipped and reported;
  save-time validation failures are reported per record.
- **Overwrite warning**: restoring upserts by ID (overwrites the same songs and
  setlists, deletes nothing else) and confirms before writing. Both caches are
  reloaded afterwards and the editor stays on the same setlist when it still
  exists.
- **Logos stay manual in v1**: the envelope keeps `logo.file_name`, width, and
  alignment. A same-device restore keeps the logo; on another device the file is
  missing, the preview shows the placeholder, and the logo is re-imported
  manually. Base64 embedding is deferred to a later envelope version.
- **Status line** reports imported and rejected/skipped counts with the file
  name.

Verification: `npm run build` and `cargo test` (33 tests; no Rust changes).
Manual QA still needs a real desktop run (save dialog scope, restore counts, and
a fresh-profile round trip).

## Feature 8: Library polish — Done

Status: shipped. The library keeps instant search across title, artist, key, and
tuning and adds three view controls:

- **Duplicate song**: a per-row copy action saves a new song with a fresh UUID and
  a non-colliding ` (copy)`, ` (copy 2)`, … title suffix. Fields are copied
  verbatim; setlist items already hold song copies, so duplicating never touches a
  running order.
- **Sort**: a select for title (default), artist, key, or tuning. Blank values sort
  last, ties fall back to title, and the choice is in-memory only: it never marks a
  setlist dirty and is not backed up.
- **Tuning filter**: a **Has tuning** checkbox that shows only songs with a
  non-empty tuning. It combines with the instant search; the empty state names
  whichever filter/search is active.
- **Accessibility**: all new controls keep the 44px target. The sort and filter
  have visible labels; the icon-only duplicate button carries an aria-label and
  tooltip. Add, search, and delete-with-confirm are unchanged.

Verification: `npm run build` and `cargo test` (33 tests; no Rust or data-model
changes).

## Feature 9: Logo downscale on import — Done

Status: shipped. Imported PNG/JPEG logos are decoded in Rust; when either edge
exceeds `MAX_LOGO_DIMENSION` (1024 px) the image is resized with Lanczos3 and
its aspect ratio preserved. PNG stays PNG; JPEG re-encodes at quality 85.
Smaller rasters are stored byte-for-byte, and SVG stays vector and untouched.
Broken image bodies are rejected as invalid input even when the magic bytes
match. The 5 MiB upload cap is checked before and after processing.

Why post-export: export already rasterizes the logo at its printed millimetre
size rather than its source pixel size, so downscaling is not needed for print
fidelity. It still trims stored file size, decode memory, and disk use. At the
80 mm maximum print width, 1024 px is roughly 325 dpi.

Verification: `npm run build` and `cargo test` (37 tests).

## Feature 10: Column widths rebalance + header alignment — Done

Status: shipped. `sheet.ts` selects a preset from the visible info-column
combination instead of the column count: `.cols-2`, `.cols-3-{key,tuning,bpm,
time}`, `.cols-4-{key-tuning,key-bpm,key-time,tuning-bpm,tuning-time,bpm-time}`,
`.cols-5` (any three info columns including Time), `.cols-5-no-time` (the three
narrow columns), and `.cols-5-tuning` (all four). Every preset sums to 100% in
`app.css`, so fixed table layout no longer redistributes slack. `<colgroup>` is
the only width source; the numeric body cells now share the header's right
alignment and 1.5 mm horizontal padding. Print and export follow unchanged:
both render through the same `sheet.ts` path, and the exporter reads measured
header widths.

Reported from real use: with some sheet toggles off, the table header no
longer aligns with the body text. Root cause: widths come from count-based
presets (`.cols-2` / `.cols-minimal` / `.cols-4` / `.cols-5` /
`.cols-5-tuning`), but `.cols-4` only sums to 100% for 2 of its 6 column
combinations (key+bpm = 92%, key+tuning = 94%, tuning+bpm = 94%, bpm+time =
98%); `.cols-minimal` gives any lone info column 20% whether it is a narrow
Key or a Time column. With `table-layout: fixed` the browser distributes the
slack, so header and body cells drift apart.

### Spec

- Replace count-based presets with per-combination widths that sum to 100%:
  4 combos for 3-column tables (which single info column is visible), 6 combos
  for 4-column tables (which two are visible). Keep `.cols-5` (7/55/10/10/18)
  and `.cols-5-tuning` (6/50/9/10/9/16) as the verified anchors; derive the
  smaller sets from the same proportions.
- Single width source: `<colgroup>` only. Audit and remove any competing `th`
  width rules; check text-align/padding symmetry between header and body cells
  sharing a class.
- No data-model or IPC change. Print and export follow automatically (same
  `sheet.ts` path, same colgroup workaround in the exporter).

### Tests + QA

- QA matrix over every toggle combination (2-col, 3-col ×4, 4-col ×6, 5-col,
  6-col): header vs body alignment per combo, at full and narrowed preview
  widths, plus the Phase 6 paper setlists.
- `npm run build` clean; `cargo test` green (37 tests, no Rust change).

Verification: a stub-DOM harness rendered every combo and asserted the preset
class, `<colgroup>` order, and header/body class symmetry; each preset's CSS
widths were parsed and summed to exactly 100%. Paper QA remains Phase 6.

## Feature 11: Paginated multi-page preview + print — Done

Reported from real use: in multi-page mode the preview looks like the sheet
is cut off mid-text instead of showing multiple pages. Root cause: the preview
was one tall sheet with dashed sibling-overlay lines (`#sheet-page-marks`)
every 271 mm of content height. Rows could visually straddle a dashed line on
screen (`break-inside: avoid` only binds in print), and no header/footer
repeated per visual page — while the export PDF (Feature 6) *does* composite
header/footer per page, so preview and export disagreed.

Status: shipped. `src/pages.ts` paginates the rendered rows by measured height
and builds one A4 `.sheet-page` frame per page in `#sheet-pages`; each frame
clones the table's `<colgroup>`, brand header (logo, title, venue/date, column
labels), and footer, and the footer is pinned to the frame bottom. Pages break
at whole rows only. The tall `#setlist-sheet` stays in the DOM as the
measurement/export source but is hidden on screen and in print; screen shows
the frame stack (8 mm gap, scaled with `--sheet-scale`), print shows one frame
per page. The dashed `#sheet-page-marks` overlay and the `≈ N pages` estimate
are gone: the meta label reports the actual frame count, and the Single-mode
<70% nudge and 50% floor are unchanged. Export still captures and composites
the tall sheet through `exporter.ts`, and the frame split uses the same
header/footer-adjusted 271 mm capacity, so frame count equals exported PDF page
count. WebKitGTK's native print scales content by GTK's page setup rather than
CSS, so Linux WebKit is marked `html.webkitgtk` and `print.css` normalizes just
the frame stack (`zoom: 0.885`); other engines print the frames 1:1. The
existing `thead`/`tfoot` repeat rules remain for supporting engines.

### Spec

- Paginate rows by measured height in JS and render one A4 frame per page,
  each with its own cloned brand/header (logo, title, venue/date, column
  labels) and footer. Separator overlays become real page boundaries; nothing
  straddles them.
- Print the page frames instead of the tall sheet, so preview, print, and
  export all agree. This also sidesteps WebKitGTK bug 17205 (`thead`/`tfoot`
  never repeat on native print): repeated headers become real content,
  engine-independent. Keep the existing `thead`/`tfoot` repeat rules for
  engines that support them.
- The `≈ N pages` estimate is replaced by the actual frame count. The <70%
  legibility nudge and 50% floor (Feature 5) stay as-is.
- Export keeps its current compositing path (already correct); after this
  lands, preview matches export instead of contradicting it.
- Accepted fallback if frames prove too invasive: snap overlay lines to row
  tops and render ghost header labels at each boundary. This preserves the
  cut-off feel and is explicitly the worse option — take the frames unless
  measurement shows otherwise.

### Tests + QA

- 25 songs + 2 breaks at default and narrowed preview widths: no row straddles
  a page boundary on screen; every frame carries header + footer; frame count
  equals exported PDF page count.
- Native print (WebKitGTK first): page count within ±1 of the frame count,
  rows intact, headers on every page.
- `npm run build` clean; `cargo test` green.

Verification: the 25-song + 2-break fixture paginates to 3 frames at preview
scales 1, 0.6, and 0.28 (row order intact, header + footer on every frame,
each frame within the 271 mm content box). The real exporter (`prepareSheetRaster`
+ `buildPdfBytes`) on the same sheet produced a 3-page PDF whose page groups
match the frames exactly (1–8 + Intermission, 9–17, 18 + Encore + 19–25), and
WebKitGTK native print produced those 3 pages with the brand header and footer
on each. Chromium native print also produced 3 pages with headers/footers. With
a stored logo configured, every frame's cloned brand header carried the logo
`<img>` (frame count grew to 4 because the 40 mm logo shortens the body area).
Physical-paper QA and cross-engine (WebView2/WKWebView) checks remain on the
Phase 6 checklist.

## Roadmap backlog (prioritized)

- **P0 — Sheet correctness fixes (from real use)**: Feature 10 (column widths
  rebalance + header alignment) and Feature 11 (paginated preview/print
  frames) are done. The sheet is the product; new tooling stays behind these.
- **P0 — PNG/PDF export + print**: Feature 6 done. Physical-paper QA and
  cross-engine checks remain in Phase 6.
- **P0 — Overflow tooling for the single-A4 cap**: Feature 5 shipped
  (multi-page mode + sub-70% legibility nudge). Remaining slice: a
  split-setlist helper (duplicate setlist, move second half) as an alternative
  to multi-page.
- **P1 — Backup/restore**: Done (Feature 7). One versioned JSON envelope for
  the full library + setlists; logos are re-imported manually in v1.
- **P1 — CI**: Done. `.github/workflows/ci.yml` runs `npm ci` + `npm run build`
  and `npm run test:rust` on `ubuntu-latest` (Node 20, stable Rust, the
  webkit2gtk-4.1/gtk3/libsoup3 dev packages from the README) for pushes to
  `main` and pull requests. No secrets, bundles, signing, or mobile builds;
  signing/release automation stays P3.
- **P1 — Library polish**: Done (Feature 8). Duplicate song, view-only sort by
  title/artist/key/tuning, and a "Has tuning" filter; no data-model changes.
- **P2 — Mobile**: `android`/`ios init` on a provisioned machine, share-sheet
  export (verify a community share plugin first — not an official Tauri v2
  plugin).
- **P2 — Logo downscale**: Done (Feature 9). Raster logos are downscaled on
  import to a 1024 px longest edge; SVGs stay vector.
- **P3 — Scale-out**: SQLite migration past ~1000 songs; CI-based signing,
  release automation, auto-update.
