/**
 * Renders the printable A4 sheet.
 *
 * Hard rule: this subtree is always black text on a white background. The only
 * optional visual treatment is a grayscale logo filter, which is print-safe.
 * Do not add dark-stage styling here.
 */

import { el } from "./dom";
import { formatDuration, formatGigDate, formatRuntime, setlistDurationSecs } from "./format";
import { withSheetDefaults } from "./types";
import type { LogoAlignment, Setlist, Song } from "./types";

export interface SheetRenderOptions {
  logoUrl: string | null;
  grayscaleLogo: boolean;
  /** Called when the logo changes the sheet height (load/error). */
  onLogoLayout?: () => void;
}

interface SheetVisibility {
  hasTuning: boolean;
  showKey: boolean;
  showTempo: boolean;
  showDuration: boolean;
  showComment: boolean;
}

type InfoColumn = "key" | "tuning" | "bpm" | "time";

/** Info columns in canonical order; widths are keyed off the visible subset. */
const INFO_COLUMNS: ReadonlyArray<{
  key: InfoColumn;
  label: string;
  className: string;
}> = [
  { key: "key", label: "Key", className: "col-key" },
  { key: "tuning", label: "Tuning", className: "col-tuning" },
  // The editor toggle says "Tempo (BPM)"; the sheet keeps the compact BPM
  // heading so it stays legible in the narrow numeric column.
  { key: "bpm", label: "BPM", className: "col-bpm" },
  { key: "time", label: "Time", className: "col-time" },
];

export function renderSetlistSheet(
  root: HTMLElement,
  setlist: Setlist,
  options: SheetRenderOptions,
): void {
  const title = setlist.title.trim() || "Untitled setlist";
  const date = formatGigDate(setlist.date);
  const totalSecs = setlistDurationSecs(setlist);
  const songCount = setlist.items.filter((item) => "Song" in item).length;
  const sheetOptions = withSheetDefaults(setlist.sheet_options);

  // The tuning column only exists when the toggle is on *and* at least one
  // song needs it, so a setlist without retunes keeps the narrower layout.
  const visibility: SheetVisibility = {
    hasTuning:
      sheetOptions.show_tuning &&
      setlist.items.some((item) => "Song" in item && Boolean(item.Song.tuning?.trim())),
    showKey: sheetOptions.show_key,
    showTempo: sheetOptions.show_tempo,
    showDuration: sheetOptions.show_duration,
    showComment: sheetOptions.show_comment,
  };

  const infoColumns = INFO_COLUMNS.filter((column) => {
    switch (column.key) {
      case "key":
        return visibility.showKey;
      case "tuning":
        return visibility.hasTuning;
      case "bpm":
        return visibility.showTempo;
      case "time":
        return visibility.showDuration;
    }
  });

  const columns: Array<[string, string]> = [
    ["#", "col-index"],
    ["Song", "col-song"],
    ...infoColumns.map((column): [string, string] => [column.label, column.className]),
  ];
  const columnCount = columns.length;

  const table = el("table", sheetTableClass(infoColumns.map((column) => column.key)));
  const caption = el(
    "caption",
    "sr-only",
    `Setlist ${title}${setlist.venue ? ` at ${setlist.venue}` : ""}`,
  );
  table.append(caption);

  // Fixed table layout takes column widths from <colgroup>; without it the
  // full-width brand row (colspan) would give every column an equal share.
  const colgroup = document.createElement("colgroup");
  for (const [, className] of columns) {
    const column = document.createElement("col");
    column.className = className;
    colgroup.append(column);
  }
  table.append(colgroup);

  const thead = el("thead");
  const brandRow = el("tr", "sheet-brand-row");
  const brandCell = el("th", "sheet-brand-cell");
  brandCell.colSpan = columnCount;
  brandCell.append(buildBrand(setlist, title, date, options));
  brandRow.append(brandCell);
  thead.append(brandRow);

  const columnRow = el("tr", "sheet-columns");
  for (const [label, className] of columns) {
    const heading = el("th", className, label);
    heading.scope = "col";
    columnRow.append(heading);
  }
  thead.append(columnRow);
  table.append(thead);

  const tbody = el("tbody");
  if (setlist.items.length === 0) {
    const emptyRow = el("tr", "sheet-empty-row");
    const emptyCell = el("td", "sheet-empty-cell", "No songs yet — add songs from the library.");
    emptyCell.colSpan = columnCount;
    emptyRow.append(emptyCell);
    tbody.append(emptyRow);
  } else {
    let songNumber = 0;
    for (const item of setlist.items) {
      if ("Song" in item) {
        songNumber += 1;
        tbody.append(buildSongRow(item.Song, songNumber, visibility));
      } else {
        tbody.append(
          buildBreakRow(
            item.Break.duration_mins,
            item.Break.note,
            item.Break.label,
            columnCount,
            visibility.showComment,
          ),
        );
      }
    }
  }
  table.append(tbody);

  const tfoot = el("tfoot");
  const footerRow = el("tr", "sheet-footer-row");
  const footerCell = el("td", "sheet-footer-cell");
  footerCell.colSpan = columnCount;
  const footer = el("div", "sheet-footer");
  footer.append(
    el("span", "sheet-footer-title", title),
    el(
      "span",
      "sheet-footer-meta",
      `${songCount} ${songCount === 1 ? "song" : "songs"} · ${formatRuntime(totalSecs)} · StageSheet`,
    ),
  );
  footerCell.append(footer);
  footerRow.append(footerCell);
  tfoot.append(footerRow);
  table.append(tfoot);

  root.replaceChildren(table);
}

function buildBrand(
  setlist: Setlist,
  title: string,
  date: string | null,
  options: SheetRenderOptions,
): HTMLElement {
  const brand = el("div", "sheet-brand");

  if (setlist.logo.file_name) {
    const logoRow = el("div", `sheet-logo-row ${alignmentClass(setlist.logo.alignment)}`);
    if (options.logoUrl) {
      const image = el("img", "sheet-logo");
      image.src = options.logoUrl;
      image.alt = "Band logo";
      image.style.width = `${setlist.logo.width_mm}mm`;
      image.classList.toggle("print-safe", options.grayscaleLogo);
      image.addEventListener("load", () => options.onLogoLayout?.());
      image.addEventListener("error", () => {
        // Do not print a broken-image icon or its alt text.
        image.hidden = true;
        options.onLogoLayout?.();
      });
      logoRow.append(image);
    } else {
      const placeholder = el("span", "sheet-logo-placeholder no-print", "Logo");
      placeholder.style.width = `${setlist.logo.width_mm}mm`;
      logoRow.append(placeholder);
    }
    brand.append(logoRow);
  }

  const titleBlock = el("div", "sheet-title-block");
  titleBlock.append(el("p", "sheet-kicker", "Setlist"));
  titleBlock.append(el("h2", "sheet-title", title));

  const metaParts = [setlist.venue?.trim(), date].filter(
    (part): part is string => Boolean(part),
  );
  if (metaParts.length > 0) {
    titleBlock.append(el("p", "sheet-meta", metaParts.join("  ·  ")));
  }

  brand.append(titleBlock);
  return brand;
}

function buildSongRow(
  song: Song,
  number: number,
  visibility: SheetVisibility,
): HTMLTableRowElement {
  const row = el("tr", "song-row");
  row.append(cell("col-index tabular", String(number)));

  const songCell = el("td", "col-song song-cell");
  songCell.append(el("span", "song-title", song.title));
  // The artist line is part of the song identity and always shows.
  if (song.artist?.trim()) {
    songCell.append(el("span", "song-artist", song.artist.trim()));
  }
  const commentText = visibility.showComment ? songCommentText(song.notes) : null;
  if (commentText) songCell.append(el("span", "song-notes", commentText));
  row.append(songCell);

  if (visibility.showKey) {
    row.append(cell("col-key tabular", song.key?.trim() || "—"));
  }
  if (visibility.hasTuning) {
    row.append(cell("col-tuning tabular", song.tuning?.trim() || "—"));
  }
  if (visibility.showTempo) {
    row.append(cell("col-bpm tabular", song.bpm ? String(song.bpm) : "—"));
  }
  if (visibility.showDuration) {
    row.append(
      cell(
        "col-time tabular",
        song.duration_secs != null ? formatDuration(song.duration_secs) : "—",
      ),
    );
  }

  return row;
}

function buildBreakRow(
  durationMins: number,
  note: string | null,
  label: string | null | undefined,
  columnCount: number,
  showComment: boolean,
): HTMLTableRowElement {
  const row = el("tr", "break-row");
  const cellNode = el("td", "break-cell");
  cellNode.colSpan = columnCount;

  // The duration is structural and always renders. There is no separate label
  // toggle, so the Comment toggle gates both the label and the comment; with
  // it off the row is just `N min`.
  const labelText = showComment ? breakLabelText(label) : null;
  const commentText = showComment ? breakCommentText(note) : null;
  if (labelText) cellNode.append(el("span", "break-label", labelText));
  cellNode.append(el("span", "break-duration tabular", `${durationMins} min`));
  if (commentText) cellNode.append(el("span", "break-note", commentText));

  row.append(cellNode);
  return row;
}

/** Song comment, or `null` when empty or the Comment toggle is off. */
function songCommentText(note: string | null | undefined): string | null {
  const trimmed = note?.trim();
  return trimmed ? trimmed : null;
}

/** Custom label, falling back to the generic `Break` heading. */
function breakLabelText(label: string | null | undefined): string {
  return label?.trim() || "Break";
}

/** Break comment, or `null` when empty. */
function breakCommentText(note: string | null | undefined): string | null {
  const trimmed = note?.trim();
  return trimmed ? trimmed : null;
}

/**
 * Width preset for the visible info-column combination. The presets are
 * per-combination, not per-count: every visible set sums to 100% in app.css so
 * fixed table layout does not redistribute slack. `.cols-5` and
 * `.cols-5-tuning` are the Feature 4 / Feature 1 anchors; the rest are derived
 * from the same proportions. Keep this mapping in sync with app.css.
 */
function sheetTableClass(infoColumns: readonly InfoColumn[]): string {
  if (infoColumns.length === 0) return "sheet-table cols-2";
  if (infoColumns.length === 1) return `sheet-table cols-3-${infoColumns[0]}`;
  if (infoColumns.length === 2) return `sheet-table cols-4-${infoColumns.join("-")}`;
  if (infoColumns.length === 3) {
    // `.cols-5` is the verified key/bpm/time anchor; its narrow columns are
    // interchangeable, so it also covers tuning/time and key/tuning/time.
    return infoColumns.includes("time")
      ? "sheet-table cols-5"
      : "sheet-table cols-5-no-time";
  }
  return "sheet-table cols-5-tuning";
}

function cell(className: string, text: string): HTMLTableCellElement {
  return el("td", className, text);
}

function alignmentClass(alignment: LogoAlignment): string {
  switch (alignment) {
    case "Left":
      return "align-left";
    case "Right":
      return "align-right";
    case "Center":
      return "align-center";
  }
}
