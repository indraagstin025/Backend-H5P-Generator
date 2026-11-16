import cors from "cors";
import express from "express";
import path from "node:path";
import { config } from "./config.js";
import { prisma } from "./db.js";
import { startCleanupJob, stopCleanupJob } from "./jobs/cleanup.js";
import { errorHandler } from "./middleware/errorHandler.js";
import { apiRateLimiter } from "./middleware/rateLimiter.js";
import { requestLogger } from "./middleware/requestLogger.js";
import { adminRouter } from "./routes/admin.js";
import { authRouter } from "./routes/auth.js";
import { h5pRouter } from "./routes/h5p.js";
import { internalRouter } from "./routes/internal.js";
import { jobsRouter } from "./routes/jobs.js";
import { projectsRouter } from "./routes/projects.js";
import { seedInitialUsers } from "./services/auth.js";
import { ensureDirs } from "./services/storage.js";
import { createLogger } from "./utils/logger.js";

const log = createLogger("server");
const app = express();

// Sembunyikan header X-Powered-By: Express untuk mengurangi fingerprinting
app.disable("x-powered-by");

// Security headers defensif untuk seluruh respons
app.use((req, res, next) => {
  res.setHeader("X-Content-Type-Options", "nosniff");
  res.setHeader("Referrer-Policy", "strict-origin-when-cross-origin");
  res.setHeader("X-XSS-Protection", "0");
  res.setHeader("Permissions-Policy", "camera=(), microphone=(self), geolocation=()");

  // Player H5P (/api/h5p/player/* dan /h5p-vendor/*) dimuat di iframe oleh frontend;
  // endpoint lain diblokir dari framing eksternal (anti-clickjacking).
  const isPlayerFrame = req.path.startsWith("/api/h5p/player/") || req.path.startsWith("/h5p-vendor");
  if (isPlayerFrame) {
    const allowedFrames = [
      "'self'",
      ...config.corsOrigins,
      ...(!config.isProduction ? ["http://localhost:*", "http://127.0.0.1:*"] : []),
    ].join(" ");
    res.setHeader("Content-Security-Policy", `frame-ancestors ${allowedFrames}`);
  } else {
    res.setHeader("X-Frame-Options", "DENY");
    res.setHeader("Content-Security-Policy", "frame-ancestors 'none'");
  }
  next();
});

app.use(requestLogger);

// Kebijakan CORS ketat: mengizinkan origin dari CORS_ORIGINS (serta localhost saat non-produksi)
app.use(
  cors({
    origin: (origin, cb) => {
      if (!origin) {
        cb(null, true);
        return;
      }
      if (config.corsOrigins.includes(origin)) {
        cb(null, true);
        return;
      }
      if (!config.isProduction && /^https?:\/\/(localhost|127\.0\.0\.1)(:\d+)?$/i.test(origin)) {
        cb(null, true);
        return;
      }
      cb(Object.assign(new Error("Origin tidak diizinkan oleh kebijakan CORS."), { status: 403 }));
    },
    methods: ["GET", "POST", "PUT", "PATCH", "DELETE", "OPTIONS"],
    allowedHeaders: ["Content-Type", "Authorization"],
  }),
);

// Batas parser JSON dan URL-encoded dinaikkan ke 50mb untuk menampung data
// proyek presentasi dengan banyak slide dan elemen interaktif (mencegah HTTP 413)
app.use(express.json({ limit: "50mb" }));
app.use(express.urlencoded({ extended: true, limit: "50mb" }));

// Terapkan rate limiter umum untuk seluruh endpoint API
app.use("/api", apiRateLimiter);

// Aset player mandiri (h5p-standalone frame) + halaman player sesi
app.use("/h5p-vendor", express.static(path.join(process.cwd(), "public", "h5p-vendor")));

app.get("/api/health", (_request, response) => {
  response.json({ status: "ok" });
});

app.use("/api/auth", authRouter);
app.use("/api/admin", adminRouter);
app.use("/api/projects", projectsRouter);
app.use("/api/ingest-jobs", jobsRouter);
app.use("/api/h5p", h5pRouter);
app.use("/internal", internalRouter);

app.use((_request, response) => {
  response.status(404).json({ error: "Endpoint tidak ditemukan." });
});

app.use(errorHandler);

async function main(): Promise<void> {
  await ensureDirs();
  startCleanupJob();

  // Inisialisasi akun bawaan (Admin & User @gmail.com) saat server mulai
  seedInitialUsers()
    .then((res) => {
      if (res.admin.created) log.info(`Akun admin bawaan diinisialisasi: ${res.admin.email}`);
      if (res.user.created) log.info(`Akun user bawaan diinisialisasi: ${res.user.email}`);
    })
    .catch(() => {
      // Abaikan jika database belum siap saat booting pertama
    });

  const server = app.listen(config.port, () => {
    log.info(`Backend berjalan di http://localhost:${config.port}`, {
      storageDir: config.storageDir,
      logLevel: process.env.LOG_LEVEL ?? "info",
    });
  });

  const shutdown = async () => {
    log.info("Mematikan backend…");
    stopCleanupJob();
    server.close();
    await prisma.$disconnect();
    process.exit(0);
  };
  process.on("SIGINT", () => void shutdown());
  process.on("SIGTERM", () => void shutdown());
  process.on("unhandledRejection", (reason) => {
    log.error("Promise rejection tanpa handler", reason);
  });
}

main().catch((err) => {
  log.error("Gagal menjalankan backend", err);
  process.exit(1);
});
