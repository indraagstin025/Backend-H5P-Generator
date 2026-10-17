import { promises as fs } from "node:fs";
import path from "node:path";
import { config } from "../config.js";

export function projectDir(projectId: string): string {
  return path.join(config.storageDir, "projects", projectId);
}

export function tmpRoot(): string {
  return path.join(config.storageDir, "tmp");
}

export async function ensureDirs(): Promise<void> {
  await fs.mkdir(path.join(config.storageDir, "projects"), { recursive: true });
  await fs.mkdir(tmpRoot(), { recursive: true });
}

/** Hapus seluruh file milik satu proyek (dipakai saat DELETE). */
export async function removeProjectFiles(projectId: string): Promise<void> {
  await fs.rm(projectDir(projectId), { recursive: true, force: true });
}

/**
 * Bersihkan direktori tmp yang lebih tua dari TTL (NFR-06).
 * Mengembalikan jumlah direktori yang dihapus (untuk log/job).
 */
export async function cleanupTemp(now = Date.now()): Promise<number> {
  const root = tmpRoot();
  let removed = 0;
  let entries;
  try {
    entries = await fs.readdir(root, { withFileTypes: true });
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return 0;
    throw err;
  }
  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    const full = path.join(root, entry.name);
    try {
      const stat = await fs.stat(full);
      if (now - stat.mtimeMs > config.tempTtlMs) {
        await fs.rm(full, { recursive: true, force: true });
        removed += 1;
      }
    } catch {
      // File hilang di tengah jalan (race) — lanjutkan entri berikutnya.
    }
  }
  return removed;
}
