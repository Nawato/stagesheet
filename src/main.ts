import "./styles/app.css";
import "./styles/print.css";

import { api } from "./api";
import { exportBackup, readBackupFile } from "./backup";
import { byId, el } from "./dom";
import {
  durationInputValue,
  formatBreakDuration,
  formatDuration,
  formatRuntime,
  parseDuration,
  setlistDurationSecs,
} from "./format";
import { exportSetlist } from "./exporter";
import type { ExportFormat } from "./exporter";
import { storedLogoUrl } from "./logo";
import { A4_CONTENT_HEIGHT_PX, renderSheetPages } from "./pages";
import { renderSetlistSheet } from "./sheet";
import type { BreakItem, LogoAlignment, PageMode, Setlist, SheetOptions, Song } from "./types";
import {
  DEFAULT_LOGO_WIDTH_MM,
  DEFAULT_PAGE_MODE,
  DEFAULT_SHEET_OPTIONS,
  LOGO_MAX_WIDTH_MM,
  LOGO_MIN_WIDTH_MM,
  MAX_BREAK_LABEL_CHARS,
  MAX_BREAK_SECS,
  MAX_COMMENT_CHARS,
  normalizeSetlistItems,
  withPageModeDefaults,
  withSheetDefaults,
} from "./types";

const MM_TO_PX = 96 / 25.4;
const A4_WIDTH_PX = 210 * MM_TO_PX;
const SHEET_FIT_MIN = 0.5;
const SHEET_FIT_STEP = 0.05;
/** Below this auto-fit percentage the printed type is too small for the stand. */
const LEGIBILITY_MIN_FIT = 0.7;

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
/** Library view controls. In-memory only: sorting/filtering never dirties a setlist. */
let songSort: SongSortKey = "title";
let tuningOnly = false;
/**
 * Inline library editor state. At most one row editor is open at a time;
 * opening another row discards the previous draft, because nothing reaches the
 * cache until Save. The draft survives library re-renders (search, sort, add,
 * duplicate, delete another row, `renderAll`) and is only cleared by Save,
 * Cancel, or hiding an idle edited row behind the active filter.
 */
let libraryEditor: LibraryEditorState | null = null;
/** True while the Add-to-library request is in flight. */
let addingSong = false;
/** Library writes (add/edit/duplicate/delete) currently in flight. */
let libraryWritesInFlight = 0;
/** True while a backup/restore owns the library snapshot. */
let backingUp = false;
let restoring = false;
/** Logo files to delete only after a setlist save succeeds. */
const pendingLogoRemovals = new Set<string>();
/** Frames currently rendered in multiple-page mode (the exact page count). */
let renderedPageCount = 0;

type SongSortKey = "title" | "artist" | "key" | "tuning";

/** Raw strings from the inline library editor; parsed only on Save. */
interface LibrarySongDraft {
  title: string;
  artist: string;
  key: string;
  tuning: string;
  bpm: string;
  duration: string;
  notes: string;
}

interface LibraryEditorState {
  songId: string;
  draft: LibrarySongDraft;
  /** True while the upsert is in flight; fields and Save are disabled. */
  saving: boolean;
  /** True after a failed save until the draft is retried or explicitly discarded. */
  retryPending: boolean;
  /** Validation markers that must survive a library re-render. */
  invalidFields: Set<keyof LibrarySongDraft>;
  /** True when the active search/filter currently hides this row. */
  hiddenByFilter: boolean;
  /** Last focused field/button, kept across disabled states and re-renders. */
  focusMemory: LibraryEditorFocusTarget | null;
}

/** Focus and selection to restore after an unrelated library re-render. */
type LibraryEditorFocusTarget =
  | {
      kind: "input";
      songId: string;
      inputIndex: number;
      selectionStart: number | null;
      selectionEnd: number | null;
      selectionDirection: HTMLInputElement["selectionDirection"];
    }
  | {
      kind: "button";
      songId: string;
      action: "save" | "cancel";
    };

/** Deferred focus restore when an Add finishes while the editor is still busy. */
let pendingLibraryEditorFocus: LibraryEditorFocusTarget | null = null;

// ---------------------------------------------------------------------------
// Elements
// ---------------------------------------------------------------------------

const statusEl = byId<HTMLParagraphElement>("status");

const setlistSelect = byId<HTMLSelectElement>("setlist-select");
const newSetlistButton = byId<HTMLButtonElement>("new-setlist");
const saveSetlistButton = byId<HTMLButtonElement>("save-setlist");
const printButton = byId<HTMLButtonElement>("print-setlist");
const exportPdfButton = byId<HTMLButtonElement>("export-pdf");
const exportPngButton = byId<HTMLButtonElement>("export-png");
const exportOpenAfterInput = byId<HTMLInputElement>("export-open-after");
const deleteSetlistButton = byId<HTMLButtonElement>("delete-setlist");

const songSearch = byId<HTMLInputElement>("song-search");
const songSortSelect = byId<HTMLSelectElement>("song-sort");
const songTuningOnlyInput = byId<HTMLInputElement>("song-tuning-only");
const songListEl = byId<HTMLUListElement>("song-list");
const songCountEl = byId<HTMLSpanElement>("song-count");
const songForm = byId<HTMLFormElement>("song-form");
const newSongTitle = byId<HTMLInputElement>("new-song-title");
const newSongArtist = byId<HTMLInputElement>("new-song-artist");
const newSongKey = byId<HTMLInputElement>("new-song-key");
const newSongTuning = byId<HTMLInputElement>("new-song-tuning");
const newSongBpm = byId<HTMLInputElement>("new-song-bpm");
const newSongDuration = byId<HTMLInputElement>("new-song-duration");
const newSongNotes = byId<HTMLInputElement>("new-song-notes");
const addSongButton = songForm.querySelector<HTMLButtonElement>('button[type="submit"]');

const backupExportButton = byId<HTMLButtonElement>("backup-export");
const backupRestoreButton = byId<HTMLButtonElement>("backup-restore");

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
const sheetPages = byId<HTMLDivElement>("sheet-pages");
const sheetFrame = byId<HTMLDivElement>("sheet-frame");
const sheetScroll = byId<HTMLDivElement>("sheet-scroll");
const previewMeta = byId<HTMLParagraphElement>("preview-meta");

/** Editor "Page layout" radios: Single (default) or Multiple. */
const pageModeRadios = Array.from(
  document.querySelectorAll<HTMLInputElement>('input[name="page-mode"]'),
);

/** Editor "Sheet columns" checkboxes, in display order. */
const sheetOptionInputs: Array<[keyof SheetOptions, HTMLInputElement]> = [
  ["show_key", byId<HTMLInputElement>("sheet-option-key")],
  ["show_tuning", byId<HTMLInputElement>("sheet-option-tuning")],
  ["show_tempo", byId<HTMLInputElement>("sheet-option-tempo")],
  ["show_duration", byId<HTMLInputElement>("sheet-option-duration")],
  ["show_comment", byId<HTMLInputElement>("sheet-option-comment")],
];

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
  exportPdfButton.addEventListener("click", () => {
    void exportCurrent("pdf");
  });
  exportPngButton.addEventListener("click", () => {
    void exportCurrent("png");
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
  songSortSelect.addEventListener("change", () => {
    songSort = isSongSortKey(songSortSelect.value) ? songSortSelect.value : "title";
    renderLibrary();
  });
  songTuningOnlyInput.addEventListener("change", () => {
    tuningOnly = songTuningOnlyInput.checked;
    renderLibrary();
  });
  document.addEventListener("focusin", (event) => {
    if (!(event.target instanceof Element)) return;
    if (!event.target.closest("form.song-item-editor")) {
      pendingLibraryEditorFocus = null;
      if (libraryEditor) libraryEditor.focusMemory = null;
    }
  });
  songForm.addEventListener("submit", (event) => {
    void handleSongSubmit(event);
  });
  addBreakButton.addEventListener("click", addBreak);
  backupExportButton.addEventListener("click", () => {
    void backUpLibrary();
  });
  backupRestoreButton.addEventListener("click", () => {
    void restoreLibrary();
  });

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

  for (const [key, input] of sheetOptionInputs) {
    input.addEventListener("change", () => {
      if (!current) return;
      const options = withSheetDefaults(current.sheet_options);
      options[key] = input.checked;
      current.sheet_options = options;
      markDirty();
      renderSheet();
    });
  }

  for (const radio of pageModeRadios) {
    radio.addEventListener("change", () => {
      if (!current || !radio.checked || !isPageMode(radio.value)) return;
      current.page_mode = radio.value;
      markDirty();
      renderSheet();
    });
  }

  window.addEventListener("keydown", (event) => {
    if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === "s") {
      event.preventDefault();
      // Inside a song editor, Ctrl/Cmd+S saves the song draft instead of the
      // setlist. The Add form gets the same treatment for consistency.
      if (event.target instanceof Element) {
        const editor = event.target.closest<HTMLFormElement>("form.song-item-editor");
        if (editor) {
          editor.requestSubmit();
          return;
        }
        if (songForm.contains(event.target)) {
          songForm.requestSubmit();
          return;
        }
      }
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
  applyPrintPlatformClass();
  logoWidthInput.min = String(LOGO_MIN_WIDTH_MM);
  logoWidthInput.max = String(LOGO_MAX_WIDTH_MM);
  bindEvents();

  try {
    const [loadedSongs, loadedSetlists] = await Promise.all([
      api.listSongs(),
      api.listSetlists(),
    ]);
    adoptLoadedState(loadedSongs, loadedSetlists);
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
  document.fonts.ready.then(handleSheetLayout).catch(() => undefined);
}

/**
 * WebKitGTK (Tauri on Linux) prints at GTK's page-setup scale rather than the
 * CSS pixel scale, which makes a 271 mm frame taller than one sheet. Mark that
 * engine only; print.css sizes the frame stack down there. Chromium-based
 * WebView2 and WKWebView print the frames 1:1 and keep the class off.
 */
function applyPrintPlatformClass(): void {
  const ua = navigator.userAgent;
  const webkitGtk =
    ua.includes("AppleWebKit") && ua.includes("Linux") && !/Chrome|Chromium|Edg\//.test(ua);
  document.documentElement.classList.toggle("webkitgtk", webkitGtk);
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
    sheet_options: { ...DEFAULT_SHEET_OPTIONS },
    page_mode: DEFAULT_PAGE_MODE,
    created_at: now,
    updated_at: now,
  };
}

function cloneSetlist(setlist: Setlist): Setlist {
  return {
    ...setlist,
    items: normalizeSetlistItems(setlist.items).map((item) =>
      "Song" in item ? { Song: { ...item.Song } } : { Break: { ...item.Break } },
    ),
    logo: { ...setlist.logo },
    sheet_options: withSheetDefaults(setlist.sheet_options),
    page_mode: withPageModeDefaults(setlist.page_mode),
  };
}

/**
 * Replaces the in-memory caches with a fresh backend snapshot and selects the
 * requested setlist when it still exists (otherwise the most recent one).
 */
function adoptLoadedState(
  loadedSongs: Song[],
  loadedSetlists: Setlist[],
  preferredId?: string | null,
): void {
  songs = [...loadedSongs];
  sortSongsByTitle();
  libraryEditor = null;
  pendingLibraryEditorFocus = null;
  setlists = loadedSetlists.map((setlist) => ({
    ...setlist,
    items: normalizeSetlistItems(setlist.items),
    sheet_options: withSheetDefaults(setlist.sheet_options),
    page_mode: withPageModeDefaults(setlist.page_mode),
  }));
  sortSetlists();

  const preferred = preferredId
    ? setlists.find((setlist) => setlist.id === preferredId)
    : undefined;
  const next = preferred ?? setlists[0];
  current = next ? cloneSetlist(next) : createDraft();
  dirty = setlists.length === 0;
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

  // Commit every rendered break field before the backend call. `change` does
  // not fire for Ctrl/Cmd+S while the field still has focus, so validating only
  // the raw text would save the previous model value.
  const breakDurationInputs = Array.from(
    itemList.querySelectorAll<HTMLInputElement>('input[data-field="break-duration"]'),
  );
  for (const input of breakDurationInputs) {
    const row = input.closest<HTMLElement>(".item-row");
    const index = Number(row?.dataset.index);
    const item = Number.isInteger(index) ? current.items[index] : undefined;
    if (!item || !("Break" in item)) {
      setStatus(
        "Could not find the break for this duration field. Reopen the setlist and try again.",
        "error",
      );
      return false;
    }

    const committed = commitBreakDurationInput(input, item.Break);
    if (!committed.ok) {
      const details = input.closest("details");
      if (details) details.open = true;
      input.focus();
      setStatus(committed.error, "error");
      return false;
    }

    // The save-path commit bypasses the field's `change` handler, so reflect a
    // real edit in the dirty state and sheet immediately. A later invalid field
    // must not leave an earlier valid commit looking clean or unrendered.
    if (committed.changed) {
      markDirty();
      renderSheet();
    }
  }

  // The editor rejects invalid input as it is typed; this guards values loaded
  // from older files (or set programmatically) before the backend sees them.
  // Rust validation remains the authority.
  const invalidBreak = current.items.find(
    (item) =>
      "Break" in item &&
      (!Number.isInteger(item.Break.duration_secs) ||
        item.Break.duration_secs < 0 ||
        item.Break.duration_secs > MAX_BREAK_SECS),
  );
  if (invalidBreak) {
    setStatus(
      `Break durations must be between 0:00 and 600:00 (${MAX_BREAK_SECS} seconds). Fix the break length before saving.`,
      "error",
    );
    return false;
  }

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
  if (!current || exporting) return;

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

let exporting = false;

/**
 * Exports the current editor state (not the last saved copy). The exporter
 * reuses the rendered sheet, so the selected page mode and column options are
 * exactly what the preview shows. `window.print()` stays the text-sharp path.
 */
async function exportCurrent(format: ExportFormat): Promise<void> {
  if (!current || exporting) return;
  if (!backendAvailable) {
    setStatus("Local backend unavailable — export needs the desktop app.", "error");
    return;
  }

  // Make sure the preview DOM matches the editor state before rasterizing, then
  // lock it: export prep mutates the live sheet, and `renderSheet` ignores edits
  // until the finally block restores and re-renders.
  renderSheet();
  exporting = true;
  // The exporter captures the tall sheet, which multiple mode normally hides
  // behind the frame stack. Reveal the source and hide the frames for the
  // capture; `renderSheet()` restores the framed preview in the finally block.
  sheetFrame.classList.remove("is-framed");
  printButton.disabled = true;
  exportPdfButton.disabled = true;
  exportPngButton.disabled = true;
  setStatus(`Preparing ${format.toUpperCase()} export…`);

  try {
    const outcome = await exportSetlist({
      sheet,
      setlist: current,
      format,
      openAfterExport: exportOpenAfterInput.checked,
    });

    if (outcome.status === "canceled") {
      setStatus("Export canceled.");
      return;
    }

    const logoNote = outcome.logoWarning
      ? ` The logo could not be read, so the export has no logo: ${outcome.logoWarning}`
      : "";
    const openNote = outcome.opened
      ? " Opened in the system viewer."
      : outcome.openError
        ? ` The file was saved, but it could not be opened: ${outcome.openError}`
        : "";
    setStatus(
      `Exported ${format.toUpperCase()}: ${baseName(outcome.path)}${logoNote}${openNote}`,
      outcome.openError || outcome.logoWarning ? "error" : "success",
    );
  } catch (error) {
    setStatus(`Export failed: ${describeError(error)}`, "error");
  } finally {
    exporting = false;
    printButton.disabled = false;
    exportPdfButton.disabled = false;
    exportPngButton.disabled = false;
    // Export prep mutates the sheet's inline styles and table markup; a fresh
    // render restores the preview and re-applies the page-mode fit.
    renderSheet();
  }
}

function baseName(path: string): string {
  const parts = path.split(/[\\/]/);
  return parts[parts.length - 1] || path;
}

// ---------------------------------------------------------------------------
// Backup / restore
// ---------------------------------------------------------------------------

/**
 * Refuses backup/restore while a library write is in flight or an inline draft
 * (including a failed one) is open. This keeps stored-only snapshots from
 * silently omitting unsaved edits and prevents writes from landing after the
 * restore adopts its reloaded state.
 */
function libraryDraftGuard(action: "backing up" | "restoring"): string | null {
  if (libraryWritesInFlight > 0) {
    return `Wait for the current library request to finish before ${action}.`;
  }
  const editor = libraryEditor;
  if (!editor) return null;
  const kind = editor.retryPending ? "failed edit" : "edit";
  if (editor.hiddenByFilter) {
    return `Clear the search or filter, then save or cancel the ${kind} for “${libraryEditorLabel(editor)}” before ${action}.`;
  }
  return `Save or cancel the ${kind} for “${libraryEditorLabel(editor)}” before ${action}.`;
}

/** Blocks row/Add actions while a backup or restore owns the library snapshot. */
function blockLibraryActionWhileBusy(): boolean {
  if (restoring) {
    setStatus("Restore in progress — wait for it to finish.", "info");
    return true;
  }
  if (backingUp) {
    setStatus("Backup in progress — wait for it to finish.", "info");
    return true;
  }
  return false;
}

/**
 * Writes the whole library and every setlist to one versioned JSON file. Like
 * Print, it saves a dirty editor first so the backup matches what the user sees.
 * Library drafts must be saved or cancelled first so a backup never silently
 * omits an edit that is visible in the UI.
 */
async function backUpLibrary(): Promise<void> {
  if (!ensureBackend() || restoring || backingUp) return;

  const libraryBlock = libraryDraftGuard("backing up");
  if (libraryBlock) {
    setStatus(libraryBlock, "error");
    return;
  }

  try {
    backingUp = true;
    backupExportButton.disabled = true;
    backupRestoreButton.disabled = true;
    syncAddSongControls();
    // Disable row actions for the whole snapshot read/write; handlers also
    // guard so keyboard/programmatic paths cannot mutate the library.
    renderLibrary();

    if (dirty) {
      const saved = await saveCurrent();
      if (!saved) {
        setStatus("Save or discard the current setlist before backing up.", "error");
        return;
      }
    }

    const [backupSongs, backupSetlists] = await Promise.all([
      api.listSongs(),
      api.listSetlists(),
    ]);
    const outcome = await exportBackup({ songs: backupSongs, setlists: backupSetlists });

    if (outcome.status === "canceled") {
      setStatus("Backup canceled.");
      return;
    }

    setStatus(
      `Backed up ${countLabel(outcome.songs, "song")} and ${countLabel(outcome.setlists, "setlist")} to ${baseName(outcome.path)}.`,
      "success",
      10000,
    );
  } catch (error) {
    setStatus(`Backup failed: ${describeError(error)}`, "error");
  } finally {
    backingUp = false;
    backupExportButton.disabled = false;
    backupRestoreButton.disabled = false;
    syncAddSongControls();
    renderLibrary();
  }
}

/**
 * Restores a backup by re-saving each record through the normal commands, so
 * Rust validation stays authoritative. Records with the same IDs are
 * overwritten; nothing is deleted. Malformed records are skipped and reported.
 */
async function restoreLibrary(): Promise<void> {
  if (!ensureBackend() || restoring || backingUp) return;

  const libraryBlock = libraryDraftGuard("restoring");
  if (libraryBlock) {
    setStatus(libraryBlock, "error");
    return;
  }

  const picked = await readBackupFile().catch((error: unknown) => {
    setStatus(`Restore failed: ${describeError(error)}`, "error");
    return null;
  });
  if (!picked) return;

  if (picked.status === "canceled") {
    setStatus("Restore canceled.");
    return;
  }

  const { envelope, skipped } = picked.backup;
  if (envelope.songs.length + envelope.setlists.length === 0) {
    const reason = skipped.length > 0 ? ` All records were malformed: ${summarizeRecords(skipped)}.` : "";
    setStatus(`No restorable records in ${baseName(picked.path)}.${reason}`, "error");
    return;
  }

  const skippedNote =
    skipped.length > 0
      ? `\n\n${countLabel(skipped.length, "malformed record")} will be skipped: ${summarizeRecords(skipped)}.`
      : "";
  const confirmed = window.confirm(
    `Restore ${countLabel(envelope.songs.length, "song")} and ${countLabel(envelope.setlists.length, "setlist")} from ${baseName(picked.path)}?\n\n` +
      "Existing records with the same IDs are overwritten; nothing else is deleted. " +
      "Logo images are not part of the backup — re-import any missing logos afterwards." +
      skippedNote,
  );
  if (!confirmed) {
    setStatus("Restore canceled.");
    return;
  }

  if (dirty && !confirmDiscard()) {
    setStatus("Restore canceled.");
    return;
  }

  const lateLibraryBlock = libraryDraftGuard("restoring");
  if (lateLibraryBlock) {
    setStatus(lateLibraryBlock, "error");
    return;
  }

  let importedSongs = 0;
  let importedSetlists = 0;
  const failures: string[] = [];

  try {
    restoring = true;
    backupExportButton.disabled = true;
    backupRestoreButton.disabled = true;
    syncAddSongControls();
    // Row controls are guarded in their handlers; this render applies the visual
    // disabled state without touching any draft (none can be open here).
    renderLibrary();

    for (const [index, song] of envelope.songs.entries()) {
      try {
        await api.saveSong(song);
        importedSongs += 1;
      } catch (error) {
        failures.push(`song ${index + 1} “${song.title}” (${describeError(error)})`);
      }
    }

    for (const [index, setlist] of envelope.setlists.entries()) {
      try {
        await api.saveSetlist(setlist);
        importedSetlists += 1;
      } catch (error) {
        failures.push(`setlist ${index + 1} “${setlist.title}” (${describeError(error)})`);
      }
    }

    const currentId = current?.id ?? null;
    const [loadedSongs, loadedSetlists] = await Promise.all([
      api.listSongs(),
      api.listSetlists(),
    ]);
    pendingLogoRemovals.clear();
    clearLogoPreview();
    adoptLoadedState(loadedSongs, loadedSetlists, currentId);
    renderAll();
    if (backendAvailable && !dirty) {
      await loadLogoForCurrent();
    }
    fitPreview();

    const summary = `Restored ${countLabel(importedSongs, "song")} and ${countLabel(importedSetlists, "setlist")} from ${baseName(picked.path)}.`;
    const problems = [
      failures.length > 0
        ? `${countLabel(failures.length, "record")} rejected: ${summarizeRecords(failures)}`
        : null,
      skipped.length > 0
        ? `${countLabel(skipped.length, "malformed record")} skipped: ${summarizeRecords(skipped)}`
        : null,
    ].filter((part): part is string => Boolean(part));

    if (problems.length === 0) {
      setStatus(summary, "success", 10000);
    } else {
      setStatus(`${summary} ${problems.join(" ")}`, "error");
    }
  } catch (error) {
    setStatus(
      `Restore failed after ${countLabel(importedSongs + importedSetlists, "record")}: ${describeError(error)}`,
      "error",
    );
  } finally {
    restoring = false;
    backupExportButton.disabled = false;
    backupRestoreButton.disabled = false;
    syncAddSongControls();
    renderLibrary();
  }
}

function countLabel(count: number, singular: string): string {
  return `${count} ${singular}${count === 1 ? "" : "s"}`;
}

function summarizeRecords(records: string[], limit = 3): string {
  const head = records.slice(0, limit).join("; ");
  return records.length > limit ? `${head}; +${records.length - limit} more` : head;
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
  renderSheetOptions();
  renderPageModeControls();
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

function renderSheetOptions(): void {
  if (!current) return;

  const options = withSheetDefaults(current.sheet_options);
  for (const [key, input] of sheetOptionInputs) {
    input.checked = options[key];
  }
}

function renderPageModeControls(): void {
  if (!current) return;

  const mode = withPageModeDefaults(current.page_mode);
  for (const radio of pageModeRadios) {
    radio.checked = radio.value === mode;
  }
}

function renderLibrary(): void {
  const query = songSearch.value.trim().toLocaleLowerCase();
  const matching = songs
    .filter((song) => {
      if (!query) return true;
      return [song.title, song.artist, song.key, song.tuning]
        .filter((value): value is string => Boolean(value))
        .some((value) => value.toLocaleLowerCase().includes(query));
    })
    .filter((song) => !tuningOnly || Boolean(song.tuning?.trim()));
  const ordered = [...matching].sort((left, right) =>
    compareLibrarySongs(left, right, songSort),
  );

  // The inline editor is taller than the normal list cap; let the library pane
  // scroll instead of nesting the editor in a 340px scroller while it is open.
  reconcileLibraryEditor(ordered);
  const editor = libraryEditor;
  songListEl.classList.toggle(
    "has-editor",
    editor !== null && ordered.some((song) => song.id === editor.songId),
  );

  songCountEl.textContent = String(songs.length);
  songCountEl.setAttribute(
    "aria-label",
    `${songs.length} ${songs.length === 1 ? "song" : "songs"} in the library`,
  );

  if (ordered.length === 0) {
    songListEl.replaceChildren(el("li", "empty-state", libraryEmptyMessage(query)));
    return;
  }

  const fragment = document.createDocumentFragment();
  for (const song of ordered) {
    fragment.append(buildLibraryRow(song));
  }
  songListEl.replaceChildren(fragment);
}

function libraryEmptyMessage(query: string): string {
  if (songs.length === 0) return "No songs yet. Add the first one below.";
  if (query) {
    return tuningOnly
      ? "No songs with tuning match that search."
      : "No songs match that search.";
  }
  if (tuningOnly) return "No songs have a tuning set.";
  return "No songs match that search.";
}

function sortSongsByTitle(): void {
  songs.sort((left, right) => left.title.localeCompare(right.title));
}

/** Sorts by the chosen field, puts missing values last, and falls back to title. */
function compareLibrarySongs(left: Song, right: Song, sort: SongSortKey): number {
  const leftValue = (left[sort] ?? "").trim();
  const rightValue = (right[sort] ?? "").trim();

  if (!leftValue && rightValue) return 1;
  if (leftValue && !rightValue) return -1;

  const primary = leftValue.localeCompare(rightValue);
  if (primary !== 0) return primary;
  return sort === "title" ? 0 : left.title.localeCompare(right.title);
}

function buildLibraryRow(song: Song): HTMLLIElement {
  const row = el("li", "song-item");
  const editor = libraryEditor;
  const editing = editor !== null && editor.songId === song.id;
  if (editing) row.classList.add("is-editing");

  const info = el("div", "song-info");
  info.append(el("span", "song-item-title", song.title));

  const metaParts = [
    song.artist?.trim(),
    song.key?.trim(),
    song.tuning?.trim(),
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

  const copyButton = el("button", "icon-button");
  copyButton.type = "button";
  copyButton.title = `Duplicate ${song.title}`;
  copyButton.setAttribute("aria-label", `Duplicate ${song.title} in the library`);
  copyButton.append(copyIcon());
  copyButton.addEventListener("click", () => {
    void duplicateLibrarySong(song);
  });

  const editButton = el("button", "icon-button");
  editButton.type = "button";
  editButton.dataset.editSongId = song.id;
  editButton.title = `Edit ${song.title}`;
  editButton.setAttribute("aria-label", `Edit ${song.title} in the library`);
  editButton.setAttribute("aria-expanded", String(editing));
  if (editing) editButton.setAttribute("aria-controls", libraryEditorId(song.id));
  editButton.append(editIcon());
  editButton.addEventListener("click", () => openLibraryEditor(song.id));

  const removeButton = el("button", "icon-button", "✕");
  removeButton.type = "button";
  removeButton.title = `Remove ${song.title} from the library`;
  removeButton.setAttribute("aria-label", `Remove ${song.title} from the library`);
  removeButton.addEventListener("click", () => {
    void deleteLibrarySong(song);
  });

  if (restoring || backingUp) {
    addButton.disabled = true;
    copyButton.disabled = true;
    editButton.disabled = true;
    removeButton.disabled = true;
  }

  actions.append(addButton, copyButton, editButton, removeButton);
  row.append(info, actions);
  if (editing && editor) row.append(buildLibraryEditor(song, editor));
  return row;
}

/** Copy glyph (two overlapping sheets) built as SVG so no font fallback is needed. */
function copyIcon(): SVGSVGElement {
  const ns = "http://www.w3.org/2000/svg";
  const svg = document.createElementNS(ns, "svg");
  svg.setAttribute("viewBox", "0 0 24 24");
  svg.setAttribute("width", "17");
  svg.setAttribute("height", "17");
  svg.setAttribute("fill", "none");
  svg.setAttribute("stroke", "currentColor");
  svg.setAttribute("stroke-width", "1.8");
  svg.setAttribute("stroke-linejoin", "round");
  svg.setAttribute("aria-hidden", "true");
  svg.setAttribute("focusable", "false");

  for (const [x, y] of [
    ["9", "9"],
    ["4", "4"],
  ] as const) {
    const sheet = document.createElementNS(ns, "rect");
    sheet.setAttribute("x", x);
    sheet.setAttribute("y", y);
    sheet.setAttribute("width", "11");
    sheet.setAttribute("height", "11");
    sheet.setAttribute("rx", "2");
    svg.append(sheet);
  }

  return svg;
}

/** Pencil glyph for the inline library editor. */
function editIcon(): SVGSVGElement {
  const ns = "http://www.w3.org/2000/svg";
  const svg = document.createElementNS(ns, "svg");
  svg.setAttribute("viewBox", "0 0 24 24");
  svg.setAttribute("width", "17");
  svg.setAttribute("height", "17");
  svg.setAttribute("fill", "none");
  svg.setAttribute("stroke", "currentColor");
  svg.setAttribute("stroke-width", "1.8");
  svg.setAttribute("stroke-linecap", "round");
  svg.setAttribute("stroke-linejoin", "round");
  svg.setAttribute("aria-hidden", "true");
  svg.setAttribute("focusable", "false");

  const outline = document.createElementNS(ns, "path");
  outline.setAttribute("d", "M4 20h4L18.5 9.5a2.1 2.1 0 0 0-3-3L5 17v3Z");
  const nib = document.createElementNS(ns, "path");
  nib.setAttribute("d", "M13.5 6.5l4 4");
  svg.append(outline, nib);

  return svg;
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
      song.tuning?.trim(),
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

  const tuningField = textField("Tuning", song.tuning ?? "", "E Std");
  tuningField.input.maxLength = 24;
  tuningField.input.addEventListener("input", () => {
    song.tuning = trimmedOrNull(tuningField.input.value);
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

  const notesField = textField("Comment", song.notes ?? "", "Count-in, capo, cue…");
  notesField.input.maxLength = MAX_COMMENT_CHARS;
  notesField.input.addEventListener("input", () => {
    song.notes = trimmedOrNull(notesField.input.value);
    markDirty();
    renderSheet();
  });

  fields.append(
    titleField.element,
    artistField.element,
    keyField.element,
    tuningField.element,
    bpmField.element,
    durationField.element,
    notesField.element,
  );
  details.append(fields);
  main.append(details);

  row.append(number, main, buildItemActions(index));
  return row;
}

function buildBreakItem(breakItem: BreakItem, index: number): HTMLLIElement {
  const row = el("li", "item-row break-item");
  row.draggable = true;
  row.dataset.index = String(index);

  const number = buildItemLead("—");
  const main = el("div", "item-main");
  const heading = el("div", "item-heading");
  const titleNode = el("span", "item-title", breakHeading(breakItem.label));
  const metaNode = el("span", "item-sub");
  heading.append(titleNode, metaNode);
  main.append(heading);

  const refreshTitle = (): void => {
    titleNode.textContent = breakHeading(breakItem.label);
  };

  const refreshMeta = (): void => {
    updateBreakMeta(metaNode, breakItem);
  };
  refreshMeta();

  const details = el("details", "item-details");
  details.append(el("summary", "item-details-summary", "Edit break"));

  const fields = el("div", "item-fields");

  const labelField = textField("Label", breakItem.label ?? "", "Intermission / Encore");
  labelField.input.maxLength = MAX_BREAK_LABEL_CHARS;
  labelField.input.addEventListener("input", () => {
    breakItem.label = trimmedOrNull(labelField.input.value);
    refreshTitle();
    markDirty();
    renderSheet();
  });

  const durationField = textField(
    "Duration",
    durationInputValue(breakItem.duration_secs),
    "10:00",
  );
  durationField.input.dataset.field = "break-duration";
  // Fits the longest valid value, `600:00` (36000 seconds).
  durationField.input.maxLength = 6;
  durationField.input.addEventListener("change", () => {
    const committed = commitBreakDurationInput(durationField.input, breakItem);
    if (!committed.ok) {
      setStatus(committed.error, "error");
      return;
    }

    markDirty();
    renderSheet();
  });

  const noteField = textField("Comment", breakItem.note ?? "", "Tune down, speech…");
  noteField.input.maxLength = MAX_COMMENT_CHARS;
  noteField.input.addEventListener("input", () => {
    breakItem.note = trimmedOrNull(noteField.input.value);
    refreshMeta();
    markDirty();
    renderSheet();
  });

  fields.append(labelField.element, durationField.element, noteField.element);
  details.append(fields);
  main.append(details);

  row.append(number, main, buildItemActions(index));
  return row;
}

/** Custom break heading, falling back to the generic `Break`. */
function breakHeading(label: string | null | undefined): string {
  return label?.trim() || "Break";
}

/**
 * Break fields share song-duration parsing, but stay `mm:ss`: no hour part and
 * no seconds value of 60 or more (`99:99` is a typo, not 100 minutes 39 s).
 */
function parseBreakDuration(value: string): number | null {
  const trimmed = value.trim();
  const parsed = parseDuration(trimmed);
  if (parsed === null) return null;

  const parts = trimmed.split(":");
  if (parts.length > 2 || parts.some((part) => !/^\d+$/.test(part))) {
    return null;
  }
  if (parts.length === 2 && Number(parts[1]) >= 60) {
    return null;
  }

  return parsed;
}

/** Refreshes the break row subtitle from the model item. */
function updateBreakMeta(metaNode: HTMLElement, breakItem: BreakItem): void {
  metaNode.textContent = [
    formatBreakDuration(breakItem.duration_secs),
    breakItem.note?.trim(),
  ]
    .filter((part): part is string => Boolean(part))
    .join(" · ");
}

type BreakDurationCommit =
  | { ok: true; changed: boolean }
  | { ok: false; error: string };

/**
 * Validates the rendered break field and commits its seconds to the model.
 *
 * Used by both the field's `change` handler and the pre-save pass, so a
 * Ctrl/Cmd+S with the field still focused cannot save a stale duration. Invalid
 * input marks the field and leaves the model untouched; valid input also
 * normalizes the field text and refreshes the row subtitle.
 */
function commitBreakDurationInput(
  input: HTMLInputElement,
  breakItem: BreakItem,
): BreakDurationCommit {
  const parsed = parseBreakDuration(input.value.trim());
  if (parsed === null) {
    markFieldInvalid(input, true);
    return {
      ok: false,
      error:
        "Break duration must use mm:ss between 0:00 and 600:00; blank is not allowed.",
    };
  }
  if (parsed > MAX_BREAK_SECS) {
    markFieldInvalid(input, true);
    return {
      ok: false,
      error: "Break duration must be at most 600:00 (10 hours).",
    };
  }

  markFieldInvalid(input, false);
  const changed = breakItem.duration_secs !== parsed;
  breakItem.duration_secs = parsed;
  input.value = durationInputValue(parsed);

  const metaNode = input
    .closest<HTMLElement>(".item-row")
    ?.querySelector<HTMLElement>(".item-sub");
  if (metaNode) updateBreakMeta(metaNode, breakItem);

  return { ok: true, changed };
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
  // Export temporarily mutates the live sheet and holds the raster; ignoring
  // edits here keeps the capture consistent. The export finally block renders
  // the latest state once the sheet is restored.
  if (exporting) return;

  if (!current) {
    sheet.replaceChildren();
    sheetPages.replaceChildren();
    sheetFrame.classList.remove("is-framed");
    renderedPageCount = 0;
    return;
  }

  // The class (not inline styles) is the single switch for the multiple-page
  // escape hatch in both the screen and print stylesheets. It must be applied
  // before the height measurements below.
  const multi = isMultiPage();
  sheet.classList.toggle("multipage", multi);
  // In multiple mode the tall sheet stays in the DOM as the export/measurement
  // source, but the frame stack is what the preview and print show.
  sheetFrame.classList.toggle("is-framed", multi);

  renderSetlistSheet(sheet, current, {
    logoUrl: logoSrc,
    grayscaleLogo: grayscaleLogoInput.checked,
    onLogoLayout: handleSheetLayout,
  });
  renderSummary();

  if (multi) {
    renderPageFrames();
  } else {
    sheetPages.replaceChildren();
    renderedPageCount = 0;
    fitSheetToPage();
  }
}

/**
 * Re-paginates the multiple-page frame stack from the tall source sheet and
 * updates the meta label with the actual frame count.
 */
function renderPageFrames(): void {
  renderedPageCount = renderSheetPages(sheet, sheetPages, {
    previewScale: currentSheetScale(),
  });
  updateFitHint(1, false);
  syncSheetHeight();
}

/** Logo/fonts can change the measured header height; re-paginate when framed. */
function handleSheetLayout(): void {
  if (exporting) return;
  if (isMultiPage()) {
    renderPageFrames();
    return;
  }
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
 * Shrink the setlist table (via --sheet-fit zoom) until it fits the 271mm
 * content area of one A4 page. --sheet-fit also drives the print stylesheet, so
 * the paper output matches the preview. Never grows content, only shrinks down
 * to SHEET_FIT_MIN.
 *
 * The zoom is applied to `.sheet-table`, not to `#setlist-sheet`: the sheet is a
 * fixed A4 box, and zooming the box would scale the clipping boundary along
 * with the content, so no extra rows would ever become visible.
 *
 * Multiple-page mode never reaches this function: the callers render page
 * frames instead and report the actual frame count.
 */
function fitSheetToPage(): void {
  // Export holds the sheet in its full-height layout; the finally block refits
  // the preview once the DOM is restored.
  if (exporting) return;

  applySheetFit(1);

  const table = sheet.querySelector<HTMLTableElement>(".sheet-table");
  if (!table) {
    updateFitHint(1, false);
    syncSheetHeight();
    return;
  }

  // Start from the measured natural height, rounded down to whole percent, then
  // verify against the painted height. Zoom changes the pre-zoom layout width
  // (the table keeps 100% width), so the first estimate can be off by a step.
  //
  // `#setlist-sheet` is scaled by --sheet-scale in the preview, and the painted
  // rect includes that ancestor transform. The 271mm target is unscaled, so
  // divide the measured height by the preview scale; otherwise the required fit
  // changes with the window width and the overfull hint never fires.
  const target = A4_CONTENT_HEIGHT_PX;
  const previewScale = currentSheetScale();
  const tableHeight = (): number => table.getBoundingClientRect().height / previewScale;
  let fit = 1;

  if (tableHeight() > target + 1) {
    const required = target / tableHeight();
    fit = Math.min(1, Math.max(SHEET_FIT_MIN, Math.floor(required * 100) / 100));
    applySheetFit(fit);

    for (let i = 0; i < 12 && fit > SHEET_FIT_MIN; i += 1) {
      // Reading the rect forces a reflow, so each zoom step is measured.
      if (tableHeight() <= target + 1) break;
      fit = Math.max(
        SHEET_FIT_MIN,
        Math.round((fit - SHEET_FIT_STEP) * 1000) / 1000,
      );
      applySheetFit(fit);
    }
  }

  const overfull = tableHeight() > target + 1;
  updateFitHint(fit, overfull);
  syncSheetHeight();
}

function applySheetFit(fit: number): void {
  sheet.style.setProperty("--sheet-fit", String(fit));
}

function updateFitHint(fit: number, overfull: boolean): void {
  if (isMultiPage()) {
    const pages = Math.max(1, renderedPageCount);
    previewMeta.textContent = `A4 · multiple pages · ${pages} ${
      pages === 1 ? "page" : "pages"
    }`;
    previewMeta.classList.remove("is-hint");
    return;
  }

  if (fit >= 0.999 && !overfull) {
    previewMeta.textContent = "A4 · 210 × 297 mm · black on white";
    previewMeta.classList.remove("is-hint");
    return;
  }

  // The label always mirrors the applied zoom, clamped to the 50% floor.
  const percent = Math.round(fit * 100);

  if (overfull) {
    previewMeta.textContent = `A4 · single page · auto-fit ${percent}% — still overfull; try multiple pages`;
    previewMeta.classList.add("is-hint");
    return;
  }

  const illegible = fit < LEGIBILITY_MIN_FIT;
  previewMeta.textContent = illegible
    ? `A4 · single page · auto-fit ${percent}% — try multiple pages`
    : `A4 · single page · auto-fit ${percent}%`;
  previewMeta.classList.toggle("is-hint", illegible);
}

function syncSheetHeight(): void {
  if (exporting) return;
  requestAnimationFrame(() => {
    if (exporting) return;
    const scale = currentSheetScale();
    // The frame stack is the visible preview in multiple mode; the tall sheet
    // is only the measurement/export source. Both are measured unscaled and
    // then multiplied by the preview scale for the clipping box.
    const target = isMultiPage() ? sheetPages : sheet;
    sheetFrame.style.height = `${Math.ceil(target.offsetHeight * scale)}px`;
  });
}

function currentSheetScale(): number {
  const raw = getComputedStyle(sheetScroll).getPropertyValue("--sheet-scale").trim();
  const parsed = Number.parseFloat(raw);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : 1;
}

function isMultiPage(): boolean {
  return withPageModeDefaults(current?.page_mode) === "Multiple";
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

  current.items.push({ Break: { duration_secs: 600, note: null, label: null } });
  markDirty();
  renderItems();
  renderSheet();

  const lastRow = itemList.lastElementChild;
  const duration = lastRow?.querySelector<HTMLInputElement>(
    'input[data-field="break-duration"]',
  );
  if (duration) {
    const details = lastRow?.querySelector("details");
    if (details) details.open = true;
    duration.focus();
    duration.select();
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
  if (addingSong) return;
  if (blockLibraryActionWhileBusy()) return;
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
    tuning: trimmedOrNull(newSongTuning.value),
    duration_secs: duration,
    notes: trimmedOrNull(newSongNotes.value),
  };

  const addFormOwnedFocus =
    addFormOwnsFocus() ||
    (event.submitter instanceof HTMLElement && songForm.contains(event.submitter));

  try {
    addingSong = true;
    libraryWritesInFlight += 1;
    syncAddSongControls();

    await api.saveSong(song);
    // Capture focus ownership before reset/render; a user who moved to the
    // inline editor, search, or sort must not be pulled back to the Add title.
    pendingLibraryEditorFocus = null;
    const directEditorFocus = captureLibraryEditorFocus();
    const editorFocus =
      directEditorFocus ?? (isPageFocusLost() ? libraryEditor?.focusMemory ?? null : null);
    const restoreTitleFocus =
      addFormOwnsFocus() ||
      (addFormOwnedFocus && isPageFocusLost() && !editorFocus);
    songs.push(song);
    sortSongsByTitle();
    songForm.reset();
    renderLibrary();
    setStatus(`Added “${song.title}” to the library.`, "success");
    if (restoreTitleFocus) {
      newSongTitle.focus();
    } else if (editorFocus && !restoreLibraryEditorFocus(editorFocus)) {
      pendingLibraryEditorFocus = editorFocus;
    }
  } catch (error) {
    setStatus(
      `Could not add “${song.title}” to the library: ${describeError(error)}`,
      "error",
    );
  } finally {
    addingSong = false;
    libraryWritesInFlight -= 1;
    syncAddSongControls();
  }
}

/** Locks the Add-to-library submit during an Add request, backup, or restore. */
function syncAddSongControls(): void {
  const locked = addingSong || restoring || backingUp;
  // Only an actual Add request keeps the editable form semantically busy.
  songForm.setAttribute("aria-busy", String(addingSong));
  if (addSongButton) {
    addSongButton.disabled = locked;
    addSongButton.textContent = addingSong ? "Adding…" : "Add song";
  }
}

function addFormOwnsFocus(): boolean {
  const active = document.activeElement;
  if (isPageFocusLost()) {
    // With an inline draft open, body focus usually means the editor was
    // disabled/rendered, not that the Add form owns the caret.
    return !libraryEditor;
  }
  return active !== null && songForm.contains(active);
}

function libraryEditorId(songId: string): string {
  return `song-editor-${songId}`;
}

function draftFromSong(song: Song): LibrarySongDraft {
  return {
    title: song.title,
    artist: song.artist ?? "",
    key: song.key ?? "",
    tuning: song.tuning ?? "",
    bpm: song.bpm === null ? "" : String(song.bpm),
    duration: durationInputValue(song.duration_secs),
    notes: song.notes ?? "",
  };
}

/** Title used in editor statuses so a failure/discard names exactly one song. */
function libraryEditorLabel(editor: LibraryEditorState): string {
  const draftTitle = editor.draft.title.trim();
  if (draftTitle) return draftTitle;
  return songs.find((song) => song.id === editor.songId)?.title.trim() || "Untitled song";
}

/**
 * Opens the inline editor for one library row. Only one editor exists at a
 * time: opening another row discards the previous draft without touching the
 * cache, which is safe because edits are only persisted by Save. The draft is
 * kept in state so unrelated library re-renders cannot reset it.
 */
function openLibraryEditor(songId: string): void {
  if (blockLibraryActionWhileBusy()) return;

  const song = songs.find((entry) => entry.id === songId);
  if (!song) return;

  if (libraryEditor?.saving) {
    setStatus("Wait for the current song save to finish before editing another.", "info");
    return;
  }

  if (libraryEditor?.songId === songId) {
    focusLibraryEditor(songId);
    return;
  }

  const previous = libraryEditor;
  if (previous && (previous.retryPending || previous.invalidFields.size > 0)) {
    setStatus(`Discarded the failed edit for “${libraryEditorLabel(previous)}”.`, "info");
  }

  pendingLibraryEditorFocus = null;
  libraryEditor = {
    songId,
    draft: draftFromSong(song),
    saving: false,
    retryPending: false,
    invalidFields: new Set(),
    hiddenByFilter: false,
    focusMemory: null,
  };
  renderLibrary();
  focusLibraryEditor(songId);
}

/**
 * Tracks whether the open editor's row is visible. An idle editor whose row is
 * hidden is dropped during the same render, so clearing the filter cannot
 * resurrect it. A saving editor is left alone until the request resolves:
 * success closes it normally, while failure keeps the draft so clearing the
 * filter allows a retry.
 */
function reconcileLibraryEditor(ordered: Song[]): void {
  const editor = libraryEditor;
  if (!editor) return;

  const song = songs.find((entry) => entry.id === editor.songId);
  if (!song) {
    if (!editor.saving) {
      libraryEditor = null;
      pendingLibraryEditorFocus = null;
    }
    return;
  }

  const visible = ordered.some((entry) => entry.id === editor.songId);
  if (visible) {
    const wasHidden = editor.hiddenByFilter;
    editor.hiddenByFilter = false;
    if (!editor.saving && wasHidden && editor.retryPending) {
      setStatus(
        `Restored the failed edit for “${libraryEditorLabel(editor)}”. Retry Save.`,
        "info",
      );
    }
    return;
  }

  editor.hiddenByFilter = true;
  if (editor.saving) return;
  // A failed draft stays retry-pending even while hidden; further filter
  // renders must not silently discard it. Clearing the filter restores it.
  if (editor.retryPending) return;

  libraryEditor = null;
  pendingLibraryEditorFocus = null;
  setStatus(
    `Edit cancelled — “${libraryEditorLabel(editor)}” is hidden by the current search or filter.`,
    "info",
  );
}

/** Discards the open row draft and returns focus to that row's Edit button. */
function cancelLibraryEditor(songId: string): void {
  const editor = libraryEditor;
  if (!editor || editor.songId !== songId || editor.saving) return;
  if (editor.retryPending || editor.invalidFields.size > 0) {
    setStatus(`Discarded the failed edit for “${libraryEditorLabel(editor)}”.`, "info");
  }
  pendingLibraryEditorFocus = null;
  libraryEditor = null;
  renderLibrary();
  focusLibraryEditButton(songId);
}

function findLibraryEditor(songId: string): HTMLFormElement | null {
  for (const form of songListEl.querySelectorAll<HTMLFormElement>("form.song-item-editor")) {
    if (form.dataset.editSongId === songId) return form;
  }
  return null;
}

function focusLibraryEditor(songId: string): void {
  const input = findLibraryEditor(songId)?.querySelector<HTMLInputElement>("input");
  input?.focus();
}

/** Keeps focus in the library after a re-render; falls back to search when filtered out. */
function focusLibraryEditButton(songId: string): void {
  for (const button of songListEl.querySelectorAll<HTMLButtonElement>("button[data-edit-song-id]")) {
    if (button.dataset.editSongId === songId) {
      button.focus();
      return;
    }
  }
  songSearch.focus();
}

/**
 * Focus is ours to restore only while the editor still owns it or the browser
 * dropped it to the page body. Any deliberate move to search/sort/Add form wins.
 */
function shouldRestoreEditorFocus(focusTarget: HTMLElement | null): boolean {
  const active = document.activeElement;
  return (
    active === null ||
    active === document.body ||
    active === document.documentElement ||
    active === focusTarget
  );
}

function isPageFocusLost(): boolean {
  const active = document.activeElement;
  return active === null || active === document.body || active === document.documentElement;
}

/** Converts a focused editor element into a restorable descriptor. */
function libraryEditorFocusTargetFromElement(
  element: Element | null,
): LibraryEditorFocusTarget | null {
  if (!element) return null;

  const form = element.closest<HTMLFormElement>("form.song-item-editor");
  const songId = form?.dataset.editSongId;
  if (!form || !songId) return null;

  if (element instanceof HTMLInputElement) {
    const inputs = [...form.querySelectorAll<HTMLInputElement>("input")];
    const inputIndex = inputs.indexOf(element);
    if (inputIndex < 0) return null;
    return {
      kind: "input",
      songId,
      inputIndex,
      selectionStart: element.selectionStart,
      selectionEnd: element.selectionEnd,
      selectionDirection: element.selectionDirection,
    };
  }

  if (element instanceof HTMLButtonElement && element.closest(".song-editor-actions")) {
    return {
      kind: "button",
      songId,
      action: element.type === "submit" ? "save" : "cancel",
    };
  }

  return null;
}

/** Remembers the focused inline-editor field/button before an unrelated render. */
function captureLibraryEditorFocus(): LibraryEditorFocusTarget | null {
  return libraryEditorFocusTargetFromElement(document.activeElement);
}

/** Restores a field/button and selection once its editor controls are enabled. */
function restoreLibraryEditorFocus(target: LibraryEditorFocusTarget): boolean {
  const editor = libraryEditor;
  if (!editor || editor.songId !== target.songId) return false;

  const form = findLibraryEditor(target.songId);
  if (!form) return false;

  const element =
    target.kind === "input"
      ? [...form.querySelectorAll<HTMLInputElement>("input")][target.inputIndex]
      : form.querySelector<HTMLButtonElement>(
          target.action === "save"
            ? 'button[type="submit"]'
            : '.song-editor-actions button:not([type="submit"])',
        );
  if (!element || element.disabled) return false;

  element.focus();
  if (
    element instanceof HTMLInputElement &&
    target.kind === "input" &&
    target.selectionStart !== null &&
    target.selectionEnd !== null
  ) {
    try {
      element.setSelectionRange(
        target.selectionStart,
        target.selectionEnd,
        target.selectionDirection ?? undefined,
      );
    } catch {
      // Number inputs reject selection ranges; focus restoration still applies.
    }
  }
  return true;
}

/** Applies a deferred Add-success focus restore once save controls re-enable. */
function restorePendingLibraryEditorFocus(): void {
  const pending = pendingLibraryEditorFocus;
  if (!pending) return;
  if (!isPageFocusLost()) {
    pendingLibraryEditorFocus = null;
    return;
  }
  if (!libraryEditor || libraryEditor.songId !== pending.songId) {
    pendingLibraryEditorFocus = null;
    return;
  }
  if (restoreLibraryEditorFocus(pending)) {
    pendingLibraryEditorFocus = null;
  }
}

/** Locks every control in an inline editor while its upsert is in flight. */
function setLibraryEditorBusy(form: HTMLFormElement, busy: boolean): void {
  form.setAttribute("aria-busy", String(busy));
  for (const input of form.querySelectorAll<HTMLInputElement>("input")) {
    input.disabled = busy;
  }
  for (const button of form.querySelectorAll<HTMLButtonElement>("button")) {
    button.disabled = busy;
  }
  const saveButton = form.querySelector<HTMLButtonElement>('button[type="submit"]');
  if (saveButton) {
    saveButton.textContent = busy ? "Saving…" : "Save";
  }
}

/**
 * Inline library editor with the same fields and bounds as "Add to library".
 * The form is a sibling of the row actions (never nested in a button), so Enter
 * saves through normal form submission; Escape cancels. Values come from the
 * state draft so re-renders cannot reset partially typed fields.
 */
function buildLibraryEditor(
  song: Song,
  state: LibraryEditorState,
): HTMLFormElement {
  const draft = state.draft;
  const form = el("form", "song-item-editor");
  form.id = libraryEditorId(song.id);
  form.dataset.editSongId = song.id;
  form.noValidate = true;
  form.setAttribute("aria-label", `Edit ${song.title} in the library`);

  const fields = el("div", "item-fields song-editor-fields");

  const titleField = textField("Title", draft.title, "Song title");
  titleField.element.classList.add("song-editor-wide");
  titleField.input.required = true;
  titleField.input.autocomplete = "off";

  const artistField = textField("Artist", draft.artist, "Artist");
  artistField.element.classList.add("song-editor-wide");
  artistField.input.autocomplete = "off";

  const keyField = textField("Key", draft.key, "Em");
  keyField.input.maxLength = 12;
  keyField.input.autocomplete = "off";

  const tuningField = textField("Tuning", draft.tuning, "E Std");
  tuningField.input.maxLength = 24;
  tuningField.input.autocomplete = "off";

  const bpmField = numberField("BPM", null, 1, 400);
  bpmField.input.value = draft.bpm;

  const durationField = textField("Duration", draft.duration, "4:30");
  durationField.input.inputMode = "numeric";

  const notesField = textField("Comment", draft.notes, "Count-in, capo, cue…");
  notesField.element.classList.add("song-editor-wide");
  notesField.input.maxLength = MAX_COMMENT_CHARS;
  notesField.input.autocomplete = "off";

  fields.append(
    titleField.element,
    artistField.element,
    keyField.element,
    tuningField.element,
    bpmField.element,
    durationField.element,
    notesField.element,
  );

  const fieldInputs: Record<keyof LibrarySongDraft, HTMLInputElement> = {
    title: titleField.input,
    artist: artistField.input,
    key: keyField.input,
    tuning: tuningField.input,
    bpm: bpmField.input,
    duration: durationField.input,
    notes: notesField.input,
  };
  for (const key of state.invalidFields) {
    markFieldInvalid(fieldInputs[key], true);
  }

  const rememberFocus = (event: Event): void => {
    const editor = libraryEditor;
    if (!editor || editor.songId !== song.id) return;
    const target = libraryEditorFocusTargetFromElement(
      event.target instanceof Element ? event.target : null,
    );
    if (target) editor.focusMemory = target;
  };
  form.addEventListener("focusin", rememberFocus);
  for (const input of Object.values(fieldInputs)) {
    for (const eventName of ["input", "keyup", "mouseup", "select"] as const) {
      input.addEventListener(eventName, rememberFocus);
    }
  }

  const updateDraft = (key: keyof LibrarySongDraft, input: HTMLInputElement): void => {
    input.addEventListener("input", () => {
      const editor = libraryEditor;
      if (!editor || editor.songId !== song.id || editor.saving) return;
      editor.draft[key] = input.value;
      if (editor.invalidFields.delete(key)) {
        markFieldInvalid(input, false);
      }
    });
  };

  updateDraft("title", titleField.input);
  updateDraft("artist", artistField.input);
  updateDraft("key", keyField.input);
  updateDraft("tuning", tuningField.input);
  updateDraft("bpm", bpmField.input);
  updateDraft("duration", durationField.input);
  updateDraft("notes", notesField.input);

  const actions = el("div", "song-editor-actions");
  const cancelButton = el("button", "btn btn-small", "Cancel");
  cancelButton.type = "button";
  const saveButton = el("button", "btn btn-small btn-primary", "Save");
  saveButton.type = "submit";
  actions.append(cancelButton, saveButton);

  form.addEventListener("submit", (event) => {
    event.preventDefault();
    const state = libraryEditor;
    if (!state || state.songId !== song.id || state.saving) return;
    if (blockLibraryActionWhileBusy()) return;
    if (!ensureBackend()) return;

    const title = state.draft.title.trim();
    if (!title) {
      state.invalidFields.add("title");
      markFieldInvalid(titleField.input, true);
      setStatus("Song title is required.", "error");
      titleField.input.focus();
      return;
    }

    const bpmRaw = state.draft.bpm.trim();
    const bpm = bpmRaw ? Number(bpmRaw) : null;
    if (bpm !== null && (!Number.isInteger(bpm) || bpm < 1 || bpm > 400)) {
      state.invalidFields.add("bpm");
      markFieldInvalid(bpmField.input, true);
      setStatus("BPM must be a whole number between 1 and 400.", "error");
      bpmField.input.focus();
      return;
    }

    const durationRaw = state.draft.duration.trim();
    const duration = parseDuration(durationRaw);
    if (durationRaw && duration === null) {
      state.invalidFields.add("duration");
      markFieldInvalid(durationField.input, true);
      setStatus("Duration must use mm:ss, for example 4:30.", "error");
      durationField.input.focus();
      return;
    }

    const edited: Song = {
      id: song.id,
      title,
      artist: trimmedOrNull(state.draft.artist),
      bpm,
      key: trimmedOrNull(state.draft.key),
      tuning: trimmedOrNull(state.draft.tuning),
      duration_secs: duration,
      notes: trimmedOrNull(state.draft.notes),
    };

    const focusTarget =
      form.contains(document.activeElement) && document.activeElement instanceof HTMLElement
        ? document.activeElement
        : null;

    state.retryPending = false;
    state.saving = true;
    setStatus(`Saving “${edited.title}”…`);
    setLibraryEditorBusy(form, true);
    libraryWritesInFlight += 1;
    void saveEditedLibrarySong(edited, state, focusTarget).finally(() => {
      libraryWritesInFlight -= 1;
      if (libraryEditor === state) {
        state.saving = false;
        const currentForm = findLibraryEditor(song.id) ?? form;
        setLibraryEditorBusy(currentForm, false);
        if (
          focusTarget &&
          currentForm.contains(focusTarget) &&
          shouldRestoreEditorFocus(focusTarget)
        ) {
          focusTarget.focus();
        }
      }
      restorePendingLibraryEditorFocus();
    });
  });

  cancelButton.addEventListener("click", () => {
    cancelLibraryEditor(song.id);
  });

  form.addEventListener("keydown", (event) => {
    if (event.key === "Escape") {
      event.preventDefault();
      cancelLibraryEditor(song.id);
    }
  });

  form.append(fields, actions);
  setLibraryEditorBusy(form, state.saving);
  return form;
}

/**
 * Upserts the edited song under its stable id through the normal command, then
 * re-sorts and re-renders so the active search/sort/tuning filter still applies.
 */
async function saveEditedLibrarySong(
  edited: Song,
  state: LibraryEditorState,
  focusTarget: HTMLElement | null,
): Promise<void> {
  try {
    const saved = await api.saveSong(edited);
    const index = songs.findIndex((song) => song.id === saved.id);
    if (index >= 0) {
      songs[index] = saved;
    } else {
      songs.push(saved);
    }
    sortSongsByTitle();

    const closedEditor = libraryEditor === state;
    if (closedEditor) libraryEditor = null;
    renderLibrary();
    setStatus(
      `Updated “${saved.title}” in the library. Setlists keep their own copies.`,
      "success",
    );
    if (closedEditor && focusTarget && shouldRestoreEditorFocus(focusTarget)) {
      focusLibraryEditButton(saved.id);
    }
  } catch (error) {
    // Keep the editor/draft retryable (even while a filter hides the row). The
    // hint only appears when the row is currently filtered out; visibility
    // transitions replace this message with a restore notice.
    state.retryPending = true;
    const hint = state.hiddenByFilter ? " Clear the search or filter to retry." : "";
    setStatus(
      `Could not save “${edited.title.trim() || libraryEditorLabel(state)}” in the library: ${describeError(error)}${hint}`,
      "error",
    );
  }
}

/** Saves a copy of a library song under a new id and a non-colliding “(copy)” title. */
async function duplicateLibrarySong(song: Song): Promise<void> {
  if (blockLibraryActionWhileBusy()) return;
  if (!ensureBackend()) return;

  const copy: Song = {
    ...song,
    id: newId(),
    title: duplicateSongTitle(song.title),
  };

  libraryWritesInFlight += 1;
  try {
    const saved = await api.saveSong(copy);
    songs.push(saved);
    sortSongsByTitle();
    renderLibrary();
    setStatus(`Duplicated “${song.title}” as “${saved.title}”.`, "success");
  } catch (error) {
    setStatus(`Could not duplicate song: ${describeError(error)}`, "error");
  } finally {
    libraryWritesInFlight -= 1;
  }
}

/** `Song` → `Song (copy)`, incrementing the suffix instead of stacking copies. */
function duplicateSongTitle(title: string): string {
  const base = title.replace(/\s+\(copy(?: \d+)?\)$/i, "").trim() || title.trim();
  const used = new Set(songs.map((entry) => entry.title));

  let candidate = `${base} (copy)`;
  let index = 2;
  while (used.has(candidate)) {
    candidate = `${base} (copy ${index})`;
    index += 1;
  }
  return candidate;
}

function addSongToSetlist(song: Song): void {
  if (blockLibraryActionWhileBusy()) return;
  if (!current) return;

  current.items.push({ Song: { ...song } });
  markDirty();
  renderItems();
  renderSheet();
  setStatus(`Added “${song.title}” to the running order.`, "success");
}

async function deleteLibrarySong(song: Song): Promise<void> {
  if (blockLibraryActionWhileBusy()) return;
  if (!ensureBackend()) return;
  if (libraryEditor?.songId === song.id && libraryEditor.saving) {
    setStatus("Wait for this song's save to finish before deleting it.", "info");
    return;
  }
  if (!window.confirm(`Remove “${song.title}” from the library? Setlists keep their own copies.`)) {
    return;
  }

  libraryWritesInFlight += 1;
  try {
    await api.deleteSong(song.id);
    songs = songs.filter((entry) => entry.id !== song.id);
    if (libraryEditor?.songId === song.id) {
      libraryEditor = null;
      pendingLibraryEditorFocus = null;
    }
    renderLibrary();
    setStatus(`Removed “${song.title}” from the library.`);
  } catch (error) {
    setStatus(`Could not remove song: ${describeError(error)}`, "error");
  } finally {
    libraryWritesInFlight -= 1;
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
    setStatus("Logo imported.", "success");
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

function setStatus(
  message: string,
  kind: "info" | "success" | "error" = "info",
  timeoutMs = 5000,
): void {
  statusEl.textContent = message;
  statusEl.dataset.kind = kind;

  if (statusTimer !== undefined) {
    window.clearTimeout(statusTimer);
    statusTimer = undefined;
  }

  if (kind !== "error") {
    statusTimer = window.setTimeout(() => {
      statusEl.textContent = "";
    }, timeoutMs);
  }
}

function ensureBackend(): boolean {
  if (backendAvailable) return true;
  setStatus("Local backend unavailable — start the desktop app with `npm run tauri dev`.", "error");
  return false;
}

function describeError(error: unknown): string {
  let message: string;
  if (typeof error === "string") {
    message = error;
  } else if (error instanceof Error) {
    message = error.message;
  } else {
    try {
      message = JSON.stringify(error) ?? String(error);
    } catch {
      message = String(error);
    }
  }

  // `AppError::InvalidInput` serializes as "invalid input: ...". The prefix is
  // backend jargon; the payload is already written for the status line.
  return message.replace(/^invalid input:\s*/i, "");
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

function markFieldInvalid(input: HTMLInputElement, invalid: boolean): void {
  input.classList.toggle("is-invalid", invalid);
  if (invalid) {
    input.setAttribute("aria-invalid", "true");
  } else {
    input.removeAttribute("aria-invalid");
  }
}

function clamp(value: number, min: number, max: number): number {
  if (!Number.isFinite(value)) return min;
  return Math.min(max, Math.max(min, value));
}

function isLogoAlignment(value: string): value is LogoAlignment {
  return value === "Left" || value === "Center" || value === "Right";
}

function isPageMode(value: string): value is PageMode {
  return value === "Single" || value === "Multiple";
}

function isSongSortKey(value: string): value is SongSortKey {
  return value === "title" || value === "artist" || value === "key" || value === "tuning";
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
