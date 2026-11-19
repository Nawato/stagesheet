# StageSheet — Upcoming Features Plan

Per-feature specs for what ships next, ordered by priority. The current data
contract lives in `SKILL.md`; these specs extend it and must update it in the
same commit. Statuses: **Todo** / **In progress** / **Done**.

Context: before Feature 14, `Song` was `{ title, artist, bpm, key, tuning,
duration_secs, notes }` (`src-tauri/src/models.rs`, `src/types.ts`), with
`artist` as free text and no artist records. Setlist items store Song *copies*
(deliberate: editing the library never rewrites saved setlists by default;
Feature 28's per-edit offer is the only rewrite path). Feature 14 has
since added managed `Artist` records plus `Song.artist_id`/`Setlist.artist_id`
with the legacy text as a display fallback. The sheet defaults to a
single A4 page with auto-fit shrink (`--sheet-fit`, min 50%), implemented in
`main.ts` (`fitSheetToPage`) and `print.css`; per-setlist `page_mode`
(Feature 5) opts into multiple pages instead. Column widths come from
per-combination presets in `app.css` (Feature 10; each sums to 100%);
multi-page preview and print use measured A4 page frames (Feature 11).

Decisions locked in: tuning is a **free-text optional field** (same pattern as
`key`), not a preset picker or per-instrument map. The **library is the
canonical place for song data** (Feature 12): setlist items are gig-specific
snapshots, so fixing a song happens once in the library and saved setlists
keep their copies by default — there is no silent propagation of library edits
into setlists (Feature 28 adds an explicit per-edit opt-in offer). The artist
lock (Feature 16) is an **editor-only constraint**: it
filters the library and gates adds, but it never rewrites existing setlist
items and never changes the printed sheet. **Artists become records**
(Feature 14): one managed artist list with names and logos that songs and
setlists reference by id, replacing free-text matching everywhere new code is
written (legacy `artist` text stays as a display fallback until adopted). The
setlist editor's width slider and alignment radios edit **this setlist's own
geometry** (Feature 29; superseding Feature 19's displayed-logo binding) — the
artist keeps only the image, and removing an own logo falls back to the artist
image at the setlist's size. **The artist becomes the workspace
scope** (Feature 20): a landing page gates artist creation/selection, songs
and setlists must belong to exactly one artist on save, and the library and
setlist lists show only the active artist's records (Feature 15's select,
Feature 16's lock chrome, and the per-setlist editor Artist select are
superseded).

## Shipped features — summary

Full specs lived here until the 2026-11 cleanup; the contract facts below are
all mirrored in `SKILL.md`, which is now the single authority for shipped
behavior. Features 12 (edit library songs), 13 (duplicate setlist as preset
base), 14 (artist records with logos), 15 (filter library by artist), 16
(setlist artist + lock), 17 (break seconds), 18 (setlist Delete-clarity), 19
(effective logo width control), 20 (artist-first mode: landing page +
per-artist scoping), and 21 (print/export toolbar consolidation)
are Done; their specs remain below as reference.

- **Validation hardening (with Feature 2)** — Done. `Setlist::validate()` walks
  every item. Bounds enforced in Rust: break `duration_secs` `0..=36000` (the
  old 600-minute cap), break `label` ≤ 24 chars after trim, song/break comments
  ≤ 140 chars after trim. Validation runs **on save only**: old files still
  load; their next save fails with a clear message. No silent truncation.
  Feature 17 replaced the minute field with seconds; legacy `duration_mins`
  JSON still loads × 60.
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
- **Feature 14: Artist records with logos** — Done. `artists.json` +
  `list_artists` / `save_artist` / `delete_artist`; shared logo pool;
  `Song.artist_id` with name snapshot fallback; `Setlist.artist_id` (wired by
  Feature 16); library Artists section and song dropdowns; additive schema-1
  backup `artists` array. Renames never rewrite songs/setlists.
- **Feature 15: Filter library by artist** — Done. View-only **Artist** select
  (`All artists` default) with resolved song counts plus **No artist**;
  combines with search, Has tuning, and sort. In-memory only: never dirties a
  setlist, persists, or enters a backup. Counts and the predicate share
  `libraryArtistBucket()`, so legacy text groups under its record and
  unmatched text stays under All artists.
- **Feature 16: Setlist artist + per-artist picker + lock** — Done. Editor
  **Artist** select (`No artist` = unlocked), header **Artist** picker
  (`All artists`, filters the setlist select, pre-assigns New), and a UI-only
  lock that narrows/forces the library artist filter and refuses non-A library
  adds with the exact gate message. Existing items stay; the summary carries
  `· A` plus a non-matching count. Preview/print/export resolve the logo via
  setlist → artist → placeholder. Backup schema stays 1.

## Feature 12: Edit library songs — Done

Status: Done. Library rows used to offer Add / Duplicate / Delete only, so a
typo fix meant delete + re-add under a new id. Per-row **Edit** now opens an
inline editor in the row; Save upserts the same id and re-applies the active
search/sort/tuning filter, Cancel (or Escape) discards the draft without
touching the cache. Only one row editor is open at a time — opening another
discards the previous draft. Drafts and validation markers survive unrelated
library re-renders. If the active search or filter hides an idle edited row,
the editor closes and the status line announces the cancellation so clearing
the filter cannot resurrect it; while a save is in flight the hidden state is
deferred until the outcome is known — success closes the edit normally, while
failure marks the draft retry-pending and reports a titled error. Retry-pending
drafts stay alive across further hidden renders; clearing the filter restores
the editor with a titled “retry Save” notice. Starting a retry clears
retry-pending and shows a titled `Saving “<title>”…` status, so restore notices
cannot appear while the request is running. Opening another row or cancelling
discards a failed draft with a titled discard message. Back up and Restore
refuse while a library write is in flight or an inline draft (including a failed
one) is open. Hidden retry-pending drafts add “Clear the search or filter, then
save or cancel…” to that guard. Back up locks library rows and the Add submit
while it reads the snapshot; Restore does the same during its write phase and
re-enables them when it finishes (after adopting on success or on the failure
path). These locks do not cover the setlist editor or header actions, and a
setlist draft edited during a restore can be replaced by the adopted state. A
successful Add focuses its title when the Add form still owns focus (including
page-lost focus when no editor draft exists), or when the Add form owned focus
at submit, focus is still page-lost, and no inline editor focus target exists;
otherwise it restores the focused inline editor field or Save/Cancel button and
selection. Deferred focus restores are cancelled by an outside focus and only
apply while focus remains page-lost. Setlist-side editors are unchanged,
and no data-contract change was needed.

Locked answer to the "songs must be uniform" feedback: the library is the one
canonical edit place, and setlist items stay copies on purpose (a gig snapshot
may legitimately differ — capo, shortened version — from the library
original). Fixing a song happens once in the library; saved setlists are only
rewritten when the user accepts the Feature 28 per-edit offer, and declining
(the default) keeps every copy untouched.

### Data model

None. `save_song` already upserts by `id` (`storage.rs`), and `Song::validate`
already enforces the add-form bounds (non-empty title, tuning ≤ 24, comment ≤
140 after trim). Re-saving an edited song keeps its id; setlist items hold
copies, so saved setlists stay untouched unless the Feature 28 per-edit offer
is accepted. No serde, storage, backup, or IPC change. (Since Feature 14 the
artist field is the record dropdown described there.)

### UI

- Per-row **Edit** button next to Duplicate (same 44px target, `aria-label`
  `Edit <title> in the library`), opening an inline editor with the same
  fields and limits as the "Add to library" form (title required, BPM 1–400,
  duration `mm:ss`, tuning `maxlength=24`, comment `maxlength=140`).
- **Save** re-saves through `save_song` with the stable id, then re-sorts and
  re-renders the library (including the Feature 14 artist counts); **Cancel**
  discards without touching the cache. Field-level error messages match the
  add form; failures report through the status line.
- The status line confirms `Updated “<title>” in the library.`; when matching
  in-scope setlist copies differ, the Feature 28 safe-default dialog asks
  before rewriting them (declining keeps every copy untouched and is reported).

### Tests + QA

- `npm run build` clean; `cargo test` green (no Rust change; upsert is covered
  by the existing storage test).
- Manual QA: edit every field once; validation errors (empty title, bad BPM,
  bad duration, over-long tuning/comment); id stable across save (check
  `songs.json`); declining the Feature 28 offer leaves saved setlists
  byte-identical after a library edit, accepting updates only matching
  in-scope copies; backup round trip unaffected.
- Draft/state QA: type in the editor, then trigger search, sort, Has tuning,
  add, duplicate, and delete-another-song in turn; the draft must survive each
  rebuild. Hiding an idle edited row cancels it with the draft title in the
  status message, and clearing the filter must not bring it back. Validation
  styling and `aria-invalid` survive a re-render and clear per field on input.
- Save/filter race QA: hide the edited row during an in-flight save. Success
  closes normally with the Updated status; failure reports a titled error and
  marks the draft retry-pending. Retry-pending drafts survive further hidden
  renders; clearing the filter restores the editor with a titled retry notice.
  Starting the retry replaces that notice with `Saving “<title>”…` and clears
  retry-pending. Opening another row or cancelling discards the failed draft
  with a titled message. The row cannot be deleted while its save is in flight.
- Backup/restore QA: Back up and Restore refuse with a titled message while a
  library write is in flight or a normal/failed inline draft is open; hidden
  retry-pending drafts add the “Clear the search or filter, then…” instruction.
  Back up locks library rows and the Add submit while reading the snapshot, and
  Restore locks them during its write phase and re-enables them when the
  operation finishes (success or failure). The setlist editor/header actions
  stay unlocked and a setlist draft edited during restore may be replaced by the
  adopted state.
- Focus and keyboard QA: every field and Save are disabled during the request;
  focus returns to Edit only when it was still in the editor or lost to the page
  body, never stealing from search/sort/Add. A successful Add focuses its title
  when the Add form still owns focus (including page-lost focus when no editor
  draft exists), or when the Add form owned focus at submit, focus is still
  page-lost, and no inline editor focus target exists; otherwise it restores the
  focused inline editor field or Save/Cancel button and selection. Deferred
  restores are cancelled by focusing outside the editor and only apply while
  focus remains page-lost. Ctrl/Cmd+S inside the inline editor saves the song,
  inside the Add form adds the song, and elsewhere saves the setlist. Repeated
  shortcuts do not double-submit, and a failed Add preserves the typed values
  and names the tried title.

### Build order

1. Inline editor + `save_song` wiring + re-render.
2. QA + this file status + commit.

## Feature 13: Duplicate setlist as preset base — Done

Status: Done. Starting a new gig from last month's running order today means
rebuilding it song by song. Duplicating a setlist under a fresh id gives a
"base preset" to rename and reshape.

### Shipped notes

**Duplicate** sits beside **Delete** in the header actions. It writes a new
`Setlist` through `save_setlist` with a fresh UUID and fresh timestamps,
reusing `cloneSetlist()` so items, logo config, `sheet_options`, `page_mode`,
`artist_id`, venue, and date are deep-copied. Item `Song` snapshots keep their
song ids because they are values; the logo `file_name` is shared, not copied.
A dirty editor saves first (the Print/Backup rule) and aborts with the save
error; an unavailable backend uses the standard message. The title follows
`X` → `X (copy)` → `X (copy 2)`: the source is trimmed, then an existing
suffix is stripped and the base is trimmed again; a blank title falls back to
`Untitled setlist`, candidates compare trimmed and case-insensitively over
stored setlist titles, and the status uses the normalized source title.
Success selects the clean copy in the header (it stays available even when the
header artist filter excludes it) and reports
`Duplicated “<title>” as “<copy title>”.` No confirmation was added. QA note
for the shared logo: deleting either copy is already safe because
`deleteCurrent` only calls `remove_logo` after confirming no remaining setlist
references the file (and the backend repeats that check), so the survivor keeps
its logo; no new cleanup behavior was needed.

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
- If the editor is dirty, save first — same rule as Print/Backup — so
  the preset is the saved state; if the save fails, abort with the save error.
  Backend unavailable aborts with the standard message. (Export is intentionally
  different: it captures the live editor state without saving.)
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

## Feature 14: Artist records with logos — Done

Status: Done, builds before Features 15–16. From user feedback: artists must
be creatable in one place — name plus logo — and songs (and later setlists)
are assigned to an artist there, instead of retyping free text on every song.
This replaces free-text matching everywhere new code is written; legacy
`Song.artist` text stays as a display fallback until adopted.

### Shipped notes

`Artist { id, name, logo }` lives in `artists.json` and shares the setlist logo
pool (`import_logo`, downscale, and the reference-aware `remove_logo`).
`Song.artist_id` stores the record reference while `artist` keeps the current
name snapshot/legacy text; `Setlist.artist_id` was declared here and wired into
the editor, header picker, lock, and logo chain by Feature 16. The library pane gained
an Artists section (logo thumbnails, resolved counts, one shared create/edit
form with name + logo/width/alignment, confirmed delete), and both song forms
use artist dropdowns with a "Keep text" option for unassigned legacy songs.
Renaming never rewrites songs or setlists; `resolveArtistName()` drives library
display/search/sort, `resolveArtistForSong()` backs the resolved counts and the
Feature 15 filter bucket, and `resolveSetlistLogo()` holds the own-logo →
artist-logo → placeholder chain for Feature 16. Delete nulls song/setlist ids
through best-effort `save_*` loops, keeps snapshots, reports per-record
failures, and only then deletes the record and attempts logo cleanup. Backups
carry an additive schema-1 `artists` array and restore artists first, then
songs, then setlists. Follow-up hardening: Back up/Restore treat edit mode, a
typed artist name, or a changed logo/width/alignment as an artist draft and
refuse with a titled message (a pristine empty form does not block), and
Restore re-checks after reading the file; entering/cancelling edit updates
`is-editing` and `aria-expanded` immediately; a pending logo import
disables/rejects the artist Save and blocks backup/restore until it finishes;
artist Delete refuses during a library song write or inline draft and locks
library row actions while clearing references. Manual QA for the artist CRUD,
logo chain, and backup round trip is listed below.

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
- Manual QA: create/rename/delete artist; rename reflects in the library
  display/search/sort without touching songs or setlists; delete nulls
  references (snapshots shown, setlist ids cleared, nothing else deleted);
  edit/cancel immediately reflects `is-editing`/`aria-expanded`; a pending logo
  import holds Save and blocks backup/restore; typed/edit/changed-logo artist
  drafts block backup/restore while a pristine empty form does not; artist
  delete is blocked during a library song write/draft and library rows lock
  during cleanup; logo resolution chain helper (setlist → artist → placeholder)
  is covered by code review now and wired into preview/export by Feature 16;
  backup/restore round trip incl. artists; old-build restore drops artists but
  keeps songs/setlists (documented, accepted).

### Build order

1. Rust model + storage + commands + tests; TS types + resolution helper.
2. Artists section + song-form dropdown + Feature 12 editor dropdown.
3. Backup `artists` array + restore ordering.
4. QA + `SKILL.md` + this file status + commit.

## Feature 15: Filter library by artist — Done

Status: Done, built on Feature 14. Sort-by-artist (Feature 8) orders the list
but cannot narrow it; bands with a multi-artist library cannot isolate one
artist's songs. This is the in-memory, view-only filter; the persisted
per-setlist variant is Feature 16.

### Shipped notes

The library pane has an **Artist** select in `.library-controls` (`All artists`
default) listing every live artist record with its resolved song count plus
**No artist**. Filtering runs before the existing sort and combines with the
instant search and **Has tuning**. `artistFilter: string | null` holds `null`
(all), an artist id, or `"none"`; it lives only in memory, never marks a
setlist dirty, and never enters the backup envelope. One shared
`libraryArtistBucket()` helper feeds both the option counts and the predicate,
using `resolveArtistForSong()` identity: id-backed songs count for their
record, same-named legacy text counts for that record until adoption, and
unmatched non-empty legacy text has no bucket (it stays under All artists and
in search rather than being forced into No artist). Empty states name the
active filter: `No songs by “<name>” match that search.` /
`No songs by “<name>” yet.` (with `No songs without an artist …` for the
No-artist bucket). The options rebuild on every library render, so
add/edit/duplicate/delete/restore and artist create/rename/delete cannot leave
stale labels or counts, and a deleted selected artist resets to All artists.
The song-count badge still reports the total library size, and Feature 12's
filter-hide cancellation, draft retention, save locking, focus, and row layout
rules are unchanged.

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

## Feature 16: Setlist artist + per-artist setlist picker (lock) — Done

Status: Done, builds on Features 14–15. From user feedback: songs belong to
the same artist the setlist belongs to, and picking an artist in the first
dropdown shows that artist's setlists in the second dropdown. The lock is the
toggleable enforcement of that assignment: while locked, only matching songs
can be added.

### Shipped notes

The editor gained an **Artist** section between the setlist meta and the running
order (`No artist` = unlocked). Assigning or clearing it marks the setlist dirty
and persists through `save_setlist`; dangling ids resolve unlocked and remain
saveable. The header gained a view-only **Artist** picker left of the setlist
select: `All artists` by default, filtering the second dropdown by saved
`artist_id`, keeping the open setlist available when it falls outside the
filter, and showing a "No setlists by …" placeholder at zero matches. **New**
pre-assigns the picker's artist (dirty, unsaved as usual); the picker itself is
never persisted, never dirties, and never enters a backup. Both pickers and
labels rebuild after artist create/rename/delete, setlist save/delete/load, and
restore.

With a live setlist artist A, the library list narrows to A using
`resolveArtistForSong()` (id-backed songs plus trimmed, case-insensitive legacy
text matching A's name), combined with search, Has tuning, and sort. The
Feature 15 select is forced to A and disabled with a visible note; the
underlying in-memory selection is untouched and returns exactly on unlock.
Library adds outside A (including songs with no artist) are refused with
`“<title>” is not by <A> — switch the setlist artist to add it.`; breaks stay
allowed and drag/reorder is never gated. Existing non-A items remain, and the
summary appends `· <A>` plus a non-matching song count when > 0. Library edits
still follow Feature 12/15 filter reconciliation.

Preview, print, and export now use `resolveSetlistLogo()`: setlist own logo →
artist logo → placeholder. The resolved file name/width/alignment flows through
the existing live `logoUrl` and export-only data-URL path; the Logo controls
still edit only the setlist's own config, and there is no new printed markup,
column/frame/print-CSS change, or raster change. The preview refreshes when the
setlist artist or the artist's logo changes. `normalizeArtistId()` covers load,
clone, adoption, save, and restore; backups carry the field without a schema
bump. Rust already covered with/without `artist_id`, legacy missing-field
loading, and dangling-id validation from Feature 14.

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
- While the current setlist has a live artist A by id (legacy-text songs match
  when their trimmed text equals A's name, so old libraries gate sensibly
  before adoption):
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
print-CSS, raster, or layout change; the exporter only gains the resolved
`LogoConfig` input. Existing paper QA stands.

### Tests + QA

- Rust: round trip with/without `artist_id`; legacy JSON without the field
  loads as `None`; dangling id validates fine; `cargo test` green.
- `npm run build` clean.
- Manual QA: assign/unassign artist; header picker filters the setlist
  select (incl. zero-match + pre-assigned New); lock/unlock round trip; add
  gate per case (match, mismatch, blank-artist song, legacy-text song,
  break allowed); search + tuning filter still narrow within the lock;
  Feature 15 select disabled/restored; summary suffix + mismatch count;
  backup/restore preserves it; dirty/save flows treat artist edits like any
  edit. Artist delete with a dirty setlist draft: cached S assigned A but the
  draft changed to B keeps B; cached S assigned B but the draft changed to A
  clears A and unlocks. Both must refresh the editor select, header picker,
  lock, summary, and logo fallback. Feature 13's duplicate copies the value.

### Build order

1. `Setlist.artist_id` wiring end-to-end (selector section + header picker
  + gate + summary).
2. QA + `SKILL.md` + this file status + commit.

## Feature 17: Breaks with second precision — Done

Status: Done, independent of the artist chain. From user feedback: real
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

### Shipped notes

`SetlistItem` now derives `Serialize` and deserializes through a wire enum:
`duration_secs` is authoritative, legacy `duration_mins` is multiplied × 60
with u32 saturation, and serialization never writes `duration_mins`. The
shared `formatBreakDuration()` helper drives the sheet and the break editor
meta; totals still use `formatRuntime()`. The editor's `mm:ss` field rejects
blank/invalid values and values above `600:00` with `is-invalid` plus the
status line, and Save commits valid field text to the model before
re-checking the rendered fields and calling the backend (so Ctrl/Cmd+S with the
field still focused cannot save a stale duration).
`withBreakDefaults()`/`normalizeSetlistItems()` in `types.ts` apply
the same legacy fallback when adopting loaded setlists and when restoring a
backup; schema 1 stays unchanged because old and new break payloads both
normalize to `duration_secs`, and restored records are written in the new
shape.

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

## Feature 18: Delete-clarity (setlist) — Done

Status: Done, tiny, independent. From user feedback: **Delete** sitting
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

1. Move the button (label stays Delete; Feature 13's button placement follows
   it).
2. QA + this file status + commit.

## Feature 19: Effective logo width control (setlist slider) — Done

Status: Done, small, independent of Feature 20. From user feedback: if the
artist has a logo, its size must be changeable with the setlist editor's
width slider; when a setlist puts its own logo image on top, that one should
come in at the size that was set up before; removing it must switch back to
the default band logo.

Context: Feature 16 resolves the displayed logo as own → artist →
placeholder, but the Logo fieldset still edits only `setlist.logo`: the width
slider never touches `artist.logo.width_mm`, so with the artist logo on the
sheet the slider does nothing visible, and a newly uploaded own logo lands at
the setlist's stale width instead of the size the user just had on screen.

### Shipped notes

> Superseded in part by **Feature 29**: width/alignment now always edit
> `setlist.logo`; the artist-path `save_artist` commit described below is
> retired. The displayed-file resolution and per-setlist size control remain.

The slider follows the displayed logo: own and placeholder paths stay
`input`-driven on `setlist.logo.width_mm` (placeholder pre-sizes the next
own logo), while the artist path updates the label on `input` and commits
`artist.logo.width_mm` through `save_artist` on `change` without dirtying the
setlist. The artist commit holds `artistBusy`, allows one in-flight save,
refuses while backup/restore or an artist logo import runs or an edit draft
for that artist is open, and reverts the slider on refusal or failure with a
status message that names the shared-size consequence. Uploading an own logo
copies the displayed width/alignment onto `setlist.logo` before the first
re-render; removing it keeps the guarded `remove_logo` flow and the slider
follows back to the artist width. The Logo fieldset shows `Setlist logo` /
`<name> logo (artist)` / `No logo yet`; the Artist-section note is retired to
an always-hidden stub so it never duplicates.

### Data model

None. `Artist.logo` is already a mutable `LogoConfig` persisted through
`save_artist` (Feature 14), and `Setlist.logo` stays the setlist's own
config. No serde, storage, IPC, or backup change.

### Behavior

- The Logo fieldset's width slider edits **the logo currently displayed**
  (Feature 16 resolution):
  - Own logo set → edits `setlist.logo.width_mm`, exactly as today.
  - No own logo, artist logo exists → edits `artist.logo.width_mm` via
    `save_artist`. This is the artist's one shared size (one image, one
    size — changing it here updates every setlist showing that artist's
    logo, and the status line says so). The setlist itself is not dirtied:
    the artist record is what changed.
  - Neither → placeholder; the slider edits `setlist.logo.width_mm`
    (harmless; it pre-sizes the next own logo).
- Artist-logo path: the slider commits on `change` (release), allows one
  in-flight `save_artist` at a time, and reuses the Feature 14 artist-edit
  guards (refuse while a backup/restore or artist-logo import is in
  flight, or while an artist draft for that artist is open). A failed
  artist save reverts the slider to the previous effective value and
  reports through the status line. The own-logo/placeholder paths keep
  today's `input`-driven `setlist.logo` updates exactly as they are.
- **Uploading an own logo adopts the effective size**: `setlist.logo`'s
  width **and alignment** initialize from the currently displayed logo's
  config before re-render, so the replacement appears exactly where and how
  large the artist logo was ("same size as set up before"). Alignment
  adoption is a locked decision for a seamless swap; the width is the part
  the feedback requires.
- Removing the own logo keeps today's guarded `remove_logo` flow; the
  resolution chain switches the display back to the artist logo
  automatically and the slider follows to the artist width. Nothing
  retroactive, no new removal behavior.
- The Logo fieldset gains a visible showing line so the slider's target is
  unambiguous: `Setlist logo`, `<name> logo (artist)`, or `No logo yet`.
  This supersedes Feature 16's Artist-section note (moved here, not
  duplicated).

### Sheet + print

No structural change: the effective width/alignment flows through the
existing `resolveSetlistLogo()` plumbing into preview, print, frames, and
export. No column, frame, print-CSS, or raster change.

### Tests + QA

- `npm run build` clean; `cargo test` green (no Rust change expected).
- Manual QA: artist-logo setlist — slider changes the sheet and every
  setlist of that artist reflects it; uploading an own logo adopts the
  pre-swap size/alignment; removing it returns the artist logo at its size;
  a failed artist save reverts the slider; placeholder setlists are
  unchanged; backup/restore round trip unaffected; the showing line matches
  the resolution in every case.

### Build order

1. Effective-logo binding (slider + upload adoption + showing line +
   guards).
2. QA + `SKILL.md` note + this file status + commit.

## Feature 20: Artist-first mode (landing page + per-artist scoping) — Done

Status: Done, large, builds on Features 14–16 and supersedes parts of
15–16. From user feedback: if no artist is present you must create one
first — a landing page with artist creation and selection. This tightens
the model: each song library and setlist belongs to exactly one specific
artist (1 artist → N songs and N setlists; N setlists → M songs), and
1 song belongs to exactly 1 artist.

### Decisions locked in

- The artist is the **workspace scope**, not a filter: one active artist at
  a time; the library pane is that artist's library and the setlist list is
  that artist's setlists.
- `artist_id` becomes **mandatory on save** for songs and setlists. The
  wire format stays compatible: `Option<Uuid>` with `#[serde(default)]`
  remains (old files load), but save validation rejects a missing
  assignment. No schema bump; "unfiled" is purely the legacy/migration
  state.
- **No retroactive rewrites**: legacy records are never auto-assigned
  silently. Assignment happens through the landing-page offer or explicit
  filing. Setlist items keep the Feature 16 rule — existing non-artist
  items are never removed.
- Superseded by scoping (retire at implementation): the Feature 15 library
  Artist select, the Feature 16 lock chrome (forced filter + note +
  `· <A>` summary suffix) and the editor's per-setlist Artist select. The
  header artist picker becomes the scope switcher. The non-matching item
  count stays.

### Shipped notes

The backend enforces filing through `validate_for_save()` on `Song` and
`Setlist` (same rules as `validate()`, plus the artist check): unfiled saves
fail with `“<title>” has no artist — assign it before saving.`
`save_song` / `save_setlist` / `reorder_items` carry `allow_unfiled`
(JS `allowUnfiled`, default `false`); the flag skips only the artist check and
is used by exactly restore, deletion-nulling, and the stored-unfiled reorder
path. Duplication and the backup dirty-setlist auto-save require an artist
automatically (no flag), and unfiled duplications fail with the unfiled
message. Setlist item snapshots keep plain `validate()`. Storage fixtures
gained artist ids; no schema bump — `Option<Uuid>` with `#[serde(default)]`
stays, and unfiled records load/list/restore as before.

The landing overlay (`#landing-overlay`, chrome only — no sheet markup, hidden
in print) shows on startup with no session selection and reopens via a
`Choose artist…` picker entry (plus Escape/Back when scoped). No artists →
create-first form (name + logo upload/width/alignment + the Artists-section
validation, entering the new scope on success). Artists → per-artist buttons
with thumbnails and resolved song/setlist counts, a New-artist toggle form,
and an Unfiled entry with the total unfiled count. The header picker lists
artist entries plus always-on `Unfiled (N)`; scope switches keep the
confirm-discard dirty guard and reselect inside the scope. The offer runs once
per entry per unfiled signature (confirm assigns through the normal commands
with per-record status; decline keeps Unfiled). `activeArtistId` is in-memory
only. The Unfiled scope shows resolve-null songs and live-null setlists; New
is disabled there; the song Add form and the Feature 12 editor dropdown return
only there (targeting any artist), while an artist scope auto-assigns on Add
and shows the owning artist read-only in the editor (adopted on save).
Unfiled setlists file through a `File under…` select; the retired editor
Artist select is gone, and saving unfiled from the editor surfaces the backend
message. Artist delete confirms
`Delete artist “<name>”? N songs and M setlists will become unfiled.`, nulls through
the allowance, and follows the records (Unfiled scope, or landing when nothing
is unfiled). The Feature 15 select, lock note, and both Artist selects were
removed from markup (plus their CSS/rules); the summary drops `· A` but keeps
`· N not by <artist>`; the badge counts the scope; the Feature 16 refusal
stays as the stale-cache guard.

### Data model

- Save-only validation: a song or setlist with no `artist_id` fails with a
  clear message (e.g. `“<title>” has no artist — assign it before
  saving.`). Loading, listing, and reading backups keep accepting unfiled
  records (the save-only philosophy).
- **Unfiled allowance** (locked mechanism; keeps restore and deletion
  working without a bulk command): `save_song` / `save_setlist` gain an
  optional `allow_unfiled` argument (JS `allowUnfiled`, default `false`).
  With the flag, validation skips only the artist check — every other
  rule still applies. It is used by exactly three paths: backup restore,
  artist-deletion reference-nulling, and `reorder_items` re-saving an
  already-stored unfiled setlist. Everything else (editor saves, adds,
  duplication, backup's dirty-setlist auto-save) requires an artist.
- Storage, `artists.json`, and the backup envelope are unchanged
  (`schema_version` stays 1); unfiled records round-trip as-is through
  the allowance.
- Artist deletion keeps today's reference-nulling, writing the nulled
  records through the allowance; its confirm must state the consequence:
  `Delete artist “<name>”? N songs and M setlists will become unfiled.`
  Deleted-artist records land in the Unfiled scope, never in limbo.

### Landing page

- Shown on startup whenever no artist is selected for the session, and
  reachable later via the header picker. Full-workspace overlay of UI
  chrome only — never sheet markup or print CSS.
- No artists yet → **create first**: name plus the same logo
  upload/width/alignment controls and validation as the Artists section
  (Feature 14). Creating the first artist enters the workspace scoped to
  it.
- Artists exist → **selection list**: logo thumbnails, song + setlist
  counts, a `New artist` affordance (create artist #2 without entering),
  and an `Unfiled` entry when unfiled records exist. Keyboard, labels, and
  44px targets per repo patterns.
- After entering an artist, if unfiled songs/setlists exist, offer once per
  entry: `N songs and M setlists have no artist. Assign them to
  “<name>”?` Confirming assigns through the normal `save_*` loops with
  per-record status; declining keeps them Unfiled.

### Scoped workspace

- The library shows only the active artist's songs (Feature 14/15 resolved
  identity); search, Has tuning, and sort remain. The song-count badge
  switches from total-library to **scoped count** (totals live on the
  landing page) — locked decision.
- The add form assigns the active artist automatically (no artist dropdown
  in an artist scope; the Unfiled scope restores it, see below). The
  Feature 12 inline editor shows the owning artist read-only; moving a
  song between artists is out of scope (mis-filed songs: delete + re-add
  in the right library, consistent with copy semantics).
- Header artist picker = scope switcher: artist entries plus
  `Unfiled (N)`; switching re-scopes library, setlist list, badge, and
  landing-offer state. A dirty editor follows the existing setlist-switch
  guard (save or confirm discard) before the scope changes. New setlists
  pre-assign the active artist (Feature 16 behavior, now the only path).
- Unfiled scope: shows unfiled songs and setlists. The song Add form and
  the Feature 12 editor's artist dropdown reappear **only here** (target:
  any artist, so new and existing songs can be filed on save), and each
  unfiled setlist gets a `File under…` select; filing saves through the
  normal commands and moves the record into its artist scope. Saving an
  unfiled setlist from the editor fails with the unfiled message until it
  is filed. **New setlist is disabled here** (a setlist belongs to an
  artist; switch to an artist scope to create one).
- The add gate becomes inherent (the scoped library only offers the
  artist's songs); keep the Feature 16 refusal as a defensive guard for
  stale-cache edges. The summary drops the `· <A>` suffix (redundant) and
  keeps `· N not by <artist>` when > 0 for legacy leftovers.
- Feature 19's effective-logo slider works unchanged inside the scope (the
  artist logo is the active artist's).

### Tests + QA

- Rust: unfiled song/setlist save rejected with clear messages; unfiled
  accepted with `allow_unfiled` (restore, deletion-nulling, stored-unfiled
  reorder) and still rejected without it; every other validation rule
  still enforced under the flag; legacy unfiled loads; artist deletion
  nulls refs (records become unfiled); backup round trip incl. unfiled.
  Existing save-path fixtures without `artist_id` must gain artist
  fixtures — expect the widest test churn of the artist chain.
- `npm run build` clean.
- Manual QA: fresh install → landing create → scoped workspace; second
  artist create/switch; dirty-switch guard; unfiled offer accept/decline;
  filing songs and setlists from the Unfiled scope (Add form + editor
  dropdown + `File under…`); New setlist disabled in the Unfiled scope;
  restore of a backup containing unfiled records keeps them unfiled;
  save-blocked unfiled editing;
  artist deletion → unfiled counts; Feature 19 slider inside the scope;
  backup/restore incl. unfiled; regression matrix for 12–18 (especially
  the 15/16 retirements and Feature 13 duplication in scoped mode).

### Build order

1. Save validation + `allow_unfiled` allowance + unfiled semantics + Rust
   test fixtures.
2. Landing page (create/select/counts) + startup flow.
3. Scope switcher + library/setlist scoping + add/editor changes +
   badge/summary changes + retire superseded UI.
4. Unfiled scope + landing offer + artist-deletion confirm wording.
5. QA + `SKILL.md` + this file status + commit.

## Feature 21: Print/export toolbar consolidation — Done

Status: Done, small, independent UI-chrome slice. From user feedback:
Print belongs beside the export buttons, the two export buttons become
one with a format choice after clicking, and the always-visible
"Print: Ctrl / ⌘ + P" pill should become hover information instead of
spending toolbar space.

### Shipped notes

**Print** (`#print-setlist`, label unchanged) moved from the header
actions into `.preview-actions` first; the header keeps New/Save/Delete/
Duplicate. One click still calls `window.print()` directly through the
existing `printCurrent` path (dirty auto-save first, webview Ctrl/Cmd+P
untouched). **Export PDF**/**Export PNG** merged into one **Export**
(`#export-setlist`) button opening an in-place `menu` with `PDF`/`PNG`
`menuitem` entries; choosing runs the existing `exportCurrent('pdf'/'png')`
path unchanged (open-after-export checkbox as sibling, status, in-flight
handling). The Export button is disabled with its menu items while a capture
runs, so no second concurrent export. Keyboard: Enter/Space toggles the
menu, arrows/Home/End move between entries, Escape closes and returns
focus to the button; pointer click selects and outside pointer/focus-out
closes. 44px targets, native buttons, visible focus. The group's
`aria-label` is `Print and export`; the menu carries `Export format` with
per-entry Export-as labels. The `.print-hint` span and its CSS (including
the `print.css` exception) are removed; the Print button carries
`title="Print (Ctrl / ⌘ + P)"`. No sheet/print/export/raster/no capability/
CSP/storage/IPC/Rust change.

Context: the header actions carry New/Save/Delete/Duplicate/**Print**
(`#print-setlist`), while the preview toolbar carries a
`.preview-actions` group (`Export PDF` / `Export PNG`), the "Open after
export" checkbox, and the `.print-hint` pill (hidden in print via
`print.css`). Print is one click on `window.print()` and must stay that
way.

### Data model

None. No IPC, storage, exporter, or raster change; both export paths
keep their format-specific behavior and the existing export-in-flight
handling.

### UI

- Move **Print** (`#print-setlist`, label unchanged) out of the header
  actions into `.preview-actions`, first in the group. The header keeps
  the current-setlist actions (New, Save, Delete, Duplicate) — Feature
  18's grouping stays intact. One click still calls `window.print()`
  directly (no menu, no confirm); the webview's own Ctrl/⌘+P path is
  unchanged.
- Merge the two export buttons into a single **Export** button. Clicking
  opens a small in-place menu with exactly two entries, `PDF` and `PNG`;
  choosing one runs the existing exporter path for that format unchanged
  (including the `Open after export` checkbox and status reporting).
  Keyboard: the button opens on Enter/Space, entries are
  arrow-navigable, Escape closes and returns focus to the button;
  pointer users click an entry. 44px targets throughout. While a capture
  runs, the Export button reflects the existing export-state handling
  (no second concurrent export).
- The group's `aria-label` becomes `Print and export`.
- Replace the visible hint with hover information on the Print button:
  `title="Print (Ctrl / ⌘ + P)"`, shown on hover (a native `title` is not
  a dependable focus disclosure, so keyboard users are covered by the
  working Ctrl/⌘+P shortcut itself rather than the tooltip). Decision
  locked: the `.print-hint` span and its CSS (including the `print.css`
  exception) are removed — the shortcut is the platform's standard print
  path, so a tooltip is sufficient discoverability, and the toolbar
  space is freed.

### Sheet + print

None. Button placement is editor chrome; print output, page modes,
frames, the exporter, and raster logic are untouched.

### Tests + QA

- `npm run build` clean; `cargo test` green (no Rust change).
- Manual QA: Print placement at full and narrowed widths; menu opens and
  closes via keyboard and pointer (Escape and focus return); PDF and PNG
  exports unchanged incl. `Open after export`; no concurrent second
  export; Print stays one-click and text-sharp; the header reads as
  current-setlist actions; the hint occupies no toolbar space and shows
  on hover (keyboard users rely on the shortcut itself, not the
  tooltip).

### Build order

1. Move Print + merge export buttons + menu + tooltip swap (CSS cleanup
   incl. `.print-hint`).
2. QA + this file status + commit.

## Feature 22: Header action order (Duplicate beside New) — Done

Status: Done, tiny, independent UI chrome. From user feedback: the
**Duplicate** button belongs beside **New**, before **Save** —
creation-adjacent, not next to **Delete**.

### Shipped notes

`#duplicate-setlist` moved between `#new-setlist` and `#save-setlist`, so
the header reads scope selects, **New, Duplicate, Save, Delete** (order
verified in `index.html`). No label, behavior, or flow change: the same
dirty-save-first, confirm-free duplication. 44px targets and the existing
wrap behavior are untouched. Feature 18's grouping (Delete next to Save)
stays intact.

Context: the header currently reads scope selects, New / Save / Delete /
Duplicate (Feature 13 placed Duplicate beside Delete; Feature 18 put
Delete next to Save). New order: scope selects, **New, Duplicate, Save,
Delete**.

### Spec

- Move `#duplicate-setlist` between `#new-setlist` and `#save-setlist`.
  No label, behavior, or flow change: the same dirty-save-first,
  confirm-free duplication. 44px targets and the existing wrap behavior
  are untouched; no CSS change expected beyond what the move needs.
- Feature 18's grouping (Delete next to Save) stays intact.

### Tests + QA

- `npm run build` clean; `cargo test` green (no Rust change).
- Manual QA: button order at full and narrowed widths; duplication flow
  unchanged (dirty save-first, copy title, clean selection).

### Build order

1. Move the button.
2. QA + this file status + commit.

## Feature 23: Artist management moves to the landing screen — Done

Status: Done, medium, builds on Feature 20. From user feedback: remove
the artists from the main window below the song library. With
artist-first scoping, managing artists inside the song workspace is
redundant and crowds the song workflow.

Context: the library pane carried an **Artists** section (list with
thumbnails/counts + the New/edit form with logo controls) below the song
list; the landing screen already created and selected artists and is
reachable anytime via **Choose artist…**.

### Shipped notes

The `.artists-section` (heading, count badge, list, and form) is gone from
the library pane, including its CSS and handlers. The library pane keeps
songs, the scoped badge, the add form, search/sort/tuning, and the backup
fieldset (Feature 24 moves that separately). Each landing row gained
**Edit** and **Delete** icon buttons (44px, labels, `aria-expanded` on Edit)
beside the workspace entry button. Edit renders the same
name/logo/width/alignment form and validation inline under the row on the
landing card (new `artist-edit-*` ids; the shared `artistFormState` draft
survives card rebuilds, Escape cancels without closing a reopened landing
page, focus returns to the row's Edit button). Delete keeps the same
confirm with the unfiled consequence and the same guards — a library song
write/draft, backup/restore, and either logo import (edit-form or landing
create) refuse with a titled status — plus the colocation guards (an
in-flight landing create/logo import blocks edit/delete/save, and vice versa;
starting an edit while the New-artist form holds a typed name or staged logo
is refused with a titled status, and a typed-but-unsubmitted create name
survives management re-renders via a stashed draft).
Deleting the active artist keeps the follow-records rule unchanged
(Unfiled scope when unfiled records remain, landing re-select when nothing
is unfiled) with a status that names the fallback. The Feature 14/20
artist-form guards moved with the form: the backup/restore draft guard now
names the landing screen (reopen via Choose artist… to resolve it), and
the effective-logo width commit still refuses while that artist's edit
draft is open. The retired `libraryArtistCounts()` / `libraryArtistBucket()`
/ `NO_ARTIST_FILTER` helpers were removed with their only callers. No
model, storage, IPC, or backup change; `SKILL.md` notes where the artist
UI lives.

### Data model

None. No serde, storage, IPC, or backup change. Artist records,
validation, logo pool, and deletion-nulling are untouched.

### UI

- Remove the `.artists-section` (heading, count badge, list, and form)
  from the library pane, including its CSS and handlers. The library
  pane keeps songs, the scoped badge, the add form, search/sort/tuning
  (backup moves separately in Feature 24).
- The landing screen gains full management per artist row: **Edit**
  (reuses the same name/logo/width/alignment form and validation as the
  removed section, inline on the landing card) and **Delete** (same
  confirm with the unfiled consequence, same guards: refuse while a
  library write, backup/restore, or logo import is in flight).
- Deleting the **active** artist keeps the existing follow-records rule
  unchanged (Unfiled scope when unfiled records remain, landing re-select
  when nothing is unfiled) — the management surface moves, the behavior
  does not — with a status naming the fallback.
- The Feature 14/20 artist-form guards move with the form (landing-draft
  blocking of backup/restore stays coherent — the form and the landing
  `inert` scope now coincide).

### Tests + QA

- `npm run build` clean; `cargo test` green (no Rust change expected).
- Manual QA: create/edit/delete artists from landing; rename propagates
  without touching songs; delete-active-artist fallback; guards hold;
  no orphaned ids, handlers, or CSS; library pane layout at full and
  narrowed widths; keyboard/focus through the landing management form.

### Build order

1. Landing management (row Edit/Delete + form move) + remove the pane
   section.
2. QA + `SKILL.md` note (where artist UI lives) + this file status +
   commit.

## Feature 24: Backup & Restore on the landing screen — Done

Status: Done, medium, builds on Features 20 and 23. From user feedback: backup/restore should be a separate button set in the artist
selection/creation screen — and it fixes the v0.3.0 UX finding that a
fresh-device restore currently needs a throwaway artist first.

Context: the backup fieldset lived in the library pane, which is
`inert` while the landing overlay gates the workspace.

### Shipped notes

The library-pane `.backup-controls` fieldset (markup, hint copy, CSS,
handlers) is removed. The landing card carries a **Backup** section with
separate **Back up** and **Restore** buttons (same labels) wired to the same
`backUpLibrary` / `restoreLibrary` entry points — same guards (including the
landing-draft guard with the re-check after the file is picked), same dirty
auto-save before backup, same per-record reporting. The section renders on the
first-run card too, so a fresh profile restores before entering any scope;
after a restore the card rebuilds from the restored artists/songs/setlists
(counts and the Unfiled entry refresh) and the user then enters a scope. No
envelope, schema, IPC, storage, or Rust change.

### Data model

None. No envelope, schema, IPC, or storage change; the same handlers,
guards, and per-record reporting move with the buttons.

### UI

- Add a **Backup** section to the landing card with separate
  **Back up** and **Restore** buttons (same labels, same guards —
  including the landing-draft guard — and the same re-check after the
  file is picked).
- Remove the `.backup-controls` fieldset from the library pane
  (markup, hint copy, CSS, handlers).
- Restore works before entering any scope: after a restore the artist
  list, counts, and Unfiled entry refresh from the restored data, and
  the user then enters a scope. Status reporting is unchanged.
- The setlist editor's dirty auto-save before backup stays as-is; an
  unfiled dirty draft still aborts (its message is improved by Feature
  25, which ships after this one).

### Tests + QA

- `npm run build` clean; `cargo test` green (no Rust change).
- Manual QA: fresh profile → Restore first (no dummy artist), then
  enter a scope; Back up from landing; guards (drafts, in-flight
  writes/imports); restored counts/Unfiled entry correct; no orphaned
  ids/handlers/CSS.

### Build order

1. Landing Backup section + remove the pane fieldset.
2. QA + this file status + commit.

## Feature 25: v0.3.0 review hardening (safety + correctness) — Done

Status: Done, medium batch, from the five v0.3.0 perspective reviews
(UI, UX, normal user, frontend, backend). Each item is small; they ship
as one hardening slice because they share the same guard/message code.

### Shipped notes

> Superseded in part by **Feature 29**: the alignment radios no longer bind
> `save_artist`; width and alignment always edit the setlist's own config, so
> the shared-size status/revert path described below is retired.

- **Export capture lock**: `exportCurrent` snapshots the editor state
  (`cloneSetlist(current)`) before the raster and locks item editing
  (running-order buttons, drag reorder, all inline song/break field edits),
  meta inputs (title/venue/date, `File under…`, sheet options, page mode,
  logo file/width/alignment/remove), setlist switching (New/Save/Delete/
  Duplicate/setlist select), and scope switching (`switchScope` /
  `enterScope`) for the capture via `syncCaptureLock()` + `captureGuard()`
  (refused paths announce through the status line). `renderSheet` already
  ignored edits mid-capture; the finally block unlocks and re-renders, so
  no torn captures. Backup/restore refuse while a capture runs, and vice
  versa.
- **Backup/restore vs scope switch**: `switchScope` / `enterScope` refuse
  with a titled `Scope switch blocked — backup/restore in progress…` error
  status while `backingUp` / `restoring`, so a restore cannot overwrite a
  reselection.
- **Alignment binds the displayed logo**: the alignment radios follow the
  same effective-logo case as the Feature 19 width slider. Own/placeholder
  paths write `setlist.logo.alignment` (dirty + re-render); the artist path
  commits via `save_artist` through a shared `commitEffectiveArtistLogo()`
  helper (one in-flight save, the Feature 14 guards plus backup/restore/
  export guards, radio revert on refusal/failure, shared-size status). The
  showing line now names the width **and** alignment target in every case.
- **Dangling-id resolver contract change**: `resolveArtistForSong()` resolves
  id-backed songs by id only — a dangling id is unfiled (no legacy-text
  fallback) — for songs and setlists alike; `resolveArtistName()` likewise
  shows blank for dangling ids (legacy text only applies when `artist_id`
  is `None`). The landing assign offer lists only true-`None` records with
  accurate copy; counts, scopes, and the Unfiled bucket follow the same rule.
- **Unfiled failure guidance**: when backup / print / duplicate auto-save
  fails on the artist check, the status names the filing next step
  (`“<title>” has no artist — open the Unfiled scope or use File under…
  to file it, or discard the draft, then … again.`) instead of surfacing
  the raw backend message.
- **New-disabled explanation**: the disabled New button in the Unfiled scope
  uses `aria-disabled` (not `disabled`) with an adjacent
  `#new-setlist-hint` plus Unfiled empty-state guidance copy, so attempted
  activation (click or keyboard) announces the next step; keyboard/AT access
  is preserved.
- **Backend**: `save_song` / `save_setlist` trim titles like artist names;
  the `allow_unfiled` trust rule is documented in the command code and in
  `SKILL.md` (any IPC caller can pass it; the backend narrows *what* is
  skipped, not *who*); the stored-unfiled reorder path has a test;
  `artistThumbUrls` blob URLs are pruned on artist delete/replace and
  landing preview blob URLs are revoked on rebuild.
- **Small correctness**: `parseDuration` rejects empty colon parts (like the
  break parser); blank song-duplicate titles fall back to `Untitled song`;
  artist option labels trim; `beforeunload` covers open song/artist/landing
  drafts; `#setlist-sheet` gets `role="region"`; landing Ctrl/Cmd+S routes
  to the artist create form.

### Scope (all must-fix; nothing optional here)

- **Export capture lock** (frontend BLOCKING): `exporting` currently
  disables Print/Export but leaves the editor live while `current` is
  passed by reference into the capture — lock item editing, meta
  inputs, and scope switching for the capture, or snapshot
  `current.items` first; restore afterwards.
- **Backup/restore vs scope switch** (frontend BLOCKING): `switchScope`
  / `enterScope` have no `backingUp`/`restoring` guard while pickers,
  meta inputs, and item actions stay enabled — refuse (or wait out) a
  scope switch mid-snapshot/write so a restore cannot overwrite a
  reselection.
- **Alignment binds the displayed logo** (UX): the width slider follows
  the effective logo (Feature 19) but the alignment radios always write
  `setlist.logo` — bind alignment to the same effective-logo case
  (artist path commits via `save_artist`; the showing line names width
  **and** alignment target), so the two controls can never disagree.
- **Dangling-id resolver as a contract change** (UX): today a dangling
  song id falls back to legacy-text matching while setlists land Unfiled.
  Change the contract so a dangling `artist_id` resolves as unfiled (no
  text fallback) for songs **and** setlists alike; the assign offer then
  lists only true `None` records with accurate copy; update `SKILL.md`
  and this spec's shipped notes to the new rule.
- **Unfiled failure guidance** (UX + normal user): when backup / print /
  duplicate auto-save fails on the artist check, the status names the
  filing next step (open the Unfiled scope / use `File under…` /
  discard-then-switch) instead of surfacing the raw backend message.
- **New-disabled explanation** (UX + normal user): the disabled New in
  the Unfiled scope gets an adjacent hint plus an empty-state CTA
  ("switch to an artist scope to create"), not tooltip-only; announce
  on attempted activation.
- **Backend**: trim song/setlist titles in commands like artists;
  document `allow_unfiled` as UX-convention trust (any IPC caller can
  pass it; the backend narrows *what* is skipped, not *who*); add the
  missing stored-unfiled reorder test; revoke/prune blob-URL caches on
  artist delete/logo replace (artist thumbs + landing previews).
- **Small correctness**: `parseDuration` rejects empty colon parts
  like the break parser; blank song-duplicate title falls back to
  `Untitled song` (mirrors setlists); artist option labels trim;
  `beforeunload` covers open song/artist/landing drafts; `#setlist-sheet`
  gets `role="region"` (or the label goes); landing Ctrl/Cmd+S routes
  to artist create.

### Out of scope

No new screens, no model changes, no envelope change. Larger asks stay
open (undo system, see Feature 26).

### Tests + QA

- `npm run build` clean; `cargo test` green (incl. the new reorder +
  trim tests).
- Manual QA per item: capture while editing; scope switch mid-backup;
  alignment on an artist logo; dangling-id fixtures; each unfiled
  dead-end message; disabled-New hint/announcement; draft-close guard.

### Build order

1. Locks (export, backup/scope) + alignment binding + resolver.
2. Messages (unfiled guidance, New hint) + backend small items.
3. QA + `SKILL.md` + this file status + commit.

## Feature 26: UI polish + language pass — Done

Status: Done, small batch, from the v0.3.0 UI and normal-user reviews.
Visual consistency and wording only; no behavior change beyond the
labels named here. Builds on Feature 22 (assumes the
New/Duplicate/Save/Delete header order).

### Shipped notes

- Export menu right-anchored (`right: 0`) in the right-aligned toolbar.
- Icon-button rows (running-order `.item-actions`, library
  `.song-item-actions`, landing `.landing-manage`) use 8px separation.
- Header grouping: the scope selects sit in an `app-scope-group` and the
  four buttons in an `app-setlist-actions` group with a divider; Delete
  keeps black-on-white with a heavier border/weight as the stronger danger
  affordance; the four buttons wrap as their own group at narrow widths
  (stacked divider) instead of orphaning.
- Landing card vertically centered via auto margins (top-pin only for
  overflow); display type (`--font-display`, 30px) for the landing title;
  the landing create/edit forms use the single `field-label` token.
- Logo showing line moved adjacent to (below) the width/alignment controls.
- `.logo-row` wraps at editor-pane widths (base `flex-wrap`, not just the
  ≤ 520px query).
- Language: **Time → Duration** toggle label, sheet column heading
  (`sheet.ts` `INFO_COLUMNS`), and related copy (Rust/TS doc comments,
  `SKILL.md`, `status.md`, CSS comments); internal `cols-*-time` class
  names unchanged. Preview toolbar carries the one-line guidance
  "Print is the sharpest paper copy; Export saves a PDF/PNG file". The
  Unfiled library empty state carries the glossary "Unfiled means no
  artist yet — file these or pick an artist scope above."
- Out of scope as specced (stay open): undo, S/M/L sizing, vector PDF,
  mobile, SQLite.

### Scope

- Export menu right-anchored (`right: 0`) in the right-aligned toolbar.
- Icon-button rows (running-order, library, artist/landing rows) get
  ≥ 8px visual separation.
- Header grouping: scope selects visually separated from the
  New/Duplicate/Save/Delete group (grouping/divider + stronger danger
  affordance for Delete); the four buttons wrap as their own group at
  narrow widths instead of orphaning.
- Landing card vertically centered (keep top-pin only for overflow);
  display type for the landing title; one label token in the landing
  form.
- Logo showing line adjacent to the width/alignment controls.
- `.logo-row` wraps at editor-pane widths, not just ≤ 520px.
- Language: **Time → Duration** label consistency (toggle, column
  heading; internal `cols-*-time` class names unchanged); a one-line
  Print-vs-Export guidance note in the preview toolbar ("Print is the
  sharpest paper copy; Export saves a PDF/PNG file"); a one-sentence
  Unfiled glossary in the Unfiled empty state ("Unfiled means no artist
  yet — file these or pick an artist scope above.").

### Out of scope (stay open)

Undo for Delete/Restore (needs a design of its own), Small/Medium/Large
logo sizing instead of mm, selectable/vector PDF text, mobile, SQLite.

### Tests + QA

- `npm run build` clean; `cargo test` green (no Rust change expected).
- Manual QA: toolbar/menu placement at full and narrowed widths;
  header grouping/wrap; landing first-run impression; label
  consistency across form, toggles, sheet, and empty states.

### Build order

1. Menu anchor + spacing + header grouping/wrap + landing + logo rows.
2. Language labels + guidance/glossary lines + `SKILL.md`/status
   contract sync (Time → Duration wording everywhere it is pinned,
   internal `cols-*-time` class names unchanged).
3. QA + this file status + commit.

## Feature 27: Artist-creation logo reaches the setlist (bugfix) — Done (desktop QA pending)

Status: Done — code complete; the six desktop QA gates remain pending (no
desktop session in this environment). Small, builds on Features 14/20/23/29
(rebased onto the
per-setlist logo model). From user feedback:
a logo uploaded during artist creation does not show in the setlist afterwards —
the new setlist shows the placeholder and the Logo fieldset sticks on the
`No logo yet` path.

Context: the landing create form stages the upload in `landingLogoFile` /
transient-logo tracking, `save_artist` persists `logo.file_name`, then
`enterScope()` runs. The display resolves through `resolveSetlistLogo()` (own
file → artist file → none, `src/artists.ts`); width/alignment always come from
the setlist (Feature 29). Blob URLs feed the preview; export uses data URLs
(`logo.ts` / `exporter.ts`). Suspected cause per UX review: the record saves the
file name but the artists cache / thumbnail blob URL is not warmed and the
setlist preview is not re-resolved after scope entry — and `enterScope()` /
`switchScope()` skip `loadLogoForCurrent()` whenever the selected draft is dirty
(a brand-new setlist is always dirty), so the fieldset showing line and `<img>`
stay on the placeholder path.

### Shipped notes

- Root cause confirmed: `enterScope()` / `switchScope()` (and `init()` /
  `deleteCurrent()`) loaded the resolved logo only when the selected setlist was
  clean. A brand-new setlist is a dirty blank draft pre-assigned to the artist,
  so the artist image was never read and the preview stayed on the placeholder.
  Those four paths plus `startNewSetlist()`, restore, and the
  `File under…`/reselect path now await `loadLogoForCurrent()` whenever the
  backend is available; a blank draft shows its artist's image at the
  setlist's own default 40 mm / Center (Feature 29 geometry).
- Landing create warms the saved `file_name` in `artistThumbUrls` through a
  small `storedLogoUrl()` helper (revokes duplicates/failures) before
  `enterScope()`, so the artist thumbnail is ready when the landing card next
  renders. Landing inline Edit prunes the replaced/removed old thumbnail, warms
  the saved one, recomputes the showing line, and **awaits**
  `refreshLogoIfChanged()` before the final status/focus; rename, swap, and
  removal all update the current draft (own file → artist file → none) and the
  landing thumbnail.
- `refreshLogoIfChanged()` no longer delegates to `loadLogoForCurrent()`'s
  clear-first path. It bumps `logoRequestId`, reads the changed resolved file
  while the old blob URL stays on screen, then swaps and revokes the previous
  URL; no file (or no backend) clears normally, a local upload preview always
  wins, and a stale request revokes its own URL. A read failure clears to the
  truthful placeholder state and reports `Could not load logo: …` as before.
  Removing an own logo therefore falls back to the artist image without a
  placeholder flash; the local-preview case in `handleLogoRemove()` keeps the
  displayed image on screen until the swap instead of clearing first.
- Showing line content is unchanged: `“<Name>” logo (from the artist) — size
  applies to this setlist only.` with the setlist's width/alignment. There is no
  `save_artist` geometry write; export still reads `storedLogoDataUrl()` and the
  resolved file. Export capture, backup/restore, and artist-draft guards are
  untouched.
- Gates: `npm run build` and `cargo test` pass (no Rust/model/serde/storage/
  IPC/schema/backup/CSP/fs change). QA deviation: the six desktop gates
  (create→enter→New, removal fallback, geometry save/reload, placeholder copy,
  export/print logo, backup round trip) need a running `tauri dev` session and
  were not executed in this environment; the code paths were verified by
  inspection and are recorded as pending rather than passed.

Reviewed 2026-11-19: UX/UI designer, frontend developer, software architect
(Rust/Tauri reviewer trimmed — frontend/docs-only diff). Applied: Edit-save
focus restored only after the artist busy lock releases; in-flight logo reads
invalidated before the equality shortcut; local-preview removal now clears the
stale image (empty resolution checked first); Feature 30's Reset local-preview
handoff and old-file cleanup ordering pinned; superseded top-of-plan decisions
annotated. Waived/deferred: the six desktop QA gates (no desktop session), the
create→enter placeholder frame (one read, overlay covers most of it), refresh
errors being followed by a success status (pre-existing rare path), thumbnail
cache race on lazy vs warmed reads, and the pre-existing dirty prompt for an
untouched blank draft.

### Data model

None. No serde, storage, IPC, backup, or schema change. `Artist.logo` and the
shared `logos/` pool (`import_logo` / `remove_logo`) are unchanged.

### Behavior (must-fix per UX review)

- After `save_artist` from landing create **and** from the landing inline row
  Edit: reload the `artists` cache, revoke/recreate the thumbnail blob URL for
  the saved `file_name` (reuse the `pruneArtistThumbUrl` / landing-preview
  revoke pattern from Feature 25), and re-run `resolveSetlistLogo()` for the
  current draft plus landing thumbnails **before** `renderAll()`.
- `enterScope()` / `switchScope()` must await the logo load for the new scope
  (`loadLogoForCurrent()` / `refreshLogoIfChanged()` equivalent, same as the
  delete/duplicate paths) after the scope is set — **including dirty blank
  drafts** — never rely on the stale preview `<img>`. The same rule covers
  startup when no setlist is selected and `deleteCurrent()`'s blank draft.
- The Logo fieldset showing line plus width slider / alignment radios recompute
  from the resolved file and the setlist's per-setlist geometry (Feature 29:
  own → artist → none for the file; `setlist.logo` for width/alignment). The
  slider/radios always edit `setlist.logo`; there is no `save_artist` geometry
  path. Once the fix lands, the showing line must read
  `“<name>” logo (from the artist) — size applies to this setlist only.` with
  the setlist's matching width/alignment.
- Constraints intact: logos render only via `<img src>` (blob/data URLs, never
  inline SVG); no widening of `$APPDATA/stagesheet/**`; no CSP change; the
  preview-blob vs export-data-URL split (`storedLogoDataUrl()`) stays.

### Sheet + print

No structural change. Preview, frames, print, and export keep consuming the
resolved `LogoConfig` through the existing path (grayscale-forced in
print/export).

### Tests + QA (all six gate the fix)

1. Create artist with logo → enter scope → New setlist shows the **artist logo**
   at the setlist's default 40 mm / Center; the showing line reads
   `“<name>” logo (from the artist) — size applies to this setlist only.`
   with matching width/alignment.
2. In-scope setlist: upload an own logo → keeps the displayed geometry;
   remove it → falls back to the artist logo automatically, no placeholder
   flash after reload.
3. Width slider + alignment radios on the artist-image path persist through the
   setlist Save (dirty + reload keeps them) and never write the artist record;
   the artist's stored geometry stays unchanged.
4. Placeholder path unchanged: artist with no logo + setlist with no logo →
   `No logo yet — add an image above, or add one to “<Name>” and it will appear
   here.`; the slider pre-sizes the next own logo.
5. Export (PDF/PNG) and `window.print()` from the new setlist include the logo,
   grayscale-forced, with no CSP console errors and no blob-URL fetch.
6. Backup on the same device round-trips `file_name`/width/alignment; a
   new-device restore shows the placeholder + re-import prompt (v1
   logos-not-embedded rule — not fixed here).

### Out of scope

Embedding logo bytes in the backup envelope (future schema version), any
export/print layout change, any new token or styling.

### Build order

1. Cache warm + re-resolve on artist save and scope entry + showing-line
   recompute.
2. QA (six gates) + `SKILL.md` note if the resolution path changes + this file
   status + commit.

## Feature 28: Opt-in library ⇄ setlist song sync (per-edit offer) — Done (desktop QA pending)

Status: Done (desktop QA pending), medium, builds on Features 12/14/20/25 and
Feature 27's
re-resolve. From user feedback: editing a song in the Song Library or in a
setlist should offer to apply the same change to the other copy, and accepting
should refresh the setlist preview automatically.

This **reverses the Feature 12 locked "no propagation" decision into opt-in
per-edit propagation**: the copy semantics stay (gig snapshots may diverge on
purpose — capo, shortened version, key), but each explicit save with a matching
opposite copy asks once. There is deliberately no silent sync, no global
toggle, and no per-song "always sync" flag. UX-reviewed (custom modal, safe
default, guard matrix, wording) — the must-fix items below are part of the
spec, not guidance.

### Shipped notes

- Trigger boundary: library→setlist starts only after `api.saveSong` succeeds
  and the cache/sort/render update. Setlist→library is offered only from an
  explicit setlist Save (`#save-setlist` or the setlist Ctrl/Cmd+S path) after
  the saved-runtime status; field changes alone never open a modal, and Print,
  Duplicate, Back up, File under…, and auto-saves never offer.
- Field-level setlist copy: after the explicit save, each unique changed
  `Song.id` compares the saved item against the pre-save cached item (or the
  library song for a new setlist/item). Only `title`, `bpm`, `key`, `tuning`,
  `duration_secs`, and `notes` count; artist text/`artist_id` are ignored, so an
  artist-only change never offers. One modal per changed song runs sequentially;
  accept copies only the effective changed fields onto the filed library song
  and keeps the library's `artist` snapshot and `artist_id`. The body is neutral
  (the library copy is different) rather than claiming the library is old.
- Matching/scope: `Song.id` equality only, resolved through
  `resolveArtistForSong()`/`songInScope()` for the active artist. Unfiled and
  other artists never offer; setlist→library also requires the library song to
  be filed (`findArtistById` on its artist id), excluding legacy-text/unfiled/
  dangling records. Library→setlist lists up to 3 differing saved setlist
  titles with `, +K more`; the dirty `current` setlist is excluded and reported,
  a clean `current` is written.
- Modal: one reusable `showChoiceDialog` in `main.ts` (`role="dialog"`,
  `aria-modal="true"`, heading/body ids, exactly two always-enabled buttons),
  appended to `document.body`; header/main and a visible landing overlay are
  inert and restored through `syncLandingInert()` on close. Initial focus is
  **Keep**; Enter/Escape keep unless the user has explicitly Tabbed to Update,
  where the focused button activates (Escape always keeps); Tab is trapped
  between the buttons, and a pending dialog counts as unsaved work.
  `renderLanding()` does not steal focus while a choice dialog is open. A
  caller-supplied focus restore lands on the saved row's **Edit** button or the
  edited item summary; accept re-renders through `renderAll()` + logo refresh +
  `renderSheet()`.
- Guards/writes/reporting: the guard matrix is implemented (`exporting`,
  backup/restore/delete, other library writes, artist/landing busy/logo busy,
  hidden-by-filter, open library editor). Library→setlist failures use
  `Open the library song and save it again, then choose Update.` and dirty
  targets keep `Skipped “<Setlist>”: unsaved changes.` A target whose cache
  object/`updated_at` changed during the accepted batch is skipped as
  `Skipped “<Setlist>”: changed while updating.` Both accepted phases set a
  `propagationBusy` lock: `syncCaptureLock()`, `itemList` inert, print/export
  unavailable, and save/delete/duplicate/New/scope-switch/print/export/File
  under…/library Add and editor/backup-restore guards refuse with
  `Updating setlist copies — wait for it to finish.` Final focus is restored
  only while focus is still page-lost, so a deliberate move to search or
  another row wins. Setlist→library accept writes only the changed data fields
  through `api.saveSong` without `allowUnfiled`.
- QA: no Rust/model/serde/storage/IPC/schema/backup/CSP/fs change.
  `npm run build` and `npm run test:rust` pass. The desktop manual QA list
  (explicit-Save trigger, field-level copy, filed-only matching, keyboard/focus,
  multi-target naming, guard matrix, backup round trip) is pending because this
  environment has no desktop session.

Reviewed 2026-11-19: UX/UI designer, frontend developer, software architect, end-user (Rust/Tauri trimmed — frontend/docs-only diff). Applied: explicit-Save trigger; field-level six-field copy; filed-library-only matching; neutral setlist→library body; safe retry text; `propagationBusy` accepted-write lock with stale-target re-checks and gated focus; dialog/inert/focus hardening; docs and QA-pending status. Waived/deferred: desktop manual QA (no desktop session), per-setlist picker/apply-to-all, and cross-artist propagation.

### Data model

None. All writes go through the existing `save_song` / `save_setlist`
validation (including the Feature 20 mandatory-`artist_id` check).
`allowUnfiled` is **not** used for propagation writes (only the three
`SKILL.md` paths); the filed-only matching rule keeps normal targets
artist-valid, and any validation failure aborts with its error message. No
serde, storage, IPC, envelope, or schema change.

### Matching + scope rules (locked)

- Match key is `Song.id` equality only — never title/artist-text fallback.
  Duplicated setlists that deep-copied snapshots keep ids, so they match by
  design and must be named in the dialog. Dangling/legacy-text rows are
  excluded (same rule as the landing assign offer).
- Only candidates **in the active artist scope** are counted/offered/written.
  Unfiled records never auto-match; cross-artist propagation is out of scope
  ("switch scope and re-edit" instead of a cross-artist write).
- Multiple targets: one modal lists up to 3 setlist names via the existing
  `summarizeRecords(records, 3)` pattern, then `+K more`. Accepting writes
  each target through the normal commands with per-target reporting, never
  partial-silent: `Updated 2 of 3 — “<Setlist>” failed: <error>. Open the
  library song and save it again, then choose Update.` A target whose cache
  object/`updated_at` changes during the accepted batch is skipped as
  `Skipped “<Setlist>”: changed while updating.`
- Dirty-target policy: a target setlist with unsaved changes is skipped and
  reported per target (`Skipped “<Setlist>”: unsaved changes.`); the primary
  save still succeeds.

### UI — custom modal, safe default, exact wording

- A small `role="dialog" aria-modal="true"` modal reusing the landing-overlay
  dialog tokens (no new color/radius/shadow values; motion limited to
  open/close opacity/transform with a `prefers-reduced-motion` bypass; no
  sheet/print CSS change). **Not** `window.confirm`: button order/labels are
  platform-dependent and cannot carry the direction + count + names + gig
  risk content. Background `inert` while open; two buttons only, 44px
  min-height, visible `:focus-visible` outline, both always enabled once shown.
- **Safe default**: initial focus on **Keep**; Enter/Escape keep unless the
  user has explicitly Tabbed to Update, where the focused button activates
  (Escape always keeps). No auto-focus on Update. No "don't ask
  again" checkbox — the dialog asks **every time** a matching in-scope
  opposite copy exists. A per-setlist picker or "apply to all listed" split is
  a follow-up, still per-edit, never persisted.
- Strings (adjust only quoted names/counts):

  **Library → setlist** (after the library save succeeds, before any snapshot
  write):
  - Heading: `Update N setlist copies?`
  - Body: `You changed “<song title>”. N setlists in <Artist> still have the
    old gig copy: <Setlist A>, <Setlist B>[, +K more]. Setlist copies are gig
    snapshots — they may have a different key, capo, or shortened notes on
    purpose.`
  - Buttons: `[Keep setlist copies]` (default, focused) / `[Update N copies]`
  - Accept status (success): `Updated “<title>” in N setlists. Gig edits there
    were overwritten.`
  - Decline status (info): `Kept N setlist copies unchanged. Library “<title>”
    saved.`

  **Setlist-item → library** (after an explicit setlist Save, before the
  library write):
  - Heading: `Update the library song too?`
  - Body: `You changed “<title>” in “<Setlist title>”. The library copy is
    different. Updating replaces its <field list> with this setlist's copy and
    changes every future setlist that adds this song.` The field list names
    only the changed data fields (title, BPM, key, tuning, duration, comment);
    artist text/`artist_id` never count.
  - Buttons: `[Keep library unchanged]` (default) / `[Update library]`
  - Accept: `Updated library “<title>”. Future setlists will use the new
    version.`
  - Decline: `Kept library “<title>” unchanged. Only “<Setlist title>” uses
    the new version.`

### Guards + focus (must-fix)

- Setlist→library offers fire only after an explicit setlist Save; the saved
  runtime status is set first. Field-only changes, Print, Duplicate, Back up,
  File under…, and all auto-saves never offer. The offer **never appears** and
  follow-up writes **never run** while any of these hold; the save succeeds and
  the status explains the deferral:
  - export capture in flight (`captureGuard()`) → `Export in progress —
    “<title>” saved here only. Re-apply the change after export if needed.`
  - `backingUp` / `restoring` / `artistDeleting`, `libraryWritesInFlight > 0`,
    `artistBusy` / `landingBusy`, or `artistLogoBusy` / `landingLogoBusy` →
    `"..." saved here only. Finish the current library/artist request, then
    re-edit to propagate.`
  - Setlist→library direction blocked while any library inline editor is open
    (including `retryPending` / `hiddenByFilter` / invalid fields); its status
    names saving/cancelling that draft, then re-editing the item. The
    scope-switch dirty guard (`confirmDiscard`) takes precedence: never stack
    the propagation modal on a discard confirm (order: save → propagation
    modal → scope switch allowed). A pending propagation modal counts as
    unsaved work for `beforeunload` (closing = Keep).
- Accepted writes hold a `propagationBusy` lock until all cache/render/focus
  work finishes: `syncCaptureLock()` locks the header/meta/logo/sheet options
  and page mode, `itemList` is inert, print/export are unavailable, and
  save/delete/duplicate/New/scope-switch/print/export/File under…/library Add
  and editor/backup-restore refuse with
  `Updating setlist copies — wait for it to finish.` Each library→setlist target
  is re-read from the cache immediately before its write; a gone or changed
  cache object is reported as `Skipped “<Setlist>”: changed while updating.`
  and never resurrected. The cache entry is only replaced while it is still the
  planned object; a clean `current` is only replaced when its id and planned
  version still match. Final focus is restored only while focus is still
  page-lost, never after a deliberate move to search/another row.
- Trigger only from a visible, committed save (editor closed on success). If
  the edited row is `hiddenByFilter` at save time, do **not** pop the modal:
  `Saved “<title>” here only — clear search to review other copies.`
- Focus: on open move focus to the default Keep button; trap Tab. Enter/Escape
  keep unless the user has explicitly Tabbed to Update, where the focused
  button activates (Escape always keeps). On close (either choice) return focus
  to the originating Save/Edit control or the setlist item summary and announce
  via `setStatus()`. After accept, re-render through the same path
  (`renderAll()` + logo refresh + `sheet.ts`) so preview/print/export agree —
  the "auto reload into the setlist preview" is that re-render, not a scope
  reload — and never leave focus inside a re-rendered-away node.

### Sheet + print

No structural change. The accepted write re-renders the preview/frames
through `sheet.ts`; export raster warm-up needs no change (per-session warm-up
stands).

### Tests + QA

- `npm run build` clean; `cargo test` green (no Rust change expected).
- Manual QA: library→setlist accept (all in-scope copies update, preview
  refreshes, accept status); library→setlist decline (copies byte-identical,
  decline status); setlist→library offers only after explicit Save (not after
  Print/Duplicate/Back up/File under…/blur), field-level copy preserves artist
  identity, sequential multi-song offers, neutral body wording; multi-setlist
  naming + `+K more`; per-target failure, dirty-target skip, and
  changed-while-updating skip reporting; each guard deferral message above;
  propagationBusy lock disables the editor and refuses save/delete/duplicate/
  new/scope/print/export/File under…/library/backup, with focus not yanked when
  the user moves to search; hidden-by-filter save never pops the modal; focus
  open/trap/return + Enter/Escape safe default; 44px targets + visible focus at
  full and narrowed widths; keyboard-only pass; backup/restore round trip with
  diverged copies keeps the divergence; Unfiled, cross-artist, and
  legacy/unfiled/dangling library songs never offer.

### Out of scope (stay open)

Global/per-song auto-sync toggles, bulk "sync all songs" tool, cross-artist
propagation, moving songs between artists, legacy-text fuzzy matching, changing
the Feature 12 default to auto-sync, export/print layout changes.

### Build order

1. Explicit-Save trigger + field-level match/copy + filed-library rule + custom
   modal + safe-default focus + strings + guard matrix + propagationBusy lock +
   per-target writes/reporting + preview re-render.
2. QA + `SKILL.md` (Feature 12 copy-semantics note becomes opt-in offer) +
   this file status + commit.

## Feature 29: Per-setlist logo size (no shared artist size) — Done

Status: Done, medium, builds on Features 19/25 and narrows Feature 27.
From user feedback: logo size has no merit in the artists section — it differs
per setlist. The artist record keeps the logo *image* (autoloads into its
setlists when set); width and alignment become per-setlist display settings
edited only in the setlist editor. UX-reviewed — the must-fix items below are
part of the spec.

Locked scope: **both** width **and** alignment go per-setlist (splitting only
width would keep the shared-mutation surprise on the radios). Geometry always
comes from `setlist.logo.width_mm` / `setlist.logo.alignment`; only the
*file* resolves (own → artist → none). No "default size for new setlists" on
the artist — new setlists keep the existing 40 mm / Center default.

### Shipped notes

- Artist records keep only the logo **image**. Landing create saves
  `width_mm: 40` / `alignment: "Center"`; inline Edit preserves the record's
  stored geometry untouched but exposes no controls. Both forms show name +
  upload + remove + preview only (no disabled size slider). Artist
  width/alignment stay serialized and validated yet are render-dead.
- `resolveSetlistLogo()` resolves only the file (own → artist → none) and
  pairs it with `setlist.logo`'s width/alignment. The setlist Logo slider
  `input` and alignment radio `change` always write the draft (clamped
  10–80), `markDirty()`, and `renderSheet()` — all three logo cases
  identically. Logo geometry now dirties the setlist like any other edit
  (`confirmDiscard` covers scope switches); no per-tick status is emitted.
  `commitEffectiveArtistLogo*`, `effectiveLogoSaving`, the artist
  case branches, revert closures, artist-draft/backup/import refusals, and
  every "applies to every setlist" string are deleted. `captureGuard()` still
  guards slider/radios/upload/remove and reverts through
  `renderLogoControls()`; `syncCaptureLock(false)` re-renders the Remove
  state after unlocking.
- Upload-own-logo geometry adoption is gone (the geometry already is the
  displayed geometry); preview-local → `importLogo` → `file_name` →
  `markDirty()` + sheet + `Logo imported.` stays, including the failed-import
  fallback. Remove keeps `pendingLogoRemovals` + `markDirty()` +
  `refreshLogoIfChanged()` and the per-setlist size survives. Removing moves
  focus to the upload control instead of letting the now-disabled button drop
  focus to `<body>`. The landing create form also has a **Remove logo** control
  (staged file deleted immediately because no record references it yet).
- Showing line: `Setlist logo — size applies to this setlist only.`;
  `“<Name>” logo (from the artist) — size applies to this setlist only.`;
  `No logo yet — add an image above, or add one to “<Name>” and it will appear
  here.` (live artist without a logo); `No logo yet — add an image above.`
  (no live artist, dangling id, or Unfiled). `role="note"`, never live.
- Migration is one silent first-startup pass after the caches are adopted,
  skipped when the backend is unavailable: for each setlist with no own logo
  whose live artist has a logo, copy the artist's clamped width/alignment into
  the setlist and persist through normal `save_setlist` — but only while the
  stored geometry is still exactly 40 mm / Center. A UI-level localStorage
  guard (`stagesheet.logoGeometryMigrated`) records the completed pass and the
  ids whose save failed; later starts retry only those ids, never the whole
  pass. It is not a model/schema/backup flag; no schema bump or status message.
  Interpretation pinned: a **pre-upgrade** setlist deliberately left at
  40/Center while its artist uses another size adopts the artist size once on
  the first start (display geometry only, then stable). On that device while
  the key exists, new setlists, later resets to 40/Center, duplicates, and
  restored 40/Center records keep 40 mm / Center.
- Backup/restore draft guard is exactly "edit mode, typed name, or staged
  logo"; the artist width/alignment checks are dropped.
- Feature 27 interplay: 27 keeps its cache-warm/re-resolve half and all six QA
  gates; gate 3 is rebased onto per-setlist geometry (Save + reload, no
  `save_artist` geometry write). Feature 28 unchanged.
- Gates: `npm run build` and `cargo test` pass; no Rust/model/serde/IPC/
  storage/schema/backup-envelope, CSP, or fs-capability change.

Reviewed 2026-11-19: UX/UI designer, frontend developer, software architect
(Rust/Tauri reviewer trimmed — frontend/docs-only diff). Applied: startup gate
before adoption/migration and event binding after it, one-time localStorage
migration guard with failed-id retries, create-form **Remove logo**, focus
handoff after setlist Remove, slider/radiogroup `aria-describedby`, showing-line
wrap, and the Feature 27/30 spec rebases/cleanup ordering. Waived: extra
no-logo hint (pinned strings only), legacy out-of-range geometry clamping
(save-only validation policy), first-launch setlist picker reorder (normal
`updated_at` bump), and an artist-form "size moved" hint (forms stay minimal).

### Data model

No new field, no schema bump, backup v1 envelope unchanged. `LogoConfig`
struct, `Artist.logo` validation (10–80, plain name), `normalizeLogo`, and the
`remove_logo` reference check are unchanged (`artist.file_name` still pins the
file). `Artist.logo.width_mm` / `alignment` stay serialized but become
render-dead (documented in `SKILL.md` at implementation; a future schema may
retire them — explicitly not this slice).

Migration (deterministic, idempotent, no schema/model marker — pin verbatim):
`On first load after upgrade, for each setlist with no own logo whose artist
has a logo: if the setlist's stored width/alignment are still the default
(40 mm / Center), copy the artist's current width/alignment (clamped 10–80)
into the setlist's display config; otherwise keep the setlist's stored values.
Never copy again afterwards.` The one-time guard is a UI-level localStorage key,
not a field in `Setlist`/`Artist` or the backup envelope. A pre-upgrade setlist
whose user deliberately chose 40/Center accepting the artist copy is harmless
and stable after that single pass. Same-device backup round trips keep
per-setlist sizes; new-device restore still shows the placeholder until
re-import (v1 rule intact).

### UI

- Landing create + inline row Edit forms: keep name + logo upload + remove +
  thumbnail only. Delete both width sliders and both alignment groups (no
  disabled "preview size" slider — a disabled slider implies future function).
- Setlist Logo fieldset: slider `input` and radio `change` **always** write
  `current.logo.width_mm` / `current.logo.alignment` (clamped 10–80), then
  `markDirty()` + `renderSheet()` — all three logo cases identically. Delete
  `commitEffectiveArtistLogo*` and the `effectiveLogoCase() === "artist"`
  branches. Upload-own-logo width/alignment adoption becomes a no-op by
  construction (geometry already is the displayed geometry) — delete it; keep
  the preview-local → `importLogo` → `file_name` assign → `markDirty` + status
  flow. Remove-own-logo keeps the `pendingLogoRemovals` + `markDirty()` +
  `refreshLogoIfChanged()` flow; the per-setlist size survives trivially.
  Artist image swap later preserves per-setlist sizes; require
  `refreshLogoIfChanged()` + `renderSheet()` + showing-line recompute on
  artist `file_name` change (the surviving half of Feature 27).
- Showing line (exact strings, adjust only quoted names):
  - Own logo: `Setlist logo — size applies to this setlist only.`
  - Artist image: `“<Name>” logo (from the artist) — size applies to this
    setlist only.` ("from the artist" states provenance without implying a
    live size link; never "linked"/"synced"/"connected".)
  - None, artist in scope but artist has no logo: `No logo yet — add an image
    above, or add one to “<Name>” and it will appear here.`
  - None, unfiled / no artist: `No logo yet — add an image above.`
- Guards: delete from the Logo path `effectiveLogoSaving`/`artistBusy`,
  `artistLogoBusy`, backup/restore refusals, the artist-draft-open refusal,
  revert closures, and every `applies to every setlist` string. Keep
  `captureGuard()` on slider/radios/upload/remove (revert via
  `renderLogoControls()`), the dirty indicator + scope-switch `confirmDiscard`
  (logo edits now count as dirty — call it out), the `saveCurrent` failure
  path (draft + values intact), and backend-unavailable handling. Slider/radio
  produce no per-tick status (only `output` text + sheet update); save uses the
  existing setlist-saved message; remove keeps `Logo removed — save to
  apply.`; import keeps `Logo imported.` Shrink the backup/restore draft-guard
  copy to "edit mode, typed name, or staged logo" (drop "or any
  width/alignment change") for both edit and create guards.
- Accessibility: slider + radios **always enabled** whenever a setlist draft is
  open (including none-case — it sizes the future logo); only the export
  capture temporarily reverts. Keep native `fieldset`/`legend`, `label
  for="logo-width"` + `output`, native range + radios (no custom slider);
  slider `input` updates `output` only (not live); announce via `setStatus()`
  only on import/remove/save/guard refusal; showing line stays `role="note"`,
  never live. No focus moves on slider/radio edits; upload/remove keep focus
  on the invoking control. Keep 44px minimums; confirm `.logo-row` wraps so
  nothing clips at narrow widths / 200% zoom. No new tokens; no sheet/print
  CSS change; grayscale print/export untouched.
- Interplay: land before or rebase Feature 27 onto this — 27 keeps its
  cache-warm/re-resolve and QA gates 1–2/4–6, drops its item-3 `save_artist`
  assertion in favor of the QA below. Feature 28 unchanged.

### Sheet + print

None. Preview, frames, print, and export consume the per-setlist geometry
through the existing resolved-config path.

### Tests + QA

- `npm run build` clean; `cargo test` green (Rust validation-only; no new
  bounds expected).
- Manual QA (all gate the slice): two setlists of one artist diverge in
  width/alignment independently; new setlist autoloads the artist image at
  40 mm / Center; swapping the artist image preserves per-setlist sizes;
  upload-own-logo seamless (geometry unchanged) and remove falls back to the
  artist image at the setlist's own size; reload persists; dirty indicator +
  scope-switch guard fire on logo-size edits; export PDF/PNG + `window.print()`
  grayscale-correct with no CSP errors; backup round trip keeps per-setlist
  sizes; landing artist forms show no width/alignment controls.

### Out of scope (stay open)

S/M/L sizing, vector/selectable PDF, logo bytes in backups, bulk resize tool,
moving songs between artists, export/print layout changes.

### Build order

1. Per-setlist geometry + artist-form control removal + showing-line/guards/
   statuses + migration rule + `SKILL.md` render-dead note.
2. QA + this file status (incl. Feature 27 interplay note) + commit.

## Feature 30: Artist-logo propagation offer + reset to artist logo — Todo

Status: Todo, medium, builds on Features 27/28/29. Land **after** 29 (and the
rebased 27 cache-warm half). From user feedback: changing the artist's logo
image must not silently rewrite setlists; the setlist side stays silent-local;
and a reset button restores the artist image after a delete or divergence.
UX-reviewed — the must-fix items below are the spec (verdict: not writable
without them).

Locked model (c) — reject (a)/(b): the artist image is **live** unless a
setlist carries its own logo. **Accept/follow = zero `save_setlist` writes**
(only `save_artist`; followers resolve to the new file or placeholder
automatically). **Keep = pin**: for each affected setlist set
`setlist.logo.file_name = <old artist file_name>`, keep its own
`width_mm`/`alignment` (Feature 29), `save_setlist` per target — display
pixels literally unchanged. Rejected: (a) Accept-copies-new-file-as-own (every
follower becomes pinned, so the *next* swap silently stops propagating); (b)
keep-following flag (new boolean + serde/backup/migration for zero benefit —
following is the default, pinning is already an own logo). Backup/restore and
`remove_logo` stay safe (plain `file_name` values; backend skips deletion while
referenced). No model/schema change; geometry stays per-setlist; artist
width/alignment stay render-dead.

Affected setlists (pin verbatim):
`Affected = setlists where setlist.artist_id == <edited artist id> AND
setlist.logo.file_name is None AND pre-save artist.logo.file_name is non-null
(there is an old image to preserve/lose).` Never counted/offered/written:
setlists with their own logo (every body string confirms they are untouched),
other artists' setlists, Unfiled/dangling-id setlists, placeholder setlists
when the artist had no logo. **Addition** (`None` → new file): no modal (new
image where placeholder was is non-destructive) — silent success + status.
Only change or removal of a non-null old file can trigger the modal. List up to
3 names via `summarizeRecords(records, 3)` + `+K more`; no per-setlist picker.
Fires from both landing create-form Save and inline-row Edit Save (same
`save_artist` image path); artist-save failure/backend-unavailable → error
status only, no modal, nothing snapshotted. Decline-snapshot failures continue
per target with per-target reporting (same as Feature 28). The open setlist
draft counts as a dirty-target skip with no exemption.

**Cleanup ordering (must-fix)**: the current landing save path calls
`remove_logo` on the replaced `originalLogo` immediately after `save_artist`
returns. Feature 30's Keep choice pins that same old file onto affected
setlists *after* the save, so the early cleanup would delete it first and every
pin would point at a missing file. Defer the replaced/removed artist file's
`remove_logo` call (and thumbnail prune) until the follow-vs-pin choice has
completed: Follow/Removal may then remove it (the backend still skips any file
a setlist or artist references), Keep pins first so the reference check keeps
it. A failed pin write must leave the old file in place and be reported per
target; never delete it speculatively.

### UI — reuse the Feature 28 modal pattern exactly

One `role="dialog" aria-modal="true"` modal, background `inert`,
landing-overlay dialog tokens only, 44px buttons, visible `:focus-visible`,
motion limited to open/close opacity/transform with `prefers-reduced-motion`
bypass. Two buttons only, both always enabled once shown. No "don't ask again".
Per-edit only. Initial focus on **Keep**; Enter/Escape keep unless the user has
explicitly Tabbed to Use/Remove, where the focused button activates (Escape
always keeps; the destructive path here is *following*). No backdrop close (or
backdrop close = Keep). A pending modal counts as unsaved work for
`beforeunload` (closing = Keep).

Strings (adjust only quoted names/counts; one verb per action: Keep vs
Use/Remove):

**Change** (old file → new file, N affected):
- Heading: `Use the new logo on N setlists?`
- Body: `You changed the logo for “<Artist>”. N setlists still show the old
  artist image: <A>, <B>[, +K more]. Setlists with their own logo are not
  affected. New setlists for “<Artist>” will use the new logo either way.`
- Buttons: `[Keep old image on N setlists]` (default, focused) /
  `[Use new logo]`
- Follow: `Updated the logo for “<Artist>”. N setlists now show the new logo.`
- Keep: `Kept the old image on N setlists as their own logo. “<Artist>” uses
  the new logo.`

**Removal** (old file → none, N affected):
- Heading: `Remove the logo from N setlists too?`
- Body: `You removed the logo for “<Artist>”. N setlists still show the old
  image: <A>, <B>[, +K more]. Setlists with their own logo are not affected.
  Removing continues — those setlists will show “No logo yet”. Keeping
  preserves the old image on those setlists as their own logo.`
- Buttons: `[Keep old image on N setlists]` (default, focused) /
  `[Remove from N setlists]`
- Follow: `Removed the logo for “<Artist>”. N setlists now show “No logo
  yet”.`
- Keep: `Kept the old image on N setlists as their own logo. “<Artist>” has
  no logo.`

**Addition / zero affected**: no modal — `Updated the logo for “<Artist>”. N
setlists now show it.` / `Updated the logo for “<Artist>”.` / `Removed the
logo for “<Artist>”.` as applicable. Per-target: `Updated 2 of 3 —
“<Setlist>” failed: <error>. Re-edit the artist logo and choose Keep again.`
and `Skipped “<Setlist>”: unsaved changes.` (per-target pattern shared with
Feature 28).

Guards (modal **never** appears, follow-up writes **never** run; artist save
succeeds + status defers): export capture (`Export in progress — “<Artist>”
saved here only. Re-apply the logo choice after export if needed.`);
`backingUp`/`restoring`/`artistDeleting`, `libraryWritesInFlight > 0`,
`artistBusy`/`landingBusy`, `artistLogoBusy`/`landingLogoBusy` (`“<Artist>”
saved here only. Finish the current library/artist request, then re-edit to
choose setlists.`); Unfiled/no-affected/addition (silent success); landing
create-vs-edit colocation refusals (never queue a modal behind them).
Dirty targets skip-and-report; never auto-save a dirty setlist to force a pin.

Setlist side stays silent-local (locked): upload-own / Remove writes only
`setlist.logo.file_name` on the open draft (dirty + Save), already guarded by
dirty/`confirmDiscard`/scope-switch plus the import/remove statuses — no
cross-record blast radius, no modal. Keep `Logo imported.`, `Logo removed —
save to apply.`, no per-tick geometry statuses.

**Reset to artist logo** button (all five pinned): label `Reset to artist
logo` (reject `Use artist logo`); placed in the Logo `fieldset` next to Remove
(`[Upload…] [Remove] [Reset to artist logo]`, same `.logo-row` wrap, 44px);
native `disabled` (not `aria-disabled`) iff `setlist.logo.file_name != null AND
artist.logo.file_name != null AND setlist.logo.file_name !=
artist.logo.file_name` — disabled when already following, when no own logo to
clear, or when the artist has no logo. Adjacent visible hint (never
`title`-only): artist without logo → `No artist logo — add one to “<Name>”
and it will appear here.`; already following → the Feature 29 showing line.
Behavior: clears `setlist.logo.file_name` only (cancels any
`pendingLogoRemovals` entry for the abandoned own file — never deletes a file
still referenced elsewhere); never touches `width_mm`/`alignment`; `markDirty()`
+ `refreshLogoIfChanged()` + `renderSheet()` + showing-line recompute; Save
persists. Like Remove, stop a local upload preview from winning before the
refresh (`logoPreviewIsLocal = false; loadedLogoFileName = null`) so the
artist image actually swaps in. Focus stays on Reset while it remains enabled; once a successful
Reset disables it (no own logo left), move focus to the upload control like
Feature 29's Remove rule instead of dropping focus to `<body>`.
`Artist logo restored — save to apply.` then
the saved message. Slider/radios stay always-enabled; `captureGuard()` reverts
Reset during export. Native `<button type="button">`; showing line stays
`role="note"`, announcements via `setStatus()` only.

Focus/live-region: on open focus the heading (`tabindex="-1"`) or Keep;
trap Tab; on close return focus to the originating artist Save/Edit control;
`setStatus()` polite announcements only; trigger only from a visible committed
artist save; re-render via `renderAll()` + logo refresh + `sheet.ts`, never
leaving focus in a re-rendered-away node.

### Sheet + print

None. Follow/keep/reset flow through the existing resolved-config path;
grayscale print/export untouched.

### Tests + QA

- `npm run build` clean; `cargo test` green (no Rust change expected).
- Manual QA (all gate): change + Keep (old pixels preserved at per-setlist
  sizes, own-logo file set, reload stable) vs Use-new (new image, sizes
  preserved) with pinned statuses; removal Remove-from-N (`No logo yet` at own
  sizes) vs Keep (old image as own logo); own-logo setlists byte-identical in
  both paths; other-artist/Unfiled never offered; setlist-side upload/Remove
  silent (no modal, dirty + save, statuses unchanged); Reset after Keep, after
  Remove-own, and no-artist-logo disabled + hint (focus stays, save persists,
  sizes survive, 44px + keyboard-only at full/narrow widths and 200% zoom);
  reload persistence; export PDF/PNG + print grayscale with no CSP/blob
  errors; same-device backup keeps follow-vs-pin; new-device restore shows
  placeholder + re-import prompt (v1 rule).

### Out of scope (stay open)

Per-setlist subset picker, "don't ask again" / global auto-sync, cross-artist
propagation, geometry changes, logo bytes in backups, export/print layout,
new dialog tokens, model/schema changes.

### Build order

1. Follow-vs-pin writes + modal + strings + guards + Reset button + hint.
2. QA + `SKILL.md` (resolve-vs-pin rule) + this file status + commit.

## Roadmap backlog (prioritized)

- **P0 — Sheet correctness fixes (from real use)**: Features 10 (column widths
  rebalance + header alignment) and 11 (paginated preview/print frames) are
  done. The sheet is the product; new tooling stays behind these.
- **P0 — PNG/PDF export + print**: Feature 6 done. Physical-paper QA and
  cross-engine checks remain in Phase 6.
- **P0 — Overflow tooling for the single-A4 cap**: Feature 5 shipped
  (multi-page mode + sub-70% legibility nudge). Feature 13 shipped setlist
  duplication as a preset base; the remaining slice stays open: a
  split-setlist helper (move second half to a new setlist) as an alternative to
  multi-page.
- **P1 — Library/setlist tooling**: Features 12 (edit library songs), 13
  (duplicate setlist as preset base), 14 (artist records + logos), 15 (library
  artist filter), 16 (setlist artist + per-artist picker + lock), 17 (break
  seconds), and 18 (delete clarity) are Done. Setlist duplication copies
  `Setlist.artist_id` and shares the logo file.
- **P1 — Artist-first mode + logo width control**: Features 19 (effective
  logo width control), 20 (landing page + per-artist scoping with
  `artist_id` mandatory on save), and 21 (print/export toolbar
  consolidation) are Done.
- **P1 — v0.3.1 slice**: Feature 22 (Duplicate beside New before Save — Done),
  Feature 23 (artist management on the landing screen, out of the
  library pane — Done), Feature 24 (Backup & Restore on the landing screen,
  incl. restore-before-scope — Done), Feature 25 (v0.3.0 review hardening:
  export/scope locks, alignment binding, dangling-id resolver, unfiled
  guidance, backend small items — Done), and Feature 26 (UI polish + language
  pass — Done). The split-setlist helper stays open behind these.
- **P1 — v0.3.2 slice (In progress)**: Feature 27 (artist-creation logo
  reaches the setlist — bugfix, rebased onto 29 — Done, desktop QA pending),
  Feature 28 (opt-in
  library ⇄ setlist song sync offer with safe-default custom modal — Done
  (desktop QA pending)), Feature 29
  (per-setlist logo size — artist keeps the image, geometry lives on the
  setlist — Done), and Feature 30 (artist-logo propagation offer with
  Keep-vs-follow + Reset to artist logo; setlist side stays silent-local). The
  split-setlist helper stays open behind these.
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
