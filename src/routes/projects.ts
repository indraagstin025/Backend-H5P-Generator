import { createReadStream } from "node:fs";
import { promises as fs } from "node:fs";
import path from "node:path";
import { Router } from "express";
import { prisma } from "../db.js";
import { runIngestJob } from "../converter/pipeline.js";
import { exportProjectPackage } from "../h5p/exporter.js";
import { asyncHandler } from "../middleware/errorHandler.js";
import { uploadSource } from "../middleware/upload.js";
import { ingestUpload } from "../services/ingest.js";
import { projectDir } from "../services/storage.js";
import { createLogger } from "../utils/logger.js";
import {
  createProject,
  deleteProject,
  getProject,
  listProjects,
  renameProject,
} from "../services/projects.js";

const log = createLogger("ingest");

export const projectsRouter = Router();

function paramId(value: unknown): string {
  if (Array.isArray(value)) return String(value[0] ?? "");
  return String(value ?? "");
}

// CRUD proyek
projectsRouter.get("/", asyncHandler(async (_req, res) => {
  res.json({ data: await listProjects() });
}));

projectsRouter.post("/", asyncHandler(async (req, res) => {
  const project = await createProject({ title: String(req.body?.title ?? ""), aspect: req.body?.aspect });
  res.status(201).json({ data: project });
}));

projectsRouter.get("/:id", asyncHandler(async (req, res) => {
  const project = await getProject(paramId(req.params.id));
  if (!project) {
    res.status(404).json({ error: "Proyek tidak ditemukan." });
    return;
  }
  res.json({ data: project });
}));

projectsRouter.patch("/:id", asyncHandler(async (req, res) => {
  res.json({ data: await renameProject(paramId(req.params.id), String(req.body?.title ?? "")) });
}));

projectsRouter.delete("/:id", asyncHandler(async (req, res) => {
  await deleteProject(paramId(req.params.id));
  res.status(204).end();
}));

// Tahap 3: upload → 202 + pipeline async (polling GET /api/ingest-jobs/:id)
projectsRouter.post("/ingest", uploadSource.single("sourceFile"), asyncHandler(async (req, res) => {
  const result = await ingestUpload(req, String(req.body?.title ?? ""));
  const jobId = (result.job as { id: string }).id;
  void runIngestJob(jobId).catch((err) => log.error(`Job ingest ${jobId} gagal`, err));
  res.status(202).json({ data: result });
}));

// Slide hasil konversi: struktur siap Tahap 3 (latar presisi bila renderer ada)
projectsRouter.get("/:id/slides", asyncHandler(async (req, res) => {
  const projectId = paramId(req.params.id);
  const rows = await prisma.slide.findMany({
    where: { projectId },
    orderBy: { order: "asc" },
  });
  res.json({
    data: rows.map((r) => {
      const parsed = JSON.parse(r.dataJson as string) as {
        background?: string | null;
        elements?: Array<{ asset?: string } & Record<string, unknown>>;
      } & Record<string, unknown>;
      const background = (parsed.background as string | null) ?? null;
      const backgroundUrl = background
        ? `/projects/${projectId}/assets/${background.split("/").pop()}`
        : null;
      const elements = (parsed.elements ?? []).map((el) => {
        const asset = (el as { asset?: unknown }).asset;
        if (typeof asset !== "string" || asset.length === 0) return el;
        return { ...el, assetUrl: `/projects/${projectId}/assets/${asset.split("/").pop()}` };
      });
      return {
        id: r.id,
        order: r.order,
        title: r.title,
        ...parsed,
        background,
        backgroundUrl,
        elements,
      };
    }),
  });
}));

// Aset slide (latar OnlyOffice + media ekstraksi): GET /api/projects/:id/assets/:filename
const ASSET_MIME: Record<string, string> = {
  jpg: "image/jpeg",
  jpeg: "image/jpeg",
  png: "image/png",
  gif: "image/gif",
  webp: "image/webp",
  svg: "image/svg+xml",
  mp3: "audio/mpeg",
  wav: "audio/wav",
  m4a: "audio/mp4",
  mp4: "video/mp4",
};

projectsRouter.get("/:id/assets/:filename", asyncHandler(async (req, res) => {
  const projectId = paramId(req.params.id);
  const raw = paramId(req.params.filename);
  if (!/^[A-Za-z0-9._-]+$/.test(raw) || raw.includes("..")) {
    res.status(400).json({ error: "Nama berkas tidak valid." });
    return;
  }
  const base = path.join(projectDir(projectId), "assets");
  const abs = path.normalize(path.join(base, raw));
  if (!abs.startsWith(path.normalize(base + path.sep))) {
    res.status(400).json({ error: "Nama berkas tidak valid." });
    return;
  }
  try {
    const stat = await fs.stat(abs);
    if (!stat.isFile()) throw new Error("bukan file");
    const ext = raw.split(".").pop()?.toLowerCase() ?? "";
    res.setHeader("Content-Type", ASSET_MIME[ext] ?? "application/octet-stream");
    res.setHeader("Cache-Control", "public, max-age=86400");
    res.setHeader("Content-Length", String(stat.size));
    createReadStream(abs).pipe(res);
  } catch {
    res.status(404).json({ error: "Gambar latar tidak ketemu." });
  }
}));

// Skor pratinjau server untuk satu proyek (Tahap 5)
projectsRouter.get("/:id/attempts", asyncHandler(async (req, res) => {
  const { listProjectAttempts } = await import("../h5p/player.js");
  res.json({ data: await listProjectAttempts(paramId(req.params.id)) });
}));

// Ekspor .h5p via Lumi (Tahap 4): rakit + validasi dependensi + unduh
projectsRouter.get("/:id/export-report", asyncHandler(async (req, res) => {
  const { buildExportReport } = await import("../h5p/exporter.js");
  res.json({ data: await buildExportReport(paramId(req.params.id)) });
}));

projectsRouter.post("/:id/export", asyncHandler(async (req, res) => {
  try {
    const result = await exportProjectPackage(paramId(req.params.id));
    res.setHeader("Content-Type", "application/zip");
    res.setHeader("Content-Disposition", `attachment; filename="${result.filename}"`);
    res.send(result.buffer);
  } catch (err) {
    const status =
      err instanceof Error && typeof (err as Error & { status?: unknown }).status === "number"
        ? (err as Error & { status: number }).status
        : 500;
    const issues =
      err instanceof Error ? (err as Error & { issues?: string[] }).issues : undefined;
    res.status(status).json({
      error: err instanceof Error ? err.message : "Ekspor gagal.",
      ...(issues ? { issues } : {}),
    });
  }
}));

// Player server untuk satu proyek (Tahap 5): ekspor → sesi → redirect
projectsRouter.get("/:id/player", asyncHandler(async (req, res) => {
  const { createPreviewSession } = await import("../h5p/player.js");
  try {
    const result = await exportProjectPackage(paramId(req.params.id));
    const session = await createPreviewSession(result.buffer, "", paramId(req.params.id));
    res.redirect(302, session.playerUrl);
  } catch (err) {
    const status =
      err instanceof Error && typeof (err as Error & { status?: unknown }).status === "number"
        ? (err as Error & { status: number }).status
        : 500;
    res.status(status).json({ error: err instanceof Error ? err.message : "Player gagal disiapkan." });
  }
}));
