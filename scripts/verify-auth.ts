import assert from "node:assert/strict";
import { config } from "../src/config.js";
import {
  TIMING_DUMMY_HASH,
  hashPassword,
  verifyPassword,
  generateToken,
  verifyToken,
  validateEmail,
  validateLoginEmail,
  validatePassword,
  validateName,
  validateBirthDate,
  generateDefaultPassword,
  sanitizeUser,
  resolveSeedDefinitions,
} from "../src/services/auth.js";
import { issueExchangeCode } from "../src/services/googleAuth.js";

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

  // 7. Resolusi Konfigurasi Seeder Admin & User
  const devSeeds = resolveSeedDefinitions({}, false);
  assert.equal(devSeeds.admin?.email, "admin.h5p@gmail.com");
  assert.equal(devSeeds.admin?.role, "ADMIN");
  assert.equal(devSeeds.user?.email, "user.h5p@gmail.com");
  assert.equal(devSeeds.user?.role, "USER");

  const prodWithoutPasswords = resolveSeedDefinitions({}, true);
  assert.equal(prodWithoutPasswords.admin, null);
  assert.equal(prodWithoutPasswords.user, null);

  const prodWithPasswords = resolveSeedDefinitions(
    {
      SEED_ADMIN_EMAIL: "Custom.Admin@gmail.com",
      SEED_ADMIN_PASSWORD: "ProdAdmin99!",
      SEED_USER_EMAIL: "Custom.User@gmail.com",
      SEED_USER_PASSWORD: "ProdUser99!",
    },
    true,
  );
  assert.equal(prodWithPasswords.admin?.email, "custom.admin@gmail.com");
  assert.equal(prodWithPasswords.user?.email, "custom.user@gmail.com");
  console.log("✓ Test 7 Lolos: Seeder Admin & User valid untuk dev dan aman di produksi.");

  // 8. Validasi Email Login Non-@gmail.com (Google Workspace)
  assert.equal(validateLoginEmail("  Dosen@Kampus.AC.ID "), "dosen@kampus.ac.id");
  assert.equal(validateLoginEmail("user@gmail.com"), "user@gmail.com");
  assert.throws(() => validateLoginEmail("invalid-email"), /Format alamat email tidak valid/);
  assert.throws(() => validateLoginEmail("user..name@kampus.ac.id"), /Format alamat email tidak valid/);
  console.log("✓ Test 8 Lolos: Validasi email login mendukung akun Google Workspace & @gmail.com.");

  // 9. Sandi Bawaan Otomatis & Validasi Tanggal Lahir
  const autoPass = generateDefaultPassword();
  assert.equal(validatePassword(autoPass), autoPass);
  assert.ok(autoPass.length >= 12);

  const dob = validateBirthDate("2000-05-17");
  assert.equal(dob.toISOString().slice(0, 10), "2000-05-17");
  assert.throws(() => validateBirthDate("2000-02-31"), /tidak valid/);
  assert.throws(() => validateBirthDate("2999-01-01"), /hingga hari ini/);
  assert.throws(() => validateBirthDate("17-05-2000"), /YYYY-MM-DD/);
  console.log("✓ Test 9 Lolos: Sandi bawaan otomatis memenuhi kebijakan password & validasi tanggal lahir akurat.");

  // 10. One-time Exchange Code OAuth
  const code = issueExchangeCode("550e8400-e29b-41d4-a716-446655440000", autoPass);
  assert.ok(typeof code === "string" && code.length >= 32);
  console.log("✓ Test 10 Lolos: One-time exchange code OAuth terbangkitkan dengan entropi aman.");

  console.log("\n========================================================");
  console.log("SEMUA 10 SKENARIO TEST & SECURITY HARDENING BERHASIL!");
  console.log("========================================================");
}

testAuth().catch((err) => {
  console.error("Test autentikasi gagal:", err);
  process.exit(1);
});
