import multer from "multer";
import path from "node:path";
import { config } from "../config.js";
import { tmpRoot } from "../services/storage.js";

const ALLOWED_EXT = new Set([".pptx", ".pdf"]);
const ALLOWED_MEDIA_EXT = new Set([
  ".png",
  ".jpg",
  ".jpeg",
  ".gif",
  ".webp",
  ".svg",
  ".mp3",
  ".wav",
  ".ogg",
  ".m4a",
  ".mp4",
  ".m4v",
  ".webm",
  ".ogv",
]);

function httpError(status: number, message: string): Error & { status: number } {
  return Object.assign(new Error(message), { status });
}

export const uploadSource = multer({
  storage: multer.diskStorage({
    destination: (_req, _file, cb) => cb(null, tmpRoot()),
    filename: (_req, file, cb) => {
      const ext = path.extname(file.originalname).toLowerCase();
      cb(null, `upload-${Date.now()}-${Math.round(Math.random() * 1e9)}${ext}`);
    },
  }),
  limits: { fileSize: config.maxUploadBytes, files: 1 },
  fileFilter: (_req, file, cb) => {
    const ext = path.extname(file.originalname).toLowerCase();
    if (!ALLOWED_EXT.has(ext)) {
      cb(httpError(400, "Pakai file .pptx atau .pdf ya."));
      return;
    }
    cb(null, true);
  },
});

export const uploadMediaAsset = multer({
  storage: multer.diskStorage({
    destination: (_req, _file, cb) => cb(null, tmpRoot()),
    filename: (_req, file, cb) => {
      const ext = path.extname(file.originalname).toLowerCase();
      cb(null, `media-tmp-${Date.now()}-${Math.round(Math.random() * 1e9)}${ext}`);
    },
  }),
  limits: { fileSize: 50 * 1024 * 1024, files: 1 },
  fileFilter: (_req, file, cb) => {
    const ext = path.extname(file.originalname).toLowerCase();
    if (!ALLOWED_MEDIA_EXT.has(ext)) {
      cb(
        httpError(
          400,
          "Format media tidak didukung. Gunakan gambar (.png/.jpg/.gif/.webp/.svg), audio (.mp3/.wav/.ogg/.m4a), atau video (.mp4/.webm/.ogv).",
        ),
      );
      return;
    }
    cb(null, true);
  },
});
