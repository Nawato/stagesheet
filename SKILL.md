# StageSheet — agent contract

This file pins the data contract and non-negotiable design rules. Read it before
editing models, storage, IPC, or the printable sheet.

## Hard rules

1. **Print output is black on white on A4.** `@page { size: A4 portrait; margin: 13mm 12mm; }`.
   Never add a dark-stage theme, gradient, or colour-dependent styling to
   `#setlist-sheet` or anything inside it.
2. `#setlist-sheet` is the only printed node. UI chrome may be themed; the sheet
   may not.
3. Duration is computed in Rust, never only in the UI:
   `sum(song.duration_secs or 0) + sum(break.duration_mins * 60)`.
4. All storage lives under `<app_data_dir>/stagesheet/`; the frontend `fs` capability
   is scoped to `$APPDATA/stagesheet/**`. Do not widen it.
5. Every Tauri command is `async` and returns `Result<T, AppError>`.
6. Logos are rendered only via `<img src>` (blob/data URLs). Never inline SVG
   markup into the DOM: stored SVGs may contain scripts, and `<img>` is the
   one context where they cannot execute.

## Data contract (`src-tauri/src/models.rs` and `src/types.ts`)

```rust
pub enum LogoAlignment { Left, Center, Right } // Center is the default

pub struct LogoConfig {
    pub file_name: Option<String>, // plain name inside <app_data>/stagesheet/logos/
    pub width_mm: f32,             // 10.0..=80.0
    pub alignment: LogoAlignment,
}

pub struct Song {
    pub id: uuid::Uuid,
    pub title: String,
    pub artist: Option<String>,
    pub bpm: Option<u16>,
    pub key: Option<String>,       // e.g. "Em"
    pub tuning: Option<String>,    // e.g. "Drop D"; trimmed, ≤ 24 chars
    pub duration_secs: Option<u32>,
    pub notes: Option<String>,     // "Comment" in the UI; ≤ 140 chars
}

pub struct SheetOptions {
    pub show_key: bool,       // every field defaults to true
    pub show_tuning: bool,
    pub show_tempo: bool,     // Tempo (BPM) column
    pub show_duration: bool,  // Time column
    pub show_comment: bool,   // song/break comments + break label
}

pub enum SetlistItem {
    Song(Song),
    Break {
        duration_mins: u32,         // 0..=600, checked in Setlist::validate
        note: Option<String>,       // "Comment" in the UI; trimmed, ≤ 140 chars
        label: Option<String>,      // e.g. "Intermission"; trimmed, ≤ 24 chars
    },
}

pub enum PageMode { Single, Multiple } // Single is the default

pub struct Setlist {
    pub id: uuid::Uuid,
    pub title: String,
    pub venue: Option<String>,
    pub date: Option<chrono::NaiveDate>, // "YYYY-MM-DD"
    pub items: Vec<SetlistItem>,
    pub logo: LogoConfig,            // serde alias: logo_config
    pub sheet_options: SheetOptions, // missing in old files -> all true
    pub page_mode: PageMode,         // missing in old files -> Single
    pub created_at: chrono::DateTime<chrono::Utc>,
    pub updated_at: chrono::DateTime<chrono::Utc>,
}
```

Serde notes:

- `SetlistItem` uses serde's default externally tagged form:
  `{"Song": {...}}` and
  `{"Break": {"duration_mins": 10, "note": null, "label": null}}`.
  A missing `note`/`label` deserializes to `None` (old files stay valid).
- `LogoAlignment` deserializes case-insensitively (`"left"`, `"Left"`, `"CENTER"`).
- `Song.key` and all optional fields default when missing.
- `Setlist.sheet_options` carries a field-level `#[serde(default)]`; the
  `SheetOptions` struct carries a **container-level** `#[serde(default)]` and a
  manual `Default` with every field `true`. So a missing field, a partial
  object, and a pre-feature file all render every optional block. Never add
  field-level bool defaults inside `SheetOptions`: an absent bool would silently
  mean `false`.
- `Setlist.page_mode` carries a field-level `#[serde(default)]`. `PageMode`
  serializes by variant name (`"Single"` / `"Multiple"`), and `Single` is the
  `Default`, so pre-Feature-5 files keep the single-A4 cap they were saved with.
  Unknown or differently-cased values are rejected, not coerced.
- `Song.tuning` and `Break.label` are trimmed in both directions;
  whitespace-only values serialize as `null` and deserialize as `None`, so
  pre-feature files stay equal to new ones. Comments (`Song.notes`,
  `Break.note`) are labeled "Comment" in the UI, trimmed there and counted after
  trim, but not rewritten by serde; both are bounded at 140 chars on save.
- Validation runs **on save only** (`Setlist::validate`), never during
  deserialization: old files with over-long values still load, and their next
  save fails with a clear message. No silent truncation.
  - `Song::validate()`: title non-empty; `tuning` ≤ 24 chars; `notes` (the song
    "Comment") ≤ 140 chars.
  - `Setlist::validate()`: title non-empty; logo width 10..=80 mm and plain file
    name; every item via `SetlistItem::validate()`.
  - `SetlistItem::validate()`: songs delegate to `Song::validate()`; breaks
    require `duration_mins` in `0..=600`, `label` ≤ 24 chars, and `note`
    (the break "Comment") ≤ 140 chars. Lengths are counted after trimming.
- `Setlist.logo` accepts the legacy key `logo_config`; missing timestamps default to
  `Utc::now`.
- TS mirror: `SheetOptions`, `DEFAULT_SHEET_OPTIONS`, and
  `withSheetDefaults()` live in `types.ts`. Run setlists through the helper when
  loading/cloning so a field left off by an older writer still means "visible".
  `PageMode`, `DEFAULT_PAGE_MODE`, and `withPageModeDefaults()` live there too;
  they normalize a missing `page_mode` to `"Single"`.
- Unknown legacy fields are ignored, so the first-draft schema still loads.

## Storage

```text
<app_data_dir>/stagesheet/
├── songs.json            # Vec<Song>
├── setlists/<uuid>.json  # Setlist
└── logos/<uuid>.<ext>    # PNG / JPEG / SVG, max 5 MiB
```

- Writes: temp file + rename, serialized by a tokio mutex.
- Logo file names are plain names (no separators, `..`, drive letters, or `:`).
- Content sniffing decides the stored extension; never trust the client MIME type.
- `import_logo` decodes PNG/JPEG (invalid bodies are rejected), and when the
  longest edge exceeds `MAX_LOGO_DIMENSION` (1024 px) it downscales with aspect
  ratio preserved. Small rasters are stored untouched; JPEG re-encodes at
  quality 85; SVG is stored byte-for-byte and remains vector. The 5 MiB cap is
  checked before and after processing.
- Capability: `$APPDATA/stagesheet/**` for the frontend `fs` plugin (the dialog
  save/open integration extends it to the one selected file);
  `opener:allow-open-path` is scoped to `$HOME/**`, `$TEMP/**`, and the app-data
  folder; no shell or network permissions.

## IPC surface

`list_songs`, `save_song`, `delete_song`, `list_setlists`, `get_setlist`,
`save_setlist`, `delete_setlist`, `reorder_items`, `setlist_duration`,
`import_logo`, `remove_logo`.

JS argument keys are camelCase (`setlistId`, `fileName`); model fields are snake_case.

## Sheet markup and CSS

- `<div id="setlist-sheet">` contains a `<table class="sheet-table">`.
- Columns are built from `Setlist.sheet_options`: `#` and `Song` always exist;
  `Key`, `Tuning`, `BPM`, and `Time` each render only while their toggle is on.
  `Tuning` additionally requires at least one song in the setlist to have tuning
  set. The editor labels the tempo toggle **"Tempo (BPM)"**; the sheet keeps the
  compact `BPM` heading.
- The table carries a width preset named for its visible column combination,
  never the count: `.cols-2` (index/song, 8/92);
  `.cols-3-key|tuning|bpm` (7/83/10) and `.cols-3-time` (7/75/18);
  `.cols-4-key-tuning|key-bpm|tuning-bpm` (7/73/10/10),
  `.cols-4-key-time|tuning-time|bpm-time` (7/65/10/18);
  `.cols-5` (any three info columns incl. Time, 7/55/10/10/18);
  `.cols-5-no-time` (key+tuning+bpm, 7/63/10/10/10); and `.cols-5-tuning`
  (all four info columns, 6/50/9/10/9/16). Every preset sums to 100%. The
  `<colgroup>` is the only width source — never add `th` width rules — and the
  numeric header/body cells share right alignment and 1.5 mm horizontal padding.
- `<thead>` carries the logo/title/venue/date header and column labels; `<tfoot>`
  carries the footer. Both are marked as table header/footer groups
  (`display: table-header-group` / `table-footer-group`). Chromium-based engines
  are expected to repeat them on every printed page; WebKitGTK's print path
  currently does not
  repeat them (WebKit bug 17205 — see the engine note under Feature 5 in
  `docs/plans/upcoming-features.md`).
- Rows use `.song-row` / `.break-row` and must keep `break-inside: avoid`.
- Song artist always renders under the title; a song comment renders there only
  when `show_comment` is on, and a blank comment emits no element. Break rows
  render `[label] · [duration] · [comment]` inside one full-width dashed cell:
  the duration is always shown, while the label (default `Break`, bold/uppercase)
  and the comment are gated by `show_comment`. There is no separate label
  toggle. Keep the text lookups in helpers (`songCommentText`, `breakLabelText`,
  `breakCommentText` in `sheet.ts`).
- Typography targets: title 22–26pt bold, meta 11–12pt, song rows 12–14pt, tabular
  figures for numbers/BPM/key.
- `Setlist.page_mode` drives one class: JS toggles `#setlist-sheet.multipage`
  from the setlist, and both stylesheets key off it. `Single` (default) keeps
  the `--sheet-fit` auto-fit cap: the zoom is applied to `.sheet-table` inside
  the fixed A4 sheet box, measured from the painted table height and clamped to
  50–100%, so the preview label matches the applied zoom. Zooming the sheet box
  itself cannot un-clip content (the clip boundary scales with it) — keep the
  zoom on the table. `Multiple` skips the fit, sets `--sheet-fit: 1`, and lifts
  the page cap with `height: auto; max-height: none; overflow: visible` in both
  stylesheets. Never toggle per-mode layout inline; the class is the contract.
- Screen preview is a real A4 box scaled with `--sheet-scale`; print resets the
  transform and padding (`@page` owns the margins). In multiple mode the sheet
  grows to its natural height and the preview draws dashed page boundaries in
  `#sheet-page-marks` (a sibling of `#setlist-sheet`, so it never prints or
  exports) plus an approximate `≈ N pages` label.
- The single-page fit hint warns below ~70% auto-fit and points at multiple
  pages. It mirrors the applied table zoom measured from the painted table
  height relative to `--sheet-scale` (the preview transform must be divided out,
  or the required fit changes with the window width and the overfull warning
  never fires). The natural content height feeds only the multiple-page N
  estimate.
- `#setlist-sheet` must stay `background: #fff; color: #000` on screen and print.
- Logos are forced to grayscale in print, regardless of the preview toggle.

## Export (PDF / PNG)

- Export lives in `src/exporter.ts` and is a **300 dpi raster** of the full
  natural-height sheet (lower effective dpi only when a sheet exceeds WebKit's
  canvas height limit), never the preview's fitted box. Prep temporarily applies
  the `.multipage` layout, removes the preview transform, swaps in an
  export-only data-URL logo, removes `<colgroup>`, inserts a hidden zero-height
  first row carrying the measured column widths (WebKitGTK reports cloned
  `<col>` widths as `0px`), and restores the DOM afterwards. Never reuse
  `--sheet-fit` for export.
- Blob URLs must not reach the raster: the production `connect-src` blocks their
  fetch and WebKitGTK was unreliable even when allowed. `storedLogoDataUrl()` in
  `logo.ts` base64-encodes the same scoped `readFile` bytes; the live preview
  keeps blob URLs. Never widen the CSP or the fs capability for export.
- Warm up the raster pipeline once per session with a throwaway `toCanvas`; the
  first WebKitGTK capture can drop the logo even when the live `<img>` is
  complete. Export always forces the logo to grayscale, regardless of the
  preview toggle, and stays strictly black on white.
- PDF: `jsPDF({ unit: "mm", format: "a4", orientation: "portrait", compress:
  true })`, header + slice + footer images per page plus a vector page number. Slices cut at A4 height minus the captured
  header/footer and snap to row tops. The header (brand + column labels) and
  footer are composited on every page because raw slices repeat neither and
  WebKitGTK's native print path does not repeat `thead`/`tfoot` (WebKit bug
  17205). `Page N / M` is stamped in the bottom margin.
- PNG: the same raster as one file; a short sheet is padded to A4
  (2480 × 3508 px, 300 dpi), a long sheet stays tall. Sheets whose natural
  height would exceed WebKit's canvas limit are downscaled proportionally
  (whole sheet, lower effective dpi) rather than clipped.
- Export renders the current editor state through the same `sheet.ts` path, so
  `page_mode` and `sheet_options` apply. Page `N / M` appears only in PDFs. All
  exported sheet text is bitmap; `window.print()` remains the text-sharp path.
- Saving uses `dialog.save()` + `fs.writeFile` (the dialog extends the fs scope
  to the selected file) and optionally `opener.openPath()` for the "Open after
  export" checkbox. There is no silent-print API; direct print stays one-click
  `window.print()`.

## Backup / restore

- `src/backup.ts` writes and reads one versioned JSON envelope:

  ```json
  {
    "schema_version": 1,
    "exported_at": "2026-11-17T18:30:00.000Z",
    "songs": [ /* Song */ ],
    "setlists": [ /* Setlist */ ]
  }
  ```

- Frontend-only by design: export builds the envelope from `list_songs` /
  `list_setlists`, restore re-saves each record through `save_song` /
  `save_setlist`. Rust validation, trim rules, and serde defaults stay the single
  authority; never add a bulk import command or write storage files directly
  from the frontend.
- File access uses `dialog.save` / `dialog.open` plus the existing scoped `fs`
  plugin. The selected path is added to the fs scope for that operation only.
  Do not widen `$APPDATA/stagesheet/**`, add fs commands, or change the CSP for
  backup/restore.
- Version rules: `schema_version` is mandatory and must be a positive integer.
  A version newer than `BACKUP_SCHEMA_VERSION` is rejected with an "update
  StageSheet" message; older versions go through `migrateEnvelope()` before the
  per-record normalizers. Bump `BACKUP_SCHEMA_VERSION` whenever the serialized
  `Song` / `Setlist` shape changes in a way that needs migration.
- Restore semantics: upsert by `id`; records with the same IDs are overwritten,
  nothing else is deleted. Structurally malformed records are skipped and
  reported; validation failures from `save_*` are reported per record. The UI
  confirms before writing and reloads both caches afterwards.
- Logos are **not embedded in v1**. `logo.file_name`, width, and alignment stay
  in the envelope, so a same-device restore keeps working; on a new device the
  file is absent, the preview shows the logo placeholder, and the logo must be
  re-imported manually. Embedding bytes is a future envelope version.

## Tests that must stay green

- `cargo test` in `src-tauri`: model round-trips, first-draft JSON migration, reorder
  bounds, duration with breaks, storage CRUD, logo validation/traversal rejection,
  raster downscaling, and untouched small/SVG logos.
  (The `tauri` crate needs the `webkit2gtk-4.1` system libraries from the README to
  compile, even for pure model tests.)
- `npm run build`: TypeScript strict mode + Vite production bundle.
- Export fidelity is desktop-engine QA, not a unit test: a long setlist must
  produce A4 pages with a visible logo, repeated header/footer, row-safe slices,
  and page numbers; check the CSP console and the PDF with `pdfinfo`.
