import { createHmac, randomUUID } from "node:crypto";
import { promises as fs } from "node:fs";
import { config } from "../config.js";

export function isOnlyOfficeConfigured(): boolean {
  return config.onlyoffice.url.length > 0;
}

function base64url(input: Buffer | string): string {
  return Buffer.from(input).toString("base64url");
}

/** JWT HS256 tanpa dependensi (format token-in-body versi Docs). */
export function signJwt(payload: Record<string, unknown>, secret: string): string {
  const header = base64url(JSON.stringify({ alg: "HS256", typ: "JWT" }));
  const body = base64url(JSON.stringify(payload));
  const sig = createHmac("sha256", secret).update(`${header}.${body}`).digest("base64url");
  return `${header}.${body}.${sig}`;
}

interface ConvertResponse {
  endConvert?: boolean;
  percent?: number;
  fileUrl?: string;
  error?: number;
}

const CONVERT_ERRORS: Record<number, string> = {
  [-1]: "Dokumen tidak dikenali.",
  [-2]: "Timeout konversi.",
  [-3]: "Kesalahan penyimpanan hasil.",
  [-4]: "Memori tidak cukup.",
  [-5]: "Kunci dokumen tidak valid.",
  [-6]: "Kesalahan basis data.",
  [-7]: "Kesalahan input.",
  [-8]: "Token tidak valid.",
};

/** Registry URL sementara agar Document Server bisa mengunduh berkas sumber. */
interface TempEntry {
  absPath: string;
  expiresAt: number;
}
const tempFiles = new Map<string, TempEntry>();

export function registerTempFile(absPath: string, ttlMs = 10 * 60 * 1000): { token: string; url: string } {
  const token = randomUUID().replace(/-/g, "");
  tempFiles.set(token, { absPath, expiresAt: Date.now() + ttlMs });
  return { token, url: `${config.onlyoffice.fileUrlBase}/internal/oo/${token}` };
}

export function resolveTempFile(token: string): string | null {
  const entry = tempFiles.get(token);
  if (!entry) return null;
  if (entry.expiresAt < Date.now()) {
    tempFiles.delete(token);
    return null;
  }
  return entry.absPath;
}

export function unregisterTempFile(token: string): void {
  tempFiles.delete(token);
}

async function postConverter(
  base: string,
  path: string,
  payload: Record<string, unknown>,
  timeoutMs: number,
): Promise<ConvertResponse> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetch(`${base}${path}`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload),
      signal: controller.signal,
    });
    if (res.status === 404 && path === "/converter") {
      return postConverter(base, "/ConvertService.ashx", payload, timeoutMs);
    }
    if (!res.ok) throw new Error(`Document Server menjawab ${res.status}.`);
    return (await res.json()) as ConvertResponse;
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Konversi pptx/pdf → ZIP berisi PNG semua halaman via OnlyOffice.
 * Melempar Error berbahasa santai bila gagal.
 */
export async function convertToPngZip(
  absPath: string,
  fileName: string,
  filetype: string,
): Promise<Buffer> {
  const { url, jwt, timeoutMs } = config.onlyoffice;
  if (!url) throw new Error("ONLYOFFICE_URL belum disetel.");
  const key = randomUUID().replace(/-/g, "");
  const { token, url: fileUrl } = registerTempFile(absPath);
  try {
    const payload: Record<string, unknown> = {
      async: true,
      filetype,
      key,
      outputtype: "png",
      thumbnail: { first: false, width: 1920, height: 1080, aspect: 1 },
      title: fileName,
      url: fileUrl,
    };
    if (jwt) payload.token = signJwt(payload, jwt);
    const started = Date.now();
    for (;;) {
      const res = await postConverter(url, `/converter?shardkey=${key}`, { ...payload }, 60_000);
      if (typeof res.error === "number" && res.error !== 0) {
        throw new Error(CONVERT_ERRORS[res.error] ?? `Konversi gagal (kode ${res.error}).`);
      }
      if (res.endConvert && res.fileUrl) {
        const dl = await fetch(res.fileUrl);
        if (!dl.ok) throw new Error(`Unduh hasil konversi gagal (${dl.status}).`);
        return Buffer.from(await dl.arrayBuffer());
      }
      if (Date.now() - started > timeoutMs) {
        throw new Error("Konversi kelamaan, coba lagi atau kecilkan file.");
      }
      await new Promise((r) => setTimeout(r, 2000));
    }
  } finally {
    unregisterTempFile(token);
  }
}

/** Baca cepat PNG hasil konversi (untuk pipeline renderer). */
export async function readSourceBytes(absPath: string): Promise<Uint8Array> {
  return new Uint8Array(await fs.readFile(absPath));
}
