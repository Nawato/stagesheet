/**
 * PDF/PNG export for the printable sheet.
 *
 * The sheet is a fixed A4 box with `overflow: hidden`, so the exporter never
 * reuses the preview's `--sheet-fit`. It temporarily applies the `.multipage`
 * layout, captures the full natural-height sheet at 300 dpi (2480 px wide) for
 * normal setlists, slices at the A4 content height, and restores the DOM
 * afterwards. Extremely long sheets are downscaled proportionally to stay under
 * WebKit's canvas limit rather than being clipped.
 *
 * PDF pages composite the captured header/footer on every page: raw slices
 * would repeat neither (the brand header is on page 1 only and the footer on the
 * last page), and WebKitGTK's native print path does not repeat table header or
 * footer groups either (WebKit bug 17205). `window.print()` remains the
 * text-sharp paper path; everything in the exported sheet is rasterized.
 */

import { jsPDF } from "jspdf";
import { toCanvas } from "html-to-image";
import { save } from "@tauri-apps/plugin-dialog";
import { writeFile } from "@tauri-apps/plugin-fs";
import { openPath } from "@tauri-apps/plugin-opener";
import { downloadDir, join } from "@tauri-apps/api/path";

import { storedLogoDataUrl } from "./logo";
import type { LogoConfig, Setlist } from "./types";

const A4_WIDTH_MM = 210;
const A4_HEIGHT_MM = 297;
/** Matches `@page { margin: 13mm 12mm; }` in print.css. */
const PAGE_MARGIN_MM = 13;
/** Printable height of one page before header/footer compositing. */
const CONTENT_HEIGHT_MM = A4_HEIGHT_MM - PAGE_MARGIN_MM * 2;
/** 210 mm at 300 dpi. */
const RASTER_WIDTH_PX = 2480;
/** 297 mm at 300 dpi (2480 × 3508 is the standard 300 dpi A4 raster). */
const A4_HEIGHT_PX = 3508;
/** WebKit caps canvas dimensions at 16384 px; leave a little headroom. */
const MAX_CANVAS_HEIGHT_PX = 16000;
/** Below this much room between composited header and footer, fall back to raw slices. */
const MIN_COMPOSITE_CONTENT_MM = 30;
/** Never emit a thin sliver page; cut through a row instead. */
const MIN_SLICE_MM = 10;

export type ExportFormat = "pdf" | "png";

export type ExportOutcome =
  | { status: "canceled" }
  | {
      status: "exported";
      path: string;
      opened: boolean;
      openError?: string;
      /** Set when the stored logo could not be read; the file has no logo. */
      logoWarning?: string;
    };

export interface ExportRequest {
  sheet: HTMLElement;
  setlist: Setlist;
  /**
   * Resolved logo (setlist own → artist → placeholder). Defaults to the
   * setlist's own config for callers that do not resolve the chain.
   */
  logo?: LogoConfig;
  format: ExportFormat;
  openAfterExport: boolean;
}

/** Logo bytes/config handed to the raster prep. */
export interface RasterLogo {
  /** Stored bytes as a data URL, or null when the logo could not be read. */
  dataUrl: string | null;
  /** Printed width in millimetres (`LogoConfig.width_mm`). */
  widthMm: number;
}

interface RowBounds {
  top: number;
  bottom: number;
}

/** Everything needed to build a PDF/PNG after the capture, plus DOM restore. */
export interface PreparedRaster {
  canvas: HTMLCanvasElement;
  /** Absolute y (canvas pixels) where the repeated header ends. */
  headerBottomPx: number;
  /** Absolute y (canvas pixels) where the repeated footer starts. */
  footerTopPx: number;
  rowBounds: RowBounds[];
  restore: () => void;
}

/** Warm-up the raster pipeline once per session (WebKit logo-decode race). */
let rasterWarmedUp = false;

/**
 * Runs the export: save dialog → full-sheet raster → artifact → write → optional
 * open. Uses the current in-memory setlist, so `page_mode` and the sheet options
 * are captured exactly as rendered.
 */
export async function exportSetlist(request: ExportRequest): Promise<ExportOutcome> {
  const extension = request.format === "pdf" ? "pdf" : "png";
  const fileName = exportFileName(request.setlist.title, extension);
  const path = await promptForPath(fileName, request.format);
  if (!path) return { status: "canceled" };

  const logo = request.logo ?? request.setlist.logo;
  let logoDataUrl: string | null = null;
  let logoWarning: string | undefined;
  if (logo.file_name) {
    try {
      logoDataUrl = await storedLogoDataUrl(logo.file_name);
    } catch (error) {
      // A missing/unreadable stored logo must not abort the export: the preview
      // already degrades to a placeholder, so export without the logo and
      // report the problem in the status line.
      logoWarning = describeError(error);
    }
  }

  const prepared = await prepareSheetRaster(request.sheet, {
    dataUrl: logoDataUrl,
    widthMm: logo.width_mm,
  });
  let bytes: Uint8Array;
  try {
    bytes =
      request.format === "pdf" ? buildPdfBytes(prepared) : buildPngBytes(prepared.canvas);
  } finally {
    prepared.restore();
  }

  await writeFile(path, bytes);

  let opened = false;
  let openError: string | undefined;
  if (request.openAfterExport) {
    try {
      await openPath(path);
      opened = true;
    } catch (error) {
      openError = describeError(error);
    }
  }

  return { status: "exported", path, opened, openError, logoWarning };
}

// ---------------------------------------------------------------------------
// Preparation + capture
// ---------------------------------------------------------------------------

/**
 * Temporarily switches the sheet to its full natural height and captures it at
 * 300 dpi (or a proportionally lower dpi when the natural height exceeds
 * WebKit's canvas limit). The returned `restore` must always be called (the
 * page uses it to put the preview back into its layout).
 *
 * Kept as a separate function so the raster/slice path can be exercised without
 * opening a save dialog.
 */
export async function prepareSheetRaster(
  sheet: HTMLElement,
  logoOptions: RasterLogo | null,
): Promise<PreparedRaster> {
  const table = sheet.querySelector<HTMLTableElement>(".sheet-table");
  const thead = table?.tHead;
  const tfoot = table?.tFoot;
  if (!table || !thead || !tfoot) {
    throw new Error("The sheet has no table to export.");
  }

  // Snapshot everything that export prep mutates.
  const savedStyle = sheet.getAttribute("style");
  const savedClassName = sheet.className;
  const savedTableStyle = table.getAttribute("style");
  const colgroup = table.querySelector("colgroup");
  const colgroupNext = colgroup?.nextSibling ?? null;

  const logoRow = sheet.querySelector<HTMLElement>(".sheet-logo-row");
  const existingLogo = sheet.querySelector<HTMLImageElement>(".sheet-logo");
  const placeholder = sheet.querySelector<HTMLElement>(".sheet-logo-placeholder");
  const savedLogoSrc = existingLogo?.getAttribute("src") ?? null;
  const savedLogoHidden = existingLogo?.hidden ?? false;
  const savedLogoPrintSafe = existingLogo?.classList.contains("print-safe") ?? false;
  const savedPlaceholderHidden = placeholder?.hidden ?? false;

  let widthRow: HTMLTableRowElement | null = null;
  let injectedLogo: HTMLImageElement | null = null;

  const restore = (): void => {
    widthRow?.remove();
    widthRow = null;

    injectedLogo?.remove();
    injectedLogo = null;

    if (colgroup && colgroup.parentNode !== table) {
      if (colgroupNext && colgroupNext.parentNode === table) {
        table.insertBefore(colgroup, colgroupNext);
      } else {
        table.insertBefore(colgroup, table.firstChild);
      }
    }

    if (savedTableStyle === null) {
      table.removeAttribute("style");
    } else {
      table.setAttribute("style", savedTableStyle);
    }

    sheet.className = savedClassName;
    if (savedStyle === null) {
      sheet.removeAttribute("style");
    } else {
      sheet.setAttribute("style", savedStyle);
    }

    if (existingLogo) {
      if (savedLogoSrc === null) {
        existingLogo.removeAttribute("src");
      } else {
        existingLogo.setAttribute("src", savedLogoSrc);
      }
      existingLogo.hidden = savedLogoHidden;
      existingLogo.classList.toggle("print-safe", savedLogoPrintSafe);
    }

    if (placeholder) {
      placeholder.hidden = savedPlaceholderHidden;
    }
  };

  try {
    // `.multipage` is the layout contract: height:auto, no max-height, visible
    // overflow. The preview's transform must not scale the clone, and
    // --sheet-fit is irrelevant because the class resets the table zoom to 1.
    sheet.classList.add("multipage");
    sheet.style.setProperty("--sheet-fit", "1");
    sheet.style.height = "auto";
    sheet.style.maxHeight = "none";
    sheet.style.overflow = "visible";
    sheet.style.transform = "none";
    sheet.style.boxShadow = "none";

    const logoDataUrl = logoOptions?.dataUrl ?? null;
    let logo = existingLogo;

    if (logoRow && !logo && logoDataUrl) {
      // Export clicked while the preview logo was still loading: the sheet shows
      // `.sheet-logo-placeholder`, which is screen-only styling and would be
      // rasterized. Inject the real export image with the configured width so
      // the placeholder never reaches the PNG/PDF.
      logo = document.createElement("img");
      logo.className = "sheet-logo";
      logo.alt = "Band logo";
      const widthMm =
        logoOptions && Number.isFinite(logoOptions.widthMm) && logoOptions.widthMm > 0
          ? logoOptions.widthMm
          : 40;
      logo.style.width = `${widthMm}mm`;
      logoRow.append(logo);
      injectedLogo = logo;
    }

    if (logo && logoDataUrl) {
      // Export-only data URL: blob URLs are blocked by the production CSP and
      // were unreliable in WebKitGTK even when allowed.
      logo.src = logoDataUrl;
      logo.hidden = false;
      await decodeImage(logo);
    } else if (logo) {
      // A preview-only logo (backend unavailable) has no stored bytes to hand
      // to the raster; its blob URL would fail the clone fetch. Drop it rather
      // than fail the whole export.
      logo.removeAttribute("src");
      logo.hidden = true;
    }

    // The dashed placeholder is a screen-only affordance. Hide it for the whole
    // raster, including when the stored-logo read failed and no image exists.
    if (placeholder) {
      placeholder.hidden = true;
    }

    // Print output always forces logos to grayscale, regardless of the preview
    // toggle. The raster clone would otherwise keep the coloured preview logo.
    logo?.classList.add("print-safe");

    await settleLayout();

    // WebKitGTK reports every `<col>` computed width as 0px in the clone, which
    // collapses fixed-layout columns. Remove the colgroup and pin the measured
    // widths with a hidden zero-height first row instead.
    const headerWidths = Array.from(
      table.querySelectorAll<HTMLTableCellElement>(".sheet-columns th"),
    ).map((cell) => cell.getBoundingClientRect().width);

    colgroup?.remove();
    if (headerWidths.length > 0) {
      widthRow = document.createElement("tr");
      widthRow.className = "export-width-row";
      widthRow.style.cssText = "height:0;font-size:0;line-height:0;visibility:hidden;";
      for (const width of headerWidths) {
        const cell = document.createElement("td");
        cell.style.cssText = `width:${width}px;padding:0;border:0;`;
        widthRow.append(cell);
      }
      thead.insertBefore(widthRow, thead.firstChild);
    }
    table.style.tableLayout = "fixed";

    await settleLayout();
    await waitForImages(sheet);
    await document.fonts.ready;

    if (!rasterWarmedUp) {
      // First capture in a fresh WebView can omit the logo even with a data
      // URL and a fully decoded source. A throwaway small raster warms it up.
      await toCanvas(sheet, {
        canvasWidth: 400,
        canvasHeight: 566,
        pixelRatio: 1,
        backgroundColor: "#ffffff",
        skipAutoScale: true,
      }).catch(() => undefined);
      rasterWarmedUp = true;
    }

    const cssWidth = Math.max(1, sheet.clientWidth);
    const cssHeight = Math.max(1, sheet.clientHeight);
    let rasterWidth = RASTER_WIDTH_PX;
    let canvasHeight = Math.round((rasterWidth * cssHeight) / cssWidth);
    if (canvasHeight > MAX_CANVAS_HEIGHT_PX) {
      // Keep the whole sheet inside WebKit's canvas limit by lowering the
      // effective dpi. There is deliberately no minimum-width floor: a clipped
      // export is worse than a low-dpi one. Normal setlists stay at 300 dpi.
      rasterWidth = Math.max(
        1,
        Math.floor((MAX_CANVAS_HEIGHT_PX * cssWidth) / cssHeight),
      );
      canvasHeight = Math.min(
        MAX_CANVAS_HEIGHT_PX,
        Math.round((rasterWidth * cssHeight) / cssWidth),
      );
    }

    const canvas = await toCanvas(sheet, {
      canvasWidth: rasterWidth,
      canvasHeight,
      pixelRatio: 1,
      backgroundColor: "#ffffff",
      skipAutoScale: true,
    });

    return {
      canvas,
      ...measureSheet(sheet, table, thead, tfoot, canvas),
      restore,
    };
  } catch (error) {
    restore();
    throw error;
  }
}

function measureSheet(
  sheet: HTMLElement,
  table: HTMLTableElement,
  thead: HTMLTableSectionElement,
  tfoot: HTMLTableSectionElement,
  canvas: HTMLCanvasElement,
): Pick<PreparedRaster, "headerBottomPx" | "footerTopPx" | "rowBounds"> {
  const sheetRect = sheet.getBoundingClientRect();
  const scale = canvas.width / Math.max(1, sheet.clientWidth);
  const toCanvasY = (rect: DOMRect): number => (rect.top - sheetRect.top) * scale;

  const headerRect = thead.getBoundingClientRect();
  const headerBottomPx = Math.round(
    (headerRect.bottom - sheetRect.top) * scale,
  );
  const footerTopPx = Math.round(toCanvasY(tfoot.getBoundingClientRect()));

  const rowBounds = Array.from(
    table.querySelectorAll<HTMLTableRowElement>(
      ".song-row, .break-row, .sheet-empty-row",
    ),
  ).map((row) => {
    const rect = row.getBoundingClientRect();
    return {
      top: (rect.top - sheetRect.top) * scale,
      bottom: (rect.bottom - sheetRect.top) * scale,
    };
  });

  return {
    headerBottomPx: clamp(headerBottomPx, 0, canvas.height),
    footerTopPx: clamp(footerTopPx, 0, canvas.height),
    rowBounds,
  };
}

// ---------------------------------------------------------------------------
// PDF
// ---------------------------------------------------------------------------

/**
 * Builds the sliced A4 PDF. Header and footer crops are composited on every
 * page so a multi-page export never ships pages with missing branding or column
 * labels; `Page N / M` is stamped into the bottom margin.
 *
 * Kept separate from the save/open flow so the PDF build can be exercised on a
 * captured raster.
 */
export function buildPdfBytes(prepared: PreparedRaster): Uint8Array {
  const { canvas } = prepared;
  const pdf = new jsPDF({
    orientation: "portrait",
    unit: "mm",
    format: "a4",
    compress: true,
  });

  const pxPerMm = canvas.width / A4_WIDTH_MM;
  const headerPx = clamp(prepared.headerBottomPx, 0, canvas.height);
  const footerTopPx = clamp(prepared.footerTopPx, headerPx, canvas.height);
  const headerMm = headerPx / pxPerMm;
  const footerMm = (canvas.height - footerTopPx) / pxPerMm;
  const availableContentMm = A4_HEIGHT_MM - headerMm - footerMm;
  const composite = availableContentMm >= MIN_COMPOSITE_CONTENT_MM;

  interface PageSlice {
    /** PNG data URL; the slice canvas is released immediately after encoding. */
    image: string;
    yMm: number;
    heightMm: number;
  }

  const pages: PageSlice[] = [];

  if (composite) {
    const contentMm = availableContentMm;
    const slices = sliceContent(
      canvas,
      headerPx,
      footerTopPx,
      contentMm * pxPerMm,
      prepared.rowBounds,
      pxPerMm,
    );
    for (const slice of slices) {
      pages.push({
        image: cropCanvas(canvas, slice.y0, slice.y1).toDataURL("image/png"),
        yMm: headerMm,
        heightMm: (slice.y1 - slice.y0) / pxPerMm,
      });
    }

    const header = cropCanvas(canvas, 0, headerPx);
    const footer = cropCanvas(canvas, footerTopPx, canvas.height);
    const headerImage = header.toDataURL("image/png");
    const footerImage = footer.toDataURL("image/png");

    pages.forEach((page, index) => {
      if (index > 0) pdf.addPage("a4", "portrait");
      pdf.addImage(headerImage, "PNG", 0, 0, A4_WIDTH_MM, headerMm, "export-header", "FAST");
      pdf.addImage(
        page.image,
        "PNG",
        0,
        page.yMm,
        A4_WIDTH_MM,
        page.heightMm,
        `export-slice-${index}`,
        "FAST",
      );
      pdf.addImage(
        footerImage,
        "PNG",
        0,
        A4_HEIGHT_MM - footerMm,
        A4_WIDTH_MM,
        footerMm,
        "export-footer",
        "FAST",
      );
    });
  } else {
    // Pathological header/footer height: keep the spike's raw 271 mm slices.
    // Page 1 carries the brand header and the last page the footer; repeated
    // branding is impossible without eating the whole content area.
    const topMm = PAGE_MARGIN_MM;
    const contentTopPx = topMm * pxPerMm;
    const contentBottomPx = canvas.height - PAGE_MARGIN_MM * pxPerMm;
    const slices = sliceContent(
      canvas,
      contentTopPx,
      contentBottomPx,
      CONTENT_HEIGHT_MM * pxPerMm,
      prepared.rowBounds,
      pxPerMm,
    );
    for (const slice of slices) {
      pages.push({
        image: cropCanvas(canvas, slice.y0, slice.y1).toDataURL("image/png"),
        yMm: topMm,
        heightMm: (slice.y1 - slice.y0) / pxPerMm,
      });
    }
    pages.forEach((page, index) => {
      if (index > 0) pdf.addPage("a4", "portrait");
      pdf.addImage(
        page.image,
        "PNG",
        0,
        page.yMm,
        A4_WIDTH_MM,
        page.heightMm,
        `export-slice-${index}`,
        "FAST",
      );
    });
  }

  const total = pdf.getNumberOfPages();
  pdf.setFont("helvetica", "normal");
  pdf.setFontSize(8);
  for (let index = 1; index <= total; index += 1) {
    pdf.setPage(index);
    pdf.text(
      `Page ${index} / ${total}`,
      A4_WIDTH_MM - 12,
      A4_HEIGHT_MM - 5,
      { align: "right" },
    );
  }

  return new Uint8Array(pdf.output("arraybuffer"));
}

interface SliceBounds {
  y0: number;
  y1: number;
}

/** Slice `[top, bottom]` at `maxHeightPx`, snapping before a split row. */
function sliceContent(
  canvas: HTMLCanvasElement,
  top: number,
  bottom: number,
  maxHeightPx: number,
  rowBounds: RowBounds[],
  pxPerMm: number,
): SliceBounds[] {
  const slices: SliceBounds[] = [];
  const start = clamp(Math.round(top), 0, canvas.height);
  const end = clamp(Math.round(bottom), start, canvas.height);
  const maxHeight = Math.max(1, maxHeightPx);
  let y = start;

  while (y < end - 0.5) {
    let sliceEnd = Math.min(y + maxHeight, end);

    const straddler = rowBounds.find(
      (row) => row.top > y + 1 && row.top < sliceEnd - 1 && row.bottom > sliceEnd + 1,
    );
    if (straddler) sliceEnd = straddler.top;

    if (sliceEnd - y < MIN_SLICE_MM * pxPerMm) {
      sliceEnd = Math.min(y + maxHeight, end);
    }
    if (sliceEnd <= y + 0.5) break;

    slices.push({ y0: y, y1: sliceEnd });
    y = sliceEnd;
  }

  return slices;
}

function cropCanvas(
  source: HTMLCanvasElement,
  y0: number,
  y1: number,
): HTMLCanvasElement {
  const top = clamp(Math.round(y0), 0, source.height);
  const bottom = clamp(Math.round(y1), top + 1, source.height);
  const slice = document.createElement("canvas");
  slice.width = source.width;
  slice.height = Math.max(1, bottom - top);
  const context = slice.getContext("2d");
  if (!context) throw new Error("Could not create a 2D canvas for export.");
  context.fillStyle = "#ffffff";
  context.fillRect(0, 0, slice.width, slice.height);
  context.drawImage(
    source,
    0,
    top,
    source.width,
    slice.height,
    0,
    0,
    source.width,
    slice.height,
  );
  return slice;
}

// ---------------------------------------------------------------------------
// PNG
// ---------------------------------------------------------------------------

/**
 * A single full-sheet PNG at 300 dpi for normal sheets. A sheet shorter than one
 * A4 page is padded to the standard 300 dpi A4 raster; longer sheets stay tall
 * (the full setlist in one file).
 */
export function buildPngBytes(canvas: HTMLCanvasElement): Uint8Array {
  const target = document.createElement("canvas");
  target.width = canvas.width;
  // A short sheet is padded to the standard 300 dpi A4 raster. A long sheet is
  // already taller than one page and keeps its full height (max()).
  target.height = Math.max(canvas.height, A4_HEIGHT_PX);
  const context = target.getContext("2d");
  if (!context) throw new Error("Could not create a 2D canvas for export.");
  context.fillStyle = "#ffffff";
  context.fillRect(0, 0, target.width, target.height);
  context.drawImage(canvas, 0, 0);

  const dataUrl = target.toDataURL("image/png");
  const separator = dataUrl.indexOf(",");
  return decodeBase64(dataUrl.slice(separator + 1));
}

// ---------------------------------------------------------------------------
// File handling
// ---------------------------------------------------------------------------

async function promptForPath(fileName: string, format: ExportFormat): Promise<string | null> {
  let defaultPath = fileName;
  try {
    defaultPath = await join(await downloadDir(), fileName);
  } catch {
    // Fall back to a bare file name; the dialog still opens in a user folder.
  }

  const result = await save({
    title: format === "pdf" ? "Export setlist as PDF" : "Export setlist as PNG",
    defaultPath,
    canCreateDirectories: true,
    filters: [
      {
        name: format === "pdf" ? "PDF document" : "PNG image",
        extensions: [format],
      },
    ],
  });
  return result ?? null;
}

function exportFileName(title: string, extension: ExportFormat): string {
  const base = title
    .trim()
    .replace(/[\u0000-\u001f\\/:*?"<>|]/g, "")
    .replace(/\s+/g, " ")
    .slice(0, 80)
    .trim();
  return `${base || "setlist"}.${extension}`;
}

// ---------------------------------------------------------------------------
// Small helpers
// ---------------------------------------------------------------------------

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}

function settleLayout(): Promise<void> {
  return new Promise((resolve) => {
    requestAnimationFrame(() => requestAnimationFrame(() => resolve()));
  });
}

function decodeImage(image: HTMLImageElement): Promise<void> {
  if (image.complete) {
    // A broken image also reports complete; decode rejects and the export
    // continues without a logo instead of hanging forever.
    return image.decode?.().catch(() => undefined) ?? Promise.resolve();
  }
  return new Promise((resolve) => {
    image.addEventListener("load", () => resolve(), { once: true });
    image.addEventListener("error", () => resolve(), { once: true });
  });
}

async function waitForImages(root: ParentNode): Promise<void> {
  const images = Array.from(root.querySelectorAll("img"));
  await Promise.all(
    images.map(async (image) => {
      if (!image.complete) {
        await new Promise<void>((resolve) => {
          image.addEventListener("load", () => resolve(), { once: true });
          image.addEventListener("error", () => resolve(), { once: true });
        });
      }
      await image.decode?.().catch(() => undefined);
    }),
  );
}

function decodeBase64(base64: string): Uint8Array {
  const binary = atob(base64);
  const bytes = new Uint8Array(binary.length);
  for (let index = 0; index < binary.length; index += 1) {
    bytes[index] = binary.charCodeAt(index);
  }
  return bytes;
}

function describeError(error: unknown): string {
  if (typeof error === "string") return error;
  if (error instanceof Error) return error.message;
  return String(error);
}
