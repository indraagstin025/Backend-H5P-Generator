/**
 * SALINAN sinkron dari frontend (SINKRONISASI MANUAL — lihat SYNC.md).
 * Jangan ubah logika di sini; ubah di frontend lalu salin ulang.
 *
 * Parser .pptx lokal (FR-02/FR-03 + interaktivitas non-AI):
 * judul, hyperlink antar-slide, speaker notes, media ter-embed + posisi,
 * dan penanda konvensi ([ke:N], [kuis], [narasi], [sembunyi]).
 * Berjalan di browser via unzip (fflate) + DOMParser — tanpa backend,
 * tanpa API eksternal (NFR-03). Modul murni: siap dipindah ke backend.
 */
import { strFromU8, unzipSync } from 'fflate';

export interface PptxHotlink {
  label: string;
  targetOrder: number;
  x: number;
  y: number;
  width: number;
  height: number;
}

export interface PptxMedia {
  fileName: string;
  ext: string;
  bytes: Uint8Array;
  x: number;
  y: number;
  width: number;
  height: number;
  alt: string;
}

export interface PptxSlideInfo {
  order: number;
  title: string;
  hyperlinks: PptxHotlink[];
  /** Paragraf speaker notes (sudah bersih dari penanda). */
  notes: string[];
  images: PptxMedia[];
  audios: PptxMedia[];
  /** True bila ada penanda [kuis] / [kuis-pg] di slide. */
  quizDraft: boolean;
}

export interface PptxInfo {
  slideCount: number;
  titles: string[];
  aspect: '16:9' | '4:3';
  slides: PptxSlideInfo[];
}

const NS_P = 'http://schemas.openxmlformats.org/presentationml/2006/main';
const NS_A = 'http://schemas.openxmlformats.org/drawingml/2006/main';
const NS_R = 'http://schemas.openxmlformats.org/officeDocument/2006/relationships';
const NS_PKG = 'http://schemas.openxmlformats.org/package/2006/relationships';

const IMG_EXTS = ['png', 'jpg', 'jpeg', 'gif', 'svg'];
const AUD_EXTS = ['mp3', 'wav'];

const MARKER_RE = /\[(ke:\d+|kuis-pg|kuis|narasi|sembunyi)\]/gi;

function parseXml(xml: string): Document | null {
  // Tidak boleh melempar error: satu bagian cacat tidak boleh
  // menggugurkan seluruh ingest (cukup bagian itu dilewati).
  // console.error dibisukan sesaat karena xmldom mencetak fatalError ke console.
  const origError = console.error;
  console.error = () => undefined;
  try {
    const doc = new DOMParser().parseFromString(xml, 'application/xml');
    return doc.getElementsByTagName('parsererror').length > 0 ? null : doc;
  } catch {
    return null;
  } finally {
    console.error = origError;
  }
}

function local(el: Element): string {
  const t = el.tagName;
  const i = t.indexOf(':');
  return i < 0 ? t : t.slice(i + 1);
}

function relIdOf(el: Element): string {
  return el.getAttributeNS(NS_R, 'id') ?? el.getAttribute('r:id') ?? '';
}

function stripMarkers(text: string): { markers: string[]; clean: string } {
  const found = text.match(MARKER_RE) ?? [];
  const markers = found.map((s) => s.slice(1, -1).toLowerCase());
  // Pertahankan \n (batas paragraf notes), hanya rapikan spasi horizontal
  const clean = text
    .replace(MARKER_RE, '')
    .split('\n')
    .map((line) => line.replace(/[^\S\n]+/g, ' ').trim())
    .join('\n')
    .trim();
  return { markers, clean };
}

/** Paragraf teks sebuah shape (satu string per <a:p>). */
function shapeParagraphs(shape: Element): string[] {
  const out: string[] = [];
  const paras = Array.from(shape.getElementsByTagNameNS(NS_A, 'p'));
  for (const p of paras) {
    const runs = Array.from(p.getElementsByTagNameNS(NS_A, 't'));
    const text = runs.map((r) => r.textContent ?? '').join('').replace(/\s+/g, ' ').trim();
    if (text) out.push(text);
  }
  return out;
}

/** Nama + deskripsi dari p:cNvPr (untuk alt media & penanda). */
function cnvMeta(shape: Element): { name: string; descr: string } {
  const cnv = shape.getElementsByTagNameNS(NS_P, 'cNvPr')[0];
  return {
    name: cnv?.getAttribute('name') ?? '',
    descr: cnv?.getAttribute('descr') ?? '',
  };
}

/** Kotak shape dalam persen kanvas (dari a:xfrm EMU). */
function shapeBox(
  shape: Element,
  sldW: number,
  sldH: number,
): { x: number; y: number; width: number; height: number } | null {
  const xfrm = shape.getElementsByTagNameNS(NS_A, 'xfrm')[0];
  if (!xfrm) return null;
  const off = xfrm.getElementsByTagNameNS(NS_A, 'off')[0];
  const ext = xfrm.getElementsByTagNameNS(NS_A, 'ext')[0];
  if (!off || !ext) return null;
  const x = Number(off.getAttribute('x') ?? NaN);
  const y = Number(off.getAttribute('y') ?? NaN);
  const cx = Number(ext.getAttribute('cx') ?? NaN);
  const cy = Number(ext.getAttribute('cy') ?? NaN);
  if (![x, y, cx, cy].every(Number.isFinite) || cx <= 0 || cy <= 0) return null;
  const r = (v: number) => Math.round(v * 100) / 100;
  return { x: r((x / sldW) * 100), y: r((y / sldH) * 100), width: r((cx / sldW) * 100), height: r((cy / sldH) * 100) };
}

function ownerShape(el: Element): Element | null {
  // parentNode (bukan parentElement) agar kompatibel DOMParser mana pun
  let cur = el.parentNode as Element | null;
  while (cur && cur.nodeType === 1) {
    const l = local(cur);
    if (l === 'sp' || l === 'cxnSp' || l === 'pic' || l === 'graphicFrame') return cur;
    if (l === 'sld' || l === 'cSld') return null;
    cur = cur.parentNode as Element | null;
  }
  return null;
}

interface RelEntry {
  type: string;
  target: string;
}

function relsOf(entries: Record<string, Uint8Array>, slideKey: string): Map<string, RelEntry> {
  const map = new Map<string, RelEntry>();
  const relsKey = slideKey.replace('ppt/slides/', 'ppt/slides/_rels/') + '.rels';
  const raw = entries[relsKey];
  if (!raw) return map;
  const doc = parseXml(strFromU8(raw));
  if (!doc) return map;
  const rels = Array.from(doc.getElementsByTagNameNS(NS_PKG, 'Relationship'));
  for (const r of rels) {
    const id = r.getAttribute('Id') ?? '';
    const type = r.getAttribute('Type') ?? '';
    const target = r.getAttribute('Target') ?? '';
    if (id && type && target) map.set(id, { type, target });
  }
  return map;
}

function baseName(path: string): string {
  return path.split('/').pop() ?? path;
}

function cleanFileName(name: string): string {
  const base = baseName(name);
  return base.replace(/[^a-zA-Z0-9._-]+/g, '-').replace(/-+/g, '-');
}

function extOf(name: string): string {
  return name.split('.').pop()?.toLowerCase() ?? '';
}

function textsOf(slideXml: string): string[] {
  const doc = parseXml(slideXml);
  if (!doc) return [];
  const shapes = Array.from(doc.getElementsByTagNameNS(NS_P, 'sp'));
  const out: Array<{ titleLike: boolean; text: string }> = [];
  for (const sp of shapes) {
    const ph = sp.getElementsByTagNameNS(NS_P, 'ph')[0];
    const phType = ph?.getAttribute('type') ?? null;
    const text = shapeParagraphs(sp).join(' ').replace(/\s+/g, ' ').trim();
    if (!text) continue;
    out.push({ titleLike: phType === 'title' || phType === 'ctrTitle', text: stripMarkers(text).clean });
  }
  out.sort((a, b) => Number(b.titleLike) - Number(a.titleLike));
  return out.map((o) => o.text).filter((t) => t.length > 0);
}

function extractHyperlinks(
  doc: Document,
  rels: Map<string, RelEntry>,
  orderOfFile: Map<string, number>,
  sldW: number,
  sldH: number,
): PptxHotlink[] {
  const out: PptxHotlink[] = [];
  const seen = new Set<string>();
  const clicks = Array.from(doc.getElementsByTagNameNS(NS_A, 'hlinkClick'));
  for (const click of clicks) {
    const rid = relIdOf(click);
    const rel = rels.get(rid);
    const action = click.getAttribute('action') ?? '';
    const isSlideJump = action.includes('hlinksldjump') || (rel && rel.type.endsWith('/slide'));
    if (!isSlideJump || !rel) continue;
    const targetOrder = orderOfFile.get(baseName(rel.target));
    if (!targetOrder) continue;

    const owner = ownerShape(click);
    if (!owner) continue;
    const rawText = shapeParagraphs(owner).join(' ');
    const { markers, clean } = stripMarkers(rawText);
    if (markers.includes('sembunyi')) continue;
    const keMarker = markers.find((m) => m.startsWith('ke:'));
    const finalTarget = keMarker ? Number(keMarker.slice(3)) : targetOrder;
    if (!Number.isFinite(finalTarget) || finalTarget < 1) continue;

    const box = shapeBox(owner, sldW, sldH);
    if (!box) continue;
    const label = clean.slice(0, 60) || `Ke Slide ${finalTarget}`;
    const key = `${finalTarget}|${box.x},${box.y},${box.width},${box.height}`;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push({ label, targetOrder: finalTarget, ...box });
  }
  return out;
}

function extractMedia(
  doc: Document,
  rels: Map<string, RelEntry>,
  entries: Record<string, Uint8Array>,
  sldW: number,
  sldH: number,
): { images: PptxMedia[]; audios: PptxMedia[] } {
  const images: PptxMedia[] = [];
  const audios: PptxMedia[] = [];
  const pics = Array.from(doc.getElementsByTagNameNS(NS_P, 'pic'));
  for (const pic of pics) {
    const meta = cnvMeta(pic);
    const { markers } = stripMarkers(`${meta.name} ${meta.descr}`);
    if (markers.includes('sembunyi')) continue;
    const box = shapeBox(pic, sldW, sldH);
    if (!box) continue;

    // Audio: poster frame membawa a:audioFile
    const audioFile = pic.getElementsByTagNameNS(NS_A, 'audioFile')[0];
    if (audioFile) {
      const rel = rels.get(relIdOf(audioFile));
      const ext = rel ? extOf(rel.target) : '';
      const bytes = rel ? entries[`ppt/media/${baseName(rel.target)}`] : undefined;
      if (rel && bytes && AUD_EXTS.includes(ext)) {
        audios.push({
          fileName: cleanFileName(rel.target),
          ext,
          bytes,
          ...box,
          alt: meta.descr || meta.name,
        });
      }
      continue;
    }

    const blip = pic.getElementsByTagNameNS(NS_A, 'blip')[0];
    if (!blip) continue;
    const rel = rels.get(relIdOf(blip));
    const ext = rel ? extOf(rel.target) : '';
    const bytes = rel ? entries[`ppt/media/${baseName(rel.target)}`] : undefined;
    if (rel && bytes && IMG_EXTS.includes(ext)) {
      images.push({
        fileName: cleanFileName(rel.target),
        ext,
        bytes,
        ...box,
        alt: meta.descr || meta.name || cleanFileName(rel.target),
      });
    }
  }
  return { images, audios };
}

function extractNotes(
  rels: Map<string, RelEntry>,
  entries: Record<string, Uint8Array>,
): string[] {
  for (const [, rel] of rels) {
    if (!rel.type.endsWith('/notesSlide')) continue;
    const raw = entries[`ppt/notesSlides/${baseName(rel.target)}`];
    if (!raw) continue;
    const doc = parseXml(strFromU8(raw));
    if (!doc) continue;
    const shapes = Array.from(doc.getElementsByTagNameNS(NS_P, 'sp'));
    const bodies: string[][] = [];
    const others: string[][] = [];
    for (const sp of shapes) {
      const ph = sp.getElementsByTagNameNS(NS_P, 'ph')[0];
      const paras = shapeParagraphs(sp);
      if (paras.length === 0) continue;
      if ((ph?.getAttribute('type') ?? '') === 'body') bodies.push(paras);
      else others.push(paras);
    }
    const picked = bodies.length > 0 ? bodies.flat() : others.flat();
    const { markers, clean } = stripMarkers(picked.join('\n'));
    if (markers.includes('sembunyi')) return [];
    return clean
      .split('\n')
      .map((s) => s.trim())
      .filter((s) => s.length > 0);
  }
  return [];
}

function slideHasQuizDraft(doc: Document | null): boolean {
  if (!doc) return false;
  const texts = Array.from(doc.getElementsByTagNameNS(NS_A, 't'))
    .map((t) => t.textContent ?? '')
    .join(' ');
  return /\[(kuis-pg|kuis)\]/i.test(texts);
}

export async function inspectPptx(file: File): Promise<PptxInfo> {
  const bytes = new Uint8Array(await file.arrayBuffer());
  const entries = unzipSync(bytes);
  const slideKeys = Object.keys(entries)
    .filter((k) => /^ppt\/slides\/slide\d+\.xml$/.test(k))
    .sort((a, b) => {
      const na = Number(a.match(/slide(\d+)\.xml/)?.[1] ?? 0);
      const nb = Number(b.match(/slide(\d+)\.xml/)?.[1] ?? 0);
      return na - nb;
    });
  if (slideKeys.length === 0) throw new Error('Tidak ada slide terbaca dari berkas .pptx ini.');

  // Urutan baca sesuai urutan presentasi bila tersedia
  let orderedKeys = slideKeys;
  let sldW = 9144000;
  let sldH = 5143500;
  let aspect: '16:9' | '4:3' = '16:9';
  try {
    const presRaw = entries['ppt/presentation.xml'];
    if (presRaw) {
      const doc = parseXml(strFromU8(presRaw));
      const sldIds = doc ? Array.from(doc.getElementsByTagNameNS(NS_P, 'sldId')) : [];
      const sz = doc?.getElementsByTagNameNS(NS_P, 'sldSz')[0];
      const cx = Number(sz?.getAttribute('cx') ?? 0);
      const cy = Number(sz?.getAttribute('cy') ?? 1);
      if (cx > 0 && cy > 0) {
        sldW = cx;
        sldH = cy;
        const ratio = cx / cy;
        aspect = Math.abs(ratio - 16 / 9) <= Math.abs(ratio - 4 / 3) ? '16:9' : '4:3';
      }
      const relsRaw = entries['ppt/_rels/presentation.xml.rels'];
      if (relsRaw && sldIds.length === slideKeys.length) {
        const relsDoc = parseXml(strFromU8(relsRaw));
        const relMap = new Map<string, string>();
        const rels = relsDoc ? Array.from(relsDoc.getElementsByTagNameNS(NS_PKG, 'Relationship')) : [];
        for (const r of rels) {
          const id = r.getAttribute('Id') ?? '';
          const target = r.getAttribute('Target') ?? '';
          if (id && target) relMap.set(id, target.replace(/^slides\//, ''));
        }
        const ordered = sldIds
          .map((s) => s.getAttributeNS(NS_R, 'id') ?? s.getAttribute('r:id') ?? '')
          .map((rid) => (relMap.get(rid) ? `ppt/slides/${relMap.get(rid)}` : ''))
          .filter((k) => k && entries[k]);
        if (ordered.length === slideKeys.length) orderedKeys = ordered;
      }
    }
  } catch {
    orderedKeys = slideKeys;
  }

  const orderOfFile = new Map<string, number>();
  orderedKeys.forEach((key, idx) => orderOfFile.set(baseName(key), idx + 1));

  const slides: PptxSlideInfo[] = orderedKeys.map((key, idx) => {
    const order = idx + 1;
    const xml = strFromU8(entries[key]);
    const doc = parseXml(xml);
    const texts = textsOf(xml);
    const rels = relsOf(entries, key);
    if (!doc) {
      return { order, title: texts[0] ?? `Slide ${order}`, hyperlinks: [], notes: [], images: [], audios: [], quizDraft: false };
    }
    return {
      order,
      title: texts[0] ?? `Slide ${order}`,
      hyperlinks: extractHyperlinks(doc, rels, orderOfFile, sldW, sldH),
      notes: extractNotes(rels, entries),
      ...extractMedia(doc, rels, entries, sldW, sldH),
      quizDraft: slideHasQuizDraft(doc),
    };
  });

  return {
    slideCount: orderedKeys.length,
    titles: slides.map((s) => s.title),
    aspect,
    slides,
  };
}
