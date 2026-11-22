import crypto from "node:crypto";
import bcrypt from "bcryptjs";
import jwt from "jsonwebtoken";
import { prisma } from "../db.js";
import { config } from "../config.js";
import type { Role } from "@prisma/client";

export interface AuthTokenPayload {
  id: string;
  email: string;
  name: string;
  role: Role;
}

export interface SafeUser {
  id: string;
  email: string;
  name: string;
  role: Role;
  isActive: boolean;
  avatarUrl: string | null;
  birthDate: string | null;
  profileCompleted: boolean;
  createdAt: Date;
  updatedAt: Date;
}

export interface RegisterInput {
  email: unknown;
  password: unknown;
  name: unknown;
}

export interface LoginInput {
  email: unknown;
  password: unknown;
}

const BCRYPT_ROUNDS = 12;
const MAX_PASSWORD_LENGTH = 128;

// Hash dummy bcrypt 60-karakter asli yang dibangkitkan sekali saat modul dimuat
// agar perbandingan gagal pada akun tak terdaftar tetap menghabiskan waktu CPU bcrypt yang setara.
export const TIMING_DUMMY_HASH = bcrypt.hashSync(crypto.randomBytes(32).toString("hex"), BCRYPT_ROUNDS);

function createHttpError(status: number, message: string): Error & { status: number } {
  return Object.assign(new Error(message), { status });
}

export function sanitizeUser(user: {
  id: string;
  email: string;
  name: string;
  role: Role;
  isActive: boolean;
  avatarUrl: string | null;
  birthDate?: Date | null;
  profileCompleted?: boolean;
  createdAt: Date;
  updatedAt: Date;
}): SafeUser {
  return {
    id: user.id,
    email: user.email,
    name: user.name,
    role: user.role,
    isActive: user.isActive,
    avatarUrl: user.avatarUrl,
    birthDate: user.birthDate ? user.birthDate.toISOString().slice(0, 10) : null,
    profileCompleted: user.profileCompleted !== false,
    createdAt: user.createdAt,
    updatedAt: user.updatedAt,
  };
}

export async function hashPassword(plainText: string): Promise<string> {
  const salt = await bcrypt.genSalt(BCRYPT_ROUNDS);
  return bcrypt.hash(plainText, salt);
}

export async function verifyPassword(plainText: string, hash: string): Promise<boolean> {
  return bcrypt.compare(plainText, hash);
}

export function generateToken(payload: AuthTokenPayload): string {
  // Kunci algoritma HS256 agar mencegah downgrade/alg-none attack
  return jwt.sign(
    {
      id: payload.id,
      email: payload.email,
      name: payload.name,
      role: payload.role,
    },
    config.jwt.secret,
    {
      algorithm: "HS256",
      expiresIn: config.jwt.expiresIn,
    } as jwt.SignOptions,
  );
}

export function verifyToken(token: string): AuthTokenPayload | null {
  try {
    if (typeof token !== "string" || token.length === 0 || token.length > 4096) {
      return null;
    }
    const decoded = jwt.verify(token, config.jwt.secret, {
      algorithms: ["HS256"],
    });
    if (
      typeof decoded === "object" &&
      decoded !== null &&
      typeof (decoded as Record<string, unknown>).id === "string" &&
      (decoded as Record<string, unknown>).id !== "" &&
      typeof (decoded as Record<string, unknown>).email === "string" &&
      typeof (decoded as Record<string, unknown>).name === "string" &&
      ((decoded as Record<string, unknown>).role === "ADMIN" ||
        (decoded as Record<string, unknown>).role === "USER")
    ) {
      return {
        id: (decoded as Record<string, string>).id,
        email: (decoded as Record<string, string>).email,
        name: (decoded as Record<string, string>).name,
        role: (decoded as Record<string, Role>).role,
      };
    }
    return null;
  } catch {
    return null;
  }
}

/**
 * Validasi ketat format alamat email: wajib domain @gmail.com (selaras dengan validasi frontend).
 */
export function validateEmail(email: unknown): string {
  if (typeof email !== "string") {
    throw createHttpError(400, "Format alamat email tidak valid.");
  }
  const clean = email.trim().toLowerCase();
  const gmailRegex = /^[a-z0-9._%+-]+@gmail\.com$/;
  if (!gmailRegex.test(clean) || clean.includes("..") || clean.startsWith(".") || clean.includes(".@") || clean.length > 254) {
    throw createHttpError(400, "Email harus menggunakan format nama@gmail.com yang valid.");
  }
  return clean;
}

/**
 * Validasi format email standar untuk login (mengizinkan @gmail.com maupun domain Google Workspace).
 */
export function validateLoginEmail(email: unknown): string {
  if (typeof email !== "string") {
    throw createHttpError(400, "Format alamat email tidak valid.");
  }
  const clean = email.trim().toLowerCase();
  const emailRegex = /^[a-z0-9._%+-]+@[a-z0-9.-]+\.[a-z]{2,}$/;
  if (!emailRegex.test(clean) || clean.includes("..") || clean.startsWith(".") || clean.includes(".@") || clean.length > 254) {
    throw createHttpError(400, "Format alamat email tidak valid.");
  }
  return clean;
}

/**
 * Bangkitkan kata sandi bawaan acak yang aman (12 karakter kombinasi huruf & angka) untuk akun Google baru.
 */
export function generateDefaultPassword(): string {
  const upper = "ABCDEFGHJKLMNPQRSTUVWXYZ";
  const lower = "abcdefghijkmnopqrstuvwxyz";
  const digits = "23456789";
  const all = upper + lower + digits;
  const chars = [
    upper[crypto.randomInt(upper.length)],
    lower[crypto.randomInt(lower.length)],
    digits[crypto.randomInt(digits.length)],
  ];
  for (let i = chars.length; i < 12; i++) {
    chars.push(all[crypto.randomInt(all.length)]);
  }
  for (let i = chars.length - 1; i > 0; i--) {
    const j = crypto.randomInt(i + 1);
    [chars[i], chars[j]] = [chars[j], chars[i]];
  }
  return chars.join("");
}

export function validateBirthDate(raw: unknown): Date {
  if (typeof raw !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(raw.trim())) {
    throw createHttpError(400, "Tanggal lahir wajib diisi dengan format YYYY-MM-DD.");
  }
  const clean = raw.trim();
  const [y, m, d] = clean.split("-").map(Number);
  const parsed = new Date(Date.UTC(y, m - 1, d));
  if (
    Number.isNaN(parsed.getTime()) ||
    parsed.getUTCFullYear() !== y ||
    parsed.getUTCMonth() !== m - 1 ||
    parsed.getUTCDate() !== d
  ) {
    throw createHttpError(400, "Tanggal lahir tidak valid.");
  }
  const today = new Date();
  const todayUtc = new Date(Date.UTC(today.getUTCFullYear(), today.getUTCMonth(), today.getUTCDate()));
  if (parsed > todayUtc || y < 1900) {
    throw createHttpError(400, "Tanggal lahir harus berada di antara tahun 1900 hingga hari ini.");
  }
  return parsed;
}

export function validatePassword(password: unknown): string {
  if (typeof password !== "string" || password.length < 8) {
    throw createHttpError(400, "Kata sandi minimal harus 8 karakter.");
  }
  // Batasi 128 karakter untuk mencegah CPU DoS dan batas pemotongan 72-byte pada bcrypt
  if (password.length > MAX_PASSWORD_LENGTH) {
    throw createHttpError(400, `Kata sandi maksimal ${MAX_PASSWORD_LENGTH} karakter.`);
  }
  if (!/[A-Za-z]/.test(password) || !/[0-9]/.test(password)) {
    throw createHttpError(400, "Kata sandi harus mengandung kombinasi huruf dan angka.");
  }
  return password;
}

export function validateName(name: unknown): string {
  if (typeof name !== "string") {
    throw createHttpError(400, "Nama pengguna wajib diisi.");
  }
  // Hapus karakter kontrol berbahaya dan spasi berlebih
  const clean = name.replace(/[\x00-\x1F\x7F]/g, "").trim();
  if (clean.length < 2 || clean.length > 100) {
    throw createHttpError(400, "Nama pengguna harus diisi antara 2 hingga 100 karakter.");
  }
  return clean;
}

/**
 * Pendaftaran pengguna publik: role selalu dikunci ke USER untuk mencegah privilege escalation.
 */
export async function registerUser(input: RegisterInput): Promise<{ user: SafeUser; token: string }> {
  const email = validateEmail(input.email);
  const password = validatePassword(input.password);
  const name = validateName(input.name);

  const existing = await prisma.user.findUnique({
    where: { email },
    select: { id: true },
  });

  if (existing) {
    throw createHttpError(409, "Email tersebut sudah terdaftar di sistem. Silakan gunakan email lain atau masuk.");
  }

  const passwordHash = await hashPassword(password);
  const user = await prisma.user.create({
    data: {
      email,
      name,
      passwordHash,
      role: "USER",
      isActive: true,
    },
  });

  const token = generateToken({
    id: user.id,
    email: user.email,
    name: user.name,
    role: user.role,
  });

  return { user: sanitizeUser(user), token };
}

export async function loginUser(input: LoginInput): Promise<{ user: SafeUser; token: string }> {
  const email = validateLoginEmail(input.email);
  if (typeof input.password !== "string" || input.password.length === 0) {
    throw createHttpError(400, "Kata sandi wajib diisi.");
  }
  if (input.password.length > MAX_PASSWORD_LENGTH) {
    throw createHttpError(401, "Email atau kata sandi tidak valid.");
  }

  const user = await prisma.user.findUnique({
    where: { email },
  });

  // Perlindungan timing attack: tetap lakukan komputasi bcrypt asli jika akun tidak ada
  if (!user || !user.passwordHash) {
    await bcrypt.compare(input.password, TIMING_DUMMY_HASH);
    throw createHttpError(401, "Email atau kata sandi tidak valid.");
  }

  if (!user.isActive) {
    throw createHttpError(403, "Akun Anda telah dinonaktifkan oleh Administrator. Silakan hubungi admin.");
  }

  const isPasswordValid = await verifyPassword(input.password, user.passwordHash);
  if (!isPasswordValid) {
    throw createHttpError(401, "Email atau kata sandi tidak valid.");
  }

  const token = generateToken({
    id: user.id,
    email: user.email,
    name: user.name,
    role: user.role,
  });

  return { user: sanitizeUser(user), token };
}

export async function getUserById(id: string): Promise<SafeUser | null> {
  const user = await prisma.user.findUnique({
    where: { id },
  });
  return user ? sanitizeUser(user) : null;
}

export async function completeUserProfile(
  userId: string,
  input: {
    name: unknown;
    birthDate: unknown;
    newPassword?: unknown;
  },
): Promise<SafeUser> {
  const name = validateName(input.name);
  const birthDate = validateBirthDate(input.birthDate);

  let passwordHash: string | undefined;
  if (typeof input.newPassword === "string" && input.newPassword.length > 0) {
    const validated = validatePassword(input.newPassword);
    passwordHash = await hashPassword(validated);
  }

  const updated = await prisma.user.update({
    where: { id: userId },
    data: {
      name,
      birthDate,
      profileCompleted: true,
      ...(passwordHash ? { passwordHash } : {}),
    },
  });

  return sanitizeUser(updated);
}

export interface SeedAccountDefinition {
  email: string;
  name: string;
  password: string;
  role: Role;
}

export interface SeedAccountStatus {
  email: string;
  created: boolean;
}

/**
 * Menyusun konfigurasi akun seeder (Admin & User) dari environment variable.
 * Di lingkungan produksi, akun hanya dibuat bila password eksplisit disetel agar
 * kredensial bawaan pengembangan tidak pernah aktif di produksi.
 */
export function resolveSeedDefinitions(
  env: NodeJS.ProcessEnv = process.env,
  isProduction: boolean = config.isProduction,
): { admin: SeedAccountDefinition | null; user: SeedAccountDefinition | null } {
  const buildDefinition = (
    prefix: "SEED_ADMIN" | "SEED_USER",
    role: Role,
    defaults: { email: string; name: string; password: string },
  ): SeedAccountDefinition | null => {
    const rawPassword = env[`${prefix}_PASSWORD`]?.trim();
    if (isProduction && !rawPassword) {
      return null;
    }
    const email = validateEmail(env[`${prefix}_EMAIL`]?.trim() || defaults.email);
    const name = validateName(env[`${prefix}_NAME`]?.trim() || defaults.name);
    const password = validatePassword(rawPassword || defaults.password);
    return { email, name, password, role };
  };

  return {
    admin: buildDefinition("SEED_ADMIN", "ADMIN", {
      email: "admin.h5p@gmail.com",
      name: "Administrator H5P",
      password: "Admin1234!",
    }),
    user: buildDefinition("SEED_USER", "USER", {
      email: "user.h5p@gmail.com",
      name: "Pengguna H5P",
      password: "User1234!",
    }),
  };
}

async function ensureSeedAccount(def: SeedAccountDefinition): Promise<SeedAccountStatus> {
  const existing = await prisma.user.findUnique({ where: { email: def.email }, select: { id: true } });
  if (existing) {
    return { email: def.email, created: false };
  }

  const passwordHash = await hashPassword(def.password);
  await prisma.user.create({
    data: {
      email: def.email,
      name: def.name,
      passwordHash,
      role: def.role,
      isActive: true,
    },
  });
  return { email: def.email, created: true };
}

/**
 * Inisialisasi akun bawaan: 1 Admin dan 1 Regular User berdomain @gmail.com (Idempoten).
 */
export async function seedInitialUsers(): Promise<{
  admin: SeedAccountStatus;
  user: SeedAccountStatus;
}> {
  const defs = resolveSeedDefinitions();
  const admin = defs.admin
    ? await ensureSeedAccount(defs.admin)
    : { email: "admin.h5p@gmail.com", created: false };
  const user = defs.user
    ? await ensureSeedAccount(defs.user)
    : { email: "user.h5p@gmail.com", created: false };

  return { admin, user };
}
