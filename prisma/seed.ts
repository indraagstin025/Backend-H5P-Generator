import { prisma } from "../src/db.js";
import { seedInitialUsers } from "../src/services/auth.js";

/**
 * Prisma Database Seeder untuk akun bawaan Admin & User (@gmail.com).
 * Jalankan via:
 *   npm run db:seed
 *   npx prisma db seed
 */
async function main(): Promise<void> {
  const result = await seedInitialUsers();
  console.log(
    `✓ Akun ADMIN : ${result.admin.email} (${result.admin.created ? "dibuat baru" : "sudah terdaftar"})`,
  );
  console.log(
    `✓ Akun USER  : ${result.user.email} (${result.user.created ? "dibuat baru" : "sudah terdaftar"})`,
  );
}

main()
  .catch((err) => {
    console.error("Gagal menjalankan seeder akun pengguna:", err);
    process.exitCode = 1;
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
