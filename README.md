# StageSheet

StageSheet is a small, offline-first setlist manager for bands and live performers. It
builds clean, stage-legible setlists and previews them on A4 paper in plain black on
white.

Built with **Tauri v2**, **Rust**, **TypeScript**, and **Vite** (vanilla TS, no UI
framework).

## Hard rules

1. Printed output is **plain black text on white paper**, always A4 portrait
   (`@page { size: A4 }`).
2. `<div id="setlist-sheet">` is the only printable node. It must never receive a
   dark-stage theme, tinted background, or colour-dependent styling.
3. Setlist duration is computed in Rust (`Setlist::total_duration_secs`, exposed via
   `setlist_duration`) from song durations plus breaks.

## Project layout

```text
src/
  main.ts            app shell, editor, song library, logo controls
  sheet.ts           renders #setlist-sheet (table markup, repeats on print)
  types.ts           TypeScript mirror of the Rust IPC/JSON models
  api.ts             typed wrappers around the Tauri commands
  logo.ts            reads stored logos from the app-data directory
  format.ts          duration/date helpers
  styles/app.css     UI chrome + on-screen A4 sheet
  styles/print.css   @page A4 + black-on-white print rules
src-tauri/
  src/lib.rs         shared entry point for desktop and mobile
  src/main.rs        desktop binary; calls stagesheet_lib::run()
  src/models.rs      Song, SetlistItem, LogoConfig, Setlist (+ tests)
  src/storage.rs     JSON persistence in <app_data_dir>/stagesheet (+ tests)
  src/commands.rs    async #[tauri::command] handlers
  src/error.rs       thiserror AppError (serialized to the frontend)
  capabilities/default.json
  tauri.conf.json
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
and stored under a generated UUID name. Absolute paths are never persisted. Image
downscaling is deferred until the export phase.

## Tauri commands

All command handlers are async and return `Result<T, AppError>`:

- `list_songs`, `save_song`, `delete_song`
- `list_setlists`, `get_setlist`, `save_setlist`, `delete_setlist`
- `reorder_items(setlist_id, from, to)`, `setlist_duration(setlist_id)`
- `import_logo(bytes, file_name)`, `remove_logo(file_name)`

Argument names are camelCase on the JavaScript side (Tauri's default). Struct fields
remain snake_case because they are the serialized contract.

## What is implemented in this scaffold

- Tauri v2 desktop app with the `lib.rs` / `main.rs` split needed for mobile targets.
- Corrected data models including key, logo alignment enum, `NaiveDate`, and
  created/updated timestamps, with migration-friendly serde defaults and aliases.
- JSON storage + capability scoping + the full command list above.
- Song library with instant search and one-click add.
- Setlist editor: title/venue/date, break insertion, up/down + drag reorder, inline
  BPM/key/notes editing, logo upload with width/alignment controls.
- A4 black-on-white preview with `@page`, repeated table header/footer on print, and
  `break-inside: avoid` for rows. Printing uses the native webview print dialog
  (Ctrl/Cmd + P).

Deferred to later phases: PDF/PNG export (`html-to-image` + `jspdf`), per-page
`page N / M` numbering (browsers cannot render `counter(page)` in `@page` margin
boxes; this belongs in the PDF exporter), logo downscaling, native mobile share,
and print QA on physical A4.
