import "./styles/app.css";
import "./styles/print.css";

import { api } from "./api";
import { byId, el } from "./dom";
import {
  durationInputValue,
  formatDuration,
  formatRuntime,
  parseDuration,
  setlistDurationSecs,
} from "./format";
import { storedLogoUrl } from "./logo";
import { renderSetlistSheet } from "./sheet";
import type { LogoAlignment, Setlist, Song } from "./types";
import {
  DEFAULT_LOGO_WIDTH_MM,
  LOGO_MAX_WIDTH_MM,
  LOGO_MIN_WIDTH_MM,
} from "./types";

const A4_WIDTH_PX = (210 / 25.4) * 96;
const A4_HEIGHT_PX = (297 / 25.4) * 96;
const SHEET_FIT_MIN = 0.5;
const SHEET_FIT_STEP = 0.05;

// ---------------------------------------------------------------------------
// State
// ---------------------------------------------------------------------------

let songs: Song[] = [];
let setlists: Setlist[] = [];
let current: Setlist | null = null;
let dirty = false;
let backendAvailable = true;
let logoSrc: string | null = null;
let logoRequestId = 0;
let statusTimer: number | undefined;
/** Logo files to delete only after a setlist save succeeds. */
const pendingLogoRemovals = new Set<string>();

// ---------------------------------------------------------------------------
// Elements
// ---------------------------------------------------------------------------

const statusEl = byId<HTMLParagraphElement>("status");

const setlistSelect = byId<HTMLSelectElement>("setlist-select");
const newSetlistButton = byId<HTMLButtonElement>("new-setlist");
const saveSetlistButton = byId<HTMLButtonElement>("save-setlist");
const printButton = byId<HTMLButtonElement>("print-setlist");
const deleteSetlistButton = byId<HTMLButtonElement>("delete-setlist");

const songSearch = byId<HTMLInputElement>("song-search");
const songListEl = byId<HTMLUListElement>("song-list");
const songCountEl = byId<HTMLSpanElement>("song-count");
const songForm = byId<HTMLFormElement>("song-form");
const newSongTitle = byId<HTMLInputElement>("new-song-title");
const newSongArtist = byId<HTMLInputElement>("new-song-artist");
const newSongKey = byId<HTMLInputElement>("new-song-key");
const newSongBpm = byId<HTMLInputElement>("new-song-bpm");
const newSongDuration = byId<HTMLInputElement>("new-song-duration");
const newSongNotes = byId<HTMLInputElement>("new-song-notes");

const titleInput = byId<HTMLInputElement>("setlist-title");
const venueInput = byId<HTMLInputElement>("setlist-venue");
const dateInput = byId<HTMLInputElement>("setlist-date");
const dirtyIndicator = byId<HTMLSpanElement>("dirty-indicator");
const setlistSummary = byId<HTMLParagraphElement>("setlist-summary");

const itemList = byId<HTMLOListElement>("item-list");
const emptyItems = byId<HTMLParagraphElement>("empty-items");
const addBreakButton = byId<HTMLButtonElement>("add-break");

const logoFileInput = byId<HTMLInputElement>("logo-file");
const logoRemoveButton = byId<HTMLButtonElement>("logo-remove");
const logoWidthInput = byId<HTMLInputElement>("logo-width");
const logoWidthOutput = byId<HTMLOutputElement>("logo-width-value");
const alignmentRadios = Array.from(
  document.querySelectorAll<HTMLInputElement>('input[name="logo-alignment"]'),
);
const grayscaleLogoInput = byId<HTMLInputElement>("logo-grayscale");

const sheet = byId<HTMLDivElement>("setlist-sheet");
const sheetFrame = byId<HTMLDivElement>("sheet-frame");
const sheetScroll = byId<HTMLDivElement>("sheet-scroll");
const previewMeta = byId<HTMLParagraphElement>("preview-meta");

// ---------------------------------------------------------------------------
// Boot
// ---------------------------------------------------------------------------

function bindEvents(): void {
  newSetlistButton.addEventListener("click", () => {
    void startNewSetlist();
  });
  saveSetlistButton.addEventListener("click", () => {
    void saveCurrent();
  });
  printButton.addEventListener("click", () => {
    void printCurrent();
  });
  deleteSetlistButton.addEventListener("click", () => {
    void deleteCurrent();
  });
  setlistSelect.addEventListener("change", () => {
    void handleSetlistChange();
  });

  titleInput.addEventListener("input", () => {
    if (!current) return;
    current.title = titleInput.value;
    markDirty();
    renderSetlistSelect();
    renderSheet();
  });
  venueInput.addEventListener("input", () => {
    if (!current) return;
    current.venue = trimmedOrNull(venueInput.value);
    markDirty();
    renderSheet();
  });
  dateInput.addEventListener("input", () => {
    if (!current) return;
    current.date = dateInput.value || null;
    markDirty();
    renderSheet();
  });

  songSearch.addEventListener("input", renderLibrary);
  songForm.addEventListener("submit", (event) => {
    void handleSongSubmit(event);
  });
  addBreakButton.addEventListener("click", addBreak);

  itemList.addEventListener("click", handleItemClick);
  bindDragReorder();

  logoFileInput.addEventListener("change", () => {
    void handleLogoFile();
  });
  logoRemoveButton.addEventListener("click", handleLogoRemove);
  logoWidthInput.addEventListener("input", () => {
    if (!current) return;
    current.logo.width_mm = clamp(
      Number(logoWidthInput.value),
      LOGO_MIN_WIDTH_MM,
      LOGO_MAX_WIDTH_MM,
    );
    logoWidthOutput.textContent = `${Math.round(current.logo.width_mm)} mm`;
    markDirty();
    renderSheet();
  });
  for (const radio of alignmentRadios) {
    radio.addEventListener("change", () => {
      if (!current || !radio.checked || !isLogoAlignment(radio.value)) return;
      current.logo.alignment = radio.value;
      markDirty();
      renderSheet();
    });
  }
  grayscaleLogoInput.addEventListener("change", renderSheet);

  window.addEventListener("keydown", (event) => {
    if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === "s") {
      event.preventDefault();
      void saveCurrent();
    }
  });

  window.addEventListener("beforeunload", (event) => {
    if (!dirty) return;
    event.preventDefault();
    event.returnValue = "";
  });

  if (typeof ResizeObserver !== "undefined") {
    new ResizeObserver(fitPreview).observe(sheetScroll);
  } else {
    window.addEventListener("resize", fitPreview);
  }
}

async function init(): Promise<void> {
  logoWidthInput.min = String(LOGO_MIN_WIDTH_MM);
  logoWidthInput.max = String(LOGO_MAX_WIDTH_MM);
  bindEvents();

  try {
    const [loadedSongs, loadedSetlists] = await Promise.all([
      api.listSongs(),
      api.listSetlists(),
    ]);
    songs = loadedSongs.sort((left, right) => left.title.localeCompare(right.title));
    setlists = loadedSetlists;
    current = setlists[0] ? cloneSetlist(setlists[0]) : createDraft();
    dirty = setlists.length === 0;
  } catch (error) {
    backendAvailable = false;
    current = createDraft();
    dirty = true;
    setStatus(
      `Local backend unavailable (${describeError(error)}). Run the desktop app with \`npm run tauri dev\`.`,
      "error",
    );
  }

  renderAll();
  if (backendAvailable && !dirty) {
    await loadLogoForCurrent();
  }
  fitPreview();
  document.fonts.ready.then(fitSheetToPage).catch(() => undefined);
}

// ---------------------------------------------------------------------------
// Setlist lifecycle
// ---------------------------------------------------------------------------

function createDraft(): Setlist {
  const now = new Date().toISOString();
  return {
    id: newId(),
    title: "Untitled setlist",
    venue: null,
    date: null,
    items: [],
    logo: {
      file_name: null,
      width_mm: DEFAULT_LOGO_WIDTH_MM,
      alignment: "Center",
    },
    created_at: now,
    updated_at: now,
  };
}

function cloneSetlist(setlist: Setlist): Setlist {
  return {
    ...setlist,
    items: setlist.items.map((item) =>
      "Song" in item ? { Song: { ...item.Song } } : { Break: { ...item.Break } },
    ),
    logo: { ...setlist.logo },
  };
}

async function startNewSetlist(): Promise<void> {
  if (!confirmDiscard()) return;

  pendingLogoRemovals.clear();
  current = createDraft();
  dirty = true;
  clearLogoPreview();
  logoFileInput.value = "";
  renderAll();
  titleInput.focus();
  titleInput.select();
}

async function handleSetlistChange(): Promise<void> {
  if (!current) return;

  const next = setlists.find((setlist) => setlist.id === setlistSelect.value);
  if (!next || next.id === current.id) {
    setlistSelect.value = current.id;
    return;
  }

  if (!confirmDiscard()) {
    setlistSelect.value = current.id;
    return;
  }

  pendingLogoRemovals.clear();
  clearLogoPreview();
  current = cloneSetlist(next);
  dirty = false;
  dirtyIndicator.hidden = true;
  renderAll();
  await loadLogoForCurrent();
  fitPreview();
}

async function saveCurrent(): Promise<boolean> {
  if (!current) return false;

  if (!backendAvailable) {
    setStatus("Backend unavailable — changes cannot be saved.", "error");
    return false;
  }

  current.title = current.title.trim();
  if (!current.title) {
    setStatus("Give the setlist a title before saving.", "error");
    titleInput.focus();
    return false;
  }
  titleInput.value = current.title;

  try {
    const saved = await api.saveSetlist(current);
    current = saved;
    dirty = false;
    dirtyIndicator.hidden = true;

    // Keep the editor copy separate from the cache so discarding an edit never
    // mutates the last saved version.
    const cached = cloneSetlist(saved);
    const existingIndex = setlists.findIndex((setlist) => setlist.id === saved.id);
    if (existingIndex >= 0) {
      setlists[existingIndex] = cached;
    } else {
      setlists.push(cached);
    }
    sortSetlists();

    await cleanupPendingLogoRemovals();

    renderMeta();
    renderSetlistSelect();
    renderSheet();

    // Rust is the authority for the saved duration; the local sum is only a
    // fallback if the follow-up call fails for an unrelated reason.
    const totalSecs = await api
      .setlistDuration(saved.id)
      .catch(() => setlistDurationSecs(saved));
    setStatus(
      `Saved “${saved.title}” · ${formatRuntime(totalSecs)} total runtime.`,
      "success",
    );
    return true;
  } catch (error) {
    setStatus(`Could not save: ${describeError(error)}`, "error");
    return false;
  }
}

async function deleteCurrent(): Promise<void> {
  if (!current) return;

  const persisted = setlists.some((setlist) => setlist.id === current?.id);
  const message = persisted
    ? `Delete “${current.title}”? This cannot be undone.`
    : "Discard this unsaved setlist?";
  if (!window.confirm(message)) return;

  const persistedVersion = setlists.find((setlist) => setlist.id === current?.id);
  if (persisted) {
    if (!ensureBackend()) return;
    try {
      await api.deleteSetlist(current.id);
      setlists = setlists.filter((setlist) => setlist.id !== current?.id);

      const detachedLogo = persistedVersion?.logo.file_name;
      if (detachedLogo && !setlists.some((setlist) => setlist.logo.file_name === detachedLogo)) {
        await api.removeLogo(detachedLogo).catch(() => undefined);
      }
    } catch (error) {
      setStatus(`Could not delete: ${describeError(error)}`, "error");
      return;
    }
  }

  pendingLogoRemovals.clear();
  clearLogoPreview();
  current = setlists[0] ? cloneSetlist(setlists[0]) : createDraft();
  dirty = setlists.length === 0;
  renderAll();
  if (backendAvailable && !dirty) {
    await loadLogoForCurrent();
  }
}

async function printCurrent(): Promise<void> {
  if (!current) return;

  if (dirty && backendAvailable) {
    const saved = await saveCurrent();
    if (!saved) return;
  }

  renderSheet();
  await new Promise<void>((resolve) => {
    requestAnimationFrame(() => resolve());
  });
  window.print();
}

function confirmDiscard(): boolean {
  if (!dirty) return true;
  return window.confirm("Discard unsaved changes to this setlist?");
}

function sortSetlists(): void {
  setlists.sort((left, right) => {
    const byUpdate = Date.parse(right.updated_at) - Date.parse(left.updated_at);
    if (Number.isFinite(byUpdate) && byUpdate !== 0) {
      return byUpdate;
    }
    return left.title.localeCompare(right.title);
  });
}

// ---------------------------------------------------------------------------
// Rendering
// ---------------------------------------------------------------------------

function renderAll(): void {
  renderSetlistSelect();
  renderMeta();
  renderLogoControls();
  renderItems();
  renderLibrary();
  renderSheet();
}

function renderSetlistSelect(): void {
  const fragment = document.createDocumentFragment();
  const options = [...setlists];

  if (current && !options.some((setlist) => setlist.id === current?.id)) {
    options.unshift(current);
  }

  for (const setlist of options) {
    const option = document.createElement("option");
    option.value = setlist.id;
    const isCurrent = current?.id === setlist.id;
    const unsaved = isCurrent && !setlists.some((item) => item.id === setlist.id);
    const title = isCurrent ? current?.title : setlist.title;
    option.textContent = `${title?.trim() || "Untitled setlist"}${unsaved ? " (unsaved)" : ""}`;
    fragment.append(option);
  }

  setlistSelect.replaceChildren(fragment);
  if (current) {
    setlistSelect.value = current.id;
  }
}

function renderMeta(): void {
  if (!current) return;

  titleInput.value = current.title;
  venueInput.value = current.venue ?? "";
  dateInput.value = current.date ?? "";

  const persisted = setlists.some((setlist) => setlist.id === current?.id);
  deleteSetlistButton.textContent = persisted ? "Delete" : "Discard";
  dirtyIndicator.hidden = !dirty;
  dirtyIndicator.textContent = persisted ? "Unsaved changes" : "Not saved yet";
}

function renderLogoControls(): void {
  if (!current) return;

  logoWidthInput.value = String(current.logo.width_mm);
  logoWidthOutput.textContent = `${Math.round(current.logo.width_mm)} mm`;
  logoRemoveButton.disabled = !current.logo.file_name && !logoSrc;

  for (const radio of alignmentRadios) {
    radio.checked = radio.value === current.logo.alignment;
  }
}

function renderLibrary(): void {
  const query = songSearch.value.trim().toLocaleLowerCase();
  const matching = songs.filter((song) => {
    if (!query) return true;
    return [song.title, song.artist, song.key]
      .filter((value): value is string => Boolean(value))
      .some((value) => value.toLocaleLowerCase().includes(query));
  });

  songCountEl.textContent = String(songs.length);
  songCountEl.setAttribute(
    "aria-label",
    `${songs.length} ${songs.length === 1 ? "song" : "songs"} in the library`,
  );

  if (matching.length === 0) {
    const empty = el(
      "li",
      "empty-state",
      songs.length === 0 ? "No songs yet. Add the first one below." : "No songs match that search.",
    );
    songListEl.replaceChildren(empty);
    return;
  }

  const fragment = document.createDocumentFragment();
  for (const song of matching) {
    fragment.append(buildLibraryRow(song));
  }
  songListEl.replaceChildren(fragment);
}

function buildLibraryRow(song: Song): HTMLLIElement {
  const row = el("li", "song-item");
  const info = el("div", "song-info");
  info.append(el("span", "song-item-title", song.title));

  const metaParts = [
    song.artist?.trim(),
    song.key?.trim(),
    song.bpm ? `${song.bpm} BPM` : null,
    song.duration_secs != null ? formatDuration(song.duration_secs) : null,
  ].filter((part): part is string => Boolean(part));
  if (metaParts.length > 0) {
    info.append(el("span", "song-item-meta", metaParts.join(" · ")));
  }

  const actions = el("div", "song-item-actions");
  const addButton = el("button", "btn btn-small btn-primary", "Add");
  addButton.type = "button";
  addButton.setAttribute("aria-label", `Add ${song.title} to the setlist`);
  addButton.addEventListener("click", () => addSongToSetlist(song));

  const removeButton = el("button", "icon-button", "✕");
  removeButton.type = "button";
  removeButton.title = `Remove ${song.title} from the library`;
  removeButton.setAttribute("aria-label", `Remove ${song.title} from the library`);
  removeButton.addEventListener("click", () => {
    void deleteLibrarySong(song);
  });

  actions.append(addButton, removeButton);
  row.append(info, actions);
  return row;
}

function renderItems(): void {
  if (!current) {
    itemList.replaceChildren();
    emptyItems.hidden = true;
    return;
  }

  const fragment = document.createDocumentFragment();
  let songNumber = 0;

  current.items.forEach((item, index) => {
    if ("Song" in item) {
      songNumber += 1;
      fragment.append(buildSongItem(item.Song, index, songNumber));
    } else {
      fragment.append(buildBreakItem(item.Break, index));
    }
  });

  itemList.replaceChildren(fragment);
  emptyItems.hidden = current.items.length > 0;
  renderSummary();
}

function buildSongItem(song: Song, index: number, songNumber: number): HTMLLIElement {
  const row = el("li", "item-row");
  row.draggable = true;
  row.dataset.index = String(index);

  const number = buildItemLead(String(songNumber));
  const main = el("div", "item-main");
  const heading = el("div", "item-heading");
  const titleNode = el("span", "item-title", song.title || "Untitled song");
  const metaNode = el("span", "item-sub");
  heading.append(titleNode, metaNode);
  main.append(heading);

  const refreshMeta = (): void => {
    const parts = [
      song.artist?.trim(),
      song.key?.trim(),
      song.bpm ? `${song.bpm} BPM` : null,
      song.duration_secs != null ? formatDuration(song.duration_secs) : null,
    ].filter((part): part is string => Boolean(part));
    metaNode.textContent = parts.join(" · ");
    metaNode.hidden = parts.length === 0;
  };
  refreshMeta();

  const details = el("details", "item-details");
  details.append(el("summary", "item-details-summary", "Edit details"));

  const fields = el("div", "item-fields");
  const titleField = textField("Title", song.title, "Song title");
  titleField.input.addEventListener("input", () => {
    song.title = titleField.input.value;
    titleNode.textContent = song.title.trim() || "Untitled song";
    markDirty();
    renderSheet();
  });

  const artistField = textField("Artist", song.artist ?? "", "Artist");
  artistField.input.addEventListener("input", () => {
    song.artist = trimmedOrNull(artistField.input.value);
    refreshMeta();
    markDirty();
    renderSheet();
  });

  const keyField = textField("Key", song.key ?? "", "Em");
  keyField.input.addEventListener("input", () => {
    song.key = trimmedOrNull(keyField.input.value);
    refreshMeta();
    markDirty();
    renderSheet();
  });

  const bpmField = numberField("BPM", song.bpm, 1, 400);
  bpmField.input.addEventListener("change", () => {
    const value = bpmField.input.valueAsNumber;
    song.bpm = Number.isFinite(value) ? clamp(Math.round(value), 1, 400) : null;
    bpmField.input.value = song.bpm === null ? "" : String(song.bpm);
    refreshMeta();
    markDirty();
    renderSheet();
  });

  const durationField = textField(
    "Duration",
    durationInputValue(song.duration_secs),
    "4:30",
  );
  durationField.input.addEventListener("change", () => {
    const raw = durationField.input.value.trim();
    const parsed = parseDuration(raw);
    if (raw && parsed === null) {
      durationField.input.classList.add("is-invalid");
      setStatus("Use mm:ss (for example 4:30) for song durations.", "error");
      return;
    }
    durationField.input.classList.remove("is-invalid");
    song.duration_secs = parsed;
    refreshMeta();
    markDirty();
    renderSheet();
  });

  const notesField = textField("Notes", song.notes ?? "", "Count-in, capo, cue…");
  notesField.input.addEventListener("input", () => {
    song.notes = trimmedOrNull(notesField.input.value);
    markDirty();
    renderSheet();
  });

  fields.append(
    titleField.element,
    artistField.element,
    keyField.element,
    bpmField.element,
    durationField.element,
    notesField.element,
  );
  details.append(fields);
  main.append(details);

  row.append(number, main, buildItemActions(index));
  return row;
}

function buildBreakItem(
  breakItem: { duration_mins: number; note: string | null },
  index: number,
): HTMLLIElement {
  const row = el("li", "item-row break-item");
  row.draggable = true;
  row.dataset.index = String(index);

  const number = buildItemLead("—");
  const main = el("div", "item-main");
  const heading = el("div", "item-heading");
  const titleNode = el("span", "item-title", "Break");
  const metaNode = el("span", "item-sub");
  heading.append(titleNode, metaNode);
  main.append(heading);

  const refreshMeta = (): void => {
    metaNode.textContent = [
      `${breakItem.duration_mins} min`,
      breakItem.note?.trim(),
    ]
      .filter((part): part is string => Boolean(part))
      .join(" · ");
  };
  refreshMeta();

  const details = el("details", "item-details");
  details.append(el("summary", "item-details-summary", "Edit break"));

  const fields = el("div", "item-fields");
  const minutesField = numberField("Minutes", breakItem.duration_mins, 0, 600);
  minutesField.input.dataset.field = "break-minutes";
  minutesField.input.addEventListener("change", () => {
    const value = minutesField.input.valueAsNumber;
    breakItem.duration_mins = Number.isFinite(value) ? clamp(Math.round(value), 0, 600) : 0;
    minutesField.input.value = String(breakItem.duration_mins);
    refreshMeta();
    markDirty();
    renderSheet();
  });

  const noteField = textField("Note", breakItem.note ?? "", "Tune down, speech…");
  noteField.input.addEventListener("input", () => {
    breakItem.note = trimmedOrNull(noteField.input.value);
    refreshMeta();
    markDirty();
    renderSheet();
  });

  fields.append(minutesField.element, noteField.element);
  details.append(fields);
  main.append(details);

  row.append(number, main, buildItemActions(index));
  return row;
}

function buildItemLead(label: string): HTMLSpanElement {
  const lead = el("span", "item-lead");
  lead.append(el("span", "item-number tabular", label));
  const grip = el("span", "drag-grip", "⠿");
  grip.setAttribute("aria-hidden", "true");
  grip.title = "Drag to reorder";
  lead.append(grip);
  return lead;
}

function buildItemActions(index: number): HTMLDivElement {
  const actions = el("div", "item-actions");
  const lastIndex = (current?.items.length ?? 1) - 1;

  const up = actionButton("↑", "Move item up", "up", index);
  up.disabled = index === 0;
  const down = actionButton("↓", "Move item down", "down", index);
  down.disabled = index >= lastIndex;
  const remove = actionButton("✕", "Remove item", "remove", index);

  actions.append(up, down, remove);
  return actions;
}

function actionButton(
  label: string,
  accessibleName: string,
  action: string,
  index: number,
): HTMLButtonElement {
  const button = el("button", "icon-button", label);
  button.type = "button";
  button.dataset.action = action;
  button.dataset.index = String(index);
  button.title = accessibleName;
  button.setAttribute("aria-label", accessibleName);
  return button;
}

function renderSummary(): void {
  if (!current) {
    setlistSummary.textContent = "";
    return;
  }

  const totalSecs = setlistDurationSecs(current);
  const songCount = current.items.filter((item) => "Song" in item).length;
  const breakCount = current.items.filter((item) => "Break" in item).length;

  if (current.items.length === 0) {
    setlistSummary.textContent = "Empty running order";
    return;
  }

  const parts = [
    `${songCount} ${songCount === 1 ? "song" : "songs"}`,
    breakCount > 0 ? `${breakCount} ${breakCount === 1 ? "break" : "breaks"}` : null,
    `${formatRuntime(totalSecs)} total`,
  ].filter((part): part is string => Boolean(part));

  setlistSummary.textContent = parts.join(" · ");
}

function renderSheet(): void {
  if (!current) {
    sheet.replaceChildren();
    return;
  }

  renderSetlistSheet(sheet, current, {
    logoUrl: logoSrc,
    grayscaleLogo: grayscaleLogoInput.checked,
    onLogoLayout: fitSheetToPage,
  });
  renderSummary();
  fitSheetToPage();
}

function fitPreview(): void {
  const available = Math.max(sheetScroll.clientWidth - 40, 0);
  if (available === 0) return;

  const scale = Math.min(1, Math.max(0.28, available / A4_WIDTH_PX));
  const rounded = Math.round(scale * 1000) / 1000;
  sheetScroll.style.setProperty("--sheet-scale", String(rounded));
  syncSheetHeight();
}

/**
 * Shrink the sheet content (via --sheet-fit zoom) until it fits a single A4
 * page. --sheet-fit also drives the print stylesheet, so the paper output
 * matches the preview. Never grows content, only shrinks down to SHEET_FIT_MIN.
 */
function fitSheetToPage(): void {
  sheet.style.setProperty("--sheet-fit", "1");
  let fit = 1;

  for (let i = 0; i < 12 && fit > SHEET_FIT_MIN; i += 1) {
    // Reading offsetHeight forces a reflow, so each zoom step is measured.
    if (sheet.offsetHeight <= A4_HEIGHT_PX + 2) break;
    fit = Math.max(SHEET_FIT_MIN, Math.round((fit - SHEET_FIT_STEP) * 1000) / 1000);
    sheet.style.setProperty("--sheet-fit", String(fit));
  }

  updateFitHint(fit);
  syncSheetHeight();
}

function updateFitHint(fit: number): void {
  if (fit >= 0.999) {
    previewMeta.textContent = "A4 · 210 × 297 mm · black on white";
    return;
  }

  const percent = Math.round(fit * 100);
  const overfull = sheet.offsetHeight > A4_HEIGHT_PX + 2;
  previewMeta.textContent = overfull
    ? `A4 · single page · auto-fit ${percent}% — still overfull, remove items`
    : `A4 · single page · auto-fit ${percent}%`;
}

function syncSheetHeight(): void {
  requestAnimationFrame(() => {
    const raw = getComputedStyle(sheetScroll).getPropertyValue("--sheet-scale").trim();
    const parsed = Number.parseFloat(raw);
    const scale = Number.isFinite(parsed) && parsed > 0 ? parsed : 1;
    sheetFrame.style.height = `${Math.ceil(sheet.offsetHeight * scale)}px`;
  });
}

// ---------------------------------------------------------------------------
// Item interactions
// ---------------------------------------------------------------------------

function handleItemClick(event: MouseEvent): void {
  if (!(event.target instanceof Element)) return;

  const button = event.target.closest<HTMLButtonElement>("button[data-action]");
  if (!button || !itemList.contains(button) || !current) return;

  const index = Number(button.dataset.index);
  if (!Number.isInteger(index)) return;

  switch (button.dataset.action) {
    case "up":
      moveItem(index, index - 1);
      break;
    case "down":
      moveItem(index, index + 1);
      break;
    case "remove":
      removeItem(index);
      break;
  }
}

function moveItem(from: number, to: number): void {
  if (!current || from < 0 || to < 0 || from >= current.items.length || to >= current.items.length) {
    return;
  }
  if (from === to) return;

  const [item] = current.items.splice(from, 1);
  current.items.splice(to, 0, item);
  markDirty();
  renderItems();
  renderSheet();
}

function removeItem(index: number): void {
  if (!current || index < 0 || index >= current.items.length) return;

  current.items.splice(index, 1);
  markDirty();
  renderItems();
  renderSheet();
}

function addBreak(): void {
  if (!current) return;

  current.items.push({ Break: { duration_mins: 10, note: null } });
  markDirty();
  renderItems();
  renderSheet();

  const lastRow = itemList.lastElementChild;
  const minutes = lastRow?.querySelector<HTMLInputElement>('input[data-field="break-minutes"]');
  if (minutes) {
    const details = lastRow?.querySelector("details");
    if (details) details.open = true;
    minutes.focus();
    minutes.select();
  }
}

function bindDragReorder(): void {
  let dragFrom: number | null = null;

  itemList.addEventListener("dragstart", (event) => {
    if (!(event.target instanceof Element)) return;
    // Never start a row drag from a control the user is trying to operate.
    if (event.target.closest("input, button, summary, a")) {
      event.preventDefault();
      return;
    }

    const row = event.target.closest<HTMLElement>(".item-row");
    if (!row) return;

    dragFrom = Number(row.dataset.index);
    row.classList.add("is-dragging");
    event.dataTransfer?.setData("text/plain", row.dataset.index ?? "");
    if (event.dataTransfer) {
      event.dataTransfer.effectAllowed = "move";
    }
  });

  itemList.addEventListener("dragover", (event) => {
    if (!(event.target instanceof Element)) return;
    const row = event.target.closest<HTMLElement>(".item-row");
    if (!row) return;

    event.preventDefault();
    if (event.dataTransfer) {
      event.dataTransfer.dropEffect = "move";
    }
    for (const candidate of itemList.querySelectorAll(".item-row")) {
      candidate.classList.toggle("is-drop-target", candidate === row);
    }
  });

  itemList.addEventListener("dragleave", (event) => {
    if (!(event.target instanceof Element)) return;
    const row = event.target.closest<HTMLElement>(".item-row");
    row?.classList.remove("is-drop-target");
  });

  itemList.addEventListener("drop", (event) => {
    if (!(event.target instanceof Element)) return;
    const row = event.target.closest<HTMLElement>(".item-row");
    if (!row) return;

    event.preventDefault();
    const to = Number(row.dataset.index);
    const from = dragFrom;
    clearDragState();
    dragFrom = null;

    if (from !== null && Number.isInteger(to) && from !== to) {
      moveItem(from, to);
    }
  });

  itemList.addEventListener("dragend", () => {
    clearDragState();
    dragFrom = null;
  });

  function clearDragState(): void {
    for (const row of itemList.querySelectorAll(".item-row")) {
      row.classList.remove("is-dragging", "is-drop-target");
    }
  }
}

// ---------------------------------------------------------------------------
// Song library
// ---------------------------------------------------------------------------

async function handleSongSubmit(event: SubmitEvent): Promise<void> {
  event.preventDefault();
  if (!ensureBackend()) return;

  const title = newSongTitle.value.trim();
  if (!title) {
    setStatus("Song title is required.", "error");
    newSongTitle.focus();
    return;
  }

  const bpmRaw = newSongBpm.value.trim();
  const bpm = bpmRaw ? Number(bpmRaw) : null;
  if (bpm !== null && (!Number.isInteger(bpm) || bpm < 1 || bpm > 400)) {
    setStatus("BPM must be a whole number between 1 and 400.", "error");
    newSongBpm.focus();
    return;
  }

  const durationRaw = newSongDuration.value.trim();
  const duration = parseDuration(durationRaw);
  if (durationRaw && duration === null) {
    setStatus("Duration must use mm:ss, for example 4:30.", "error");
    newSongDuration.focus();
    return;
  }

  const song: Song = {
    id: newId(),
    title,
    artist: trimmedOrNull(newSongArtist.value),
    bpm,
    key: trimmedOrNull(newSongKey.value),
    duration_secs: duration,
    notes: trimmedOrNull(newSongNotes.value),
  };

  try {
    await api.saveSong(song);
    songs.push(song);
    songs.sort((left, right) => left.title.localeCompare(right.title));
    songForm.reset();
    renderLibrary();
    setStatus(`Added “${song.title}” to the library.`, "success");
    newSongTitle.focus();
  } catch (error) {
    setStatus(`Could not save song: ${describeError(error)}`, "error");
  }
}

function addSongToSetlist(song: Song): void {
  if (!current) return;

  current.items.push({ Song: { ...song } });
  markDirty();
  renderItems();
  renderSheet();
  setStatus(`Added “${song.title}” to the running order.`, "success");
}

async function deleteLibrarySong(song: Song): Promise<void> {
  if (!ensureBackend()) return;
  if (!window.confirm(`Remove “${song.title}” from the library? Setlists keep their own copies.`)) {
    return;
  }

  try {
    await api.deleteSong(song.id);
    songs = songs.filter((entry) => entry.id !== song.id);
    renderLibrary();
    setStatus(`Removed “${song.title}” from the library.`);
  } catch (error) {
    setStatus(`Could not remove song: ${describeError(error)}`, "error");
  }
}

// ---------------------------------------------------------------------------
// Logo
// ---------------------------------------------------------------------------

async function handleLogoFile(): Promise<void> {
  const file = logoFileInput.files?.[0];
  logoFileInput.value = "";
  if (!file || !current) return;

  const allowed = ["image/png", "image/jpeg", "image/svg+xml"];
  if (!allowed.includes(file.type) && !/\.(png|jpe?g|svg)$/i.test(file.name)) {
    setStatus("Logo must be a PNG, JPEG, or SVG image.", "error");
    return;
  }

  if (file.size > 5 * 1024 * 1024) {
    setStatus("Logo must be 5 MiB or smaller.", "error");
    return;
  }

  let bytes: Uint8Array;
  try {
    bytes = new Uint8Array(await file.arrayBuffer());
  } catch (error) {
    setStatus(`Could not read logo: ${describeError(error)}`, "error");
    return;
  }

  const setlist = current;
  const previewUrl = URL.createObjectURL(file);
  const previousFileName = setlist.logo.file_name;
  setLogoPreview(previewUrl);
  renderLogoControls();
  markDirty();

  if (!backendAvailable) {
    setStatus("Logo preview is local only — the backend is unavailable.", "error");
    return;
  }

  try {
    const storedName = await api.importLogo(bytes, file.name);
    if (current !== setlist) {
      URL.revokeObjectURL(previewUrl);
      return;
    }
    if (previousFileName && previousFileName !== storedName) {
      pendingLogoRemovals.add(previousFileName);
    }
    setlist.logo.file_name = storedName;
    renderLogoControls();
    markDirty();
    renderSheet();
    setStatus(`Logo imported (${Math.max(1, Math.round(file.size / 1024))} KB).`, "success");
  } catch (error) {
    setStatus(`Could not import logo: ${describeError(error)}`, "error");
    // Keep the previous logo (if any) visible after a failed replacement.
    await loadLogoForCurrent();
    renderLogoControls();
  }
}

function handleLogoRemove(): void {
  if (!current) return;

  const fileName = current.logo.file_name;
  if (!fileName && !logoSrc) return;

  if (fileName) {
    // Defer the delete until Save succeeds. Discarding the edit must leave the
    // saved setlist's logo file intact.
    pendingLogoRemovals.add(fileName);
  }

  current.logo.file_name = null;
  setLogoPreview(null);
  renderLogoControls();
  markDirty();
  setStatus(fileName ? "Logo removed — save to apply." : "Logo removed.");
}

async function cleanupPendingLogoRemovals(): Promise<void> {
  if (pendingLogoRemovals.size === 0 || !backendAvailable) return;

  const names = [...pendingLogoRemovals];
  pendingLogoRemovals.clear();

  for (const name of names) {
    if (setlists.some((setlist) => setlist.logo.file_name === name)) continue;
    // A leftover file is harmless; never fail a successful save over cleanup.
    await api.removeLogo(name).catch(() => undefined);
  }
}

async function loadLogoForCurrent(): Promise<void> {
  const request = ++logoRequestId;
  clearLogoPreview();
  renderSheet();

  const fileName = current?.logo.file_name;
  if (!fileName || !backendAvailable) return;

  try {
    const url = await storedLogoUrl(fileName);
    if (request !== logoRequestId) {
      URL.revokeObjectURL(url);
      return;
    }
    logoSrc = url;
  } catch (error) {
    if (request === logoRequestId) {
      setStatus(`Could not load logo: ${describeError(error)}`, "error");
    }
  }
  renderSheet();
}

function setLogoPreview(url: string | null): void {
  clearLogoPreview();
  logoSrc = url;
  renderSheet();
}

function clearLogoPreview(): void {
  if (logoSrc) {
    URL.revokeObjectURL(logoSrc);
    logoSrc = null;
  }
}

// ---------------------------------------------------------------------------
// Small helpers
// ---------------------------------------------------------------------------

function markDirty(): void {
  dirty = true;
  const persisted = current ? setlists.some((setlist) => setlist.id === current?.id) : false;
  dirtyIndicator.hidden = false;
  dirtyIndicator.textContent = persisted ? "Unsaved changes" : "Not saved yet";
}

function setStatus(message: string, kind: "info" | "success" | "error" = "info"): void {
  statusEl.textContent = message;
  statusEl.dataset.kind = kind;

  if (statusTimer !== undefined) {
    window.clearTimeout(statusTimer);
    statusTimer = undefined;
  }

  if (kind !== "error") {
    statusTimer = window.setTimeout(() => {
      statusEl.textContent = "";
    }, 5000);
  }
}

function ensureBackend(): boolean {
  if (backendAvailable) return true;
  setStatus("Local backend unavailable — start the desktop app with `npm run tauri dev`.", "error");
  return false;
}

function describeError(error: unknown): string {
  if (typeof error === "string") return error;
  if (error instanceof Error) return error.message;
  try {
    return JSON.stringify(error);
  } catch {
    return String(error);
  }
}

/** UUID v4 with a fallback for webviews without `crypto.randomUUID`. */
function newId(): string {
  if (typeof crypto.randomUUID === "function") {
    return crypto.randomUUID();
  }

  const bytes = crypto.getRandomValues(new Uint8Array(16));
  bytes[6] = (bytes[6] & 0x0f) | 0x40;
  bytes[8] = (bytes[8] & 0x3f) | 0x80;
  const hex = Array.from(bytes, (byte) => byte.toString(16).padStart(2, "0")).join("");
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

function trimmedOrNull(value: string): string | null {
  const trimmed = value.trim();
  return trimmed ? trimmed : null;
}

function clamp(value: number, min: number, max: number): number {
  if (!Number.isFinite(value)) return min;
  return Math.min(max, Math.max(min, value));
}

function isLogoAlignment(value: string): value is LogoAlignment {
  return value === "Left" || value === "Center" || value === "Right";
}

interface FieldHandle {
  element: HTMLLabelElement;
  input: HTMLInputElement;
}

function textField(label: string, value: string, placeholder?: string): FieldHandle {
  const input = document.createElement("input");
  input.type = "text";
  input.value = value;
  if (placeholder) input.placeholder = placeholder;
  return labeledField(label, input);
}

function numberField(
  label: string,
  value: number | null,
  min: number,
  max: number,
): FieldHandle {
  const input = document.createElement("input");
  input.type = "number";
  input.min = String(min);
  input.max = String(max);
  input.inputMode = "numeric";
  input.value = value === null ? "" : String(value);
  return labeledField(label, input);
}

function labeledField(label: string, input: HTMLInputElement): FieldHandle {
  const element = el("label", "item-field");
  element.append(el("span", "item-field-label", label), input);
  return { element, input };
}

void init();
