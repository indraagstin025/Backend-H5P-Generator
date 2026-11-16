import { Router } from "express";
import { config } from "../config.js";
import { asyncHandler } from "../middleware/errorHandler.js";
import { authRateLimiter } from "../middleware/rateLimiter.js";
import { authenticateToken } from "../middleware/auth.js";
import {
  loginUser,
  registerUser,
  seedInitialUsers,
} from "../services/auth.js";
import { createLogger } from "../utils/logger.js";

const log = createLogger("auth");
export const authRouter = Router();

/**
 * Registrasi akun baru (Email @gmail.com dan Kata Sandi)
 * POST /api/auth/register
 */
authRouter.post(
  "/register",
  authRateLimiter,
  asyncHandler(async (req, res) => {
    const body = (req.body && typeof req.body === "object" ? req.body : {}) as Record<string, unknown>;
    const result = await registerUser({
      email: body.email,
      password: body.password,
      name: body.name,
    });
    log.info(`Pendaftaran pengguna baru berhasil: ${result.user.email} (${result.user.id})`);
    res.status(201).json({
      message: "Pendaftaran akun berhasil.",
      data: result,
    });
  }),
);

/**
 * Masuk ke sistem (Email @gmail.com dan Kata Sandi)
 * POST /api/auth/login
 */
authRouter.post(
  "/login",
  authRateLimiter,
  asyncHandler(async (req, res) => {
    const body = (req.body && typeof req.body === "object" ? req.body : {}) as Record<string, unknown>;
    const result = await loginUser({
      email: body.email,
      password: body.password,
    });
    log.info(`Pengguna berhasil masuk: ${result.user.email} [${result.user.role}]`);
    res.json({
      message: "Berhasil masuk ke sistem.",
      data: result,
    });
  }),
);

/**
 * Ambil profil pengguna yang sedang login
 * GET /api/auth/me
 */
authRouter.get(
  "/me",
  authenticateToken,
  asyncHandler(async (req, res) => {
    res.json({
      data: req.user,
    });
  }),
);

/**
 * Inisialisasi Akun Bawaan (Admin & User) - hanya aktif di non-produksi
 * POST /api/auth/seed
 */
authRouter.post(
  "/seed",
  authRateLimiter,
  asyncHandler(async (_req, res) => {
    if (config.isProduction) {
      res.status(403).json({ error: "Endpoint inisialisasi akun dinonaktifkan pada lingkungan produksi." });
      return;
    }
    const result = await seedInitialUsers();
    res.json({
      message: "Proses inisialisasi akun bawaan selesai.",
      data: result,
    });
  }),
);
