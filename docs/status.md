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
  in preview, print, and export, and the Logo width slider edits the
  displayed logo: own/placeholder paths stay input-driven on the setlist
  config, the artist path commits the shared artist width on release without
  dirtying the setlist, uploads adopt the displayed size/alignment, removal
  falls back to the artist logo, and a `Setlist logo` / `<name> logo
  (artist)` / `No logo yet` line names the target. Delete/Discard sits next to Save in the header
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

## Still missing (per plan)

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
