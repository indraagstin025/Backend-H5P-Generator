import assert from "node:assert/strict";
import express from "express";
import type { AddressInfo } from "node:net";
import { prisma } from "../src/db.js";
import { adminRouter } from "../src/routes/admin.js";
import { errorHandler } from "../src/middleware/errorHandler.js";
import { generateToken, verifyPassword } from "../src/services/auth.js";

async function main() {
  const admin = {
    id: "11111111-1111-4111-8111-111111111111", name: "Test Admin",
    email: "test.admin@gmail.com", role: "ADMIN" as const, isActive: true,
    avatarUrl: null, createdAt: new Date(), updatedAt: new Date(),
  };
  const regular = { ...admin, id: "22222222-2222-4222-8222-222222222222", role: "USER" as const };
  let duplicate = false;
  let writes = 0;
  let savedHash = "";
  const originalFindUnique = prisma.user.findUnique;
  const originalCreate = prisma.user.create;
  prisma.user.findUnique = (async ({ where }: { where: { id: string } }) => (
    where.id === admin.id ? admin : regular
  )) as typeof originalFindUnique;
  prisma.user.create = (async ({ data }: {
    data: { name: string; email: string; passwordHash: string; role: string; isActive: boolean };
  }) => {
    writes++;
    if (duplicate) throw Object.assign(new Error("Duplicate"), { code: "P2002" });
    savedHash = data.passwordHash;
    return { ...admin, ...data, id: "33333333-3333-4333-8333-333333333333" };
  }) as typeof originalCreate;

  const app = express();
  app.use(express.json());
  app.use("/api/admin", adminRouter);
  app.use(errorHandler);
  const server = app.listen(0, "127.0.0.1");
  await new Promise<void>((resolve) => server.once("listening", resolve));
  const url = `http://127.0.0.1:${(server.address() as AddressInfo).port}/api/admin/users`;
  const input = { name: "  New User  ", email: " NEW.USER@GMAIL.COM ", password: "Testing123!", role: "ADMIN" };
  const adminToken = generateToken(admin);
  async function post(body: unknown, token?: string) {
    return fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json", ...(token ? { Authorization: `Bearer ${token}` } : {}) },
      body: JSON.stringify(body),
    });
  }

  try {
    assert.equal((await post(input)).status, 401);
    assert.equal((await post(input, generateToken(regular))).status, 403);
    assert.equal(writes, 0, "Unauthorized requests must never create accounts");
    for (const invalid of [
      { ...input, name: "A" }, { ...input, email: "user@example.com" },
      { ...input, password: "short" }, { ...input, password: "onlyletters" }, {},
    ]) assert.equal((await post(invalid, adminToken)).status, 400);
    assert.equal(writes, 0, "Invalid input must never reach user.create");
    const response = await post(input, adminToken);
    assert.equal(response.status, 201);
    const result = await response.json();
    assert.equal(result.data.email, "new.user@gmail.com");
    assert.equal(result.data.name, "New User");
    assert.equal(result.data.role, "USER", "Client-supplied ADMIN role must be ignored");
    assert.equal(result.data.isActive, true);
    assert.equal(result.data.projectsCount, 0);
    assert.equal("passwordHash" in result.data, false);
    assert.equal("token" in result, false, "Creating an account must not replace the admin session");
    assert.notEqual(savedHash, input.password);
    assert.equal(await verifyPassword(input.password, savedHash), true);
    duplicate = true;
    assert.equal((await post(input, adminToken)).status, 409);
    console.log("PASS: admin-only creation, input validation, normalized identity, USER role, bcrypt, safe response, duplicate email.");
  } finally {
    prisma.user.findUnique = originalFindUnique;
    prisma.user.create = originalCreate;
    await new Promise<void>((resolve, reject) => server.close((err) => err ? reject(err) : resolve()));
    await prisma.$disconnect();
  }
}

main().catch((err) => { console.error(err); process.exitCode = 1; });
