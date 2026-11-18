import type { Setlist } from "./types";

/** Formats seconds as `m:ss`, or `h:mm:ss` once past an hour. */
export function formatDuration(totalSecs: number | null | undefined): string {
  if (totalSecs == null || !Number.isFinite(totalSecs) || totalSecs < 0) {
    return "—";
  }

  const secs = Math.round(totalSecs);
  const hours = Math.floor(secs / 3600);
  const minutes = Math.floor((secs % 3600) / 60);
  const seconds = secs % 60;

  if (hours > 0) {
    return `${hours}:${String(minutes).padStart(2, "0")}:${String(seconds).padStart(2, "0")}`;
  }

  return `${minutes}:${String(seconds).padStart(2, "0")}`;
}

/** Compact human runtime used in the sheet footer, e.g. `1 h 12 min`. */
export function formatRuntime(totalSecs: number): string {
  const minutes = Math.round(totalSecs / 60);
  if (minutes < 60) {
    return `${minutes} min`;
  }

  const hours = Math.floor(minutes / 60);
  const rest = minutes % 60;
  return rest === 0 ? `${hours} h` : `${hours} h ${rest} min`;
}

/**
 * Break length for the sheet, editor meta, preview, print, and export.
 *
 * Under a minute keeps second precision (`11 sec`); whole minutes stay exactly
 * as before (`10 min`); mixed values show both (`1 min 5 sec`). Totals keep
 * using `formatRuntime`.
 */
export function formatBreakDuration(totalSecs: number | null | undefined): string {
  if (totalSecs == null || !Number.isFinite(totalSecs) || totalSecs < 0) {
    return "—";
  }

  const secs = Math.round(totalSecs);
  const minutes = Math.floor(secs / 60);
  const rest = secs % 60;
  if (minutes === 0) {
    return `${secs} sec`;
  }

  return rest === 0 ? `${minutes} min` : `${minutes} min ${rest} sec`;
}

/** Parses `m:ss`, `h:mm:ss`, or plain seconds. Returns null for empty input. */
export function parseDuration(value: string): number | null {
  const trimmed = value.trim();
  if (!trimmed) {
    return null;
  }

  if (trimmed.includes(":")) {
    const parts = trimmed.split(":");
    // Empty colon parts are rejected, like the break parser: "4:" and ":30"
    // are typos, not 4:00 and 0:30.
    if (parts.length > 3 || parts.some((part) => !/^\d+$/.test(part))) {
      return null;
    }

    const numbers = parts.map((part) => Number(part));
    if (numbers.some((part) => !Number.isFinite(part))) {
      return null;
    }

    return numbers.reduce((total, part) => total * 60 + part, 0);
  }

  if (!/^\d+$/.test(trimmed)) {
    return null;
  }

  return Number(trimmed);
}

/** Renders `4:05` for an `mm:ss` input field. */
export function durationInputValue(totalSecs: number | null): string {
  if (totalSecs == null) {
    return "";
  }

  const minutes = Math.floor(totalSecs / 60);
  const seconds = totalSecs % 60;
  return `${minutes}:${String(seconds).padStart(2, "0")}`;
}

export function setlistDurationSecs(setlist: Setlist): number {
  return setlist.items.reduce((total, item) => {
    return total + ("Song" in item ? (item.Song.duration_secs ?? 0) : item.Break.duration_secs);
  }, 0);
}

/** Displays `YYYY-MM-DD` without timezone drift. */
export function formatGigDate(date: string | null): string | null {
  if (!date) {
    return null;
  }

  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(date);
  if (!match) {
    return date;
  }

  const year = Number(match[1]);
  const month = Number(match[2]) - 1;
  const day = Number(match[3]);
  const parsed = new Date(Date.UTC(year, month, day));
  if (
    Number.isNaN(parsed.getTime()) ||
    parsed.getUTCFullYear() !== year ||
    parsed.getUTCMonth() !== month ||
    parsed.getUTCDate() !== day
  ) {
    return date;
  }

  return new Intl.DateTimeFormat(undefined, {
    weekday: "short",
    day: "numeric",
    month: "short",
    year: "numeric",
    timeZone: "UTC",
  }).format(parsed);
}
