import path from "node:path";

function num(name: string, fallback: number): number {
  const raw = process.env[name];
  const parsed = raw === undefined ? NaN : Number(raw);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

const isProduction = process.env.NODE_ENV === "production";

function resolveJwtSecret(): string {
  const envSecret = process.env.JWT_SECRET?.trim() ?? "";
  if (isProduction) {
    if (envSecret.length < 32) {
      throw new Error(
        "FATAL SECURITY ERROR: JWT_SECRET wajib diisi minimal 32 karakter pada lingkungan produksi (NODE_ENV=production).",
      );
    }
    return envSecret;
  }
  return envSecret || "dev-only-h5p-jwt-secret-key-min-32-chars-change-for-prod";
}

function parseCorsOrigins(): string[] {
  const raw = process.env.CORS_ORIGINS ?? "";
  return raw
    .split(",")
    .map((s) => s.trim())
    .filter((s) => s.length > 0);
}

export const config = {
  isProduction,
  port: num("PORT", 3000),
  databaseUrl: process.env.DATABASE_URL ?? "postgresql://postgres@localhost:5432/H5P_Generator?schema=public",
  storageDir: path.resolve(process.env.STORAGE_DIR ?? "./storage"),
  maxUploadBytes: num("MAX_UPLOAD_BYTES", 50 * 1024 * 1024),
  maxSlidesPerProject: num("MAX_SLIDES_PER_PROJECT", 60),
  tempTtlMs: num("TEMP_TTL_HOURS", 24) * 3600 * 1000,
  cleanupIntervalMs: num("CLEANUP_INTERVAL_MS", 3600 * 1000),
  corsOrigins: parseCorsOrigins(),
  jwt: {
    secret: resolveJwtSecret(),
    expiresIn: process.env.JWT_EXPIRES_IN || "7d",
  },
  google: {
    clientId: process.env.GOOGLE_CLIENT_ID || "",
    clientSecret: process.env.GOOGLE_CLIENT_SECRET || "",
  },
  onlyoffice: {
    // Kosong = render nonaktif (latar pending). Contoh dev via Docker:
    // ONLYOFFICE_URL=http://localhost:8080 ONLYOFFICE_FILE_URL_BASE=http://host.docker.internal:3000
    url: (process.env.ONLYOFFICE_URL ?? "").replace(/\/+$/, ""),
    jwt: process.env.ONLYOFFICE_JWT ?? "",
    fileUrlBase: (process.env.ONLYOFFICE_FILE_URL_BASE ?? `http://localhost:${num("PORT", 3000)}`).replace(/\/+$/, ""),
    timeoutMs: num("ONLYOFFICE_TIMEOUT_MS", 300_000),
  },
} as const;
