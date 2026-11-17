# StageSheet — Upcoming Features Plan

Per-feature specs for what ships next, ordered by priority. The current data
contract lives in `SKILL.md`; these specs extend it and must update it in the
same commit. Statuses: **Todo** / **In progress** / **Done**.

Context: `Song` today is `{ title, artist, bpm, key, duration_secs, notes }`
(`src-tauri/src/models.rs`, `src/types.ts`). Setlist items store Song *copies*
(deliberate: editing the library never rewrites saved setlists). The sheet is
hard-capped to a single A4 page with auto-fit shrink (`--sheet-fit`, min 50%),
implemented in `main.ts` (`fitSheetToPage`) and `print.css`.

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
- UI wording: label BPM as **"Tempo (BPM)"** to match band vocabulary.

## Feature 5: Multi-page A4 mode — Todo

Problem: single-page auto-shrink bottoms out at 50% (~6pt body) — still
overfull means clipped, illegible output. Multi-page is the legibility escape
hatch.

### Mechanism (previously under-specified — this is the reference)

- Data: `Setlist.page_mode: PageMode` with a field-level `#[serde(default)]`;
  `enum PageMode { #[default] Single, Multiple }` serializes as `"Single"` /
  `"Multiple"`. TS mirror: `page_mode: "Single" | "Multiple"`.
- **Single** (default): current behavior untouched — `--sheet-fit` shrink to
  50%, `max-height: 271mm`, `overflow: hidden` in `print.css`.
- **Multiple**: `--sheet-fit: 1`, the fit loop is skipped, and print CSS gets
  an escape hatch via a class kept in sync by the JS:
  `#setlist-sheet.multipage { max-height: none !important; overflow: visible
  !important; zoom: 1 !important; }` — the base `!important` rules stay in
  place for single mode. Repeating `thead`/`tfoot` and `break-inside: avoid`
  (already implemented) handle pagination.
- Screen preview: no stacked-frame mockup — show the sheet at 100% zoom in the
  scroll area with dashed separators every 271 mm of content height and an
  "≈ N pages" label (N = ceil(contentHeight / 271 mm)). The engine paginates
  slightly differently, so N is approximate by design.
- Legibility guard: when single-page auto-fit drops below ~70%, the preview
  meta suggests switching (`A4 · single page · auto-fit 62% — try multiple
  pages`).
- Both `window.print()` and the PDF export (Feature 6) respect the mode. Page
  `N / M` numbering ships only in the PDF export path (no engine we target
  renders `counter(page)` in `@page` margin boxes).
- QA: 25 songs + 2 breaks in multi mode on real A4 (WebKitGTK first): rows
  never split, header/footer repeat on every page, printed page count within
  ±1 of ≈N.

## Feature 6: PDF/PNG export + direct print — Todo (blocked by the Phase 5a spike)

- **Spike first**: `docs/plans/development-plan.md` § Phase 5a. If
  `foreignObject` rasterization fails in WebKitGTK, the fallback decision is
  PNG-only export plus the OS "print to PDF" dialog for documents; vector PDF
  via `typst` post-MVP.
- **Export PDF** (`html-to-image` + `jspdf`, `format: 'a4', unit: 'mm'`):
  - Single-page mode: one page at the fitted zoom (target ≥2480 px wide ≈
    300 dpi), reusing `--sheet-fit` so the file matches the preview.
  - Multi-page mode: rasterize the full sheet once, slice at 271 mm content
    height, stamp `page N / M` on each slice. Documented limitation: raster
    slices cannot repeat the table header per page — the native print engine
    does that; if repeated headers matter for a PDF, use "Save as PDF" in the
    OS print dialog. Accepted for MVP.
  - All export text is bitmap; `window.print()` remains the text-sharp path.
- **PNG export**: same raster path, single file.
- **Direct print**: keep one-click `window.print()` of the sheet (Ctrl/⌘+P
  button) — no export step needed for paper.
- **Export-then-print flow**: after a PDF export, offer "Open PDF" (via
  `tauri-plugin-opener` in the system viewer, where the OS print dialog lives).
  Documented constraint: Tauri has no silent-print API — every paper path ends
  in an OS print dialog; there is no bypass.
- Buttons: `Print` (immediate system dialog) + `Export PDF` (file, with an
  "open after export" checkbox). No combined magic button until export is
  proven.
- Deps: `html-to-image`, `jspdf`, added during the spike. No CSP change
  expected (`img-src blob: data:` already allowed); verify during the spike.

## Roadmap backlog (prioritized)

- **P0 — PNG/PDF export + print**: Phase 5a spike, then Features 5 + 6.
- **P0 — Overflow tooling for the single-A4 cap**: covered by Feature 5
  (multi-page mode + sub-70% legibility nudge). Remaining slice: a
  split-setlist helper (duplicate setlist, move second half) as an alternative
  to multi-page.
- **P1 — Backup/restore**: export/import the full library + setlists as one
  JSON file with a versioned envelope (`{ schema_version, songs, setlists }`)
  so restore can migrate forward; logos are re-imported manually in v1 (or
  base64-embedded in a later envelope version).
- **P1 — CI**: GitHub Actions on ubuntu-latest running `npm run build` +
  `cargo test` with the `webkit2gtk-4.1` packages the README already lists.
  Cheap regression gate until signing/release automation (P3).
- **P1 — Library polish**: duplicate-song, sort by artist/key/tuning, tuning
  filter.
- **P2 — Mobile**: `android`/`ios init` on a provisioned machine, share-sheet
  export (verify a community share plugin first — not an official Tauri v2
  plugin).
- **P2 — Logo downscale** on import: safely post-export — export rasterizes at
  the printed mm size, not the source pixel size; downscale still trims file
  size and memory.
- **P3 — Scale-out**: SQLite migration past ~1000 songs; CI-based signing,
  release automation, auto-update.
