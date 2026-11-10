import { Router } from "express";
import { prisma } from "../db.js";
import { asyncHandler } from "../middleware/errorHandler.js";
import { authenticateToken, requireRole } from "../middleware/auth.js";
import { sanitizeUser } from "../services/auth.js";
import { createLogger } from "../utils/logger.js";
import type { Role } from "@prisma/client";

const log = createLogger("admin");
export const adminRouter = Router();

// Seluruh endpoint admin di bawah ini wajib terautentikasi dan memiliki Role ADMIN
adminRouter.use(authenticateToken);
adminRouter.use(requireRole("ADMIN"));

/**
 * Daftar seluruh pengguna sistem (dengan pencarian dan filter role)
 * GET /api/admin/users
 */
adminRouter.get(
  "/users",
  asyncHandler(async (req, res) => {
    const q = typeof req.query.q === "string" ? req.query.q.trim() : "";
    const role = typeof req.query.role === "string" ? req.query.role.toUpperCase() : undefined;
    const page = Math.max(1, Number(req.query.page) || 1);
    const limit = Math.min(100, Math.max(1, Number(req.query.limit) || 20));
    const skip = (page - 1) * limit;

    const where: {
      role?: Role;
      OR?: Array<{ email?: { contains: string; mode: "insensitive" }; name?: { contains: string; mode: "insensitive" } }>;
    } = {};

    if (role === "ADMIN" || role === "USER") {
      where.role = role as Role;
    }

    if (q) {
      where.OR = [
        { email: { contains: q, mode: "insensitive" } },
        { name: { contains: q, mode: "insensitive" } },
      ];
    }

    const [total, users] = await Promise.all([
      prisma.user.count({ where }),
      prisma.user.findMany({
        where,
        skip,
        take: limit,
        orderBy: { createdAt: "desc" },
        include: {
          _count: { select: { projects: true } },
        },
      }),
    ]);

    res.json({
      data: users.map((u) => ({
        ...sanitizeUser(u),
        projectsCount: u._count.projects,
      })),
      pagination: {
        total,
        page,
        limit,
        totalPages: Math.ceil(total / limit),
      },
    });
  }),
);

/**
 * Detail satu pengguna
 * GET /api/admin/users/:id
 */
adminRouter.get(
  "/users/:id",
  asyncHandler(async (req, res) => {
    const id = String(req.params.id);
    const user = await prisma.user.findUnique({
      where: { id },
      include: {
        _count: { select: { projects: true } },
      },
    });

    if (!user) {
      res.status(404).json({ error: "Pengguna tidak ditemukan." });
      return;
    }

    res.json({
      data: {
        ...sanitizeUser(user),
        projectsCount: user._count.projects,
      },
    });
  }),
);

/**
 * Ubah role pengguna (ADMIN <-> USER)
 * PATCH /api/admin/users/:id/role
 */
adminRouter.patch(
  "/users/:id/role",
  asyncHandler(async (req, res) => {
    const id = String(req.params.id);
    const targetRole = String(req.body?.role ?? "").toUpperCase();

    if (targetRole !== "ADMIN" && targetRole !== "USER") {
      res.status(400).json({ error: "Role tidak valid. Pilihan yang tersedia: ADMIN atau USER." });
      return;
    }

    // Cegah admin mencopot hak akses dirinya sendiri jika tidak ada admin lain
    if (req.user?.id === id && targetRole !== "ADMIN") {
      res.status(400).json({ error: "Anda tidak dapat mengubah hak akses akun Anda sendiri dari Admin." });
      return;
    }

    const updated = await prisma.user.update({
      where: { id },
      data: { role: targetRole as Role },
    });

    log.info(`Role pengguna ${updated.email} diubah menjadi ${targetRole} oleh ${req.user?.email}`);
    res.json({
      message: `Role pengguna berhasil diubah menjadi ${targetRole}.`,
      data: sanitizeUser(updated),
    });
  }),
);

/**
 * Aktifkan / Nonaktifkan akun pengguna (Blokir / Buka Blokir)
 * PATCH /api/admin/users/:id/status
 */
adminRouter.patch(
  "/users/:id/status",
  asyncHandler(async (req, res) => {
    const id = String(req.params.id);
    const isActive = req.body?.isActive === true;

    // Cegah admin menonaktifkan dirinya sendiri
    if (req.user?.id === id && !isActive) {
      res.status(400).json({ error: "Anda tidak dapat menonaktifkan akun Anda sendiri." });
      return;
    }

    const updated = await prisma.user.update({
      where: { id },
      data: { isActive },
    });

    log.info(`Status akun pengguna ${updated.email} diubah menjadi ${isActive ? "Aktif" : "Nonaktif"} oleh ${req.user?.email}`);
    res.json({
      message: `Status akun pengguna berhasil ${isActive ? "diaktifkan" : "dinonaktifkan"}.`,
      data: sanitizeUser(updated),
    });
  }),
);

/**
 * Hapus akun pengguna
 * DELETE /api/admin/users/:id
 */
adminRouter.delete(
  "/users/:id",
  asyncHandler(async (req, res) => {
    const id = String(req.params.id);

    // Cegah admin menghapus dirinya sendiri
    if (req.user?.id === id) {
      res.status(400).json({ error: "Anda tidak dapat menghapus akun Anda sendiri." });
      return;
    }

    await prisma.user.delete({
      where: { id },
    });

    log.info(`Pengguna dengan ID ${id} dihapus oleh ${req.user?.email}`);
    res.status(204).end();
  }),
);
