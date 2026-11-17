# StageSheet

[![CI](https://github.com/Nawato/stagesheet/actions/workflows/ci.yml/badge.svg)](https://github.com/Nawato/stagesheet/actions/workflows/ci.yml)

StageSheet is a small, offline-first setlist manager for bands and live performers. It
builds clean, stage-legible setlists and previews them on A4 paper in plain black on
white.

Built with **Tauri v2**, **Rust**, **TypeScript**, and **Vite** (vanilla TS, no UI
framework).

## Print guarantee

StageSheet prints clean, stage-legible setlists: plain black text on white
paper, always A4 portrait, with durations computed by the Rust backend. The
full non-negotiable contract (print output, storage scope, IPC shape) lives
in `SKILL.md`; agent notes live in `AGENTS.md`.

## Project layout

```text
src/
  main.ts            app shell, editor, song library, logo controls
  sheet.ts           renders #setlist-sheet (table markup, per-combination widths)
  pages.ts           paginates the sheet into A4 frames for multiple-page mode
  types.ts           TypeScript mirror of the Rust IPC/JSON models
  api.ts             typed wrappers around the Tauri commands
  backup.ts          versioned one-file library/setlist backup + restore
  logo.ts            reads stored logos from the app-data directory
  exporter.ts        PDF/PNG raster export + save/open flow
  format.ts          duration/date helpers
  dom.ts             tiny element helper
  styles/app.css     UI chrome + on-screen A4 sheet and page frames
  styles/print.css   @page A4 + black-on-white print rules
src-tauri/
  src/lib.rs         shared entry point for desktop and mobile
  src/main.rs        desktop binary; calls stagesheet_lib::run()
  src/models.rs      Song, SetlistItem, SheetOptions, PageMode, LogoConfig, Setlist (+ tests)
  src/storage.rs     JSON persistence in <app_data_dir>/stagesheet (+ tests)
  src/commands.rs    async #[tauri::command] handlers
  src/error.rs       thiserror AppError (serialized to the frontend)
  capabilities/default.json
  tauri.conf.json
docs/plans/          development plan (phases, QA, risks) + feature specs
SKILL.md             schema and convention notes for coding agents
```

## Development

Prerequisites: Rust 1.85+, Node 20+, and the Tauri v2 system dependencies for your
platform (on Linux: `webkit2gtk-4.1`, `gtk3`, `libsoup3`, and their development
headers).

```bash
npm install
npm run tauri dev      # desktop app with Vite HMR
npm run build          # type-check + production frontend bundle
npm run tauri build    # desktop bundles
```

The app icons are generated from `app-icon.png` (including the Android/iOS icon sets):

```bash
npx tauri icon app-icon.png
```

Run the Rust tests with:

```bash
cd src-tauri && cargo test
# or from the repo root:
npm run test:rust
```

CI (`.github/workflows/ci.yml`) runs `npm ci`, `npm run build`, and
`npm run test:rust` on `ubuntu-latest` for every push to `main` and every pull
request. It installs the Linux Tauri packages above; it does not build bundles,
initialise mobile projects, or sign anything.

Releases (`.github/workflows/release.yml`) run on every `v*` tag push: Windows,
Linux, and macOS (ARM) bundles are built with `tauri-action@v0` and
auto-published as a GitHub Release. Keep `package.json`,
`src-tauri/tauri.conf.json`, and `src-tauri/Cargo.toml` versions in sync, then
`git tag vX.Y.Z && git push origin vX.Y.Z`. Builds are unsigned.

### Mobile targets

The backend is already mobile-ready: the shared `lib.rs` + `mobile_entry_point` split is
in place, and the default capability applies to the main webview. Generate the platform
projects on a machine with the matching toolchain:

```bash
# Android: requires JDK 17+, Android SDK, and NDK
npx tauri android init

# iOS: requires macOS and Xcode
npx tauri ios init
```

These commands were not run in the initial scaffold environment (no JDK/Android SDK,
and iOS initialization is macOS-only), so `src-tauri/gen/android` and
`src-tauri/gen/ios` do not exist yet.

## Storage

Everything is local JSON under the platform app-data directory:

```text
<app_data_dir>/stagesheet/
├── songs.json            # Vec<Song>
├── setlists/<uuid>.json  # one Setlist per file
└── logos/<uuid>.<ext>    # imported PNG/JPEG/SVG files
```

`Storage::for_app` resolves `<app_data_dir>/stagesheet`; the frontend capability is
scoped to `$APPDATA/stagesheet/**`, so no other paths are reachable from the webview.
Writes use a temp file plus rename, and mutations are serialized with a tokio mutex.

Logos are validated by content (PNG/JPEG magic bytes, SVG root tag), capped at 5 MiB,
and stored under a generated UUID name. Absolute paths are never persisted. Raster
logos whose longest edge exceeds 1024 px are decoded and downscaled on import with
the aspect ratio preserved (PNG stays PNG, JPEG stays JPEG at quality 85); SVGs are
stored byte-for-byte and stay vector.

## Song library

The library pane keeps reusable songs and offers instant search across title,
artist, key, and tuning. A view-only sort control orders the list by title
(default), artist, key, or tuning; missing values sort last and ties fall back to
title. The **Has tuning** checkbox narrows the list to songs with a tuning set and
combines with the search query. Each row adds the song to the running order,
duplicates it into the library under a new id with a `(copy)` suffix, or removes
it after a confirmation. Sorting and filtering never mark a setlist dirty or
change the stored data.

## Backup and restore

The library pane has **Back up** and **Restore** actions. Both operate on one
human-readable JSON file:

```json
{
  "schema_version": 1,
  "exported_at": "2026-11-17T18:30:00.000Z",
  "songs": [ /* Song[] */ ],
  "setlists": [ /* Setlist[] */ ]
}
```

The envelope includes every current field (tuning, sheet options, page mode,
labels, comments, and logo width/alignment). Restore is frontend-only: it reads
the file through the dialog-scoped `fs` permission, validates the envelope, and
re-saves each record through `save_song` / `save_setlist`, so Rust validation
and serde defaults remain the authority. Older schema versions are migrated
before saving; a `schema_version` newer than the build supports is rejected with
a clear "update StageSheet" message instead of being partially imported.

Restore overwrites existing songs and setlists with the same IDs and does not
delete anything else. Malformed records are skipped and reported with counts.
**Logo images are not embedded in v1**: a setlist keeps its `logo.file_name`, so
restoring on the same device keeps working, but on a new device the image is
missing and must be re-imported manually for each setlist. A later envelope
version can embed the bytes.

No new Tauri commands or capabilities were added: writing and reading use
`dialog.save` / `dialog.open` plus the existing scoped `fs` plugin, with the
selected file added to the scope for that one operation.

## Exporting

The preview toolbar writes the current setlist to PDF or PNG at 300 dpi A4,
using the current page layout and sheet options. Export opens a system save
dialog (defaults to Downloads) and optionally opens the saved file in the system
viewer. PDFs repeat the captured header/footer on every page and stamp
`Page N / M`; the PNG is a single full-sheet image. Exported text is bitmap by
design — the `Print` button remains the direct, text-sharp paper path. Temporary
files are never kept: the exporter captures the sheet, restores the preview,
then writes the chosen file.

## Tauri commands

All command handlers are async and return `Result<T, AppError>`:

- `list_songs`, `save_song`, `delete_song`
- `list_setlists`, `get_setlist`, `save_setlist`, `delete_setlist`
- `reorder_items(setlist_id, from, to)`, `setlist_duration(setlist_id)`
- `import_logo(bytes, file_name)`, `remove_logo(file_name)`

Argument names are camelCase on the JavaScript side (Tauri's default). Struct fields
remain snake_case because they are the serialized contract.

## Status: implemented vs. missing

Tracked against the in-repo plans: `docs/plans/development-plan.md` (phases,
QA strategy, risks) and `docs/plans/upcoming-features.md` (feature specs and
backlog). Keep them — and this list — in sync in the same commit as each
change.

### Currently implemented

- Tauri v2 desktop app with the `lib.rs` / `main.rs` split needed for mobile targets.
- Corrected data models including key, free-text tuning, logo alignment enum,
  `NaiveDate`, and created/updated timestamps, with migration-friendly serde
  defaults and aliases.
- JSON storage + capability scoping + the full command list above.
- Song library with instant search (title, artist, key, tuning), view-only sort by
  title/artist/key/tuning, a "Has tuning" filter, one-click add, per-row duplicate
  under a new id, and delete with confirmation. Free-text tuning (max 24 chars) is
  part of search, the add form, and each song's editor details.
- Setlist editor: title/venue/date, break insertion (custom label, length in
  minutes, comment), up/down + drag reorder, inline BPM/key/tuning editing,
  Comment fields for songs and breaks (max 140 chars) that render on the sheet,
  and logo upload with width/alignment controls. Oversized raster logos are
  downscaled on import; SVG logos stay vector.
- Per-setlist "Sheet columns" toggles for Key, Tuning, Tempo (BPM), Time, and
  Comment, persisted with the setlist and applied to preview, print, and
  export. Column widths are per-combination presets summing to 100% with the
  `<colgroup>` as the only width source, so the header stays aligned with the
  body in every toggle combination. Title/venue/date and song titles always
  print; the Time column can be hidden, while break durations always render.
- Validation hardening on save: break length `0..=600`, break label ≤ 24 chars,
  and song/break comments ≤ 140 chars (after trim). Old files still load; their
  next save reports the violation instead of truncating.
- A4 black-on-white preview with `@page` and `break-inside: avoid` for rows.
  In multiple-page mode every printed page carries its own cloned header and
  footer (paginated frames), so repetition no longer depends on the engine's
  `thead`/`tfoot` support; single-page native print still relies on the
  engine groups (WebKitGTK does not repeat them — WebKit bug 17205).
  The `Tuning` column appears only when its toggle is on and at least one song in
  the setlist has tuning set.
- Single-A4 cap with automatic type shrink: the sheet is locked to one page,
  the table zooms down inside it (minimum 50%) to fit, and the preview label
  mirrors the applied fit.
- Per-setlist Page layout toggle (Single/Multiple). Multiple mode replaces the
  tall sheet in the preview and in print with measured A4 page frames: rows are
  grouped by painted height so none straddles a boundary, and every frame carries
  its own cloned brand header (logo, title, venue/date, column labels) and footer.
  The label reports the actual frame count, matching the exported PDF's pages.
  Single mode keeps the one-page fit and points at Multiple when the required fit
  drops below ~70%. Persisted as `page_mode`, with old files defaulting to Single.
  The fit loop measures the table relative to the preview scale, so the applied
  zoom and overfull warning do not change with the window width.
- PDF and PNG export at 300 dpi A4 (2480 px wide) through `html-to-image` + `jsPDF`. Export
  temporarily lifts the sheet to its natural height, uses an export-only data-URL
  logo, works around WebKitGTK's collapsed `<col>` widths, and restores the
  preview. PDFs composite the captured header/footer on every page with
  `Page N / M` stamped (per-page content ~221 mm after header/footer; raw
  271 mm slices only as fallback), snap to row tops, and PNGs are a single
  full-sheet file (padded to A4 2480 × 3508 when short). A sheet long enough to
  exceed WebKit's canvas-height limit is downscaled proportionally (whole sheet,
  lower effective dpi) instead of clipped. The preview toolbar also has an
  "Open after export" option that opens the saved file in the system viewer
  through `tauri-plugin-opener`. Exported text is bitmap by design.
- Printing through the native webview print dialog (Ctrl/Cmd + P); the print
  output follows the selected page layout and remains the text-sharp paper path.
- GitHub Actions regression gate (`.github/workflows/ci.yml`): Node 20 frontend
  build plus `cargo test` on `ubuntu-latest` with the webkit2gtk-4.1 packages,
  cached npm/Cargo downloads. No secrets, bundles, signing, or mobile builds.
- One-file backup/restore of the whole song library and every setlist as a
  versioned JSON envelope (`schema_version: 1`), written and read through the
  dialog-scoped fs permission with no new commands or capability widening.
  Restore validates records, re-saves them through the normal commands, and
  reports imported/rejected counts; future schema versions are rejected until
  the app supports them, older ones can migrate forward. Logos are not embedded
  in v1 and are re-imported manually.

### Still missing (per plan)

- Planned library/setlist tooling (Features 12–15, Todo): in-place library
  song editing, setlist duplication as a preset base, an in-memory artist
  filter, and a toggleable per-setlist artist lock.
- Paginated split-setlist helper (duplicate setlist, move second half) as an
  alternative to multi-page mode.
- Physical-paper QA on A4 (page count, header/footer per engine, legibility),
  plus cross-engine (WebView2/WKWebView) export checks. Single-page native
  print relies on engine `thead`/`tfoot` repetition (WebKit bug 17205);
  multi-page mode and the PDF exporter carry their own headers instead.
- Selectable/vector PDF text (post-MVP via `typst`).
- Android/iOS project initialization (`tauri android init` / `tauri ios init`) and
  native mobile share.
- Signing (P3), including notarization; unsigned tag-push release automation for
  Windows/Linux/macOS (ARM) already exists via `.github/workflows/release.yml`.

## License

MIT — see [LICENSE](LICENSE).
