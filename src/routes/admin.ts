import { Router } from "express";
import { prisma } from "../db.js";
import { asyncHandler } from "../middleware/errorHandler.js";
import { authenticateToken, requireRole } from "../middleware/auth.js";
import { sanitizeUser } from "../services/auth.js";
import { createLogger } from "../utils/logger.js";
import type { Prisma, Role } from "@prisma/client";

const log = createLogger("admin");
export const adminRouter = Router();

const UUID_REGEX = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function parseUserIdParam(raw: unknown): string | null {
  const id = Array.isArray(raw) ? String(raw[0] ?? "") : String(raw ?? "");
  return UUID_REGEX.test(id) ? id : null;
}

function isNotFoundPrismaError(err: unknown): boolean {
  return (
    typeof err === "object" &&
    err !== null &&
    "code" in err &&
    (err as { code?: unknown }).code === "P2025"
  );
}

// Seluruh endpoint admin di bawah ini wajib terautentikasi dan memiliki Role ADMIN
adminRouter.use(authenticateToken);
adminRouter.use(requireRole("ADMIN"));

/**
 * Daftar seluruh pengguna sistem (dengan pencarian, filter role, filter status, dan ringkasan global)
 * GET /api/admin/users
 */
adminRouter.get(
  "/users",
  asyncHandler(async (req, res) => {
    const q = typeof req.query.q === "string" ? req.query.q.trim().slice(0, 100) : "";
    const role = typeof req.query.role === "string" ? req.query.role.trim().toUpperCase() : undefined;
    const statusParam = typeof req.query.status === "string" ? req.query.status.trim().toUpperCase() : "";
    const page = Math.max(1, Number(req.query.page) || 1);
    const limit = Math.min(100, Math.max(1, Number(req.query.limit) || 20));
    const skip = (page - 1) * limit;

    const where: Prisma.UserWhereInput = {};

    if (role === "ADMIN" || role === "USER") {
      where.role = role as Role;
    }

    if (statusParam === "ACTIVE") {
      where.isActive = true;
    } else if (statusParam === "BLOCKED") {
      where.isActive = false;
    }

    if (q) {
      where.OR = [
        { email: { contains: q, mode: "insensitive" } },
        { name: { contains: q, mode: "insensitive" } },
      ];
    }

    const [total, users, totalUsers, activeUsers, adminCount] = await Promise.all([
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
      prisma.user.count(),
      prisma.user.count({ where: { isActive: true } }),
      prisma.user.count({ where: { role: "ADMIN" } }),
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
      summary: {
        totalUsers,
        activeUsers,
        adminCount,
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
    const id = parseUserIdParam(req.params.id);
    if (!id) {
      res.status(400).json({ error: "Format ID pengguna tidak valid." });
      return;
    }

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
    const id = parseUserIdParam(req.params.id);
    if (!id) {
      res.status(400).json({ error: "Format ID pengguna tidak valid." });
      return;
    }

    const targetRole = typeof req.body?.role === "string" ? req.body.role.trim().toUpperCase() : "";
    if (targetRole !== "ADMIN" && targetRole !== "USER") {
      res.status(400).json({ error: "Role tidak valid. Pilihan yang tersedia: ADMIN atau USER." });
      return;
    }

    // Cegah admin mencopot hak akses dirinya sendiri
    if (req.user?.id === id && targetRole !== "ADMIN") {
      res.status(400).json({ error: "Anda tidak dapat mengubah hak akses akun Anda sendiri dari Admin." });
      return;
    }

    try {
      const updated = await prisma.user.update({
        where: { id },
        data: { role: targetRole as Role },
      });

      log.info(`Role pengguna ${updated.email} diubah menjadi ${targetRole} oleh ${req.user?.email}`);
      res.json({
        message: `Role pengguna berhasil diubah menjadi ${targetRole}.`,
        data: sanitizeUser(updated),
      });
    } catch (err) {
      if (isNotFoundPrismaError(err)) {
        res.status(404).json({ error: "Pengguna tidak ditemukan." });
        return;
      }
      throw err;
    }
  }),
);

/**
 * Aktifkan / Nonaktifkan akun pengguna (Blokir / Buka Blokir)
 * PATCH /api/admin/users/:id/status
 */
adminRouter.patch(
  "/users/:id/status",
  asyncHandler(async (req, res) => {
    const id = parseUserIdParam(req.params.id);
    if (!id) {
      res.status(400).json({ error: "Format ID pengguna tidak valid." });
      return;
    }

    if (typeof req.body?.isActive !== "boolean") {
      res.status(400).json({ error: "Field 'isActive' wajib berupa boolean (true/false)." });
      return;
    }
    const isActive = req.body.isActive;

    // Cegah admin menonaktifkan dirinya sendiri
    if (req.user?.id === id && !isActive) {
      res.status(400).json({ error: "Anda tidak dapat menonaktifkan akun Anda sendiri." });
      return;
    }

    try {
      const updated = await prisma.user.update({
        where: { id },
        data: { isActive },
      });

      log.info(`Status akun pengguna ${updated.email} diubah menjadi ${isActive ? "Aktif" : "Nonaktif"} oleh ${req.user?.email}`);
      res.json({
        message: `Status akun pengguna berhasil ${isActive ? "diaktifkan" : "dinonaktifkan"}.`,
        data: sanitizeUser(updated),
      });
    } catch (err) {
      if (isNotFoundPrismaError(err)) {
        res.status(404).json({ error: "Pengguna tidak ditemukan." });
        return;
      }
      throw err;
    }
  }),
);

/**
 * Hapus akun pengguna
 * DELETE /api/admin/users/:id
 */
adminRouter.delete(
  "/users/:id",
  asyncHandler(async (req, res) => {
    const id = parseUserIdParam(req.params.id);
    if (!id) {
      res.status(400).json({ error: "Format ID pengguna tidak valid." });
      return;
    }

    // Cegah admin menghapus dirinya sendiri
    if (req.user?.id === id) {
      res.status(400).json({ error: "Anda tidak dapat menghapus akun Anda sendiri." });
      return;
    }

    try {
      await prisma.user.delete({
        where: { id },
      });

      log.info(`Pengguna dengan ID ${id} dihapus oleh ${req.user?.email}`);
      res.status(204).end();
    } catch (err) {
      if (isNotFoundPrismaError(err)) {
        res.status(404).json({ error: "Pengguna tidak ditemukan." });
        return;
      }
      throw err;
    }
  }),
);
