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
docs/plans/          development plan (phases, QA, risks) + feature specs
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
placeholder; preview, print, and export all use that same chain.

## Song library

The library pane keeps reusable songs and offers instant search across title,
artist, key, and tuning. Search matches the resolved artist name, so songs
assigned to an artist record and older free-text songs filter identically. A
view-only sort control orders the list by title (default), resolved artist name,
key, or tuning; missing values sort last and ties fall back to title. An
**Artist** select filters the list to one artist record, or to **No artist**
for songs with no resolved artist identity, and combines with search, sort, and
tuning. Its options carry resolved song counts; legacy text groups under a
same-named record until adopted, while unmatched non-empty text stays under
All artists and in search. **Has tuning** narrows the list to songs with a
tuning set. Each row adds the song to the running order, duplicates it into the
library under a new id with a `(copy)` suffix, or removes it after a
confirmation. **Edit** opens an inline editor in the row with the same fields
and validation as the add form; saving keeps the song's id and re-applies the
current search, sort, artist, and tuning filters, while saved setlists keep
their own copies. Sorting and filtering never mark a setlist dirty or change
the stored data, and the library badge always reports the total song count.

### Artists

The same pane has an **Artists** section with logo thumbnails and resolved song
counts. **New artist** takes a name and the same logo upload, width, and
alignment controls as a setlist; each row's Edit action reuses that form for
name and logo changes, and Delete confirms first. Renaming never rewrites songs
or setlists: they reference the record by id, and the record name wins in the
library display, search, and sort. Song add/edit forms offer **No artist** plus
every record; legacy free-text songs get a "Keep text" option until they are
adopted. Deleting an artist clears referencing `artist_id` values best-effort,
keeps each song's last name snapshot, and leaves its logo file alone while a
setlist or another artist still uses it. Entering or cancelling edit mode
updates the row's editing state immediately; a pending logo import holds the
artist Save until it finishes; and Delete is refused while a library song
edit/save is in flight and locks library row actions while references are
cleared.

### Setlist artists and the library lock

The setlist editor has an **Artist** select (`No artist` = unlocked). Assigning
an artist is a normal setlist edit and is saved with the setlist. The header's
first dropdown is a view-only **Artist** picker (`All artists` default) that
filters the setlist select to that artist's saved setlists; **New** starts a
setlist pre-assigned to the picked artist. The open setlist always stays
available even when it falls outside the filter, and the picker is never saved
or included in a backup.

While the current setlist has a live artist A, the library narrows to A (with
legacy artist text matching A's name by resolved identity) and still combines
with search, sort, and **Has tuning**. The library Artist select is forced to A
and disabled with a note explaining why; unlocking restores the previous
in-memory selection. Adding a song that does not belong to A — including a song
with no artist — is refused with
`“<title>” is not by <A> — switch the setlist artist to add it.` Breaks are
always allowed, existing items are never removed or rewritten, and the running
order summary shows the artist plus a count of non-matching songs when any.

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
tuning, sheet options, page mode, labels, comments, and logo
width/alignment). Break lengths
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
forms (edit mode, a typed name, or a changed logo/width/alignment) to be saved
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
- Song library with instant search (title, resolved artist, key, tuning),
  view-only sort by title/resolved artist/key/tuning, a "Has tuning" filter,
  and a view-only Artist filter (All artists / a record with its resolved song
  count / No artist) that combines with search, tuning, and sort. The filter
  uses the same resolved identity as the Artists section, keeps the total song
  badge, and names the active constraint in empty states. One-click add, inline
  row editing with the add form's validation and field limits (stable id,
  re-sorted and re-filtered after save), per-row duplicate under a new id, and
  delete with confirmation. Free-text tuning (max 24 chars) is part of search,
  the add form, the library editor, and each setlist song's editor details.
- Managed artist records (name + logo) in the library pane with logo
  thumbnails, resolved song counts, an inline create/edit form using the setlist
  logo controls, and confirmed delete. Songs reference artists by id while
  keeping a name snapshot; renaming updates display without rewriting songs or
  setlists, deleting clears references best-effort and reports failures, and
  legacy free-text artists remain as a display fallback (and a "Keep text"
  option) until adopted. Artist logos share the `import_logo` pool and removal
  skips files any setlist or artist still references.
- Setlist editor: title/venue/date, artist assignment (`No artist` = unlocked),
  break insertion (custom label, `mm:ss` length, comment), up/down + drag
  reorder, inline BPM/key/tuning editing, Comment fields for songs and breaks
  (max 140 chars) that render on the sheet, and logo upload with
  width/alignment controls. Oversized raster logos are downscaled on import;
  SVG logos stay vector. The logo chain is setlist own → artist → placeholder
  in preview, print, and export. Delete/Discard sits next to Save in the header
  actions (away from Add break) and keeps the existing confirmation for saved
  setlists and unsaved drafts.
- **Duplicate** sits beside **Delete** and turns the current setlist into a
  preset base: a dirty editor is saved first, then a deep copy is written under
  a fresh id and fresh timestamps. Venue, date, items, logo config (the file
  name is shared, never copied), sheet options, page mode, and the setlist
  artist are copied; the clean copy becomes current. Titles follow
  `X` → `X (copy)` → `X (copy 2)` without stacking suffixes, and deleting one
  copy keeps a logo the other still references.
- Per-artist setlist picker in the header (`All artists` default; **New**
  pre-assigns the picked artist) and an editor-only library lock: the current
  setlist's artist forces the library artist filter, narrows adds to matching
  songs (legacy text resolves by name), and leaves existing non-matching items
  untouched. The summary names the artist and any non-matching count.
- Per-setlist "Sheet columns" toggles for Key, Tuning, Tempo (BPM), Time, and
  Comment, persisted with the setlist and applied to preview, print, and
  export. Column widths are per-combination presets summing to 100% with the
  `<colgroup>` as the only width source, so the header stays aligned with the
  body in every toggle combination. Title/venue/date and song titles always
  print; the Time column can be hidden, while break durations always render.
- Validation hardening on save: break length `0..=36000` seconds (the old
  600-minute cap, entered as `mm:ss`), break label ≤ 24 chars, and song/break
  comments ≤ 140 chars (after trim). Break durations render as `11 sec`,
  `10 min`, or `1 min 5 sec` via one shared helper. Old files still load; their
  next save reports the violation instead of truncating. Legacy minute-only
  break JSON loads as × 60 seconds and is re-saved in the seconds shape.
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
- One-file backup/restore of artists, the whole song library, and every setlist
  as a versioned JSON envelope (`schema_version: 1`), written and read through
  the dialog-scoped fs permission with no new commands or capability widening.
  Restore validates records, re-saves them through the normal commands
  (artists first), and reports imported/rejected counts; future schema versions
  are rejected until the app supports them, older ones can migrate forward.
  Logos are not embedded in v1 and are re-imported manually.

### Still missing (per plan)

- Feature 19 — the setlist editor's logo slider controls the currently
  displayed logo: an artist logo's size is changeable in place, an own logo
  uploaded on top adopts that effective size, and removing it falls back to
  the band logo.
- Feature 20 — artist-first mode: a landing page for artist
  creation/selection, per-artist song libraries and setlists, and a mandatory
  artist on save (legacy records stay "unfiled" until assigned).
- Feature 21 — print/export toolbar consolidation: Print moves beside the
  export buttons, the two export buttons merge into one with a PDF/PNG
  choice after clicking, and the Ctrl/⌘+P pill becomes hover information
  on the Print button.
- Paginated split-setlist helper (move the second half of a setlist into a new
  one) as an alternative to multi-page mode.
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
