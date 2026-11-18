import { constants as fsConstants, createReadStream, promises as fs } from "node:fs";
import path from "node:path";
import type { NextFunction, Request, Response } from "express";
import { Router } from "express";
import { prisma } from "../db.js";
import { runIngestJob } from "../converter/pipeline.js";
import { exportProjectPackage } from "../h5p/exporter.js";
import { authenticateToken } from "../middleware/auth.js";
import { asyncHandler, discardUploaded } from "../middleware/errorHandler.js";
import { uploadMediaAsset, uploadSource } from "../middleware/upload.js";
import { ingestUpload } from "../services/ingest.js";
import { projectDir } from "../services/storage.js";
import { validateAndSaveMediaAsset } from "../services/uploadValidator.js";
import { createLogger } from "../utils/logger.js";
import { config } from "../config.js";
import {
  assertProjectOwner,
  assertValidUuid,
  createProject,
  deleteProject,
  duplicateProject,
  getProject,
  listProjects,
  saveProjectSlides,
  updateProject,
} from "../services/projects.js";

const log = createLogger("ingest");

export const projectsRouter = Router();

function paramId(value: unknown): string {
  if (Array.isArray(value)) return String(value[0] ?? "");
  return String(value ?? "");
}

const requireProjectOwnerParam = asyncHandler(async (req: Request, _res: Response, next: NextFunction) => {
  await assertProjectOwner(paramId(req.params.id), req.user!.id);
  next();
});

// CRUD proyek (terisolasi ketat per userId milik user login)
projectsRouter.get("/", authenticateToken, asyncHandler(async (req, res) => {
  res.json({ data: await listProjects(req.user!.id) });
}));

projectsRouter.post("/", authenticateToken, asyncHandler(async (req, res) => {
  const project = await createProject({
    title: typeof req.body?.title === "string" ? req.body.title : "",
    aspect: typeof req.body?.aspect === "string" ? req.body.aspect : undefined,
    userId: req.user!.id,
  });
  res.status(201).json({ data: project });
}));

projectsRouter.get("/media", authenticateToken, asyncHandler(async (req, res) => {
  const projects = await prisma.project.findMany({ where: { userId: req.user!.id }, select: { id: true } });
  const libraryDir = path.join(config.storageDir, "users", req.user!.id, "media");
  await fs.mkdir(libraryDir, { recursive: true });
  await Promise.all(projects.map(async ({ id }) => {
    const dir = path.join(projectDir(id), "assets");
    const entries = await fs.readdir(dir, { withFileTypes: true }).catch((err: NodeJS.ErrnoException) => {
      if (err.code === "ENOENT") return [];
      throw err;
    });
    await Promise.all(entries.filter((entry) => entry.isFile() && /^media-[a-z0-9-]+\.(png|jpe?g|gif|webp|svg|mp4|m4v|webm|ogv)$/i.test(entry.name)).map(async (entry) => {
      const source = path.join(dir, entry.name);
      const target = path.join(libraryDir, entry.name);
      await fs.copyFile(source, target, fsConstants.COPYFILE_EXCL).catch((err: NodeJS.ErrnoException) => {
        if (err.code !== "EEXIST") throw err;
      });
      const [sourceStat, targetStat] = await Promise.all([fs.stat(source), fs.stat(target)]);
      if (sourceStat.mtimeMs < targetStat.mtimeMs) await fs.utimes(target, sourceStat.atime, sourceStat.mtime);
    }));
  }));
  const entries = await fs.readdir(libraryDir, { withFileTypes: true });
  const media = await Promise.all(entries.filter((entry) => entry.isFile() && /^media-[a-z0-9-]+\.(png|jpe?g|gif|webp|svg|mp4|m4v|webm|ogv)$/i.test(entry.name)).map(async (entry) => ({
      fileName: entry.name,
      assetUrl: `/projects/media/${entry.name}`,
      kind: /\.(png|jpe?g|gif|webp|svg)$/i.test(entry.name) ? "image" : "video",
      uploadedAt: (await fs.stat(path.join(libraryDir, entry.name))).mtimeMs,
  })));
  media.sort((a, b) => b.uploadedAt - a.uploadedAt || a.fileName.localeCompare(b.fileName));
  res.json({ data: media });
}));

projectsRouter.post("/media", authenticateToken, uploadMediaAsset.single("file"), asyncHandler(async (req, res) => {
  const file = (req as Request & { file?: Express.Multer.File }).file;
  if (!file) { res.status(400).json({ error: "File media wajib disertakan." }); return; }
  try {
    if (!/\.(png|jpe?g|gif|webp|svg|mp4|m4v|webm|ogv)$/i.test(file.originalname)) {
      await discardUploaded(req);
      res.status(400).json({ error: "Hanya gambar atau video yang diperbolehkan." });
      return;
    }
    const saved = await validateAndSaveMediaAsset(file.path, file.originalname, path.join(config.storageDir, "users", req.user!.id, "media"));
    res.status(201).json({ data: { fileName: saved.filename, assetUrl: `/projects/media/${saved.filename}` } });
  } catch (err) {
    await discardUploaded(req);
    throw err;
  }
}));

projectsRouter.get("/media/:filename", authenticateToken, asyncHandler(async (req, res) => {
  const filename = paramId(req.params.filename);
  if (!/^media-[a-z0-9-]+\.(png|jpe?g|gif|webp|svg|mp4|m4v|webm|ogv)$/i.test(filename)) {
    res.status(400).json({ error: "Nama berkas tidak valid." });
    return;
  }
  const abs = path.join(config.storageDir, "users", req.user!.id, "media", filename);
  const stat = await fs.stat(abs).catch((err: NodeJS.ErrnoException) => {
    if (err.code === "ENOENT") return null;
    throw err;
  });
  if (!stat?.isFile()) { res.status(404).json({ error: "Media tidak ditemukan." }); return; }
  const ext = path.extname(filename).slice(1).toLowerCase();
  res.setHeader("Content-Type", ASSET_MIME[ext]);
  res.setHeader("X-Content-Type-Options", "nosniff");
  res.setHeader("Cache-Control", "private, no-store");
  if (ext === "svg") res.setHeader("Content-Security-Policy", "default-src 'none'; sandbox");
  res.setHeader("Content-Length", String(stat.size));
  createReadStream(abs).pipe(res);
}));

projectsRouter.post("/:id/media/:filename", authenticateToken, requireProjectOwnerParam, asyncHandler(async (req, res) => {
  const filename = paramId(req.params.filename);
  if (!/^media-[a-z0-9-]+\.(png|jpe?g|gif|webp|svg|mp4|m4v|webm|ogv)$/i.test(filename)) {
    res.status(400).json({ error: "Nama berkas tidak valid." });
    return;
  }
  const source = path.join(config.storageDir, "users", req.user!.id, "media", filename);
  const assetsDir = path.join(projectDir(paramId(req.params.id)), "assets");
  const stat = await fs.stat(source).catch((err: NodeJS.ErrnoException) => {
    if (err.code === "ENOENT") return null;
    throw err;
  });
  if (!stat?.isFile()) { res.status(404).json({ error: "Media tidak ditemukan." }); return; }
  await fs.mkdir(assetsDir, { recursive: true });
  await fs.copyFile(source, path.join(assetsDir, filename), fsConstants.COPYFILE_EXCL).catch((err: NodeJS.ErrnoException) => {
    if (err.code !== "EEXIST") throw err;
  });
  res.json({ data: { asset: `assets/${filename}`, assetUrl: `/projects/${paramId(req.params.id)}/assets/${filename}`, fileName: filename } });
}));

projectsRouter.get("/:id", authenticateToken, asyncHandler(async (req, res) => {
  const project = await getProject(paramId(req.params.id), req.user!.id);
  if (!project) {
    res.status(404).json({ error: "Proyek tidak ditemukan." });
    return;
  }
  res.json({ data: project });
}));

projectsRouter.patch("/:id", authenticateToken, asyncHandler(async (req, res) => {
  const updated = await updateProject(paramId(req.params.id), req.user!.id, {
    title: req.body?.title,
    settings: req.body?.settings,
  });
  res.json({ data: updated });
}));

projectsRouter.delete("/:id", authenticateToken, asyncHandler(async (req, res) => {
  await deleteProject(paramId(req.params.id), req.user!.id);
  res.status(204).end();
}));

projectsRouter.post("/:id/duplicate", authenticateToken, asyncHandler(async (req, res) => {
  const copy = await duplicateProject(paramId(req.params.id), req.user!.id);
  res.status(201).json({ data: copy });
}));

// Tahap 3: upload → 202 + pipeline async (polling GET /api/ingest-jobs/:id)
projectsRouter.post("/ingest", authenticateToken, uploadSource.single("sourceFile"), asyncHandler(async (req, res) => {
  const result = await ingestUpload(
    req,
    typeof req.body?.title === "string" ? req.body.title : "",
    req.user!.id,
  );
  const jobId = (result.job as { id: string }).id;
  void runIngestJob(jobId).catch((err) => log.error(`Job ingest ${jobId} gagal`, err));
  res.status(202).json({ data: result });
}));

// Simpan pembaruan slide dari Studio Editor: PUT /api/projects/:id/slides
projectsRouter.put("/:id/slides", authenticateToken, asyncHandler(async (req, res) => {
  const projectId = paramId(req.params.id);
  const raw = Array.isArray(req.body) ? req.body : Array.isArray(req.body?.slides) ? req.body.slides : null;
  if (!raw) {
    res.status(400).json({ error: "Format data slide tidak valid. Harapkan array slide." });
    return;
  }
  const saved = await saveProjectSlides(projectId, req.user!.id, raw);
  res.json({ data: saved });
}));

projectsRouter.get("/:id/slides", authenticateToken, asyncHandler(async (req, res) => {
  const projectId = paramId(req.params.id);
  await assertProjectOwner(projectId, req.user!.id);
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

// Upload media elemen Studio (gambar/audio/video): POST /api/projects/:id/assets
projectsRouter.post(
  "/:id/assets",
  authenticateToken,
  requireProjectOwnerParam,
  uploadMediaAsset.single("file"),
  asyncHandler(async (req, res) => {
    const file = (req as Request & { file?: Express.Multer.File }).file;
    if (!file) {
      res.status(400).json({ error: "File media wajib disertakan." });
      return;
    }
    const projectId = paramId(req.params.id);
    const assetsDir = path.join(projectDir(projectId), "assets");
    try {
      const saved = await validateAndSaveMediaAsset(file.path, file.originalname, assetsDir);
      const libraryDir = path.join(config.storageDir, "users", req.user!.id, "media");
      await fs.mkdir(libraryDir, { recursive: true });
      if (saved.mime.startsWith("image/") || saved.mime.startsWith("video/")) {
        await fs.copyFile(path.join(assetsDir, saved.filename), path.join(libraryDir, saved.filename), fsConstants.COPYFILE_EXCL);
      }
      res.status(201).json({
        data: {
          asset: saved.asset,
          assetUrl: `/projects/${projectId}/assets/${saved.filename}`,
          fileName: path.basename(file.originalname),
          mime: saved.mime,
          size: saved.size,
        },
      });
    } catch (err) {
      await discardUploaded(req);
      throw err;
    }
  }),
);

// Aset slide (latar + media Studio): GET /api/projects/:id/assets/:filename
const ASSET_MIME: Record<string, string> = {
  jpg: "image/jpeg",
  jpeg: "image/jpeg",
  png: "image/png",
  gif: "image/gif",
  webp: "image/webp",
  svg: "image/svg+xml",
  mp3: "audio/mpeg",
  wav: "audio/wav",
  ogg: "audio/ogg",
  m4a: "audio/mp4",
  mp4: "video/mp4",
  m4v: "video/mp4",
  webm: "video/webm",
  ogv: "video/ogg",
};

projectsRouter.get("/:id/assets/:filename", asyncHandler(async (req, res) => {
  const projectId = assertValidUuid(paramId(req.params.id), "ID proyek");
  const raw = paramId(req.params.filename);
  if (!/^[A-Za-z0-9._-]+$/.test(raw) || raw.includes("..")) {
    res.status(400).json({ error: "Nama berkas tidak valid." });
    return;
  }
  const projectExists = await prisma.project.findUnique({
    where: { id: projectId },
    select: { id: true },
  });
  if (!projectExists) {
    res.status(404).json({ error: "Proyek tidak ditemukan." });
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
    res.setHeader("X-Content-Type-Options", "nosniff");
    res.setHeader("Cross-Origin-Resource-Policy", "cross-origin");
    if (ext === "svg") {
      res.setHeader("Content-Security-Policy", "default-src 'none'; sandbox");
    }
    res.setHeader("Cache-Control", "public, max-age=86400");
    res.setHeader("Content-Length", String(stat.size));
    createReadStream(abs).pipe(res);
  } catch {
    res.status(404).json({ error: "Berkas aset tidak ditemukan." });
  }
}));

// Skor pratinjau server untuk satu proyek (Tahap 5)
projectsRouter.get("/:id/attempts", authenticateToken, asyncHandler(async (req, res) => {
  const projectId = paramId(req.params.id);
  await assertProjectOwner(projectId, req.user!.id);
  const { listProjectAttempts } = await import("../h5p/player.js");
  res.json({ data: await listProjectAttempts(projectId) });
}));

// Ekspor .h5p via Lumi (Tahap 4): rakit + validasi dependensi + unduh
projectsRouter.get("/:id/export-report", authenticateToken, asyncHandler(async (req, res) => {
  const projectId = paramId(req.params.id);
  await assertProjectOwner(projectId, req.user!.id);
  const { buildExportReport } = await import("../h5p/exporter.js");
  res.json({ data: await buildExportReport(projectId) });
}));

projectsRouter.post("/:id/export", authenticateToken, asyncHandler(async (req, res) => {
  const projectId = paramId(req.params.id);
  await assertProjectOwner(projectId, req.user!.id);
  try {
    const result = await exportProjectPackage(projectId);
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
      error: status === 500 ? "Ekspor gagal." : err instanceof Error ? err.message : "Ekspor gagal.",
      ...(issues ? { issues } : {}),
    });
  }
}));

// Player server untuk satu proyek (Tahap 5): ekspor → sesi → redirect
projectsRouter.get("/:id/player", authenticateToken, asyncHandler(async (req, res) => {
  const projectId = paramId(req.params.id);
  await assertProjectOwner(projectId, req.user!.id);
  const { createPreviewSession } = await import("../h5p/player.js");
  try {
    const result = await exportProjectPackage(projectId);
    const session = await createPreviewSession(result.buffer, "", projectId);
    res.redirect(302, session.playerUrl);
  } catch (err) {
    const status =
      err instanceof Error && typeof (err as Error & { status?: unknown }).status === "number"
        ? (err as Error & { status: number }).status
        : 500;
    res.status(status).json({
      error: status === 500 ? "Player gagal disiapkan." : err instanceof Error ? err.message : "Player gagal disiapkan.",
    });
  }
}));
