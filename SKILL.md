# StageSheet — agent contract

This file pins the data contract and non-negotiable design rules. Read it before
editing models, storage, IPC, or the printable sheet.

## Hard rules

1. **Print output is black on white on A4.** `@page { size: A4 portrait; margin: 13mm 12mm; }`.
   Never add a dark-stage theme, gradient, or colour-dependent styling to
   `#setlist-sheet`, `.sheet-page`, or anything inside them.
2. `#setlist-sheet` is the printed node in Single mode; in Multiple mode the
   `#sheet-pages` frame stack is printed instead (the tall sheet stays the
   export/measurement source and is hidden in print). UI chrome may be themed;
   neither the sheet nor the frames may.
3. Duration is computed in Rust, never only in the UI:
   `sum(song.duration_secs or 0) + sum(break.duration_secs)`.
4. All storage lives under `<app_data_dir>/stagesheet/`; the frontend `fs` capability
   is scoped to `$APPDATA/stagesheet/**`. Do not widen it. The only device-local
   UI state outside it is the Feature 29 one-time logo-geometry upgrade guard in
   `localStorage` (`stagesheet.logoGeometryMigrated`): it is not user data, never
   enters the backup envelope, and the backend never reads it.
5. Every Tauri command is `async` and returns `Result<T, AppError>`.
6. Logos are rendered only via `<img src>` (blob/data URLs). Never inline SVG
   markup into the DOM: stored SVGs may contain scripts, and `<img>` is the
   one context where they cannot execute.

## Data contract (`src-tauri/src/models.rs` and `src/types.ts`)

```rust
pub enum LogoAlignment { Left, Center, Right } // Center is the default

pub struct LogoConfig {
    pub file_name: Option<String>, // plain name inside <app_data>/stagesheet/logos/
    pub width_mm: f32,             // 10.0..=80.0 (per-setlist display geometry)
    pub alignment: LogoAlignment,
}

pub struct Artist {
    pub id: uuid::Uuid,
    pub name: String,          // trimmed, non-empty
    pub logo: LogoConfig,      // file shared with setlists; width/alignment render-dead
}

pub struct Song {
    pub id: uuid::Uuid,
    pub title: String,
    pub artist: Option<String>,        // display snapshot / legacy free text
    pub artist_id: Option<uuid::Uuid>, // artist record; missing in old files
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
    pub show_duration: bool,  // Duration column
    pub show_comment: bool,   // song/break comments + break label
}

pub enum SetlistItem {
    Song(Song),
    Break {
        duration_secs: u32,         // 0..=36000, checked in Setlist::validate
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
    pub logo: LogoConfig,            // serde alias: logo_config; per-setlist geometry
    pub sheet_options: SheetOptions, // missing in old files -> all true
    pub page_mode: PageMode,         // missing in old files -> Single
    pub artist_id: Option<uuid::Uuid>, // setlist's own artist; missing -> None = unlocked
    pub created_at: chrono::DateTime<chrono::Utc>,
    pub updated_at: chrono::DateTime<chrono::Utc>,
}
```

Serde notes:

- `SetlistItem` uses serde's default externally tagged form:
  `{"Song": {...}}` and
  `{"Break": {"duration_secs": 600, "note": null, "label": null}}`.
  A missing `note`/`label` deserializes to `None` (old files stay valid).
  `SetlistItem` derives `Serialize` and deserializes through a manual
  implementation: breaks accept the pre-Feature-17 `duration_mins` payload and
  convert it × 60, while `duration_secs` wins when both fields exist. Writing
  always emits `duration_secs` only, never `duration_mins`. A break with neither
  field is malformed and rejected. The legacy conversion saturates at `u32::MAX`
  so any old u32-sized minute value still loads; validation then rejects it on
  the next save (save-only, like all bounds).
- `LogoAlignment` deserializes case-insensitively (`"left"`, `"Left"`, `"CENTER"`).
- `Song.key` and all optional fields default when missing.
- `Artist.name` is trimmed in both directions; a whitespace-only name loads as
  an empty string and fails `Artist::validate()` on its next save (clear artist
  name error). There is deliberately no invented maximum length.
- `Artist.logo` shares `LogoConfig`'s storage, validation, and file pool (plain
  file name, 10..=80 mm, same alignment enum; missing logo objects default to
  **no file / 40 mm / Center**), but since Feature 29 only `file_name` is live.
  Artist `width_mm`/`alignment` stay serialized and validated yet are
  **render-dead**: the setlist editor never writes them, and no setlist path
  calls `save_artist` for geometry (artist saves still round-trip the stored
  values). Width and alignment
  always come from `setlist.logo.width_mm` / `setlist.logo.alignment`, so two
  setlists of one artist size the same image independently. New setlists start
  at 40 mm / Center. On the first startup after the upgrade, a deterministic
  migration copies the live artist's width (clamped 10–80) and alignment into
  each logo-less setlist whose live artist has a logo and whose stored geometry
  is still exactly 40 mm / Center; the copy is persisted through
  `save_setlist`. A UI-level localStorage guard
  (`stagesheet.logoGeometryMigrated`) records the completed pass and the ids
  whose save failed, so it does not reopen the whole pass and only retries
  those failures; on that device while the key exists, new/reset 40 mm /
  Center setlists keep their value (no schema/model marker, no schema bump).
  A pre-upgrade setlist deliberately left at 40/Center while its artist uses
  another size adopts the artist size once on that first start — accepted,
  harmless, then stable.
- `Song.artist` stays the display snapshot and legacy free-text field.
  `Song.artist_id` (Feature 14) carries the artist record reference and
  `#[serde(default)]` keeps old songs loading with `None`. Since Feature 20,
  `artist_id` is **mandatory on save**: a song with no `artist_id` fails
  `save_song` with `“<title>” has no artist — assign it before saving.`
  Records with `artist_id: None` still load, list, and restore — they are
  "unfiled", never a load error. Saving a song assigned
  to a record stores both the id and the record's current name in `artist`;
  renaming the artist never rewrites songs. Display resolution is frontend-only
  (`resolveArtistName` in `src/artists.ts`): live record name; else (only
  when `artist_id` is `None`) the `artist` text; else blank. A dangling id
  (record gone) resolves as **unfiled** for songs and setlists alike — no
  legacy-text fallback, blank display, Unfiled scope membership, and excluded
  from the landing assign offer (Feature 25 contract change).
- `Setlist.artist_id` (`#[serde(default)]`, old files load as `None`) is the
  setlist's **own artist A**. Since Feature 20 it is likewise **mandatory on
  save** (`save_setlist` fails an unfiled setlist with the same shaped
  message), while loading/listing/reading backups still accept `None`.
  A dangling id resolves as **unfiled** in the UI (Unfiled scope,
  `File under…` row, excluded from the landing assign offer); the backend
  still accepts `Some` on save. Assigning or clearing A is a normal setlist
  edit (dirty + persisted on save). Setlist duplication (Feature 13) copies
  the field.
- **Unfiled allowance** (Feature 20): `save_song` / `save_setlist` take an
  optional `allow_unfiled` argument (JS `allowUnfiled`, default `false`).
  With the flag, validation skips only the artist check — every other rule
  still applies. Exactly three paths use it: backup restore (re-saving stored
  records as-is), artist-deletion reference-nulling, and the `reorder_items`
  command re-saving an already-stored unfiled setlist. Everything else
  (editor saves, adds, duplication, backup's dirty-setlist auto-save)
  requires an artist. Setlist item snapshot songs never go through
  save-validation: only the setlist itself must be filed. Trust rule
  (Feature 25): `allow_unfiled` is a UX-convention trust, not a capability —
  any IPC caller can pass it; the backend narrows *what* is skipped (only the
  artist check), not *who* may call. The frontend passes it only on the three
  paths above.
- Setlist duplication (Feature 13) is frontend-only through `save_setlist`: the
  new `Setlist` gets a fresh UUID and fresh `created_at`/`updated_at`, while
  `items` are deep-copied values (song snapshot ids are kept) and `venue`,
  `date`, `logo` config, `sheet_options`, `page_mode`, and `artist_id` are
  copied. The logo `file_name` is shared, not copied; `remove_logo` already
  keeps a file while any setlist or artist references it. Titles follow
  `X` → `X (copy)` → `X (copy 2)`: the source is trimmed, an existing suffix is
  stripped, the base is trimmed again, and a blank title falls back to
  `Untitled setlist`; candidates compare trimmed and case-insensitively over
  stored setlist titles. A dirty editor saves first (the Print/Backup rule);
  save failures abort the duplicate and leave the cache/editor on the source.
  Success selects the clean copy in the header (it copies the filed artist, so
  it stays in the active scope). No sheet, `<colgroup>`, frame, print-CSS,
  raster, or layout change is involved.
- **Opt-in song propagation (Feature 28)**: the library stays the canonical
  edit place. Library→setlist starts only after a successful library save;
  setlist→library starts only from an explicit setlist Save (`#save-setlist` or
  the setlist Ctrl/Cmd+S path), after the saved-runtime status — never on field
  blur, Print, Duplicate, Back up, File under…, or an auto-save. Matching is
  `Song.id` equality only (no title/artist-text fallback; dangling/legacy rows
  never match), scoped to the active artist through `resolveArtistForSong()` /
  `songInScope()`; the Unfiled scope and other artists are never offered. Both
  directions require the library song to be filed (`findArtistById` resolves its
  `artist_id`), excluding legacy-text/unfiled/dangling records.
  Library→setlist targets are in-scope saved setlists with a differing
  song-data item snapshot; a dirty target (only `current`) is skipped and
  reported, never auto-saved, and a clean `current` is included.
  Setlist→library compares only `title`, `bpm`, `key`, `tuning`,
  `duration_secs`, and `notes` against the pre-save cached item (or the library
  song for a new setlist/item), ignores artist text/`artist_id`, and copies only
  the effective changed fields onto the filed library song while preserving its
  `artist` snapshot and `artist_id`; its dialog body uses neutral "library copy
  is different" wording, not an "old version" claim. One modal runs per changed
  song, sequentially.
  The reusable `showChoiceDialog` is safe-default (`role="dialog"`,
  `aria-modal="true"`, header/main and a visible landing overlay inert, exactly
  two always-enabled buttons, initial focus on Keep; Enter/Escape keep unless
  the user has explicitly Tabbed to Update, where the focused button activates
  — Escape always keeps; Tab trapped between the buttons); there is no silent
  sync, global/per-song toggle, or "don't ask again".
  Library→setlist accept writes each clean target via `save_setlist` with every
  matching item snapshot replaced by `{ ...saved }`; setlist→library accept
  writes only the changed data fields via `save_song`. Accepted batches hold a
  `propagationBusy` lock (`syncCaptureLock`, `itemList` inert, print/export
  unavailable, editor/library/scope/backup guards); library→setlist re-reads
  each planned setlist target before writing, and a changed/cache-mismatched
  target is skipped with `Skipped “<Setlist>”: changed while updating.`
  Propagation writes never pass `allowUnfiled`; a pending dialog counts as
  unsaved work for `beforeunload`. Item snapshots remain gig copies; this
  explicit-save offer is the only path that rewrites saved copies.
- The artist list is frontend-sorted by name. Counts use resolved identity:
  id-backed songs count for their record, legacy-text songs count for a
  same-named record until adopted, and unmatched text stays uncounted. Search
  and sort-by-artist use the same resolved display name.
  `libraryArtistBucket()` in `src/artists.ts` still shares that identity for
  the Artists-section counts, and Unfiled membership resolves through
  `resolveArtistForSong()` directly — but the Feature 15 library Artist select
  itself is retired (Feature 20 scopes the whole workspace instead).
- Feature 20 scopes the workspace to one active artist at a time (session-only
  `activeArtistId`, never persisted/backed up/dirty). The header **Artist**
  picker is the scope switcher: artist entries plus `Unfiled (N)` plus a
  `Choose artist…` shortcut back to the landing page; switching follows the
  existing setlist-switch guard (confirm discard of a dirty editor). The
  library shows only the active artist's songs (`resolveArtistForSong()`
  identity: id-backed plus same-named legacy text), combined with search, Has
  tuning, and sort. The song-count badge reports the scoped count; totals live
  on the landing page. The Add form auto-assigns the active artist (no dropdown
  in an artist scope); the Feature 12 inline editor shows the owning artist
  read-only and adopts it on save — moving a song between artists stays out of
  scope (delete + re-add in the right library). New setlists pre-assign the
  active artist; **New is unavailable in the Unfiled scope** — the button
  stays activatable (`aria-disabled`, not `disabled`) with an adjacent hint
  and an empty-state CTA, so attempted activation announces the next step.
  Each unfiled setlist
  gets a `File under…` select that files it through the normal save path;
  saving an unfiled setlist from the editor fails with the unfiled message
  until it is filed. The Feature 16 lock chrome (forced filter + note +
  `· <A>` summary suffix) and the per-setlist editor Artist select are
  retired; the add-gate refusal stays only as a defensive guard for
  stale-cache edges, and the summary keeps `· N not by <artist>` for legacy
  leftovers. A dangling setlist artist id resolves as unfiled in the UI.
  Feature 19's width slider and alignment radios edit the setlist draft's own
  geometry in every scope (Feature 29), never the artist record.
- The landing page (`#landing-overlay`, chrome only — never sheet markup or
  print CSS) gates the workspace: it shows on startup whenever no artist is
  selected for the session, and reopens later via the header picker. No
  artists yet → create first (name + logo upload/remove + preview + the artist
  form validation). Artists exist → selection list with logo thumbnails and
  song/setlist counts, per-row **Edit** (the same name/logo upload/remove/
  preview form and validation, inline on the landing card, preserving the
  record's stored width/alignment untouched) and **Delete** (the same
  confirm with the unfiled consequence and the same guards), a New artist
  affordance, and an Unfiled entry when
  unfiled records exist. After entering an artist, truly unfiled records (a
  null `artist_id` with no resolved artist — dangling ids excluded) are
  offered
  once per entry for assignment (`save_*` loops with per-record status);
  declining keeps them Unfiled. While visible, the overlay marks the header
  and workspace `inert`, so keyboard focus cannot Tab out of the dialog;
  Escape closes a reopened landing page (an open artist-edit draft cancels
  first without closing) and focus returns to the scope
  switcher. 44px targets, labels, keyboard focus, and
  dialog/menu/select aria throughout.
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
  - `Artist::validate()`: name non-empty after trim; logo width 10..=80 mm and
    plain file name (shared `LogoConfig::validate`).
  - `Setlist::validate()`: title non-empty; logo width 10..=80 mm and plain file
    name; every item via `SetlistItem::validate()`.
  - `SetlistItem::validate()`: songs delegate to `Song::validate()`; breaks
    require `duration_secs` in `0..=36000` (the old 600-minute cap, in seconds),
    `label` ≤ 24 chars, and `note` (the break "Comment") ≤ 140 chars. Lengths
    are counted after trimming. Oversized legacy minute values still load but
    fail this check on save.
- `Setlist.logo` accepts the legacy key `logo_config`; missing timestamps default to
  `Utc::now`.
- TS mirror: `SheetOptions`, `DEFAULT_SHEET_OPTIONS`, and
  `withSheetDefaults()` live in `types.ts`. Run setlists through the helper when
  loading/cloning so a field left off by an older writer still means "visible".
  `PageMode`, `DEFAULT_PAGE_MODE`, and `withPageModeDefaults()` live there too;
  they normalize a missing `page_mode` to `"Single"`.
  `normalizeArtistId()` maps missing/blank song/setlist `artist_id` values to
  `null` on load, adoption, cloning, saving, and restore.
  `Artist` is mirrored in `types.ts`; `src/artists.ts` holds
  `resolveArtistName()` (display/search/sort), `resolveArtistForSong()`
  (resolved counts, scope identity, and the Unfiled bucket), and
  `resolveSetlistLogo()` (own file → artist file → none, with geometry always
  from `setlist.logo`; used by preview, print, and export). Unfiled scope
  membership resolves through `resolveArtistForSong()` directly.
  `BreakItem.duration_secs` is the only written break length.
  `withBreakDefaults()`/`normalizeSetlistItems()` convert legacy backup JSON
  (`duration_mins` × 60, preferring `duration_secs`) and are applied on restore
  and when adopting loaded setlists; `duration_mins` is never persisted.
  `formatBreakDuration()` in `format.ts` is the shared display helper:
  `11 sec` under a minute, `10 min` for whole minutes, `1 min 5 sec` otherwise.
- Unknown legacy fields are ignored, so the first-draft schema still loads.

## Storage

```text
<app_data_dir>/stagesheet/
├── songs.json            # Vec<Song>
├── artists.json          # Vec<Artist>
├── setlists/<uuid>.json  # Setlist
└── logos/<uuid>.<ext>    # PNG / JPEG / SVG, max 5 MiB
```

- Writes: temp file + rename, serialized by a tokio mutex.
- Logo file names are plain names (no separators, `..`, drive letters, or `:`).
- Setlist and artist logos share `logos/` and the same `import_logo` path.
  `remove_logo` deletes a file only when no setlist or artist record references
  it (checked under the write mutex; missing files are success). Setlist/artist
  deletion only schedules `remove_logo`, so an interrupted delete never breaks a
  still-referenced logo.
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

`list_songs`, `save_song`, `delete_song`, `list_artists`, `save_artist`,
`delete_artist`, `list_setlists`, `get_setlist`, `save_setlist`,
`delete_setlist`, `reorder_items`, `setlist_duration`, `import_logo`,
`remove_logo`.

`delete_artist` removes only the artist record; the frontend nulls referencing
song/setlist ids through `save_song`/`save_setlist` loops with `allowUnfiled`
and reports per-record failures. Its confirm names the consequence:
`Delete artist “<name>”? N songs and M setlists will become unfiled.` The backend
deliberately has no bulk import or cascade command.

JS argument keys are camelCase (`setlistId`, `fileName`, `allowUnfiled`);
model fields are snake_case.

## Sheet markup and CSS

- `<div id="setlist-sheet">` contains a `<table class="sheet-table">`.
- Columns are built from `Setlist.sheet_options`: `#` and `Song` always exist;
  `Key`, `Tuning`, `BPM`, and `Duration` each render only while their toggle is on.
  `Tuning` additionally requires at least one song in the setlist to have tuning
  set. The editor labels the tempo toggle **"Tempo (BPM)"**; the sheet keeps the
  compact `BPM` heading.
- The table carries a width preset named for its visible column combination,
  never the count: `.cols-2` (index/song, 8/92);
  `.cols-3-key|tuning|bpm` (7/83/10) and `.cols-3-time` (7/75/18);
  `.cols-4-key-tuning|key-bpm|tuning-bpm` (7/73/10/10),
  `.cols-4-key-time|tuning-time|bpm-time` (7/65/10/18);
  `.cols-5` (any three info columns incl. Duration, 7/55/10/10/18);
  `.cols-5-no-time` (key+tuning+bpm, 7/63/10/10/10); and `.cols-5-tuning`
  (all four info columns, 6/50/9/10/9/16). Every preset sums to 100%. The
  `<colgroup>` is the only width source — never add `th` width rules — and the
  numeric header/body cells share right alignment and 1.5 mm horizontal padding.
- The brand logo resolves **only its file** through the chain: setlist's own
  `logo.file_name` when set, otherwise its artist's `logo.file_name` when set,
  otherwise none. `resolveSetlistLogo()` is the single helper for preview,
  print, and export, and it always pairs the resolved file with the setlist's
  own `logo.width_mm` / `logo.alignment` (Feature 29) — artist geometry is
  render-dead. The Logo fieldset width slider and alignment radios therefore
  edit `setlist.logo` in every case: `input`/`change` clamp width to 10–80 mm,
  write the draft, `markDirty()`, and `renderSheet()`. The no-logo case
  pre-sizes the next own logo; the controls stay enabled whenever a draft is
  open, and only the export capture temporarily disables/reverts them
  (`captureGuard()` reverts via `renderLogoControls()`). There is no
  setlist → artist geometry write, no revert closure, and no artist-draft/
  backup/import refusal here. Uploading an own logo keeps the setlist's current
  geometry (no adoption step); removing it resolves to the artist image at
  that same size; only the draft's own file name changes (dirty + normal Save),
  with no hidden or cross-record setlist write. Showing-line strings (adjust
  only names):
  `Setlist logo — size applies to this setlist only.`;
  `“<Name>” logo (from the artist) — size applies to this setlist only.`;
  `No logo yet — add an image above, or add one to “<Name>” and it will appear
  here.`; and `No logo yet — add an image above.` (no live artist, dangling id,
  or Unfiled). The line stays `role="note"`, never live. No column, frame,
  print-CSS, or raster change is involved.
- **Resolve-vs-pin artist logos (Feature 30)**: the artist image is **live**
  for every setlist without its own `logo.file_name`; changing or removing it
  never silently rewrites followers. A committed inline artist Edit with a
  non-null pre-save artist file that changed (change or removal) offers
  Keep-vs-follow once per edit; adding a first image never prompts. The
  landing create-form Save is addition-only and never opens the dialog (a new
  artist has no setlists). *Affected* = persisted setlists whose `artist_id`
  equals the edited record, whose own `logo.file_name` was null before the
  save, and whose pre-save artist file was non-null. Own-logo, other-artist,
  Unfiled/dangling, and placeholder setlists when the artist had no old image
  are never counted or written. After `save_artist` + `refreshLogoIfChanged`,
  followers already resolve the outcome, so the dialog uses **outcome
  framing**: heading `Keep the old logo on N setlists?`, the body says the
  setlists were using the old image and now show the new image/`No logo yet`,
  and the confirm is `Use new logo` / `Leave them without a logo` (singular
  `Leave it without a logo`). `showChoiceDialog` resolves true only for that
  explicit confirm (Follow) and false for the focused Keep. **Follow**
  performs **zero `save_setlist` writes** — those setlists resolve the new
  file or none automatically. **Keep** pins the old artist `file_name` as
  each target's own logo through one `save_setlist` per target while
  preserving that setlist's `width_mm`/`alignment` (display pixels unchanged,
  `its own logo` for one setlist); a clean `current` may be pinned. A dirty
  `current` still at no own logo is pinned **in its draft only**
  (`markDirty()`, no auto-save) and reported `Keep the old image on
  “<Setlist>” too — save that setlist to apply it.`; a dirty `current` with a
  different own logo is skipped (`Skipped “…”: unsaved changes.`).
  `showChoiceDialog` keeps Keep focused, traps Tab, and counts a pending
  dialog as unsaved work. Accepted pins hold `propagationBusy` /
  `syncPropagationLock(true)`, show `Restoring the old image on N setlists…`,
  keep the visible landing overlay inert, and make `closeLanding`, scope
  entry/switch, backup/restore, save/delete/duplicate/New, print/export, File
  under…, and library actions refuse. Each planned target is re-read before
  its write (`Skipped “…”: changed while updating.`). The old file is
  retained (no prune, no `remove_logo`) whenever a target was skipped, the
  draft was pinned, or a pin failed; delete only on a fully successful batch
  with at least one pin or no affected targets. A blocked offer, late block,
  or Keep batch with failures/skips stores a memory-only
  `{ artistId, oldFileName, targetIds }`; the status says the old image is
  kept and that opening Edit retries the choice. `startArtistEdit` re-offers
  through the normal finish path with the pending file and recorded targets
  that still follow the artist, clearing the record first (a blocked/failed
  retry stores it again). A new committed logo change, successful
  Follow/Keep, artist deletion, or restore/adopted cache clears it; a restart
  drops the memory-only retry (the file stays), and `hasUnsavedWork` counts a
  pending record. Guards defer with `Export in progress — “<Artist>” saved
  here only. The old image is kept — open Edit to retry the choice after
  export.` or `“<Artist>” saved here only. Finish the current library/artist
  request. The old image is kept — open Edit to retry the choice.`
  (`artistBusy` is the triggering save and is allowed;
  `libraryWritesInFlight > 1`, `propagationBusy`, `choiceDialogOpen`, etc.
  defer; an Edit retry has no triggering save, so any
  `libraryWritesInFlight > 0` or `artistBusy` defers). The setlist side stays
  silent-local: upload/Remove changes only the
  draft's `logo.file_name` and the normal Save persists it (no hidden or
  cross-record `save_setlist`). The Logo fieldset's **Reset to artist logo**
  button clears only the draft's own `file_name` (width/alignment survive),
  adds that file to `pendingLogoRemovals` so the normal save cleanup removes
  it if unreferenced (backend skips shared files), stops a local upload
  preview from winning, updates the showing line, and awaits
  `refreshLogoIfChanged()` before `Artist logo restored — save to apply.` It
  is native-disabled unless there is an own file, the live artist has a
  different file (resolved even when the setlist shows its own logo), and no
  export/propagation/logo-import lock is active; `setlistLogoBusy` disables
  and refuses Remove/Reset during the import. A successful Reset disables
  itself (native-disabled never focusable), so focus moves to `#logo-file`;
  the adjacent `role="note"` hint is `No artist logo — add one to “<Name>”,
  then use Reset to show it here.` (already-following/no-own-logo rely on the
  Feature 29 showing line). No per-setlist picker, "don't ask again",
  cross-artist propagation, geometry change, or logo bytes in backups.
- Logo preview lifecycle (Feature 27): scope entry and startup (`enterScope`,
  `switchScope`, `init`, New, Delete/Discard, restore) await
  `loadLogoForCurrent()` whenever the backend is available, including dirty
  blank drafts pre-assigned to an artist; refiling awaits the resolved refresh
  through the save path. Artist Edit saves prune the
  replaced thumbnail blob URL and warm the saved `file_name` in the landing
  thumbnail cache; create warms the saved file before entering the scope, and
  inline Edit awaits `refreshLogoIfChanged()` before reporting success. A
  changed resolved file is read before the displayed blob URL is
  revoked/swapped, so own-logo removal re-resolves to the artist image
  and an artist image swap never flashes the placeholder; a local upload
  preview wins until an explicit Remove/Reset stops it, stale loads are
  cancelled by `logoRequestId`, and export
  still uses `storedLogoDataUrl()`. The width/alignment rules above are
  unchanged.
- `<thead>` carries the logo/title/venue/date header and column labels; `<tfoot>`
  carries the footer. Both are marked as table header/footer groups
  (`display: table-header-group` / `table-footer-group`). Chromium-based engines
  are expected to repeat them on every printed page; WebKitGTK's print path
  currently does not
  repeat them (WebKit bug 17205 — see the engine note under Feature 5 in
  `docs/plans/upcoming-features.md`). Multiple mode does not depend on that
  repetition: `src/pages.ts` clones the brand header and footer into each
  `#sheet-pages .sheet-page` frame.
- Rows use `.song-row` / `.break-row` and must keep `break-inside: avoid`.
- Song artist always renders under the title; a song comment renders there only
  when `show_comment` is on, and a blank comment emits no element. Break rows
  render `[label] · [duration] · [comment]` inside one full-width dashed cell:
  the duration is always shown, while the label (default `Break`, bold/uppercase)
  and the comment are gated by `show_comment`. There is no separate label
  toggle. Keep the text lookups in helpers (`songCommentText`, `breakLabelText`,
  `breakCommentText` in `sheet.ts`). Break lengths render through
  `formatBreakDuration()` so preview, print, export, and the editor meta agree
  (`11 sec`, `10 min`, `1 min 5 sec`); totals keep `formatRuntime()`.
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
- **Multiple mode is a frame stack.** The tall `#setlist-sheet` stays in the DOM
  as the measurement/export source but is hidden on screen and in print; JS
  (`renderSheetPages` in `src/pages.ts`) measures the rendered rows at
  `--sheet-scale: 1`, groups whole rows under
  `271 mm − header − footer`, and renders one `.sheet-page` per page into
  `#sheet-pages`. Each frame clones the table's `<colgroup>`, brand header
  (logo `<img>`, title, venue/date, column labels), and footer, so nothing
  depends on engine `thead`/`tfoot` repetition. The footer is pinned to the
  bottom of the frame (export composites it at the page bottom too). The label
  reports the actual frame count, not an estimate. `Single` mode never renders
  frames.
- Screen preview is a real A4 box scaled with `--sheet-scale`; in multiple mode
  the frames are stacked with an 8 mm gap and scaled as one stack. Print resets
  the transform, hides the tall sheet, and prints one frame per page
  (`break-after: page`), with `@page` owning the margins. WebKitGTK lays print
  out at GTK's page-setup scale rather than the CSS scale, so `main.ts` marks
  that engine (`html.webkitgtk`) and `print.css` normalizes the frame stack with
  `zoom: 0.885`; other engines print the frames 1:1.
- The single-page fit hint warns below ~70% auto-fit and points at multiple
  pages. It mirrors the applied table zoom measured from the painted table
  height relative to `--sheet-scale` (the preview transform must be divided out,
  or the required fit changes with the window width and the overfull warning
  never fires). The 70% nudge and 50% floor are Single-mode only.
- `#setlist-sheet` and `.sheet-page` must stay `background: #fff; color: #000`
  on screen and print.
- Logos are forced to grayscale in print, regardless of the preview toggle. The
  frame header reuses the same `<img src>` logo path; never inline SVG.

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
  keeps blob URLs. Never widen the CSP or the fs capability for export. The
  exporter receives the resolved logo file plus the setlist's geometry, so the
  export data-URL, printed width, and alignment match the preview; its
  raster/grayscale logic is unchanged.
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
  Multiple mode is still exported from the tall sheet (the frame stack is
  preview/print only): `src/pages.ts` groups rows under the same
  header/footer-adjusted 271 mm capacity the PDF compositor uses, so the frame
  count and the exported page count match. Never feed the framed preview to the
  exporter.
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
    "artists": [ /* Artist */ ],
    "songs": [ /* Song */ ],
    "setlists": [ /* Setlist */ ]
  }
  ```

- Frontend-only by design: export builds the envelope from `list_artists` /
  `list_songs` / `list_setlists`, restore re-saves each record through
  `save_artist` / `save_song` / `save_setlist`. Rust validation, trim rules, and
  serde defaults stay the single authority; never add a bulk import command or
  write storage files directly from the frontend. Restore order is artists first,
  then songs, then setlists. Restore passes `allowUnfiled` so unfiled records
  round-trip as-is; a dirty editor's auto-save before backup still requires an
  artist.
- File access uses `dialog.save` / `dialog.open` plus the existing scoped `fs`
  plugin. The selected path is added to the fs scope for that operation only.
  Do not widen `$APPDATA/stagesheet/**`, add fs commands, or change the CSP for
  backup/restore.
- Version rules: `schema_version` is mandatory and must be a positive integer.
  A version newer than `BACKUP_SCHEMA_VERSION` is rejected with an "update
  StageSheet" message; older versions go through `migrateEnvelope()` before the
  per-record normalizers. Bump `BACKUP_SCHEMA_VERSION` when the serialized
  `Song` / `Setlist` shape changes in a way the per-record normalizers cannot
  absorb; the break seconds rename stays schema 1 because both payload shapes
  normalize to `duration_secs`.
- Break lengths are written as `duration_secs`. Schema-1 backups from older
  builds may still carry `duration_mins`; `normalizeBreak()` runs the same
  seconds-preferred, minutes × 60 fallback as serde, so old backups restore
  with identical totals and are re-saved in the current shape.
- The `artists` array is additive in schema 1. Backups from pre-Feature-14
  builds have no key and restore as an empty artist list (`normalizeArtist()`
  mirrors the Rust name trim/logo defaults). `song.artist_id` and
  `setlist.artist_id` normalize from missing/blank to `null`; restore never
  requires the artist to exist first, so dangling ids stay loadable. Setlist
  `artist_id` round-trips as part of `Setlist` (Feature 16) without a schema
  bump; an older build restoring the file drops the assignment and keeps the
  rest of the setlist.
- Restore semantics: upsert by `id`; records with the same IDs are overwritten,
  nothing else is deleted. Structurally malformed records are skipped and
  reported; validation failures from `save_*` are reported per record. The UI
  confirms before writing and reloads all three caches (artists, songs,
  setlists) afterwards.
- Backup/restore guards: an inline library song draft (including a failed one),
  a non-pristine landing artist-edit draft (edit mode, typed name, or staged
  logo — reopen the landing screen via Choose artist… to resolve it), a
  landing create-form draft (typed name or staged logo), and
  any in-flight library/artist write or artist/landing logo import all
  refuse with a titled status message. Restore re-checks the guard after reading
  the file. Back up locks
  library row actions, the Add submit, and the landing management buttons while
  it reads the snapshot; Restore does the same during its write phase.
  `switchScope` / `enterScope` refuse with a titled status while backing up
  or restoring, and backup/restore refuse while an export capture runs.
  Export likewise locks item editing, meta inputs, and scope switching for
  the capture (working from a pre-capture snapshot of the editor state).
- Artist delete guards: it refuses while a library song write is in flight or an
  inline song draft is open (same rationale as backup), reports a titled
  `Artist delete blocked — …` status, and disables library row actions for the
  reference-clearing loop. A logo import holds the artist Save until it
  finishes; entering/cancelling artist edit mode re-renders the landing row's
  `is-editing`/`aria-expanded` state immediately and returns focus to its
  Edit button.
- Logos are **not embedded in v1**. Setlist `logo` (file name plus the
  per-setlist width/alignment) and artist `logo.file_name` (artist width/
  alignment stay serialized but render-dead) remain in the envelope, so a
  same-device restore keeps working; on a new device the file is absent, the
  preview shows the logo placeholder, and the logo must be re-imported
  manually. Embedding bytes is a future envelope version.

## Tests that must stay green

- `cargo test` in `src-tauri`: model round-trips, artist round-trips and
  name/logo validation, song/setlist title trims like artist names, legacy
  `artist_id` defaulting on songs and setlists,
  dangling artist ids, unfiled save rejection with the named-artist message and
  the `allow_unfiled` acceptance path (other rules still enforced, item
  snapshots exempt, legacy unfiled loads, deletion-nulling, backup round trip
  incl. unfiled, stored-unfiled reorder), legacy minute-break migration and conversion-on-save,
  first-draft JSON migration, reorder bounds, duration with breaks
  (`duration_secs` totals, 11-second precision), break bounds
  (0/36000 pass, 36001 fails, oversized legacy values load then fail save),
  artist/song/setlist storage CRUD, logo removal skipping referenced files,
  logo validation/traversal rejection, raster downscaling, and untouched
  small/SVG logos.
  (The `tauri` crate needs the `webkit2gtk-4.1` system libraries from the README to
  compile, even for pure model tests.)
- `npm run build`: TypeScript strict mode + Vite production bundle.
- Export fidelity is desktop-engine QA, not a unit test: a long setlist must
  produce A4 pages with a visible logo, repeated header/footer, row-safe slices,
  and page numbers; check the CSP console and the PDF with `pdfinfo`.
