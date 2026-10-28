import { promises as fs } from "node:fs";
import path from "node:path";
import { prisma } from "../db.js";
import { projectDir } from "./storage.js";

export async function listProjects() {
  return prisma.project.findMany({
    orderBy: { updatedAt: "desc" },
    include: { _count: { select: { slides: true } } },
  });
}

export async function getProject(id: string) {
  return prisma.project.findUnique({
    where: { id },
    include: { slides: { orderBy: { order: "asc" } } },
  });
}

export async function createProject(input: { title: string; aspect?: string }) {
  const title = input.title.trim();
  if (!title) throw Object.assign(new Error("Judul proyek wajib diisi."), { status: 400 });
  return prisma.project.create({
    data: { title, aspect: input.aspect === "4:3" ? "4:3" : "16:9" },
  });
}

export async function renameProject(id: string, title: string) {
  const clean = title.trim();
  if (!clean) throw Object.assign(new Error("Judul proyek wajib diisi."), { status: 400 });
  try {
    return await prisma.project.update({ where: { id }, data: { title: clean } });
  } catch {
    throw Object.assign(new Error("Proyek tidak ditemukan."), { status: 404 });
  }
}

export async function deleteProject(id: string): Promise<void> {
  try {
    await prisma.project.delete({ where: { id } });
  } catch {
    throw Object.assign(new Error("Proyek tidak ditemukan."), { status: 404 });
  }
  const { removeProjectFiles } = await import("./storage.js");
  await removeProjectFiles(id);
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

export async function saveProjectSlides(projectId: string, slides: any[]) {
  const project = await prisma.project.findUnique({ where: { id: projectId } });
  if (!project) throw Object.assign(new Error("Proyek tidak ditemukan."), { status: 404 });

  await prisma.$transaction(async (tx) => {
    await tx.slide.deleteMany({ where: { projectId } });
    for (const [idx, s] of slides.entries()) {
      await tx.slide.create({
        data: {
          id: s.id && !s.id.includes("copy") && !s.id.startsWith("temp") && s.id.length <= 36 ? s.id : undefined,
          projectId,
          order: s.order ?? idx + 1,
          title: s.title || `Slide ${idx + 1}`,
          dataJson: JSON.stringify({
            chapter: s.chapter,
            tone: s.tone,
            aspect: s.aspect,
            keywords: s.keywords,
            background: s.background ?? s.backgroundUrl ?? null,
            elements: s.elements ?? [],
          }),
        },
      });
    }
    await tx.project.update({ where: { id: projectId }, data: { updatedAt: new Date() } });
  });

  return getProject(projectId);
}
