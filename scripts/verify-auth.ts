import assert from "node:assert/strict";
import {
  hashPassword,
  verifyPassword,
  generateToken,
  verifyToken,
  validateEmail,
  validatePassword,
  sanitizeUser,
} from "../src/services/auth.js";

async function testAuth() {
  console.log("=== MEMULAI TEST UNIT FITUR AUTENTIKASI ===");

  // 1. Password Hashing & Verification
  const rawPass = "Secret123!";
  const hash = await hashPassword(rawPass);
  assert.notEqual(hash, rawPass);
  assert.ok(hash.startsWith("$2a$") || hash.startsWith("$2b$"));
  const isValid = await verifyPassword(rawPass, hash);
  assert.equal(isValid, true);
  const isInvalid = await verifyPassword("WrongPassword123!", hash);
  assert.equal(isInvalid, false);

  // Uji pembuktian salt unik: 2 hash dari kata sandi yang sama PERSIS harus menghasilkan hash yang BERBEDA
  const hashUserA = await hashPassword("PasswordSama123!");
  const hashUserB = await hashPassword("PasswordSama123!");
  assert.notEqual(hashUserA, hashUserB, "Salt gagal: dua user dengan password sama tidak boleh menghasilkan hash yang sama!");
  assert.equal(await verifyPassword("PasswordSama123!", hashUserA), true);
  assert.equal(await verifyPassword("PasswordSama123!", hashUserB), true);
  console.log("✓ Test 1 Lolos: Bcrypt hashing & verification bekerja dengan benar (Salt unik terbukti berbeda per user).");

  // 2. Email Validation
  assert.equal(validateEmail("User.Test@domain.com"), "user.test@domain.com");
  assert.throws(() => validateEmail("invalid-email"), /Format alamat email tidak valid/);
  assert.throws(() => validateEmail("user@.com"), /Format alamat email tidak valid/);
  console.log("✓ Test 2 Lolos: Sanitasi dan validasi format email bekerja akurat.");

  // 3. Password Strength Validation
  validatePassword("P@ssw0rd123");
  assert.throws(() => validatePassword("short"), /minimal harus 8 karakter/);
  assert.throws(() => validatePassword("onlylettersnohumber"), /kombinasi huruf dan angka/);
  assert.throws(() => validatePassword("12345678"), /kombinasi huruf dan angka/);
  console.log("✓ Test 3 Lolos: Validasi kompleksitas password berhasil menolak password lemah.");

  // 4. Token Generation & Verification
  const token = generateToken({
    id: "usr-123",
    email: "test@domain.com",
    name: "Tester",
    role: "ADMIN",
  });
  assert.ok(typeof token === "string" && token.length > 20);

  const decoded = verifyToken(token);
  assert.ok(decoded !== null);
  assert.equal(decoded.id, "usr-123");
  assert.equal(decoded.email, "test@domain.com");
  assert.equal(decoded.role, "ADMIN");

  const invalidDecoded = verifyToken("invalid.token.here");
  assert.equal(invalidDecoded, null);
  console.log("✓ Test 4 Lolos: JWT Token generation, signing, and verification bekerja aman.");

  // 5. User Sanitization
  const dummyUser = {
    id: "usr-1",
    email: "user@h5p.local",
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
  assert.equal(sanitized.role, "USER");
  console.log("✓ Test 5 Lolos: Sanitasi objek user tidak membocorkan hash password.");

  console.log("\n==============================================");
  console.log("SEMUA 5 SKENARIO TEST AUTENTIKASI BERHASIL!");
  console.log("==============================================");
}

testAuth().catch((err) => {
  console.error("Test autentikasi gagal:", err);
  process.exit(1);
});
