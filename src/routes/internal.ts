import { Router } from "express";
import { createReadStream, promises as fs } from "node:fs";
import { asyncHandler } from "../middleware/errorHandler.js";
import { resolveTempFile } from "../converter/onlyoffice.js";

export const internalRouter = Router();

/** Unduhan satu-kali pakai untuk Document Server (token tak tertebak, TTL pendek). */
internalRouter.get("/oo/:token", asyncHandler(async (req, res) => {
  const token = Array.isArray(req.params.token) ? String(req.params.token[0]) : String(req.params.token);
  const absPath = resolveTempFile(token);
  if (!absPath) {
    res.status(404).json({ error: "Tautan berkas kedaluwarsa." });
    return;
  }
  try {
    const stat = await fs.stat(absPath);
    res.setHeader("Content-Type", "application/octet-stream");
    res.setHeader("Content-Length", String(stat.size));
    createReadStream(absPath).pipe(res);
  } catch {
    res.status(404).json({ error: "Berkas tidak ditemukan." });
  }
}));
