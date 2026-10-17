import { createReadStream, promises as fs } from "node:fs";
import path from "node:path";
import { PassThrough, Readable } from "node:stream";
import { strFromU8, unzipSync } from "fflate";
import sharp from "sharp";
import { prisma } from "../db.js";
import { projectDir } from "../services/storage.js";
import { getH5P, installedLibraryVersion, systemUser } from "./h5pService.js";
import type { ContentId } from "@lumieducation/h5p-server";
import { buildContentParams } from "./contentMapper.js";
import type { StoredSlide } from "./contentMapper.js";

export interface ExportIssue {
  level: "error" | "warning";
  message: string;
}

export interface ExportReport {
  ok: boolean;
  issues: string[];
  warnings: string[];
  libraries: Array<{ machineName: string; majorVersion: number; minorVersion: number }>;
  mainLibrary: string | null;
  slideCount: number;
  quizCount: number;
}

export interface ExportResult {
  buffer: Buffer;
  filename: string;
  report: ExportReport;
}

const TONE_GRADIENTS: Record<string, [string, string, string]> = {
  lime: ["#d9f7aa", "#88cf68", "#23734b"],
  forest: ["#c9e9ae", "#5ca45a", "#174d39"],
  mint: ["#ebf8d4", "#a5db87", "#327b55"],
  paper: ["#fbfdec", "#d6edbc", "#82bc74"],
};

function escapeXml(s: string): string {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

function wrapLines(text: string, maxChars: number): string[] {
  const words = text.split(/\s+/).filter(Boolean);
  const lines: string[] = [];
  let line = "";
  for (const w of words) {
    const test = line ? `${line} ${w}` : w;
    if (test.length > maxChars && line) {
      lines.push(line);
      line = w;
    } else line = test;
    if (lines.length === 2) break;
  }
  if (line) lines.push(line);
  return lines.slice(0, 3);
}

/** Latar gradien pengganti bila render presisi belum ada (backgroundPending). */
export async function renderGradientBackground(
  tone: string,
  title: string,
  chapter: string,
  aspect: string,
): Promise<Buffer> {
  const W = aspect === "4:3" ? 1440 : 1920;
  const H = 1080;
  const [c1, c2, c3] = TONE_GRADIENTS[tone] ?? TONE_GRADIENTS.paper;
  const lines = wrapLines(title || "Slide", 28);
  const titleSvg = lines.map((l, i) => `<text x="10%" y="${26 + i * 9}%" class="title">${escapeXml(l)}</text>`).join("");
  const svg =
    `<svg xmlns="http://www.w3.org/2000/svg" width="${W}" height="${H}">` +
    `<defs><linearGradient id="g" x1="0" y1="0" x2="1" y2="1">` +
    `<stop offset="0" stop-color="${c1}"/><stop offset="0.47" stop-color="${c2}"/><stop offset="1" stop-color="${c3}"/>` +
    `</linearGradient><style>.chapter{font:700 ${Math.round(H * 0.022)}px sans-serif;fill:rgba(20,63,40,.62);letter-spacing:4px;}.title{font:700 ${Math.round(H * 0.07)}px sans-serif;fill:#123d2a;}</style></defs>` +
    `<rect width="100%" height="100%" fill="url(#g)"/>` +
    `<text x="10%" y="14%" class="chapter">${escapeXml(chapter.toUpperCase())}</text>${titleSvg}</svg>`;
  return sharp(Buffer.from(svg)).png().toBuffer();
}

export function safeFileName(title: string): string {
  const clean = title.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "");
  return `${clean || "modul"}.h5p`;
}

interface SlideRow {
  order: number;
  title: string;
  data: StoredSlide;
}

async function loadSlides(projectId: string): Promise<{ project: { id: string; title: string; aspect: string; settings: Record<string, unknown> }; slides: SlideRow[] }> {
  const project = await prisma.project.findUnique({ where: { id: projectId } });
  if (!project) throw Object.assign(new Error("Proyek tidak ditemukan."), { status: 404 });
  const rows = await prisma.slide.findMany({ where: { projectId }, orderBy: { order: "asc" } });
  let settings: Record<string, unknown> = {};
  try {
    settings = JSON.parse(project.settingsJson || "{}") as Record<string, unknown>;
  } catch {
    settings = {};
  }
  return {
    project: { id: project.id, title: project.title, aspect: project.aspect, settings },
    slides: rows.map((r) => {
      const data = JSON.parse(r.dataJson) as StoredSlide;
      return { order: r.order, title: r.title, data };
    }),
  };
}

function countBlanks(text: string): number {
  const m = (text || "").match(/\*[^*]+\*/g);
  return m ? m.length : 0;
}

/** Aturan checklist pra-ekspor (cerminan ExportStep frontend). */
export function checkIssues(slides: SlideRow[], dir: string): { issues: string[]; warnings: string[] } {
  const issues: string[] = [];
  const warnings: string[] = [];
  const n = slides.length;
  if (n === 0) issues.push("Belum ada slide.");
  for (const s of slides) {
    for (const el of s.data.elements ?? []) {
      if (el.kind === "goToSlide" && el.targetType !== "next" && el.targetType !== "previous") {
        const t = Number((el as Record<string, unknown>).targetSlide) || 0;
        if (t < 1 || t > n) issues.push(`Slide ${s.order}: tombol “${String((el as Record<string, unknown>).label ?? "pilihan")}” mengarah ke slide ${t} yang tidak ada.`);
      }
      if (el.kind === "multiChoice") {
        const opts = (Array.isArray((el as Record<string, unknown>).options) ? (el as unknown as { options: Array<{ text?: string; correct?: boolean }> }).options : []);
        if (opts.length < 2) issues.push(`Slide ${s.order}: kuis pilihan ganda minimal 2 pilihan jawaban.`);
        if (!opts.some((o) => o.correct)) issues.push(`Slide ${s.order}: kuis pilihan ganda belum ada jawaban yang benar.`);
        if (opts.some((o) => !(o.text ?? "").trim())) issues.push(`Slide ${s.order}: ada pilihan jawaban yang masih kosong.`);
        if (!String((el as Record<string, unknown>).question ?? "").trim()) issues.push(`Slide ${s.order}: pertanyaan kuisnya masih kosong.`);
      }
      if (el.kind === "trueFalse" && !String((el as Record<string, unknown>).question ?? "").trim()) {
        issues.push(`Slide ${s.order}: pertanyaan kuisnya masih kosong.`);
      }
      if (el.kind === "blanks" && countBlanks(String((el as Record<string, unknown>).text ?? "")) === 0) {
        issues.push(`Slide ${s.order}: kuis isian belum punya jawaban *berbintang*.`);
      }
      if ((el.kind === "image" || el.kind === "audio") && !(el as Record<string, unknown>).asset) {
        issues.push(`Slide ${s.order}: ${el.kind === "image" ? "Gambar" : "Suara"} belum ada file-nya.`);
      }
    }
    if (s.data.backgroundPending) warnings.push(`Slide ${s.order}: latar presisi belum ada — dipakai gradien pengganti.`);
  }
  return { issues: [...new Set(issues)], warnings: [...new Set(warnings)] };
}

export async function buildExportReport(projectId: string): Promise<ExportReport> {
  const { slides } = await loadSlides(projectId);
  const dir = projectDir(projectId);
  const { issues, warnings } = checkIssues(slides, dir);
  const cp = await installedLibraryVersion("H5P.CoursePresentation");
  const libraries = cp ? [cp] : [];
  if (!cp) issues.push("Library H5P.CoursePresentation belum terinstal di server. Jalankan: npm run h5p:seed");
  const quizCount = slides.flatMap((s) => s.data.elements ?? []).filter((e) => e.kind === "multiChoice" || e.kind === "trueFalse" || e.kind === "blanks").length;
  return {
    ok: issues.length === 0,
    issues,
    warnings,
    libraries,
    mainLibrary: cp ? `${cp.machineName} ${cp.majorVersion}.${cp.minorVersion}` : null,
    slideCount: slides.length,
    quizCount,
  };
}

interface ContentFile {
  contentPath: string;
  absPath?: string;
  bytes?: Uint8Array;
}

export async function exportProjectPackage(projectId: string): Promise<ExportResult> {
  const { project, slides } = await loadSlides(projectId);
  if (slides.length === 0) throw Object.assign(new Error("Belum ada slide."), { status: 422 });
  const dir = projectDir(projectId);
  const { issues, warnings } = checkIssues(slides, dir);
  if (issues.length > 0) {
    throw Object.assign(new Error(`Pemeriksaan gagal (${issues.length} masalah). Lihat export-report.`), {
      status: 422,
      issues,
    });
  }

  const settings = project.settings;
  const bool = (v: unknown, fallback: boolean) => (typeof v === "boolean" ? v : fallback);
  const files: ContentFile[] = [];
  const remapAsset = (storedPath: string, kind: string): string => {
    const base = storedPath.split("/").pop() ?? storedPath;
    const contentPath = `${kind === "audio" ? "audios" : "images"}/${base}`;
    files.push({ contentPath, absPath: path.join(dir, storedPath) });
    return contentPath;
  };
  const backgroundPath = (idx: number): string | null => {
    const s = slides[idx];
    if (!s) return null;
    if (s.data.background) {
      const base = s.data.background.split("/").pop() ?? s.data.background;
      const contentPath = `images/${base}`;
      files.push({ contentPath, absPath: path.join(dir, s.data.background) });
      return contentPath;
    }
    return null;
  };

  const { params, mainLibraryUbername } = await buildContentParams(
    slides.map((s) => s.data),
    {
      title: project.title,
      language: "id",
      keywordListEnabled: bool(settings.keywordListEnabled, true),
      activeSurface: bool(settings.activeSurface, false),
      hideSummarySlide: bool(settings.hideSummarySlide, false),
      showSolutionButton: bool(settings.showSolutionButton, true),
      retryButton: bool(settings.retryButton, true),
      remapAsset,
      backgroundPath,
    },
  );

  // Latar gradien pengganti untuk slide yang backgroundPending
  for (let i = 0; i < slides.length; i++) {
    const s = slides[i];
    if (!s.data.background) {
      const contentPath = `images/slide-${s.order}.png`;
      const bytes = await renderGradientBackground(s.data.tone, s.title, s.data.chapter, s.data.aspect);
      files.push({ contentPath, bytes: new Uint8Array(bytes) });
      (params.presentation as { slides: Array<Record<string, unknown>> }).slides[i] = {
        ...((params.presentation as { slides: Array<Record<string, unknown>> }).slides[i] as Record<string, unknown>),
        slideBackgroundSelector: {
          imageSlideBackground: {
            path: contentPath,
            mime: "image/png",
            copyright: { license: "U" },
            title: s.title,
          },
        },
      };
    }
  }

  const { editor, exporter, contentStorage } = await getH5P();
  // ID undefined = konten baru (ID eksplisit dianggap update oleh Lumi
  // dan mencari content.json lama). ID acak hasil save dibersihkan usai paket jadi.
  const metadata = {
    title: project.title,
    language: "id",
    defaultLanguage: "id",
    license: "U",
    embedTypes: ["div", "iframe"] as Array<"div" | "iframe">,
    mainLibrary: mainLibraryUbername.split(" ")[0],
    preloadedDependencies: [],
  };
  const savedId = await editor.saveOrUpdateContent(
    undefined as unknown as ContentId,
    params,
    metadata,
    mainLibraryUbername,
    systemUser,
  );
  for (const f of files) {
    const stream = f.bytes ? Readable.from(Buffer.from(f.bytes)) : createReadStream(f.absPath as string);
    await contentStorage.addFile(savedId, f.contentPath, stream, systemUser);
  }

  const chunks: Buffer[] = [];
  const out = new PassThrough();
  out.on("data", (c: Buffer) => chunks.push(c));
  const finished = new Promise<void>((resolve, reject) => {
    out.on("finish", () => resolve());
    out.on("error", (e) => reject(e));
  });
  try {
    await exporter.createPackage(savedId, out, systemUser);
    await finished;
  } finally {
    await contentStorage.deleteContent(savedId).catch(() => undefined);
  }
  const buffer = Buffer.concat(chunks);

  verifyPackageStructure(buffer, mainLibraryUbername.split(" ")[0]);
  const report = await buildExportReport(projectId);
  return { buffer, filename: safeFileName(project.title), report };
}

/** Verifikasi struktur §5: h5p.json di akar, tanpa entri direktori. */
export function verifyPackageStructure(buffer: Buffer, expectedMainLibrary: string): void {
  const entries = unzipSync(new Uint8Array(buffer));
  const keys = Object.keys(entries);
  if (!keys.includes("h5p.json")) throw new Error("Paket rusak: h5p.json tidak di akar arsip.");
  if (!keys.includes("content/content.json")) throw new Error("Paket rusak: content/content.json absen.");
  const bad = keys.filter((k) => k.endsWith("/") || k.includes("..") || k.startsWith("/"));
  if (bad.length > 0) throw new Error(`Paket tidak valid (entri terlarang: ${bad.slice(0, 3).join(", ")}).`);
  const manifest = JSON.parse(strFromU8(entries["h5p.json"])) as { mainLibrary?: string };
  if (manifest.mainLibrary !== expectedMainLibrary) {
    throw new Error(`mainLibrary paket (${manifest.mainLibrary}) tidak sesuai (${expectedMainLibrary}).`);
  }
}

export interface ValidateResult {
  ok: boolean;
  issues: string[];
  mainLibrary: string | null;
  libraries: Array<{ machineName: string; majorVersion: number; minorVersion: number; status: string }>;
}

/** Validasi ringan paket .h5p rakitan klien terhadap library server. */
export async function validateClientPackage(buffer: Buffer): Promise<ValidateResult> {
  const issues: string[] = [];
  let entries: Record<string, Uint8Array>;
  try {
    entries = unzipSync(new Uint8Array(buffer));
  } catch {
    return { ok: false, issues: ["Berkas bukan ZIP valid."], mainLibrary: null, libraries: [] };
  }
  const keys = Object.keys(entries);
  if (!keys.includes("h5p.json")) issues.push("h5p.json tidak di akar arsip.");
  if (!keys.includes("content/content.json")) issues.push("content/content.json absen.");
  const bad = keys.filter((k) => k.endsWith("/") || k.includes("..") || k.startsWith("/"));
  if (bad.length > 0) issues.push(`Entri direktori/terlarang: ${bad.slice(0, 3).join(", ")} (validator LMS bisa menolak).`);

  let mainLibrary: string | null = null;
  const libraries: ValidateResult["libraries"] = [];
  const manifestRaw = entries["h5p.json"];
  if (manifestRaw) {
    try {
      const manifest = JSON.parse(strFromU8(entries["h5p.json"])) as {
        mainLibrary?: string;
        preloadedDependencies?: Array<{ machineName: string; majorVersion: number; minorVersion: number }>;
      };
      mainLibrary = manifest.mainLibrary ?? null;
      for (const dep of manifest.preloadedDependencies ?? []) {
        const installed = await installedLibraryVersion(dep.machineName);
        if (!installed) {
          libraries.push({ ...dep, status: "missing" });
          issues.push(`Library ${dep.machineName} ${dep.majorVersion}.${dep.minorVersion} tidak ada di server (perlu dicek di LMS).`);
        } else if (
          installed.majorVersion !== dep.majorVersion ||
          installed.minorVersion < dep.minorVersion
        ) {
          libraries.push({ ...dep, status: `server-${installed.majorVersion}.${installed.minorVersion}` });
          issues.push(
            `Library ${dep.machineName} butuh ${dep.majorVersion}.${dep.minorVersion}, server punya ${installed.majorVersion}.${installed.minorVersion}.`,
          );
        } else {
          libraries.push({ ...dep, status: "ok" });
        }
      }
    } catch {
      issues.push("h5p.json rusak (bukan JSON).");
    }
  }
  const contentRaw = entries["content/content.json"];
  if (contentRaw) {
    try {
      const content = JSON.parse(strFromU8(contentRaw)) as { presentation?: { slides?: unknown[] } };
      const n = content.presentation?.slides?.length ?? 0;
      if (n === 0) issues.push("content.json tidak berisi slide.");
    } catch {
      issues.push("content/content.json rusak (bukan JSON).");
    }
  }
  return { ok: issues.length === 0, issues, mainLibrary, libraries };
}
