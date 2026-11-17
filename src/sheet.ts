/**
 * Renders the printable A4 sheet.
 *
 * Hard rule: this subtree is always black text on a white background. The only
 * optional visual treatment is a grayscale logo filter, which is print-safe.
 * Do not add dark-stage styling here.
 */

import { el } from "./dom";
import { formatDuration, formatGigDate, formatRuntime, setlistDurationSecs } from "./format";
import type { LogoAlignment, Setlist, Song } from "./types";

export interface SheetOptions {
  logoUrl: string | null;
  grayscaleLogo: boolean;
  /** Called when the logo changes the sheet height (load/error). */
  onLogoLayout?: () => void;
}

export function renderSetlistSheet(
  root: HTMLElement,
  setlist: Setlist,
  options: SheetOptions,
): void {
  const title = setlist.title.trim() || "Untitled setlist";
  const date = formatGigDate(setlist.date);
  const totalSecs = setlistDurationSecs(setlist);
  const songCount = setlist.items.filter((item) => "Song" in item).length;
  const hasTuning = setlist.items.some(
    (item) => "Song" in item && Boolean(item.Song.tuning?.trim()),
  );

  // The tuning column only exists when at least one song needs it, so a
  // setlist without retunes keeps the baseline five-column layout.
  const columns: Array<[string, string]> = [
    ["#", "col-index"],
    ["Song", "col-song"],
    ["Key", "col-key"],
    ...(hasTuning ? [["Tuning", "col-tuning"] as [string, string]] : []),
    ["BPM", "col-bpm"],
    ["Time", "col-time"],
  ];
  const columnCount = columns.length;

  const table = el("table", hasTuning ? "sheet-table has-tuning" : "sheet-table");
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
        tbody.append(buildSongRow(item.Song, songNumber, hasTuning));
      } else {
        tbody.append(
          buildBreakRow(
            item.Break.duration_mins,
            item.Break.note,
            item.Break.label,
            columnCount,
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
  options: SheetOptions,
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

function buildSongRow(song: Song, number: number, hasTuning: boolean): HTMLTableRowElement {
  const row = el("tr", "song-row");
  row.append(cell("col-index tabular", String(number)));

  const songCell = el("td", "col-song song-cell");
  songCell.append(el("span", "song-title", song.title));
  if (song.artist?.trim()) {
    songCell.append(el("span", "song-artist", song.artist.trim()));
  }
  // Feature 4 will gate the song comment behind `show_comment`; keeping the
  // lookup in a helper means that toggle only changes this call.
  const commentText = songCommentText(song.notes);
  if (commentText) songCell.append(el("span", "song-notes", commentText));
  row.append(songCell);

  row.append(cell("col-key tabular", song.key?.trim() || "—"));
  if (hasTuning) {
    row.append(cell("col-tuning tabular", song.tuning?.trim() || "—"));
  }
  row.append(cell("col-bpm tabular", song.bpm ? String(song.bpm) : "—"));
  row.append(cell("col-time tabular", song.duration_secs != null ? formatDuration(song.duration_secs) : "—"));

  return row;
}

function buildBreakRow(
  durationMins: number,
  note: string | null,
  label: string | null | undefined,
  columnCount: number,
): HTMLTableRowElement {
  const row = el("tr", "break-row");
  const cellNode = el("td", "break-cell");
  cellNode.colSpan = columnCount;

  // Feature 4 will gate the label and comment behind `show_comment`; keeping
  // both text lookups in helpers means that toggle only changes these two
  // calls. The duration is structural and always renders.
  const labelText = breakLabelText(label);
  const commentText = breakCommentText(note);
  if (labelText) cellNode.append(el("span", "break-label", labelText));
  cellNode.append(el("span", "break-duration tabular", `${durationMins} min`));
  if (commentText) cellNode.append(el("span", "break-note", commentText));

  row.append(cellNode);
  return row;
}

/** Song comment, or `null` when empty (Feature 4 will also gate it). */
function songCommentText(note: string | null | undefined): string | null {
  const trimmed = note?.trim();
  return trimmed ? trimmed : null;
}

/** Custom label, falling back to the generic `Break` heading. */
function breakLabelText(label: string | null | undefined): string {
  return label?.trim() || "Break";
}

/** Break comment, or `null` when empty (Feature 4 will also gate it). */
function breakCommentText(note: string | null | undefined): string | null {
  const trimmed = note?.trim();
  return trimmed ? trimmed : null;
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
