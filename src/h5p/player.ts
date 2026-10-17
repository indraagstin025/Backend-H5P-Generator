import { strFromU8, unzipSync } from "fflate";
import path from "node:path";
import { prisma } from "../db.js";
import { getH5P, systemUser } from "./h5pService.js";

const SESSION_TTL_MS = 24 * 3600 * 1000;

export interface PreviewSessionInfo {
  sessionId: string;
  playerUrl: string;
  title: string;
  expiresAt: string;
}

/** Ambil file library H5P (untuk player + validasi manual). */
export async function getLibraryFile(
  ubername: string,
  file: string,
): Promise<{ stream: NodeJS.ReadableStream; mime: string; size?: number }> {
  const m = ubername.match(/^(.*)-(\d+)\.(\d+)$/);
  if (!m) throw Object.assign(new Error("Format library salah (cth: H5P.Video-1.6)."), { status: 400 });
  if (file.includes("..") || path.isAbsolute(file)) {
    throw Object.assign(new Error("Path file tidak valid."), { status: 400 });
  }
  const { libraryStorage } = await getH5P();
  const stats = await libraryStorage
    .getFileStats(
      { machineName: m[1], majorVersion: Number(m[2]), minorVersion: Number(m[3]) },
      file,
    )
    .catch(() => null);
  if (!stats) throw Object.assign(new Error("File library tidak ditemukan."), { status: 404 });
  const stream = await libraryStorage.getFileStream(
    { machineName: m[1], majorVersion: Number(m[2]), minorVersion: Number(m[3]) },
    file,
  );
  return { stream, mime: mimeFor(file), size: (stats as { size?: number }).size };
}

function mimeFor(file: string): string {
  const ext = file.split(".").pop()?.toLowerCase() ?? "";
  const map: Record<string, string> = {
    js: "application/javascript",
    css: "text/css",
    json: "application/json",
    png: "image/png",
    jpg: "image/jpeg",
    jpeg: "image/jpeg",
    gif: "image/gif",
    svg: "image/svg+xml",
    woff: "font/woff",
    woff2: "font/woff2",
    ttf: "font/ttf",
    eot: "application/vnd.ms-fontobject",
    otf: "font/otf",
    mp3: "audio/mpeg",
    wav: "audio/wav",
    mp4: "video/mp4",
    webm: "video/webm",
  };
  return map[ext] ?? "application/octet-stream";
}

/** Ambil h5p.json / file konten milik satu sesi pratinjau. */
export async function getSessionFile(
  sessionId: string,
  filePath: string,
): Promise<{ data?: Uint8Array; stream?: NodeJS.ReadableStream; mime: string } | null> {
  const session = await prisma.previewSession.findUnique({ where: { id: sessionId } });
  if (!session || session.expiresAt.getTime() < Date.now()) return null;
  const { contentStorage } = await getH5P();
  if (!filePath || filePath === "h5p.json") {
    const metadata = await contentStorage.getMetadata(session.contentId, systemUser).catch(() => null);
    if (!metadata) return null;
    return { data: new TextEncoder().encode(JSON.stringify(metadata)), mime: "application/json" };
  }
  const rel = filePath.replace(/^content\//, "");
  try {
    const stream = await contentStorage.getFileStream(session.contentId, rel, systemUser);
    return { stream, mime: mimeFor(rel) };
  } catch {
    return null;
  }
}

/**
 * Impor paket .h5p (rakitan browser) menjadi sesi pratinjau bervolume TTL.
 * Mengembalikan URL player + ID sesi untuk polling attempts.
 */
export async function createPreviewSession(
  buffer: Buffer,
  title: string,
  projectId?: string,
): Promise<PreviewSessionInfo> {
  let entries: Record<string, Uint8Array>;
  try {
    entries = unzipSync(new Uint8Array(buffer));
  } catch {
    throw Object.assign(new Error("Berkas bukan ZIP valid."), { status: 400 });
  }
  const manifestRaw = entries["h5p.json"];
  const contentRaw = entries["content/content.json"];
  if (!manifestRaw || !contentRaw) {
    throw Object.assign(new Error("Paket tidak valid (h5p.json/content absen)."), { status: 400 });
  }
  let manifest: { title?: string; language?: string; mainLibrary?: string };
  let params: Record<string, unknown>;
  try {
    manifest = JSON.parse(strFromU8(manifestRaw)) as typeof manifest;
    params = JSON.parse(strFromU8(contentRaw)) as Record<string, unknown>;
  } catch {
    throw Object.assign(new Error("h5p.json/content.json rusak."), { status: 400 });
  }
  if (manifest.mainLibrary !== "H5P.CoursePresentation") {
    throw Object.assign(new Error("Sesi pratinjau hanya untuk Course Presentation."), { status: 400 });
  }

  const { editor, contentStorage } = await getH5P();
  const metadata = {
    title: manifest.title || title,
    language: manifest.language || "id",
    defaultLanguage: manifest.language || "id",
    license: "U",
    embedTypes: ["div", "iframe"] as Array<"div" | "iframe">,
    mainLibrary: manifest.mainLibrary,
    preloadedDependencies: [],
  };
  const contentId = await editor.saveOrUpdateContent(
    undefined as unknown as string,
    params,
    metadata,
    `${manifest.mainLibrary} ${await mainUberSuffix(manifest.mainLibrary)}`,
    systemUser,
  );
  try {
    const { Readable } = await import("node:stream");
    for (const [key, data] of Object.entries(entries)) {
      if (!key.startsWith("content/") || key.endsWith("/") || key === "content/content.json") continue;
      const rel = key.slice("content/".length);
      await contentStorage.addFile(contentId, rel, Readable.from(Buffer.from(data)), systemUser);
    }
  } catch (err) {
    await contentStorage.deleteContent(contentId).catch(() => undefined);
    throw err;
  }

  const session = await prisma.previewSession.create({
    data: {
      contentId: String(contentId),
      projectId,
      title: manifest.title || title,
      expiresAt: new Date(Date.now() + SESSION_TTL_MS),
    },
  });
  return {
    sessionId: session.id,
    playerUrl: `/api/h5p/player/${session.id}`,
    title: session.title,
    expiresAt: session.expiresAt.toISOString(),
  };
}

async function mainUberSuffix(machineName: string): Promise<string> {
  const { libraryManager } = await getH5P();
  const installed = (await libraryManager.listInstalledLibraries(machineName)) as Record<
    string,
    Array<{ machineName: string; majorVersion: number; minorVersion: number }>
  >;
  const mine = Object.values(installed ?? {})
    .flat()
    .filter((v) => v?.machineName === machineName)
    .sort((a, b) => b.majorVersion - a.majorVersion || b.minorVersion - a.minorVersion);
  if (mine.length === 0) throw new Error(`Library ${machineName} belum terinstal. Jalankan: npm run h5p:seed`);
  return `${mine[0].majorVersion}.${mine[0].minorVersion}`;
}

/** Halaman player mandiri (di-iframe dari frontend). */
export function playerPageHtml(sessionId: string): string {
  const api = `/api/h5p/session/${sessionId}`;
  return `<!doctype html>
<html lang="id">
<head>
<meta charset="utf-8" />
<meta name="viewport" content="width=device-width, initial-scale=1" />
<title>Pratinjau H5P</title>
<style>html,body{margin:0;padding:0;background:#f2f7f0}#h5p-player{min-height:420px}.h5p-error{font:14px sans-serif;color:#a33327;padding:24px}</style>
</head>
<body>
<div id="h5p-player"></div>
<script src="/h5p-vendor/main.bundle.js" charset="utf-8"></script>
<script>
(function () {
  var el = document.getElementById('h5p-player');
  function fail(msg) { el.innerHTML = '<p class="h5p-error">' + msg + '</p>'; }
  try {
    new H5PStandalone.H5P(el, {
      h5pJsonPath: '${api}',
      frameJs: '/h5p-vendor/frame.bundle.js',
      frameCss: '/h5p-vendor/styles/h5p.css',
      librariesPath: '/api/h5p/libraries',
      frame: true,
      fullScreen: true
    }).then(function () {
      try {
        H5P.externalDispatcher.on('xAPI', function (ev) {
          try {
            var st = ev && ev.data && ev.data.statement;
            var score = st && st.result && st.result.score;
            if (score && typeof score.raw === 'number') {
              fetch('${api}/finish', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ score: score.raw, maxScore: typeof score.max === 'number' ? score.max : score.raw })
              }).catch(function () {});
            }
          } catch (e) {}
        });
      } catch (e) {}
    });
  } catch (e) { fail('Player gagal dimuat.'); }
})();
</script>
</body>
</html>`;
}

/** Catat skor dari event xAPI player (untuk uji nilai sebelum naik LMS). */
export async function recordFinish(
  sessionId: string,
  score: number,
  maxScore: number,
): Promise<{ id: string; score: number; maxScore: number }> {
  if (!Number.isFinite(score) || !Number.isFinite(maxScore) || maxScore <= 0) {
    throw Object.assign(new Error("Skor tidak valid."), { status: 400 });
  }
  const session = await prisma.previewSession.findUnique({ where: { id: sessionId } });
  if (!session) throw Object.assign(new Error("Sesi tidak ditemukan."), { status: 404 });
  const attempt = await prisma.previewAttempt.create({
    data: { sessionId, projectId: session.projectId, score, maxScore },
  });
  // Batas wajar: simpan 50 percobaan terakhir per sesi
  const extras = await prisma.previewAttempt.findMany({
    where: { sessionId },
    orderBy: { createdAt: "desc" },
    skip: 50,
    select: { id: true },
  });
  if (extras.length > 0) {
    await prisma.previewAttempt.deleteMany({ where: { id: { in: extras.map((e) => e.id) } } });
  }
  return { id: attempt.id, score: attempt.score, maxScore: attempt.maxScore };
}

export async function listAttempts(sessionId: string) {
  const session = await prisma.previewSession.findUnique({ where: { id: sessionId } });
  if (!session) throw Object.assign(new Error("Sesi tidak ditemukan."), { status: 404 });
  return prisma.previewAttempt.findMany({
    where: { sessionId },
    orderBy: { createdAt: "desc" },
    take: 50,
  });
}

export async function listProjectAttempts(projectId: string) {
  return prisma.previewAttempt.findMany({
    where: { projectId },
    orderBy: { createdAt: "desc" },
    take: 50,
  });
}

/** Hapus sesi kedaluwarsa + konten Lumi-nya (dipanggil job cleanup). */
export async function purgeExpiredSessions(now = Date.now()): Promise<number> {
  const expired = await prisma.previewSession.findMany({
    where: { expiresAt: { lt: new Date(now) } },
    select: { id: true, contentId: true },
  });
  if (expired.length === 0) return 0;
  const { contentStorage } = await getH5P();
  for (const s of expired) {
    try {
      await contentStorage.deleteContent(s.contentId);
    } catch {
      // lanjutkan — baris DB tetap dihapus
    }
  }
  await prisma.previewSession.deleteMany({ where: { id: { in: expired.map((s) => s.id) } } });
  return expired.length;
}
