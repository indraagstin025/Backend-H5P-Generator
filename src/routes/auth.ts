import { Router } from "express";
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
 * Registrasi akun baru (Email dan Kata Sandi)
 * POST /api/auth/register
 */
authRouter.post(
  "/register",
  authRateLimiter,
  asyncHandler(async (req, res) => {
    const { email, password, name } = req.body ?? {};
    const result = await registerUser({ email, password, name });
    log.info(`Pendaftaran pengguna baru berhasil: ${result.user.email} (${result.user.id})`);
    res.status(201).json({
      message: "Pendaftaran akun berhasil.",
      data: result,
    });
  }),
);

/**
 * Masuk ke sistem (Email dan Kata Sandi)
 * POST /api/auth/login
 */
authRouter.post(
  "/login",
  authRateLimiter,
  asyncHandler(async (req, res) => {
    const { email, password } = req.body ?? {};
    const result = await loginUser({ email, password });
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
 * Inisialisasi Akun Bawaan (Admin & User)
 * POST /api/auth/seed
 */
authRouter.post(
  "/seed",
  asyncHandler(async (_req, res) => {
    const result = await seedInitialUsers();
    res.json({
      message: "Proses inisialisasi akun bawaan selesai.",
      data: result,
    });
  }),
);
