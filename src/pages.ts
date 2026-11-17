/**
 * Multi-page preview frames.
 *
 * The tall sheet remains the layout + export source (the exporter in
 * `exporter.ts` still captures one full-height table). For `page_mode:
 * Multiple` the preview and the native print path show this frame stack
 * instead: one A4 frame per page, each with its own cloned brand header
 * (logo, title, venue/date, column labels) and footer. Rows are grouped by
 * measured height, so no row ever straddles a page boundary.
 *
 * Hard rule: frames are black on white, exactly like `#setlist-sheet`.
 * Layout is measured from the source sheet at `--sheet-scale: 1` (the preview
 * transform is divided out), so the split does not depend on the window width.
 */

import { el } from "./dom";

const MM_TO_PX = 96 / 25.4;

/** One A4 content box: 297 mm minus the 13 mm top/bottom page margins. */
export const A4_CONTENT_HEIGHT_PX = (297 - 13 * 2) * MM_TO_PX;

/** Keep the group measurably under the page cap so print rounding cannot add a sliver page. */
const PAGE_SAFETY_PX = 0.5;

export interface PageFrameOptions {
  /** CSS scale applied to the source sheet by the preview (`--sheet-scale`). */
  previewScale: number;
}

/**
 * Splits the rendered source sheet's body rows into A4 page frames and renders
 * them into `target`. Returns the frame count (the exact page count, replacing
 * the old `≈ N` estimate).
 *
 * Header and footer heights are measured from the source table, so the body
 * capacity here matches the exporter's composited header/footer slices.
 */
export function renderSheetPages(
  source: HTMLElement,
  target: HTMLElement,
  options: PageFrameOptions,
): number {
  target.replaceChildren();

  const table = source.querySelector<HTMLTableElement>(".sheet-table");
  const thead = table?.tHead;
  const tbody = table?.tBodies[0];
  const tfoot = table?.tFoot;
  if (!table || !thead || !tbody || !tfoot) return 0;

  const previewScale =
    Number.isFinite(options.previewScale) && options.previewScale > 0
      ? options.previewScale
      : 1;
  const heightOf = (element: Element): number =>
    element.getBoundingClientRect().height / previewScale;

  const headerHeight = heightOf(thead);
  const footerHeight = heightOf(tfoot);
  const capacity = A4_CONTENT_HEIGHT_PX - headerHeight - footerHeight - PAGE_SAFETY_PX;

  const rows = Array.from(tbody.rows);
  const groups: HTMLTableRowElement[][] = [];
  let group: HTMLTableRowElement[] = [];
  let used = 0;

  for (const row of rows) {
    const height = heightOf(row);
    // Never split a row: measure the whole row and start a new frame when it
    // would cross the boundary. A row taller than a page still gets its own
    // frame (it cannot be made shorter here).
    if (group.length > 0 && used + height > capacity) {
      groups.push(group);
      group = [];
      used = 0;
    }
    group.push(row);
    used += height;
  }
  if (group.length > 0 || groups.length === 0) groups.push(group);

  const footerSource = tfoot.querySelector<HTMLElement>(".sheet-footer");
  const fragment = document.createDocumentFragment();

  for (const pageRows of groups) {
    const page = el("div", "sheet-page");

    // Clone the table so each frame carries the same `<colgroup>`, brand header,
    // and column labels as the source, then keep only this page's body rows.
    const clone = table.cloneNode(true) as HTMLTableElement;
    clone.tFoot?.remove();
    const cloneBody = clone.tBodies[0];
    if (cloneBody) {
      cloneBody.replaceChildren(...pageRows.map((row) => row.cloneNode(true)));
    }
    page.append(clone);

    if (footerSource) {
      // The footer is pinned to the bottom of the A4 frame (margin-top: auto),
      // matching the export, which composites the footer at the page bottom on
      // every page. It is cloned per frame, not moved.
      const footer = el("div", "sheet-page-footer");
      footer.append(footerSource.cloneNode(true));
      page.append(footer);
    }

    fragment.append(page);
  }

  target.replaceChildren(fragment);
  return groups.length;
}
