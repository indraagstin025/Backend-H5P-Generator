import { promises as fs } from "node:fs";
import path from "node:path";
import { prisma } from "../db.js";
import { config } from "../config.js";
import { projectDir } from "../services/storage.js";
import { ensureDom } from "./domShim.js";
import { inspectPdf } from "./pdfInspector.js";
import { buildSlidesFromPptx } from "./pptxConverter.js";
import { inspectPptx } from "./pptxParser.js";
import { optimizeImage, renderBackgrounds } from "./renderer.js";
import type { Slide, SlideElement } from "./h5pModel.js";
import { createSlide } from "./h5pModel.js";

interface PersistedElement extends Record<string, unknown> {
  kind: string;
}

function toFile(name: string, bytes: Uint8Array, mime: string): File {
  return new File([bytes as unknown as BlobPart], name, { type: mime });
}

/** Ubah elemen ber-File menjadi deskriptor aset di disk (optimasi sharp). */
async function persistElement(
  assetsDir: string,
  el: SlideElement,
  prefix: string,
): Promise<PersistedElement> {
  const { file: _file, objectUrl: _url, ...rest } = el as SlideElement & { file?: File | null; objectUrl?: string | null };
  void _file;
  void _url;
  if ((el.kind === "image" || el.kind === "audio" || el.kind === "video") && el.file) {
    const buf = new Uint8Array(await el.file.arrayBuffer());
    const origExt = (el.fileName.split(".").pop() ?? "bin").toLowerCase();
    let fileName = `${prefix}-${el.id.slice(0, 8)}.${origExt}`;
    let bytes: Uint8Array = buf;
    if (el.kind === "image") {
      const opt = await optimizeImage(buf, origExt);
      fileName = `${prefix}-${el.id.slice(0, 8)}.${opt.ext}`;
      bytes = opt.bytes;
    }
    await fs.writeFile(path.join(assetsDir, fileName), bytes);
    return { ...rest, asset: `assets/${fileName}`, fileName: el.fileName } as PersistedElement;
  }
  return rest as PersistedElement;
}

async function setJob(jobId: string, patch: { status?: string; progress?: number; message?: string }): Promise<void> {
  await prisma.ingestJob.update({ where: { id: jobId }, data: patch });
}

function fail(jobId: string, message: string): Promise<void> {
  return setJob(jobId, { status: "error", message }).catch(() => undefined);
}

/**
 * Orkestrasi konversi async (FR-01/02/03, NFR-01):
 * parsing (10–50%) → persistensi (60%) → render latar (60–95%) → done.
 * Dipanggil fire-and-forget dari route ingest; progres via polling job.
 */
export async function runIngestJob(jobId: string): Promise<void> {
  const job = await prisma.ingestJob.findUnique({
    where: { id: jobId },
    include: { project: true },
  });
  if (!job || !job.project) {
    await fail(jobId, "Job atau proyek tidak ditemukan.");
    return;
  }
  const project = job.project;
  const sourcePath = project.sourcePath;
  if (!sourcePath) {
    await fail(jobId, "Berkas sumber tidak tercatat.");
    return;
  }

  try {
    ensureDom();
    await setJob(jobId, { status: "parsing", progress: 10, message: "Membaca halaman, link, catatan & gambar…" });
    const ext = path.extname(project.sourceFileName ?? "").toLowerCase();
    const raw = await fs.readFile(sourcePath);

    let slides: Slide[];
    let aspect: "16:9" | "4:3" = "16:9";
    let counts = { hotspots: 0, notes: 0, media: 0, quizzes: 0 };

    if (ext === ".pptx") {
      const info = await inspectPptx(toFile(project.sourceFileName ?? "materi.pptx", raw, "application/vnd.openxmlformats-officedocument.presentationml.presentation"));
      if (info.slideCount < 1) throw new Error("Tidak ada halaman yang bisa dibaca dari file ini.");
      if (info.slideCount > config.maxSlidesPerProject) {
        throw new Error(`File-nya ada ${info.slideCount} halaman, maksimal ${config.maxSlidesPerProject} slide per materi.`);
      }
      aspect = info.aspect;
      await setJob(jobId, { status: "parsing", progress: 40, message: `Ditemukan ${info.slideCount} slide — memasang elemen…` });
      const built = buildSlidesFromPptx(info);
      slides = built.slides;
      counts = built.counts;
    } else {
      const pdf = await inspectPdf(toFile(project.sourceFileName ?? "materi.pdf", raw, "application/pdf"));
      if (pdf.pageCount < 1) throw new Error("Tidak ada halaman yang bisa dibaca dari file ini.");
      if (pdf.pageCount > config.maxSlidesPerProject) {
        throw new Error(`File-nya ada ${pdf.pageCount} halaman, maksimal ${config.maxSlidesPerProject} slide per materi.`);
      }
      slides = Array.from({ length: pdf.pageCount }, (_, i) => createSlide(i + 1, `Halaman ${i + 1}`, aspect));
    }

    // Persistensi slide + aset media
    await setJob(jobId, { status: "persisting", progress: 60, message: `Menyimpan ${slides.length} slide…` });
    const dir = projectDir(project.id);
    const assetsDir = path.join(dir, "assets");
    await fs.mkdir(assetsDir, { recursive: true });
    await prisma.slide.deleteMany({ where: { projectId: project.id } });

    const backgrounds = new Array<string | null>(slides.length).fill(null);
    let backgroundPending = false;
    await setJob(jobId, { status: "rendering", progress: 65, message: "Merender latar slide…" });
    const rendered = await renderBackgrounds(sourcePath, assetsDir, ext).catch(() => ({ available: false as const, files: [] as string[] }));
    if (rendered.available) {
      rendered.files.forEach((abs, i) => {
        if (i < backgrounds.length) backgrounds[i] = `assets/${path.basename(abs)}`;
      });
      await setJob(jobId, { status: "rendering", progress: 95, message: `${rendered.files.length} latar slide dirender.` });
    } else {
      backgroundPending = true;
    }

    let n = 0;
    for (const slide of slides) {
      n += 1;
      const elements: PersistedElement[] = [];
      for (const el of slide.elements) {
        elements.push(await persistElement(assetsDir, el, `slide-${n}`));
      }
      await prisma.slide.create({
        data: {
          projectId: project.id,
          order: slide.order,
          title: slide.title,
          dataJson: JSON.stringify({
            chapter: slide.chapter,
            tone: slide.tone,
            aspect: slide.aspect,
            keywords: slide.keywords,
            background: backgrounds[slide.order - 1],
            backgroundPending,
            elements,
          }),
        },
      });
    }

    await prisma.project.update({ where: { id: project.id }, data: { aspect } });
    const auto = counts.hotspots + counts.notes + counts.media + counts.quizzes;
    await setJob(jobId, {
      status: "done",
      progress: 100,
      message:
        auto > 0
          ? `${slides.length} slide + ${auto} isi otomatis siap.` +
            (backgroundPending ? " Gambar latar presisi belum ikut (render gagal, coba upload ulang)." : "")
          : `${slides.length} slide siap.` + (backgroundPending ? " Gambar latar presisi belum ikut." : ""),
    });
  } catch (err) {
    await fail(jobId, err instanceof Error ? err.message : "Gagal mengubah file.");
  }
}
