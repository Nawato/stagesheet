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
index.html          app shell markup: header, panes, preview toolbar, sheet container
src/
  main.ts            app shell, editor, song library, artist records, setlist pickers, logo controls
  sheet.ts           renders #setlist-sheet (table markup, per-combination widths)
  pages.ts           paginates the sheet into A4 frames for multiple-page mode
  types.ts           TypeScript mirror of the Rust IPC/JSON models
  api.ts             typed wrappers around the Tauri commands
  artists.ts         artist display names, filter buckets/counts, logo resolution
  backup.ts          versioned one-file artist/song/setlist backup + restore
  logo.ts            reads stored logos from the app-data directory
  exporter.ts        PDF/PNG raster export + save/open flow
  format.ts          duration/date helpers
  dom.ts             tiny element helper
  styles/app.css     UI chrome + on-screen A4 sheet and page frames
  styles/print.css   @page A4 + black-on-white print rules
src-tauri/
  src/lib.rs         shared entry point for desktop and mobile
  src/main.rs        desktop binary; calls stagesheet_lib::run()
  src/models.rs      Artist, Song, SetlistItem, SheetOptions, PageMode, LogoConfig, Setlist (+ tests)
  src/storage.rs     JSON persistence in <app_data_dir>/stagesheet (+ tests)
  src/commands.rs    async #[tauri::command] handlers
  src/error.rs       thiserror AppError (serialized to the frontend)
  capabilities/default.json
  tauri.conf.json
docs/
  plans/             development plan (phases, QA, risks) + feature specs
  status.md          implemented-vs-missing feature status; synced per commit
.github/workflows/   ci.yml (build + Rust tests) and release.yml (v* tag bundles)
SKILL.md             schema and convention notes for coding agents
AGENTS.md            agent entry point: hard rules, gates, and commit conventions
LICENSE              MIT
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
├── artists.json          # Vec<Artist>
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
stored byte-for-byte and stay vector. Setlists and artists share this logo pool.
Removing a logo skips files still referenced by a setlist or artist record. A
setlist shows its own logo when set, otherwise its artist's logo, otherwise the
placeholder; preview, print, and export all use that same file chain, while
width and alignment always come from the setlist's own config.

## Song library

The library pane keeps reusable songs and offers instant search across title,
artist, key, and tuning. Search matches the resolved artist name, so songs
assigned to an artist record and older free-text songs filter identically. A
view-only sort control orders the list by title (default), resolved artist name,
key, or tuning; missing values sort last and ties fall back to title. The list
shows only the active artist's songs — id-backed songs plus legacy text
grouping under a same-named record until adopted — and combines with search,
sort, and tuning. **Has tuning** narrows the list to songs with a
tuning set. Each row adds the song to the running order, duplicates it into the
library under a new id with a `(copy)` suffix, or removes it after a
confirmation. **Edit** opens an inline editor in the row with the same fields
and validation as the add form; saving keeps the song's id and re-applies the
current search, sort, and tuning filters. Saved setlists keep their own copies
by default: after a save with matching in-scope copies, one safe-default dialog
offers to update them, so a gig-specific divergence (key, capo, shortened
notes) is only overwritten when you explicitly choose Update. After an explicit
setlist Save, the same safe-default request appears for each changed song,
offering to bring the library copy up to date. Sorting and
filtering never mark a setlist dirty or change
the stored data, and the library badge counts the active scope — totals live
on the landing page.

### Artists

The landing screen lists each artist with a logo thumbnail and resolved song
counts. Creating an artist takes a name and a logo image; each row's Edit action
reuses that form for name and logo changes, and Delete confirms first. Renaming
never rewrites songs or setlists: they reference the record by id, and the
record name wins in the library display, search, and sort. In the Unfiled scope,
song add/edit forms
offer **No artist** plus every record so songs can be filed on save, and
legacy free-text songs get a "Keep text" option until they are adopted; in an
artist scope the artist is automatic on add and read-only in the row editor. Deleting an artist clears referencing `artist_id` values best-effort,
keeps each song's last name snapshot, and leaves its logo file alone while a
setlist or another artist still uses it. Entering or cancelling edit mode
updates the row's editing state immediately; a pending logo import holds the
artist Save until it finishes; and Delete is refused while a library song
edit/save is in flight and locks library row actions while references are
cleared.

### Artist scope and the library

StageSheet is artist-first: a landing page gates startup — create the first
artist (name plus logo upload/remove and preview), or pick one from the selection
list with song/setlist counts, plus an **Unfiled** entry when records have no
artist. It reopens later via **Choose artist…** in the header picker.

The header's first dropdown is the scope switcher: artist entries plus
`Unfiled (N)` plus **Choose artist…**. The library, the setlist list, and the
song-count badge follow the active scope; search, sort, and **Has tuning**
still combine on top. **New** starts a setlist pre-assigned to the active
artist and is disabled in the Unfiled scope. Each unfiled setlist gets a
**File under…** select that files it through the normal save path; the song
Add form and the row editor offer an artist dropdown only in the Unfiled
scope, and saving an unfiled song or setlist fails with a
`“…has no artist — assign it before saving.”` message until it is filed.
Adding a song outside the scope — possible only through a stale cache — is
refused with
`“<title>” is not by <A> — switch artist scope to add it.` Breaks are
always allowed, scope changes never remove or rewrite existing items, and the
running order summary keeps only a count of non-matching songs when any.
The only rewrite path is the opt-in per-edit song offer above.
The scope selection is session-only: never saved, never backed up.

## Backup and restore

The library pane has **Back up** and **Restore** actions. Both operate on one
human-readable JSON file:

```json
{
  "schema_version": 1,
  "exported_at": "2026-11-17T18:30:00.000Z",
  "artists": [ /* Artist[] */ ],
  "songs": [ /* Song[] */ ],
  "setlists": [ /* Setlist[] */ ]
}
```

The envelope includes every current field (song and setlist artist references,
tuning, sheet options, page mode, labels, comments, setlist logo geometry, and
artist logo file names). Break lengths
are written as `duration_secs`; schema-1 backups from older builds may still
carry `duration_mins` and are converted × 60 on restore. Restore is
frontend-only: it reads the file through the dialog-scoped `fs` permission,
validates the envelope, and re-saves each record through `save_artist` /
`save_song` / `save_setlist`, so Rust validation and serde defaults remain the
authority. Artists are restored first, then songs, then setlists, so
assignments resolve immediately; an absent `artists` array in an older backup
restores as an empty list, and `artist_id` values are preserved even when the
record does not exist yet. Older schema versions are migrated before saving; a
`schema_version` newer than the build supports is rejected with a clear "update
StageSheet" message instead of being partially imported.

Restore overwrites existing artists, songs, and setlists with the same IDs and
does not delete anything else. Malformed records are skipped and reported with
counts. Back up and Restore require open library drafts and non-pristine artist
forms (edit mode, a typed name, or a staged logo) to be saved
or cancelled first. Both refuse while any library/artist write or artist logo
import is in flight, and Restore re-checks the guard after reading the file.
Back up locks library row actions, the Add submit, artist rows, and the artist
form while it reads the snapshot; Restore does the same during its write phase
and re-enables them when the restore finishes (after adopting on success or
after the failure path). The setlist editor and header actions are not locked,
and a setlist draft edited during a restore can be replaced by the restored
state.

**Logo images are not embedded in v1**: setlists and artists keep their
`logo.file_name`, so restoring on the same device keeps working, but on a new
device the image is missing and must be re-imported manually. A later envelope
version can embed the bytes.

Backup/restore adds no Tauri commands or capabilities: writing and reading use
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
- `list_artists`, `save_artist`, `delete_artist`
- `list_setlists`, `get_setlist`, `save_setlist`, `delete_setlist`
- `reorder_items(setlist_id, from, to)`, `setlist_duration(setlist_id)`
- `import_logo(bytes, file_name)`, `remove_logo(file_name)`

Argument names are camelCase on the JavaScript side (Tauri's default). Struct fields
remain snake_case because they are the serialized contract.

## Status: implemented vs. missing

The implemented-vs-missing list lives in [`docs/status.md`](docs/status.md),
tracked against the in-repo plans in `docs/plans/`; keep it in sync in the
same commit as each change.

## License

MIT — see [LICENSE](LICENSE).
