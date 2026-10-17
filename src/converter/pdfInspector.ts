/**
 * SALINAN sinkron dari frontend (SINKRONISASI MANUAL — lihat SYNC.md).
 * Jangan ubah logika di sini; ubah di frontend lalu salin ulang.
 *
 * Inspeksi .pdf lokal (FR-02/FR-03): hitung halaman tanpa backend.
 * Heuristik jumlah objek /Type /Page; fallback estimasi ukuran.
 * Judul per halaman tidak tersedia tanpa render — panel keywords
 * tetap bisa diedit manual (FR-03 Should Have).
 */

export interface PdfInfo {
  pageCount: number;
  estimated: boolean;
}

export async function inspectPdf(file: File): Promise<PdfInfo> {
  try {
    const buffer = await file.arrayBuffer();
    const bytes = new Uint8Array(buffer);
    // Baca sebagai latin1 agar regex stabil untuk file biner
    let text = '';
    const CHUNK = 1 << 20;
    for (let i = 0; i < bytes.length; i += CHUNK) {
      text += String.fromCharCode(...bytes.subarray(i, i + CHUNK));
    }
    const matches = text.match(/\/Type\s*\/Page[^s]/g);
    const count = matches ? matches.length : 0;
    if (count > 0 && count <= 2000) return { pageCount: count, estimated: false };
  } catch {
    // abaikan, pakai estimasi
  }
  const estimated = Math.min(60, Math.max(1, Math.round(file.size / (120 * 1024))));
  return { pageCount: estimated, estimated: true };
}
