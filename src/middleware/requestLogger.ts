import type { NextFunction, Request, Response } from "express";
import { createLogger } from "../utils/logger.js";

const log = createLogger("http");

/**
 * Log request selesai: 2xx API pada info, aset statis pada debug,
 * 4xx pada warn, 5xx pada error. Body tidak dicatat (bisa berisi data pribadi).
 */
export function requestLogger(req: Request, res: Response, next: NextFunction): void {
  const started = process.hrtime.bigint();
  res.on("finish", () => {
    const ms = Number(process.hrtime.bigint() - started) / 1e6;
    const line = `${req.method} ${req.originalUrl} ${res.statusCode} ${ms.toFixed(1)}ms`;
    const meta = {
      ip: req.ip,
      length: res.getHeader("content-length") ?? undefined,
    };
    if (res.statusCode >= 500) {
      log.error(line, meta);
    } else if (res.statusCode >= 400) {
      log.warn(line, meta);
    } else if (req.originalUrl.startsWith("/api/") && req.originalUrl !== "/api/health") {
      log.info(line, meta);
    } else {
      log.debug(line, meta);
    }
  });
  next();
}
