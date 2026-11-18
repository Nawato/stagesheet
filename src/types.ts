/**
 * TypeScript mirror of `src-tauri/src/models.rs`.
 *
 * Field names are snake_case because they are the serialized Rust field names
 * and also the on-disk JSON format. Keep both files in sync.
 */

export type LogoAlignment = "Left" | "Center" | "Right";

export interface LogoConfig {
  /** Plain file name inside `<appDataDir>/stagesheet/logos/`, or null. */
  file_name: string | null;
  /** Display width in millimetres, constrained to 10..=80 by the backend.
   * Setlist geometry is live; the artist copy is render-dead (Feature 29). */
  width_mm: number;
  alignment: LogoAlignment;
}

export interface Song {
  id: string;
  title: string;
  /**
   * Artist display snapshot. New songs assigned to a record store its current
   * name here as a fallback; legacy free-text values stay untouched.
   */
  artist: string | null;
  /**
   * Artist record reference. Older files omit the field (loads as null); a
   * dangling id resolves as unfiled with no legacy-text fallback (blank
   * display, Unfiled scope membership).
   */
  artist_id: string | null;
  bpm: number | null;
  key: string | null;
  /** Free-text tuning label, e.g. `E Std` or `Drop D`; trimmed, max 24 chars. */
  tuning: string | null;
  duration_secs: number | null;
  notes: string | null;
}

/** A managed artist with an optional logo. Mirrors `Artist` in `models.rs`. */
export interface Artist {
  id: string;
  /** Display name; trimmed, non-empty (enforced by Rust on save). */
  name: string;
  /** Same file pool/rules as setlists; width/alignment are render-dead (Feature 29). */
  logo: LogoConfig;
}

/** Normalizes a missing or blank artist record id to `null`. */
export function normalizeArtistId(value: string | null | undefined): string | null {
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  return trimmed ? trimmed : null;
}

/** The `Break` payload of a setlist item. */
export interface BreakItem {
  /** Break length in seconds, 0..=MAX_BREAK_SECS. */
  duration_secs: number;
  note: string | null;
  /** Optional heading such as `Intermission`; `null`/missing renders `Break`. */
  label?: string | null;
}

/** Serde's default externally tagged enum representation. */
export type SetlistItem = { Song: Song } | { Break: BreakItem };

/**
 * Raw break payload as found in older setlist files and backups, before
 * Feature 17 renamed `duration_mins` to `duration_secs`.
 */
export interface RawBreakItem {
  duration_secs?: number | null;
  duration_mins?: number | null;
  note?: string | null;
  label?: string | null;
}

/**
 * Normalizes a break payload that bypassed Rust serde (backup restore).
 * `duration_secs` wins; legacy `duration_mins` is converted × 60 with the same
 * u32 saturation the Rust migration uses, so an oversized old value still
 * loads and fails validation on save instead of disappearing at load time.
 */
export function withBreakDefaults(raw: RawBreakItem): BreakItem {
  const durationSecs =
    raw.duration_secs ??
    (raw.duration_mins != null ? Math.min(raw.duration_mins * 60, 0xffffffff) : null);
  if (durationSecs === null) {
    throw new Error("missing break duration");
  }

  return {
    duration_secs: durationSecs,
    note: raw.note ?? null,
    label: raw.label ?? null,
  };
}

/** Applies `withBreakDefaults` to every break in a setlist item list. */
export function normalizeSetlistItems(items: readonly SetlistItem[]): SetlistItem[] {
  return items.map((item) =>
    "Break" in item ? { Break: withBreakDefaults(item.Break) } : item,
  );
}

/** Which optional blocks the printable sheet shows. Mirrors `SheetOptions`. */
export interface SheetOptions {
  show_key: boolean;
  show_tuning: boolean;
  /** Tempo (BPM) column. */
  show_tempo: boolean;
  /** Duration (song duration) column. */
  show_duration: boolean;
  /** Song and break comments; also gates the break label. */
  show_comment: boolean;
}

export const DEFAULT_SHEET_OPTIONS: Readonly<SheetOptions> = Object.freeze({
  show_key: true,
  show_tuning: true,
  show_tempo: true,
  show_duration: true,
  show_comment: true,
});

/**
 * Fills a possibly missing/partial `sheet_options` object with the all-visible
 * defaults. Old setlist files load exactly as before the toggles existed.
 */
export function withSheetDefaults(
  options?: Partial<SheetOptions> | null,
): SheetOptions {
  return {
    show_key: options?.show_key ?? true,
    show_tuning: options?.show_tuning ?? true,
    show_tempo: options?.show_tempo ?? true,
    show_duration: options?.show_duration ?? true,
    show_comment: options?.show_comment ?? true,
  };
}

/** How the printable sheet paginates. Mirrors `PageMode` in `models.rs`. */
export type PageMode = "Single" | "Multiple";

export const DEFAULT_PAGE_MODE: PageMode = "Single";

/**
 * Normalizes a possibly missing page mode. Old setlist files carry no
 * `page_mode`, and those must keep the single-A4 cap they were printed with.
 */
export function withPageModeDefaults(mode?: PageMode | string | null): PageMode {
  return mode === "Multiple" ? "Multiple" : "Single";
}

export interface Setlist {
  id: string;
  title: string;
  venue: string | null;
  /** `YYYY-MM-DD`, or null when no gig date is set. */
  date: string | null;
  items: SetlistItem[];
  logo: LogoConfig;
  /** Missing in pre-Feature-4 files; use `withSheetDefaults` when loading. */
  sheet_options?: SheetOptions;
  /** Missing in pre-Feature-5 files; use `withPageModeDefaults` when loading. */
  page_mode?: PageMode;
  /**
   * The setlist's own artist record reference; `null` means unfiled.
   * Normalize with `normalizeArtistId` when loading/cloning/restoring.
   * Missing/blank loads as null; a dangling id resolves as unfiled
   * (Unfiled scope, `File under…` row, excluded from the landing assign
   * offer) while the backend still accepts `Some` on save.
   */
  artist_id?: string | null;
  /** RFC 3339 timestamps. */
  created_at: string;
  updated_at: string;
}

export const LOGO_MIN_WIDTH_MM = 10;
export const LOGO_MAX_WIDTH_MM = 80;
export const DEFAULT_LOGO_WIDTH_MM = 40;

/** Mirrors the Rust validation bounds in `models.rs`. */
export const MAX_BREAK_SECS = 36_000;
export const MAX_BREAK_LABEL_CHARS = 24;
export const MAX_COMMENT_CHARS = 140;
