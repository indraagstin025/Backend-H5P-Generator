import { promises as fs } from "node:fs";
import path from "node:path";
import { config } from "../config.js";
import { prisma } from "../db.js";
import { projectDir, removeProjectFiles } from "./storage.js";

export const UUID_REGEX = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

function httpError(status: number, message: string): Error & { status: number } {
  return Object.assign(new Error(message), { status });
}

export function assertValidUuid(value: string, label = "ID proyek"): string {
  const clean = value.trim();
  if (!UUID_REGEX.test(clean)) {
    throw httpError(400, `Format ${label} tidak valid.`);
  }
  return clean;
}

function sanitizeTitle(raw: unknown): string {
  if (typeof raw !== "string") {
    throw httpError(400, "Judul proyek wajib berupa teks.");
  }
  const clean = raw.replace(/[\x00-\x1F\x7F]/g, " ").trim();
  if (!clean) {
    throw httpError(400, "Judul proyek wajib diisi.");
  }
  if (clean.length > 200) {
    throw httpError(400, "Judul proyek maksimal 200 karakter.");
  }
  return clean;
}

const ALLOWED_SETTING_FLAGS = [
  "keywordListEnabled",
  "requireQuestionsBeforeNavigation",
  "activeSurface",
  "hideSummarySlide",
  "showSolutionButton",
  "retryButton",
] as const;

function sanitizeSettingsPatch(raw: unknown, currentJson: string): string {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
    throw httpError(400, "Format settings proyek tidak valid.");
  }
  let base: Record<string, unknown> = {};
  try {
    const parsed = JSON.parse(currentJson || "{}");
    if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
      base = { ...(parsed as Record<string, unknown>) };
    }
  } catch {
    base = {};
  }

  const patch = raw as Record<string, unknown>;
  if (patch.autoAdvance !== undefined) {
    const value = patch.autoAdvance as Record<string, unknown>;
    if (!value || typeof value !== 'object' || typeof value.enabled !== 'boolean' || !['all', 'selected'].includes(String(value.scope)) || !['next', 'previous', 'specified'].includes(String(value.targetType)) || typeof value.targetSlideId !== 'string' || !Array.isArray(value.rules) || !value.rules.every((rule: unknown) => !!rule && typeof rule === 'object' && typeof (rule as Record<string, unknown>).sourceId === 'string' && typeof (rule as Record<string, unknown>).targetId === 'string')) throw httpError(400, 'Pengaturan perpindahan otomatis tidak valid.');
    base.autoAdvance = value;
  }
  if ("language" in patch && patch.language !== undefined) {
    if (typeof patch.language !== "string" || !/^[a-zA-Z-]{2,10}$/.test(patch.language.trim())) {
      throw httpError(400, "Kode bahasa pengaturan proyek tidak valid.");
    }
    base.language = patch.language.trim().toLowerCase();
  }

  for (const key of ALLOWED_SETTING_FLAGS) {
    if (key in patch && patch[key] !== undefined) {
      if (typeof patch[key] !== "boolean") {
        throw httpError(400, `Pengaturan "${key}" wajib bernilai boolean.`);
      }
      base[key] = patch[key];
    }
  }

  return JSON.stringify(base);
}

/**
 * Verifikasi ketat bahwa proyek ada dan dimiliki oleh userId pemanggil.
 * Melempar 400 bila UUID tidak valid, 404 bila tidak ada, 403 bila milik user lain.
 */
export async function assertProjectOwner(projectId: string, userId: string) {
  const id = assertValidUuid(projectId, "ID proyek");
  const project = await prisma.project.findUnique({ where: { id } });
  if (!project) {
    throw httpError(404, "Proyek tidak ditemukan.");
  }
  if (!project.userId || project.userId !== userId) {
    throw httpError(403, "Anda tidak memiliki izin untuk mengakses proyek ini.");
  }
  return project;
}

export async function listProjects(userId: string) {
  return prisma.project.findMany({
    where: { userId },
    orderBy: { updatedAt: "desc" },
    include: { _count: { select: { slides: true } } },
  });
}

export async function getProject(id: string, userId: string) {
  await assertProjectOwner(id, userId);
  return prisma.project.findUnique({
    where: { id },
    include: { slides: { orderBy: { order: "asc" } } },
  });
}

export async function createProject(input: { title: string; aspect?: string; userId: string }) {
  const title = sanitizeTitle(input.title);
  return prisma.project.create({
    data: {
      title,
      aspect: input.aspect === "4:3" ? "4:3" : "16:9",
      userId: input.userId,
    },
  });
}

export async function updateProject(
  id: string,
  userId: string,
  input: { title?: unknown; settings?: unknown },
) {
  const project = await assertProjectOwner(id, userId);
  const data: { title?: string; settingsJson?: string } = {};

  if (input.title !== undefined) {
    data.title = sanitizeTitle(input.title);
  }
  if (input.settings !== undefined) {
    data.settingsJson = sanitizeSettingsPatch(input.settings, project.settingsJson);
  }

  if (data.title === undefined && data.settingsJson === undefined) {
    throw httpError(400, "Sertakan title atau settings yang ingin diperbarui.");
  }

  return prisma.project.update({ where: { id }, data });
}

export async function deleteProject(id: string, userId: string): Promise<void> {
  await assertProjectOwner(id, userId);
  try {
    await prisma.project.delete({ where: { id } });
  } catch {
    throw httpError(404, "Proyek tidak ditemukan.");
  }
  await removeProjectFiles(id);
}

export async function duplicateProject(id: string, userId: string) {
  const source = await assertProjectOwner(id, userId);
  const slides = await prisma.slide.findMany({
    where: { projectId: id },
    orderBy: { order: "asc" },
  });

  const baseTitle = `${source.title} (Salinan)`;
  const duplicatedTitle = baseTitle.length <= 200 ? baseTitle : `${source.title.slice(0, 190)} (Salinan)`;

  const created = await prisma.$transaction(async (tx) => {
    const copy = await tx.project.create({
      data: {
        title: duplicatedTitle,
        aspect: source.aspect,
        settingsJson: source.settingsJson,
        sourceFileName: source.sourceFileName,
        userId,
      },
    });
    for (const s of slides) {
      await tx.slide.create({
        data: {
          projectId: copy.id,
          order: s.order,
          title: s.title,
          dataJson: s.dataJson,
        },
      });
    }
    return copy;
  });

  const srcAssets = path.join(projectDir(id), "assets");
  const dstAssets = path.join(projectDir(created.id), "assets");
  try {
    const stat = await fs.stat(srcAssets).catch(() => null);
    if (stat?.isDirectory()) {
      await fs.mkdir(projectDir(created.id), { recursive: true });
      await fs.cp(srcAssets, dstAssets, { recursive: true });
    }
  } catch (err) {
    await prisma.project.delete({ where: { id: created.id } }).catch(() => undefined);
    await removeProjectFiles(created.id).catch(() => undefined);
    throw err;
  }

  return getProject(created.id, userId);
}

/**
 * Hapus proyek lama tanpa pemilik (userId: null) beserta seluruh folder fisiknya di disk.
 * Aman dan idempoten untuk dijalankan pada startup atau migrasi.
 */
export async function purgeOrphanedProjects(): Promise<number> {
  const orphans = await prisma.project.findMany({
    where: { userId: null },
    select: { id: true },
  });
  if (orphans.length === 0) return 0;

  const ids = orphans.map((p) => p.id);
  await prisma.project.deleteMany({ where: { id: { in: ids } } });
  for (const id of ids) {
    await removeProjectFiles(id).catch(() => undefined);
  }
  return ids.length;
}

/** Pindahkan file upload tmp ke folder proyek + catat di DB (dipakai ingest). */
export async function attachSourceFile(
  projectId: string,
  tmpPath: string,
  fileName: string,
) {
  const dir = projectDir(projectId);
  await fs.mkdir(dir, { recursive: true });
  const safeName = path.basename(fileName).replace(/[^a-zA-Z0-9._-]+/g, "-");
  const dest = path.join(dir, `source-${Date.now()}-${safeName}`);
  await fs.rename(tmpPath, dest);
  return prisma.project.update({
    where: { id: projectId },
    data: { sourceFileName: path.basename(fileName), sourcePath: dest },
  });
}

/**
 * Normalisasi URL atau path relatif aset dari frontend menjadi path lokal konsisten "assets/<nama-berkas>".
 * Menolak blob:/data: URL maupun karakter berbahaya agar tidak memicu path traversal.
 */
export function normalizeAssetToLocalPath(val: unknown): string | null {
  if (typeof val !== "string" || !val.trim()) return null;
  const clean = val.trim();
  if (/^(blob:|data:|javascript:)/i.test(clean)) return null;
  const noQuery = clean.split("?")[0].split("#")[0];
  const rawName = noQuery.split("/").pop()?.split("\\").pop();
  if (!rawName || rawName === "." || rawName === ".." || !/^[A-Za-z0-9._-]+$/.test(rawName)) {
    return null;
  }
  return `assets/${rawName}`;
}

export async function saveProjectSlides(projectId: string, userId: string, slides: any[]) {
  await assertProjectOwner(projectId, userId);
  if (slides.length > config.maxSlidesPerProject) {
    throw httpError(400, `Maksimal ${config.maxSlidesPerProject} slide per proyek.`);
  }

  // Cegah slide ID hijacking/tabrakan lintas proyek: hanya izinkan UUID milik proyek ini
  const candidateIds = slides
    .map((s) => (typeof s?.id === "string" ? s.id.trim() : ""))
    .filter((id) => UUID_REGEX.test(id));
  const foreignSlides =
    candidateIds.length > 0
      ? await prisma.slide.findMany({
          where: { id: { in: candidateIds }, projectId: { not: projectId } },
          select: { id: true },
        })
      : [];
  const forbiddenIds = new Set(foreignSlides.map((s) => s.id));
  const usedIds = new Set<string>();

  await prisma.$transaction(async (tx) => {
    await tx.slide.deleteMany({ where: { projectId } });
    for (const [idx, s] of slides.entries()) {
      const rawBg = s?.background ?? s?.backgroundUrl ?? null;
      const normalizedBg = normalizeAssetToLocalPath(rawBg);

      const rawElements = Array.isArray(s?.elements) ? s.elements : [];
      const normalizedElements = rawElements.map((el: Record<string, unknown>) => {
        if (!el || typeof el !== "object") return el;
        const kind = String(el.kind ?? "");
        if (kind === "image" || kind === "audio" || kind === "video") {
          const rawAsset = el.asset ?? el.assetUrl ?? el.objectUrl;
          const normalized = normalizeAssetToLocalPath(rawAsset);
          return {
            ...el,
            asset: normalized ?? (typeof el.asset === "string" ? normalizeAssetToLocalPath(el.asset) : undefined),
          };
        }
        return el;
      });

      const candidateId = typeof s?.id === "string" ? s.id.trim() : "";
      const safeSlideId =
        UUID_REGEX.test(candidateId) && !forbiddenIds.has(candidateId) && !usedIds.has(candidateId)
          ? candidateId
          : undefined;
      if (safeSlideId) usedIds.add(safeSlideId);

      const safeTitle =
        typeof s?.title === "string" && s.title.trim()
          ? s.title.replace(/[\x00-\x1F\x7F]/g, " ").trim().slice(0, 200)
          : `Slide ${idx + 1}`;

      await tx.slide.create({
        data: {
          id: safeSlideId,
          projectId,
          order: typeof s?.order === "number" && Number.isFinite(s.order) ? Math.max(1, Math.round(s.order)) : idx + 1,
          title: safeTitle,
          dataJson: JSON.stringify({
            chapter: s?.chapter,
            tone: s?.tone,
            aspect: s?.aspect,
            keywords: s?.keywords,
            background: normalizedBg,
            backgroundPending:
              typeof s?.backgroundPending === "boolean" ? s.backgroundPending : !normalizedBg,
            elements: normalizedElements,
          }),
        },
      });
    }
    await tx.project.update({ where: { id: projectId }, data: { updatedAt: new Date() } });
  });

  return getProject(projectId, userId);
}
