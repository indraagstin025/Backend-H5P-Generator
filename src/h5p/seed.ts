import { getH5P, systemUser } from "./h5pService.js";

/**
 * Seed library H5P dari Hub (sekali saja / idempoten).
 *   npm run h5p:seed
 */
async function main(): Promise<void> {
  const { editor, libraryManager } = await getH5P();
  const wanted = [
    "H5P.CoursePresentation",
    "H5P.AdvancedText",
    "H5P.Image",
    "H5P.Audio",
    "H5P.Video",
    "H5P.MultiChoice",
    "H5P.SingleChoiceSet",
    "H5P.TrueFalse",
    "H5P.Blanks",
    "H5P.DragText",
    "H5P.MarkTheWords",
  ];

  for (const machineName of wanted) {
    try {
      const installed = (await libraryManager.listInstalledLibraries(machineName)) as Record<string, unknown>;
      if (installed && Object.keys(installed).length > 0) {
        console.log(`✓ ${machineName} sudah terinstal — dilewati.`);
        continue;
      }
      console.log(`Menginstal ${machineName} dari H5P Hub (termasuk dependensi)…`);
      const result = await editor.installLibraryFromHub(machineName, systemUser);
      console.log(`✓ ${machineName} berhasil diinstal.`);
    } catch (err) {
      console.warn(`⚠ Peringatan saat menginstal ${machineName}:`, err instanceof Error ? err.message : err);
    }
  }
  const all = (await libraryManager.listInstalledLibraries()) as Record<
    string,
    Array<{ majorVersion: number; minorVersion: number }>
  >;
  const names = Object.keys(all).sort();
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
