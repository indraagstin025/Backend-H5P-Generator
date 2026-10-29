import assert from "node:assert/strict";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { toCpElement, StoredElement, StoredSlide, LibVersions } from "../src/h5p/contentMapper.js";
import { checkIssues, SlideRow } from "../src/h5p/exporter.js";
import { convertPdfToSlides } from "../src/converter/pdfRenderer.js";

// Mock LibVersions
const mockLibs: LibVersions = {
  get(machineName: string): string {
    const versions: Record<string, string> = {
      "H5P.CoursePresentation": "H5P.CoursePresentation 1.25",
      "H5P.AdvancedText": "H5P.AdvancedText 1.1",
      "H5P.Image": "H5P.Image 1.1",
      "H5P.Audio": "H5P.Audio 1.0",
      "H5P.Video": "H5P.Video 1.1",
      "H5P.MultiChoice": "H5P.MultiChoice 1.16",
      "H5P.SingleChoiceSet": "H5P.SingleChoiceSet 1.2",
      "H5P.TrueFalse": "H5P.TrueFalse 1.8",
      "H5P.Blanks": "H5P.Blanks 1.14",
      "H5P.DragText": "H5P.DragText 1.8",
      "H5P.MarkTheWords": "H5P.MarkTheWords 1.0",
    };
    return versions[machineName] ?? `${machineName} 1.0`;
  },
};

const mockRemapAsset = (storedPath: string, kind: string): string => {
  if (kind === "video") return `videos/${storedPath.replace(/^[/\\]+/, "")}`;
  if (kind === "audio") return `audios/${storedPath.replace(/^[/\\]+/, "")}`;
  return `images/${storedPath.replace(/^[/\\]+/, "")}`;
};

async function runSanityTests() {
  console.log("=== MEMULAI AUTOMATED SANITY TEST BACKEND STUDIO ===");
  let passedCount = 0;

  // ----------------------------------------------------
  // TEST 1: Pemetaan Elemen Video pada toCpElement
  // ----------------------------------------------------
  {
    const videoEl: StoredElement = {
      id: "v1",
      kind: "video",
      title: "Video Animasi",
      asset: "sample.mp4",
      videoUrl: "",
      position: { x: 10, y: 15, width: 80, height: 60 },
      displayAsButton: false,
      buttonLabel: "",
    };
    const cpVideo = toCpElement(videoEl, 3, mockLibs, mockRemapAsset);
    assert.equal(cpVideo.x, 10);
    assert.equal(cpVideo.y, 15);
    assert.equal(cpVideo.width, 80);
    assert.equal(cpVideo.height, 60);

    const action = cpVideo.action as Record<string, unknown>;
    assert.equal(action.library, "H5P.Video 1.1");
    const params = action.params as Record<string, any>;
    assert.equal(params.sources?.[0]?.path, "videos/sample.mp4");
    assert.equal(params.sources?.[0]?.mime, "video/mp4");
    assert.equal(params.visuals?.controls, true);
    console.log("✓ Test 1 Lolos: Pemetaan elemen video H5P sesuai spesifikasi.");
    passedCount++;
  }

  // ----------------------------------------------------
  // TEST 2: Pemetaan Elemen Single Choice pada toCpElement
  // ----------------------------------------------------
  {
    const singleEl: StoredElement = {
      id: "sc1",
      kind: "singleChoice",
      title: "Pilihan Tunggal",
      question: "Apakah bumi bulat?",
      options: [
        { text: "Ya, bulat lonjong", correct: true },
        { text: "Bukan, datar", correct: false },
      ],
      position: { x: 5, y: 5, width: 90, height: 80 },
      displayAsButton: false,
      buttonLabel: "",
    };
    const cpSingle = toCpElement(singleEl, 3, mockLibs, mockRemapAsset);
    const action = cpSingle.action as Record<string, unknown>;
    assert.equal(action.library, "H5P.SingleChoiceSet 1.2");
    const params = action.params as Record<string, any>;
    assert.equal(params.choices?.[0]?.question, "Apakah bumi bulat?");
    assert.deepEqual(params.choices?.[0]?.answers, ["Ya, bulat lonjong", "Bukan, datar"]);
    console.log("✓ Test 2 Lolos: Pemetaan elemen singleChoice H5P.SingleChoiceSet sesuai spesifikasi.");
    passedCount++;
  }

  // ----------------------------------------------------
  // TEST 3: Pemetaan Elemen Drag the Words pada toCpElement
  // ----------------------------------------------------
  {
    const dragEl: StoredElement = {
      id: "dw1",
      kind: "dragWords",
      title: "Drag Words",
      text: "Ibukota Indonesia adalah *Nusantara*.",
      position: { x: 0, y: 0, width: 100, height: 50 },
      displayAsButton: false,
      buttonLabel: "",
    };
    const cpDrag = toCpElement(dragEl, 3, mockLibs, mockRemapAsset);
    const action = cpDrag.action as Record<string, unknown>;
    assert.equal(action.library, "H5P.DragText 1.8");
    const params = action.params as Record<string, any>;
    assert.equal(params.textField, "Ibukota Indonesia adalah *Nusantara*.");
    assert.equal(params.behaviour?.enableRetry, true);
    console.log("✓ Test 3 Lolos: Pemetaan elemen dragWords H5P.DragText sesuai spesifikasi.");
    passedCount++;
  }

  // ----------------------------------------------------
  // TEST 4: Pemetaan Elemen Mark the Words pada toCpElement
  // ----------------------------------------------------
  {
    const markEl: StoredElement = {
      id: "mw1",
      kind: "markWords",
      title: "Mark Words",
      text: "Pilihlah kata benda: *meja*, berjalan, *kursi*.",
      position: { x: 0, y: 0, width: 100, height: 50 },
      displayAsButton: false,
      buttonLabel: "",
    };
    const cpMark = toCpElement(markEl, 3, mockLibs, mockRemapAsset);
    const action = cpMark.action as Record<string, unknown>;
    assert.equal(action.library, "H5P.MarkTheWords 1.0");
    const params = action.params as Record<string, any>;
    assert.equal(params.textField, "Pilihlah kata benda: *meja*, berjalan, *kursi*.");
    console.log("✓ Test 4 Lolos: Pemetaan elemen markWords H5P.MarkTheWords sesuai spesifikasi.");
    passedCount++;
  }

  // ----------------------------------------------------
  // TEST 5: Auto-Clamp Koordinat & Ukuran pada toCpElement
  // ----------------------------------------------------
  {
    const elOverflow: StoredElement = {
      id: "ov1",
      kind: "advancedText",
      title: "Teks",
      text: "Testing clamp",
      position: { x: 125, y: -50, width: 150, height: 200 },
      displayAsButton: false,
      buttonLabel: "",
    };
    const cpEl = toCpElement(elOverflow, 3, mockLibs, mockRemapAsset);
    assert.equal(cpEl.x, 100);
    assert.equal(cpEl.y, 0);
    assert.equal(cpEl.width, 100);
    assert.equal(cpEl.height, 100);
    console.log("✓ Test 5 Lolos: Bounding box auto-clamping 0–100% bekerja aman.");
    passedCount++;
  }

  // ----------------------------------------------------
  // TEST 6: Validasi Pra-Ekspor (checkIssues) Menemukan Kesalahan
  // ----------------------------------------------------
  {
    const invalidSlides: SlideRow[] = [
      {
        order: 1,
        title: "Slide dengan Elemen Rusak",
        data: {
          order: 1,
          title: "Slide Rusak",
          chapter: "BAB 1",
          tone: "paper",
          aspect: "16:9",
          keywords: [],
          background: null,
          backgroundPending: false,
          elements: [
            // Video tanpa aset & url
            { id: "e1", kind: "video", title: "Video Tanpa File", asset: "", videoUrl: "", position: { x: 0, y: 0, width: 50, height: 50 }, displayAsButton: false, buttonLabel: "" },
            // Single choice tanpa pilihan jawaban
            { id: "e2", kind: "singleChoice", title: "Single Choice Kosong", question: "Siapa saya?", options: [], position: { x: 0, y: 0, width: 50, height: 50 }, displayAsButton: false, buttonLabel: "" },
            // Drag words tanpa bintang
            { id: "e3", kind: "dragWords", title: "Drag Words Tanpa Bintang", text: "Teks tanpa bintang sama sekali", position: { x: 0, y: 0, width: 50, height: 50 }, displayAsButton: false, buttonLabel: "" },
            // Mark words tanpa bintang
            { id: "e4", kind: "markWords", title: "Mark Words Tanpa Bintang", text: "Teks tanpa bintang sama sekali", position: { x: 0, y: 0, width: 50, height: 50 }, displayAsButton: false, buttonLabel: "" },
          ],
        },
      },
    ];

    const result = checkIssues(invalidSlides, "storage/test");
    assert.ok(result.issues.some((i) => i.includes("Video belum ada berkas atau tautan URL-nya")));
    assert.ok(result.issues.some((i) => i.includes("kuis pilihan tunggal minimal 2 pilihan jawaban")));
    assert.ok(result.issues.some((i) => i.includes("kuis Drag the Words belum punya kata *berbintang*")));
    assert.ok(result.issues.some((i) => i.includes("kuis Mark the Words belum punya kata kunci *berbintang*")));
    console.log("✓ Test 6 Lolos: checkIssues mendeteksi seluruh anomali validasi elemen baru secara akurat.");
    passedCount++;
  }

  // ----------------------------------------------------
  // TEST 7: Validasi Pra-Ekspor (checkIssues) Sukses pada Slide Valid
  // ----------------------------------------------------
  {
    const validSlides: SlideRow[] = [
      {
        order: 1,
        title: "Slide Pembuka",
        data: {
          order: 1,
          title: "Slide Pembuka",
          chapter: "BAB 1",
          tone: "forest",
          aspect: "16:9",
          keywords: [{ main: "Pengantar", subs: ["Sub-topik"] }],
          background: "bg1.png",
          backgroundPending: false,
          elements: [
            {
              id: "v-ok",
              kind: "video",
              title: "Intro Video",
              asset: "intro.mp4",
              videoUrl: "",
              position: { x: 10, y: 10, width: 80, height: 45 },
              displayAsButton: false,
              buttonLabel: "",
            },
            {
              id: "dw-ok",
              kind: "dragWords",
              title: "Tebak Kata",
              text: "Matahari terbit di sebelah *timur* dan tenggelam di sebelah *barat*.",
              position: { x: 10, y: 60, width: 80, height: 30 },
              displayAsButton: false,
              buttonLabel: "",
            },
          ],
        },
      },
      {
        order: 2,
        title: "Slide Kuis",
        data: {
          order: 2,
          title: "Slide Kuis",
          chapter: "BAB 2",
          tone: "lime",
          aspect: "16:9",
          keywords: [],
          background: null,
          backgroundPending: false,
          elements: [
            {
              id: "sc-ok",
              kind: "singleChoice",
              title: "Kuis Pilihan Tunggal",
              question: "Berapa 2 + 2?",
              options: [
                { text: "4", correct: true },
                { text: "5", correct: false },
              ],
              position: { x: 10, y: 10, width: 80, height: 60 },
              displayAsButton: false,
              buttonLabel: "",
            },
          ],
        },
      },
    ];

    const result = checkIssues(validSlides, "storage/test");
    assert.equal(result.issues.length, 0, `Harusnya tidak ada issue, ditemukan: ${result.issues.join(", ")}`);
    console.log("✓ Test 7 Lolos: checkIssues menerima slide yang valid tanpa error.");
    passedCount++;
  }

  // ----------------------------------------------------
  // TEST 8: Konversi Dokumen PDF ke Gambar Latar Slide via PDFium
  // ----------------------------------------------------
  {
    // Struktur berkas PDF 1.4 minimal yang valid untuk pengujian
    const minimalPdf =
      "%PDF-1.4\n" +
      "1 0 obj << /Type /Catalog /Pages 2 0 R >> endobj\n" +
      "2 0 obj << /Type /Pages /Kids [3 0 R] /Count 1 >> endobj\n" +
      "3 0 obj << /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] >> endobj\n" +
      "xref\n" +
      "0 4\n" +
      "0000000000 65535 f \n" +
      "0000000009 00000 n \n" +
      "0000000058 00000 n \n" +
      "0000000115 00000 n \n" +
      "trailer << /Size 4 /Root 1 0 R >>\n" +
      "startxref\n" +
      "206\n" +
      "%%EOF\n";

    const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "pdf-test-"));
    const tmpPdfPath = path.join(tmpDir, "test-document.pdf");
    const tmpOutDir = path.join(tmpDir, "assets");
    await fs.mkdir(tmpOutDir, { recursive: true });
    await fs.writeFile(tmpPdfPath, Buffer.from(minimalPdf));

    try {
      const pdfResult = await convertPdfToSlides(tmpPdfPath, tmpOutDir);
      assert.equal(pdfResult.slideCount, 1);
      assert.equal(pdfResult.slides.length, 1);
      assert.equal(pdfResult.slides[0].imageFileName, "slide-1.jpg");
      assert.equal(pdfResult.backgroundFiles.length, 1);

      // Verifikasi fisik berkas gambar latar slide benar-benar dibuat di disk
      const stat = await fs.stat(pdfResult.backgroundFiles[0]);
      assert.ok(stat.isFile() && stat.size > 0, "Berkas gambar latar slide PDF harus terbentuk dan tidak kosong.");

      console.log("✓ Test 8 Lolos: Konversi PDF ke gambar latar slide via WebAssembly PDFium berhasil 100%.");
      passedCount++;
    } finally {
      // Bersihkan folder pengujian sementara
      await fs.rm(tmpDir, { recursive: true, force: true }).catch(() => undefined);
    }
  }

  console.log(`\n=================================================`);
  console.log(`SEMUA ${passedCount} SKENARIO PENGUJIAN OTOMATIS BERHASIL!`);
  console.log(`=================================================\n`);
}

runSanityTests().catch((err) => {
  console.error("❌ PENGUJIAN GAGAL:", err);
  process.exit(1);
});
