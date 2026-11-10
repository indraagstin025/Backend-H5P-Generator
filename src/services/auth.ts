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
  createdAt: Date;
  updatedAt: Date;
}

export interface RegisterInput {
  email: string;
  password: string;
  name: string;
  role?: Role;
}

export interface LoginInput {
  email: string;
  password: string;
}

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
    createdAt: user.createdAt,
    updatedAt: user.updatedAt,
  };
}

export async function hashPassword(plainText: string): Promise<string> {
  const salt = await bcrypt.genSalt(12);
  return bcrypt.hash(plainText, salt);
}

export async function verifyPassword(plainText: string, hash: string): Promise<boolean> {
  return bcrypt.compare(plainText, hash);
}

export function generateToken(payload: AuthTokenPayload): string {
  // Gunakan sign dengan secret dan batas waktu kedaluwarsa
  return jwt.sign(payload, config.jwt.secret, {
    expiresIn: config.jwt.expiresIn,
  } as jwt.SignOptions);
}

export function verifyToken(token: string): AuthTokenPayload | null {
  try {
    const decoded = jwt.verify(token, config.jwt.secret);
    if (typeof decoded === "object" && decoded !== null && "id" in decoded && "email" in decoded) {
      return decoded as AuthTokenPayload;
    }
    return null;
  } catch {
    return null;
  }
}

/**
 * Validasi ketat format email dan kekuatan kata sandi
 */
export function validateEmail(email: string): string {
  const clean = email.trim().toLowerCase();
  const emailRegex = /^[a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,}$/;
  if (!emailRegex.test(clean) || clean.length > 254) {
    throw createHttpError(400, "Format alamat email tidak valid.");
  }
  return clean;
}

export function validatePassword(password: string): void {
  if (typeof password !== "string" || password.length < 8) {
    throw createHttpError(400, "Kata sandi minimal harus 8 karakter.");
  }
  if (!/[A-Za-z]/.test(password) || !/[0-9]/.test(password)) {
    throw createHttpError(400, "Kata sandi harus mengandung kombinasi huruf dan angka.");
  }
}

export async function registerUser(input: RegisterInput): Promise<{ user: SafeUser; token: string }> {
  const email = validateEmail(input.email);
  validatePassword(input.password);

  const name = String(input.name ?? "").trim();
  if (name.length < 2 || name.length > 100) {
    throw createHttpError(400, "Nama pengguna harus diisi antara 2 hingga 100 karakter.");
  }

  // Cek apakah email sudah terdaftar
  const existing = await prisma.user.findUnique({
    where: { email },
    select: { id: true },
  });

  if (existing) {
    throw createHttpError(409, "Email tersebut sudah terdaftar di sistem. Silakan gunakan email lain atau masuk.");
  }

  const passwordHash = await hashPassword(input.password);
  const user = await prisma.user.create({
    data: {
      email,
      name,
      passwordHash,
      role: input.role === "ADMIN" ? "ADMIN" : "USER",
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
  const email = validateEmail(input.email);
  if (!input.password) {
    throw createHttpError(400, "Kata sandi wajib diisi.");
  }

  const user = await prisma.user.findUnique({
    where: { email },
  });

  // Perlindungan timing attack: jalankan dummy comparison jika user tidak ditemukan
  if (!user || !user.passwordHash) {
    await bcrypt.compare(input.password, "$2a$12$e80yJp9u8r5G7Q.uTqXj3O4FzYlY8G1c8g5x2q4j3k2m1n0o9p8q7");
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

/**
 * Inisialisasi akun bawaan: 1 Admin dan 1 Regular User (Seeder).
 */
export async function seedInitialUsers(): Promise<{
  admin: { email: string; created: boolean };
  user: { email: string; created: boolean };
}> {
  const adminEmail = "admin@h5p.local";
  const userEmail = "user@h5p.local";

  let adminCreated = false;
  let userCreated = false;

  // 1. Akun Admin
  const existingAdmin = await prisma.user.findUnique({ where: { email: adminEmail } });
  if (!existingAdmin) {
    const adminPassHash = await hashPassword("Admin1234!");
    await prisma.user.create({
      data: {
        email: adminEmail,
        name: "Administrator H5P",
        passwordHash: adminPassHash,
        role: "ADMIN",
        isActive: true,
      },
    });
    adminCreated = true;
  }

  // 2. Akun User Biasa
  const existingUser = await prisma.user.findUnique({ where: { email: userEmail } });
  if (!existingUser) {
    const userPassHash = await hashPassword("User1234!");
    await prisma.user.create({
      data: {
        email: userEmail,
        name: "Pengguna H5P",
        passwordHash: userPassHash,
        role: "USER",
        isActive: true,
      },
    });
    userCreated = true;
  }

  return {
    admin: { email: adminEmail, created: adminCreated },
    user: { email: userEmail, created: userCreated },
  };
}
