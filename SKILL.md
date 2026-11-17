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

pub enum SetlistItem {
    Song(Song),
    Break {
        duration_mins: u32,         // 0..=600, checked in Setlist::validate
        note: Option<String>,       // "Comment" in the UI; trimmed, ≤ 140 chars
        label: Option<String>,      // e.g. "Intermission"; trimmed, ≤ 24 chars
    },
}

pub struct Setlist {
    pub id: uuid::Uuid,
    pub title: String,
    pub venue: Option<String>,
    pub date: Option<chrono::NaiveDate>, // "YYYY-MM-DD"
    pub items: Vec<SetlistItem>,
    pub logo: LogoConfig,            // serde alias: logo_config
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
- Capability: `$APPDATA/stagesheet/**` only; dialog open/save; no shell/network.

## IPC surface

`list_songs`, `save_song`, `delete_song`, `list_setlists`, `get_setlist`,
`save_setlist`, `delete_setlist`, `reorder_items`, `setlist_duration`,
`import_logo`, `remove_logo`.

JS argument keys are camelCase (`setlistId`, `fileName`); model fields are snake_case.

## Sheet markup and CSS

- `<div id="setlist-sheet">` contains a `<table class="sheet-table">`.
- Columns: `#`, `Song`, `Key`, `Tuning`, `BPM`, `Time`. The `Tuning` column renders
  only when at least one song in the setlist has tuning set; without it the
  five-column layout is unchanged.
- `<thead>` carries the logo/title/venue/date header and column labels; it repeats on
  every printed page. `<tfoot>` repeats the footer.
- Rows use `.song-row` / `.break-row` and must keep `break-inside: avoid`.
- Song comments render under the title in the song cell; a blank comment emits
  no element. Break rows render `[label] · [duration] · [comment]` inside one
  full-width dashed cell: the label defaults to `Break`, is bold/uppercase, and
  the duration is always shown. The label and comments will be gated by the
  Feature 4 `show_comment` toggle; keep their text lookups in helpers
  (`songCommentText`, `breakLabelText`, `breakCommentText` in `sheet.ts`).
- Typography targets: title 22–26pt bold, meta 11–12pt, song rows 12–14pt, tabular
  figures for numbers/BPM/key.
- Screen preview is a real A4 box scaled with `--sheet-scale`; print resets the
  transform and padding (`@page` owns the margins).
- `#setlist-sheet` must stay `background: #fff; color: #000` on screen and print.
- Logos are forced to grayscale in print, regardless of the preview toggle.

## Tests that must stay green

- `cargo test` in `src-tauri`: model round-trips, first-draft JSON migration, reorder
  bounds, duration with breaks, storage CRUD, logo validation/traversal rejection.
  (The `tauri` crate needs the `webkit2gtk-4.1` system libraries from the README to
  compile, even for pure model tests.)
- `npm run build`: TypeScript strict mode + Vite production bundle.
