import { createReadStream, promises as fs } from "node:fs";
import path from "node:path";
import { Router } from "express";
import { config } from "../config.js";
import { prisma } from "../db.js";
import { asyncHandler, discardUploaded } from "../middleware/errorHandler.js";
import { authRateLimiter } from "../middleware/rateLimiter.js";
import { authenticateToken } from "../middleware/auth.js";
import { uploadMediaAsset } from "../middleware/upload.js";
import {
  completeUserProfile,
  loginUser,
  registerUser,
  sanitizeUser,
  seedInitialUsers,
} from "../services/auth.js";
import {
  createGoogleAuthUrl,
  exchangeGoogleOneTimeCode,
  handleGoogleCallback,
  isGoogleOAuthConfigured,
} from "../services/googleAuth.js";
import { validateAndSaveMediaAsset } from "../services/uploadValidator.js";
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
 * Status penyedia autentikasi eksternal (Google OAuth)
 * GET /api/auth/providers
 */
authRouter.get("/providers", (_req, res) => {
  res.json({
    data: {
      google: isGoogleOAuthConfigured(),
    },
  });
});

/**
 * Mulai alur login Google OAuth 2.0
 * GET /api/auth/google
 */
authRouter.get(
  "/google",
  authRateLimiter,
  asyncHandler(async (_req, res) => {
    const url = createGoogleAuthUrl();
    res.redirect(url);
  }),
);

/**
 * Callback dari Google OAuth 2.0
 * GET /api/auth/google/callback
 */
authRouter.get("/google/callback", async (req, res) => {
  const loginBase = `${config.frontendUrl}/login`;
  if (typeof req.query.error === "string" && req.query.error) {
    const msg =
      req.query.error === "access_denied"
        ? "Login dengan Google dibatalkan."
        : "Autentikasi Google gagal. Silakan coba lagi.";
    res.redirect(`${loginBase}?oauth_error=${encodeURIComponent(msg)}`);
    return;
  }

  try {
    const exchangeCode = await handleGoogleCallback(req.query.code, req.query.state);
    res.redirect(`${loginBase}?oauth_code=${encodeURIComponent(exchangeCode)}`);
  } catch (err) {
    const msg = err instanceof Error ? err.message : "Gagal memproses login Google.";
    log.warn("Callback Google OAuth gagal", { error: msg });
    res.redirect(`${loginBase}?oauth_error=${encodeURIComponent(msg)}`);
  }
});

/**
 * Tukar one-time exchange code menjadi sesi JWT aplikasi
 * POST /api/auth/google/exchange
 */
authRouter.post(
  "/google/exchange",
  authRateLimiter,
  asyncHandler(async (req, res) => {
    const body = (req.body && typeof req.body === "object" ? req.body : {}) as Record<string, unknown>;
    const result = await exchangeGoogleOneTimeCode(body.code);
    log.info(`Pengguna masuk via Google: ${result.user.email} [${result.user.role}]`);
    res.json({
      message: "Berhasil masuk dengan akun Google.",
      data: result,
    });
  }),
);

/**
 * Lengkapi / perbarui profil pengguna (Nama Lengkap, Tanggal Lahir, & opsional Ubah Sandi)
 * PATCH /api/auth/profile
 */
authRouter.patch(
  "/profile",
  authenticateToken,
  asyncHandler(async (req, res) => {
    const body = (req.body && typeof req.body === "object" ? req.body : {}) as Record<string, unknown>;
    const updated = await completeUserProfile(req.user!.id, {
      name: body.name,
      birthDate: body.birthDate,
      newPassword: body.newPassword,
    });
    log.info(`Profil pengguna diperbarui: ${updated.email} (${updated.id})`);
    res.json({
      message: "Profil berhasil disimpan.",
      data: updated,
    });
  }),
);

/**
 * Unggah foto profil pengguna (PNG/JPG/WEBP, maks 5 MB)
 * POST /api/auth/avatar
 */
authRouter.post(
  "/avatar",
  authenticateToken,
  uploadMediaAsset.single("file"),
  asyncHandler(async (req, res) => {
    const file = (req as typeof req & { file?: Express.Multer.File }).file;
    if (!file) {
      res.status(400).json({ error: "Berkas foto profil wajib disertakan." });
      return;
    }

    try {
      const ext = path.extname(file.originalname).toLowerCase();
      if (![".png", ".jpg", ".jpeg", ".webp"].includes(ext)) {
        await discardUploaded(req);
        res.status(400).json({ error: "Foto profil harus berupa gambar .png, .jpg, atau .webp." });
        return;
      }
      if (file.size > 5 * 1024 * 1024) {
        await discardUploaded(req);
        res.status(413).json({ error: "Ukuran foto profil maksimal 5 MB." });
        return;
      }

      const avatarDir = path.join(config.storageDir, "users", req.user!.id, "avatar");
      const saved = await validateAndSaveMediaAsset(file.path, file.originalname, avatarDir);
      const avatarUrl = `/api/auth/avatar/${req.user!.id}/${saved.filename}`;
      const updated = await prisma.user.update({
        where: { id: req.user!.id },
        data: { avatarUrl },
      });

      res.status(201).json({
        message: "Foto profil berhasil diperbarui.",
        data: {
          avatarUrl,
          user: sanitizeUser(updated),
        },
      });
    } catch (err) {
      await discardUploaded(req);
      throw err;
    }
  }),
);

/**
 * Sajikan foto profil pengguna yang disimpan di server
 * GET /api/auth/avatar/:userId/:filename
 */
const AVATAR_MIME: Record<string, string> = {
  png: "image/png",
  jpg: "image/jpeg",
  webp: "image/webp",
};

authRouter.get(
  "/avatar/:userId/:filename",
  asyncHandler(async (req, res) => {
    const userId = String(req.params.userId ?? "");
    const filename = String(req.params.filename ?? "");
    if (
      !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(userId) ||
      !/^media-[a-z0-9-]+\.(png|jpg|webp)$/i.test(filename)
    ) {
      res.status(400).json({ error: "Parameter avatar tidak valid." });
      return;
    }

    const abs = path.join(config.storageDir, "users", userId, "avatar", filename);
    const stat = await fs.stat(abs).catch((err: NodeJS.ErrnoException) => {
      if (err.code === "ENOENT") return null;
      throw err;
    });
    if (!stat?.isFile()) {
      res.status(404).json({ error: "Foto profil tidak ditemukan." });
      return;
    }

    const ext = path.extname(filename).slice(1).toLowerCase();
    res.setHeader("Content-Type", AVATAR_MIME[ext] ?? "application/octet-stream");
    res.setHeader("X-Content-Type-Options", "nosniff");
    res.setHeader("Cross-Origin-Resource-Policy", "cross-origin");
    res.setHeader("Cache-Control", "public, max-age=3600");
    res.setHeader("Content-Length", String(stat.size));
    createReadStream(abs).pipe(res);
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
