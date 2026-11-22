import path from "node:path";
import { prisma } from "../db.js";
import { assertProjectOwner } from "./projects.js";

export type ExportPackageFormat = "H5P" | "SCORM 1.2";

export interface RecordExportInput {
  userId: string;
  projectId?: string | null;
  title: string;
  format: ExportPackageFormat;
  sizeKb: number;
  sourceFileName?: string | null;
}

export interface ValidatedExportPayload {
  projectId: string | null;
  title: string;
  format: ExportPackageFormat;
  sizeKb: number;
  sourceFileName: string | null;
}

const ALLOWED_EXPORT_FORMATS = new Set<ExportPackageFormat>(["H5P", "SCORM 1.2"]);
const MAX_TITLE_LENGTH = 200;
const MAX_SOURCE_FILENAME_LENGTH = 255;
const MAX_EXPORT_SIZE_KB = 1_048_576; // 1 GB

function httpError(status: number, message: string): Error & { status: number } {
  return Object.assign(new Error(message), { status });
}

export function validateExportInput(raw: unknown): ValidatedExportPayload {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
    throw httpError(400, "Data riwayat ekspor wajib berupa objek JSON.");
  }
  const body = raw as Record<string, unknown>;

  if (typeof body.title !== "string") {
    throw httpError(400, "Judul materi wajib diisi.");
  }
  const cleanTitle = body.title.replace(/[\x00-\x1F\x7F]/g, " ").trim();
  if (!cleanTitle) {
    throw httpError(400, "Judul materi wajib diisi.");
  }
  if (cleanTitle.length > MAX_TITLE_LENGTH) {
    throw httpError(400, `Judul materi maksimal ${MAX_TITLE_LENGTH} karakter.`);
  }

  const rawFormat = body.format === undefined ? "H5P" : body.format;
  if (typeof rawFormat !== "string" || !ALLOWED_EXPORT_FORMATS.has(rawFormat as ExportPackageFormat)) {
    throw httpError(400, "Format ekspor harus berupa H5P atau SCORM 1.2.");
  }

  if (typeof body.sizeKb !== "number" || !Number.isFinite(body.sizeKb)) {
    throw httpError(400, "Ukuran paket ekspor wajib berupa angka.");
  }
  const normalizedSizeKb = Math.round(body.sizeKb);
  if (normalizedSizeKb < 1 || normalizedSizeKb > MAX_EXPORT_SIZE_KB) {
    throw httpError(400, `Ukuran paket harus antara 1 hingga ${MAX_EXPORT_SIZE_KB} KB.`);
  }

  let projectId: string | null = null;
  if (body.projectId !== undefined && body.projectId !== null && body.projectId !== "") {
    if (typeof body.projectId !== "string") {
      throw httpError(400, "Format ID proyek tidak valid.");
    }
    projectId = body.projectId.trim();
  }

  let sourceFileName: string | null = null;
  if (body.sourceFileName !== undefined && body.sourceFileName !== null && body.sourceFileName !== "") {
    if (typeof body.sourceFileName !== "string") {
      throw httpError(400, "Nama berkas sumber tidak valid.");
    }
    const cleanName = path.basename(body.sourceFileName.replace(/[\x00-\x1F\x7F]/g, "")).trim();
    if (cleanName) {
      sourceFileName = cleanName.slice(0, MAX_SOURCE_FILENAME_LENGTH);
    }
  }

  return {
    projectId,
    title: cleanTitle,
    format: rawFormat as ExportPackageFormat,
    sizeKb: normalizedSizeKb,
    sourceFileName,
  };
}

export async function recordExportHistory(input: RecordExportInput) {
  let resolvedProjectId: string | null = null;
  let resolvedSourceFileName = input.sourceFileName ?? null;

  if (input.projectId) {
    const owned = await assertProjectOwner(input.projectId, input.userId);
    resolvedProjectId = owned.id;
    if (!resolvedSourceFileName) {
      resolvedSourceFileName = owned.sourceFileName;
    }
  }

  return prisma.exportHistory.create({
    data: {
      userId: input.userId,
      projectId: resolvedProjectId,
      title: input.title,
      format: input.format,
      sizeKb: Math.max(1, Math.round(input.sizeKb)),
      sourceFileName: resolvedSourceFileName,
    },
    select: {
      id: true,
      projectId: true,
      title: true,
      format: true,
      sizeKb: true,
      sourceFileName: true,
      createdAt: true,
    },
  });
}

export async function listExportHistory(userId: string, rawLimit?: unknown) {
  const parsed = typeof rawLimit === "string" || typeof rawLimit === "number" ? Number(rawLimit) : 50;
  const limit = Number.isFinite(parsed) ? Math.min(100, Math.max(1, Math.round(parsed))) : 50;

  return prisma.exportHistory.findMany({
    where: { userId },
    orderBy: { createdAt: "desc" },
    take: limit,
    select: {
      id: true,
      projectId: true,
      title: true,
      format: true,
      sizeKb: true,
      sourceFileName: true,
      createdAt: true,
    },
  });
}
