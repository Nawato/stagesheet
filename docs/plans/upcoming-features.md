# StageSheet — Upcoming Features Plan

Per-feature specs for what ships next, ordered by priority. The current data
contract lives in `SKILL.md`; these specs extend it and must update it in the
same commit. Statuses: **Todo** / **In progress** / **Done**.

Context: `Song` today is `{ title, artist, bpm, key, tuning, duration_secs,
notes }` (`src-tauri/src/models.rs`, `src/types.ts`), with `artist` as free
text and no artist records. Setlist items store Song *copies* (deliberate:
editing the library never rewrites saved setlists). The sheet defaults to a
single A4 page with auto-fit shrink (`--sheet-fit`, min 50%), implemented in
`main.ts` (`fitSheetToPage`) and `print.css`; per-setlist `page_mode`
(Feature 5) opts into multiple pages instead. Column widths come from
per-combination presets in `app.css` (Feature 10; each sums to 100%);
multi-page preview and print use measured A4 page frames (Feature 11).

Decisions locked in: tuning is a **free-text optional field** (same pattern as
`key`), not a preset picker or per-instrument map. The **library is the
canonical place for song data** (Feature 12): setlist items are gig-specific
snapshots, so fixing a song happens once in the library and saved setlists
keep their copies — there will be no propagation of library edits into
setlists. The artist lock (Feature 16) is an **editor-only constraint**: it
filters the library and gates adds, but it never rewrites existing setlist
items and never changes the printed sheet. **Artists become records**
(Feature 14): one managed artist list with names and logos that songs and
setlists reference by id, replacing free-text matching everywhere new code is
written (legacy `artist` text stays as a display fallback until adopted).

## Shipped (Features 1–11) — summary

Full specs lived here until the 2026-11 cleanup; the contract facts below are
all mirrored in `SKILL.md`, which is now the single authority for shipped
behavior.

- **Validation hardening (with Feature 2)** — Done. `Setlist::validate()` walks
  every item. Bounds enforced in Rust: break `duration_mins` `0..=600`, break
  `label` ≤ 24 chars after trim, song/break comments ≤ 140 chars after trim.
  Validation runs **on save only**: old files still load; their next save fails
  with a clear message. No silent truncation. (Superseded in part by
  Feature 17, which moves breaks to second precision.)
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
- **Feature 6: PDF/PNG export + print** — Done. 300 dpi raster of the
  natural-height sheet (`html-to-image` + `jsPDF`), export-only data-URL logo,
  colgroup workaround, header/footer composited per page, `Page N / M` in PDFs
  only. Exported text is bitmap; `window.print()` stays text-sharp.
- **Feature 7: Backup/restore** — Done. One versioned JSON envelope
  (`BACKUP_SCHEMA_VERSION = 1`), frontend-only through `save_song` /
  `save_setlist`, upsert by id, logos manual in v1. (Feature 14 adds an
  `artists` array to the envelope without a version bump — same additive
  precedent as tuning, sheet options, and page mode.)
- **Feature 8: Library polish** — Done. Per-row duplicate song (` (copy)` title
  scheme, fresh UUID), in-memory sort (title/artist/key/tuning, blanks last),
  **Has tuning** filter. All view-only: never dirty, never backed up. 44px
  targets throughout.
- **Feature 9: Logo downscale on import** — Done. Rasters decoded in Rust;
  longest edge > 1024 px downscaled (Lanczos, aspect kept; PNG stays PNG, JPEG
  re-encodes at quality 85). SVG untouched. 5 MiB cap checked before and after.
  (Reused by artist logos in Feature 14 — same `import_logo` path.)
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

Locked answer to the "songs must be uniform" feedback: the library is the one
canonical edit place, and setlist items stay copies on purpose (a gig snapshot
may legitimately differ — capo, shortened version — from the library
original). Fixing a song happens once in the library; saved setlists are
never rewritten. There is no propagation feature planned; the status line
keeps the copy semantics visible instead.

### Data model

None. `save_song` already upserts by `id` (`storage.rs`), and `Song::validate`
already enforces the add-form bounds (non-empty title, tuning ≤ 24, comment ≤
140 after trim). Re-saving an edited song keeps its id; setlist items hold
copies, so saved setlists are untouched — the same guarantee Duplicate relies
on. No serde, storage, backup, or IPC change. (After Feature 14 the artist
field is a record dropdown; until then it stays the free-text input.)

### UI

- Per-row **Edit** button next to Duplicate (same 44px target, `aria-label`
  `Edit <title> in the library`), opening an inline editor with the same
  fields and limits as the "Add to library" form (title required, BPM 1–400,
  duration `mm:ss`, tuning `maxlength=24`, comment `maxlength=140`).
- **Save** re-saves through `save_song` with the stable id, then re-sorts and
  re-renders the library (including the Feature 15 artist list); **Cancel**
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
`artist_id` (Feature 16). The logo `file_name` is **shared**, not copied:
setlist deletion already skips `remove_logo` while another setlist references
the file, so sharing is safe. Title follows the library pattern
(`X` → `X (copy)` → `X (copy 2)`, non-colliding over setlist titles).

### UI

- **Duplicate** button next to **Delete** in its Feature 18 location
  (away from Add Break), same sizing. No confirmation (non-destructive,
  mirrors Duplicate song).
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
  options/page mode/artist; title suffix increments without stacking
  (`X (copy)` → `X (copy 2)`); items, logo, options, and artist copied;
  timestamps differ; deleting the source keeps the copy's logo working;
  duplicating with backend unavailable reports cleanly.

### Build order

1. Title helper + duplicate flow + selection/status.
2. QA + this file status + commit.
3. Remaining overflow slice stays open: split-setlist (move second half to a
  new setlist) as the alternative to multi-page mode.

## Feature 14: Artist records with logos — Todo

Status: Todo, builds before Features 15–16. From user feedback: artists must
be creatable in one place — name plus logo — and songs (and later setlists)
are assigned to an artist there, instead of retyping free text on every song.
This replaces free-text matching everywhere new code is written; legacy
`Song.artist` text stays as a display fallback until adopted.

### Data model

- New `Artist { id: Uuid, name: String, logo: LogoConfig }` in `models.rs`
  (+ TS mirror in `types.ts`). Name trimmed, non-empty (`validate()` error
  otherwise); logo rules are exactly the setlist-logo rules (plain file name,
  10–80 mm, same alignment enum).
- Storage: `artists.json: Vec<Artist>` under `<app_data_dir>/stagesheet/`,
  temp-file + rename writes under the same mutex. New commands
  `list_artists`, `save_artist` (upsert by id, like songs), `delete_artist`
  (refuses while referenced? No — see below), all `async` returning
  `Result<T, AppError>`. Logo files are shared with the setlist logo pool
  (`logos/` + `import_logo`/`remove_logo`, including the Feature 9 downscale);
  the existing "skip removal while referenced" check extends to artist
  references.
- `Song.artist_id: Option<Uuid>`, `#[serde(default)]`; legacy `artist` text
  stays untouched as the display fallback. Display resolution (frontend
  helper, also used by search/sort): artist record name when `artist_id`
  resolves, else the legacy `artist` text, else blank. Saving a song with an
  artist record stores both the id and a name snapshot in `artist`, so a
  later-deleted artist still shows its last name.
- `Setlist.artist_id: Option<Uuid>`, `#[serde(default)]` (wired in Feature 16;
  declared here so the field ships once).
- Backup envelope gains `artists: [...]`; `BACKUP_SCHEMA_VERSION` stays 1
  (additive; old readers ignore unknown top-level arrays, same precedent as
  before). Restore saves artists first, then songs, then setlists, and
  reports per-record like today.
- Logo resolution for a setlist (used by preview/print/export from
  Feature 16 on): setlist's own logo if set, else its artist's logo if set,
  else the placeholder. No print-path change — the resolved URL flows through
  the existing `logoUrl` plumbing.

### UI

- **Artists** section in the library pane: list with logo thumbnails and song
  counts; **New artist** (name + the same logo upload/width/alignment
  controls as setlists, 44px targets); rename inline (propagates
  automatically — everything references the id); **Delete** with the standard
  `window.confirm` naming the artist. Deleting nulls `artist_id` on
  referencing songs/setlists via `save_*` loops (snapshots keep their names,
  setlists become unlocked); nothing else is deleted. Failures report
  per-record in the status line.
- Song form + Feature 12 editor: the artist text input becomes a dropdown of
  artist records plus **No artist**. Legacy-text songs keep showing their
  text until assigned; assigning sets id + snapshot.
- The search box keeps matching the resolved display name, so legacy and
  record-backed songs filter identically.

### Tests + QA

- Rust: `Artist` round trip; name validation (blank fails); legacy song
  without `artist_id` loads as `None`; id + snapshot survive a round trip;
  logo bounds shared with setlists; `cargo test` green.
- `npm run build` clean.
- Manual QA: create/rename/delete artist; rename reflects in library +
  setlists without touching them; delete nulls references (snapshots shown,
  setlists unlocked, nothing else deleted); logo resolution chain
  (setlist → artist → placeholder) in preview and export; backup/restore
  round trip incl. artists; old-build restore drops artists but keeps
  songs/setlists (documented, accepted).

### Build order

1. Rust model + storage + commands + tests; TS types + resolution helper.
2. Artists section + song-form dropdown + Feature 12 editor dropdown.
3. Backup `artists` array + restore ordering.
4. QA + `SKILL.md` + this file status + commit.

## Feature 15: Filter library by artist — Todo

Status: Todo, builds on Feature 14. Sort-by-artist (Feature 8) orders the
list but cannot narrow it; bands with a multi-artist library cannot isolate
one artist's songs. This is the in-memory, view-only filter; the persisted
per-setlist variant is Feature 16.

### Data model

None. New in-memory state (e.g. `artistFilter: string | null`, holding an
artist id or `"none"` for unassigned, default `null` = all artists) alongside
`songSort`/`tuningOnly`: it never marks a setlist dirty, is never persisted,
and never enters the backup envelope.

### UI

- An **Artist** select in `.library-controls` (`All artists` default) listing
  artist records with song counts, plus **No artist** for unassigned songs
  (legacy-text songs without an id count under their record once adopted,
  otherwise under No artist only if they have no text at all — resolved
  display name decides, exactly like search).
- Combines with instant search, **Has tuning**, and sort (filter first, then
  the existing sort). The empty state names the active constraint
  (`No songs by “<name>” match that search.` / `No songs by “<name>” yet.` as
  appropriate). The song-count badge keeps reporting total library size.
- The list refreshes on add/edit (Feature 12)/duplicate/delete/restore and on
  artist create/rename/delete (Feature 14) so the dropdown never goes stale.
  44px target, visible label, same as sort/filter.

### Tests + QA

- `npm run build` clean; `cargo test` green (no Rust change).
- Manual QA matrix: each artist × search text × Has tuning × each sort;
  No-artist grouping; legacy-text songs filter by their text; empty-state
  wording per combination; dropdown updates after
  add/edit/duplicate/delete/restore and after artist changes.

### Build order

1. Record-based predicate + select + empty states (reuses Feature 14's
  resolution helper).
2. QA + this file status + commit.

## Feature 16: Setlist artist + per-artist setlist picker (lock) — Todo

Status: Todo, builds on Features 14–15. From user feedback: songs belong to
the same artist the setlist belongs to, and picking an artist in the first
dropdown shows that artist's setlists in the second dropdown. The lock is the
toggleable enforcement of that assignment: while locked, only matching songs
can be added.

### Data model

- `Setlist.artist_id: Option<Uuid>` (declared in Feature 14):
  `#[serde(default)]`, missing in old files → `None` = unlocked. TS
  normalizer (missing/blank → `None`) applied wherever
  `withSheetDefaults`/`withPageModeDefaults` run. No length bound — any
  record id is accepted; dangling ids (artist deleted on another device)
  resolve as unlocked with the stored snapshot shown, never a save error.
- Validation on save: none beyond the id resolving or dangling (both fine);
  the gate below is UI-only, like the Feature 8 filters.
- Backup carries the field as part of `Setlist` (schema stays 1); restoring
  on an older build drops the assignment and keeps everything else.
- Duplication (Feature 13) copies the value.

### UI

- Editor **Artist** section (below the setlist meta, above the running
  order): a select of artist records plus **No artist** (= unlocked),
  persisted on the setlist, marks dirty like any edit. Logo note: with no
  own logo the setlist shows its artist's logo (Feature 14 resolution chain).
- Header **artist picker** (first dropdown, left of the setlist select):
  `All artists` default. Selecting an artist filters the **setlist select**
  (second dropdown) to that artist's setlists; with zero matches the select
  shows its empty state and **New** starts a setlist pre-assigned to that
  artist. Switching back to All restores the full list; the current setlist
  stays selected even if it falls outside the filter (never yank the editor
  out from under the user).
- While the current setlist has an artist A (case-insensitive id match;
  legacy-text songs match when their trimmed text equals A's name, so old
  libraries gate sensibly before adoption):
  - The library list narrows to A, combined with search, Has-tuning filter,
    and sort. The Feature 15 select is forced to A and disabled with a note;
    unlocking restores the previous in-memory selection.
  - **Add gate:** adding a non-A song is refused with
    `“<title>” is not by <A> — switch the setlist artist to add it.` Breaks
    have no artist and are always allowed.
  - Existing items are never touched: non-A rows stay, and the setlist
    summary gains a `· <A>` suffix (plus a non-matching count when > 0).
    No retroactive removal, consistent with copy semantics.

### Sheet + print

Explicitly none: the artist assignment is editor chrome plus logo
resolution, never extra printed markup. No sheet, `<colgroup>`, frame,
print-CSS, or exporter change; existing paper QA stands.

### Tests + QA

- Rust: round trip with/without `artist_id`; legacy JSON without the field
  loads as `None`; dangling id validates fine; `cargo test` green.
- `npm run build` clean.
- Manual QA: assign/unassign artist; header picker filters the setlist
  select (incl. zero-match + pre-assigned New); lock/unlock round trip; add
  gate per case (match, mismatch, blank-artist song, legacy-text song,
  break allowed); search + tuning filter still narrow within the lock;
  Feature 15 select disabled/restored; summary suffix + mismatch count;
  duplicate carries the artist; backup/restore preserves it; dirty/save
  flows treat artist edits like any edit.

### Build order

1. `Setlist.artist_id` wiring end-to-end (selector section + header picker
  + gate + summary).
2. QA + `SKILL.md` + this file status + commit.

## Feature 17: Breaks with second precision — Todo

Status: Todo, independent of the artist chain. From user feedback: real
breaks can be 11 seconds (EOAK set), and minute-only granularity cannot
express that. Replaces the `duration_mins` side of the validation-hardening
contract; everything else (labels, comments, bounds philosophy) stays.

### Data model

- `Break { duration_secs: u32 }` replaces `duration_mins`. Validation
  `0..=36000` (the old 600-minute cap, now in seconds), save-only like
  before. Deserialization accepts the legacy shape: prefer `duration_secs`,
  fall back to `duration_mins × 60`, so pre-feature files load with identical
  totals. TS `BreakItem` mirrors the field; a load-time normalizer applies
  the same fallback for JSON that bypasses serde (backup restore path).
- Rust `duration_secs()` contribution is unchanged in kind (already seconds).
  Display helper (shared frontend, e.g. `formatBreakDuration`): under 60 s →
  `11 sec`; whole minutes → `10 min` (unchanged); otherwise `1 min 5 sec`.
  Totals via `formatRuntime` are untouched.

### UI

- Break editor: the Minutes number input becomes an `mm:ss` text field
  reusing the song-duration `parseDuration`/`durationInputValue` helpers
  (`maxlength` fitting `600:00`, same `is-invalid` + status-line pattern as
  song durations). Sheet and editor meta use the shared display helper, so
  preview, print, export, and the summary always agree.
- No migration UI: old breaks load converted and save converted on next
  save; the status line explains nothing unless validation fails (same
  save-only philosophy as before).

### Sheet + print

No structural change: the break row keeps `[label] · [duration] · [comment]`
with the new duration text. Row heights shift slightly for second-precision
labels; auto-fit absorbs it in Single mode, frames re-measure in Multiple
mode. No column, frame, print-CSS, or exporter change.

### Tests + QA

- Rust: round trip with `duration_secs`; legacy `duration_mins` JSON loads
  as × 60; bounds 0/36000 pass, 36001 fails; save-only loading of oversized
  legacy values still parses but fails validation. `cargo test` green.
- `npm run build` clean.
- Manual QA: 11-second break end to end (edit → sheet → print → export →
  total runtime); legacy setlist with minute breaks loads identical and
  saves converted; invalid input (`99:99`, blanks) follows the song-duration
  error pattern.

### Build order

1. Rust model + migration + tests; TS types + normalizer + display helper.
2. Editor field + sheet/meta rendering.
3. QA + `SKILL.md` + this file status + commit.

## Feature 18: Delete-clarity (setlist) — Todo

Status: Todo, tiny, independent. From user feedback: **Delete** sitting
directly next to **Add break** reads as "delete the break", and deleting a
saved setlist must always ask first. The confirm already exists
(`deleteCurrent`); this feature moves the button where it can't be
misread instead of adding new behavior.

### Spec

- Move the **Delete** button out of the running-order actions row — next to
  **Save** in the header actions (or under the setlist meta if header space
  loses on narrow screens; decide at implementation, keep 44px). The header
  context (right beside Save, acting on the current setlist) already makes
  the target unambiguous, so the label stays **Delete** — no rename.
  **Add break** stays where it is; each break row keeps its own ✕ remove
  action, unchanged.
- Keep the existing `window.confirm` (`Delete “<title>”? This cannot be
  undone.` / discard-draft variant); unsaved-draft wording stays (`Discard`
  label when the setlist was never persisted). No data-model, IPC, or
  storage change.
- Feature 13's **Duplicate** button lands beside it in the new location.

### Tests + QA

- `npm run build` clean; `cargo test` green (no Rust change).
- Manual QA: button location at full and narrowed widths; confirm
  appears for persisted setlists and drafts; cancel keeps everything;
  post-delete selection + logo-cleanup behavior unchanged.

### Build order

1. Move + rename (+ Feature 13 button placement follows it).
2. QA + this file status + commit.

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
- **P1 — Library/setlist tooling**: Feature 12 (edit library songs) and
  Feature 13 (duplicate setlist as preset base) in any order; Feature 18
  (delete clarity) and Feature 17 (break seconds) likewise independent. Then
  the artist chain in order: 14 (artist records + logos) → 15 (library artist
  filter) → 16 (setlist artist + per-artist picker + lock).
- **P1 — Backup/restore**: Done (Feature 7). One versioned JSON envelope for
  the full library + setlists; logos are re-imported manually in v1.
  Feature 14 adds the `artists` array without a version bump.
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
  import to a 1024 px longest edge; SVGs stay vector. Artist logos reuse the
  same path.
- **P3 — Scale-out**: SQLite migration past ~1000 songs; CI-based signing,
  release automation, auto-update.
