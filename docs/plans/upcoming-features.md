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
`key`), not a preset picker or per-instrument map. The artist lock (Feature 15)
is an **editor-only constraint**: it filters the library and gates adds, but it
never rewrites existing setlist items and never changes the printed sheet.

## Shipped (Features 1–11) — summary

Full specs lived here until the 2026-11 cleanup; the contract facts below are
all mirrored in `SKILL.md`, which is now the single authority for shipped
behavior.

- **Validation hardening (with Feature 2)** — Done. `Setlist::validate()` walks
  every item. Bounds enforced in Rust: break `duration_mins` `0..=600`, break
  `label` ≤ 24 chars after trim, song/break comments ≤ 140 chars after trim.
  Validation runs **on save only**: old files still load; their next save fails
  with a clear message. No silent truncation.
- **Feature 1: Song tuning (free text)** — Done. `Song.tuning: Option<String>`,
  trimmed, empty → `None`, max 24 chars, `#[serde(default)]`. Conditional
  `Tuning` column (toggle on *and* ≥1 song with tuning). Library search covers
  tuning.
- **Feature 2: Customizable break block** — Done. `Break.label: Option<String>`
  (trimmed, ≤ 24, renders `Break` when absent). Sheet row renders
  `[label] · [duration] · [comment]`.
- **Feature 3: Comment field on songs + breaks** — Done. `Song.notes` /
  `Break.note` labeled **"Comment"** in the UI, `maxlength=140`, rejected on
  save past 140 chars after trim. Song comments render under the title; break
  comments inline. Both gated by the Comment toggle.
- **Feature 4: Toggleable sheet blocks** — Done. `SheetOptions` persisted per
  setlist, container-level `#[serde(default)]` over an all-`true` `Default`
  (never field-level bool defaults). Tempo toggle labeled **"Tempo (BPM)"**;
  there is no label toggle (Comment gates the break label); break duration
  always renders.
- **Feature 5: Multi-page A4 mode** — Done (physical-paper QA pending).
  `Setlist.page_mode` (`Single` default; unknown/cased values rejected).
  Single keeps the `--sheet-fit` cap with a sub-70% legibility nudge and a 50%
  floor. Multiple flows whole rows across pages. WebKitGTK's print path does
  not repeat `thead`/`tfoot` (WebKit bug 17205) — recorded per engine, not
  re-argued here.
- **Feature 6: PDF/PNG export + direct print** — Done. 300 dpi raster of the
  natural-height sheet (`html-to-image` + `jsPDF`), export-only data-URL logo,
  colgroup workaround, header/footer composited per page, `Page N / M` in PDFs
  only. Exported text is bitmap; `window.print()` stays text-sharp.
- **Feature 7: Backup/restore** — Done. One versioned JSON envelope
  (`BACKUP_SCHEMA_VERSION = 1`), frontend-only through `save_song` /
  `save_setlist`, upsert by id, logos manual in v1.
- **Feature 8: Library polish** — Done. Per-row duplicate song (` (copy)` title
  scheme, fresh UUID), in-memory sort (title/artist/key/tuning, blanks last),
  **Has tuning** filter. All view-only: never dirty, never backed up. 44px
  targets throughout.
- **Feature 9: Logo downscale on import** — Done. Rasters decoded in Rust;
  longest edge > 1024 px downscaled (Lanczos, aspect kept; PNG stays PNG, JPEG
  re-encodes at quality 85). SVG untouched. 5 MiB cap checked before and after.
- **Feature 10: Column widths rebalance + header alignment** — Done.
  Per-combination presets (`.cols-2`, `.cols-3-*`, `.cols-4-*`, `.cols-5`,
  `.cols-5-no-time`, `.cols-5-tuning`), each summing to 100%; `<colgroup>` is
  the only width source.
- **Feature 11: Paginated multi-page preview + print** — Done. `src/pages.ts`
  groups whole rows under 271 mm of content height into `.sheet-page` frames
  with cloned brand header and footer; the tall sheet stays as the
  export/measurement source. Frame count equals exported PDF page count.
  WebKitGTK frames are normalized with `zoom: 0.885` in print.

## Feature 12: Edit library songs — Todo

Status: Todo. Library rows today offer Add / Duplicate / Delete only, so a
typo fix means delete + re-add under a new id. Setlist-side editing already
exists (title/venue/date inputs plus per-row "Edit details" / "Edit break"),
so this feature is the library half of "edit existing songs and playlists";
no setlist-editor change ships here.

### Data model

None. `save_song` already upserts by `id` (`storage.rs`), and `Song::validate`
already enforces the add-form bounds (non-empty title, tuning ≤ 24, comment ≤
140 after trim). Re-saving an edited song keeps its id; setlist items hold
copies, so saved setlists are untouched — the same guarantee Duplicate relies
on. No serde, storage, backup, or IPC change.

### UI

- Per-row **Edit** button next to Duplicate (same 44px target, `aria-label`
  `Edit <title> in the library`), opening an inline editor with the same
  fields and limits as the "Add to library" form (title required, BPM 1–400,
  duration `mm:ss`, tuning `maxlength=24`, comment `maxlength=140`).
- **Save** re-saves through `save_song` with the stable id, then re-sorts and
  re-renders the library (including the Feature 14 artist list); **Cancel**
  discards without touching the cache. Field-level error messages match the
  add form; failures report through the status line.
- The status line confirms with `Updated “<title>” in the library. Setlists
  keep their own copies.` so the copy semantics stay visible.

### Tests + QA

- `npm run build` clean; `cargo test` green (no Rust change; upsert is covered
  by the existing storage test).
- Manual QA: edit every field once; validation errors (empty title, bad BPM,
  bad duration, over-long tuning/comment); id stable across save (check
  `songs.json`); saved setlists byte-identical after a library edit; backup
  round trip unaffected.

### Build order

1. Inline editor + `save_song` wiring + re-render.
2. QA + this file status + commit.

## Feature 13: Duplicate setlist as preset base — Todo

Status: Todo. Starting a new gig from last month's running order today means
rebuilding it song by song. Duplicating a setlist under a fresh id gives a
"base preset" to rename and reshape.

### Data model

None. The duplicate is a new `Setlist` written through the existing
`save_setlist`: fresh UUID, fresh `created_at`/`updated_at`, deep-copied items
(item `Song` snapshots keep their song ids — they are values, not references),
copied `venue`, `date`, `logo` config, `sheet_options`, `page_mode`, and
`artist_lock` (Feature 15). The logo `file_name` is **shared**, not copied:
setlist deletion already skips `remove_logo` while another setlist references
the file, so sharing is safe. Title follows the library pattern
(`X` → `X (copy)` → `X (copy 2)`, non-colliding over setlist titles).

### UI

- **Duplicate** button in the editor's running-order actions (next to Delete,
  same sizing). No confirmation (non-destructive, mirrors Duplicate song).
- If the editor is dirty, save first — same rule as Print/Backup/Export — so
  the preset is the saved state; if the save fails, abort with the save error.
  Backend unavailable aborts with the standard message.
- On success the new copy becomes the current setlist (clean, not dirty) and
  the status line confirms `Duplicated “<title>” as “<copy title>”.`
- Deleting one copy never removes a logo still referenced by the other (already
  the `deleteCurrent` behavior; covered by QA, not new code).

### Sheet + print

No change. The copy renders through the same `sheet.ts` path with copied
options; option-for-option output is identical to the source at duplication
time.

### Tests + QA

- `npm run build` clean; `cargo test` green (no Rust change).
- Manual QA: duplicate a setlist with songs + breaks + logo + non-default
  options/page mode/lock; title suffix increments without stacking
  (`X (copy)` → `X (copy 2)`); items, logo, options, and lock copied;
  timestamps differ; deleting the source keeps the copy's logo working;
  duplicating with backend unavailable reports cleanly.

### Build order

1. Title helper + duplicate flow + selection/status.
2. QA + this file status + commit.
3. Remaining overflow slice stays open: split-setlist (move second half to a
  new setlist) as the alternative to multi-page mode.

## Feature 14: Filter library by artist — Todo

Status: Todo. Sort-by-artist (Feature 8) orders the list but cannot narrow it;
bands with a multi-artist library cannot isolate one artist's songs. This is
the in-memory, view-only filter; the persisted per-setlist variant is Feature
15.

### Data model

None. New in-memory state (e.g. `artistFilter: string | null`, default
`null` = all artists) alongside `songSort`/`tuningOnly`: it never marks a
setlist dirty, is never persisted, and never enters the backup envelope.

### UI

- An **Artist** select in `.library-controls` (`All artists` default) populated
  from the distinct trimmed non-blank library artists, sorted with
  `localeCompare`. Songs with a blank artist appear only under `All artists`.
- Combines with instant search, **Has tuning**, and sort (filter first, then
  the existing sort). The empty state names the active constraint
  (`No songs by “<artist>” match that search.` / `No songs by “<artist>” yet.`
  as appropriate). The song-count badge keeps reporting total library size.
- The list refreshes on add/edit (Feature 12)/duplicate/delete/restore so the
  dropdown never goes stale. 44px target, visible label, same as sort/filter.

### Tests + QA

- `npm run build` clean; `cargo test` green (no Rust change).
- Manual QA matrix: each artist × search text × Has tuning × each sort;
  blank-artist songs under All only; empty-state wording per combination;
  dropdown updates after add/edit/duplicate/delete/restore.

### Build order

1. Distinct-artist derivation (shared helper — Feature 15 reuses it) +
  select + predicate + empty states.
2. QA + this file status + commit.

## Feature 15: Per-setlist artist lock (toggleable) — Todo

Status: Todo, builds on Feature 14. A tribute gig or single-artist night drawn
from a multi-artist library should not collect stray songs: the setlist locks
to one artist, the library narrows to match, and adds of other artists are
refused with a clear message. Unlocking restores the previous view.

### Data model

- New `Setlist.artist_lock: Option<String>` — trimmed free text, blank →
  `None`, `#[serde(default)]` with the same trimmed-text serde helpers as
  `tuning`/`label`, so pre-feature files load as unlocked. TS mirror:
  `artist_lock?: string | null` plus a normalizer (missing/blank → `null`)
  applied everywhere `withSheetDefaults`/`withPageModeDefaults` are applied
  (load, clone, restore).
- Validation (save only, like everything else): no length bound — `Song.artist`
  has none, and the lock must accept any artist value a song can carry. A blank
  lock normalizes to `None` before validation rather than failing.
- Backup envelope carries the field automatically as part of `Setlist`;
  `BACKUP_SCHEMA_VERSION` stays 1 (purely additive — same precedent as tuning,
  sheet options, and page mode). Restoring a locked setlist on an older build
  drops the lock and keeps everything else; the restore summary already covers
  per-record notes, so no new envelope machinery.
- `Setlist::new` defaults to `None`. Duplication (Feature 13) copies the value.

### UI

- Editor **Artist lock** section (below the setlist meta, above the running
  order): a checkbox `Lock this setlist to one artist` plus an artist input
  with a `datalist` of distinct library artists (Feature 14 helper — free text
  stays allowed so a setlist can lock to an artist with no songs yet). Both
  persist on the setlist and mark it dirty like any edit.
- While locked to artist A (case-insensitive trimmed match, mirroring search):
  - The library list is narrowed to A, combined with the existing search,
    Has-tuning filter, and sort. The global Artist select (Feature 14) is
    forced to A and disabled with a note; unlocking restores the previous
    in-memory selection.
  - **Add gate:** adding a non-A song is refused with
    `“<title>” is not by <A> — unlock the setlist to add it.` Breaks have no
    artist and are always allowed. Search/add flows otherwise unchanged.
  - Existing items are never touched: non-A rows already in the running order
    stay, and the setlist summary gains a `· locked to <A>` suffix (plus a
    non-matching count when > 0, e.g. `· locked to ABBA (2 other-artist
    songs)`). No retroactive removal, consistent with copy semantics.
- Unlocking (unchecking) keeps the items, clears the gate, and restores the
  library view.

### Sheet + print

Explicitly none: the lock is editor chrome, never printed markup. No sheet,
`<colgroup>`, frame, print-CSS, or exporter change; existing paper QA stands.

### Tests + QA

- Rust: serde round trip with/without the lock; legacy JSON without the field
  loads as `None`; blank lock normalizes to `None`; save-time validation
  accepts any non-blank lock and still rejects bad items (delegation
  unchanged). `cargo test` green.
- `npm run build` clean.
- Manual QA: lock/unlock round trip; add gate per artist (match, mismatch,
  blank-artist song, break allowed); search + tuning filter still narrow within
  the lock; global artist select disabled/restored; summary suffix + mismatch
  count; duplicate (Feature 13) carries the lock; backup/restore on the same
  build preserves it; dirty/save flows treat lock edits like any edit.

### Build order

1. Rust model + validation + tests; TS types + normalizer.
2. Editor section + library predicate/gate + summary suffix.
3. Backup/restore spot-check + QA + `SKILL.md` + this file status + commit.

## Roadmap backlog (prioritized)

- **P0 — Sheet correctness fixes (from real use)**: Features 10 (column widths
  rebalance + header alignment) and 11 (paginated preview/print frames) are
  done. The sheet is the product; new tooling stays behind these.
- **P0 — PNG/PDF export + print**: Feature 6 done. Physical-paper QA and
  cross-engine checks remain in Phase 6.
- **P0 — Overflow tooling for the single-A4 cap**: Feature 5 shipped
  (multi-page mode + sub-70% legibility nudge). Feature 13 adds setlist
  duplication; the remaining slice is a split-setlist helper (move second half
  to a new setlist) as an alternative to multi-page.
- **P1 — Library/setlist tooling**: Features 12 (edit library songs), 13
  (duplicate setlist as preset base), 14 (artist filter), 15 (per-setlist
  artist lock) — Todo, in that build order (15 reuses 14's artist derivation;
  13 copies 15's lock value).
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
