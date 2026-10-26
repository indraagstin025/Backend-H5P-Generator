import { config } from "../config.js";
import { cleanupTemp } from "../services/storage.js";
import { createLogger } from "../utils/logger.js";

const log = createLogger("cleanup");
let timer: NodeJS.Timeout | null = null;

/** Pembersih tmp berkala (NFR-06: TTL 24 jam). */
export function startCleanupJob(): void {
  if (timer) return;
  const run = async () => {
    try {
      const removed = await cleanupTemp();
      if (removed > 0) log.info(`${removed} direktori tmp kedaluwarsa dihapus.`);
      const { purgeExpiredSessions } = await import("../h5p/player.js");
      const purged = await purgeExpiredSessions();
      if (purged > 0) log.info(`${purged} sesi pratinjau kedaluwarsa dihapus.`);
    } catch (err) {
      log.error("Gagal membersihkan data kedaluwarsa", err);
    }
  };
  // Sapu pertama 10 detik setelah start (agar startup tetap cepat),
  // berikutnya sesuai interval.
  setTimeout(run, 10_000);
  timer = setInterval(run, config.cleanupIntervalMs);
  timer.unref?.();
}

export function stopCleanupJob(): void {
  if (timer) clearInterval(timer);
  timer = null;
}
