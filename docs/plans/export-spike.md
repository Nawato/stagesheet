# Export spike — html-to-image + jsPDF in WebKitGTK

Phase 5a result. **Spike complete and committed (deps + this note); the
`spikes/` harness stays untracked by design. The export implementation is
tracked as Feature 6.** Keep this note alongside that work and delete it (and
`spikes/`) once the exporter ships, per `docs/plans/development-plan.md`.

Date: 2026-11-17

## Verdict

**GO (conditional).** `html-to-image` + `jspdf` can produce a faithful 300 dpi
A4 PNG and a sliced multi-page A4 PDF in the same WebKitGTK engine Tauri uses on
Linux. It is not a drop-in call: export needs a small preparation step (data URL
logo, warm-up raster, and a table-layout workaround). With those in place the
output is clean, grayscale-only, fast enough, and the PDF page size is A4.

Fallback is **not** required for fidelity reasons, but the native
`window.print()` → OS "Print to PDF" path remains the simpler text-sharp path
for paper and should stay the default for printing. Vector PDF via `typst`
remains post-MVP.

## Environment

| Item | Value |
| --- | --- |
| OS | Linux 7.3.4-1-cachyos (Arch) |
| Engine | WebKitGTK **2.54.2** (`pkg-config --modversion webkit2gtk-4.1`) |
| UA | `Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/605.1.15 … Safari/605.1.15` |
| Node / npm | 26.13.1 / 12.2.2 |
| Dependencies | `html-to-image@1.11.13`, `jspdf@4.2.1` (exact) |

The harness drives a real `WebKit2.WebView` through PyGObject, not Chromium.
That matters: `foreignObject` behavior is engine-specific.

## Test rig

| File | Purpose |
| --- | --- |
| `spikes/export-spike.html` | Temporary page: app CSS + `#setlist-sheet`, production-like CSP |
| `spikes/export-spike.ts` | Renders test setlists, rasterizes, slices, builds PDF, reports metrics |
| `spikes/webkit-spike.py` | Loads the page in WebKitGTK and writes outputs outside the repo |

Regenerate with `npm run dev` in one terminal and
`python3 spikes/webkit-spike.py` in another. Outputs go to
`/tmp/opencode/export-spike-out/`; **no binaries are committed.**

Test data:

- **Long:** 28 songs + 2 breaks (30 items), all sheet columns, 40 mm centered
  logo, title/venue/date → natural height **642.94 mm** (2430 CSS px).
- **Short:** 8 songs, same logo, fits one A4 at 100%.

The source logo is `app-icon.png` (1024 × 1024 colored RGBA); the sheet applies
the normal `grayscale(1)` print-safe filter.

## Approach

1. Render the real setlist with `renderSetlistSheet()` into the real
   `#setlist-sheet` and real app CSS.
2. `html-to-image.toCanvas(sheet, { canvasWidth: 2480, canvasHeight: …,
   pixelRatio: 1, backgroundColor: "#ffffff" })`. A4 at 300 dpi is
   2480 × 3508 px.
3. For multi-page, temporarily set the sheet to `height: auto;
   max-height: none; overflow: visible; --sheet-fit: 1`, capture the full
   height (2480 × 7590), then slice at **271 mm content height** (297 − 13 top −
   13 bottom) and add each slice to jsPDF at 13 mm top margin.
4. Slice boundaries snap to the next song/break row top, so rows never split.
5. `new jsPDF({ unit: "mm", format: "a4", orientation: "portrait",
   compress: true })`; one `addImage` per page.

## Results

### PNG

`single-page-short.png` (short setlist, 300 dpi):

- **2480 × 3508 px**, white background, `GrayscaleAlpha`.
- Logo present (125,776 ink pixels in the logo region), grayscale.
- **0 chromatic pixels** and **max channel spread 0** across the entire sheet —
  strict black/white, including the logo.
- Capture time **≈ 50–110 ms**.

Long setlist full-sheet raster: **2480 × 7590 px** (642.94 mm), same
grayscale/no-colour result, logo present, capture ≈ 160–190 ms.

Canvas taint: **none** — `getImageData` and `toDataURL` succeeded for every
data-URL capture. Font fallback or missing glyphs: **not observed**. Blank logo
renders: **observed** in two specific cases (blob URL under CSP, and the first
capture in a fresh WebView), both covered below.

### PDF

`multi-page-long.pdf` (long setlist, width-row workaround):

- **3 pages**, page size **595.28 × 841.89 pt = A4** (`pdfinfo`); jsPDF internal
  size 210.0016 × 297.0001 mm (point→mm rounding only).
- Slices: **263.94 mm / 257.59 mm / 95.18 mm**, row-aligned; no split rows.
- ~1.0 MB, build time **≈ 1.3–1.6 s**; total per export ≈ 1.5–2 s including
  capture, within the "couple of seconds" budget.
- Text is legible at 100% (300 dpi raster; inspected at 80/150 dpi renders).

### Fonts

The sheet stack resolves through fontconfig to Helvetica/Nimbus Sans in this
environment: the measured width for the full sheet stack (1490.5) equals the
`Helvetica` probe, not `sans-serif` (1545.8) or `DejaVu Sans` (1658.69).
`document.fonts.status` is `loaded`; the raster text matches the live preview.
No font embedding is involved (system fonts only), so this is engine-local by
design. WebView2/WKWebView will resolve their own fonts; verify per engine.

### CSP

The recommended path (logo pre-encoded as a `data:` URL) produced **zero CSP
violations** under the production directives
(`img-src 'self' data: blob:; font-src 'self'; script-src 'self'; …`).

## Problems found — and the workarounds that make this GO

### 1. `<colgroup>` widths collapse to 0 px in the clone

`html-to-image` copies `getComputedStyle(<col>).width` into the SVG clone. In
WebKitGTK that computed value is **`0px` for every `<col>`**, even though the
stylesheet assigns percentages. With `table-layout: fixed`, the columns collapse
and the whole table shifts: the key text is painted at the end of the song title
(overlap) and Tuning/BPM/Time move left by one column. The header row shifts
with the body rather than staying correct on its own — it merely looks plausible
at a glance, which makes this easy to miss.

Reproduced in `short-sheet.svg`: every cloned `<col>` carries `width: 0px`.

Workarounds tested:

| Variant | Result |
| --- | --- |
| Baseline (colgroup intact) | **Broken** — data columns shifted/overlap |
| Remove colgroup; `table-layout: auto` | **Works** — columns content-sized (slightly different widths, no overlap) |
| Remove colgroup; fixed layout + zero-height first row carrying the computed cell widths | **Works** — preserves the fixed percentage layout; recommended |
| Inline `col.style.width = "…px"` | No effect — computed value is still 0 px |
| `filter` out `<col>`/`<colgroup>` | No effect in this version |

Recommended export prep: measure the `.sheet-columns th` widths, remove the
`colgroup`, insert a hidden/zero-height first row with one cell per column at
those widths, capture, then restore the DOM. It is local to export and
reversible. If exact column percentages are not important, auto layout is the
simpler fallback. The width-row variant keeps the designed fixed widths; a long
tuning label can therefore wrap (e.g. `Open G`) exactly as the fixed layout
allows.

### 2. Blob logo URLs are not viable under the production CSP

With `storedLogoUrl()` (a `blob:` URL) and the shipped CSP, `html-to-image`'s
fetch is blocked: `connect-src` violation at `html-to-image` line 209,
`warn: Load failed`, and `toCanvas` rejects with `Event(error)`.

Adding `connect-src blob:` removes the CSP error, but blob reads were still
unreliable (a first capture produced a blank logo). **Do not widen the CSP for
this.** The reliable path is to hand the exporter a `data:` URL:

- `logo.ts` already reads the logo bytes with the scoped `fs` capability.
- Add an export-only `storedLogoDataUrl()` (or base64 helper) and use that URL
  for the raster. No fs capability change, no `connect-src blob:`.
- `img-src data: blob:` already permits the resulting SVG image.

### 3. First capture can omit the logo (WebKit image-decode race)

Even with a `data:` logo, the **first** `toCanvas` in a fresh WebView produced a
blank logo region (ink 0) while the live `<img>` was complete (1024 × 1024) and
visible. Later captures worked. A throwaway warm-up
`toCanvas(sheet, { canvasWidth: 400, canvasHeight: 566, … })` before the real
capture fixed it in the rerun (logo ink 0 → 125,776). The exporter (Feature 6)
should warm up the raster pipeline once per session, or verify the logo region
and retry once.

### 4. `--sheet-fit` is not usable for single-page export (pre-Feature-5 measurement)

The pre-Feature-5 `fitSheetToPage()` in `src/main.ts` measured `sheet.offsetHeight`, but
`#setlist-sheet` is locked to `height: 297mm` with `overflow: hidden`, so
`offsetHeight` is always ~1123 px. For the long setlist the loop stops at
**fit = 1** even though natural content is 642.94 mm (needed fit ≈ 0.462).
Forcing `--sheet-fit: 0.5` does survive the clone (`computedZoom: 0.5`,
capture 190 ms), but the sheet's bounding box becomes **396.84 × 561.25 CSS px**
— half-width — leaving a blank right/bottom half. It is not an A4-filling
single-page export.

Consequence for the exporter: **capture the full sheet and slice for every
export**, including short setlists (one page if it fits). Do not depend on
`--sheet-fit` for export. This also flagged the single-A4 cap clipping at fit 1
as a pre-existing bug; Feature 5 fixed it by zooming the table inside the fixed
sheet box (the exporter still must capture full height, never the fitted zoom),
and multiple-page mode remains the escape hatch below the 50% floor.

### 5. Raw slicing does not repeat thead/tfoot

The tall raster contains the brand header once at the top and the footer once at
the end. Sliced pages after page 1 have no header, and intermediate pages have
no footer. This is **not** an html-to-image fidelity failure, but the exporter
must handle it explicitly:

- capture the brand/column header and footer separately and composite them on
  each page, adjusting the 271 mm content height per page, **or**
- use the native print path for multi-page paper output (rows paginate cleanly,
  but WebKitGTK does not repeat `thead`/`tfoot` — see Feature 5's engine note in
  `upcoming-features.md`), and keep raster PDF for one-page/PNG fallback.

The spike intentionally stops at proving raster + slicing; repeated headers are
Feature 6 work, not spike scope.

### 6. Text is bitmap (accepted)

Export text is raster at 300 dpi, so it is not selectable/searchable and does not
scale infinitely. This was an accepted Phase 5 trade-off: native print remains
the text-sharp path; vector PDF is post-MVP (`typst`).

## Artifacts (not committed)

```
/tmp/opencode/export-spike-out/single-page-short.png       # recommended PNG
/tmp/opencode/export-spike-out/full-sheet-long.png          # recommended tall raster
/tmp/opencode/export-spike-out/multi-page-long.pdf           # recommended PDF
/tmp/opencode/export-spike-out/multi-page-long-auto.pdf      # auto-layout variant
/tmp/opencode/export-spike-out/diagnostic-baseline-colgroup.png
/tmp/opencode/export-spike-out/diagnostic-multi-page-baseline.pdf
/tmp/opencode/export-spike-out/single-page-long-fit1.png     # clipped at fit 1
/tmp/opencode/export-spike-out/single-page-long-fit.png      # half-width at fit .5
/tmp/opencode/export-spike-out/short-sheet.svg               # clone with width:0px cols
/tmp/opencode/export-spike-out/meta.json                     # raw metrics
```

## Plan for the exporter (Feature 6, based on this spike)

1. Add `storedLogoDataUrl()` (read existing bytes, base64) and pass that to the
   exporter. Keep blob URLs for the live preview.
2. Implement `prepareSheetForRaster()`: save/restore the DOM, remove the
   colgroup, insert the zero-height width row (or switch to auto layout), set
   `height: auto / overflow: visible / --sheet-fit: 1` for full capture.
3. Warm up `toCanvas` once, then capture at 300 dpi.
4. Slice at 271 mm with row-boundary snapping; add repeated header/footer per
   page (or defer to native print for multi-page PDF).
5. Keep PNG export as the simple path; add PDF only after the header/footer
   decision. Never widen the CSP for export.
6. Add a frontend test that asserts the export prep produces a non-zero logo
   region and an A4-sized canvas; keep paper QA manual.

Decision: **GO** for raster PNG/PDF with the prep above; native print stays the
primary paper path.
