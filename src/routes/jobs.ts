import { Router } from "express";
import { prisma } from "../db.js";
import { asyncHandler } from "../middleware/errorHandler.js";

export const jobsRouter = Router();

/** Polling progres konversi (NFR-01): parsing → persisting → rendering → done. */
jobsRouter.get("/:id", asyncHandler(async (req, res) => {
  const id = Array.isArray(req.params.id) ? String(req.params.id[0] ?? "") : String(req.params.id ?? "");
  const job = await prisma.ingestJob.findUnique({ where: { id } });
  if (!job) {
    res.status(404).json({ error: "Job tidak ditemukan." });
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
