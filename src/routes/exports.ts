import { Router } from "express";
import { authenticateToken } from "../middleware/auth.js";
import { asyncHandler } from "../middleware/errorHandler.js";
import { listExportHistory, recordExportHistory, validateExportInput } from "../services/exports.js";

export const exportsRouter = Router();

exportsRouter.use(authenticateToken);

/**
 * Daftar riwayat ekspor milik pengguna aktif (terurut terbaru).
 * GET /api/exports
 */
exportsRouter.get(
  "/",
  asyncHandler(async (req, res) => {
    const data = await listExportHistory(req.user!.id, req.query.limit);
    res.json({ data });
  }),
);

/**
 * Catat riwayat ekspor (jalur cadangan saat paket dirakit di klien ketika server online).
 * POST /api/exports
 */
exportsRouter.post(
  "/",
  asyncHandler(async (req, res) => {
    const validated = validateExportInput(req.body);
    const created = await recordExportHistory({
      userId: req.user!.id,
      ...validated,
    });
    res.status(201).json({ data: created });
  }),
);
