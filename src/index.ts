import cors from "cors";
import express from "express";
import path from "node:path";
import { config } from "./config.js";
import { prisma } from "./db.js";
import { startCleanupJob, stopCleanupJob } from "./jobs/cleanup.js";
import { errorHandler } from "./middleware/errorHandler.js";
import { requestLogger } from "./middleware/requestLogger.js";
import { h5pRouter } from "./routes/h5p.js";
import { internalRouter } from "./routes/internal.js";
import { jobsRouter } from "./routes/jobs.js";
import { projectsRouter } from "./routes/projects.js";
import { ensureDirs } from "./services/storage.js";
import { createLogger } from "./utils/logger.js";

const log = createLogger("server");
const app = express();

app.use(requestLogger);
app.use(cors());

// Batas parser JSON dan URL-encoded dinaikkan ke 50mb untuk menampung data
// proyek presentasi dengan banyak slide dan elemen interaktif (mencegah HTTP 413)
app.use(express.json({ limit: "50mb" }));
app.use(express.urlencoded({ extended: true, limit: "50mb" }));

// Aset player mandiri (h5p-standalone frame) + halaman player sesi
app.use("/h5p-vendor", express.static(path.join(process.cwd(), "public", "h5p-vendor")));

app.get("/api/health", (_request, response) => {
  response.json({ status: "ok" });
});

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
