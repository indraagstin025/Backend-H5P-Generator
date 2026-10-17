/**
 * SALINAN logika dari frontend (SINKRONISASI MANUAL — lihat converter/SYNC.md):
 * frontend/src/features/exporter/api/h5pPackager.ts
 * (toCpElement/toAction/toContentJson) diadaptasi ke data slide server
 * (aset = path disk, bukan File/Blob).
 */
import { installedLibraryVersion } from "./h5pService.js";

export interface StoredPosition {
  x: number;
  y: number;
  width: number;
  height: number;
}

export interface StoredElement extends Record<string, unknown> {
  id: string;
  kind: "advancedText" | "image" | "audio" | "goToSlide" | "multiChoice" | "trueFalse" | "blanks";
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

const IMAGE_MIME: Record<string, string> = {
  png: "image/png",
  jpg: "image/jpeg",
  jpeg: "image/jpeg",
  gif: "image/gif",
  svg: "image/svg+xml",
};
const AUDIO_MIME: Record<string, string> = { mp3: "audio/mpeg", wav: "audio/wav" };

function mimeFor(kind: string, assetPath: string): string {
  const ext = assetPath.split(".").pop()?.toLowerCase() ?? "";
  const map = kind === "audio" ? AUDIO_MIME : IMAGE_MIME;
  return map[ext] ?? "application/octet-stream";
}

function fileRef(filePath: string, mime: string, title: string) {
  return { path: filePath, mime, copyright: { license: "U" }, title };
}

function clampPct(n: number): number {
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

export interface LibVersions {
  get(machineName: string): string;
}

async function resolveLibs(machineNames: string[]): Promise<LibVersions> {
  const map = new Map<string, string>();
  for (const name of new Set(machineNames)) {
    const ver = await installedLibraryVersion(name);
    if (!ver) throw new Error(`Library ${name} belum terinstal di server. Jalankan: npm run h5p:seed`);
    map.set(name, `${ver.machineName} ${ver.majorVersion}.${ver.minorVersion}`);
  }
  return { get: (machineName: string) => map.get(machineName) ?? `${machineName} 1.0` };
}

function optionsOf(el: StoredElement): Array<{ text: string; correct: boolean }> {
  const raw = el.options;
  if (!Array.isArray(raw)) return [];
  return raw.map((o) => {
    const r = (o ?? {}) as { text?: unknown; correct?: unknown };
    return { text: str(r.text), correct: bool(r.correct) };
  });
}

function toAction(
  el: StoredElement,
  slideCount: number,
  libs: LibVersions,
  remapAsset: (storedPath: string, kind: string) => string,
): Record<string, unknown> | null {
  switch (el.kind) {
    case "advancedText":
      return { library: libs.get("H5P.AdvancedText"), params: { text: str(el.text) } };
    case "image": {
      const contentPath = remapAsset(str(el.asset), "image");
      return {
        library: libs.get("H5P.Image"),
        params: {
          file: fileRef(contentPath, mimeFor("image", contentPath), str(el.title) || str(el.alt)),
          alt: str(el.alt),
          title: str(el.title),
        },
      };
    }
    case "audio": {
      const contentPath = remapAsset(str(el.asset), "audio");
      return {
        library: libs.get("H5P.Audio"),
        params: {
          files: [fileRef(contentPath, mimeFor("audio", contentPath), str(el.title) || contentPath)],
          playerMode: "minimalistic",
        },
      };
    }
    case "multiChoice": {
      const feedbackCorrect = str(el.feedbackCorrect, "Benar!");
      const feedbackWrong = str(el.feedbackWrong, "Kurang tepat.");
      return {
        library: libs.get("H5P.MultiChoice"),
        params: {
          question: str(el.question),
          answers: optionsOf(el).map((o) => ({
            text: o.text,
            correct: o.correct,
            tipsAndFeedback: {
              tip: "",
              chosenFeedback: o.correct ? feedbackCorrect : feedbackWrong,
              notChosenFeedback: "",
            },
          })),
          behaviour: behaviourOf(el, { singleAnswer: el.singleAnswer !== false }),
        },
      };
    }
    case "trueFalse":
      return {
        library: libs.get("H5P.TrueFalse"),
        params: {
          question: str(el.question),
          correct: bool(el.correctAnswer, true) ? "true" : "false",
          behaviour: behaviourOf(el),
          confirmCheckDialog: false,
        },
      };
    case "blanks": {
      const text = str(el.text);
      const answers = (text.match(/\*([^*]+)\*/g) ?? []).map((m) => m.slice(1, -1).trim()).filter((s) => s.length > 0);
      return {
        library: libs.get("H5P.Blanks"),
        params: { text, questions: answers, behaviour: behaviourOf(el, { enableCheckButton: true }) },
      };
    }
    case "goToSlide":
      return null;
  }
  return null;
}

export function toCpElement(
  el: StoredElement,
  slideCount: number,
  libs: LibVersions,
  remapAsset: (storedPath: string, kind: string) => string,
): Record<string, unknown> {
  const pos = (el.position ?? {}) as StoredPosition;
  const base = {
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
        ? { goToSlide: Math.min(slideCount, Math.max(1, Number(el.targetSlide) || 1)) }
        : {}),
      invisible: bool(el.invisible),
    };
  }
  return { ...base, action: toAction(el, slideCount, libs, remapAsset) };
}

const ACTION_LIB: Record<string, string> = {
  advancedText: "H5P.AdvancedText",
  image: "H5P.Image",
  audio: "H5P.Audio",
  multiChoice: "H5P.MultiChoice",
  trueFalse: "H5P.TrueFalse",
  blanks: "H5P.Blanks",
};

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
      const lib = ACTION_LIB[el.kind];
      if (lib) needed.add(lib);
    }
  }
  const libs = await resolveLibs([...needed]);
  const cp = await installedLibraryVersion("H5P.CoursePresentation");
  if (!cp) throw new Error("Library H5P.CoursePresentation belum terinstal. Jalankan: npm run h5p:seed");

  const n = slides.length;
  const outSlides = slides.map((s, idx) => ({
    elements: s.elements.map((el) => toCpElement(el, n, libs, opts.remapAsset)),
    keywords: (s.keywords ?? [])
      .filter((k) => (k.main ?? "").trim().length > 0)
      .map((k) => ({ main: k.main, subs: (k.subs ?? []).filter((x) => x.trim().length > 0) })),
    slideBackgroundSelector: opts.backgroundPath(idx)
      ? { imageSlideBackground: fileRef(opts.backgroundPath(idx) as string, mimeFor("image", opts.backgroundPath(idx) as string), s.title) }
      : {},
  }));

  return {
    params: {
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
    },
    mainLibraryUbername: `${cp.machineName} ${cp.majorVersion}.${cp.minorVersion}`,
    machineNames: [...needed],
  };
}
