/**
 * Shared artist-resolution helpers.
 *
 * Feature 14 resolves song display names and artist counts; Feature 20 reuses
 * the same resolved identity for scope membership and the Unfiled bucket, and
 * Feature 16 reuses `resolveSetlistLogo` for the setlist → artist →
 * placeholder logo chain. (The retired library Artist filter and Artists
 * section took their buckets through this module; both are gone since
 * Features 20 and 23.)
 */

import type { Artist, LogoConfig, Setlist, Song } from "./types";

export function findArtistById(
  artists: readonly Artist[],
  artistId: string | null | undefined,
): Artist | null {
  if (!artistId) return null;
  return artists.find((artist) => artist.id === artistId) ?? null;
}

/**
 * Resolved artist name: the record name while `artist_id` points at a live
 * record, otherwise (only when `artist_id` is null) the legacy `artist`
 * text, otherwise blank.
 *
 * A dangling id (record gone) resolves as unfiled: no legacy-text fallback,
 * so the display is blank and the song lands in the Unfiled scope (Feature
 * 25 contract change — songs and setlists alike). Renaming a record
 * therefore updates every id-backed song without rewriting the snapshot.
 * Search, sorting, and every library display use this helper so
 * legacy and record-backed songs behave identically.
 */
export function resolveArtistName(
  song: Pick<Song, "artist" | "artist_id">,
  artists: readonly Artist[],
): string {
  const rawId = song.artist_id;
  const id = typeof rawId === "string" ? rawId.trim() : rawId;
  if (id) {
    return findArtistById(artists, id)?.name.trim() ?? "";
  }

  return song.artist?.trim() ?? "";
}

/**
 * Resolves a song to the artist record it counts as.
 *
 * Id-backed songs resolve by id only: a dangling id is unfiled (null), with
 * no legacy-text fallback (Feature 25). Legacy-text grouping applies only to
 * records with no id: same trimmed, case-insensitive name as a live record
 * groups under it until adoption. Unmatched legacy text and songs without
 * text have no record.
 */
export function resolveArtistForSong(
  song: Pick<Song, "artist" | "artist_id">,
  artists: readonly Artist[],
): Artist | null {
  const rawId = song.artist_id;
  const id = typeof rawId === "string" ? rawId.trim() : rawId;
  if (id) return findArtistById(artists, id) ?? null;

  const text = song.artist?.trim().toLocaleLowerCase();
  if (!text) return null;

  return (
    artists.find((artist) => artist.name.trim().toLocaleLowerCase() === text) ?? null
  );
}

/**
 * Setlist logo resolution chain: the setlist's own logo when set, otherwise its
 * artist's logo when set, otherwise the setlist's placeholder config (`null`
 * file name). Stored for Feature 16's preview/print/export wiring; Feature 14
 * does not change the sheet or print path.
 */
export function resolveSetlistLogo(
  setlist: Pick<Setlist, "logo" | "artist_id">,
  artists: readonly Artist[],
): LogoConfig {
  if (setlist.logo.file_name) return setlist.logo;

  const artist = findArtistById(artists, setlist.artist_id);
  if (artist?.logo.file_name) return artist.logo;

  return setlist.logo;
}
