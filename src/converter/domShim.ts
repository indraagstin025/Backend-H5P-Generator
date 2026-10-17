import { DOMParser as XmldomParser } from "@xmldom/xmldom";

/**
 * Node tidak punya DOMParser global — sediakan dari @xmldom/xmldom
 * agar pptxParser salinan frontend jalan apa adanya.
 * Dipakai persis sekali oleh pipeline sebelum parsing.
 */
export function ensureDom(): void {
  const g = globalThis as unknown as Record<string, unknown>;
  if (typeof g.DOMParser === "undefined") {
    g.DOMParser = XmldomParser;
  }
}
