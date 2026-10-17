import { prisma } from "../db.js";
import { attachSourceFile, createProject } from "./projects.js";
import { discardUploaded } from "../middleware/errorHandler.js";
import type { Request } from "express";

type UploadedFile = Express.Multer.File;

/**
 * Tahap 3: terima file → proyek + job "parsing".
 * Route memicu runIngestJob async; klien polling GET /api/ingest-jobs/:id.
 */
export async function ingestUpload(req: Request, title: string) {
  const file = (req as Request & { file?: UploadedFile }).file;
  if (!file) throw Object.assign(new Error("File .pptx/.pdf wajib disertakan."), { status: 400 });
  try {
    const project = await createProject({ title: title || file.originalname.replace(/\.[^.]+$/, "") });
    const full = await attachSourceFile(project.id, file.path, file.originalname);
    const job = await prisma.ingestJob.create({
      data: {
        projectId: project.id,
        fileName: file.originalname,
        status: "parsing",
        progress: 5,
        message: "Antrean konversi.",
      },
    });
    return {
      project: full,
      job: { id: job.id, status: job.status, progress: job.progress, message: job.message },
      file: { name: file.originalname, size: file.size },
    };
  } catch (err) {
    await discardUploaded(req);
    throw err;
  }
}
