/** Reads stored logos from `<appDataDir>/stagesheet/logos/`. */

import { appDataDir, join } from "@tauri-apps/api/path";
import { readFile } from "@tauri-apps/plugin-fs";

const MIME_TYPES: Record<string, string> = {
  png: "image/png",
  jpg: "image/jpeg",
  jpeg: "image/jpeg",
  svg: "image/svg+xml",
};

const SAFE_FILE_NAME = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;

interface StoredLogo {
  bytes: Uint8Array<ArrayBuffer>;
  type: string;
}

/** Reads the stored bytes through the existing scoped fs capability. */
async function readStoredLogo(fileName: string): Promise<StoredLogo> {
  if (!SAFE_FILE_NAME.test(fileName) || fileName.includes("..")) {
    throw new Error("invalid stored logo file name");
  }

  const dataDir = await appDataDir();
  const path = await join(dataDir, "stagesheet", "logos", fileName);
  const bytes = await readFile(path);
  const extension = fileName.split(".").pop()?.toLowerCase() ?? "";
  const type = MIME_TYPES[extension] ?? "application/octet-stream";
  return { bytes, type };
}

/** Blob URL for the live preview (never used by the raster exporter). */
export async function storedLogoUrl(fileName: string): Promise<string> {
  const { bytes, type } = await readStoredLogo(fileName);
  return URL.createObjectURL(new Blob([bytes], { type }));
}

/**
 * `data:` URL for export only.
 *
 * `html-to-image` fetches an `<img>` source while cloning the sheet. A blob URL
 * is blocked by the production `connect-src` and was unreliable even when
 * allowed, so the exporter hands it the same stored bytes as a data URL. This
 * does not widen the fs capability or the CSP: the image is already loaded via
 * the scoped `readFile` call above.
 */
export async function storedLogoDataUrl(fileName: string): Promise<string> {
  const { bytes, type } = await readStoredLogo(fileName);
  return `data:${type};base64,${toBase64(bytes)}`;
}

/** Chunked `btoa`; the backend caps logos at 5 MiB. */
function toBase64(bytes: Uint8Array): string {
  let binary = "";
  const chunkSize = 0x8000;
  for (let offset = 0; offset < bytes.length; offset += chunkSize) {
    binary += String.fromCharCode(...bytes.subarray(offset, offset + chunkSize));
  }
  return btoa(binary);
}
