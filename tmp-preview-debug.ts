import { readFileSync } from "node:fs";
import { createPreviewSession } from "./src/h5p/player.js";
import { prisma } from "./src/db.js";

async function main() {
  const buf = readFileSync(process.argv[2]);
  try {
    const out = await createPreviewSession(buf, "Uji Pratinjau");
    console.log("OK", out);
  } catch (err) {
    console.error("FAILED:", err);
    if (err instanceof Error && err.stack) console.error(err.stack);
  } finally {
    await prisma.$disconnect();
  }
}
main();
