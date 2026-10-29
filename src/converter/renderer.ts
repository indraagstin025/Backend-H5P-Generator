import { execFile } from "node:child_process";
import { existsSync, promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { unzipSync } from "fflate";
import sharp from "sharp";
import { convertToPngZip, isOnlyOfficeConfigured } from "./onlyoffice.js";
import { convertPdfToSlides } from "./pdfRenderer.js";
import { createLogger } from "../utils/logger.js";

const execFileAsync = promisify(execFile);
const log = createLogger("render");

export interface RendererAvailability {
  onlyoffice: boolean;
  powerpoint: boolean;
}

/** Renderer tersedia bila ONLYOFFICE_URL disetel (cek cepat tanpa request). */
export async function detectRenderers(): Promise<RendererAvailability> {
  return { onlyoffice: isOnlyOfficeConfigured(), powerpoint: isPowerPointAvailable() };
}

const POWERPNT_CANDIDATES = [
  "C:\\Program Files\\Microsoft Office\\Root\\Office16\\POWERPNT.EXE",
  "C:\\Program Files (x86)\\Microsoft Office\\Root\\Office16\\POWERPNT.EXE",
  "C:\\Program Files\\Microsoft Office\\Office16\\POWERPNT.EXE",
  "C:\\Program Files (x86)\\Microsoft Office\\Office16\\POWERPNT.EXE",
  "C:\\Program Files\\Microsoft Office\\Root\\Office15\\POWERPNT.EXE",
  "C:\\Program Files (x86)\\Microsoft Office\\Root\\Office15\\POWERPNT.EXE",
];

/** PowerPoint terinstal (Windows + POWERPNT.EXE ketemu). Tanpa dependensi baru. */
export function isPowerPointAvailable(): boolean {
  if (process.platform !== "win32") return false;
  return POWERPNT_CANDIDATES.some((p) => {
    try {
      return existsSync(p);
    } catch {
      return false;
    }
  });
}

const PP_TIMEOUT_MS = 180_000;
const PP_WIDTH = 1920;

function psQuote(s: string): string {
  return `'${s.replace(/'/g, "''")}'`;
}

/**
 * Skrip render via COM automation. Aturan aman (hasil probe):
 * - TIDAK PERNAH menyentuh $app.Visible (bisa menempel ke instance user).
 * - Buka file ReadOnly + WithWindow=0 (tanpa jendela).
 * - Quit HANYA bila saat ditempel tidak ada presentasi terbuka milik user.
 */
const RENDER_PS = `
$ErrorActionPreference = 'Stop'
$src = __SRC__
$outDir = __OUT__
$targetWidth = __WIDTH__
$pres = $null
$hadOpen = $false
$oldAlerts = 2
$app = New-Object -ComObject PowerPoint.Application
try {
  $hadOpen = $app.Presentations.Count -gt 0
  $oldAlerts = $app.DisplayAlerts
  # ppAlertsNone=1 (bukan 0!), ppAlertsAll=2
  $app.DisplayAlerts = 1
  $pres = $app.Presentations.Open($src, $true, $false, $false)
  try {
    $sw = $pres.PageSetup.SlideWidth
    $sh = $pres.PageSetup.SlideHeight
    $targetHeight = [int][Math]::Round($targetWidth * $sh / $sw)
    $i = 0
    foreach ($slide in $pres.Slides) {
      $i++
      $dest = Join-Path $outDir ('slide-{0}.png' -f $i)
      $slide.Export($dest, 'PNG', $targetWidth, $targetHeight)
    }
    Write-Output ('EXPORTED:' + $i)
  } finally {
    if ($pres -ne $null) { $pres.Close() }
  }
  if (-not $hadOpen) { $app.Quit() }
} catch {
  try { if ($pres -ne $null) { $pres.Close() } } catch { }
  try { if (-not $hadOpen) { $app.Quit() } } catch { }
  Write-Output ('PP-ERROR:' + $_.Exception.Message)
  exit 1
} finally {
  try { if ($hadOpen) { $app.DisplayAlerts = $oldAlerts } } catch { }
}
`;

/** Bersih-bersih bila render timeout: quit hanya bila yang terbuka cuma file kita. */
const CLEANUP_PS = `
$ErrorActionPreference = 'SilentlyContinue'
$src = __SRC__
$app = New-Object -ComObject PowerPoint.Application
$quit = $false
if ($app.Presentations.Count -eq 0) { $quit = $true }
elseif ($app.Presentations.Count -eq 1) {
  $only = $app.Presentations.Item(1)
  if ($only.FullName -eq $src) { $only.Close(); $quit = $true }
}
if ($quit) { $app.Quit() }
Write-Output 'CLEANED'
`;

function fillPs(template: string, src: string, out: string): string {
  return template
    .replace("__SRC__", psQuote(src))
    .replace("__OUT__", psQuote(out))
    .replace("__WIDTH__", String(PP_WIDTH));
}

async function runPs(script: string, timeoutMs: number): Promise<string> {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "pp-ps-"));
  const file = path.join(dir, "render.ps1");
  try {
    await fs.writeFile(file, script, "utf8");
    const { stdout } = await execFileAsync(
      "powershell.exe",
      ["-NoProfile", "-ExecutionPolicy", "Bypass", "-File", file],
      { timeout: timeoutMs, maxBuffer: 4 * 1024 * 1024 },
    );
    return stdout;
  } finally {
    await fs.rm(dir, { recursive: true, force: true }).catch(() => undefined);
  }
}

/** PNG → JPG 1920px (kualitas sama dengan jalur OnlyOffice). */
async function pngsToJpg(pngFiles: string[], outDir: string): Promise<string[]> {
  const files: string[] = [];
  let n = 0;
  const ordered = [...pngFiles].sort((a, b) =>
    a.localeCompare(b, undefined, { numeric: true }),
  );
  for (const png of ordered) {
    n += 1;
    const dest = path.join(outDir, `slide-${n}.jpg`);
    await sharp(png)
      .resize({ width: PP_WIDTH, withoutEnlargement: false })
      .jpeg({ quality: 82 })
      .toFile(dest);
    files.push(dest);
  }
  return files;
}

/**
 * Render tiap slide .pptx jadi PNG via PowerPoint (COM, tanpa jendela),
 * lalu normalisasi ke JPG. Melempar Error santai bila gagal.
 */
export async function renderWithPowerPoint(
  sourcePath: string,
  outDir: string,
): Promise<string[]> {
  if (!isPowerPointAvailable()) throw new Error("PowerPoint tidak ketemu di komputer ini.");
  const pngDir = await fs.mkdtemp(path.join(os.tmpdir(), "pp-png-"));
  try {
    let stdout: string;
    try {
      stdout = await runPs(fillPs(RENDER_PS, sourcePath, pngDir), PP_TIMEOUT_MS);
    } catch (err) {
      // Timeout / crash: sapu proses yatim milik kita, jangan sentuh instance user.
      await runPs(fillPs(CLEANUP_PS, sourcePath, pngDir), 30_000).catch(() => undefined);
      if ((err as NodeJS.ErrnoException)?.code === "ETIMEDOUT" || /timed out/i.test((err as Error)?.message ?? "")) {
        throw new Error("PowerPoint kelamaan me-render (batas 3 menit), coba kecilkan file.");
      }
      throw new Error("PowerPoint tidak bisa membuka file ini.");
    }
    const errLine = stdout.split(/\r?\n/).find((l) => l.startsWith("PP-ERROR:"));
    if (errLine) throw new Error("PowerPoint tidak bisa membuka file ini.");
    const exported = Number((stdout.match(/EXPORTED:(\d+)/) ?? [])[1] ?? 0);
    if (!Number.isFinite(exported) || exported < 1) {
      throw new Error("Tidak ada slide yang bisa di-render PowerPoint.");
    }
    const pngs = (await fs.readdir(pngDir))
      .filter((f) => /^slide-\d+\.png$/i.test(f))
      .map((f) => path.join(pngDir, f));
    if (pngs.length === 0) throw new Error("Hasil render PowerPoint kosong.");
    return await pngsToJpg(pngs, outDir);
  } finally {
    await fs.rm(pngDir, { recursive: true, force: true }).catch(() => undefined);
  }
}

/**
 * Render latar tiap halaman menjadi JPG 1920px.
 * Prioritas alur:
 * - PPTX: PowerPoint COM langsung di Windows → OnlyOffice (server/Docker).
 * - PDF : WebAssembly PDFium lokal (tanpa dependensi luar) → OnlyOffice (server/Docker).
 * Kegagalan total = available=false (latar pending).
 */
export async function renderBackgrounds(
  sourcePath: string,
  outDir: string,
  ext: string,
): Promise<{ available: boolean; files: string[] }> {
  // Jalur khusus PPTX: gunakan PowerPoint bawaan Windows jika tersedia
  if (ext === ".pptx" && isPowerPointAvailable()) {
    try {
      const files = await renderWithPowerPoint(sourcePath, outDir);
      return { available: true, files };
    } catch (err) {
      log.warn("PowerPoint gagal, lanjut OnlyOffice", err instanceof Error ? err.message : err);
    }
  }

  // Jalur khusus PDF: gunakan engine WebAssembly PDFium lokal tanpa ketergantungan OnlyOffice
  if (ext === ".pdf") {
    try {
      const pdfResult = await convertPdfToSlides(sourcePath, outDir);
      return { available: true, files: pdfResult.backgroundFiles };
    } catch (err) {
      log.warn("Konversi PDF via PDFium gagal, coba fallback OnlyOffice", err instanceof Error ? err.message : err);
    }
  }

  // Fallback cadangan: OnlyOffice Document Server jika sudah dikonfigurasi
  if (!isOnlyOfficeConfigured()) return { available: false, files: [] };
  const filetype = ext === ".pdf" ? "pdf" : "pptx";
  const fileName = path.basename(sourcePath);
  const zip = await convertToPngZip(sourcePath, fileName, filetype);
  const entries = unzipSync(new Uint8Array(zip));
  const pages = Object.keys(entries)
    .filter((k) => k.toLowerCase().endsWith(".png"))
    .sort();
  if (pages.length === 0) throw new Error("Hasil konversi tidak berisi gambar.");

  const files: string[] = [];
  let n = 0;
  for (const page of pages) {
    n += 1;
    const dest = path.join(outDir, `slide-${n}.jpg`);
    await sharp(Buffer.from(entries[page]))
      .resize({ width: 1920, withoutEnlargement: false })
      .jpeg({ quality: 82 })
      .toFile(dest);
    files.push(dest);
  }
  return { available: true, files };
}

const IMAGE_MIME: Record<string, string> = {
  png: "image/png",
  jpg: "image/jpeg",
  jpeg: "image/jpeg",
  gif: "image/gif",
  svg: "image/svg+xml",
};

/**
 * Optimasi media hasil ekstraksi (NFR-02): batasi lebar 1600px,
 * kompres JPEG/PNG. GIF/SVG dilewatkan apa adanya.
 */
export async function optimizeImage(
  bytes: Uint8Array,
  ext: string,
): Promise<{ bytes: Uint8Array; ext: string; mime: string }> {
  const lower = ext.toLowerCase();
  if (lower === "gif" || lower === "svg") {
    return { bytes, ext: lower, mime: IMAGE_MIME[lower] ?? "application/octet-stream" };
  }
  try {
    if (lower === "png") {
      const out = await sharp(bytes).resize({ width: 1600, withoutEnlargement: true }).png({ compressionLevel: 9 }).toBuffer();
      return { bytes: new Uint8Array(out), ext: "png", mime: IMAGE_MIME.png };
    }
    const out = await sharp(bytes).resize({ width: 1600, withoutEnlargement: true }).jpeg({ quality: 82 }).toBuffer();
    return { bytes: new Uint8Array(out), ext: "jpg", mime: IMAGE_MIME.jpg };
  } catch {
    return { bytes, ext: lower, mime: IMAGE_MIME[lower] ?? "application/octet-stream" };
  }
}
