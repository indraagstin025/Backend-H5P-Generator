import assert from "node:assert/strict";
import { config } from "../src/config.js";
import {
  TIMING_DUMMY_HASH,
  hashPassword,
  verifyPassword,
  generateToken,
  verifyToken,
  validateEmail,
  validatePassword,
  validateName,
  sanitizeUser,
} from "../src/services/auth.js";

async function testAuth() {
  console.log("=== MEMULAI TEST UNIT & SECURITY AUTENTIKASI ===");

  // 1. Password Hashing, Salt Unik & Timing Attack Dummy Hash
  const rawPass = "Secret123!";
  const hash = await hashPassword(rawPass);
  assert.notEqual(hash, rawPass);
  assert.ok(hash.startsWith("$2a$") || hash.startsWith("$2b$"));
  assert.equal(await verifyPassword(rawPass, hash), true);
  assert.equal(await verifyPassword("WrongPassword123!", hash), false);

  const hashUserA = await hashPassword("PasswordSama123!");
  const hashUserB = await hashPassword("PasswordSama123!");
  assert.notEqual(
    hashUserA,
    hashUserB,
    "Salt gagal: dua user dengan password sama tidak boleh menghasilkan hash yang sama!"
  );
  assert.equal(await verifyPassword("PasswordSama123!", hashUserA), true);
  assert.equal(await verifyPassword("PasswordSama123!", hashUserB), true);

  assert.ok(
    TIMING_DUMMY_HASH.startsWith("$2a$") || TIMING_DUMMY_HASH.startsWith("$2b$"),
    "TIMING_DUMMY_HASH harus merupakan bcrypt hash valid"
  );
  assert.equal(TIMING_DUMMY_HASH.length, 60);
  assert.equal(await verifyPassword(rawPass, TIMING_DUMMY_HASH), false);
  console.log("✓ Test 1 Lolos: Bcrypt hashing, salt unik, dan TIMING_DUMMY_HASH terverifikasi.");

  // 2. Strict @gmail.com Email Validation
  assert.equal(validateEmail("  User.Test@Gmail.COM  "), "user.test@gmail.com");
  assert.equal(validateEmail("admin.h5p@gmail.com"), "admin.h5p@gmail.com");
  assert.throws(() => validateEmail("user@domain.com"), /@gmail\.com/);
  assert.throws(() => validateEmail("guru@sekolah.sch.id"), /@gmail\.com/);
  assert.throws(() => validateEmail("user..name@gmail.com"), /@gmail\.com/);
  assert.throws(() => validateEmail("invalid-email"), /@gmail\.com/);
  assert.throws(
    () => validateEmail(12345 as unknown as string),
    /Format alamat email tidak valid/
  );
  console.log("✓ Test 2 Lolos: Kebijakan wajib @gmail.com, sanitasi, dan anti-type-confusion bekerja akurat.");

  // 3. Password Complexity & Upper-Bound DoS Guard (max 128 chars)
  assert.equal(validatePassword("P@ssw0rd123"), "P@ssw0rd123");
  assert.throws(() => validatePassword("short"), /minimal harus 8 karakter/);
  assert.throws(() => validatePassword("onlylettersnohumber"), /kombinasi huruf dan angka/);
  assert.throws(() => validatePassword("12345678"), /kombinasi huruf dan angka/);
  assert.throws(
    () => validatePassword("A1" + "a".repeat(130)),
    (err: unknown) =>
      err instanceof Error && (err as { status?: number }).status === 400
  );
  assert.throws(
    () => validatePassword(null),
    (err: unknown) =>
      err instanceof Error && (err as { status?: number }).status === 400
  );
  console.log("✓ Test 3 Lolos: Validasi kompleksitas dan batas atas panjang password (DoS guard) lolos.");

  // 4. Name Sanitization (Control Character Stripping & Bounds)
  assert.equal(validateName("  Budi\x00 Santoso\x1F  "), "Budi Santoso");
  assert.throws(
    () => validateName("A"),
    (err: unknown) =>
      err instanceof Error && (err as { status?: number }).status === 400
  );
  assert.throws(
    () => validateName("a".repeat(101)),
    (err: unknown) =>
      err instanceof Error && (err as { status?: number }).status === 400
  );
  console.log("✓ Test 4 Lolos: Sanitasi karakter kontrol pada nama pengguna bekerja.");

  // 5. Token Generation, HS256 Pinning & alg:none Rejection
  assert.ok(typeof config.jwt.secret === "string" && config.jwt.secret.length >= 32);
  assert.ok(Array.isArray(config.corsOrigins));

  const token = generateToken({
    id: "usr-123",
    email: "admin.h5p@gmail.com",
    name: "Tester",
    role: "ADMIN",
  });
  assert.ok(typeof token === "string" && token.length > 20);

  const decoded = verifyToken(token);
  assert.ok(decoded !== null);
  assert.equal(decoded.id, "usr-123");
  assert.equal(decoded.email, "admin.h5p@gmail.com");
  assert.equal(decoded.role, "ADMIN");

  assert.equal(verifyToken("invalid.token.here"), null);
  const tamperedToken = token.slice(0, -4) + (token.endsWith("aaaa") ? "bbbb" : "aaaa");
  assert.equal(verifyToken(tamperedToken), null);

  const unsignedHeader = Buffer.from(
    JSON.stringify({ alg: "none", typ: "JWT" })
  ).toString("base64url");
  const unsignedPayload = Buffer.from(
    JSON.stringify({
      id: "usr-123",
      email: "admin.h5p@gmail.com",
      name: "Attacker",
      role: "ADMIN",
    })
  ).toString("base64url");
  assert.equal(verifyToken(`${unsignedHeader}.${unsignedPayload}.`), null);
  console.log("✓ Test 5 Lolos: JWT HS256 signing, signature check, dan penolakan alg:none terverifikasi.");

  // 6. User Sanitization
  const dummyUser = {
    id: "usr-1",
    email: "user.h5p@gmail.com",
    name: "User Biasa",
    passwordHash: "super-secret-hash",
    role: "USER" as const,
    isActive: true,
    avatarUrl: null,
    createdAt: new Date(),
    updatedAt: new Date(),
  };
  const sanitized = sanitizeUser(dummyUser);
  assert.equal("passwordHash" in sanitized, false);
  assert.equal(sanitized.id, "usr-1");
  assert.equal(sanitized.email, "user.h5p@gmail.com");
  assert.equal(sanitized.role, "USER");
  console.log("✓ Test 6 Lolos: Sanitasi objek user tidak membocorkan hash password.");

  console.log("\n========================================================");
  console.log("SEMUA 6 SKENARIO TEST & SECURITY HARDENING BERHASIL!");
  console.log("========================================================");
}

testAuth().catch((err) => {
  console.error("Test autentikasi gagal:", err);
  process.exit(1);
});
