/** Thin typed wrappers around the Tauri commands in `src-tauri/src/commands.rs`. */

import { invoke } from "@tauri-apps/api/core";
import type { Artist, Setlist, Song } from "./types";

export const api = {
  listSongs: () => invoke<Song[]>("list_songs"),
  /**
   * Feature 20: songs must belong to an artist record on save. Pass
   * `allowUnfiled` only on the restore and artist-deletion paths, where an
   * already-stored unfiled record is re-saved as-is.
   */
  saveSong: (song: Song, allowUnfiled = false) =>
    invoke<Song>("save_song", { song, allowUnfiled }),
  deleteSong: (id: string) => invoke<void>("delete_song", { id }),

  listArtists: () => invoke<Artist[]>("list_artists"),
  saveArtist: (artist: Artist) => invoke<Artist>("save_artist", { artist }),
  deleteArtist: (id: string) => invoke<void>("delete_artist", { id }),

  listSetlists: () => invoke<Setlist[]>("list_setlists"),
  getSetlist: (id: string) => invoke<Setlist>("get_setlist", { id }),
  /**
   * Feature 20: setlists must belong to an artist record on save, same
   * allowance rule as songs. `reorder_items` needs no flag: the backend
   * re-saves the stored record with the allowance internally.
   */
  saveSetlist: (setlist: Setlist, allowUnfiled = false) =>
    invoke<Setlist>("save_setlist", { setlist, allowUnfiled }),
  deleteSetlist: (id: string) => invoke<void>("delete_setlist", { id }),
  reorderItems: (setlistId: string, from: number, to: number) =>
    invoke<Setlist>("reorder_items", { setlistId, from, to }),
  setlistDuration: (setlistId: string) =>
    invoke<number>("setlist_duration", { setlistId }),

  /**
   * Sends the bytes as a JSON number array. Tauri's default IPC path is JSON;
   * the 5 MiB backend limit keeps this acceptable for the MVP.
   */
  importLogo: (bytes: Uint8Array, fileName: string) =>
    invoke<string>("import_logo", { bytes: Array.from(bytes), fileName }),
  removeLogo: (fileName: string) => invoke<void>("remove_logo", { fileName }),
};
