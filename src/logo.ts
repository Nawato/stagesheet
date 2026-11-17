/** Reads a stored logo from `<appDataDir>/stagesheet/logos/` as a blob URL. */

import { appDataDir, join } from "@tauri-apps/api/path";
import { readFile } from "@tauri-apps/plugin-fs";

const MIME_TYPES: Record<string, string> = {
  png: "image/png",
  jpg: "image/jpeg",
  jpeg: "image/jpeg",
  svg: "image/svg+xml",
};

const SAFE_FILE_NAME = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;

export async function storedLogoUrl(fileName: string): Promise<string> {
  if (!SAFE_FILE_NAME.test(fileName) || fileName.includes("..")) {
    throw new Error("invalid stored logo file name");
  }

  const dataDir = await appDataDir();
  const path = await join(dataDir, "stagesheet", "logos", fileName);
  const bytes = await readFile(path);
  const extension = fileName.split(".").pop()?.toLowerCase() ?? "";
  const type = MIME_TYPES[extension] ?? "application/octet-stream";
  return URL.createObjectURL(new Blob([bytes], { type }));
}
