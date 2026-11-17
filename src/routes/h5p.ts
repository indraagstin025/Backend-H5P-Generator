import multer from "multer";
import { Router } from "express";
import { validateClientPackage } from "../h5p/exporter.js";
import { authenticateToken } from "../middleware/auth.js";
import { asyncHandler } from "../middleware/errorHandler.js";
import { assertProjectOwner, assertValidUuid } from "../services/projects.js";

// Batas upload file paket .h5p diselaraskan dengan batas upload sumber materi (50 MB)
const uploadH5p = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 50 * 1024 * 1024, files: 1 },
  fileFilter: (_req, file, cb) => {
    if (!file.originalname.toLowerCase().endsWith(".h5p")) {
      cb(Object.assign(new Error("Pakai file .h5p ya."), { status: 400 }));
      return;
    }
    cb(null, true);
  },
});

export const h5pRouter = Router();

/**
 * Validasi paket .h5p rakitan browser terhadap library server (Tahap 4).
 * Body: multipart field `package` (.h5p ≤50MB).
 */
h5pRouter.post("/packages/validate", authenticateToken, uploadH5p.single("package"), asyncHandler(async (req, res) => {
  const file = (req as typeof req & { file?: Express.Multer.File }).file;
  if (!file) {
    res.status(400).json({ error: "File .h5p wajib disertakan." });
    return;
  }
  res.json({ data: await validateClientPackage(file.buffer) });
}));

/**
 * Sesi pratinjau player server (Tahap 5). Body: multipart field `package`
 * (.h5p rakitan browser ≤50MB) + opsional `title`, `projectId`.
 */
h5pRouter.post("/preview-sessions", authenticateToken, uploadH5p.single("package"), asyncHandler(async (req, res) => {
  const file = (req as typeof req & { file?: Express.Multer.File }).file;
  if (!file) {
    res.status(400).json({ error: "File .h5p wajib disertakan." });
    return;
  }
  const body = req.body as { title?: unknown; projectId?: unknown };
  let linkedProjectId: string | undefined;
  if (typeof body.projectId === "string" && body.projectId.trim()) {
    const cleanId = body.projectId.trim();
    if (!cleanId.startsWith("local-")) {
      await assertProjectOwner(cleanId, req.user!.id);
      linkedProjectId = cleanId;
    }
  }

  const { createPreviewSession } = await import("../h5p/player.js");
  res.status(201).json({
    data: await createPreviewSession(
      file.buffer,
      typeof body.title === "string" ? body.title : file.originalname.replace(/\.h5p$/i, ""),
      linkedProjectId,
    ),
  });
}));

h5pRouter.get("/player/:sessionId", asyncHandler(async (req, res) => {
  const { playerPageHtml } = await import("../h5p/player.js");
  const raw = Array.isArray(req.params.sessionId) ? String(req.params.sessionId[0]) : String(req.params.sessionId);
  const id = assertValidUuid(raw, "ID sesi");
  res.setHeader("Content-Type", "text/html; charset=utf-8");
  res.send(playerPageHtml(id));
}));

h5pRouter.post("/session/:sessionId/finish", asyncHandler(async (req, res) => {
  const { recordFinish } = await import("../h5p/player.js");
  const raw = Array.isArray(req.params.sessionId) ? String(req.params.sessionId[0]) : String(req.params.sessionId);
  const id = assertValidUuid(raw, "ID sesi");
  const body = req.body as { score?: unknown; maxScore?: unknown };
  res.status(201).json({
    data: await recordFinish(id, Number(body.score), Number(body.maxScore)),
  });
}));

h5pRouter.get("/session/:sessionId/attempts", asyncHandler(async (req, res) => {
  const { listAttempts } = await import("../h5p/player.js");
  const raw = Array.isArray(req.params.sessionId) ? String(req.params.sessionId[0]) : String(req.params.sessionId);
  const id = assertValidUuid(raw, "ID sesi");
  res.json({ data: await listAttempts(id) });
}));

/** h5p.json / content/* milik satu sesi (h5pJsonPath untuk standalone).
 * Didaftarkan SETELAH route spesifik di atas agar tidak menelannya. */
h5pRouter.get("/session/:sessionId/*splat", asyncHandler(async (req, res) => {
  const { getSessionFile } = await import("../h5p/player.js");
  const raw = Array.isArray(req.params.sessionId) ? String(req.params.sessionId[0]) : String(req.params.sessionId);
  const id = assertValidUuid(raw, "ID sesi");
  const splat = (req.params as Record<string, unknown>).splat;
  const rel = Array.isArray(splat) ? splat.join("/") : String(splat ?? "");
  const found = await getSessionFile(id, rel);
  if (!found) {
    res.status(404).json({ error: "Sesi atau file tidak ditemukan." });
    return;
  }
  res.setHeader("Content-Type", found.mime);
  if (found.data) {
    res.send(Buffer.from(found.data));
    return;
  }
  found.stream?.pipe(res);
}));

/** File library H5P (librariesPath untuk standalone). */
h5pRouter.get("/libraries/:uber/*splat", asyncHandler(async (req, res) => {
  const { getLibraryFile } = await import("../h5p/player.js");
  const uber = Array.isArray(req.params.uber) ? String(req.params.uber[0]) : String(req.params.uber);
  const splat = (req.params as Record<string, unknown>).splat;
  const file = Array.isArray(splat) ? splat.join("/") : String(splat ?? "");
  try {
    const found = await getLibraryFile(uber, file);
    res.setHeader("Content-Type", found.mime);
    if (found.size !== undefined) res.setHeader("Content-Length", String(found.size));
    found.stream.pipe(res);
  } catch (err) {
    const status =
      err instanceof Error && typeof (err as Error & { status?: unknown }).status === "number"
        ? (err as Error & { status: number }).status
        : 500;
    res.status(status).json({ error: err instanceof Error ? err.message : "Gagal membaca file library." });
  }
}));
