/**
 * SALINAN logika dari frontend (SINKRONISASI MANUAL — lihat converter/SYNC.md):
 * frontend/src/features/exporter/api/h5pPackager.ts
 * (toCpElement/toAction/toContentJson) diadaptasi ke data slide server
 * (aset = path disk, bukan File/Blob).
 *
 * Semua 22 ElementKind dipetakan ke library action yang sama dengan frontend,
 * termasuk perbaikan penting:
 *  - blanks: `questions` berisi teks soal bertanda *jawaban* (bukan daftar jawaban)
 *  - multiChoice: memakai `behaviour.type` (single/multi), bukan `singleAnswer`
 *  - multimediaChoice -> H5P.MultiChoice, interactiveVideo -> H5P.Video
 */
import type { ElementKind } from "../converter/h5pModel.js";
import { getH5P, installedLibraryVersion } from "./h5pService.js";

export interface StoredPosition {
  x: number;
  y: number;
  width: number;
  height: number;
}

export interface StoredElement extends Record<string, unknown> {
  id: string;
  kind: ElementKind | string;
  position: StoredPosition;
  displayAsButton: boolean;
  buttonLabel: string;
  title: string;
}

export interface StoredSlide {
  order: number;
  title: string;
  chapter: string;
  tone: string;
  aspect: string;
  keywords: Array<{ main: string; subs: string[] }>;
  background: string | null;
  backgroundPending: boolean;
  elements: StoredElement[];
}

export interface CoursePresentationElement {
  x: number;
  y: number;
  width: number;
  height: number;
  action?: unknown;
  title?: string;
  displayAsButton?: boolean;
  buttonLabel?: string;
  buttonSize?: string;
  goToSlide?: number;
  goToSlideType?: string;
  invisible?: boolean;
  [key: string]: unknown;
}

const IMAGE_MIME: Record<string, string> = {
  png: "image/png",
  jpg: "image/jpeg",
  jpeg: "image/jpeg",
  gif: "image/gif",
  svg: "image/svg+xml",
  webp: "image/webp",
};
const AUDIO_MIME: Record<string, string> = {
  mp3: "audio/mpeg",
  wav: "audio/wav",
  ogg: "audio/ogg",
  m4a: "audio/mp4",
};
const VIDEO_MIME: Record<string, string> = {
  mp4: "video/mp4",
  m4v: "video/mp4",
  webm: "video/webm",
  ogv: "video/ogg",
  ogg: "video/ogg",
};

type MediaKind = "image" | "audio" | "video";

function extOf(filePath: string): string {
  const clean = filePath.split("?")[0].split("#")[0];
  return (clean.split(".").pop() ?? "").toLowerCase();
}

function mimeFor(kind: string, assetPath: string): string {
  const map = kind === "audio" ? AUDIO_MIME : kind === "video" ? VIDEO_MIME : IMAGE_MIME;
  return map[extOf(assetPath)] ?? "application/octet-stream";
}

function fileRef(filePath: string, mime: string, title: string) {
  return { path: filePath, mime, copyright: { license: "U" }, title };
}

function clampPct(n: unknown): number {
  const v = typeof n === "number" && Number.isFinite(n) ? n : 0;
  return Math.round(Math.min(100, Math.max(0, v)) * 100) / 100;
}

function behaviourOf(el: Record<string, unknown>, extra: Record<string, unknown> = {}) {
  return {
    enableRetry: el.enableRetry !== false,
    enableSolutionsButton: el.showSolution !== false,
    ...extra,
  };
}

function str(v: unknown, fallback = ""): string {
  return typeof v === "string" ? v : fallback;
}

function bool(v: unknown, fallback = false): boolean {
  return typeof v === "boolean" ? v : fallback;
}

function num(v: unknown, fallback: number): number {
  return typeof v === "number" && Number.isFinite(v) ? v : fallback;
}

function arr<T>(v: unknown): T[] {
  return Array.isArray(v) ? (v as T[]) : [];
}

function optionsOf(el: StoredElement): Array<{ text: string; correct: boolean }> {
  return arr<Record<string, unknown>>(el.options).map((o) => ({
    text: str(o.text),
    correct: bool(o.correct),
  }));
}

function escapeHtml(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

function splitLinkUrl(raw: string): { protocol: string; url: string } {
  const url = raw.trim();
  if (url.startsWith("https://")) return { protocol: "https://", url: url.slice(8) };
  if (url.startsWith("http://")) return { protocol: "http://", url: url.slice(7) };
  if (url.startsWith("/")) return { protocol: "/", url: url.slice(1) };
  return { protocol: "other", url };
}

function tableHtml(el: StoredElement): string {
  const rows = Math.max(1, Math.min(20, Math.round(num(el.rows, 3))));
  const cols = Math.max(1, Math.min(20, Math.round(num(el.cols, 3))));
  const body = Array.from({ length: rows }, () => `<tr>${"<td>&nbsp;</td>".repeat(cols)}</tr>`).join("");
  return `<figure class="table"><table class="h5p-table">${body}</table></figure>`;
}

function videoSource(
  el: StoredElement,
  remapAsset: (storedPath: string, kind: string) => string,
): { path: string; mime: string } | null {
  const asset = str(el.asset);
  if (asset) {
    const contentPath = remapAsset(asset, "video");
    return { path: contentPath, mime: mimeFor("video", contentPath) };
  }
  const videoUrl = str(el.videoUrl).trim();
  if (videoUrl) {
    return { path: videoUrl, mime: "video/unknown" };
  }
  const objectUrl = str(el.objectUrl).trim();
  if (objectUrl) {
    return { path: objectUrl, mime: "video/unknown" };
  }
  return null;
}

export interface LibVersions {
  get(machineName: string): string;
}

async function resolveLibs(machineNames: string[]): Promise<LibVersions> {
  const map = new Map<string, string>();
  for (const name of machineNames) {
    const ver = await installedLibraryVersion(name);
    if (ver) map.set(name, `${ver.machineName} ${ver.majorVersion}.${ver.minorVersion}`);
  }
  return { get: (machineName: string) => map.get(machineName) ?? `${machineName} 1.0` };
}

export interface SemanticsField {
  name: string;
  type?: string;
  default?: unknown;
  optional?: boolean;
  defaultNum?: number;
  min?: number;
  options?: Array<{ value?: unknown }>;
  fields?: SemanticsField[];
  field?: SemanticsField;
}

function isPlainObject(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

function defaultFor(node: SemanticsField): unknown {
  if (node.default !== undefined) return node.default;
  const type = node.type ?? "text";

  if (type === "library") return undefined;
  if (type === "file" || type === "image" || type === "video" || type === "audio") return undefined;

  if (type === "group") {
    const fields = node.fields ?? [];
    const sameName = fields.find((f) => f.name === node.name && f.type === "list");
    if (sameName) {
      const count = sameName.defaultNum ?? sameName.min ?? 0;
      const out: unknown[] = [];
      for (let i = 0; i < count; i++) out.push(defaultFor(sameName.field ?? sameName));
      return out;
    }
    const out: Record<string, unknown> = {};
    for (const f of fields) {
      const v = defaultFor(f);
      if (v !== undefined) out[f.name] = v;
    }
    return out;
  }

  if (type === "list") {
    const count = node.defaultNum ?? 0;
    const out: unknown[] = [];
    for (let i = 0; i < count; i++) out.push(defaultFor(node.field ?? node));
    return out;
  }

  if (type === "number") return node.min ?? 0;
  if (type === "boolean") return false;
  if (type === "select") {
    const first = node.options?.find((o) => o.value !== undefined)?.value;
    return first ?? "";
  }
  return "";
}

export function fillSemanticsDefaults(
  semantics: SemanticsField[],
  params: Record<string, unknown>,
): Record<string, unknown> {
  for (const node of semantics) {
    const value = params[node.name];
    if (value === undefined) {
      const d = defaultFor(node);
      if (d !== undefined) params[node.name] = d;
      continue;
    }
    if (node.type === "group" && isPlainObject(value)) {
      if (node.fields) fillSemanticsDefaults(node.fields, value);
      continue;
    }
    if (node.type === "list" && Array.isArray(value) && node.field?.type === "group" && node.field.fields) {
      for (const item of value) {
        if (isPlainObject(item)) fillSemanticsDefaults(node.field.fields, item);
      }
    }
  }
  return params;
}

async function loadSemantics(machineNames: string[]): Promise<Record<string, SemanticsField[]>> {
  const out: Record<string, SemanticsField[]> = {};
  const { libraryManager } = await getH5P();
  await Promise.all(
    [...new Set(machineNames)].map(async (name) => {
      try {
        const ver = await installedLibraryVersion(name);
        if (!ver) return;
        const semantics = await libraryManager.getSemantics({
          machineName: ver.machineName,
          majorVersion: ver.majorVersion,
          minorVersion: ver.minorVersion,
        });
        if (Array.isArray(semantics) && semantics.length > 0) out[name] = semantics as SemanticsField[];
      } catch {
        // library tanpa semantics.json — biarkan tanpa default tambahan
      }
    }),
  );
  return out;
}

function applySemanticsDefaults(
  content: Record<string, unknown>,
  semantics: Record<string, SemanticsField[]> | undefined,
): void {
  if (!semantics) return;
  const cpSemantics = semantics["H5P.CoursePresentation"];
  if (cpSemantics) {
    fillSemanticsDefaults(
      cpSemantics.filter((f) => f.name !== "presentation"),
      content,
    );
  }

  const presentation = content.presentation as
    | { slides?: Array<{ elements?: Array<Record<string, unknown>> }> }
    | undefined;
  for (const slide of presentation?.slides ?? []) {
    for (const el of slide.elements ?? []) {
      const action = el.action as { library?: string; params?: Record<string, unknown> } | undefined;
      if (!action?.library || !isPlainObject(action.params)) continue;
      const machineName = action.library.split(" ")[0];
      const libSemantics = semantics[machineName];
      if (libSemantics) fillSemanticsDefaults(libSemantics, action.params);
    }
  }
}

/** Machine name library action yang dipakai frontend (setelah normalisasi). */
const ACTION_LIB: Record<string, string | null> = {
  advancedText: "H5P.AdvancedText",
  link: "H5P.Link",
  image: "H5P.Image",
  shape: "H5P.Shape",
  video: "H5P.Video",
  audio: "H5P.Audio",
  goToSlide: null,
  blanks: "H5P.Blanks",
  singleChoice: "H5P.SingleChoiceSet",
  multiChoice: "H5P.MultiChoice",
  trueFalse: "H5P.TrueFalse",
  dragDrop: "H5P.DragQuestion",
  summary: "H5P.Summary",
  dragWords: "H5P.DragText",
  markWords: "H5P.MarkTheWords",
  dialogCards: "H5P.Dialogcards",
  continuousText: "H5P.ContinuousText",
  exportableText: "H5P.ExportableTextArea",
  table: "H5P.Table",
  interactiveVideo: "H5P.Video",
  audioRecorder: "H5P.AudioRecorder",
  multimediaChoice: "H5P.MultiChoice",
};

export function actionMachineName(kind: string): string | null {
  return ACTION_LIB[kind] ?? null;
}

function toAction(
  el: StoredElement,
  libs: LibVersions,
  remapAsset: (storedPath: string, kind: string) => string,
): { library: string; params: Record<string, unknown> } | null {
  switch (el.kind) {
    case "advancedText":
      return {
        library: libs.get("H5P.AdvancedText"),
        params: { text: str(el.text) },
      };
    case "link": {
      const { protocol, url } = splitLinkUrl(str(el.url));
      return {
        library: libs.get("H5P.Link"),
        params: {
          title: str(el.linkText) || str(el.url) || "Tautan",
          linkWidget: { protocol, url },
        },
      };
    }
    case "shape": {
      const shapeType = str(el.shapeType, "rectangle");
      const isLine = shapeType === "vertical-line" || shapeType === "horizontal-line";
      return {
        library: libs.get("H5P.Shape"),
        params: {
          type: shapeType === "circle" ? "circle" : isLine ? "line" : "rectangle",
          shape: {
            fillColor: str(el.color, "#3b82f6"),
            borderWidth: isLine ? 2 : 0,
            borderColor: str(el.color, "#3b82f6"),
            borderStyle: "solid",
            borderRadius: shapeType === "circle" ? 50 : 0,
          },
        },
      };
    }
    case "image": {
      const asset = str(el.asset);
      if (!asset) return null;
      const contentPath = remapAsset(asset, "image");
      return {
        library: libs.get("H5P.Image"),
        params: {
          file: fileRef(contentPath, mimeFor("image", contentPath), str(el.alt) || str(el.title)),
          alt: str(el.alt) || str(el.title),
          title: str(el.title),
        },
      };
    }
    case "video": {
      const source = videoSource(el, remapAsset);
      return {
        library: libs.get("H5P.Video"),
        params: {
          sources: source ? [source] : [],
          visuals: { fit: true, controls: true },
          playback: { autoplay: false, loop: false },
          a11y: [],
        },
      };
    }
    case "audio": {
      const asset = str(el.asset);
      if (!asset) return null;
      const contentPath = remapAsset(asset, "audio");
      return {
        library: libs.get("H5P.Audio"),
        params: {
          files: [fileRef(contentPath, mimeFor("audio", contentPath), str(el.title) || contentPath)],
          playerMode: "minimalistic",
          fitToWrapper: false,
          controls: true,
          autoplay: false,
        },
      };
    }
    case "singleChoice": {
      const answers = [...optionsOf(el)]
        .sort((a, b) => Number(b.correct) - Number(a.correct))
        .map((o) => o.text);
      return {
        library: libs.get("H5P.SingleChoiceSet"),
        params: {
          choices: [{ question: str(el.question), answers }],
          behaviour: {
            autoContinue: true,
            enableRetry: el.enableRetry !== false,
            enableSolutionsButton: el.enableSolutionsButton !== false,
            passPercentage: 100,
          },
        },
      };
    }
    case "multiChoice":
    case "multimediaChoice": {
      const opts = optionsOf(el);
      const isSingle = opts.filter((o) => o.correct).length <= 1;
      return {
        library: libs.get("H5P.MultiChoice"),
        params: {
          question: str(el.question),
          answers: opts.map((o) => ({
            text: `<div>${escapeHtml(o.text)}</div>\n`,
            correct: o.correct,
            tipsAndFeedback: { tip: "", chosenFeedback: "", notChosenFeedback: "" },
          })),
          behaviour: behaviourOf(el, {
            type: isSingle ? "single" : "multi",
            singlePoint: true,
            randomAnswers: true,
          }),
        },
      };
    }
    case "trueFalse":
      return {
        library: libs.get("H5P.TrueFalse"),
        params: {
          question: str(el.question),
          correct: bool(el.correctAnswer, true) ? "true" : "false",
          behaviour: behaviourOf(el, {
            feedbackOnCorrect: str(el.feedbackCorrect),
            feedbackOnWrong: str(el.feedbackWrong),
            confirmCheckDialog: false,
            confirmRetryDialog: false,
          }),
        },
      };
    case "blanks":
      return {
        library: libs.get("H5P.Blanks"),
        params: {
          text: "",
          questions: [str(el.text)],
          behaviour: behaviourOf(el, { enableCheckButton: true }),
        },
      };
    case "dragDrop": {
      const zonesRaw = arr<Record<string, unknown>>(el.zones).map((z, i) => ({
        id: str(z.id) || `zone-${i + 1}`,
        label: str(z.label) || `Zona ${i + 1}`,
      }));
      const zones = zonesRaw.length > 0 ? zonesRaw : [{ id: "zone-1", label: "Zona 1" }];
      const itemsRaw = arr<Record<string, unknown>>(el.items).map((it, i) => ({
        id: str(it.id) || `item-${i + 1}`,
        text: str(it.text) || `Item ${i + 1}`,
        zoneId: str(it.zoneId) || zones[0].id,
      }));
      const items = itemsRaw.length > 0 ? itemsRaw : [{ id: "item-1", text: "Item 1", zoneId: zones[0].id }];
      const zoneIndex = new Map(zones.map((z, i) => [z.id, i]));
      const taskWidth = 640;
      const taskHeight = 420;
      const dropZones = zones.map((zone, i) => ({
        label: zone.label,
        showLabel: true,
        x: 16 + (i % 3) * 205,
        y: 290 + Math.floor(i / 3) * 70,
        width: 190,
        height: 58,
        correctElements: items
          .map((it, itemIndex) => (it.zoneId === zone.id ? String(itemIndex) : null))
          .filter((v): v is string => v !== null),
        backgroundOpacity: 100,
        tipsAndFeedback: { tip: "" },
        single: false,
        autoAlign: true,
      }));
      const elements = items.map((it, i) => {
        const zi = zoneIndex.get(it.zoneId) ?? 0;
        return {
          type: { library: "H5P.AdvancedText 1.1", params: { text: `<p>${escapeHtml(it.text)}</p>` } },
          x: 16 + (i % 3) * 205,
          y: 60 + Math.floor(i / 3) * 60,
          width: 190,
          height: 48,
          dropZones: [String(zi)],
          backgroundOpacity: 100,
          multiple: false,
        };
      });
      return {
        library: libs.get("H5P.DragQuestion"),
        params: {
          scoreShow: true,
          question: {
            settings: { size: { width: taskWidth, height: taskHeight } },
            task: { elements, dropZones },
          },
          behaviour: behaviourOf(el, { enableCheckButton: true, singlePoint: false }),
        },
      };
    }
    case "summary": {
      const ordered = arr<Record<string, unknown>>(el.statements)
        .map((s) => ({ text: str(s.text), correct: bool(s.correct) }))
        .sort((a, b) => Number(b.correct) - Number(a.correct));
      return {
        library: libs.get("H5P.Summary"),
        params: {
          intro: str(el.intro),
          summaries: [
            {
              summary: ordered.map((s) => s.text),
              tip: str(el.feedbackCorrect),
            },
          ],
        },
      };
    }
    case "dragWords":
      return {
        library: libs.get("H5P.DragText"),
        params: {
          taskDescription: str(el.title) || "Tarik kata-kata ke tempat yang tepat",
          textField: str(el.text),
          behaviour: behaviourOf(el, { enableCheckButton: true, enableRetry: true }),
        },
      };
    case "markWords":
      return {
        library: libs.get("H5P.MarkTheWords"),
        params: {
          taskDescription: str(el.title) || "Tandai kata yang tepat",
          textField: str(el.text),
          behaviour: behaviourOf(el, { enableCheckButton: true, showScorePoints: true }),
        },
      };
    case "dialogCards":
      return {
        library: libs.get("H5P.Dialogcards"),
        params: {
          title: str(el.title) || "Dialog Cards",
          mode: "normal",
          description: str(el.description),
          dialogs: arr<Record<string, unknown>>(el.cards).map((card) => ({
            text: str(card.front),
            answer: str(card.back),
          })),
          behaviour: { scaleTextNotCard: true, randomCards: false, enableRetry: true },
        },
      };
    case "continuousText":
      return { library: libs.get("H5P.ContinuousText"), params: { text: str(el.text) } };
    case "exportableText":
      return {
        library: libs.get("H5P.ExportableTextArea"),
        params: {
          label: str(el.text),
          index: 1,
          exportNotSupported: "Ekspor tidak didukung di browser ini.",
        },
      };
    case "table":
      return { library: libs.get("H5P.Table"), params: { text: tableHtml(el) } };
    case "interactiveVideo": {
      const source = videoSource(el, remapAsset);
      return {
        library: libs.get("H5P.Video"),
        params: {
          sources: source ? [source] : [],
          visuals: { fit: true, controls: true },
          playback: { autoplay: false, loop: false },
          a11y: [],
        },
      };
    }
    case "audioRecorder":
      return {
        library: libs.get("H5P.AudioRecorder"),
        params: { title: str(el.description) || str(el.title) || "Audio Recorder" },
      };
    case "goToSlide":
      return null;
    default:
      return null;
  }
}

export function toCpElement(
  el: StoredElement,
  slideCount: number,
  libs: LibVersions,
  remapAsset: (storedPath: string, kind: string) => string,
): CoursePresentationElement {
  const pos = (el.position ?? {}) as StoredPosition;
  const base: CoursePresentationElement = {
    x: clampPct(pos.x),
    y: clampPct(pos.y),
    width: clampPct(pos.width),
    height: clampPct(pos.height),
    title: str(el.title) || undefined,
    displayAsButton: bool(el.displayAsButton),
    buttonLabel: str(el.buttonLabel) || undefined,
    buttonSize: "big",
  };
  if (el.kind === "goToSlide") {
    const targetType = el.targetType === "next" || el.targetType === "previous" ? el.targetType : "specified";
    return {
      ...base,
      title: str(el.label) || "Pilihan",
      goToSlideType: targetType,
      ...(targetType === "specified"
        ? { goToSlide: Math.min(slideCount, Math.max(1, num(el.targetSlide, 1))) }
        : {}),
      invisible: bool(el.invisible),
    };
  }
  const action = toAction(el, libs, remapAsset);
  return { ...base, action: action ?? undefined };
}

/** Kumpulkan machineName yang dibutuhkan + rakit params CoursePresentation. */
export async function buildContentParams(
  slides: StoredSlide[],
  opts: {
    title: string;
    language: string;
    keywordListEnabled: boolean;
    activeSurface: boolean;
    hideSummarySlide: boolean;
    showSolutionButton: boolean;
    retryButton: boolean;
    remapAsset: (storedPath: string, kind: string) => string;
    backgroundPath: (slideIndex: number) => string | null;
  },
): Promise<{ params: Record<string, unknown>; mainLibraryUbername: string; machineNames: string[] }> {
  const needed = new Set<string>(["H5P.CoursePresentation"]);
  for (const s of slides) {
    for (const el of s.elements) {
      const lib = actionMachineName(str(el.kind));
      if (lib) needed.add(lib);
    }
  }
  const libs = await resolveLibs([...needed]);
  const cp = await installedLibraryVersion("H5P.CoursePresentation");
  if (!cp) throw new Error("Library H5P.CoursePresentation belum terinstal. Jalankan: npm run h5p:seed");

  const n = slides.length;
  const outSlides = slides.map((s, idx) => ({
    elements: s.elements
      .map((el) => toCpElement(el, n, libs, opts.remapAsset))
      .filter((el) => el.action !== undefined || el.goToSlideType !== undefined),
    keywords: (s.keywords ?? [])
      .filter((k) => (k.main ?? "").trim().length > 0)
      .map((k) => ({ main: k.main, subs: (k.subs ?? []).filter((x) => x.trim().length > 0) })),
    slideBackgroundSelector: opts.backgroundPath(idx)
      ? {
          imageSlideBackground: fileRef(
            opts.backgroundPath(idx) as string,
            mimeFor("image", opts.backgroundPath(idx) as string),
            s.title,
          ),
        }
      : {},
  }));

  const params: Record<string, unknown> = {
    presentation: {
      slides: outSlides,
      keywordListEnabled: opts.keywordListEnabled,
      keywordListAlwaysShow: false,
      keywordListAutoHide: false,
      keywordListOpacity: 100,
      globalBackgroundSelector: {},
    },
    override: {
      activeSurface: opts.activeSurface,
      hideSummarySlide: opts.hideSummarySlide,
      showSolutionButton: opts.showSolutionButton ? "on" : "off",
      retryButton: opts.retryButton ? "on" : "off",
      summarySlideSolutionButton: opts.showSolutionButton,
      summarySlideRetryButton: opts.retryButton,
    },
    l10n: {},
  };
  // Lengkapi field yang tidak kita tulis (UI, l10n, confirm*, overallFeedback,
  // tipsAndFeedback dropZone, dll.) supaya player tidak crash membaca undefined.
  applySemanticsDefaults(params, await loadSemantics([...needed]));

  return {
    params,
    mainLibraryUbername: `${cp.machineName} ${cp.majorVersion}.${cp.minorVersion}`,
    machineNames: [...needed],
  };
}
