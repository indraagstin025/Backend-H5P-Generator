import { applyCoursePresentationPatches, getH5P, systemUser } from "./h5pService.js";
import { promises as fs } from "node:fs";
import path from "node:path";
import { config } from "../config.js";

async function installLocalLibraries(): Promise<void> {
  const source = path.resolve(process.env.H5P_LIBRARY_SOURCE || "../Frontend-H5P-Generator/public/h5p-libraries");
  const available = await fs.stat(source).catch(() => null);
  if (!available?.isDirectory()) {
    if (process.env.H5P_LIBRARY_SOURCE) throw new Error("Folder H5P_LIBRARY_SOURCE tidak ditemukan.");
    return;
  }
  const target = path.join(config.storageDir, "h5p", "libraries");
  await fs.mkdir(target, { recursive: true });
  for (const entry of await fs.readdir(source, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue;
    const metadataPath = path.join(source, entry.name, "library.json");
    const metadata = JSON.parse(await fs.readFile(metadataPath, "utf8")) as { machineName: string; majorVersion: number; minorVersion: number };
    if (entry.name !== `${metadata.machineName}-${metadata.majorVersion}.${metadata.minorVersion}`) {
      throw new Error(`Folder library tidak sesuai metadata: ${entry.name}`);
    }
    const destination = path.join(target, entry.name);
    if (await fs.stat(destination).catch(() => null)) continue;
    await fs.cp(path.join(source, entry.name), destination, { recursive: true, force: false, errorOnExist: true });
    console.log(`✓ ${entry.name} dipasang dari library lokal.`);
  }
}

/**
 * Seed library H5P dari Hub (sekali saja / idempoten) + terapkan patch runtime CoursePresentation 1.26.
 *   npm run h5p:seed
 */
async function main(): Promise<void> {
  await installLocalLibraries();
  const { editor, libraryManager } = await getH5P();
  const wanted = [
    "H5P.CoursePresentation",
    "H5P.AdvancedText",
    "H5P.Link",
    "H5P.Image",
    "H5P.Shape",
    "H5P.Audio",
    "H5P.Video",
    "H5P.MultiChoice",
    "H5P.SingleChoiceSet",
    "H5P.TrueFalse",
    "H5P.Blanks",
    "H5P.DragQuestion",
    "H5P.Summary",
    "H5P.DragText",
    "H5P.MarkTheWords",
    "H5P.Dialogcards",
    "H5P.ContinuousText",
    "H5P.ExportableTextArea",
    "H5P.Table",
    "H5P.InteractiveVideo",
    "H5P.AudioRecorder",
    "H5P.MultiMediaChoice",
  ];

  for (const machineName of wanted) {
    try {
      const installed = (await libraryManager.listInstalledLibraries(machineName)) as Record<string, unknown>;
      if (installed && Object.keys(installed).length > 0) {
        console.log(`✓ ${machineName} sudah terinstal — dilewati.`);
        continue;
      }
      console.log(`Menginstal ${machineName} dari H5P Hub (termasuk dependensi)…`);
      await editor.installLibraryFromHub(machineName, systemUser);
      console.log(`✓ ${machineName} berhasil diinstal.`);
    } catch (err) {
      console.warn(`⚠ Peringatan saat menginstal ${machineName}:`, err instanceof Error ? err.message : err);
    }
  }

  const patched = await applyCoursePresentationPatches();
  if (patched) {
    console.log("✓ Patch kustom H5P.CoursePresentation-1.26 (rotasi & tombol pop-up) telah disinkronkan.");
  }

  const all = (await libraryManager.listInstalledLibraries()) as Record<
    string,
    Array<{ majorVersion: number; minorVersion: number }>
  >;
  const names = Object.keys(all).sort();
  if (!names.includes("H5P.CoursePresentation")) {
    throw new Error("Course Presentation belum terpasang. Isi H5P_LIBRARY_SOURCE dengan folder library H5P lokal, lalu jalankan ulang npm run h5p:seed.");
  }
  console.log(`Total ${names.length} library terinstal:`);
  for (const name of names) {
    const versions = (all[name] ?? []).map((v) => `${v.majorVersion}.${v.minorVersion}`).join(", ");
    console.log(`  - ${name} ${versions}`);
  }
}

main().catch((err) => {
  console.error("Seed gagal:", err instanceof Error ? err.message : err);
  process.exit(1);
});
