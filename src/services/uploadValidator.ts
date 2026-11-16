import crypto from "node:crypto";
import { promises as fs } from "node:fs";
import path from "node:path";
import { unzipSync } from "fflate";
import { PDFiumLibrary } from "@hyzyla/pdfium";
import { prisma } from "../db.js";

/** Error HTTP dengan status code */
export interface HttpError extends Error {
  status: number;
}

function createHttpError(status: number, message: string): HttpError {
  return Object.assign(new Error(message), { status });
}

/**
 * Validasi ketat format berkas:
 * 1. Memeriksa Magic Bytes biner asli (bukan sekadar ekstensi).
 * 2. Memeriksa apakah berkas dilindungi kata sandi (password-protected).
 * 3. Menghitung sidik jari unik (SHA-256) untuk deteksi duplikasi isi berkas.
 */
export async function validateSourceFileContent(filePath: string, originalName: string): Promise<{
  hash: string;
  ext: ".pdf" | ".pptx";
}> {
  const ext = path.extname(originalName).toLowerCase();
  if (ext !== ".pdf" && ext !== ".pptx") {
    throw createHttpError(400, "Hanya berkas presentasi .pptx atau dokumen .pdf yang diperbolehkan.");
  }

  const buffer = await fs.readFile(filePath);
  if (buffer.length === 0) {
    throw createHttpError(400, "Berkas yang diunggah kosong (0 bytes).");
  }

  // 1. Validasi untuk Dokumen PDF
  if (ext === ".pdf") {
    // Magic Bytes PDF: Wajib diawali %PDF- (0x25, 0x50, 0x44, 0x46, 0x2D)
    const header = buffer.subarray(0, 5).toString("latin1");
    if (!header.startsWith("%PDF-")) {
      throw createHttpError(400, "Berkas bukan dokumen PDF yang valid (struktur biner rusak atau file diubah nama).");
    }

    // Deteksi PDF yang dilindungi kata sandi (password-protected)
    // Tahap A: Cek tanda /Encrypt pada kamus trailer PDF
    const textSample = buffer.subarray(0, Math.min(buffer.length, 1024 * 1024)).toString("latin1");
    const hasEncryptTag = /\/Encrypt\s+/i.test(textSample) || buffer.includes(Buffer.from("/Encrypt"));

    // Tahap B: Verifikasi nyata menggunakan engine WebAssembly PDFium
    const library = await PDFiumLibrary.init();
    try {
      const doc = await library.loadDocument(buffer);
      const pageCount = doc.getPageCount();
      doc.destroy();

      if (pageCount < 1) {
        throw createHttpError(400, "Dokumen PDF tidak memiliki halaman yang dapat dibaca.");
      }
    } catch (err: unknown) {
      const errMsg = err instanceof Error ? err.message.toLowerCase() : String(err);
      if (hasEncryptTag || errMsg.includes("password") || errMsg.includes("encrypted") || errMsg.includes("protected")) {
        throw createHttpError(
          400,
          "Berkas PDF ini dilindungi kata sandi (password-protected). Harap buka kunci dokumen terlebih dahulu sebelum mengunggah.",
        );
      }
      throw createHttpError(400, "Gagal membuka dokumen PDF. Berkas mungkin rusak atau tidak kompatibel.");
    } finally {
      library.destroy();
    }
  }

  // 2. Validasi untuk Berkas PowerPoint (.pptx)
  if (ext === ".pptx") {
    // Deteksi berkas Office yang dienkripsi/diproteksi password
    // Berkas Office ber-password menggunakan format OLE/CFB dengan signature 0xD0, 0xCF, 0x11, 0xE0
    if (buffer[0] === 0xd0 && buffer[1] === 0xcf && buffer[2] === 0x11 && buffer[3] === 0xe0) {
      throw createHttpError(
        400,
        "Berkas PowerPoint ini dilindungi kata sandi. Harap buka kunci presentasi terlebih dahulu sebelum mengunggah.",
      );
    }

    // Magic Bytes ZIP: PPTX adalah arsip ZIP yang diawali PK (0x50, 0x4B)
    if (buffer[0] !== 0x50 || buffer[1] !== 0x4b) {
      throw createHttpError(400, "Berkas bukan presentasi PowerPoint (.pptx) yang valid.");
    }

    // Periksa struktur internal arsip PPTX (wajib memiliki [Content_Types].xml atau folder ppt/)
    try {
      const entries = unzipSync(new Uint8Array(buffer));
      const hasContentTypes = Object.keys(entries).some((k) => k.toLowerCase() === "[content_types].xml");
      const hasPptFolder = Object.keys(entries).some((k) => k.toLowerCase().startsWith("ppt/"));

      if (!hasContentTypes && !hasPptFolder) {
        throw createHttpError(400, "Struktur berkas .pptx tidak lengkap atau bukan berkas presentasi Microsoft PowerPoint.");
      }
    } catch {
      throw createHttpError(400, "Arsip berkas .pptx rusak dan tidak dapat diekstrak.");
    }
  }

  // Hitung hash SHA-256 dari seluruh isi berkas untuk deteksi duplikasi
  const hash = crypto.createHash("sha256").update(buffer).digest("hex");
  return { hash, ext };
}

const IMAGE_MEDIA_EXT = new Set(["png", "jpg", "jpeg", "gif", "webp", "svg"]);
const AUDIO_MEDIA_EXT = new Set(["mp3", "wav", "ogg", "m4a"]);
const VIDEO_MEDIA_EXT = new Set(["mp4", "m4v", "webm", "ogv"]);

const MEDIA_EXT_MIME: Record<string, string> = {
  png: "image/png",
  jpg: "image/jpeg",
  jpeg: "image/jpeg",
  gif: "image/gif",
  webp: "image/webp",
  svg: "image/svg+xml",
  mp3: "audio/mpeg",
  wav: "audio/wav",
  ogg: "audio/ogg",
  m4a: "audio/mp4",
  mp4: "video/mp4",
  m4v: "video/mp4",
  webm: "video/webm",
  ogv: "video/ogg",
};

const MAX_IMAGE_OR_AUDIO_BYTES = 10 * 1024 * 1024;
const MAX_VIDEO_BYTES = 50 * 1024 * 1024;

function asciiSlice(buf: Buffer, start: number, len: number): string {
  if (buf.length < start + len) return "";
  return buf.subarray(start, start + len).toString("latin1");
}

function validateSvgContent(buf: Buffer): void {
  const text = buf.toString("utf8");
  if (!/<svg[\s>]/i.test(text)) {
    throw createHttpError(400, "Berkas .svg tidak valid (elemen akar <svg> tidak ditemukan).");
  }
  const dangerousSvgPattern =
    /<script[\s>]|<\/script>|<\s*foreignObject[\s>]|on[a-z]+\s*=|javascript:|vbscript:|data:text\/html/i;
  if (dangerousSvgPattern.test(text)) {
    throw createHttpError(400, "Berkas SVG ditolak karena mengandung elemen atau skrip berisiko (XSS).");
  }
}

/**
 * Validasi ketat file media Studio (gambar/audio/video) dengan pemeriksaan ukuran,
 * ekstensi, serta Magic Bytes asli sebelum disimpan permanen ke assets/.
 */
export async function validateAndSaveMediaAsset(
  tmpFilePath: string,
  originalName: string,
  destAssetsDir: string,
): Promise<{
  filename: string;
  asset: string;
  mime: string;
  size: number;
}> {
  try {
    const rawExt = path.extname(originalName).toLowerCase().replace(/^\./, "");
    const isImage = IMAGE_MEDIA_EXT.has(rawExt);
    const isAudio = AUDIO_MEDIA_EXT.has(rawExt);
    const isVideo = VIDEO_MEDIA_EXT.has(rawExt);

    if (!isImage && !isAudio && !isVideo) {
      throw createHttpError(
        400,
        "Format media tidak didukung. Gunakan gambar (.png/.jpg/.gif/.webp/.svg), audio (.mp3/.wav/.ogg/.m4a), atau video (.mp4/.webm/.ogv).",
      );
    }

    const buffer = await fs.readFile(tmpFilePath);
    if (buffer.length === 0) {
      throw createHttpError(400, "Berkas media kosong (0 bytes).");
    }

    const maxBytes = isVideo ? MAX_VIDEO_BYTES : MAX_IMAGE_OR_AUDIO_BYTES;
    if (buffer.length > maxBytes) {
      throw createHttpError(
        413,
        `Ukuran media melebihi batas maksimal ${isVideo ? 50 : 10} MB.`,
      );
    }

    // Validasi Magic Bytes biner sesuai ekstensi yang diklaim
    let verified = false;
    if (rawExt === "png") {
      verified =
        buffer.length >= 8 &&
        buffer[0] === 0x89 &&
        buffer[1] === 0x50 &&
        buffer[2] === 0x4e &&
        buffer[3] === 0x47 &&
        buffer[4] === 0x0d &&
        buffer[5] === 0x0a &&
        buffer[6] === 0x1a &&
        buffer[7] === 0x0a;
    } else if (rawExt === "jpg" || rawExt === "jpeg") {
      verified = buffer.length >= 3 && buffer[0] === 0xff && buffer[1] === 0xd8 && buffer[2] === 0xff;
    } else if (rawExt === "gif") {
      const hdr = asciiSlice(buffer, 0, 6);
      verified = hdr === "GIF87a" || hdr === "GIF89a";
    } else if (rawExt === "webp") {
      verified = asciiSlice(buffer, 0, 4) === "RIFF" && asciiSlice(buffer, 8, 4) === "WEBP";
    } else if (rawExt === "svg") {
      validateSvgContent(buffer);
      verified = true;
    } else if (rawExt === "mp3") {
      verified =
        asciiSlice(buffer, 0, 3) === "ID3" ||
        (buffer.length >= 2 && buffer[0] === 0xff && (buffer[1] & 0xe0) === 0xe0);
    } else if (rawExt === "wav") {
      verified = asciiSlice(buffer, 0, 4) === "RIFF" && asciiSlice(buffer, 8, 4) === "WAVE";
    } else if (rawExt === "ogg" || rawExt === "ogv") {
      verified = asciiSlice(buffer, 0, 4) === "OggS";
    } else if (rawExt === "m4a" || rawExt === "mp4" || rawExt === "m4v") {
      verified = asciiSlice(buffer, 4, 4) === "ftyp";
    } else if (rawExt === "webm") {
      verified =
        buffer.length >= 4 &&
        buffer[0] === 0x1a &&
        buffer[1] === 0x45 &&
        buffer[2] === 0xdf &&
        buffer[3] === 0xa3;
    }

    if (!verified) {
      throw createHttpError(
        400,
        `Isi biner berkas tidak cocok dengan format .${rawExt}. Pastikan file media asli dan tidak rusak.`,
      );
    }

    const canonExt = rawExt === "jpeg" ? "jpg" : rawExt;
    const filename = `media-${crypto.randomUUID().slice(0, 12)}.${canonExt}`;
    await fs.mkdir(destAssetsDir, { recursive: true });
    await fs.writeFile(path.join(destAssetsDir, filename), buffer);

    return {
      filename,
      asset: `assets/${filename}`,
      mime: MEDIA_EXT_MIME[canonExt] ?? "application/octet-stream",
      size: buffer.length,
    };
  } finally {
    await fs.unlink(tmpFilePath).catch(() => undefined);
  }
}

/**
 * Memeriksa apakah berkas duplikat sudah pernah diunggah oleh pengguna yang sama:
 * 1. Pengecekan nama berkas yang sama pada proyek milik pengguna tersebut.
 * 2. Pengecekan isi berkas yang identik (SHA-256) pada proyek milik pengguna tersebut.
 */
export async function ensureNoDuplicateProject(
  originalName: string,
  fileHash: string,
  userId: string,
): Promise<void> {
  const cleanName = path.basename(originalName).trim();

  // 1. Cek duplikasi berdasarkan nama berkas dalam ruang lingkup userId yang sama
  const existingByName = await prisma.project.findFirst({
    where: { userId, sourceFileName: cleanName },
    select: { id: true, title: true, sourceFileName: true },
  });

  if (existingByName) {
    throw createHttpError(
      409,
      `Berkas dengan nama "${cleanName}" sudah pernah diunggah pada materi "${existingByName.title}". Silakan gunakan nama berkas lain atau lanjutkan pengeditan materi tersebut.`,
    );
  }

  // 2. Cek duplikasi berdasarkan isi berkas (SHA-256) dalam ruang lingkup userId yang sama
  const userProjects = await prisma.project.findMany({
    where: { userId, sourcePath: { not: null } },
    select: { id: true, title: true, sourcePath: true },
  });

  for (const proj of userProjects) {
    if (!proj.sourcePath) continue;
    try {
      const existingBuffer = await fs.readFile(proj.sourcePath);
      const existingHash = crypto.createHash("sha256").update(existingBuffer).digest("hex");
      if (existingHash === fileHash) {
        throw createHttpError(
          409,
          `Isi berkas ini 100% identik dengan materi "${proj.title}" yang sudah ada di akun Anda. Silakan buka materi tersebut di beranda.`,
        );
      }
    } catch (err: unknown) {
      if ((err as HttpError).status === 409) throw err;
      // Abaikan jika berkas lama tidak dapat diakses di disk
    }
  }
}
