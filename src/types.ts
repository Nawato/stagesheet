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
  /** Printed width in millimetres, constrained to 10..=80 by the backend. */
  width_mm: number;
  alignment: LogoAlignment;
}

export interface Song {
  id: string;
  title: string;
  artist: string | null;
  bpm: number | null;
  key: string | null;
  /** Free-text tuning label, e.g. `E Std` or `Drop D`; trimmed, max 24 chars. */
  tuning: string | null;
  duration_secs: number | null;
  notes: string | null;
}

/** The `Break` payload of a setlist item. */
export interface BreakItem {
  duration_mins: number;
  note: string | null;
  /** Optional heading such as `Intermission`; `null`/missing renders `Break`. */
  label?: string | null;
}

/** Serde's default externally tagged enum representation. */
export type SetlistItem = { Song: Song } | { Break: BreakItem };

export interface Setlist {
  id: string;
  title: string;
  venue: string | null;
  /** `YYYY-MM-DD`, or null when no gig date is set. */
  date: string | null;
  items: SetlistItem[];
  logo: LogoConfig;
  /** RFC 3339 timestamps. */
  created_at: string;
  updated_at: string;
}

export const LOGO_MIN_WIDTH_MM = 10;
export const LOGO_MAX_WIDTH_MM = 80;
export const DEFAULT_LOGO_WIDTH_MM = 40;

/** Mirrors the Rust validation bounds in `models.rs`. */
export const MAX_BREAK_MINS = 600;
export const MAX_BREAK_LABEL_CHARS = 24;
export const MAX_COMMENT_CHARS = 140;
