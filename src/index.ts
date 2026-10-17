import cors from "cors";
import express from "express";
import path from "node:path";
import { config } from "./config.js";
import { prisma } from "./db.js";
import { startCleanupJob, stopCleanupJob } from "./jobs/cleanup.js";
import { errorHandler } from "./middleware/errorHandler.js";
import { h5pRouter } from "./routes/h5p.js";
import { internalRouter } from "./routes/internal.js";
import { jobsRouter } from "./routes/jobs.js";
import { projectsRouter } from "./routes/projects.js";
import { ensureDirs } from "./services/storage.js";

const app = express();

app.use(cors());
app.use(express.json({ limit: "1mb" }));
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
    console.log(`Backend running at http://localhost:${config.port}`);
  });

  const shutdown = async () => {
    console.log("Shutting down…");
    stopCleanupJob();
    server.close();
    await prisma.$disconnect();
    process.exit(0);
  };
  process.on("SIGINT", () => void shutdown());
  process.on("SIGTERM", () => void shutdown());
}

main().catch((err) => {
  console.error("Gagal menjalankan backend:", err);
  process.exit(1);
});
