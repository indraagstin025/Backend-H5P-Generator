import { promises as fs } from "node:fs";
import path from "node:path";
import { PDFiumLibrary, type PDFiumPageRenderOptions } from "@hyzyla/pdfium";
import sharp from "sharp";
import { createLogger } from "../utils/logger.js";

const log = createLogger("pdf-render");

/** Dimensi resolusi standar kanvas slide landscape H5P */
const LANDSCAPE_16_9 = { width: 1920, height: 1080 };
const LANDSCAPE_4_3 = { width: 1440, height: 1080 };

/** Kualitas kompresi JPEG latar slide */
const JPEG_QUALITY = 82;

/** Warna latar belakang netral untuk pilarbox dokumen portrait (kiri-kanan) */
const PILLARBOX_BG = { r: 245, g: 247, b: 250, alpha: 1 };

/**
 * Informasi tiap slide yang diekstraksi dari halaman PDF.
 */
export interface PdfSlideInfo {
  pageNumber: number;
  imageFileName: string;
  imagePath: string;
  title: string;
  text: string;
  keywords: Array<{ main: string; subs: string[] }>;
}

/**
 * Hasil konversi utuh dokumen PDF ke slide materi H5P.
 */
export interface PdfConvertResult {
  slideCount: number;
  aspect: "16:9" | "4:3";
  slides: PdfSlideInfo[];
  backgroundFiles: string[];
}

/**
 * Membuat fungsi render halaman PDFium yang mengunci output gambar ke kanvas landscape H5P.
 * - Jika dokumen portrait (A4 tegak), halaman di-fit di tengah kanvas landscape dengan pilarbox netral.
 * - Jika dokumen sudah landscape, halaman di-scale pas memenuhi kanvas landscape.
 */
function createLandscapePageRenderer(canvasWidth: number, canvasHeight: number, isPortrait: boolean) {
  return async (options: PDFiumPageRenderOptions): Promise<Buffer> => {
    const img = sharp(options.data, {
      raw: {
        width: options.width,
        height: options.height,
        channels: 4,
      },
    });

    if (isPortrait) {
      // Fit proporsional di tengah kanvas landscape (isi dokumen utuh tanpa terpotong)
      return await img
        .resize({
          width: canvasWidth,
          height: canvasHeight,
          fit: "contain",
          background: PILLARBOX_BG,
        })
        .jpeg({ quality: JPEG_QUALITY })
        .toBuffer();
    }

    // Dokumen sudah landscape: penuhi kanvas slide
    return await img
      .resize({
        width: canvasWidth,
        height: canvasHeight,
        fit: "fill",
      })
      .jpeg({ quality: JPEG_QUALITY })
      .toBuffer();
  };
}

/**
 * Ekstrak judul singkat dari baris pertama teks halaman.
 */
function extractTitleFromText(text: string, pageNumber: number): string {
  const lines = text
    .split(/\r?\n/)
    .map((l) => l.trim())
    .filter((l) => l.length > 0);

  if (lines.length > 0) {
    const firstLine = lines[0];
    // Batasi panjang judul maksimal 60 karakter agar tidak merusak UI
    if (firstLine.length <= 60) return firstLine;
    return `${firstLine.slice(0, 57)}…`;
  }

  return `Halaman ${pageNumber}`;
}

/**
 * Ekstrak kata-kata kunci dasar dari teks halaman untuk panel navigasi slide.
 */
function extractKeywordsFromText(text: string, title: string): Array<{ main: string; subs: string[] }> {
  const cleanWords = text
    .replace(/[^\w\s\u00C0-\u017F-]/g, " ")
    .split(/\s+/)
    .map((w) => w.trim())
    .filter((w) => w.length >= 4);

  // Ambil beberapa kata unik sebagai sub-topik
  const uniqueWords = [...new Set(cleanWords)].slice(0, 3);
  return [{ main: title, subs: uniqueWords }];
}

/**
 * Konversi berkas PDF menjadi serangkaian gambar latar slide beresolusi tinggi (1920px)
 * dan ekstrak metadata teks halaman menggunakan WebAssembly PDFium tanpa dependensi sistem luar.
 *
 * @param sourcePath Lokasi absolut berkas PDF sumber di disk.
 * @param outDir Folder tujuan penyimpanan gambar latar (folder assets proyek).
 * @returns Metadata hasil konversi slide dan daftar file gambar latar.
 */
export async function convertPdfToSlides(
  sourcePath: string,
  outDir: string,
): Promise<PdfConvertResult> {
  log.info(`Memulai pemrosesan konversi PDF: ${path.basename(sourcePath)}`);
  const pdfBuffer = await fs.readFile(sourcePath);

  // Inisialisasi engine WebAssembly PDFium
  const library = await PDFiumLibrary.init();

  let document;
  try {
    document = await library.loadDocument(pdfBuffer);
    const slideCount = document.getPageCount();

    if (slideCount === 0) {
      throw new Error("Dokumen PDF tidak memiliki halaman yang dapat dibaca.");
    }

    log.info(`Ditemukan ${slideCount} halaman pada dokumen PDF.`);

    let detectedAspect: "16:9" | "4:3" = "16:9";
    let isPortrait = false;
    let canvasWidth = LANDSCAPE_16_9.width;
    let canvasHeight = LANDSCAPE_16_9.height;
    let pageRenderer = createLandscapePageRenderer(canvasWidth, canvasHeight, false);

    const slides: PdfSlideInfo[] = [];
    const backgroundFiles: string[] = [];

    let pageIdx = 0;
    for (const page of document.pages()) {
      pageIdx += 1;
      const pageNumber = pageIdx;

      // 1. Tentukan rasio aspek landscape dan status orientasi dokumen dari halaman pertama
      if (pageIdx === 1) {
        const size = page.getOriginalSize();
        if (size.originalHeight > 0) {
          const ratio = size.originalWidth / size.originalHeight;
          if (ratio < 1.0) {
            // Dokumen berorientasi portrait (A4 tegak / buku): kunci ke kanvas landscape 16:9
            isPortrait = true;
            detectedAspect = "16:9";
            log.info(`PDF terdeteksi berorientasi portrait (rasio ${ratio.toFixed(2)}). Disesuaikan ke kanvas landscape 16:9.`);
          } else if (ratio < 1.5) {
            // Dokumen landscape 4:3 klasik (~1.33)
            isPortrait = false;
            detectedAspect = "4:3";
            log.info(`PDF terdeteksi berorientasi landscape 4:3 (rasio ${ratio.toFixed(2)}).`);
          } else {
            // Dokumen landscape 16:9 layar lebar (~1.77)
            isPortrait = false;
            detectedAspect = "16:9";
            log.info(`PDF terdeteksi berorientasi landscape 16:9 (rasio ${ratio.toFixed(2)}).`);
          }
        }
        const dims = detectedAspect === "4:3" ? LANDSCAPE_4_3 : LANDSCAPE_16_9;
        canvasWidth = dims.width;
        canvasHeight = dims.height;
        pageRenderer = createLandscapePageRenderer(canvasWidth, canvasHeight, isPortrait);
      }

      // 2. Ekstrak teks halaman untuk judul dan kata kunci
      let pageText = "";
      try {
        pageText = page.getText() || "";
      } catch {
        pageText = "";
      }

      const pageTitle = extractTitleFromText(pageText, pageNumber);
      const keywords = extractKeywordsFromText(pageText, pageTitle);

      // 3. Render halaman menjadi gambar latar JPEG resolusi landscape (1920x1080 atau 1440x1080)
      const rendered = await page.render({
        scale: 2.0, // Skala 2x agar teks dan detail vektor tajam
        render: pageRenderer,
      });

      const fileName = `slide-${pageNumber}.jpg`;
      const destPath = path.join(outDir, fileName);

      // Simpan gambar langsung ke folder assets proyek
      await fs.writeFile(destPath, Buffer.from(rendered.data));
      backgroundFiles.push(destPath);

      slides.push({
        pageNumber,
        imageFileName: fileName,
        imagePath: `assets/${fileName}`,
        title: pageTitle,
        text: pageText,
        keywords,
      });

      // Lepaskan alokasi memori halaman PDFium setelah selesai
      page.close();
    }

    log.info(`Berhasil merender ${slides.length} gambar latar slide dari PDF.`);

    return {
      slideCount,
      aspect: detectedAspect,
      slides,
      backgroundFiles,
    };
  } finally {
    // Pastikan sumber daya memori WebAssembly dibersihkan
    if (document) {
      try {
        document.destroy();
      } catch {
        // Abaikan pembersihan dokumen jika sudah tertutup
      }
    }
    library.destroy();
  }
}
