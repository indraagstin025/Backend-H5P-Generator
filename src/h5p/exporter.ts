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
import { actionMachineName } from "./contentMapper.js";
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
  const text = (v: unknown): string => (typeof v === "string" ? v : "");
  const list = (v: unknown): Array<Record<string, unknown>> =>
    Array.isArray(v) ? (v as Array<Record<string, unknown>>) : [];
  if (n === 0) issues.push("Belum ada slide.");
  for (const s of slides) {
    for (const el of s.data.elements ?? []) {
      const record = el as Record<string, unknown>;

      if (el.kind === "goToSlide" && record.targetType !== "next" && record.targetType !== "previous") {
        const t = Number(record.targetSlide) || 0;
        if (t < 1 || t > n) {
          issues.push(`Slide ${s.order}: tombol “${text(record.label) || "pilihan"}” mengarah ke slide ${t} yang tidak ada.`);
        }
      }

      // Kuis berbasis opsi: multiChoice, singleChoice, multimediaChoice.
      if (el.kind === "multiChoice" || el.kind === "singleChoice" || el.kind === "multimediaChoice") {
        const opts = list(record.options);
        const label =
          el.kind === "multiChoice" ? "pilihan ganda" : el.kind === "singleChoice" ? "pilihan tunggal" : "multimedia choice";
        if (opts.length < 2) issues.push(`Slide ${s.order}: kuis ${label} minimal 2 pilihan jawaban.`);
        if (!opts.some((o) => o.correct === true)) issues.push(`Slide ${s.order}: kuis ${label} belum ada jawaban yang benar.`);
        if (opts.some((o) => !text(o.text).trim())) issues.push(`Slide ${s.order}: ada pilihan jawaban yang masih kosong.`);
        if (el.kind === "singleChoice" && opts.filter((o) => o.correct === true).length !== 1) {
          issues.push(`Slide ${s.order}: kuis pilihan tunggal harus punya tepat satu jawaban benar.`);
        }
        if (el.kind === "singleChoice" && opts.length > 4) {
          issues.push(`Slide ${s.order}: H5P Single Choice maksimal 4 pilihan jawaban.`);
        }
      }

      if (
        (el.kind === "multiChoice" ||
          el.kind === "singleChoice" ||
          el.kind === "multimediaChoice" ||
          el.kind === "trueFalse" ||
          el.kind === "dragDrop") &&
        !text(record.question).trim()
      ) {
        issues.push(`Slide ${s.order}: pertanyaan kuisnya masih kosong.`);
      }

      if (
        (el.kind === "blanks" || el.kind === "dragWords" || el.kind === "markWords") &&
        countBlanks(text(record.text)) === 0
      ) {
        const label = el.kind === "blanks" ? "isian" : el.kind === "dragWords" ? "drag the words" : "mark the words";
        issues.push(`Slide ${s.order}: kuis ${label} belum punya kata *berbintang*.`);
      }

      if (el.kind === "dragDrop") {
        const zones = list(record.zones);
        const items = list(record.items);
        if (zones.length === 0) issues.push(`Slide ${s.order}: drag & drop belum punya zona tujuan.`);
        if (items.length === 0) issues.push(`Slide ${s.order}: drag & drop belum punya item.`);
        if (zones.some((z) => !text(z.label).trim())) issues.push(`Slide ${s.order}: ada zona drag & drop yang masih kosong.`);
        if (items.some((it) => !text(it.text).trim())) issues.push(`Slide ${s.order}: ada item drag & drop yang masih kosong.`);
        if (items.some((it) => !zones.some((z) => z.id === it.zoneId))) {
          issues.push(`Slide ${s.order}: ada item drag & drop yang belum punya zona jawaban.`);
        }
      }

      if (el.kind === "summary") {
        const statements = list(record.statements);
        if (statements.length < 2) issues.push(`Slide ${s.order}: summary minimal butuh 2 pernyataan.`);
        if (!statements.some((st) => st.correct === true)) issues.push(`Slide ${s.order}: summary belum ada pernyataan yang benar.`);
        if (statements.some((st) => !text(st.text).trim())) {
          issues.push(`Slide ${s.order}: ada pernyataan summary yang masih kosong.`);
        }
      }

      if (el.kind === "dialogCards") {
        const cards = list(record.cards);
        if (cards.length === 0) issues.push(`Slide ${s.order}: dialog cards belum punya kartu.`);
        if (cards.some((c) => !text(c.front).trim() || !text(c.back).trim())) {
          issues.push(`Slide ${s.order}: ada kartu dialog yang sisi depan/belakangnya kosong.`);
        }
      }

      if (el.kind === "table" && (Number(record.rows) < 1 || Number(record.cols) < 1)) {
        issues.push(`Slide ${s.order}: tabel minimal 1 baris dan 1 kolom.`);
      }

      if (el.kind === "link" && !text(record.url).trim()) {
        issues.push(`Slide ${s.order}: link URL belum diisi.`);
      }

      if ((el.kind === "image" || el.kind === "audio") && !text(record.asset)) {
        issues.push(`Slide ${s.order}: ${el.kind === "image" ? "Gambar" : "Suara"} belum ada file-nya.`);
      }

      if (el.kind === "video" && !text(record.asset) && !text(record.videoUrl).trim() && !text(record.objectUrl).trim()) {
        issues.push(`Slide ${s.order}: Video belum ada file atau URL-nya.`);
      }

      if (el.kind === "interactiveVideo" && !text(record.videoUrl).trim()) {
        issues.push(`Slide ${s.order}: interactive video belum ada URL video.`);
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
  // Laporkan semua library action yang benar-benar dipakai (bukan hanya CP),
  // supaya masalah "library tidak terinstal" terlihat sebelum ekspor.
  const needed = new Set<string>(["H5P.CoursePresentation"]);
  for (const s of slides) {
    for (const el of s.data.elements ?? []) {
      const name = actionMachineName(el.kind);
      if (name) needed.add(name);
    }
  }
  const libraries: Array<{ machineName: string; majorVersion: number; minorVersion: number }> = [];
  for (const name of needed) {
    const ver = await installedLibraryVersion(name);
    if (ver) libraries.push(ver);
    else issues.push(`Library ${name} belum terinstal di server. Jalankan: npm run h5p:seed`);
  }
  const cp = libraries.find((l) => l.machineName === "H5P.CoursePresentation") ?? null;
  const quizKinds = new Set([
    "multiChoice",
    "singleChoice",
    "trueFalse",
    "blanks",
    "dragDrop",
    "dragWords",
    "markWords",
    "multimediaChoice",
    "summary",
  ]);
  const quizCount = slides
    .flatMap((s) => s.data.elements ?? [])
    .filter((e) => quizKinds.has(e.kind)).length;
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
    const folder = kind === "audio" ? "audios" : kind === "video" ? "videos" : "images";
    const contentPath = `${folder}/${base}`;
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
