import { prisma } from "../db.js";
import { attachSourceFile, createProject } from "./projects.js";
import { discardUploaded } from "../middleware/errorHandler.js";
import { ensureNoDuplicateProject, validateSourceFileContent } from "./uploadValidator.js";
import type { Request } from "express";

type UploadedFile = Express.Multer.File;

/**
 * Tahap 3: validasi ketat berkas → terima file → proyek + job "parsing".
 * Route memicu runIngestJob async; klien polling GET /api/ingest-jobs/:id.
 */
export async function ingestUpload(req: Request, title: string) {
  const file = (req as Request & { file?: UploadedFile }).file;
  if (!file) throw Object.assign(new Error("File .pptx/.pdf wajib disertakan."), { status: 400 });

  try {
    // 1. Validasi ketat biner: periksa Magic Bytes asli dan tolak PDF/PPTX yang dikunci kata sandi
    const { hash } = await validateSourceFileContent(file.path, file.originalname);

    // 2. Validasi duplikasi: tolak jika nama berkas atau isi berkas (SHA-256) sudah ada di sistem
    await ensureNoDuplicateProject(file.originalname, hash);

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
