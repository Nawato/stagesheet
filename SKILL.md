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
    pub duration_secs: Option<u32>,
    pub notes: Option<String>,
}

pub enum SetlistItem {
    Song(Song),
    Break { duration_mins: u32, note: Option<String> },
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
  `{"Song": {...}}` and `{"Break": {"duration_mins": 10, "note": null}}`.
- `LogoAlignment` deserializes case-insensitively (`"left"`, `"Left"`, `"CENTER"`).
- `Song.key` and all optional fields default when missing.
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
- `<thead>` carries the logo/title/venue/date header and column labels; it repeats on
  every printed page. `<tfoot>` repeats the footer.
- Rows use `.song-row` / `.break-row` and must keep `break-inside: avoid`.
- Typography targets: title 22–26pt bold, meta 11–12pt, song rows 12–14pt, tabular
  figures for numbers/BPM/key.
- Screen preview is a real A4 box scaled with `--sheet-scale`; print resets the
  transform and padding (`@page` owns the margins).
- `#setlist-sheet` must stay `background: #fff; color: #000` on screen and print.
- Logos are forced to grayscale in print, regardless of the preview toggle.

## Tests that must stay green

- `cargo test` in `src-tauri`: model round-trips, first-draft JSON migration, reorder
  bounds, duration with breaks, storage CRUD, logo validation/traversal rejection.
- `npm run build`: TypeScript strict mode + Vite production bundle.
