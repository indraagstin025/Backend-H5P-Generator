import path from "node:path";

function num(name: string, fallback: number): number {
  const raw = process.env[name];
  const parsed = raw === undefined ? NaN : Number(raw);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

export const config = {
  port: num("PORT", 3000),
  databaseUrl: process.env.DATABASE_URL ?? "file:../storage/h5pgen.db",
  storageDir: path.resolve(process.env.STORAGE_DIR ?? "./storage"),
  maxUploadBytes: num("MAX_UPLOAD_BYTES", 50 * 1024 * 1024),
  maxSlidesPerProject: num("MAX_SLIDES_PER_PROJECT", 60),
  tempTtlMs: num("TEMP_TTL_HOURS", 24) * 3600 * 1000,
  cleanupIntervalMs: num("CLEANUP_INTERVAL_MS", 3600 * 1000),
  onlyoffice: {
    // Kosong = render nonaktif (latar pending). Contoh dev via Docker:
    // ONLYOFFICE_URL=http://localhost:8080 ONLYOFFICE_FILE_URL_BASE=http://host.docker.internal:3000
    url: (process.env.ONLYOFFICE_URL ?? "").replace(/\/+$/, ""),
    jwt: process.env.ONLYOFFICE_JWT ?? "",
    fileUrlBase: (process.env.ONLYOFFICE_FILE_URL_BASE ?? `http://localhost:${num("PORT", 3000)}`).replace(/\/+$/, ""),
    timeoutMs: num("ONLYOFFICE_TIMEOUT_MS", 300_000),
  },
} as const;
