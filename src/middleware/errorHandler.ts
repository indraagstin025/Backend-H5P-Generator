import type { NextFunction, Request, Response } from "express";
import { promises as fs } from "node:fs";
import { createLogger } from "../utils/logger.js";

const log = createLogger("error");

export function asyncHandler(
  fn: (req: Request, res: Response, next: NextFunction) => Promise<unknown>,
) {
  return (req: Request, res: Response, next: NextFunction) => {
    fn(req, res, next).catch(next);
  };
}

/** Hapus file tmp bila request gagal setelah multer menyimpan (anti sampah). */
export async function discardUploaded(req: Request): Promise<void> {
  const file = (req as Request & { file?: Express.Multer.File }).file;
  if (file?.path) {
    try {
      await fs.unlink(file.path);
    } catch {
      // abaikan — cleanup berkala menangani sisanya
    }
  }
}

// eslint tidak dipakai di backend — parameter tak terpakai diawali garis bawah.
export function errorHandler(err: unknown, req: Request, res: Response, _next: NextFunction): void {
  if (err instanceof Error && (err as Error & { code?: string }).code === "LIMIT_FILE_SIZE") {
    res.status(413).json({ error: "File-nya kegedean, maksimal 50 MB." });
    return;
  }
  const status =
    err instanceof Error && typeof (err as Error & { status?: unknown }).status === "number"
      ? ((err as Error & { status: number }).status as number)
      : 500;
  const message =
    err instanceof Error && status !== 500 ? err.message : "Terjadi kesalahan di server.";
  if (status === 500) {
    log.error(`${req.method} ${req.originalUrl} gagal`, {
      message: err instanceof Error ? err.message : String(err),
      stack: err instanceof Error ? err.stack : undefined,
      ip: req.ip,
    });
  } else {
    log.warn(`${req.method} ${req.originalUrl} ditolak (${status}): ${message}`);
  }
  res.status(status).json({ error: message });
}
