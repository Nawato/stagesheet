# Status: implemented vs. missing

Tracked against the in-repo plans:
[`plans/development-plan.md`](plans/development-plan.md) (phases, QA
strategy, risks) and [`plans/upcoming-features.md`](plans/upcoming-features.md)
(feature specs and backlog). Keep them — and this list — in sync in the same
commit as each change.

## Currently implemented

- Tauri v2 desktop app with the `lib.rs` / `main.rs` split needed for mobile targets.
- Corrected data models including key, free-text tuning, logo alignment enum,
  `NaiveDate`, and created/updated timestamps, with migration-friendly serde
  defaults and aliases.
- JSON storage + capability scoping + the full command list in the README.
- Song library with instant search (title, resolved artist, key, tuning),
  view-only sort by title/resolved artist/key/tuning, and a "Has tuning"
  filter that combine with the active artist scope. The library shows only the
  scope's songs (resolved identity), and the badge counts the scope — totals
  live on the landing page. One-click add (auto-assigned to the scope artist),
  inline row editing with the add form's validation and field limits (stable
  id, re-sorted and re-rendered after save, owning artist read-only in a scope
  and filed through the dropdown only in the Unfiled scope), per-row duplicate
  under a new id, and delete with confirmation. Free-text tuning (max 24 chars)
  is part of search, the add form, the library editor, and each setlist song's
  editor details.
- Managed artist records (name + logo) with logo
  thumbnails, resolved song counts, an inline create/edit form for the name plus
  logo upload/remove/preview on the landing screen (no size controls — width and
  alignment are per-setlist), and confirmed delete. Songs reference artists by id while
  keeping a name snapshot; renaming updates display without rewriting songs or
  setlists, deleting clears references best-effort and reports failures (the
  confirm names the unfiled consequence), and
  legacy free-text artists remain as a display fallback (and a "Keep text"
  option) until adopted. Artist logos share the `import_logo` pool and removal
  skips files any setlist or artist still references. Song and setlist saves
  require an artist record; legacy unfiled records load, list, and restore
  as-is until assigned.
- Setlist editor: title/venue/date, break insertion (custom label, `mm:ss`
  length, comment), up/down + drag reorder, inline BPM/key/tuning editing,
  Comment fields for songs and breaks (max 140 chars) that render on the sheet,
  a `File under…` select while the setlist is unfiled, and logo upload with
  per-setlist width/alignment controls. Oversized raster logos are downscaled on import;
  SVG logos stay vector. The logo chain resolves only the image (setlist own →
  artist → none) in preview, print, and export; width and
  alignment always come from the setlist's own config, so the Logo slider and
  radios edit this setlist (10–80 mm) in every case and mark it dirty.
  Uploads keep the displayed geometry, removal resolves back to the artist
  image at that size; only the open draft is marked dirty and the normal Save
  persists the clear (no hidden or cross-record write), and a `Setlist logo` /
  `<name> logo (from the artist)` / `No logo yet` line names the source
  without a shared-size claim. Delete/Discard sits next to Save in the header
  actions (away from Add break) and keeps the existing confirmation for saved
  setlists and unsaved drafts.
- **Duplicate** sits beside **New** and turns the current setlist into a
  preset base: a dirty editor is saved first, then a deep copy is written under
  a fresh id and fresh timestamps. Venue, date, items, logo config (the file
  name is shared, never copied), sheet options, page mode, and the setlist
  artist are copied; the clean copy becomes current. Titles follow
  `X` → `X (copy)` → `X (copy 2)` without stacking suffixes, and deleting one
  copy keeps a logo the other still references.
- Per-artist workspace scoping with a landing page for artist
  creation/selection/management (name + logo image, or a selection
  list with thumbnails and song/setlist counts plus per-row Edit/Delete and
  an Unfiled entry — the library-pane Artists section is retired). The header artist
  picker is the scope switcher (artist entries plus `Unfiled (N)`, dirty-guard
  on switch); songs and setlists must belong to an artist on save, legacy
  records stay unfiled until assigned (landing offer, Unfiled scope filing, or
  `File under…`). Artist deletion names the unfiled consequence, nulls
  references through the unfiled allowance, and names the fallback scope in
  the status. The library Artist filter, the
  lock chrome, and the per-setlist Artist select are retired; the summary
  keeps the non-matching count without the `· artist` suffix.
- Per-setlist "Sheet columns" toggles for Key, Tuning, Tempo (BPM), Duration, and
  Comment, persisted with the setlist and applied to preview, print, and
  export. Column widths are per-combination presets summing to 100% with the
  `<colgroup>` as the only width source, so the header stays aligned with the
  body in every toggle combination. Title/venue/date and song titles always
  print; the Duration column can be hidden, while break durations always render.
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
  lower effective dpi) instead of clipped. The preview toolbar puts **Print**
  first beside a single **Export** button with an in-place PDF/PNG menu
  (keyboard-operable, Escape returns focus), plus an "Open after export"
  option that opens the saved file in the system viewer through
  `tauri-plugin-opener`. The Print button carries the Ctrl/⌘+P shortcut as a
  hover tooltip. Exported text is bitmap by design.
- Printing through the native webview print dialog (Ctrl/Cmd + P); the print
  output follows the selected page layout and remains the text-sharp paper path.
- GitHub Actions regression gate (`.github/workflows/ci.yml`): Node 20 frontend
  build plus `cargo test` on `ubuntu-latest` with the webkit2gtk-4.1 packages,
  cached npm/Cargo downloads. No secrets, bundles, signing, or mobile builds.
- One-file backup/restore of artists, the whole song library, and every setlist
  as a versioned JSON envelope (`schema_version: 1`), from a Backup section on
  the landing card (Back up / Restore, same guards and per-record reporting —
  restore works before entering any scope, then the user enters one). Written
  and read through
  the dialog-scoped fs permission with no new commands or capability widening.
  Restore validates records, re-saves them through the normal commands
  (artists first, unfiled records through the allowance), and reports
  imported/rejected counts; future schema versions are rejected until the app
  supports them, older ones can migrate forward.
  Logos are not embedded in v1 and are re-imported manually.
- v0.3.0 review hardening: an export capture snapshots the editor state and
  locks item editing, meta inputs, and scope switching until it restores;
  scope switches refuse during backup/restore (and vice versa); the Logo
  alignment radios joined the width slider on the displayed logo (both now
  edit per-setlist geometry — Feature 29); a dangling artist id resolves as unfiled with no legacy-text
  fallback for songs and setlists alike (the landing assign offer lists only
  true-`None` records); backup/print/duplicate auto-save failures on the
  artist check name the filing next step; New in the Unfiled scope keeps an
  adjacent hint plus Unfiled empty-state guidance copy and announces on
  attempted activation;
  song/setlist titles trim on save like artist names and `allow_unfiled` is
  documented as UX-convention trust; blob-URL caches are pruned on logo
  delete/replace; `parseDuration` rejects empty colon parts, blank duplicate
  song titles fall back to `Untitled song`, artist option labels trim,
  `beforeunload` covers open song/artist/landing drafts, `#setlist-sheet`
  is a landmark region, and landing Ctrl/Cmd+S routes to artist create.

- UI polish + language pass (Feature 26): the export menu is right-anchored
  in the right-aligned toolbar; icon-button rows (running-order, library,
  landing manage) use 8px separation; the header reads as scope selects
  beside a New/Duplicate/Save/Delete group (divider, heavier Delete, and the
  four buttons wrapping as their own group at narrow widths); the landing
  card is vertically centered (top-pinned on overflow) with display type for
  the title and one label token in the form; the logo showing line sits
  adjacent to the width/alignment controls and `.logo-row` wraps at
  editor-pane widths. The column toggle and sheet heading read **Duration**
  (internal `cols-*-time` class names unchanged); the preview toolbar carries
  the Print-vs-Export guidance line and the Unfiled library empty state names
  the glossary. Out of scope as specced: undo, S/M/L sizing, vector PDF,
  mobile, SQLite.

- Per-setlist logo size (Feature 29): the artist record keeps the logo image
  only — artist `width_mm`/`alignment` stay serialized but are render-dead, and
  the landing create/edit forms show name + upload/remove/preview with no size
  controls (new artists save 40 mm / Center; edits preserve stored geometry).
  `resolveSetlistLogo()` resolves only the file (own → artist → none), while
  width and alignment always come from `setlist.logo`; the Logo slider/radios
  edit the draft in every case (clamped 10–80, dirty + sheet re-render), upload
  keeps the geometry, and removal resolves back to the artist image at the
  setlist's size; only the draft is cleared and the normal Save persists it
  (no hidden or cross-record write). The showing line names provenance without a shared-size
  claim, and a silent first-startup migration copies a live artist's
  width/alignment into logo-less setlists still at exactly 40 mm / Center,
  guarded once by a UI-level localStorage key that also records failed ids for
  targeted retries (no schema/model marker, schema bump, or status message).
  New/reset 40 mm / Center setlists keep their value while that key exists. Out
  of scope as specced: S/M/L sizing, bulk resize, logo bytes in backups,
  export/print layout changes.

- Artist-creation logo fix (Feature 27): scope entry, startup, New, and
  Delete/Discard await the resolved logo load even for dirty drafts, so a blank
  setlist pre-assigned to an artist shows that artist's image at the setlist's
  own geometry. Artist create/edit saves warm the saved thumbnail blob URL and
  prune the replaced/removed one; inline Edit awaits the resolved-preview
  refresh before its status, covering rename, image swap, and removal.
  `refreshLogoIfChanged()` reads the replacement file before revoking the
  displayed blob URL, so own-logo removal falls back to the artist image and an
  artist swap updates without a placeholder flash; local upload previews still
  win until Remove/Reset stops them, and export keeps the data-URL/resolved-file
  path. Desktop QA gates 1–6 remain pending (no desktop session in this
  environment).

- Opt-in library ⇄ setlist song sync (Feature 28, Done (desktop QA pending)):
  a successful library save offers to update differing in-scope setlist copies,
  and an explicit setlist Save offers once per changed song (field blur, Print,
  Duplicate, Back up, File under…, and auto-saves never offer). Keep is focused;
  Enter/Escape keep unless focus was explicitly Tabbed to Update, where the
  focused button activates (Escape always keeps); the background is inert, and
  a pending dialog counts as unsaved work. Setlist→library compares only title,
  BPM, key, tuning, duration, and comment against the pre-save item (or the
  library song for a new setlist/item), ignores artist identity, and copies
  only the effective fields onto a filed library song through `save_song`
  (never `allowUnfiled`); the body uses neutral "library copy is different"
  wording. Library→setlist writes every clean target through `save_setlist`
  with the matching snapshots replaced, skips a dirty current setlist, and
  re-reads each target before writing (`Skipped …: changed while updating.`).
  Accepted batches hold a `propagationBusy` editor/cache lock and guard
  save/delete/duplicate/New/scope/print/export/File under…/library/backup with
  `Updating setlist copies — wait for it to finish.` Unfiled, other-artist, and
  legacy/unfiled/dangling library copies never offer; there is no silent sync
  or global toggle, and accept re-renders the preview. Desktop QA pending.

- Artist-logo propagation + Reset (Feature 30, Done (desktop QA pending)):
  the artist image stays live for every setlist without its own logo. A changed
  or removed non-null artist image offers Keep (default, focused) vs Follow
  once per edit from the landing inline Edit Save. The dialog is outcome-framed
  (`Keep the old logo on N setlists?`; followers now show the new image or
  `No logo yet`; confirm is `Use new logo` / `Leave them without a logo`).
  Follow writes zero setlists; Keep pins the old file as each affected
  setlist's own logo with one `save_setlist` per target, preserving its
  width/alignment and display pixels. A clean open setlist may be pinned; a
  dirty one still at no own logo is pinned in its draft and reported
  save-to-apply (never auto-saved), while a dirty draft with a different own
  logo skips/reports. The old file is retained on any skip, draft pin, or
  failure; a blocked/failed Keep stores a memory-only
  `{ artistId, oldFileName, targetIds }` and opening Edit retries the choice
  (a restart drops the retry; the file stays). Addition (`None` → image) never
  prompts; own-logo, other-artist, and Unfiled setlists are never counted or
  written. Accepted pins hold the `propagationBusy` lock, show
  `Restoring the old image on N setlists…`, and keep a visible landing overlay
  inert; target writes re-read the cache (`Skipped …: changed while
  updating.`). The Logo fieldset gains a native-disabled **Reset to artist
  logo** button plus the `No artist logo — add one to “<Name>”, then use Reset
  to show it here.` hint. Reset adds the abandoned own file to
  `pendingLogoRemovals`, keeps geometry, and saves through the normal setlist
  Save; `setlistLogoBusy` blocks Remove/Reset during a logo import. Desktop QA
  pending.

## Still missing (per plan)

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
