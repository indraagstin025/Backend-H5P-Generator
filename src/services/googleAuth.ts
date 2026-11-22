import crypto from "node:crypto";
import jwt from "jsonwebtoken";
import { OAuth2Client } from "google-auth-library";
import { config } from "../config.js";
import { prisma } from "../db.js";
import {
  generateDefaultPassword,
  generateToken,
  hashPassword,
  sanitizeUser,
  validateLoginEmail,
  type SafeUser,
} from "./auth.js";

const STATE_TTL_MS = 5 * 60 * 1000;
const EXCHANGE_TTL_MS = 60 * 1000;

interface PendingStateEntry {
  expiresAt: number;
}

interface PendingExchangeEntry {
  userId: string;
  generatedPassword?: string;
  expiresAt: number;
}

const pendingStates = new Map<string, PendingStateEntry>();
const pendingExchanges = new Map<string, PendingExchangeEntry>();

function createHttpError(status: number, message: string): Error & { status: number } {
  return Object.assign(new Error(message), { status });
}

function purgeExpiredEntries(): void {
  const now = Date.now();
  for (const [key, entry] of pendingStates) {
    if (entry.expiresAt <= now) pendingStates.delete(key);
  }
  for (const [key, entry] of pendingExchanges) {
    if (entry.expiresAt <= now) pendingExchanges.delete(key);
  }
}

export function isGoogleOAuthConfigured(): boolean {
  return Boolean(config.google.clientId && config.google.clientSecret);
}

function createOAuthClient(): OAuth2Client {
  if (!isGoogleOAuthConfigured()) {
    throw createHttpError(503, "Login Google belum dikonfigurasi pada server.");
  }
  return new OAuth2Client(config.google.clientId, config.google.clientSecret, config.google.redirectUri);
}

export function createGoogleAuthUrl(): string {
  purgeExpiredEntries();
  const client = createOAuthClient();
  const nonce = crypto.randomUUID();
  pendingStates.set(nonce, { expiresAt: Date.now() + STATE_TTL_MS });

  const state = jwt.sign({ nonce, purpose: "google-oauth" }, config.jwt.secret, {
    algorithm: "HS256",
    expiresIn: "5m",
  });

  return client.generateAuthUrl({
    access_type: "online",
    scope: ["openid", "email", "profile"],
    prompt: "select_account",
    state,
  });
}

function verifyAndConsumeState(rawState: unknown): void {
  purgeExpiredEntries();
  if (typeof rawState !== "string" || !rawState.trim()) {
    throw createHttpError(400, "Parameter state OAuth tidak ditemukan.");
  }

  let decoded: unknown;
  try {
    decoded = jwt.verify(rawState, config.jwt.secret, { algorithms: ["HS256"] });
  } catch {
    throw createHttpError(400, "Sesi login Google kedaluwarsa atau tidak valid. Silakan ulangi.");
  }

  const nonce =
    typeof decoded === "object" &&
    decoded !== null &&
    (decoded as Record<string, unknown>).purpose === "google-oauth" &&
    typeof (decoded as Record<string, unknown>).nonce === "string"
      ? ((decoded as Record<string, unknown>).nonce as string)
      : null;

  if (!nonce || !pendingStates.has(nonce)) {
    throw createHttpError(400, "State OAuth sudah digunakan atau kedaluwarsa. Silakan coba lagi.");
  }
  pendingStates.delete(nonce);
}

export function issueExchangeCode(userId: string, generatedPassword?: string): string {
  purgeExpiredEntries();
  const code = crypto.randomBytes(32).toString("base64url");
  pendingExchanges.set(code, {
    userId,
    generatedPassword,
    expiresAt: Date.now() + EXCHANGE_TTL_MS,
  });
  return code;
}

export async function resolveGoogleProfileAndIssueCode(profile: {
  googleId: string;
  email: string;
  emailVerified: boolean;
  name: string;
  avatarUrl: string | null;
}): Promise<string> {
  if (!profile.emailVerified) {
    throw createHttpError(403, "Email pada akun Google Anda belum terverifikasi.");
  }

  const cleanEmail = validateLoginEmail(profile.email);
  const cleanName = profile.name.replace(/[\x00-\x1F\x7F]/g, "").trim().slice(0, 100) || cleanEmail.split("@")[0];

  let user = await prisma.user.findUnique({
    where: { googleId: profile.googleId },
  });

  if (!user) {
    user = await prisma.user.findUnique({
      where: { email: cleanEmail },
    });
  }

  if (user && !user.isActive) {
    throw createHttpError(403, "Akun Anda telah dinonaktifkan oleh Administrator. Silakan hubungi admin.");
  }

  let generatedPassword: string | undefined;

  if (!user) {
    generatedPassword = generateDefaultPassword();
    const passwordHash = await hashPassword(generatedPassword);
    user = await prisma.user.create({
      data: {
        email: cleanEmail,
        name: cleanName.length >= 2 ? cleanName : `${cleanName} User`,
        googleId: profile.googleId,
        passwordHash,
        avatarUrl: profile.avatarUrl,
        role: "USER",
        isActive: true,
        profileCompleted: false,
      },
    });
  } else {
    const updates: Record<string, unknown> = {};
    if (!user.googleId) {
      updates.googleId = profile.googleId;
    }
    if (!user.avatarUrl && profile.avatarUrl) {
      updates.avatarUrl = profile.avatarUrl;
    }
    if (!user.passwordHash) {
      generatedPassword = generateDefaultPassword();
      updates.passwordHash = await hashPassword(generatedPassword);
      updates.profileCompleted = false;
    }
    if (Object.keys(updates).length > 0) {
      user = await prisma.user.update({
        where: { id: user.id },
        data: updates,
      });
    }
  }

  return issueExchangeCode(user.id, generatedPassword);
}

export async function handleGoogleCallback(code: unknown, state: unknown): Promise<string> {
  verifyAndConsumeState(state);

  if (typeof code !== "string" || !code.trim()) {
    throw createHttpError(400, "Kode otorisasi Google tidak ditemukan.");
  }

  const client = createOAuthClient();
  const { tokens } = await client.getToken(code.trim());
  if (!tokens.id_token) {
    throw createHttpError(401, "Google tidak mengembalikan ID token yang valid.");
  }

  const ticket = await client.verifyIdToken({
    idToken: tokens.id_token,
    audience: config.google.clientId,
  });
  const payload = ticket.getPayload();
  if (!payload || !payload.sub || !payload.email) {
    throw createHttpError(401, "Profil akun Google tidak lengkap.");
  }

  return resolveGoogleProfileAndIssueCode({
    googleId: payload.sub,
    email: payload.email,
    emailVerified: payload.email_verified === true,
    name: payload.name || payload.email.split("@")[0],
    avatarUrl: typeof payload.picture === "string" ? payload.picture : null,
  });
}

export async function exchangeGoogleOneTimeCode(
  code: unknown,
): Promise<{ user: SafeUser; token: string; generatedPassword?: string }> {
  purgeExpiredEntries();
  if (typeof code !== "string" || !code.trim()) {
    throw createHttpError(400, "Kode pertukaran sesi Google wajib diisi.");
  }

  const entry = pendingExchanges.get(code.trim());
  if (!entry || entry.expiresAt <= Date.now()) {
    pendingExchanges.delete(code.trim());
    throw createHttpError(401, "Sesi login Google sudah kedaluwarsa atau telah digunakan. Silakan login ulang.");
  }
  pendingExchanges.delete(code.trim());

  const user = await prisma.user.findUnique({
    where: { id: entry.userId },
  });
  if (!user) {
    throw createHttpError(401, "Akun pengguna tidak ditemukan.");
  }
  if (!user.isActive) {
    throw createHttpError(403, "Akun Anda telah dinonaktifkan oleh Administrator. Silakan hubungi admin.");
  }

  const token = generateToken({
    id: user.id,
    email: user.email,
    name: user.name,
    role: user.role,
  });

  return {
    user: sanitizeUser(user),
    token,
    ...(entry.generatedPassword ? { generatedPassword: entry.generatedPassword } : {}),
  };
}
