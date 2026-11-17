/**
 * One-file backup and restore for the whole library.
 *
 * The backup is a versioned JSON envelope:
 *
 * ```json
 * { "schema_version": 1, "exported_at": "…", "songs": [], "setlists": [] }
 * ```
 *
 * Restore is deliberately frontend-only: it reuses `list_songs`/`list_setlists`
 * to build the envelope and `save_song`/`save_setlist` to write records back, so
 * the existing Rust validation and serde migrations stay the single authority.
 * Files are read/written through the dialog-scoped `fs` permission (opening or
 * saving a path extends the `$APPDATA/stagesheet/**` scope to that one file);
 * no new commands and no capability widening.
 *
 * Logos are not embedded in v1: setlists keep `logo.file_name`, which still
 * works when restoring on the same device. On a new device the file is missing,
 * the preview shows the logo placeholder, and the logo must be re-imported
 * manually. A later schema version can embed the bytes.
 */

import { open, save } from "@tauri-apps/plugin-dialog";
import { readFile, writeFile } from "@tauri-apps/plugin-fs";
import { downloadDir, join } from "@tauri-apps/api/path";

import { DEFAULT_LOGO_WIDTH_MM, withPageModeDefaults, withSheetDefaults } from "./types";
import type {
  BreakItem,
  LogoAlignment,
  LogoConfig,
  Setlist,
  SetlistItem,
  SheetOptions,
  Song,
} from "./types";

/** Envelope version written by this build. Bump when the payload shape changes. */
export const BACKUP_SCHEMA_VERSION = 1;

export interface BackupEnvelope {
  schema_version: number;
  exported_at: string;
  songs: Song[];
  setlists: Setlist[];
}

export interface BackupRecords {
  songs: Song[];
  setlists: Setlist[];
}

export interface ParsedBackup {
  envelope: BackupEnvelope;
  /** Human-readable reasons for records dropped during structural validation. */
  skipped: string[];
}

export type BackupExportOutcome =
  | { status: "canceled" }
  | {
      status: "exported";
      path: string;
      songs: number;
      setlists: number;
    };

export type BackupReadOutcome =
  | { status: "canceled" }
  | { status: "loaded"; path: string; backup: ParsedBackup };

/** Builds the envelope that is written to disk. */
export function createBackupEnvelope(
  records: BackupRecords,
  now: Date = new Date(),
): BackupEnvelope {
  return {
    schema_version: BACKUP_SCHEMA_VERSION,
    exported_at: now.toISOString(),
    songs: records.songs,
    setlists: records.setlists,
  };
}

/**
 * Prompts for a destination and writes the envelope. The caller is responsible
 * for loading current records and saving any dirty editor state first.
 */
export async function exportBackup(records: BackupRecords): Promise<BackupExportOutcome> {
  const now = new Date();
  const path = await save({
    title: "Back up StageSheet library",
    defaultPath: await defaultBackupPath(now),
    canCreateDirectories: true,
    filters: [{ name: "StageSheet backup", extensions: ["json"] }],
  });
  if (!path) return { status: "canceled" };

  const envelope = createBackupEnvelope(records, now);
  const text = `${JSON.stringify(envelope, null, 2)}\n`;
  await writeFile(path, new TextEncoder().encode(text));

  return {
    status: "exported",
    path,
    songs: envelope.songs.length,
    setlists: envelope.setlists.length,
  };
}

/**
 * Prompts for a backup file, reads it, and validates the envelope. Structural
 * problems throw with a user-facing message; individual malformed records are
 * collected in `skipped` so the caller can report them before restoring.
 */
export async function readBackupFile(): Promise<BackupReadOutcome> {
  const selected = await open({
    title: "Restore StageSheet backup",
    multiple: false,
    directory: false,
    filters: [{ name: "StageSheet backup", extensions: ["json"] }],
  });
  const path = Array.isArray(selected) ? selected[0] : selected;
  if (!path) return { status: "canceled" };

  const bytes = await readFile(path);
  const text = decodeUtf8(bytes);
  return { status: "loaded", path, backup: parseBackupEnvelope(text) };
}

/** Parses and structurally validates a backup envelope. Exported for reuse. */
export function parseBackupEnvelope(text: string): ParsedBackup {
  let value: unknown;
  try {
    value = JSON.parse(text);
  } catch {
    throw new Error("Not a StageSheet backup: the file is not valid JSON.");
  }

  if (!isRecord(value)) {
    throw new Error("Not a StageSheet backup: expected a JSON object.");
  }

  const version = value.schema_version;
  if (typeof version !== "number" || !Number.isInteger(version) || version < 1) {
    throw new Error("Not a StageSheet backup: missing or invalid schema_version.");
  }
  if (version > BACKUP_SCHEMA_VERSION) {
    throw new Error(
      `This backup uses schema ${version}, but this StageSheet version supports up to ${BACKUP_SCHEMA_VERSION}. Update StageSheet to restore it.`,
    );
  }
  if (!Array.isArray(value.songs)) {
    throw new Error("Not a StageSheet backup: songs must be an array.");
  }
  if (!Array.isArray(value.setlists)) {
    throw new Error("Not a StageSheet backup: setlists must be an array.");
  }

  // Schema 1 is the first versioned format. Future migrations belong here,
  // keyed by the source version, before the per-record normalizers run.
  const migrated = migrateEnvelope(version, value);

  const skipped: string[] = [];
  const songs: Song[] = [];
  migrated.songs.forEach((raw, index) => {
    try {
      songs.push(normalizeSong(raw));
    } catch (error) {
      skipped.push(`song ${index + 1} (${describeError(error)})`);
    }
  });

  const setlists: Setlist[] = [];
  migrated.setlists.forEach((raw, index) => {
    try {
      setlists.push(normalizeSetlist(raw));
    } catch (error) {
      skipped.push(`setlist ${index + 1} (${describeError(error)})`);
    }
  });

  return {
    envelope: {
      schema_version: version,
      exported_at: typeof value.exported_at === "string" ? value.exported_at : "",
      songs,
      setlists,
    },
    skipped,
  };
}

// ---------------------------------------------------------------------------
// Envelope migration
// ---------------------------------------------------------------------------

interface MigratedRecords {
  songs: unknown[];
  setlists: unknown[];
}

/**
 * Maps an older envelope to the current payload shape. Structural validation
 * already ran, so `version` is 1..=BACKUP_SCHEMA_VERSION. Older formats do not
 * exist yet; the switch is the extension point for the next schema bump.
 */
function migrateEnvelope(
  version: number,
  value: Record<string, unknown>,
): MigratedRecords {
  switch (version) {
    case 1:
      return {
        songs: value.songs as unknown[],
        setlists: value.setlists as unknown[],
      };
    default:
      // Unreachable: versions outside 1..=BACKUP_SCHEMA_VERSION are rejected
      // before this runs. Kept explicit so a future bump cannot silently fall
      // through with an unmigrated payload.
      throw new Error(`Unsupported backup schema ${version}.`);
  }
}

// ---------------------------------------------------------------------------
// Record normalization (serde-compatible defaults)
// ---------------------------------------------------------------------------

function normalizeSong(value: unknown): Song {
  if (!isRecord(value)) throw new Error("song must be an object");

  return {
    id: requireString(value.id, "id"),
    title: requireString(value.title, "title"),
    artist: optionalText(value.artist),
    bpm: optionalInteger(value.bpm, 0xffff, "bpm"),
    key: optionalText(value.key),
    tuning: optionalText(value.tuning),
    duration_secs: optionalInteger(value.duration_secs, 0xffffffff, "duration_secs"),
    notes: optionalText(value.notes),
  };
}

function normalizeSetlist(value: unknown): Setlist {
  if (!isRecord(value)) throw new Error("setlist must be an object");

  const rawItems = value.items ?? [];
  if (!Array.isArray(rawItems)) throw new Error("items must be an array");
  const items = rawItems.map((raw, index) => {
    try {
      return normalizeItem(raw);
    } catch (error) {
      throw new Error(`item ${index + 1}: ${describeError(error)}`);
    }
  });

  // The first schema draft used `logo_config`; accept it like the Rust alias.
  const rawLogo = value.logo ?? value.logo_config ?? {};
  if (!isRecord(rawLogo)) throw new Error("logo must be an object");

  return {
    id: requireString(value.id, "id"),
    title: requireString(value.title, "title"),
    venue: optionalText(value.venue),
    date: optionalText(value.date),
    items,
    logo: normalizeLogo(rawLogo),
    sheet_options: normalizeSheetOptions(value.sheet_options),
    page_mode: withPageModeDefaults(
      typeof value.page_mode === "string" ? value.page_mode : null,
    ),
    // Rust defaults missing timestamps to now; mirror that here so the typed
    // payload always carries strings.
    created_at: optionalTimestamp(value.created_at),
    updated_at: optionalTimestamp(value.updated_at),
  };
}

function normalizeItem(value: unknown): SetlistItem {
  if (!isRecord(value)) throw new Error("must be an object");

  const hasSong = value.Song !== undefined;
  const hasBreak = value.Break !== undefined;
  if (hasSong && hasBreak) throw new Error("cannot be both a song and a break");
  if (hasSong) return { Song: normalizeSong(value.Song) };
  if (hasBreak) return { Break: normalizeBreak(value.Break) };
  throw new Error("missing Song or Break payload");
}

function normalizeBreak(value: unknown): BreakItem {
  if (!isRecord(value)) throw new Error("break must be an object");

  const duration = value.duration_mins;
  if (
    typeof duration !== "number" ||
    !Number.isInteger(duration) ||
    duration < 0 ||
    duration > 0xffffffff
  ) {
    throw new Error("invalid duration_mins");
  }

  return {
    duration_mins: duration,
    note: optionalText(value.note),
    label: optionalText(value.label),
  };
}

function normalizeLogo(value: Record<string, unknown>): LogoConfig {
  const width = value.width_mm;
  if (
    width !== undefined &&
    width !== null &&
    (typeof width !== "number" || !Number.isFinite(width))
  ) {
    throw new Error("invalid logo width_mm");
  }

  return {
    file_name: optionalText(value.file_name),
    width_mm: typeof width === "number" ? width : DEFAULT_LOGO_WIDTH_MM,
    alignment: normalizeAlignment(value.alignment),
  };
}

function normalizeAlignment(value: unknown): LogoAlignment {
  if (value === undefined || value === null) return "Center";
  if (typeof value !== "string") throw new Error("invalid logo alignment");

  switch (value.trim().toLowerCase()) {
    case "left":
      return "Left";
    case "center":
    case "centre":
      return "Center";
    case "right":
      return "Right";
    default:
      throw new Error(`unknown logo alignment \`${value}\``);
  }
}

function normalizeSheetOptions(value: unknown): SheetOptions {
  if (value === undefined || value === null) return withSheetDefaults(null);
  if (!isRecord(value)) throw new Error("sheet_options must be an object");

  const read = (key: keyof SheetOptions): boolean => {
    const raw = value[key];
    if (raw === undefined || raw === null) return true;
    if (typeof raw !== "boolean") {
      throw new Error(`sheet_options.${key} must be a boolean`);
    }
    return raw;
  };

  return {
    show_key: read("show_key"),
    show_tuning: read("show_tuning"),
    show_tempo: read("show_tempo"),
    show_duration: read("show_duration"),
    show_comment: read("show_comment"),
  };
}

// ---------------------------------------------------------------------------
// Small helpers
// ---------------------------------------------------------------------------

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function requireString(value: unknown, field: string): string {
  if (typeof value !== "string" || !value.trim()) {
    throw new Error(`missing or empty ${field}`);
  }
  return value;
}

function optionalText(value: unknown): string | null {
  return typeof value === "string" && value.trim() ? value : null;
}

function optionalInteger(value: unknown, max: number, field: string): number | null {
  if (value === undefined || value === null) return null;
  if (
    typeof value !== "number" ||
    !Number.isInteger(value) ||
    value < 0 ||
    value > max
  ) {
    throw new Error(`invalid ${field}`);
  }
  return value;
}

function optionalTimestamp(value: unknown): string {
  return typeof value === "string" && value.trim()
    ? value
    : new Date().toISOString();
}

function decodeUtf8(bytes: Uint8Array): string {
  try {
    return new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  } catch {
    throw new Error("Not a StageSheet backup: the file is not UTF-8 text.");
  }
}

async function defaultBackupPath(now: Date): Promise<string> {
  const pad = (value: number): string => String(value).padStart(2, "0");
  const stamp = [
    now.getFullYear(),
    pad(now.getMonth() + 1),
    pad(now.getDate()),
    "-",
    pad(now.getHours()),
    pad(now.getMinutes()),
  ].join("");
  const fileName = `stagesheet-backup-${stamp}.json`;

  try {
    return await join(await downloadDir(), fileName);
  } catch {
    // The dialog still opens in a sensible folder with a bare file name.
    return fileName;
  }
}

function describeError(error: unknown): string {
  if (typeof error === "string") return error;
  if (error instanceof Error) return error.message;
  return String(error);
}
