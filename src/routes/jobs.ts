import { Router } from "express";
import { prisma } from "../db.js";
import { authenticateToken } from "../middleware/auth.js";
import { asyncHandler } from "../middleware/errorHandler.js";
import { assertValidUuid } from "../services/projects.js";

export const jobsRouter = Router();

/** Polling progres konversi (NFR-01): parsing → persisting → rendering → done. */
jobsRouter.get("/:id", authenticateToken, asyncHandler(async (req, res) => {
  const rawId = Array.isArray(req.params.id) ? String(req.params.id[0] ?? "") : String(req.params.id ?? "");
  const id = assertValidUuid(rawId, "ID job");
  const job = await prisma.ingestJob.findUnique({
    where: { id },
    include: { project: { select: { userId: true } } },
  });
  if (!job) {
    res.status(404).json({ error: "Job tidak ditemukan." });
    return;
  }
  if (!job.project || job.project.userId !== req.user!.id) {
    res.status(403).json({ error: "Anda tidak memiliki izin untuk mengakses proses ini." });
    return;
  }
  const slideCount = job.projectId
    ? await prisma.slide.count({ where: { projectId: job.projectId } })
    : 0;
  res.json({
    data: {
      id: job.id,
      projectId: job.projectId,
      fileName: job.fileName,
      status: job.status,
      progress: job.progress,
      message: job.message,
      slideCount,
    },
  });
}));
