/**
 * SALINAN sinkron dari frontend (SINKRONISASI MANUAL — lihat SYNC.md).
 * Jangan ubah logika di sini; ubah di frontend lalu salin ulang.
 *
 * Konverter PPTX → slide H5P (frontend-only, modul murni).
 * Hyperlink jadi hotspot, notes jadi dialog, media ter-embed jadi
 * elemen berposisi, penanda [kuis] jadi draf soal.
 * Backend menyusul: modul ini dipindah mentah ke Node (API fflate sama).
 */
import { createElement, createSlide } from "./h5pModel";
import type { Slide } from "./h5pModel";
import type { PptxInfo } from "./pptxParser";

export interface PptxCounts {
  hotspots: number;
  notes: number;
  media: number;
  quizzes: number;
}

const MIME: Record<string, string> = {
  png: 'image/png',
  jpg: 'image/jpeg',
  jpeg: 'image/jpeg',
  gif: 'image/gif',
  svg: 'image/svg+xml',
  mp3: 'audio/mpeg',
  wav: 'audio/wav',
};

function escapeHtml(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

export function buildSlidesFromPptx(info: PptxInfo): { slides: Slide[]; counts: PptxCounts } {
  const n = info.slides.length;
  const counts: PptxCounts = { hotspots: 0, notes: 0, media: 0, quizzes: 0 };

  const slides = info.slides.map((ps) => {
    const slide = createSlide(ps.order, ps.title, info.aspect);

    for (const h of ps.hyperlinks) {
      const el = createElement('goToSlide', n);
      el.label = h.label || `Ke Slide ${h.targetOrder}`;
      el.targetType = 'specified';
      el.targetSlide = Math.min(n, Math.max(1, h.targetOrder));
      el.position = {
        x: h.x,
        y: h.y,
        width: Math.max(10, Math.min(100 - h.x, h.width)),
        height: Math.max(7, Math.min(100 - h.y, h.height)),
      };
      slide.elements.push(el);
      counts.hotspots += 1;
    }

    if (ps.notes.length > 0) {
      const el = createElement('advancedText', n);
      el.title = 'Catatan pemateri';
      el.text = ps.notes.map((p) => `<p>${escapeHtml(p)}</p>`).join('');
      el.position = { x: 8, y: 62, width: 46, height: 30 };
      slide.elements.push(el);
      counts.notes += 1;
    }

    for (const m of ps.images) {
      const el = createElement('image', n);
      const file = new File([m.bytes as BlobPart], m.fileName, { type: MIME[m.ext] ?? 'application/octet-stream' });
      el.file = file;
      el.fileName = m.fileName;
      el.objectUrl = URL.createObjectURL(file);
      el.alt = m.alt;
      el.position = { x: m.x, y: m.y, width: m.width, height: m.height };
      slide.elements.push(el);
      counts.media += 1;
    }

    for (const m of ps.audios) {
      const el = createElement('audio', n);
      const file = new File([m.bytes as BlobPart], m.fileName, { type: MIME[m.ext] ?? 'application/octet-stream' });
      el.file = file;
      el.fileName = m.fileName;
      el.objectUrl = URL.createObjectURL(file);
      el.position = { x: m.x, y: m.y, width: Math.max(24, m.width), height: Math.max(9, m.height) };
      slide.elements.push(el);
      counts.media += 1;
    }

    if (ps.quizDraft) {
      const el = createElement('multiChoice', n);
      el.title = 'Kuis (draf otomatis)';
      el.question = `Apa poin utama dari "${ps.title}"?`;
      slide.elements.push(el);
      counts.quizzes += 1;
    }

    return slide;
  });

  return { slides, counts };
}
