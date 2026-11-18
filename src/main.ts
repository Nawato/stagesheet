import "./styles/app.css";
import "./styles/print.css";

import { api } from "./api";
import {
  findArtistById,
  resolveArtistForSong,
  resolveArtistName,
  resolveSetlistLogo,
} from "./artists";
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
import type {
  Artist,
  BreakItem,
  LogoAlignment,
  LogoConfig,
  PageMode,
  Setlist,
  SheetOptions,
  Song,
} from "./types";
import {
  DEFAULT_LOGO_WIDTH_MM,
  DEFAULT_PAGE_MODE,
  DEFAULT_SHEET_OPTIONS,
  LOGO_MAX_WIDTH_MM,
  LOGO_MIN_WIDTH_MM,
  MAX_BREAK_LABEL_CHARS,
  MAX_BREAK_SECS,
  MAX_COMMENT_CHARS,
  normalizeArtistId,
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
let artists: Artist[] = [];
let setlists: Setlist[] = [];
let current: Setlist | null = null;
let dirty = false;
let backendAvailable = true;
let logoSrc: string | null = null;
/** True while `logoSrc` is a local upload preview rather than a stored logo. */
let logoPreviewIsLocal = false;
/** Stored logo file currently shown by `logoSrc`; drives resolution refreshes. */
let loadedLogoFileName: string | null = null;
let logoRequestId = 0;
let statusTimer: number | undefined;
/** Library view controls. In-memory only: sorting/filtering never dirties a setlist. */
let songSort: SongSortKey = "title";
let tuningOnly = false;
/**
 * Active workspace scope (Feature 20): a live artist record id, `UNFILED_SCOPE`
 * for the Unfiled bucket, or `null` when no artist is selected and the landing
 * page owns the workspace. In-memory only: never persisted, never backed up,
 * never dirty.
 */
let activeArtistId: string | null = null;
/** True while the landing overlay owns the workspace. */
let landingVisible = false;
/**
 * Unfiled signatures already offered per artist id, so the landing-page
 * assign offer runs once per entry instead of nagging on every visit.
 */
const landingOffered = new Map<string, string>();
/** Landing-page create form: logo file staged for the next artist record. */
let landingLogoFile: string | null = null;
/** Logo files imported for the landing draft that no record references yet. */
const landingTransientLogos = new Set<string>();
/** True while the landing create request is in flight. */
let landingBusy = false;
/** True while a landing logo upload/import is in flight. */
let landingLogoBusy = false;
/**
 * Typed-but-unsubmitted name from the landing create form, stashed before
 * every card rebuild so management renders (edit start/cancel, delete, save)
 * never drop it. Restored by `buildLandingCreateForm`.
 */
let landingCreateNameDraft = "";
/** Shows the New-artist form on a landing page that already lists artists. */
let landingShowCreate = false;
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
/** Library writes (add/edit/duplicate/delete/artist reference cleanup) in flight. */
let libraryWritesInFlight = 0;
/** True while a backup/restore owns the library snapshot. */
let backingUp = false;
let restoring = false;
/** Logo files to delete only after a setlist save succeeds. */
const pendingLogoRemovals = new Set<string>();
/** Frames currently rendered in multiple-page mode (the exact page count). */
let renderedPageCount = 0;

/** Artist form state: one shared form serves both New artist and inline edit. */
let artistFormState: ArtistFormState = createArtistFormState();
/** Object URL currently shown in the artist form preview. */
let artistLogoSrc: string | null = null;
let artistLogoRequestId = 0;
let artistLogoPreviewFailed = false;
/** True while an artist create/update/delete request is in flight. */
let artistBusy = false;
/** True while the Logo width slider is saving an artist logo width. */
let effectiveLogoSaving = false;
/** True while an artist logo upload/import is in flight. */
let artistLogoBusy = false;
/** True while deleteArtist clears song/setlist references. */
let artistDeleting = false;
/** Session cache of blob URLs for artist thumbnails, keyed by stored file name. */
const artistThumbUrls = new Map<string, string>();

/** Scope value selecting the Unfiled bucket (songs/setlists with no live artist). */
const UNFILED_SCOPE = "__unfiled__";
/** Picker value reopening the landing page without changing the scope. */
const LANDING_PICKER_VALUE = "__landing__";

/** Select value marking the legacy free-text artist option in the library editor. */
const LEGACY_ARTIST_VALUE = "__legacy_artist__";

type SongSortKey = "title" | "artist" | "key" | "tuning";

/** Input-backed library editor fields; the artist picker is a select. */
type LibrarySongDraftField =
  | "title"
  | "key"
  | "tuning"
  | "bpm"
  | "duration"
  | "notes";

/** Raw strings from the inline library editor; parsed only on Save. */
interface LibrarySongDraft {
  title: string;
  /** Selected artist record id, or "" for no artist. */
  artistId: string;
  /** Legacy free-text artist kept until the song is assigned to a record. */
  legacyArtist: string;
  /** True while the legacy option is the current selection. */
  keepLegacyArtist: boolean;
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
  invalidFields: Set<LibrarySongDraftField>;
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
      kind: "select";
      songId: string;
      selectIndex: number;
    }
  | {
      kind: "button";
      songId: string;
      action: "save" | "cancel";
    };

interface ArtistFormState {
  mode: "create" | "edit";
  artistId: string | null;
  name: string;
  logo: LogoConfig;
  /** Persisted logo before this draft started; kept when the draft is cancelled. */
  originalLogo: string | null;
  /** Files imported for this draft that are no longer its current logo. */
  transientLogos: Set<string>;
}

function createArtistFormState(): ArtistFormState {
  return {
    mode: "create",
    artistId: null,
    name: "",
    logo: {
      file_name: null,
      width_mm: DEFAULT_LOGO_WIDTH_MM,
      alignment: "Center",
    },
    originalLogo: null,
    transientLogos: new Set(),
  };
}

/** Deferred focus restore when an Add finishes while the editor is still busy. */
let pendingLibraryEditorFocus: LibraryEditorFocusTarget | null = null;

// ---------------------------------------------------------------------------
// Elements
// ---------------------------------------------------------------------------

const statusEl = byId<HTMLParagraphElement>("status");

const setlistArtistFilterSelect = byId<HTMLSelectElement>("setlist-artist-filter");
const setlistSelect = byId<HTMLSelectElement>("setlist-select");
const newSetlistButton = byId<HTMLButtonElement>("new-setlist");
const newSetlistHint = byId<HTMLSpanElement>("new-setlist-hint");
const saveSetlistButton = byId<HTMLButtonElement>("save-setlist");
const printButton = byId<HTMLButtonElement>("print-setlist");
const exportButton = byId<HTMLButtonElement>("export-setlist");
const exportMenu = byId<HTMLDivElement>("export-menu");
const exportMenuItems = Array.from(
  exportMenu.querySelectorAll<HTMLButtonElement>("button[data-export-format]"),
);
const exportOpenAfterInput = byId<HTMLInputElement>("export-open-after");
const deleteSetlistButton = byId<HTMLButtonElement>("delete-setlist");
const duplicateSetlistButton = byId<HTMLButtonElement>("duplicate-setlist");

const songSearch = byId<HTMLInputElement>("song-search");
const songSortSelect = byId<HTMLSelectElement>("song-sort");
const songTuningOnlyInput = byId<HTMLInputElement>("song-tuning-only");
const songListEl = byId<HTMLUListElement>("song-list");
const songCountEl = byId<HTMLSpanElement>("song-count");
const songForm = byId<HTMLFormElement>("song-form");
const newSongArtistField = byId<HTMLDivElement>("new-song-artist-field");
const newSongTitle = byId<HTMLInputElement>("new-song-title");
const newSongArtist = byId<HTMLSelectElement>("new-song-artist");
const newSongKey = byId<HTMLInputElement>("new-song-key");
const newSongTuning = byId<HTMLInputElement>("new-song-tuning");
const newSongBpm = byId<HTMLInputElement>("new-song-bpm");
const newSongDuration = byId<HTMLInputElement>("new-song-duration");
const newSongNotes = byId<HTMLInputElement>("new-song-notes");
const addSongButton = songForm.querySelector<HTMLButtonElement>('button[type="submit"]');

const titleInput = byId<HTMLInputElement>("setlist-title");
const venueInput = byId<HTMLInputElement>("setlist-venue");
const dateInput = byId<HTMLInputElement>("setlist-date");
const setlistFileUnderRow = byId<HTMLDivElement>("setlist-fileunder");
const setlistFileUnderSelect = byId<HTMLSelectElement>("setlist-fileunder-select");
const setlistFileUnderNote = byId<HTMLParagraphElement>("setlist-fileunder-note");
const dirtyIndicator = byId<HTMLSpanElement>("dirty-indicator");
const setlistSummary = byId<HTMLParagraphElement>("setlist-summary");

const itemList = byId<HTMLOListElement>("item-list");
const emptyItems = byId<HTMLParagraphElement>("empty-items");
const addBreakButton = byId<HTMLButtonElement>("add-break");

const logoFileInput = byId<HTMLInputElement>("logo-file");
const logoRemoveButton = byId<HTMLButtonElement>("logo-remove");
const logoWidthInput = byId<HTMLInputElement>("logo-width");
const logoWidthOutput = byId<HTMLOutputElement>("logo-width-value");
const logoShowingEl = byId<HTMLParagraphElement>("logo-showing");
const alignmentRadios = Array.from(
  document.querySelectorAll<HTMLInputElement>('input[name="logo-alignment"]'),
);
const grayscaleLogoInput = byId<HTMLInputElement>("logo-grayscale");

const sheet = byId<HTMLDivElement>("setlist-sheet");
const sheetPages = byId<HTMLDivElement>("sheet-pages");
const sheetFrame = byId<HTMLDivElement>("sheet-frame");
const sheetScroll = byId<HTMLDivElement>("sheet-scroll");
const previewMeta = byId<HTMLParagraphElement>("preview-meta");

const landingOverlay = byId<HTMLDivElement>("landing-overlay");
const landingCard = byId<HTMLDivElement>("landing-card");

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
  exportButton.addEventListener("click", () => {
    if (exportMenu.hidden) {
      openExportMenu();
    } else {
      closeExportMenu();
    }
  });
  exportButton.addEventListener("keydown", (event) => {
    if (event.key === "ArrowDown" || event.key === "ArrowUp") {
      event.preventDefault();
      openExportMenu(event.key === "ArrowUp" ? "last" : "first");
    } else if (event.key === "Escape" && !exportMenu.hidden) {
      event.preventDefault();
      closeExportMenu();
    }
  });
  exportMenu.addEventListener("keydown", (event) => {
    if (event.key === "Escape") {
      event.preventDefault();
      closeExportMenu(true);
    } else if (event.key === "ArrowDown" || event.key === "ArrowUp") {
      event.preventDefault();
      focusExportMenuItem(event.key === "ArrowUp" ? -1 : 1);
    } else if (event.key === "Home") {
      event.preventDefault();
      focusExportMenuItem("first");
    } else if (event.key === "End") {
      event.preventDefault();
      focusExportMenuItem("last");
    } else if (event.key === "Tab") {
      closeExportMenu();
    }
  });
  for (const item of exportMenuItems) {
    item.addEventListener("click", () => {
      const format = item.dataset.exportFormat;
      if (format !== "pdf" && format !== "png") return;
      closeExportMenu();
      void exportCurrent(format);
    });
  }
  document.addEventListener("pointerdown", (event) => {
    if (exportMenu.hidden) return;
    if (!(event.target instanceof Node)) return;
    if (!exportMenu.parentElement?.contains(event.target)) {
      closeExportMenu();
    }
  });
  exportMenu.parentElement?.addEventListener("focusout", (event) => {
    if (exportMenu.hidden) return;
    const next = event.relatedTarget;
    if (!(next instanceof Node)) {
      closeExportMenu();
      return;
    }
    if (!exportMenu.parentElement?.contains(next)) {
      closeExportMenu();
    }
  });
  deleteSetlistButton.addEventListener("click", () => {
    void deleteCurrent();
  });
  duplicateSetlistButton.addEventListener("click", () => {
    void duplicateCurrent();
  });
  setlistArtistFilterSelect.addEventListener("change", () => {
    const value = setlistArtistFilterSelect.value;
    if (value === LANDING_PICKER_VALUE) {
      // Reopen the landing page without leaving the scope.
      landingVisible = true;
      landingShowCreate = false;
      renderScopePicker();
      renderLanding();
      return;
    }
    if (value === UNFILED_SCOPE || artists.some((artist) => artist.id === value)) {
      void switchScope(value);
      return;
    }
    renderScopePicker();
  });
  setlistSelect.addEventListener("change", () => {
    void handleSetlistChange();
  });

  titleInput.addEventListener("input", () => {
    if (!current || captureGuard()) return;
    current.title = titleInput.value;
    markDirty();
    renderSetlistSelect();
    renderSheet();
  });
  venueInput.addEventListener("input", () => {
    if (!current || captureGuard()) return;
    current.venue = trimmedOrNull(venueInput.value);
    markDirty();
    renderSheet();
  });
  dateInput.addEventListener("input", () => {
    if (!current || captureGuard()) return;
    current.date = dateInput.value || null;
    markDirty();
    renderSheet();
  });
  setlistFileUnderSelect.addEventListener("change", () => {
    const value = setlistFileUnderSelect.value;
    if (captureGuard()) {
      renderFileUnder();
      return;
    }
    if (!value) {
      renderFileUnder();
      return;
    }
    void fileCurrentSetlist(value);
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
  landingOverlay.addEventListener("keydown", (event) => {
    if (event.key === "Escape" && activeArtistId !== null) {
      event.preventDefault();
      // An open edit draft cancels first (focus returns to its Edit button)
      // instead of closing the landing page from under it.
      const editingId = artistFormState.mode === "edit" ? artistFormState.artistId : null;
      if (editingId !== null && !artistBusy) {
        cancelArtistEdit(editingId);
        return;
      }
      closeLanding();
    }
  });
  addBreakButton.addEventListener("click", addBreak);

  itemList.addEventListener("click", handleItemClick);
  bindDragReorder();

  logoFileInput.addEventListener("change", () => {
    void handleLogoFile();
  });
  logoRemoveButton.addEventListener("click", handleLogoRemove);
  logoWidthInput.addEventListener("input", () => {
    if (!current || captureGuard()) return;
    const width = clamp(
      Number(logoWidthInput.value),
      LOGO_MIN_WIDTH_MM,
      LOGO_MAX_WIDTH_MM,
    );
    // Artist-logo path: live-update the label only; the `change` handler
    // commits via `save_artist` without dirtying the setlist. Own and
    // placeholder paths keep today's input-driven `setlist.logo` behavior.
    if (effectiveLogoCase() === "artist") {
      logoWidthOutput.textContent = `${Math.round(width)} mm`;
      return;
    }
    current.logo.width_mm = width;
    logoWidthOutput.textContent = `${Math.round(current.logo.width_mm)} mm`;
    markDirty();
    renderSheet();
  });
  logoWidthInput.addEventListener("change", () => {
    if (!current || captureGuard()) return;
    if (effectiveLogoCase() !== "artist") return;
    void commitEffectiveArtistLogoWidth();
  });
  for (const radio of alignmentRadios) {
    radio.addEventListener("change", () => {
      if (!current || !radio.checked || !isLogoAlignment(radio.value)) return;
      if (captureGuard()) {
        renderLogoControls();
        return;
      }
      if (effectiveLogoCase() === "artist") {
        void commitEffectiveArtistLogoAlignment(radio.value);
        return;
      }
      current.logo.alignment = radio.value;
      markDirty();
      renderSheet();
    });
  }
  grayscaleLogoInput.addEventListener("change", renderSheet);

  for (const [key, input] of sheetOptionInputs) {
    input.addEventListener("change", () => {
      if (!current) return;
      if (captureGuard()) {
        renderSheetOptions();
        return;
      }
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
      if (captureGuard()) {
        renderPageModeControls();
        return;
      }
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
        const landingForm = event.target.closest<HTMLFormElement>("form.landing-form");
        if (landingForm) {
          landingForm.requestSubmit();
          return;
        }
        const artistEditForm = event.target.closest<HTMLFormElement>("form.artist-form");
        if (artistEditForm) {
          artistEditForm.requestSubmit();
          return;
        }
      }
      void saveCurrent();
    }
  });

  window.addEventListener("beforeunload", (event) => {
    if (!hasUnsavedWork()) return;
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
    const [loadedSongs, loadedArtists, loadedSetlists] = await Promise.all([
      api.listSongs(),
      api.listArtists(),
      api.listSetlists(),
    ]);
    adoptLoadedState(loadedSongs, loadedArtists, loadedSetlists);
  } catch (error) {
    backendAvailable = false;
    current = createDraft();
    dirty = true;
    setStatus(
      `Local backend unavailable (${describeError(error)}). Run the desktop app with \`npm run tauri dev\`.`,
      "error",
    );
  }

  if (backendAvailable) {
    // Feature 20: startup always lands on artist selection first. The scope is
    // session-only, so a fresh launch never resumes a previous artist.
    activeArtistId = null;
    landingVisible = true;
    landingShowCreate = false;
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
    artist_id: null,
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
    artist_id: normalizeArtistId(setlist.artist_id),
  };
}

/**
 * Replaces the in-memory caches with a fresh backend snapshot and selects the
 * requested setlist when it is still in scope (otherwise the first in-scope one).
 */
function adoptLoadedState(
  loadedSongs: Song[],
  loadedArtists: Artist[],
  loadedSetlists: Setlist[],
  preferredId?: string | null,
): void {
  adoptArtists(loadedArtists);
  songs = loadedSongs.map((song) => ({
    ...song,
    artist_id: normalizeArtistId(song.artist_id),
  }));
  sortSongsByTitle();
  libraryEditor = null;
  pendingLibraryEditorFocus = null;
  setlists = loadedSetlists.map((setlist) => ({
    ...setlist,
    items: normalizeSetlistItems(setlist.items),
    sheet_options: withSheetDefaults(setlist.sheet_options),
    page_mode: withPageModeDefaults(setlist.page_mode),
    artist_id: normalizeArtistId(setlist.artist_id),
  }));
  sortSetlists();

  // A scope pointing at a deleted record cannot survive a reload: drop back to
  // the landing page instead of showing an empty artist scope.
  if (
    activeArtistId !== null &&
    activeArtistId !== UNFILED_SCOPE &&
    !artists.some((artist) => artist.id === activeArtistId)
  ) {
    activeArtistId = null;
    landingVisible = true;
  }

  const inScope = setlists.filter((setlist) => setlistInScope(setlist));
  const preferred = preferredId ? inScope.find((setlist) => setlist.id === preferredId) : undefined;
  const next = preferred ?? inScope[0];
  current = next ? cloneSetlist(next) : blankDraftForScope();
  dirty = !next;
}

/**
 * Replaces the artist cache from a backend snapshot and discards any open
 * artist-form draft, because it may point at a record that no longer exists.
 * Uncommitted logo files are cleaned up best-effort.
 */
function adoptArtists(loadedArtists: Artist[]): void {
  discardArtistDraftLogos(artistFormState);
  invalidateArtistLogoPreview();
  artistFormState = createArtistFormState();

  artists = loadedArtists
    .map((artist) => ({
      ...artist,
      name: artist.name.trim(),
      logo: { ...artist.logo },
    }))
    .sort((left, right) => left.name.localeCompare(right.name));
}

async function startNewSetlist(): Promise<void> {
  if (isUnfiledScope()) {
    setStatus(
      "New setlist is unavailable in the Unfiled scope — switch to an artist scope to create one.",
      "info",
    );
    return;
  }
  if (captureGuard()) return;
  if (!ensureBackend()) return;
  if (!activeScopeArtist()) return;
  if (!confirmDiscard()) return;

  pendingLogoRemovals.clear();
  // New setlists pre-assign the active artist; there is no other path to a
  // filed setlist. The assignment is a normal unsaved edit from here on.
  current = blankDraftForScope();
  dirty = true;
  clearLogoPreview();
  logoFileInput.value = "";
  renderAll();
  titleInput.focus();
  titleInput.select();
  // A New setlist pre-assigned from the header picker may inherit the artist's
  // logo; load it like any other setlist switch.
  if (backendAvailable) {
    void loadLogoForCurrent();
  }
}

async function handleSetlistChange(): Promise<void> {
  if (!current) return;
  if (captureGuard()) {
    setlistSelect.value = current.id;
    return;
  }

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

/** Backend/validation message from the last failed `saveCurrent`, if any. */
let lastSaveError: string | null = null;

async function saveCurrent(): Promise<boolean> {
  if (!current || captureGuard()) return false;
  lastSaveError = null;

  if (!backendAvailable) {
    lastSaveError = "Local backend unavailable — changes cannot be saved.";
    setStatus("Backend unavailable — changes cannot be saved.", "error");
    return false;
  }

  current.title = current.title.trim();
  if (!current.title) {
    lastSaveError = "Give the setlist a title before saving.";
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
      lastSaveError =
        "Could not find the break for this duration field. Reopen the setlist and try again.";
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
      lastSaveError = committed.error;
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
    lastSaveError = `Break durations must be between 0:00 and 600:00 (${MAX_BREAK_SECS} seconds). Fix the break length before saving.`;
    setStatus(
      `Break durations must be between 0:00 and 600:00 (${MAX_BREAK_SECS} seconds). Fix the break length before saving.`,
      "error",
    );
    return false;
  }

  try {
    const saved = await api.saveSetlist(current);
    current = { ...saved, artist_id: normalizeArtistId(saved.artist_id) };
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
    renderScopePicker();
    renderSetlistSelect();
    renderFileUnder();
    renderSheet();
    void refreshLogoIfChanged();

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
    lastSaveError = `Could not save: ${describeError(error)}`;
    setStatus(`Could not save: ${describeError(error)}`, "error");
    return false;
  }
}

async function deleteCurrent(): Promise<void> {
  if (!current || captureGuard()) return;

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
  // Stay inside the active scope: the next setlist is the first remaining
  // in-scope one, otherwise a blank draft for the scope.
  const next = setlists.find((setlist) => setlistInScope(setlist));
  current = next ? cloneSetlist(next) : blankDraftForScope();
  dirty = !next;
  renderAll();
  if (backendAvailable && !dirty) {
    await loadLogoForCurrent();
  }
}

let duplicating = false;

/**
 * Duplicates the current setlist as a preset base under a fresh id. A dirty
 * editor is saved first (the Print/Backup rule), so the copy is made from the
 * persisted state; the source is never mutated and a failure leaves the editor
 * and cache where they were.
 */
async function duplicateCurrent(): Promise<void> {
  if (!current || duplicating || captureGuard()) return;
  if (!ensureBackend()) return;

  duplicating = true;
  duplicateSetlistButton.disabled = true;

  try {
    if (dirty) {
      const saved = await saveCurrent();
      if (!saved) {
        const guidance = unfiledSaveGuidance("duplicating");
        if (guidance) setStatus(guidance, "error");
        return;
      }
    }
    if (!current) return;

    const sourceTitle = current.title.trim() || "Untitled setlist";
    const now = new Date().toISOString();
    // `cloneSetlist` deep-copies items, logo config, sheet options, page mode,
    // and artist id. Song snapshot ids stay as values, not references.
    const copy = cloneSetlist(current);
    copy.id = newId();
    copy.title = duplicateSetlistTitle(sourceTitle);
    copy.created_at = now;
    copy.updated_at = now;

    try {
      const saved = await api.saveSetlist(copy);
      // Keep the cache and editor copies separate, as saveCurrent does.
      const cached = cloneSetlist(saved);
      const existingIndex = setlists.findIndex((setlist) => setlist.id === saved.id);
      if (existingIndex >= 0) {
        setlists[existingIndex] = cached;
      } else {
        setlists.push(cached);
      }
      sortSetlists();
      current = cloneSetlist(cached);
      dirty = false;
      dirtyIndicator.hidden = true;

      renderAll();
      // The copy shares the logo file, so the existing preview stays valid.
      void refreshLogoIfChanged();
      fitPreview();
      setStatus(`Duplicated “${sourceTitle}” as “${saved.title}”.`, "success");
    } catch (error) {
      setStatus(`Could not duplicate setlist: ${describeError(error)}`, "error");
    }
  } finally {
    duplicating = false;
    duplicateSetlistButton.disabled = false;
  }
}

/**
 * `Setlist` → `Setlist (copy)`, incrementing the suffix instead of stacking
 * copies. The source is trimmed before the suffix is stripped, so
 * `X (copy) ` and ` X (copy)` continue the chain as `X (copy 2)`; a blank
 * title falls back to `Untitled setlist`. Mirrors `duplicateSongTitle`'s suffix
 * stripping, but setlist titles compare trimmed and case-insensitively.
 */
function duplicateSetlistTitle(title: string): string {
  const trimmed = title.trim() || "Untitled setlist";
  const base =
    trimmed.replace(/\s+\(copy(?: \d+)?\)$/i, "").trim() || "Untitled setlist";
  const used = new Set(setlists.map((setlist) => setlist.title.trim().toLocaleLowerCase()));

  let candidate = `${base} (copy)`;
  let index = 2;
  while (used.has(candidate.trim().toLocaleLowerCase())) {
    candidate = `${base} (copy ${index})`;
    index += 1;
  }
  return candidate;
}

function isExportMenuOpen(): boolean {
  return !exportMenu.hidden;
}

function openExportMenu(focus: "first" | "last" = "first"): void {
  if (exporting) return;
  exportMenu.hidden = false;
  exportButton.setAttribute("aria-expanded", "true");
  focusExportMenuItem(focus);
}

function closeExportMenu(returnFocus = false): void {
  if (exportMenu.hidden) {
    exportButton.setAttribute("aria-expanded", "false");
    if (returnFocus) exportButton.focus();
    return;
  }
  exportMenu.hidden = true;
  exportButton.setAttribute("aria-expanded", "false");
  if (returnFocus) exportButton.focus();
}

function focusExportMenuItem(target: "first" | "last" | number): void {
  const enabled = exportMenuItems.filter((item) => !item.disabled);
  if (enabled.length === 0) return;
  if (target === "first") {
    enabled[0].focus();
    return;
  }
  if (target === "last") {
    enabled[enabled.length - 1].focus();
    return;
  }
  const active = document.activeElement;
  const index = enabled.indexOf(active as HTMLButtonElement);
  const next = enabled[(index + target + enabled.length) % enabled.length];
  (next ?? enabled[0]).focus();
}

function syncExportControls(disabled: boolean): void {
  printButton.disabled = disabled;
  exportButton.disabled = disabled;
  for (const item of exportMenuItems) {
    item.disabled = disabled;
  }
}

/**
 * Refuses editor mutations while an export capture owns the sheet DOM.
 * `renderSheet` already ignores edits mid-capture; this keeps the model from
 * changing underneath it so captures never tear.
 */
function captureGuard(): boolean {
  if (!exporting) return false;
  setStatus("Export in progress — wait for it to finish.", "info");
  return true;
}

/**
 * Locks item editing, meta inputs, and scope switching for the capture.
 * The exporter works from a snapshot taken before the lock, so edits made
 * after the capture restores and re-renders cannot tear it.
 */
function syncCaptureLock(locked: boolean): void {
  setlistArtistFilterSelect.disabled = locked;
  setlistSelect.disabled = locked;
  newSetlistButton.disabled = locked;
  saveSetlistButton.disabled = locked;
  deleteSetlistButton.disabled = locked;
  duplicateSetlistButton.disabled = locked;
  titleInput.disabled = locked;
  venueInput.disabled = locked;
  dateInput.disabled = locked;
  setlistFileUnderSelect.disabled = locked;
  addBreakButton.disabled = locked;
  logoFileInput.disabled = locked;
  logoRemoveButton.disabled = locked;
  logoWidthInput.disabled = locked;
  for (const radio of alignmentRadios) radio.disabled = locked;
  for (const [, input] of sheetOptionInputs) input.disabled = locked;
  for (const radio of pageModeRadios) radio.disabled = locked;
}

async function printCurrent(): Promise<void> {
  if (!current || exporting) return;

  if (dirty && backendAvailable) {
    const saved = await saveCurrent();
    if (!saved) {
      const guidance = unfiledSaveGuidance("printing");
      if (guidance) setStatus(guidance, "error");
      return;
    }
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
  if (isExportMenuOpen()) closeExportMenu();
  // The exporter captures the tall sheet, which multiple mode normally hides
  // behind the frame stack. Reveal the source and hide the frames for the
  // capture; `renderSheet()` restores the framed preview in the finally block.
  sheetFrame.classList.remove("is-framed");
  syncExportControls(true);
  syncCaptureLock(true);
  setStatus(`Preparing ${format.toUpperCase()} export…`);

  // Snapshot the editor state up front so the capture cannot tear if a guarded
  // path is reached programmatically mid-raster.
  const snapshot = cloneSetlist(current);

  try {
    const outcome = await exportSetlist({
      sheet,
      setlist: snapshot,
      // Same resolution chain as the preview; the exporter only needs the
      // stored file name and printed width.
      logo: resolveSetlistLogo(snapshot, artists),
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
    syncExportControls(false);
    syncCaptureLock(false);
    renderScopePicker();
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
function libraryWriteGuard(action: string): string | null {
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

/** True while the landing artist-edit form holds anything worth saving. */
function artistFormHasDraft(): boolean {
  const state = artistFormState;
  if (state.mode === "edit") return true;
  if (state.name.trim()) return true;
  if (state.logo.file_name) return true;
  if (state.logo.width_mm !== DEFAULT_LOGO_WIDTH_MM) return true;
  if (state.logo.alignment !== "Center") return true;
  if (state.transientLogos.size > 0) return true;
  return false;
}

/**
 * Backup/restore refuse the landing artist-edit draft too: the form is not
 * persisted until Save, so a snapshot must not silently omit a typed name or
 * changed logo. Reopening the landing screen (Choose artist…) shows the draft
 * again. The landing create form gets the same treatment: a typed name or
 * staged logo blocks the snapshot while its request or logo import is in
 * flight.
 */
function libraryDraftGuard(action: "backing up" | "restoring"): string | null {
  if (artistBusy || landingBusy) {
    return `Wait for the current artist request to finish before ${action}.`;
  }
  if (artistLogoBusy || landingLogoBusy) {
    return `Artist logo import in progress — wait for it to finish before ${action}.`;
  }

  const libraryBlock = libraryWriteGuard(action);
  if (libraryBlock) return libraryBlock;

  if (artistFormHasDraft()) {
    const label = artistFormState.name.trim();
    if (artistFormState.mode === "edit") {
      return `Landing artist draft open — save or cancel the edit for “${label || "this artist"}” before ${action}.`;
    }
    if (label) {
      return `Landing artist draft open — save or cancel “${label}” before ${action}.`;
    }
    return `Landing artist draft open — save or cancel the new artist before ${action}.`;
  }

  const landingBlock = landingDraftGuard(action);
  if (landingBlock) return landingBlock;

  return null;
}

/** Typed name in the landing create form, if it is currently rendered. */
function landingTypedName(): string {
  const input = document.getElementById("landing-name");
  return input instanceof HTMLInputElement ? input.value.trim() : "";
}

/**
 * True while the landing create form holds anything worth saving: a typed
 * name or a staged logo. Runs only while the landing page is visible; leaving
 * it (by entering a scope or closing it) discards the staged files.
 */
function landingDraftGuard(action: "backing up" | "restoring"): string | null {
  if (!landingVisible) return null;

  const name = landingTypedName();
  if (name) {
    return `Landing artist draft open — create “${name}” before ${action}.`;
  }
  if (landingLogoFile || landingTransientLogos.size > 0) {
    return `Landing artist draft open — create the artist before ${action}.`;
  }
  return null;
}

/** Blocks row/Add actions while a backup, restore, or artist cleanup owns the library. */
function blockLibraryActionWhileBusy(): boolean {
  if (artistDeleting) {
    setStatus("Artist delete in progress — wait for it to finish.", "info");
    return true;
  }
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
  if (exporting) {
    setStatus("Export in progress — wait for it to finish before backing up.", "info");
    return;
  }
  if (!ensureBackend() || restoring || backingUp) return;

  const libraryBlock = libraryDraftGuard("backing up");
  if (libraryBlock) {
    setStatus(libraryBlock, "error");
    return;
  }

  try {
    backingUp = true;
    syncAddSongControls();
    renderLanding();
    // Disable row actions for the whole snapshot read/write; handlers also
    // guard so keyboard/programmatic paths cannot mutate the library.
    renderLibrary();

    if (dirty) {
      const saved = await saveCurrent();
      if (!saved) {
        const guidance = unfiledSaveGuidance("backing up");
        if (guidance) setStatus(guidance, "error");
        return;
      }
    }

    const [backupArtists, backupSongs, backupSetlists] = await Promise.all([
      api.listArtists(),
      api.listSongs(),
      api.listSetlists(),
    ]);
    const outcome = await exportBackup({
      artists: backupArtists,
      songs: backupSongs,
      setlists: backupSetlists,
    });

    if (outcome.status === "canceled") {
      setStatus("Backup canceled.");
      return;
    }

    setStatus(
      `Backed up ${countLabel(outcome.artists, "artist")}, ${countLabel(outcome.songs, "song")} and ${countLabel(outcome.setlists, "setlist")} to ${baseName(outcome.path)}.`,
      "success",
      10000,
    );
  } catch (error) {
    setStatus(`Backup failed: ${describeError(error)}`, "error");
  } finally {
    backingUp = false;
    syncAddSongControls();
    renderLanding();
    renderLibrary();
  }
}

/**
 * Restores a backup by re-saving each record through the normal commands, so
 * Rust validation stays authoritative. Records with the same IDs are
 * overwritten; nothing is deleted. Malformed records are skipped and reported.
 */
async function restoreLibrary(): Promise<void> {
  if (exporting) {
    setStatus("Export in progress — wait for it to finish before restoring.", "info");
    return;
  }
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
  if (envelope.songs.length + envelope.artists.length + envelope.setlists.length === 0) {
    const reason = skipped.length > 0 ? ` All records were malformed: ${summarizeRecords(skipped)}.` : "";
    setStatus(`No restorable records in ${baseName(picked.path)}.${reason}`, "error");
    return;
  }

  const skippedNote =
    skipped.length > 0
      ? `\n\n${countLabel(skipped.length, "malformed record")} will be skipped: ${summarizeRecords(skipped)}.`
      : "";
  const confirmed = window.confirm(
    `Restore ${countLabel(envelope.artists.length, "artist")}, ${countLabel(envelope.songs.length, "song")} and ${countLabel(envelope.setlists.length, "setlist")} from ${baseName(picked.path)}?\n\n` +
      "Existing records with the same IDs are overwritten; nothing else is deleted. " +
      "Artists are restored first so song and setlist assignments resolve immediately. " +
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

  let importedArtists = 0;
  let importedSongs = 0;
  let importedSetlists = 0;
  const failures: string[] = [];

  try {
    restoring = true;
    syncAddSongControls();
    renderLanding();
    // Row controls are guarded in their handlers; this render applies the visual
    // disabled state without touching any draft (none can be open here).
    renderLibrary();

    for (const [index, artist] of envelope.artists.entries()) {
      try {
        await api.saveArtist(artist);
        importedArtists += 1;
      } catch (error) {
        failures.push(`artist ${index + 1} “${artist.name}” (${describeError(error)})`);
      }
    }

    for (const [index, song] of envelope.songs.entries()) {
      try {
        // Restore re-saves stored records as-is; unfiled ones pass through the
        // allowance so the envelope round-trips without a bulk import command.
        await api.saveSong(song, true);
        importedSongs += 1;
      } catch (error) {
        failures.push(`song ${index + 1} “${song.title}” (${describeError(error)})`);
      }
    }

    for (const [index, setlist] of envelope.setlists.entries()) {
      try {
        await api.saveSetlist(setlist, true);
        importedSetlists += 1;
      } catch (error) {
        failures.push(`setlist ${index + 1} “${setlist.title}” (${describeError(error)})`);
      }
    }

    const currentId = current?.id ?? null;
    const [loadedSongs, loadedArtists, loadedSetlists] = await Promise.all([
      api.listSongs(),
      api.listArtists(),
      api.listSetlists(),
    ]);
    pendingLogoRemovals.clear();
    clearLogoPreview();
    adoptLoadedState(loadedSongs, loadedArtists, loadedSetlists, currentId);
    renderAll();
    if (backendAvailable && !dirty) {
      await loadLogoForCurrent();
    }
    fitPreview();

    const summary = `Restored ${countLabel(importedArtists, "artist")}, ${countLabel(importedSongs, "song")} and ${countLabel(importedSetlists, "setlist")} from ${baseName(picked.path)}.`;
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
      `Restore failed after ${countLabel(importedArtists + importedSongs + importedSetlists, "record")}: ${describeError(error)}`,
      "error",
    );
  } finally {
    restoring = false;
    syncAddSongControls();
    renderLanding();
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

/**
 * Names the filing next step when a dirty auto-save fails on the artist
 * check (backup, print, duplicate). Only substitutes when the save error is
 * the artist check — every other failure keeps `saveCurrent`'s own accurate
 * message.
 */
function unfiledSaveGuidance(action: "backing up" | "printing" | "duplicating"): string | null {
  if (!current) return null;
  if (!lastSaveError || !/has no artist/.test(lastSaveError)) return null;
  if (findArtistById(artists, normalizeArtistId(current.artist_id))) return null;
  const title = current.title.trim() || "Untitled setlist";
  return `“${title}” has no artist — open the Unfiled scope or use File under… to file it, or discard the draft, then ${action} again.`;
}

/**
 * True while leaving the page could lose work: a dirty setlist, an open
 * library song draft, an open landing artist draft, or a typed-but-uncreated
 * landing artist. `beforeunload` covers all of them, not just the setlist.
 */
function hasUnsavedWork(): boolean {
  if (dirty) return true;
  if (libraryEditor) return true;
  if (artistFormHasDraft()) return true;
  if (landingVisible && (landingTypedName() || landingLogoFile || landingTransientLogos.size > 0)) {
    return true;
  }
  return false;
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
  ensureValidScope();
  renderScopePicker();
  renderSetlistSelect();
  renderMeta();
  renderFileUnder();
  renderLogoControls();
  renderSheetOptions();
  renderPageModeControls();
  renderItems();
  renderNewSongArtistOptions();
  renderLibrary();
  renderLanding();
  renderSheet();
}

/**
 * Drops a scope that no longer resolves (artist deleted on another device or
 * by restore) back to the landing page. Runs at the top of every `renderAll`
 * so no render ever targets a stale artist.
 */
function ensureValidScope(): void {
  if (
    activeArtistId !== null &&
    activeArtistId !== UNFILED_SCOPE &&
    !artists.some((artist) => artist.id === activeArtistId)
  ) {
    activeArtistId = null;
    landingVisible = true;
  }
}

/**
 * The live artist record behind an artist scope, or null for the Unfiled
 * scope and the landing page.
 */
function activeScopeArtist(): Artist | null {
  if (!activeArtistId || activeArtistId === UNFILED_SCOPE) return null;
  return findArtistById(artists, activeArtistId);
}

/** True while the workspace shows the Unfiled bucket. */
function isUnfiledScope(): boolean {
  return activeArtistId === UNFILED_SCOPE;
}

/**
 * Songs in the Unfiled bucket: no record by id and no legacy-text match
 * against a live record. Everything else belongs to its resolved artist.
 */
function unfiledSongs(): Song[] {
  return songs.filter((song) => resolveArtistForSong(song, artists) === null);
}

/**
 * Setlists in the Unfiled bucket: no artist id, or an id with no live
 * record. Setlists have no legacy text, so only the id decides.
 */
function unfiledSetlists(): Setlist[] {
  return setlists.filter(
    (setlist) => !findArtistById(artists, normalizeArtistId(setlist.artist_id)),
  );
}

/** Total Unfiled records, for the picker label and the landing entry. */
function unfiledCount(): number {
  return unfiledSongs().length + unfiledSetlists().length;
}

/** True when a song belongs in the active scope. */
function songInScope(song: Song): boolean {
  if (isUnfiledScope()) return resolveArtistForSong(song, artists) === null;
  const scope = activeScopeArtist();
  if (!scope) return true;
  return resolveArtistForSong(song, artists)?.id === scope.id;
}

/** True when a setlist belongs in the active scope. */
function setlistInScope(setlist: Pick<Setlist, "artist_id">): boolean {
  if (isUnfiledScope()) {
    return !findArtistById(artists, normalizeArtistId(setlist.artist_id));
  }
  const scope = activeScopeArtist();
  if (!scope) return true;
  return normalizeArtistId(setlist.artist_id) === scope.id;
}

/** Blank draft pre-assigned to the active scope (unfiled in Unfiled scope). */
function blankDraftForScope(): Setlist {
  const draft = createDraft();
  draft.artist_id = activeScopeArtist()?.id ?? null;
  return draft;
}

/**
 * Keeps `current` inside the active scope after the cache changed underneath
 * it (filing, deletion, restore). A setlist that left the scope is replaced
 * by the first remaining in-scope one, otherwise a blank scope draft.
 */
function reselectCurrentInScope(): void {
  if (current && setlistInScope(current)) return;
  pendingLogoRemovals.clear();
  clearLogoPreview();
  const next = setlists.find((setlist) => setlistInScope(setlist));
  current = next ? cloneSetlist(next) : blankDraftForScope();
  dirty = !next;
}

/**
 * Header scope switcher: artist entries plus `Unfiled (N)` plus a landing
 * shortcut. Switching follows the existing setlist-switch guard (confirm
 * discard of a dirty editor) before the scope changes.
 */
async function switchScope(next: string): Promise<void> {
  if (next !== UNFILED_SCOPE && !artists.some((artist) => artist.id === next)) {
    renderScopePicker();
    return;
  }
  // A scope switch mid-snapshot/write could reselect the workspace out from
  // under a restore; refuse with a titled status instead.
  if (backingUp || restoring) {
    setStatus(
      `Scope switch blocked — ${backingUp ? "backup" : "restore"} in progress. Wait for it to finish.`,
      "error",
    );
    renderScopePicker();
    return;
  }
  if (captureGuard()) {
    renderScopePicker();
    return;
  }
  if (next === activeArtistId) {
    renderScopePicker();
    return;
  }
  if (dirty && !confirmDiscard()) {
    renderScopePicker();
    return;
  }

  pendingLogoRemovals.clear();
  clearLogoPreview();
  activeArtistId = next;
  landingVisible = false;
  const inScope = setlists.filter((setlist) => setlistInScope(setlist));
  current = inScope[0] ? cloneSetlist(inScope[0]) : blankDraftForScope();
  dirty = inScope.length === 0;
  renderAll();
  if (backendAvailable && !dirty) {
    await loadLogoForCurrent();
  }
  fitPreview();

  const scope = activeScopeArtist();
  if (scope) void maybeOfferUnfiledAssignment(scope);
}

/**
 * Header scope picker. The value always mirrors `activeArtistId` (or the
 * landing shortcut); stale artist ids fall back to the landing instead of a
 * dead selection.
 */
function renderScopePicker(): void {
  const fragment = document.createDocumentFragment();
  for (const artist of artists) {
    fragment.append(artistOption(artist.id, artistLabel(artist)));
  }
  const unfiled = unfiledCount();
  fragment.append(artistOption(UNFILED_SCOPE, `Unfiled (${unfiled})`));
  fragment.append(artistOption(LANDING_PICKER_VALUE, "Choose artist…"));

  setlistArtistFilterSelect.replaceChildren(fragment);
  if (activeArtistId === null) {
    setlistArtistFilterSelect.value = LANDING_PICKER_VALUE;
  } else {
    setlistArtistFilterSelect.value = activeArtistId;
  }

  // New setlists belong to an artist; the Unfiled scope cannot create one.
  // The button stays activatable (`aria-disabled`, not `disabled`) so the
  // reason is announced on attempted activation, with an adjacent hint.
  const newUnavailable = isUnfiledScope();
  if (newUnavailable) {
    newSetlistButton.setAttribute("aria-disabled", "true");
  } else {
    newSetlistButton.removeAttribute("aria-disabled");
  }
  newSetlistHint.hidden = !newUnavailable;
}

function renderSetlistSelect(): void {
  const fragment = document.createDocumentFragment();
  const options = setlists.filter((setlist) => setlistInScope(setlist));

  const scope = activeScopeArtist();
  if (options.length === 0 && scope) {
    // The scope is real but empty: New assigns this artist, so say so.
    const empty = artistOption("", `No setlists by “${artistLabel(scope)}” yet — New uses this artist`);
    empty.disabled = true;
    fragment.append(empty);
  } else if (options.length === 0 && isUnfiledScope()) {
    const empty = artistOption("", "No unfiled setlists — switch to an artist scope to create");
    empty.disabled = true;
    fragment.append(empty);
  }

  // Never yank the open setlist out of the editor when it falls outside the
  // scope (a filed record after an artist delete); it stays selectable.
  if (current && !options.some((setlist) => setlist.id === current?.id)) {
    options.push(current);
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

/**
 * Filing row for the current setlist. Visible only while the setlist has no
 * live artist: the retired per-setlist Artist select is gone, and an unfiled
 * editor save fails with the backend message until the record is filed here.
 */
function renderFileUnder(): void {
  if (!current) {
    setlistFileUnderRow.hidden = true;
    return;
  }

  const live = findArtistById(artists, normalizeArtistId(current.artist_id));
  setlistFileUnderRow.hidden = live !== null;
  if (live) return;

  const fragment = document.createDocumentFragment();
  const placeholder = artistOption("", "File under…");
  placeholder.disabled = true;
  fragment.append(placeholder);
  for (const artist of artists) {
    fragment.append(artistOption(artist.id, artistLabel(artist)));
  }
  setlistFileUnderSelect.replaceChildren(fragment);
  setlistFileUnderSelect.value = "";
  const title = current.title.trim() || "Untitled setlist";
  setlistFileUnderNote.textContent =
    `“${title}” has no artist — saving is blocked until it is filed. Choose an artist above.`;
}

/**
 * Files the current setlist under an artist through the normal save path and
 * moves on inside the active scope: a record filed away from the Unfiled
 * scope is replaced by the next unfiled setlist (or a blank draft).
 */
async function fileCurrentSetlist(artistId: string): Promise<void> {
  if (!current) return;
  if (captureGuard()) {
    renderFileUnder();
    return;
  }
  const target = artists.find((artist) => artist.id === artistId);
  if (!target) {
    setStatus("That artist is no longer available. Pick another artist.", "error");
    renderFileUnder();
    return;
  }
  if (!ensureBackend()) {
    renderFileUnder();
    return;
  }

  current.artist_id = artistId;
  markDirty();
  const saved = await saveCurrent();
  if (!saved || !current) {
    renderFileUnder();
    return;
  }

  const filedName = artistLabel(target);
  if (!setlistInScope(current)) {
    const filedTitle = current.title;
    reselectCurrentInScope();
    renderAll();
    if (backendAvailable && !dirty) {
      await loadLogoForCurrent();
    }
    fitPreview();
    setStatus(`Filed “${filedTitle}” under ${filedName}.`, "success");
    return;
  }

  renderAll();
  setStatus(`Filed under ${filedName}.`, "success");
}

function artistLabel(artist: Artist): string {
  return artist.name.trim() || "Untitled artist";
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

  // Feature 19 + 25: the width slider and the alignment radios follow the
  // displayed logo (own → artist → placeholder). The artist path shows the
  // artist's width/alignment; own and placeholder paths show the setlist's
  // own config (pre-sizing the next own logo when nothing is displayed yet).
  const logoCase = effectiveLogoCase();
  const effective = resolveSetlistLogo(current, artists);
  const sliderWidth =
    logoCase === "artist" ? effective.width_mm : current.logo.width_mm;
  logoWidthInput.value = String(sliderWidth);
  logoWidthOutput.textContent = `${Math.round(sliderWidth)} mm`;
  // Only the setlist's own logo can be removed here; an artist logo shown via
  // the resolution chain is not a setlist logo.
  logoRemoveButton.disabled = !current.logo.file_name && !logoPreviewIsLocal;

  for (const radio of alignmentRadios) {
    radio.checked = radio.value === effective.alignment;
  }

  renderLogoShowing();
}

/** Which logo the sheet currently displays (Feature 16 resolution). */
function effectiveLogoCase(): "own" | "artist" | "none" {
  if (!current) return "none";
  if (current.logo.file_name) return "own";
  const artist = findArtistById(artists, normalizeArtistId(current.artist_id));
  if (artist?.logo.file_name) return "artist";
  return "none";
}

/** The live artist record behind the artist-logo path, if any. */
function effectiveLogoArtist(): Artist | null {
  if (!current || current.logo.file_name) return null;
  return findArtistById(artists, normalizeArtistId(current.artist_id));
}

/**
 * Visible showing line so the width/alignment target is unambiguous. Names
 * both controls' target in every resolution case.
 */
function renderLogoShowing(): void {
  if (!current) {
    logoShowingEl.textContent = "No logo yet";
    return;
  }
  const logoCase = effectiveLogoCase();
  if (logoCase === "own") {
    logoShowingEl.textContent = "Setlist logo — width and alignment apply here";
    return;
  }
  const artist = effectiveLogoArtist();
  if (logoCase === "artist" && artist) {
    logoShowingEl.textContent = `${artistLabel(artist)} logo (artist) — width and alignment update every setlist using it`;
    return;
  }
  logoShowingEl.textContent = "No logo yet — width and alignment will apply to the next own logo";
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
  const scoped = songs.filter((song) => songInScope(song));
  const matching = scoped
    .filter((song) => {
      if (!query) return true;
      return [song.title, resolveArtistName(song, artists), song.key, song.tuning]
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

  // The badge counts the active scope, not the whole library: totals live on
  // the landing page.
  songCountEl.textContent = String(scoped.length);
  songCountEl.setAttribute(
    "aria-label",
    `${scoped.length} ${scoped.length === 1 ? "song" : "songs"} in this scope`,
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
  const scope = activeScopeArtist();
  if (isUnfiledScope()) {
    if (unfiledSongs().length === 0) return "No unfiled songs yet.";
    if (query) {
      return tuningOnly
        ? "No unfiled songs with tuning match that search."
        : "No unfiled songs match that search.";
    }
    if (tuningOnly) return "No unfiled songs have a tuning set.";
    return "No unfiled songs match that search.";
  }

  const scopedCount = songs.filter((song) => songInScope(song)).length;
  if (scope) {
    const name = artistLabel(scope);
    if (scopedCount === 0) return `No songs by “${name}” yet.`;
    if (query) {
      return tuningOnly
        ? `No songs by “${name}” with tuning match that search.`
        : `No songs by “${name}” match that search.`;
    }
    if (tuningOnly) return `No songs by “${name}” have a tuning set.`;
    return `No songs by “${name}” match that search.`;
  }

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
  const valueFor = (song: Song): string => {
    if (sort === "artist") return resolveArtistName(song, artists);
    return (song[sort] ?? "").trim();
  };
  const leftValue = valueFor(left);
  const rightValue = valueFor(right);

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
    resolveArtistName(song, artists),
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

  if (restoring || backingUp || artistDeleting) {
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
  if (current.items.length === 0 && isUnfiledScope()) {
    emptyItems.textContent =
      "Add songs from the library or insert a break to start the running order. New setlists are created from an artist scope.";
  } else {
    emptyItems.textContent =
      "Add songs from the library or insert a break to start the running order.";
  }
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
    if (captureGuard()) return;
    song.title = titleField.input.value;
    titleNode.textContent = song.title.trim() || "Untitled song";
    markDirty();
    renderSheet();
  });

  const artistField = textField("Artist", song.artist ?? "", "Artist");
  artistField.input.addEventListener("input", () => {
    if (captureGuard()) return;
    song.artist = trimmedOrNull(artistField.input.value);
    refreshMeta();
    markDirty();
    renderSheet();
  });

  const keyField = textField("Key", song.key ?? "", "Em");
  keyField.input.addEventListener("input", () => {
    if (captureGuard()) return;
    song.key = trimmedOrNull(keyField.input.value);
    refreshMeta();
    markDirty();
    renderSheet();
  });

  const tuningField = textField("Tuning", song.tuning ?? "", "E Std");
  tuningField.input.maxLength = 24;
  tuningField.input.addEventListener("input", () => {
    if (captureGuard()) return;
    song.tuning = trimmedOrNull(tuningField.input.value);
    refreshMeta();
    markDirty();
    renderSheet();
  });

  const bpmField = numberField("BPM", song.bpm, 1, 400);
  bpmField.input.addEventListener("change", () => {
    if (captureGuard()) return;
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
    if (captureGuard()) return;
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
    if (captureGuard()) return;
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
    if (captureGuard()) return;
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
    if (captureGuard()) return;
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
    if (captureGuard()) return;
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
  // The `· artist` suffix is gone (redundant inside a scope); the non-matching
  // count stays for legacy leftovers, resolved against the active scope.
  const scope = activeScopeArtist();
  const mismatches = scope
    ? current.items.filter(
        (item) =>
          "Song" in item &&
          resolveArtistForSong(item.Song, artists)?.id !== scope.id,
      ).length
    : 0;

  if (current.items.length === 0) {
    setlistSummary.textContent = "Empty running order";
    return;
  }

  const parts = [
    `${songCount} ${songCount === 1 ? "song" : "songs"}`,
    breakCount > 0 ? `${breakCount} ${breakCount === 1 ? "break" : "breaks"}` : null,
    `${formatRuntime(totalSecs)} total`,
    mismatches > 0 && scope
      ? `${mismatches} ${mismatches === 1 ? "song" : "songs"} not by ${artistLabel(scope)}`
      : null,
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

  // Resolve the same logo chain everywhere: own logo → artist logo →
  // placeholder. The sheet only reads `logo` for the header; no print markup
  // or layout changes.
  renderSetlistSheet(
    sheet,
    { ...current, logo: resolveSetlistLogo(current, artists) },
    {
      logoUrl: logoSrc,
      grayscaleLogo: grayscaleLogoInput.checked,
      onLogoLayout: handleSheetLayout,
    },
  );
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
  if (captureGuard()) return;

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
  if (captureGuard()) return;
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
  if (captureGuard()) return;
  if (!current || index < 0 || index >= current.items.length) return;

  current.items.splice(index, 1);
  markDirty();
  renderItems();
  renderSheet();
}

function addBreak(): void {
  if (!current || captureGuard()) return;

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

    if (captureGuard()) return;
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

  const scope = activeScopeArtist();
  const selectedArtist = scope ??
    (newSongArtist.value
      ? (artists.find((artist) => artist.id === newSongArtist.value) ?? null)
      : null);
  if (!scope && newSongArtist.value && !selectedArtist) {
    setStatus(
      "That artist is no longer available. Pick another artist and add the song again.",
      "error",
    );
    renderNewSongArtistOptions();
    return;
  }

  const song: Song = {
    id: newId(),
    title,
    artist: selectedArtist?.name.trim() || null,
    artist_id: selectedArtist?.id ?? null,
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
    renderNewSongArtistOptions();
    renderLanding();
    renderLibrary();
    // A song filed to an artist from the Unfiled scope leaves this scope on
    // save; name the destination so the row's disappearance is expected.
    const filedAway = !scope && selectedArtist;
    setStatus(
      filedAway
        ? `Added “${song.title}” to the library, filed under ${artistLabel(selectedArtist)}.`
        : `Added “${song.title}” to the library.`,
      "success",
    );
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
  const record = song.artist_id
    ? artists.find((artist) => artist.id === song.artist_id)
    : undefined;
  const legacyArtist = record ? "" : (song.artist?.trim() ?? "");

  return {
    title: song.title,
    artistId: record?.id ?? "",
    legacyArtist,
    keepLegacyArtist: !record && Boolean(legacyArtist),
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

  if (element instanceof HTMLSelectElement) {
    const selects = [...form.querySelectorAll<HTMLSelectElement>("select")];
    const selectIndex = selects.indexOf(element);
    if (selectIndex < 0) return null;
    return { kind: "select", songId, selectIndex };
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
      : target.kind === "select"
        ? [...form.querySelectorAll<HTMLSelectElement>("select")][target.selectIndex]
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
  for (const select of form.querySelectorAll<HTMLSelectElement>("select")) {
    select.disabled = busy;
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

  // An artist scope shows the owning artist read-only (moving a song between
  // artists is out of scope); the Unfiled scope restores the dropdown so the
  // song can be filed under any artist on save.
  const editorScope = activeScopeArtist();
  const artistElement = el("div", "item-field song-editor-wide");
  artistElement.append(el("span", "item-field-label", "Artist"));
  let artistSelect: HTMLSelectElement | null = null;
  if (editorScope) {
    artistElement.append(el("span", "item-readonly", artistLabel(editorScope)));
  } else {
    const select = document.createElement("select");
    select.autocomplete = "off";
    renderArtistSelectOptions(select, draft);
    artistElement.append(select);
    artistSelect = select;
  }

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
    artistElement,
    keyField.element,
    tuningField.element,
    bpmField.element,
    durationField.element,
    notesField.element,
  );

  const fieldInputs: Record<LibrarySongDraftField, HTMLInputElement> = {
    title: titleField.input,
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
  if (artistSelect) {
    const select = artistSelect;
    select.addEventListener("change", rememberFocus);
    select.addEventListener("change", () => {
      const editor = libraryEditor;
      if (!editor || editor.songId !== song.id || editor.saving) return;

      if (select.value === LEGACY_ARTIST_VALUE) {
        editor.draft.artistId = "";
        editor.draft.keepLegacyArtist = true;
      } else if (select.value === "") {
        editor.draft.artistId = "";
        editor.draft.keepLegacyArtist = false;
      } else {
        editor.draft.artistId = select.value;
        editor.draft.keepLegacyArtist = false;
      }
    });
  }

  const updateDraft = (key: LibrarySongDraftField, input: HTMLInputElement): void => {
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

    // An artist scope adopts the active artist on save (the song is already in
    // this library); the Unfiled scope files through the dropdown instead.
    const saveScope = activeScopeArtist();
    const selectedArtist = saveScope ??
      (state.draft.artistId
        ? (artists.find((artist) => artist.id === state.draft.artistId) ?? null)
        : null);
    if (!saveScope && state.draft.artistId && !selectedArtist) {
      // The record disappeared while this draft was open. Fall back to the
      // legacy text (if any) so the next Save can still succeed.
      state.draft.artistId = "";
      state.draft.keepLegacyArtist = Boolean(state.draft.legacyArtist.trim());
      setStatus(
        "That artist is no longer available. Pick another artist and save again.",
        "error",
      );
      renderLibrary();
      return;
    }
    const artistSnapshot = saveScope
      ? saveScope.name.trim()
      : (selectedArtist?.name.trim() ||
        (state.draft.keepLegacyArtist ? trimmedOrNull(state.draft.legacyArtist) : null));

    const edited: Song = {
      id: song.id,
      title,
      artist: artistSnapshot,
      artist_id: (saveScope ?? selectedArtist)?.id ?? null,
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
    renderLanding();
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
    renderLanding();
    renderLibrary();
    const sourceTitle = song.title.trim() || "Untitled song";
    setStatus(`Duplicated “${sourceTitle}” as “${saved.title}”.`, "success");
  } catch (error) {
    setStatus(`Could not duplicate song: ${describeError(error)}`, "error");
  } finally {
    libraryWritesInFlight -= 1;
  }
}

/** `Song` → `Song (copy)`, incrementing the suffix instead of stacking copies. */
function duplicateSongTitle(title: string): string {
  const trimmed = title.trim() || "Untitled song";
  const base = trimmed.replace(/\s+\(copy(?: \d+)?\)$/i, "").trim() || "Untitled song";
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
  if (captureGuard()) return;
  if (!current) return;

  // The add gate is inherent now (the scoped library only offers the scope's
  // songs); the refusal stays as a defensive guard for stale-cache edges.
  const scope = activeScopeArtist();
  if (scope && resolveArtistForSong(song, artists)?.id !== scope.id) {
    setStatus(
      `“${song.title}” is not by ${artistLabel(scope)} — switch artist scope to add it.`,
      "error",
    );
    return;
  }

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
    renderLanding();
    renderLibrary();
    setStatus(`Removed “${song.title}” from the library.`);
  } catch (error) {
    setStatus(`Could not remove song: ${describeError(error)}`, "error");
  } finally {
    libraryWritesInFlight -= 1;
  }
}

// ---------------------------------------------------------------------------
// Artists
// ---------------------------------------------------------------------------

/** Rebuilds the Add-to-library artist picker, keeping a still-valid selection. */
function renderNewSongArtistOptions(): void {
  // An artist scope auto-assigns the active artist: no dropdown. The Unfiled
  // scope restores it so new songs can be filed on save.
  newSongArtistField.hidden = activeScopeArtist() !== null;
  if (activeScopeArtist() !== null) return;
  const selected = newSongArtist.value;
  renderArtistSelectOptions(newSongArtist, {
    artistId: artists.some((artist) => artist.id === selected) ? selected : "",
    legacyArtist: "",
    keepLegacyArtist: false,
  });
}

/**
 * Fills an artist `<select>` with **No artist**, every record, and (when the
 * song still has legacy text) an option that keeps that text unchanged.
 */
function renderArtistSelectOptions(
  select: HTMLSelectElement,
  selection: { artistId: string; legacyArtist: string; keepLegacyArtist: boolean },
): void {
  const fragment = document.createDocumentFragment();
  fragment.append(artistOption("", "No artist"));

  for (const artist of artists) {
    fragment.append(artistOption(artist.id, artistLabel(artist)));
  }

  const legacy = selection.legacyArtist.trim();
  if (legacy) {
    fragment.append(artistOption(LEGACY_ARTIST_VALUE, `Keep text: “${legacy}”`));
  }

  select.replaceChildren(fragment);

  if (selection.artistId && artists.some((artist) => artist.id === selection.artistId)) {
    select.value = selection.artistId;
  } else if (legacy && selection.keepLegacyArtist) {
    select.value = LEGACY_ARTIST_VALUE;
  } else {
    select.value = "";
  }
}

function artistOption(value: string, label: string): HTMLOptionElement {
  const option = document.createElement("option");
  option.value = value;
  option.textContent = label;
  return option;
}

/**
 * Drops a cached artist thumbnail blob URL so a deleted or replaced logo
 * file cannot linger in memory. The cache reloads lazily from storage on
 * the next render, so pruning is always safe.
 */
function pruneArtistThumbUrl(fileName: string | null | undefined): void {
  if (!fileName) return;
  const url = artistThumbUrls.get(fileName);
  if (url) {
    URL.revokeObjectURL(url);
    artistThumbUrls.delete(fileName);
  }
}

/** Logo thumbnail. Rendered only through `<img src>` (never inline SVG). */
function buildArtistThumb(artist: Artist): HTMLSpanElement {  const thumb = el("span", "artist-thumb");
  const fileName = artist.logo.file_name;
  if (!fileName) {
    thumb.classList.add("is-empty");
    thumb.setAttribute("aria-hidden", "true");
    thumb.textContent = "—";
    return thumb;
  }

  const image = el("img", "artist-thumb-img");
  image.alt = "";
  thumb.append(image);

  const cached = artistThumbUrls.get(fileName);
  if (cached) {
    image.src = cached;
    return thumb;
  }

  void storedLogoUrl(fileName)
    .then((url) => {
      artistThumbUrls.set(fileName, url);
      if (image.isConnected) image.src = url;
    })
    .catch(() => {
      if (!image.isConnected) return;
      image.remove();
      thumb.classList.add("is-empty");
      thumb.setAttribute("aria-hidden", "true");
      thumb.textContent = "—";
    });

  return thumb;
}

/**
 * Enters inline edit mode on the landing card with the artist's name and
 * current logo settings. The draft lives in `artistFormState` while the card
 * rebuilds around it; entering a scope or closing the landing page keeps the
 * draft (backup/restore name the landing screen until it is resolved).
 */
function startArtistEdit(artistId: string): void {
  if (artistBusy || artistDeleting || landingBusy) {
    setStatus("Wait for the current artist request to finish before editing an artist.", "info");
    return;
  }
  if (artistLogoBusy || landingLogoBusy) {
    setStatus("Wait for the artist logo import to finish before editing an artist.", "info");
    return;
  }
  // A typed-but-unsubmitted create draft would be rebuilt away under the edit
  // form: refuse with a titled status until it is created or cleared.
  const createName = landingTypedName();
  if (createName || landingLogoFile || landingTransientLogos.size > 0) {
    setStatus(
      createName
        ? `Landing artist draft open — create “${createName}” or clear the New artist form before editing an artist.`
        : "Landing artist draft open — create the new artist or clear the form before editing an artist.",
      "error",
    );
    return;
  }
  if (restoring || backingUp) return;

  const artist = artists.find((entry) => entry.id === artistId);
  if (!artist) return;

  if (artistFormState.mode === "edit" && artistFormState.artistId === artistId) {
    const existing = landingCard.querySelector<HTMLInputElement>("#artist-edit-name");
    existing?.focus();
    existing?.select();
    return;
  }

  discardArtistDraftLogos(artistFormState);
  artistFormState = {
    mode: "edit",
    artistId,
    name: artist.name,
    logo: { ...artist.logo },
    originalLogo: artist.logo.file_name,
    transientLogos: new Set(),
  };
  renderLanding();
  void showArtistStoredLogo(artist.logo.file_name);
  const nameInput = landingCard.querySelector<HTMLInputElement>("#artist-edit-name");
  nameInput?.focus();
  nameInput?.select();
}

/**
 * Cancels the landing artist-edit draft and returns focus to that artist's
 * Edit button, so keyboard users stay in the management list.
 */
function cancelArtistEdit(artistId: string): void {
  if (artistBusy) return;

  discardArtistDraftLogos(artistFormState);
  resetArtistForm();
  renderLanding();
  focusLandingArtistEdit(artistId);
}

/** Returns focus to one artist's Edit button on the landing card. */
function focusLandingArtistEdit(artistId: string): void {
  const row = landingCard.querySelector<HTMLLIElement>(`li[data-artist-id="${artistId}"]`);
  row?.querySelector<HTMLButtonElement>("[data-landing-edit]")?.focus();
}

/** Clears the form without deleting any logo file. */
function resetArtistForm(): void {
  invalidateArtistLogoPreview();
  artistFormState = createArtistFormState();
}

/** The live landing artist-edit form, if one is currently rendered. */
function landingArtistEditForm(): HTMLFormElement | null {
  return landingCard.querySelector<HTMLFormElement>('form[data-artist-edit]');
}

function syncLandingArtistFormControls(): void {
  const form = landingArtistEditForm();
  if (!form) return;
  const locked = artistBusy || landingBusy || restoring || backingUp;
  for (const control of form.querySelectorAll<HTMLInputElement>("input")) {
    control.disabled = locked;
  }
  const submit = form.querySelector<HTMLButtonElement>('button[type="submit"]');
  if (submit) submit.disabled = locked || artistLogoBusy;
  const cancel = form.querySelector<HTMLButtonElement>('[data-artist-edit-cancel]');
  if (cancel) cancel.disabled = locked;
  const remove = form.querySelector<HTMLButtonElement>('[data-artist-edit-remove-logo]');
  if (remove) remove.disabled = locked || !artistFormState.logo.file_name;
  form.setAttribute("aria-busy", String(artistBusy));
}

/** Refreshes the live edit-form logo preview from `artistFormState`. */
function refreshLandingArtistLogoPreview(): void {
  const preview = landingCard.querySelector<HTMLDivElement>("#artist-edit-logo-preview");
  if (!preview) return;
  paintArtistLogoPreview(preview);
}

/** Paints the artist-edit logo preview into an (attached or detached) node. */
function paintArtistLogoPreview(preview: HTMLDivElement): void {
  preview.replaceChildren();

  if (!artistFormState.logo.file_name) {
    preview.append(el("span", "artist-logo-preview-empty", "No logo"));
    return;
  }

  if (!artistLogoSrc) {
    preview.append(
      el(
        "span",
        "artist-logo-preview-empty",
        artistLogoPreviewFailed ? "No preview" : "Loading…",
      ),
    );
    return;
  }

  const image = el("img", "artist-logo-preview-img");
  image.src = artistLogoSrc;
  image.alt = "";
  preview.append(image);
}

/** Revokes the artist form preview URL and cancels any pending stored load. */
function invalidateArtistLogoPreview(): void {
  artistLogoRequestId += 1;
  artistLogoPreviewFailed = false;
  if (artistLogoSrc) {
    URL.revokeObjectURL(artistLogoSrc);
    artistLogoSrc = null;
  }
}

/** Shows a local object URL (fresh upload) in the form preview. */
function showArtistLogoPreview(url: string): void {
  invalidateArtistLogoPreview();
  artistLogoSrc = url;
  refreshLandingArtistLogoPreview();
}

/** Loads a stored logo into the form preview, ignoring stale requests. */
async function showArtistStoredLogo(fileName: string | null): Promise<void> {
  invalidateArtistLogoPreview();
  if (!fileName) {
    refreshLandingArtistLogoPreview();
    return;
  }

  const request = artistLogoRequestId;
  try {
    const url = await storedLogoUrl(fileName);
    if (request !== artistLogoRequestId) {
      URL.revokeObjectURL(url);
      return;
    }
    artistLogoSrc = url;
    refreshLandingArtistLogoPreview();
  } catch (error) {
    if (request === artistLogoRequestId) {
      artistLogoPreviewFailed = true;
      refreshLandingArtistLogoPreview();
      setStatus(`Could not load artist logo: ${describeError(error)}`, "error");
    }
  }
}

/**
 * Deletes draft-only logo files. The persisted `originalLogo` is always kept:
 * cancelling an edit must not remove the artist's saved logo.
 */
function discardArtistDraftLogos(state: ArtistFormState): void {
  const names = new Set(state.transientLogos);
  if (state.logo.file_name) names.add(state.logo.file_name);

  for (const name of names) {
    if (state.originalLogo && name === state.originalLogo) continue;
    pruneArtistThumbUrl(name);
    // A leftover file is harmless; never fail a UI reset over cleanup.
    void api.removeLogo(name).catch(() => undefined);
  }
}

async function handleArtistSubmit(event: SubmitEvent): Promise<void> {
  event.preventDefault();
  if (artistBusy || artistDeleting) {
    setStatus("Wait for the current artist request to finish before saving.", "info");
    return;
  }
  if (artistLogoBusy) {
    setStatus("Wait for the artist logo import to finish before saving.", "info");
    return;
  }
  if (landingBusy || landingLogoBusy) {
    setStatus("Wait for the landing artist create to finish before saving.", "info");
    return;
  }
  if (blockLibraryActionWhileBusy()) return;
  if (!ensureBackend()) return;

  const nameInput = landingCard.querySelector<HTMLInputElement>("#artist-edit-name");
  if (!nameInput) return;
  const name = nameInput.value.trim();
  if (!name) {
    markFieldInvalid(nameInput, true);
    setStatus("Artist name is required.", "error");
    nameInput.focus();
    return;
  }
  markFieldInvalid(nameInput, false);

  const state = artistFormState;
  if (state.mode !== "edit" || !state.artistId) return;
  const artist: Artist = {
    id: state.artistId,
    name,
    logo: { ...state.logo },
  };

  artistBusy = true;
  libraryWritesInFlight += 1;
  // Lock the landing management buttons and the edit form without rebuilding
  // the card, so the failure path below keeps the user's focus in place.
  syncLandingManagementButtons();
  syncLandingArtistFormControls();
  setStatus(`Saving artist “${name}”…`);

  try {
    const saved = await api.saveArtist(artist);
    const index = artists.findIndex((entry) => entry.id === saved.id);
    if (index >= 0) {
      artists[index] = saved;
    } else {
      artists.push(saved);
    }
    artists.sort((left, right) => left.name.localeCompare(right.name));

    // The record is persisted; now the replaced/imported files can go. The
    // backend still skips any file a setlist or another artist references.
    const cleanup = new Set(state.transientLogos);
    if (state.originalLogo && state.originalLogo !== saved.logo.file_name) {
      cleanup.add(state.originalLogo);
    }
    for (const fileName of cleanup) {
      if (fileName === saved.logo.file_name) continue;
      pruneArtistThumbUrl(fileName);
      void api.removeLogo(fileName).catch(() => undefined);
    }

    resetArtistForm();
    renderNewSongArtistOptions();
    renderScopePicker();
    renderFileUnder();
    renderLogoControls();
    renderLibrary();
    // A rename can change legacy-text identity and counts; a logo edit changes
    // this setlist's resolved logo width/alignment even when the file stays the
    // same, so always re-render the sheet before refreshing the resolved file.
    renderSummary();
    renderSheet();
    renderLanding();
    void refreshLogoIfChanged();
    focusLandingArtistEdit(saved.id);
    setStatus(
      `Updated artist “${saved.name}”. Songs and setlists show the new name without being rewritten.`,
      "success",
    );
  } catch (error) {
    setStatus(`Could not save artist: ${describeError(error)}`, "error");
  } finally {
    artistBusy = false;
    libraryWritesInFlight -= 1;
    syncLandingManagementButtons();
    syncLandingArtistFormControls();
  }
}

async function handleArtistLogoFile(): Promise<void> {
  const form = landingArtistEditForm();
  const fileInput = form?.querySelector<HTMLInputElement>("#artist-edit-logo-file");
  const file = fileInput?.files?.[0];
  if (fileInput) fileInput.value = "";
  if (!file) return;
  if (artistBusy || artistLogoBusy || artistDeleting || restoring || backingUp) {
    setStatus(
      "Wait for the current artist or logo request to finish before choosing another logo.",
      "info",
    );
    return;
  }
  if (landingBusy || landingLogoBusy) {
    setStatus(
      "Wait for the landing artist create to finish before choosing another logo.",
      "info",
    );
    return;
  }

  const allowed = ["image/png", "image/jpeg", "image/svg+xml"];
  if (!allowed.includes(file.type) && !/\.(png|jpe?g|svg)$/i.test(file.name)) {
    setStatus("Artist logo must be a PNG, JPEG, or SVG image.", "error");
    return;
  }
  if (file.size > 5 * 1024 * 1024) {
    setStatus("Artist logo must be 5 MiB or smaller.", "error");
    return;
  }
  if (!ensureBackend()) return;

  const state = artistFormState;
  const previousFileName = state.logo.file_name;
  artistLogoBusy = true;
  syncLandingArtistFormControls();
  setStatus(`Importing artist logo “${file.name}”…`);

  try {
    let bytes: Uint8Array;
    try {
      bytes = new Uint8Array(await file.arrayBuffer());
    } catch (error) {
      setStatus(`Could not read artist logo: ${describeError(error)}`, "error");
      return;
    }

    // The draft was cancelled or replaced while the file was being read.
    if (artistFormState !== state) return;

    const previewUrl = URL.createObjectURL(file);
    showArtistLogoPreview(previewUrl);
    const request = artistLogoRequestId;

    try {
      const storedName = await api.importLogo(bytes, file.name);
      if (request !== artistLogoRequestId || artistFormState !== state) {
        // The form moved on while the upload was in flight.
        void api.removeLogo(storedName).catch(() => undefined);
        URL.revokeObjectURL(previewUrl);
        return;
      }

      if (
        previousFileName &&
        previousFileName !== storedName &&
        previousFileName !== state.originalLogo
      ) {
        state.transientLogos.add(previousFileName);
      }
      state.logo.file_name = storedName;
      syncLandingArtistFormControls();
      refreshLandingArtistLogoPreview();
      setStatus("Artist logo imported.", "success");
    } catch (error) {
      // Keep the persisted/previous logo after a failed replacement.
      invalidateArtistLogoPreview();
      syncLandingArtistFormControls();
      refreshLandingArtistLogoPreview();
      if (state.logo.file_name) {
        void showArtistStoredLogo(state.logo.file_name);
      }
      setStatus(`Could not import artist logo: ${describeError(error)}`, "error");
    }
  } finally {
    artistLogoBusy = false;
    syncLandingArtistFormControls();
  }
}

function handleArtistLogoRemove(): void {
  if (artistBusy) return;

  const fileName = artistFormState.logo.file_name;
  if (!fileName) return;

  if (fileName !== artistFormState.originalLogo) {
    artistFormState.transientLogos.add(fileName);
  }
  artistFormState.logo.file_name = null;
  invalidateArtistLogoPreview();
  syncLandingArtistFormControls();
  refreshLandingArtistLogoPreview();
  setStatus("Artist logo removed — save to apply.");
}

/**
 * Deletes an artist record and best-effort clears every song/setlist
 * `artist_id` that points at it through the unfiled allowance. Song `artist`
 * snapshots stay untouched, so the last name remains visible; the nulled
 * records land in the Unfiled scope, never in limbo.
 */
async function deleteArtist(artist: Artist): Promise<void> {
  if (artistBusy || artistDeleting || landingBusy) {
    setStatus("Wait for the current artist request to finish before deleting an artist.", "info");
    return;
  }
  if (artistLogoBusy || landingLogoBusy) {
    setStatus("Artist delete blocked — wait for the logo import to finish.", "info");
    return;
  }
  if (blockLibraryActionWhileBusy()) return;
  if (!ensureBackend()) return;

  // A concurrent song save/draft would be clobbered by the reference-clearing
  // loop (or could re-save a stale artist_id afterwards), so use the same guard
  // as Back up / Restore before taking the library snapshot.
  const libraryBlock = libraryWriteGuard("deleting an artist");
  if (libraryBlock) {
    setStatus(`Artist delete blocked — ${libraryBlock}`, "error");
    return;
  }

  const nulledSongCount = songs.filter((song) => song.artist_id === artist.id).length;
  const nulledSetlistCount = setlists.filter(
    (setlist) => normalizeArtistId(setlist.artist_id) === artist.id,
  ).length;
  const confirmed = window.confirm(
    `Delete artist “${artist.name}”? ${countLabel(nulledSongCount, "song")} and ${countLabel(nulledSetlistCount, "setlist")} will become unfiled.`,
  );
  if (!confirmed) return;

  const editingThis =
    artistFormState.mode === "edit" && artistFormState.artistId === artist.id;
  const failures: string[] = [];

  artistBusy = true;
  artistDeleting = true;
  libraryWritesInFlight += 1;
  renderLanding();
  // Lock library rows visually for the whole reference-clearing loop; handlers
  // also refuse through `blockLibraryActionWhileBusy`.
  renderLibrary();
  setStatus(`Deleting artist “${artist.name}”…`);

  try {
    for (const song of [...songs]) {
      if (song.artist_id !== artist.id) continue;
      try {
        // The nulled record is unfiled by definition: the allowance applies.
        const saved = await api.saveSong({ ...song, artist_id: null }, true);
        const index = songs.findIndex((entry) => entry.id === saved.id);
        if (index >= 0) songs[index] = saved;
      } catch (error) {
        failures.push(`song “${song.title}” (${describeError(error)})`);
      }
    }

    for (const setlist of [...setlists]) {
      if (normalizeArtistId(setlist.artist_id) !== artist.id) continue;
      try {
        const saved = await api.saveSetlist({ ...setlist, artist_id: null }, true);
        const index = setlists.findIndex((entry) => entry.id === saved.id);
        if (index >= 0) {
          setlists[index] = {
            ...saved,
            artist_id: normalizeArtistId(saved.artist_id),
          };
        }
        // Key off the open draft's own assignment, not the cached record: a
        // dirty draft may have moved S to another artist (or onto A) since the
        // cache was saved. Never overwrite an unrelated dirty choice.
        if (
          current?.id === saved.id &&
          normalizeArtistId(current.artist_id) === artist.id
        ) {
          current.artist_id = null;
          if (!dirty) current = cloneSetlist(saved);
        }
      } catch (error) {
        failures.push(`setlist “${setlist.title}” (${describeError(error)})`);
      }
    }
    sortSetlists();

    try {
      await api.deleteArtist(artist.id);
    } catch (error) {
      // References may already be cleared; the artist record stays, so report
      // without pretending the delete succeeded.
      const detail =
        failures.length > 0
          ? ` References not cleared: ${summarizeRecords(failures)}.`
          : "";
      setStatus(`Could not delete artist: ${describeError(error)}.${detail}`, "error");
      renderAll();
      return;
    }

    artists = artists.filter((entry) => entry.id !== artist.id);
    // The clear is keyed off the open draft itself, so it also covers a dirty
    // persisted draft whose cached record no longer points at A and drafts not
    // present in `setlists`. An unrelated draft assignment is preserved.
    if (current && normalizeArtistId(current.artist_id) === artist.id) {
      current.artist_id = null;
    }
    clearArtistDraftForDeletedArtist(artist.id, editingThis);
    // The deleted scope is gone: follow its records into the Unfiled scope, or
    // back to the landing page when nothing is unfiled.
    let fallbackNote = "";
    if (activeArtistId === artist.id) {
      if (unfiledCount() > 0) {
        activeArtistId = UNFILED_SCOPE;
        reselectCurrentInScope();
        fallbackNote = " Now in the Unfiled scope.";
      } else {
        activeArtistId = null;
        landingVisible = true;
        fallbackNote = " No unfiled records remain — choose an artist on the landing screen.";
      }
    }
    renderNewSongArtistOptions();
    renderAll();
    void refreshLogoIfChanged();

    if (artist.logo.file_name) {
      pruneArtistThumbUrl(artist.logo.file_name);
      // Backend skips the file while a setlist or another artist references it.
      await api.removeLogo(artist.logo.file_name).catch(() => undefined);
    }

    const summary = `Deleted artist “${artist.name}”. ${countLabel(nulledSongCount, "song")} and ${countLabel(nulledSetlistCount, "setlist")} are now unfiled.${fallbackNote}`;
    if (failures.length > 0) {
      setStatus(
        `${summary} Some references could not be cleared: ${summarizeRecords(failures)}.`,
        "error",
      );
    } else {
      setStatus(summary, "success");
    }
  } catch (error) {
    setStatus(`Could not delete artist: ${describeError(error)}`, "error");
  } finally {
    artistDeleting = false;
    artistBusy = false;
    libraryWritesInFlight -= 1;
    renderLanding();
    renderLibrary();
  }
}

/**
 * Points an open library-editor draft at its legacy snapshot after its artist
 * record disappears, so opening the editor never silently loses the text.
 */
function clearArtistDraftForDeletedArtist(artistId: string, editingThis: boolean): void {
  const editor = libraryEditor;
  if (editor?.draft.artistId === artistId) {
    const song = songs.find((entry) => entry.id === editor.songId);
    editor.draft.artistId = "";
    editor.draft.legacyArtist =
      song?.artist?.trim() ?? editor.draft.legacyArtist.trim();
    editor.draft.keepLegacyArtist = Boolean(editor.draft.legacyArtist);
  }

  if (!editingThis) return;
  discardArtistDraftLogos(artistFormState);
  resetArtistForm();
}

// ---------------------------------------------------------------------------
// Landing page + scope entry
// ---------------------------------------------------------------------------

/**
 * Enters an artist or Unfiled scope from the landing page. Follows the same
 * dirty-editor guard as the scope switcher; entering hides the overlay and
 * selects the first in-scope setlist (or a blank scope draft).
 */
async function enterScope(id: string): Promise<void> {
  if (id !== UNFILED_SCOPE && !artists.some((artist) => artist.id === id)) return;
  if (backingUp || restoring) {
    setStatus(
      `Scope switch blocked — ${backingUp ? "backup" : "restore"} in progress. Wait for it to finish.`,
      "error",
    );
    return;
  }
  if (captureGuard()) return;
  if (dirty && !confirmDiscard()) return;

  if (landingLogoFile) landingTransientLogos.add(landingLogoFile);
  landingLogoFile = null;
  discardLandingTransientLogos();
  landingShowCreate = false;
  landingVisible = false;
  activeArtistId = id;

  pendingLogoRemovals.clear();
  clearLogoPreview();
  const inScope = setlists.filter((setlist) => setlistInScope(setlist));
  current = inScope[0] ? cloneSetlist(inScope[0]) : blankDraftForScope();
  dirty = inScope.length === 0;
  renderAll();
  if (backendAvailable && !dirty) {
    await loadLogoForCurrent();
  }
  fitPreview();

  const scope = activeScopeArtist();
  if (scope) await maybeOfferUnfiledAssignment(scope);
  // The overlay (and its focused control) is gone; land focus on the scope
  // switcher so keyboard users stay oriented.
  setlistArtistFilterSelect.focus();
}

/** Closes a reopened landing page without leaving the active scope. */
function closeLanding(): void {
  if (activeArtistId === null) return;
  if (landingLogoFile) landingTransientLogos.add(landingLogoFile);
  landingLogoFile = null;
  discardLandingTransientLogos();
  landingShowCreate = false;
  landingVisible = false;
  renderScopePicker();
  renderLanding();
  setlistArtistFilterSelect.focus();
}

/** Best-effort cleanup of staged landing logos no record references. */
function discardLandingTransientLogos(): void {
  for (const name of landingTransientLogos) {
    // A staged file adopted by a saved artist is still referenced; the backend
    // skips those, so this never deletes a live logo.
    void api.removeLogo(name).catch(() => undefined);
  }
  landingTransientLogos.clear();
}

/**
 * Traps keyboard focus inside the modal landing dialog: while it is visible,
 * the header and workspace are `inert`, so Tab cannot leave the overlay. The
 * status line stays live for announcements. Removing the attribute restores
 * the background when the overlay hides.
 */
function syncLandingInert(): void {
  for (const node of document.querySelectorAll(".app-shell > header, .app-shell > main")) {
    if (landingVisible) {
      node.setAttribute("inert", "");
    } else {
      node.removeAttribute("inert");
    }
  }
}

function renderLanding(): void {
  // Stash the create-form name before the rebuild: cancel/delete/save paths
  // below rebuild the card, and the typed-but-unsubmitted name must survive.
  const liveNameInput = document.getElementById("landing-name");
  if (liveNameInput instanceof HTMLInputElement) {
    landingCreateNameDraft = liveNameInput.value;
  }
  landingOverlay.hidden = !landingVisible;
  syncLandingInert();
  if (!landingVisible) return;

  landingCard.replaceChildren(buildLandingCard());
  // Move keyboard focus inside the dialog, but never steal it back while the
  // user is already working in the form (logo imports re-render the card).
  if (!landingCard.contains(document.activeElement)) {
    landingCard.querySelector<HTMLElement>("button, input, select")?.focus();
  }
}

function buildLandingCard(): DocumentFragment {
  const fragment = document.createDocumentFragment();
  const scoped = activeArtistId !== null;

  if (artists.length === 0) {
    fragment.append(
      landingHeading("Create your first artist"),
      landingSub("StageSheet is organized by artist. Create one to open its song library and setlists."),
      buildLandingCreateForm(),
      buildLandingBackupSection(),
    );
  } else {
    fragment.append(
      landingHeading("Choose an artist"),
      landingSub("Each artist has its own song library and setlists. Totals live here; the library badge counts the active scope."),
    );

    const list = el("ul", "landing-list");
    for (const artist of artists) {
      list.append(buildLandingArtistRow(artist));
    }
    const unfiled = unfiledCount();
    if (unfiled > 0) {
      list.append(buildLandingUnfiledRow(unfiled));
    }
    fragment.append(list);

    if (landingShowCreate) {
      fragment.append(buildLandingCreateForm());
    } else {
      const toggle = el("button", "btn", "New artist");
      toggle.type = "button";
      toggle.dataset.landingNewToggle = "true";
      toggle.disabled = artistBusy || artistDeleting || landingBusy || restoring || backingUp;
      toggle.addEventListener("click", () => {
        landingShowCreate = true;
        renderLanding();
      });
      fragment.append(toggle);
    }
    fragment.append(buildLandingBackupSection());
  }

  if (scoped) {
    const close = el("button", "btn", "Back to workspace");
    close.type = "button";
    close.addEventListener("click", closeLanding);
    fragment.append(close);
  }
  return fragment;
}

/**
 * Backup section on the landing card (Feature 24): the same Back up / Restore
 * entry points as the retired library-pane fieldset, so restore works before
 * entering any scope. The card rebuilds from restored data via `renderAll`,
 * and the user then enters a scope. Buttons live on the card, so the
 * background `inert` scope does not block them.
 */
function buildLandingBackupSection(): HTMLElement {
  const section = el("section", "landing-backup");
  section.setAttribute("aria-labelledby", "landing-backup-heading");
  const heading = el("h3", undefined, "Backup");
  heading.id = "landing-backup-heading";
  const hint = el(
    "p",
    "landing-backup-hint",
    "One JSON file with every artist, song, and setlist. Logos are not included — re-import them after restoring on another device.",
  );
  hint.id = "landing-backup-hint";
  section.setAttribute("aria-describedby", "landing-backup-hint");
  const actions = el("div", "landing-backup-actions");
  const busy = backingUp || restoring;
  const backUpButton = el("button", "btn btn-small", "Back up");
  backUpButton.type = "button";
  backUpButton.id = "backup-export";
  backUpButton.disabled = busy;
  backUpButton.addEventListener("click", () => {
    void backUpLibrary();
  });
  const restoreButton = el("button", "btn btn-small", "Restore");
  restoreButton.type = "button";
  restoreButton.id = "backup-restore";
  restoreButton.disabled = busy;
  restoreButton.addEventListener("click", () => {
    void restoreLibrary();
  });
  actions.append(backUpButton, restoreButton);
  section.append(heading, hint, actions);
  return section;
}

function landingHeading(text: string): HTMLHeadingElement {
  const heading = el("h2", undefined, text);
  heading.id = "landing-title";
  return heading;
}

function landingSub(text: string): HTMLParagraphElement {
  return el("p", "landing-sub", text);
}

/**
 * Landing artist row: the workspace entry button plus per-row Edit/Delete
 * management. The edit form renders inline under the row while
 * `artistFormState` holds that artist's draft.
 */
function buildLandingArtistRow(artist: Artist): HTMLLIElement {
  const row = el("li", "landing-row");
  row.dataset.artistId = artist.id;
  const editing = artistFormState.mode === "edit" && artistFormState.artistId === artist.id;
  if (editing) row.classList.add("is-editing");

  const button = el("button", "landing-artist");
  button.type = "button";
  button.setAttribute("aria-label", `Open the ${artistLabel(artist)} workspace`);

  button.append(buildArtistThumb(artist));

  const info = el("div", "landing-artist-info");
  info.append(el("span", "landing-artist-name", artistLabel(artist)));
  const songCount = songs.filter(
    (song) => resolveArtistForSong(song, artists)?.id === artist.id,
  ).length;
  const setlistCount = setlists.filter(
    (setlist) => normalizeArtistId(setlist.artist_id) === artist.id,
  ).length;
  info.append(
    el(
      "span",
      "landing-artist-meta",
      `${countLabel(songCount, "song")} · ${countLabel(setlistCount, "setlist")}`,
    ),
  );
  button.append(info);

  button.addEventListener("click", () => {
    void enterScope(artist.id);
  });

  const manage = el("div", "landing-manage");
  const editButton = el("button", "icon-button");
  editButton.type = "button";
  editButton.dataset.landingEdit = artist.id;
  editButton.title = `Edit ${artistLabel(artist)}`;
  editButton.setAttribute("aria-label", `Edit artist ${artistLabel(artist)}`);
  editButton.setAttribute("aria-expanded", String(editing));
  editButton.append(editIcon());
  editButton.addEventListener("click", () => startArtistEdit(artist.id));

  const deleteButton = el("button", "icon-button", "✕");
  deleteButton.type = "button";
  deleteButton.title = `Delete ${artistLabel(artist)}`;
  deleteButton.setAttribute("aria-label", `Delete artist ${artistLabel(artist)}`);
  deleteButton.addEventListener("click", () => {
    void deleteArtist(artist);
  });

  const locked = artistBusy || artistDeleting || landingBusy || restoring || backingUp;
  editButton.disabled = locked;
  deleteButton.disabled = locked;
  manage.append(editButton, deleteButton);

  row.append(button, manage);
  if (editing) row.append(buildLandingArtistEditForm(artist));
  return row;
}

/** Locks the landing management buttons while an artist write owns the records. */
function syncLandingManagementButtons(): void {
  const locked = artistBusy || artistDeleting || landingBusy || restoring || backingUp;
  for (const button of landingCard.querySelectorAll<HTMLButtonElement>(".landing-manage button")) {
    button.disabled = locked;
  }
  const toggle = landingCard.querySelector<HTMLButtonElement>('[data-landing-new-toggle]');
  if (toggle) toggle.disabled = locked;
}

/**
 * Inline artist-edit form on the landing card: the same name/logo/width/
 * alignment fields and validation as the retired library-pane form. Values
 * live in `artistFormState`, so card rebuilds (logo imports, busy locks)
 * never reset partially typed fields.
 */
function buildLandingArtistEditForm(artist: Artist): HTMLFormElement {
  const state = artistFormState;
  const form = el("form", "artist-form");
  form.dataset.artistEdit = artist.id;
  form.noValidate = true;
  form.setAttribute("aria-label", `Edit artist ${artistLabel(artist)}`);

  const title = el("h3", undefined, "Edit artist");
  form.append(title);

  const nameField = el("label", "field");
  nameField.htmlFor = "artist-edit-name";
  const nameText = el("span", "item-field-label", "Name");
  const nameInput = document.createElement("input");
  nameInput.id = "artist-edit-name";
  nameInput.required = true;
  nameInput.autocomplete = "off";
  nameInput.value = state.name;
  nameField.append(nameText, nameInput);
  form.append(nameField);

  const previewRow = el("div", "artist-logo-preview-row");
  const preview = el("div", "artist-logo-preview");
  preview.id = "artist-edit-logo-preview";
  preview.setAttribute("aria-hidden", "true");
  const removeButton = el("button", "btn btn-small btn-danger", "Remove logo");
  removeButton.type = "button";
  removeButton.dataset.artistEditRemoveLogo = artist.id;
  previewRow.append(preview, removeButton);
  form.append(previewRow);

  const fileField = el("label", "field");
  fileField.htmlFor = "artist-edit-logo-file";
  fileField.append(
    el("span", "item-field-label", "Logo (PNG, JPEG, SVG · max 5 MiB)"),
  );
  const fileInput = document.createElement("input");
  fileInput.id = "artist-edit-logo-file";
  fileInput.type = "file";
  fileInput.accept = "image/png,image/jpeg,image/svg+xml";
  fileField.append(fileInput);
  form.append(fileField);

  const logoRow = el("div", "logo-row");
  const widthField = el("div", "field field-grow");
  const widthLabel = document.createElement("label");
  widthLabel.htmlFor = "artist-edit-logo-width";
  const widthText = el("span", "item-field-label", "Width ");
  const widthOutput = document.createElement("output");
  widthOutput.id = "artist-edit-logo-width-value";
  widthOutput.textContent = `${Math.round(state.logo.width_mm)} mm`;
  widthLabel.append(widthText, widthOutput);
  const widthInput = document.createElement("input");
  widthInput.id = "artist-edit-logo-width";
  widthInput.type = "range";
  widthInput.min = String(LOGO_MIN_WIDTH_MM);
  widthInput.max = String(LOGO_MAX_WIDTH_MM);
  widthInput.step = "1";
  widthInput.value = String(state.logo.width_mm);
  widthField.append(widthLabel, widthInput);
  const alignmentField = el("div", "field");
  const alignmentLabel = el("span", "field-label", "Alignment");
  alignmentLabel.id = "artist-edit-logo-alignment-label";
  const segmented = el("div", "segmented");
  segmented.setAttribute("role", "radiogroup");
  segmented.setAttribute("aria-labelledby", "artist-edit-logo-alignment-label");
  const alignments: LogoAlignment[] = ["Left", "Center", "Right"];
  for (const value of alignments) {
    const option = document.createElement("label");
    const radio = document.createElement("input");
    radio.type = "radio";
    radio.name = "artist-edit-logo-alignment";
    radio.value = value;
    radio.checked = value === state.logo.alignment;
    option.append(radio, el("span", undefined, value));
    segmented.append(option);
  }
  alignmentField.append(alignmentLabel, segmented);
  logoRow.append(widthField, alignmentField);
  form.append(logoRow);

  const actions = el("div", "artist-form-actions");
  const cancelButton = el("button", "btn btn-small", "Cancel");
  cancelButton.type = "button";
  cancelButton.dataset.artistEditCancel = artist.id;
  const submitButton = el("button", "btn btn-small btn-primary", "Save artist");
  submitButton.type = "submit";
  actions.append(cancelButton, submitButton);
  form.append(actions);

  // Populate the preview and busy state from `artistFormState` like the
  // retired pane form did after a render. The form is still detached here, so
  // paint/sync run against the built nodes directly.
  paintArtistLogoPreview(preview);
  form.setAttribute("aria-busy", String(artistBusy));

  nameInput.addEventListener("input", () => {
    artistFormState.name = nameInput.value;
    if (nameInput.classList.contains("is-invalid")) {
      markFieldInvalid(nameInput, false);
    }
  });
  cancelButton.addEventListener("click", () => cancelArtistEdit(artist.id));
  fileInput.addEventListener("change", () => {
    void handleArtistLogoFile();
  });
  removeButton.addEventListener("click", handleArtistLogoRemove);
  widthInput.addEventListener("input", () => {
    artistFormState.logo.width_mm = clamp(
      Number(widthInput.value),
      LOGO_MIN_WIDTH_MM,
      LOGO_MAX_WIDTH_MM,
    );
    widthOutput.textContent = `${Math.round(artistFormState.logo.width_mm)} mm`;
  });
  for (const radio of segmented.querySelectorAll<HTMLInputElement>('input[type="radio"]')) {
    radio.addEventListener("change", () => {
      if (!radio.checked || !isLogoAlignment(radio.value)) return;
      artistFormState.logo.alignment = radio.value;
    });
  }
  form.addEventListener("submit", (event) => {
    void handleArtistSubmit(event);
  });
  form.addEventListener("keydown", (event) => {
    if (event.key === "Escape") {
      // Cancel the draft without closing a reopened landing page underneath.
      event.preventDefault();
      event.stopPropagation();
      cancelArtistEdit(artist.id);
    }
  });

  return form;
}

function buildLandingUnfiledRow(count: number): HTMLLIElement {
  const row = el("li", "landing-row");
  const button = el("button", "landing-artist landing-unfiled");
  button.type = "button";
  button.setAttribute("aria-label", `Open the Unfiled workspace, ${countLabel(count, "record")}`);
  button.append(el("span", "artist-thumb is-empty", "—"));
  const info = el("div", "landing-artist-info");
  info.append(el("span", "landing-artist-name", "Unfiled"));
  info.append(el("span", "landing-artist-meta", `${countLabel(count, "record")} with no artist`));
  button.append(info);
  button.addEventListener("click", () => {
    void enterScope(UNFILED_SCOPE);
  });
  row.append(button);
  return row;
}

/**
 * Landing-page artist creation: name plus the same logo upload/width/alignment
 * controls and validation as the artist edit form. Creating enters the new
 * artist's scope immediately.
 */
function buildLandingCreateForm(): HTMLFormElement {
  const form = el("form", "landing-form");
  form.noValidate = true;
  form.setAttribute("aria-label", "New artist");

  const nameId = "landing-name";
  const nameLabel = document.createElement("label");
  nameLabel.className = "field";
  const nameText = el("span", "item-field-label", "Name");
  const nameInput = document.createElement("input");
  nameInput.id = nameId;
  nameInput.required = true;
  nameInput.autocomplete = "off";
  nameInput.value = landingCreateNameDraft;
  nameLabel.append(nameText, nameInput);

  const preview = el("div", "landing-logo-preview");
  preview.setAttribute("aria-hidden", "true");
  refreshLandingLogoPreview(preview);

  const fileId = "landing-logo-file";
  const fileLabel = document.createElement("label");
  fileLabel.className = "field";
  fileLabel.append(el("span", "item-field-label", "Logo (PNG, JPEG, SVG · max 5 MiB)"));
  const fileInput = document.createElement("input");
  fileInput.id = fileId;
  fileInput.type = "file";
  fileInput.accept = "image/png,image/jpeg,image/svg+xml";
  fileLabel.append(fileInput);

  const widthId = "landing-logo-width";
  const widthLabel = document.createElement("label");
  widthLabel.className = "field field-grow";
  const widthText = document.createElement("span");
  widthText.className = "item-field-label";
  widthText.append("Width ");
  const widthOutput = document.createElement("output");
  widthOutput.id = `${widthId}-value`;
  widthOutput.textContent = `${DEFAULT_LOGO_WIDTH_MM} mm`;
  widthText.append(widthOutput);
  const widthInput = document.createElement("input");
  widthInput.id = widthId;
  widthInput.type = "range";
  widthInput.min = String(LOGO_MIN_WIDTH_MM);
  widthInput.max = String(LOGO_MAX_WIDTH_MM);
  widthInput.step = "1";
  widthInput.value = String(DEFAULT_LOGO_WIDTH_MM);
  widthInput.addEventListener("input", () => {
    widthOutput.textContent = `${Math.round(clamp(Number(widthInput.value), LOGO_MIN_WIDTH_MM, LOGO_MAX_WIDTH_MM))} mm`;
  });
  widthLabel.append(widthText, widthInput);

  const alignmentGroup = document.createElement("div");
  alignmentGroup.className = "field";
  const alignmentLabel = el("span", "field-label", "Alignment");
  alignmentLabel.id = "landing-logo-alignment-label";
  const segmented = el("div", "segmented");
  segmented.setAttribute("role", "radiogroup");
  segmented.setAttribute("aria-labelledby", "landing-logo-alignment-label");
  const alignments: LogoAlignment[] = ["Left", "Center", "Right"];
  for (const value of alignments) {
    const option = document.createElement("label");
    const radio = document.createElement("input");
    radio.type = "radio";
    radio.name = "landing-logo-alignment";
    radio.value = value;
    radio.checked = value === "Center";
    const text = el("span", undefined, value);
    option.append(radio, text);
    segmented.append(option);
  }
  alignmentGroup.append(alignmentLabel, segmented);

  const submit = el("button", "btn btn-primary", "Create artist");
  submit.type = "submit";
  submit.disabled = landingBusy;

  fileInput.addEventListener("change", () => {
    void handleLandingLogoFile(fileInput, preview);
  });
  nameInput.addEventListener("input", () => {
    if (nameInput.classList.contains("is-invalid")) markFieldInvalid(nameInput, false);
  });

  form.addEventListener("submit", (event) => {
    event.preventDefault();
    void handleLandingCreate(form, nameInput, widthInput, submit);
  });

  form.append(nameLabel, preview, fileLabel, widthLabel, alignmentGroup, submit);
  return form;
}

function refreshLandingLogoPreview(preview: HTMLElement): void {
  // The previous render's blob URL is replaced below; revoke it first so
  // repeated landing renders cannot leak object URLs.
  const previous = preview.querySelector<HTMLImageElement>("img");
  if (previous?.src.startsWith("blob:")) URL.revokeObjectURL(previous.src);
  preview.replaceChildren();
  if (!landingLogoFile) {
    preview.append(el("span", "artist-logo-preview-empty", "No logo"));
    return;
  }
  const image = el("img", "artist-logo-preview-img");
  image.alt = "";
  preview.append(image);
  void storedLogoUrl(landingLogoFile)
    .then((url) => {
      if (image.isConnected) image.src = url;
    })
    .catch(() => {
      if (!image.isConnected) return;
      image.remove();
      preview.append(el("span", "artist-logo-preview-empty", "No preview"));
    });
}

async function handleLandingLogoFile(fileInput: HTMLInputElement, preview: HTMLElement): Promise<void> {
  const file = fileInput.files?.[0];
  fileInput.value = "";
  if (!file || landingBusy || landingLogoBusy) return;
  if (artistBusy || artistDeleting || artistLogoBusy) {
    setStatus("Wait for the current artist request to finish before choosing a logo.", "info");
    return;
  }

  const allowed = ["image/png", "image/jpeg", "image/svg+xml"];
  if (!allowed.includes(file.type) && !/\.(png|jpe?g|svg)$/i.test(file.name)) {
    setStatus("Artist logo must be a PNG, JPEG, or SVG image.", "error");
    return;
  }
  if (file.size > 5 * 1024 * 1024) {
    setStatus("Artist logo must be 5 MiB or smaller.", "error");
    return;
  }
  if (!ensureBackend()) return;

  landingLogoBusy = true;
  setStatus(`Importing artist logo “${file.name}”…`);
  try {
    const bytes = new Uint8Array(await file.arrayBuffer());
    const storedName = await api.importLogo(bytes, file.name);
    if (landingLogoFile) landingTransientLogos.add(landingLogoFile);
    landingLogoFile = storedName;
    refreshLandingLogoPreview(preview);
    setStatus("Artist logo imported.", "success");
  } catch (error) {
    setStatus(`Could not import artist logo: ${describeError(error)}`, "error");
  } finally {
    landingLogoBusy = false;
  }
}

async function handleLandingCreate(
  form: HTMLFormElement,
  nameInput: HTMLInputElement,
  widthInput: HTMLInputElement,
  submit: HTMLButtonElement,
): Promise<void> {
  if (landingBusy) return;
  if (landingLogoBusy) {
    setStatus("Wait for the artist logo import to finish before creating.", "info");
    return;
  }
  if (artistBusy || artistDeleting || artistLogoBusy) {
    setStatus("Wait for the current artist request to finish before creating.", "info");
    return;
  }
  if (!ensureBackend()) return;

  const name = nameInput.value.trim();
  if (!name) {
    markFieldInvalid(nameInput, true);
    setStatus("Artist name is required.", "error");
    nameInput.focus();
    return;
  }
  markFieldInvalid(nameInput, false);

  const checked = form.querySelector<HTMLInputElement>('input[name="landing-logo-alignment"]:checked');
  const alignment: LogoAlignment =
    checked && isLogoAlignment(checked.value) ? checked.value : "Center";

  landingBusy = true;
  submit.disabled = true;
  syncLandingManagementButtons();
  setStatus(`Creating artist “${name}”…`);

  try {
    const saved = await api.saveArtist({
      id: newId(),
      name,
      logo: {
        file_name: landingLogoFile,
        width_mm: clamp(Number(widthInput.value), LOGO_MIN_WIDTH_MM, LOGO_MAX_WIDTH_MM),
        alignment,
      },
    });
    artists.push(saved);
    artists.sort((left, right) => left.name.localeCompare(right.name));
    // The staged logo is now referenced by the record; stop tracking it so the
    // scope entry below does not try to clean it up.
    if (saved.logo.file_name) landingTransientLogos.delete(saved.logo.file_name);
    landingLogoFile = null;
    // The created name is committed: a later New-artist form starts blank.
    landingCreateNameDraft = "";
    setStatus(`Added artist “${saved.name}”.`, "success");
    await enterScope(saved.id);
  } catch (error) {
    setStatus(`Could not create artist: ${describeError(error)}`, "error");
  } finally {
    landingBusy = false;
    submit.disabled = false;
    syncLandingManagementButtons();
  }
}

/**
 * Once per scope entry, offers to assign every truly unfiled record (a null
 * `artist_id` with no resolved artist — dangling ids are excluded) to the
 * artist just entered. Confirming writes through the normal save commands
 * with per-record status; declining keeps them Unfiled.
 */
async function maybeOfferUnfiledAssignment(scope: Artist): Promise<void> {
  const offerSongs = songs.filter(
    (song) =>
      normalizeArtistId(song.artist_id) === null &&
      resolveArtistForSong(song, artists) === null,
  );
  const offerSetlists = setlists.filter(
    (setlist) => normalizeArtistId(setlist.artist_id) === null,
  );
  if (offerSongs.length === 0 && offerSetlists.length === 0) return;

  const signature = [
    ...offerSongs.map((song) => song.id),
    ...offerSetlists.map((setlist) => setlist.id),
  ]
    .sort()
    .join("|");
  if (landingOffered.get(scope.id) === signature) return;
  landingOffered.set(scope.id, signature);

  const confirmed = window.confirm(
    `${countLabel(offerSongs.length, "song")} and ${countLabel(offerSetlists.length, "setlist")} have no artist. Assign them to “${artistLabel(scope)}”?`,
  );
  if (!confirmed) return;

  let assignedSongs = 0;
  let assignedSetlists = 0;
  const failures: string[] = [];
  for (const song of offerSongs) {
    try {
      const saved = await api.saveSong({
        ...song,
        artist_id: scope.id,
        artist: scope.name.trim(),
      });
      const index = songs.findIndex((entry) => entry.id === saved.id);
      if (index >= 0) songs[index] = saved;
      assignedSongs += 1;
    } catch (error) {
      failures.push(`song “${song.title}” (${describeError(error)})`);
    }
  }
  for (const setlist of offerSetlists) {
    try {
      const saved = await api.saveSetlist({ ...setlist, artist_id: scope.id });
      const index = setlists.findIndex((entry) => entry.id === saved.id);
      if (index >= 0) {
        setlists[index] = {
          ...saved,
          artist_id: normalizeArtistId(saved.artist_id),
        };
      }
      if (current?.id === saved.id) current = cloneSetlist(saved);
      assignedSetlists += 1;
    } catch (error) {
      failures.push(`setlist “${setlist.title}” (${describeError(error)})`);
    }
  }
  sortSetlists();
  renderAll();

  const summary = `Assigned ${countLabel(assignedSongs, "song")} and ${countLabel(assignedSetlists, "setlist")} to “${artistLabel(scope)}”.`;
  if (failures.length > 0) {
    setStatus(
      `${summary} Some records could not be assigned: ${summarizeRecords(failures)}.`,
      "error",
    );
  } else {
    setStatus(summary, "success");
  }
}

// ---------------------------------------------------------------------------
// Logo
// ---------------------------------------------------------------------------

/**
 * Commits a width/alignment patch to the displayed artist logo via
 * `save_artist` (Features 19 + 25: both controls bind the effective logo).
 * Only runs on `change` (release) so dragging never spams `save_artist`;
 * at most one save is in flight at a time. The setlist itself is never
 * dirtied: the artist record is what changed. Refusals and failures revert
 * the control and report through the status line.
 */
async function commitEffectiveArtistLogo(
  patch: { width_mm?: number; alignment?: LogoAlignment },
  revert: () => void,
  summary: string,
): Promise<void> {
  if (!current) return;
  if (effectiveLogoCase() !== "artist") {
    renderLogoControls();
    return;
  }
  const artist = effectiveLogoArtist();
  if (!artist) {
    renderLogoControls();
    return;
  }

  // Reuse the Feature 14 artist-edit guards: refuse while a backup/restore,
  // export capture, or artist-logo import is in flight, while another artist
  // save runs, or while an artist draft for this artist is open.
  if (effectiveLogoSaving || artistBusy) {
    revert();
    setStatus("Wait for the current artist request to finish before changing the logo.", "info");
    return;
  }
  if (artistLogoBusy) {
    revert();
    setStatus("Wait for the artist logo import to finish before changing the logo.", "info");
    return;
  }
  if (backingUp || restoring) {
    revert();
    setStatus(
      backingUp
        ? "Backup in progress — wait for it to finish before changing the logo."
        : "Restore in progress — wait for it to finish before changing the logo.",
      "info",
    );
    return;
  }
  if (exporting) {
    revert();
    setStatus("Export in progress — wait for it to finish before changing the logo.", "info");
    return;
  }
  if (artistFormState.mode === "edit" && artistFormState.artistId === artist.id) {
    revert();
    setStatus(
      `Artist draft open — save or cancel the edit for “${artistLabel(artist)}” before changing the logo.`,
      "error",
    );
    return;
  }
  if (!ensureBackend()) {
    revert();
    return;
  }

  effectiveLogoSaving = true;
  artistBusy = true;
  logoWidthInput.disabled = true;
  for (const radio of alignmentRadios) radio.disabled = true;
  setStatus(`Saving ${summary} for “${artistLabel(artist)}”…`);

  try {
    const updated: Artist = {
      ...artist,
      logo: { ...artist.logo, ...patch },
    };
    const saved = await api.saveArtist(updated);
    const index = artists.findIndex((entry) => entry.id === saved.id);
    if (index >= 0) {
      artists[index] = saved;
    } else {
      artists.push(saved);
      artists.sort((left, right) => left.name.localeCompare(right.name));
    }
    renderLogoControls();
    renderSheet();
    setStatus(
      `Updated ${summary} for “${artistLabel(saved)}” — applies to every setlist showing that artist's logo.`,
      "success",
    );
  } catch (error) {
    revert();
    renderSheet();
    setStatus(`Could not save ${summary}: ${describeError(error)}`, "error");
  } finally {
    effectiveLogoSaving = false;
    artistBusy = false;
    logoWidthInput.disabled = false;
    for (const radio of alignmentRadios) radio.disabled = false;
  }
}

/**
 * Commits the Logo width slider for the artist-logo path (Feature 19).
 * Own and placeholder paths stay input-driven on `setlist.logo` (see the
 * `input` handler); the artist path updates the label live and commits here.
 */
async function commitEffectiveArtistLogoWidth(): Promise<void> {
  if (!current) return;
  if (effectiveLogoCase() !== "artist") {
    renderLogoControls();
    return;
  }
  const artist = effectiveLogoArtist();
  if (!artist) {
    renderLogoControls();
    return;
  }

  const previousWidth = artist.logo.width_mm;
  const desiredWidth = clamp(
    Number(logoWidthInput.value),
    LOGO_MIN_WIDTH_MM,
    LOGO_MAX_WIDTH_MM,
  );
  if (desiredWidth === previousWidth) {
    renderLogoControls();
    return;
  }

  const revert = (): void => {
    logoWidthInput.value = String(previousWidth);
    logoWidthOutput.textContent = `${Math.round(previousWidth)} mm`;
  };
  await commitEffectiveArtistLogo(
    { width_mm: desiredWidth },
    revert,
    `logo width to ${Math.round(desiredWidth)} mm`,
  );
}

/** Commits an alignment radio change to the displayed artist logo (Feature 25). */
async function commitEffectiveArtistLogoAlignment(alignment: LogoAlignment): Promise<void> {
  const artist = effectiveLogoArtist();
  if (!artist) {
    renderLogoControls();
    return;
  }
  const previous = artist.logo.alignment;
  if (previous === alignment) {
    renderLogoControls();
    return;
  }
  const revert = (): void => {
    for (const radio of alignmentRadios) radio.checked = radio.value === previous;
  };
  await commitEffectiveArtistLogo({ alignment }, revert, `logo alignment to ${alignment}`);
}

async function handleLogoFile(): Promise<void> {
  const file = logoFileInput.files?.[0];
  logoFileInput.value = "";
  if (!file || !current || captureGuard()) return;

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
  // Feature 19: adopt the currently displayed logo's size/alignment so the
  // replacement appears exactly where and how large the previous logo was.
  // Own → no-op; artist → copies the artist width/alignment; neither →
  // no-op (the slider already pre-sized the next own logo).
  const displayed = resolveSetlistLogo(setlist, artists);
  setlist.logo.width_mm = clamp(
    displayed.width_mm,
    LOGO_MIN_WIDTH_MM,
    LOGO_MAX_WIDTH_MM,
  );
  setlist.logo.alignment = displayed.alignment;
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
  if (!current || captureGuard()) return;

  const fileName = current.logo.file_name;
  if (!fileName && !logoPreviewIsLocal) return;

  if (fileName) {
    // Defer the delete until Save succeeds. Discarding the edit must leave the
    // saved setlist's logo file intact.
    pendingLogoRemovals.add(fileName);
  }

  current.logo.file_name = null;
  setLogoPreview(null);
  renderLogoControls();
  markDirty();
  // With no own logo the preview may now fall back to the artist's logo.
  void refreshLogoIfChanged();
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

/** The logo actually shown: setlist own → artist → placeholder config. */
function resolvedSetlistLogo(): LogoConfig | null {
  return current ? resolveSetlistLogo(current, artists) : null;
}

async function loadLogoForCurrent(): Promise<void> {
  // Clearing also invalidates any in-flight stored-logo request.
  clearLogoPreview();
  const request = logoRequestId;
  renderLogoControls();
  renderSheet();

  const fileName = resolvedSetlistLogo()?.file_name ?? null;
  if (!fileName || !backendAvailable) return;

  try {
    const url = await storedLogoUrl(fileName);
    if (request !== logoRequestId) {
      URL.revokeObjectURL(url);
      return;
    }
    logoSrc = url;
    logoPreviewIsLocal = false;
    loadedLogoFileName = fileName;
  } catch (error) {
    if (request === logoRequestId) {
      setStatus(`Could not load logo: ${describeError(error)}`, "error");
    }
  }
  renderSheet();
}

/**
 * Reloads the preview only when the resolved stored file changed, so artist
 * renames and unrelated renders do not revoke a working blob URL. A local
 * upload preview always wins until it is saved or cleared.
 */
async function refreshLogoIfChanged(): Promise<void> {
  if (logoPreviewIsLocal) return;
  const fileName = resolvedSetlistLogo()?.file_name ?? null;
  if (fileName === loadedLogoFileName) return;
  await loadLogoForCurrent();
}

function setLogoPreview(url: string | null): void {
  // A local upload preview must win over any stored-logo load still in flight.
  clearLogoPreview();
  logoSrc = url;
  logoPreviewIsLocal = url !== null;
  renderSheet();
}

function clearLogoPreview(): void {
  // Invalidate pending loads so they cannot overwrite a newer preview or a
  // different setlist's logo after this clear.
  logoRequestId += 1;
  if (logoSrc) {
    URL.revokeObjectURL(logoSrc);
    logoSrc = null;
  }
  logoPreviewIsLocal = false;
  loadedLogoFileName = null;
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
