# StageSheet — Development Plan

Planning docs for StageSheet, the offline-first setlist manager that prints
black-on-white A4 sheets. These files are versioned with the code and replace
the earlier drafts that lived outside the repo (now removed).

| Doc | Contents |
| --- | --- |
| `docs/plans/development-plan.md` | Constraints, stack decisions, phases, QA strategy, risks (this file) |
| `docs/plans/upcoming-features.md` | Per-feature specs and the prioritized backlog |

Maintenance rules:

1. Plans are updated in the same commit as the change they describe. Never
   reference paths outside the repo.
2. Phase/feature status must match reality. Update this file and the README
   status list together.
3. The serialized data contract lives in `SKILL.md`. Feature specs extend it;
   they never fork it, so there is only one contract to keep in sync.

## Hard constraints

1. **Print output is plain black-on-white on A4 paper.** No dark-stage or
   high-contrast theme for the sheet itself.
2. UI chrome may have its own theme, but `<div id="setlist-sheet">` — preview,
   print, and every export — is always white background, black text.
3. All exports paginate to A4 (210 × 297 mm, `@page { size: A4 }`).
4. Setlist duration is computed in Rust, never only in the UI.
5. All storage stays under `<app_data_dir>/stagesheet/`; the frontend `fs`
   capability is scoped to `$APPDATA/stagesheet/**`.

## Stack decisions

| Decision | Choice | Status |
| --- | --- | --- |
| App shell | Tauri v2, vanilla TypeScript + Vite (no UI framework) | **Done** |
| Rust core | Shared `stagesheet_lib` crate: `lib.rs` (mobile + desktop) called by `main.rs` | **Done** |
| Rust deps | serde + serde_json, uuid (v4), chrono, thiserror, tokio | **Done** |
| Storage | JSON files under `<app_data_dir>/stagesheet/` (songs.json, setlists/, logos/) | **Done** |
| Plugins | `tauri-plugin-fs`, `tauri-plugin-dialog`, `tauri-plugin-opener` | **Done** |
| Mobile share | No official Tauri v2 plugin; verify a community crate only when the feature is built | Deferred (P2) |
| Export | DOM raster (`html-to-image`) + `jspdf` A4; pure-Rust vector PDF (`typst`) post-MVP | **Done** (Phase 5a, Feature 6) |

The data model itself is pinned in `SKILL.md`; this plan intentionally does not
duplicate the struct definitions.

## Phases

### Phase 1 — Scaffolding + early mobile split — Done

- Tauri v2 vanilla-TS scaffold; `lib.rs`/`main.rs` split verified immediately
  (the expensive-to-retrofit piece was moved to the front on purpose).
- `tauri android init` / `ios init` deferred: needs JDK/Android SDK, and iOS
  initialization is macOS-only. `src-tauri/gen/` does not exist yet.

### Phase 2 — Models + unit tests — Done

- Models per `SKILL.md`, with serde defaults/aliases so first-draft JSON still
  loads (tested by `migrates_first_draft_json`).
- Tests: serde round-trips, legacy migration, reorder bounds, duration with
  breaks, logo alignment parsing, plain-file-name traversal rejection.

### Phase 3 — Storage + IPC — Done

- JSON storage with temp-file + rename writes serialized by a tokio mutex.
- Capability scoped to `$APPDATA/stagesheet/**`; dialog open/save; no shell,
  no network.
- Full command list from `SKILL.md`; every command async, `Result<T, AppError>`.
- Logos validated by content (PNG/JPEG magic bytes, SVG root tag), 5 MiB cap,
  UUID file names, absolute paths never persisted.

### Phase 4 — UI — Done

- Song library with instant search + one-click add; header inputs; break
  insertion; up/down + drag reorder; inline BPM/key/duration/notes editing;
  logo upload with width/alignment controls; live A4 preview.
- The app runs degraded without the backend (`backendAvailable = false`), which
  later makes browser-only e2e tests feasible (see QA strategy).

### Phase 5 — A4 print + export — Done (physical-paper QA in Phase 6)

Done: A4 black-on-white preview, native print via `window.print()`,
`thead`/`tfoot` marked for repetition on print (Chromium is expected to repeat
them; WebKitGTK does not — see Feature 5's engine note), `break-inside: avoid`,
single-A4 cap with auto-fit table zoom (min 50%, applied and mirrored in the
fit label), plus per-setlist multiple-page mode (`page_mode`) with preview page
boundaries and an approximate page count (preview limitations found in real use
→ Features 10–11 in `upcoming-features.md`). PDF/PNG export ships as a 300 dpi
raster with full-height capture, sliced A4 pages, repeated header/footer, and
`Page N / M`; the native print path remains the text-sharp paper route.
The implemented print CSS uses explicit layout resets (`display: none` on
chrome, static positioning for the sheet) rather than the original `visibility`
trick — this is the reference approach; do not regress it.

#### Phase 5a — Export spike — Done

Goal: prove or kill the `html-to-image` raster approach in WebKitGTK **before**
any remaining feature is built on export expectations. `html-to-image`
rasterizes via SVG `foreignObject`, which has a history of fidelity problems in
WebKitGTK (font handling, CSS support, blank renders).

Steps:

1. Spike branch; add `html-to-image` + `jspdf` as dependencies.
2. Rasterize `#setlist-sheet` at ~300 dpi (A4 = 2480 × 3508 px) for a long
   setlist that includes a logo; produce a PNG and a sliced multi-page PDF.
3. Verify: fonts render (no fallback faces), the logo inlines (no blank box),
   strict black/white output, no canvas-taint or CSP errors, export completes
   in a couple of seconds, PDF page size is exactly A4.
4. Record results in a temporary spike note; delete it and the harness once the
   exporter has shipped.

Exit criteria: an A4 PDF that opens with correct dimensions and legible text at
100% zoom, **or** a documented fallback decision (PNG-only export plus the OS
"print to PDF" dialog for documents; vector PDF via `typst` post-MVP).

Accepted trade-off: raster export means exported text is bitmap. The native
print path prints live DOM text and stays the text-sharp path for paper.

Result: **GO (conditional)** for `html-to-image` + `jspdf` in WebKitGTK with a
preparation step (full-height capture + slicing, data-URL logo, warm-up raster,
colgroup workaround, header/footer decision). Findings were folded into
`SKILL.md` and the Feature 6 implementation; the spike note and untracked
harness were removed when the exporter shipped.

### Phase 6 — Cross-OS polish + QA/release — In progress

- Minimal frontend test harness (see QA strategy) and 44px touch targets. CI
  (`.github/workflows/ci.yml`) already runs the frontend build and Rust tests.
- Sheet correctness fixes from real use (Features 10–11 in
  `upcoming-features.md`): column-width rebalance + header alignment, and
  paginated preview/print frames. Both outrank new tooling.
- `tauri android init` / `ios init` on provisioned machines; native share.
- Print QA on real A4 (checklist below), backup/restore, app versioning,
  signing/release automation (tracked in the roadmap, P3).

## QA strategy

**Rust gate:** `cargo test` in `src-tauri` (list in `SKILL.md`). Note: the
`tauri` crate needs the `webkit2gtk-4.1` system libraries to compile even for
pure model/storage tests, so the gate is environment-dependent (README lists
the packages; `.github/workflows/ci.yml` installs them on `ubuntu-latest`). If
that becomes a recurring blocker, split `models`/`storage`/`error` into a
dependency-light crate so the core tests compile anywhere; deferred until it
actually hurts.

**Frontend gate:** `npm run build` (TypeScript strict + Vite production bundle).
Both gates run in CI on every push to `main` and every pull request.

**Planned minimal harness (Phase 6):** Playwright smoke tests against the
production frontend in a plain browser. No Tauri IPC is needed because the app
already runs degraded (`backendAvailable = false`): cover sheet rendering, the
auto-fit loop and fit indicator, item add/remove/reorder, break insertion, and
assertions that `@page { size: A4 }` exists and `#setlist-sheet` stays
black-on-white. Plus Vitest units for `format.ts` (`parseDuration`,
`formatDuration`, `formatRuntime`). Keep the harness small; paper QA stays
manual by design.

**Print QA checklist (manual, real A4, per engine — WebKitGTK now;
WebView2/WKWebView when available):**

- Short setlist (8 songs) and long setlist (25 songs + 2 breaks at min fit).
- Logo present/absent × grayscale toggle.
- Rows never split across pages. Header/footer repetition is engine-dependent:
  Chromium-based engines are expected to repeat the groups, WebKitGTK currently
  does not — record the result per engine instead of assuming it.
- Multiple-page mode (`page_mode`): printed page count matches the ≈N estimate
  within ±1.

## Risks

| Risk | Mitigation |
| --- | --- |
| `html-to-image` fidelity in WebKitGTK (SVG foreignObject) | Phase 5a spike verified the raster path with the prep step; cross-engine and physical-paper QA remain in Phase 6; PNG fallback and vector PDF via `typst` stay post-MVP options |
| Print pagination differs per engine | Repeated thead/tfoot + `break-inside: avoid` already implemented; manual paper QA per engine |
| `cargo test` needs webkit2gtk system libs locally and in CI | README prerequisite; `.github/workflows/ci.yml` installs the packages; optional dependency-light test crate if blocked |
| Temp+rename writes have no `fsync`; a crash can lose the newest write (Windows does remove+rename, widening the window) | Accepted for MVP; backup/restore (P1) gives users an escape hatch; add fsync if data loss is ever reported |
| `songs.json` degrades past ~1000 songs / slow search | Trigger to migrate to SQLite (P3) |
| Count-based column presets drift for some toggle combos | Feature 10: per-combination widths summing to 100% + alignment QA matrix |
| Tall-sheet + overlay preview reads as cut-off text | Feature 11: paginated A4 frames with repeated header/footer for preview and print |
| `zoom` in print CSS is WebKit/Blink-only | All Tauri engines are WebKit-family; revisit only if a plain-browser build is ever shipped |

## Status log

- 2026-11: Phases 1–4 done; A4 preview + native print + single-page auto-fit
  done (commits `ed09df4`, `db7f279`). Planning docs moved into the repo.
- 2026-11-17: Features 1–5 shipped (tuning, break labels, comments, sheet
  column toggles, multiple-page mode); Phase 5a export spike closed GO
  (conditional). Feature 6 shipped the PDF/PNG exporter (full-height raster,
  data-URL logo, colgroup workaround, repeated header/footer, page numbers,
  open-after-export) and removed the spike note/harness. The single-page fit loop
  now divides the painted table height by the preview scale so the applied zoom
  and overfull warning are window-width independent. Physical-paper QA and
  cross-engine status remain Phase 6.
- 2026-11-17: P1 CI gate added (`.github/workflows/ci.yml`): `npm ci` +
  `npm run build` + `npm run test:rust` on `ubuntu-latest` with the Tauri Linux
  packages, npm/Cargo caching, no secrets, bundles, signing, or mobile builds.
- 2026-11-17: Plan cleanup from real use: header/body misalignment with some
  toggles off (count-based `.cols-4`/`.cols-minimal` presets don't sum to 100%
  for all combos) and multi-page preview reading as cut-off text (dashed
  overlays, no repeated header/footer). Tracked as Features 10 (widths
  rebalance + alignment matrix) and 11 (paginated preview/print frames);
  both P0, above new tooling.
