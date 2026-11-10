import type { Request, Response, NextFunction } from "express";
import { getUserById, verifyToken, type SafeUser } from "../services/auth.js";
import type { Role } from "@prisma/client";

// Tambahkan definisi user ke objek Request Express
declare global {
  namespace Express {
    interface Request {
      user?: SafeUser;
    }
  }
}

/**
 * Middleware untuk memverifikasi token JWT dari header Authorization (Bearer <token>).
 */
export async function authenticateToken(
  req: Request,
  res: Response,
  next: NextFunction,
): Promise<void> {
  const authHeader = req.headers.authorization;
  if (!authHeader) {
    res.status(401).json({ error: "Akses ditolak. Token autentikasi tidak ditemukan." });
    return;
  }

  const parts = authHeader.split(" ");
  if (parts.length !== 2 || parts[0] !== "Bearer") {
    res.status(401).json({ error: "Format header Authorization tidak valid. Gunakan format 'Bearer <token>'." });
    return;
  }

  const token = parts[1];
  const payload = verifyToken(token);
  if (!payload) {
    res.status(401).json({ error: "Sesi Anda telah kedaluwarsa atau token tidak valid. Silakan masuk kembali." });
    return;
  }

  const user = await getUserById(payload.id);
  if (!user) {
    res.status(401).json({ error: "Pengguna tidak ditemukan." });
    return;
  }

  if (!user.isActive) {
    res.status(403).json({ error: "Akun Anda telah dinonaktifkan oleh Administrator." });
    return;
  }

  req.user = user;
  next();
}

/**
 * Middleware otorisasi berbasis Role (RBAC).
 * Memastikan pengguna memiliki salah satu role yang diizinkan (misal: ADMIN).
 */
export function requireRole(...allowedRoles: Role[]) {
  return (req: Request, res: Response, next: NextFunction): void => {
    if (!req.user) {
      res.status(401).json({ error: "Autentikasi diperlukan." });
      return;
    }

    if (!allowedRoles.includes(req.user.role)) {
      res.status(403).json({
        error: `Akses ditolak. Resource ini memerlukan hak akses [${allowedRoles.join(", ")}].`,
      });
      return;
    }

    next();
  };
}
