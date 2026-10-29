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

/**
 * Memeriksa apakah berkas duplikat sudah pernah diunggah di sistem:
 * 1. Pengecekan nama berkas yang sama pada proyek aktif.
 * 2. Pengecekan isi berkas yang identik (SHA-256) pada proyek yang sudah ada.
 */
export async function ensureNoDuplicateProject(originalName: string, fileHash: string): Promise<void> {
  const cleanName = path.basename(originalName).trim();

  // 1. Cek duplikasi berdasarkan nama berkas
  const existingByName = await prisma.project.findFirst({
    where: { sourceFileName: cleanName },
    select: { id: true, title: true, sourceFileName: true },
  });

  if (existingByName) {
    throw createHttpError(
      409,
      `Berkas dengan nama "${cleanName}" sudah pernah diunggah pada materi "${existingByName.title}". Silakan gunakan nama berkas lain atau lanjutkan pengeditan materi tersebut.`,
    );
  }

  // 2. Cek duplikasi berdasarkan isi berkas (SHA-256)
  // Ambil semua proyek yang memiliki berkas sumber di disk
  const allProjects = await prisma.project.findMany({
    where: { sourcePath: { not: null } },
    select: { id: true, title: true, sourcePath: true },
  });

  for (const proj of allProjects) {
    if (!proj.sourcePath) continue;
    try {
      const existingBuffer = await fs.readFile(proj.sourcePath);
      const existingHash = crypto.createHash("sha256").update(existingBuffer).digest("hex");
      if (existingHash === fileHash) {
        throw createHttpError(
          409,
          `Isi berkas ini 100% identik dengan materi "${proj.title}" yang sudah ada di sistem. Silakan buka materi tersebut di beranda.`,
        );
      }
    } catch (err: unknown) {
      if ((err as HttpError).status === 409) throw err;
      // Abaikan jika berkas lama tidak dapat diakses di disk
    }
  }
}
