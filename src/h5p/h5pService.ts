import { promises as fs } from "node:fs";
import path from "node:path";
import {
  H5PConfig,
  H5PEditor,
  LibraryManager,
  PackageExporter,
  fsImplementations,
} from "@lumieducation/h5p-server";
import type { ContentId, IUser } from "@lumieducation/h5p-server";
import { config } from "../config.js";

/** Pengguna sistem untuk operasi tanpa login (MVP jaringan internal). */
export const systemUser: IUser = {
  id: "system",
  name: "Generator",
  email: "generator@local",
  type: "local",
};

export interface H5PInstances {
  editor: H5PEditor;
  exporter: PackageExporter;
  libraryManager: LibraryManager;
  contentStorage: InstanceType<typeof fsImplementations.FileContentStorage>;
  libraryStorage: InstanceType<typeof fsImplementations.FileLibraryStorage>;
}

let cached: H5PInstances | null = null;

/**
 * Sinkronkan berkas patch kustom H5P.CoursePresentation-1.26 (rotasi elemen,
 * tombol pop-up transparan & timer auto-hide) dari h5p-patches/ ke storage/h5p/libraries/.
 */
export async function applyCoursePresentationPatches(): Promise<boolean> {
  const patchDir = path.resolve(process.cwd(), "h5p-patches", "H5P.CoursePresentation-1.26");
  const targetDir = path.join(config.storageDir, "h5p", "libraries", "H5P.CoursePresentation-1.26");
  try {
    const [patchStat, targetStat] = await Promise.all([
      fs.stat(patchDir).catch(() => null),
      fs.stat(targetDir).catch(() => null),
    ]);
    if (!patchStat?.isDirectory() || !targetStat?.isDirectory()) return false;
    await fs.cp(patchDir, targetDir, { recursive: true, force: true });
    return true;
  } catch {
    return false;
  }
}

/** Singleton Lumi (init malas — pertama kali export/seed dipanggil). */
export async function getH5P(): Promise<H5PInstances> {
  if (cached) return cached;
  const base = path.join(config.storageDir, "h5p");
  const librariesDir = path.join(base, "libraries");
  const contentDir = path.join(base, "content");
  const tempDir = path.join(base, "temp");
  await fs.mkdir(librariesDir, { recursive: true });
  await fs.mkdir(contentDir, { recursive: true });
  await fs.mkdir(tempDir, { recursive: true });
  await applyCoursePresentationPatches();

  const h5pConfig = new H5PConfig();
  const cacheFile = path.join(base, "cache.json");
  try {
    await fs.access(cacheFile);
  } catch {
    await fs.writeFile(cacheFile, "{}");
  }
  const cache = await fsImplementations.JsonStorage.create(cacheFile);
  const libraryStorage = new fsImplementations.FileLibraryStorage(librariesDir);
  const contentStorage = new fsImplementations.FileContentStorage(contentDir);
  const tempStorage = new fsImplementations.DirectoryTemporaryFileStorage(tempDir);
  const editor = new H5PEditor(cache, h5pConfig, libraryStorage, contentStorage, tempStorage);
  const libraryManager = new LibraryManager(libraryStorage);
  const exporter = new PackageExporter(libraryManager, contentStorage, {
    exportMaxContentPathLength: 255,
  });
  cached = { editor, exporter, libraryManager, contentStorage, libraryStorage };
  return cached;
}

/** Versi terinstal tertinggi untuk satu machineName (dipakai rakit h5p.json). */
export async function installedLibraryVersion(
  machineName: string,
): Promise<{ machineName: string; majorVersion: number; minorVersion: number } | null> {
  const { libraryManager } = await getH5P();
  const installed = (await libraryManager.listInstalledLibraries(machineName)) as Record<
    string,
    Array<{ machineName: string; majorVersion: number; minorVersion: number }>
  >;
  const mine = Object.values(installed ?? {})
    .flat()
    .filter((v) => v?.machineName === machineName);
  if (mine.length === 0) return null;
  mine.sort((a, b) => b.majorVersion - a.majorVersion || b.minorVersion - a.minorVersion);
  const top = mine[0];
  return { machineName: top.machineName, majorVersion: top.majorVersion, minorVersion: top.minorVersion };
}
