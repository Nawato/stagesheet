/**
 * Shared artist-resolution helpers.
 *
 * Feature 14 resolves song display names and artist counts; Feature 15 groups
 * songs into library artist-filter buckets with the same identity, and
 * Feature 16 reuses `resolveSetlistLogo` for the setlist → artist →
 * placeholder logo chain.
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
 * record, otherwise the legacy `artist` text, otherwise blank.
 *
 * Renaming a record therefore updates every id-backed song without rewriting
 * the snapshot. Search, sorting, and every library display use this helper so
 * legacy and record-backed songs behave identically.
 */
export function resolveArtistName(
  song: Pick<Song, "artist" | "artist_id">,
  artists: readonly Artist[],
): string {
  const record = findArtistById(artists, song.artist_id);
  const recordName = record?.name.trim();
  if (recordName) return recordName;

  return song.artist?.trim() ?? "";
}

/**
 * Resolves a song to the artist record it counts as.
 *
 * Id-backed songs resolve by id. Legacy-text songs are grouped under a record
 * with the same trimmed, case-insensitive name when one exists, so old
 * libraries do not show every artist as empty before adoption. Unmatched legacy
 * text and songs without text have no record.
 */
export function resolveArtistForSong(
  song: Pick<Song, "artist" | "artist_id">,
  artists: readonly Artist[],
): Artist | null {
  const byId = findArtistById(artists, song.artist_id);
  if (byId) return byId;

  const text = song.artist?.trim().toLocaleLowerCase();
  if (!text) return null;

  return (
    artists.find((artist) => artist.name.trim().toLocaleLowerCase() === text) ?? null
  );
}

/**
 * Library artist-filter value for songs that have no artist identity at all:
 * no record (by id or resolved name) and no legacy text.
 */
export const NO_ARTIST_FILTER = "none";

/**
 * The library artist-filter bucket a song belongs to: an artist record id,
 * `NO_ARTIST_FILTER` when it has no artist identity, or `null` when it only
 * carries unmatched legacy text.
 *
 * Counts share this helper through `libraryArtistCounts()`, so the
 * Artists-section and landing labels always match the rows a scope shows.
 * Unmatched non-empty legacy text is deliberately unbucketed.
 */
export function libraryArtistBucket(
  song: Pick<Song, "artist" | "artist_id">,
  artists: readonly Artist[],
): string | null {
  const record = resolveArtistForSong(song, artists);
  if (record) return record.id;
  return song.artist?.trim() ? null : NO_ARTIST_FILTER;
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
