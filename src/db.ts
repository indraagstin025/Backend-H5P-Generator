import { PrismaClient } from "@prisma/client";

declare global {
  // Hindari koneksi ganda saat tsx watch me-reload modul.
  // eslint-disable-next-line no-var
  var __prisma: PrismaClient | undefined;
}

export const prisma: PrismaClient =
  globalThis.__prisma ?? new PrismaClient();

if (process.env.NODE_ENV !== "production") {
  globalThis.__prisma = prisma;
}
