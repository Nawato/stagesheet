/** Thin typed wrappers around the Tauri commands in `src-tauri/src/commands.rs`. */

import { invoke } from "@tauri-apps/api/core";
import type { Setlist, Song } from "./types";

export const api = {
  listSongs: () => invoke<Song[]>("list_songs"),
  saveSong: (song: Song) => invoke<Song>("save_song", { song }),
  deleteSong: (id: string) => invoke<void>("delete_song", { id }),

  listSetlists: () => invoke<Setlist[]>("list_setlists"),
  getSetlist: (id: string) => invoke<Setlist>("get_setlist", { id }),
  saveSetlist: (setlist: Setlist) => invoke<Setlist>("save_setlist", { setlist }),
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
