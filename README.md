# Backend H5P Content Generator (Tahap 2 — fondasi)

Express 5 + TypeScript + Prisma + PostgreSQL (`H5P_Generator`).

## Jalan lokal

```bash
npm install
cp .env.example .env   # samakan DATABASE_URL dengan Postgres lokal
npm run prisma:migrate # sekali (atau tiap ubah schema.prisma)
npm run dev            # http://localhost:3000
```

## API (Tahap 2)

| Method | Endpoint | Keterangan |
|---|---|---|
| GET | `/api/health` | Cek hidup |
| GET | `/api/projects` | Daftar proyek + jumlah slide |
| POST | `/api/projects` | Buat proyek kosong `{title, aspect?}` |
| GET | `/api/projects/:id` | Detail + slide |
| PATCH | `/api/projects/:id` | Ganti judul `{title}` |
| DELETE | `/api/projects/:id` | Hapus proyek + file |
| POST | `/api/projects/ingest` | Upload `sourceFile` (.pptx/.pdf ≤50MB) + `title` → **202** `{project, job}` + pipeline async |
| GET | `/api/ingest-jobs/:id` | Polling progres: `parsing → persisting → rendering → done/error` + `slideCount` |
| GET | `/api/projects/:id/slides` | Slide hasil konversi (elemen + `background`/`backgroundPending`) |
| POST | `/api/projects/:id/export` | Unduh `.h5p` rakitan Lumi (422 + `issues` bila pemeriksaan gagal) |
| GET | `/api/projects/:id/export-report` | `{ok, issues, warnings, libraries, mainLibrary, slideCount, quizCount}` |
| POST | `/api/h5p/packages/validate` | Validasi paket `.h5p` rakitan browser (`package` ≤30MB) terhadap library server |
| POST | `/api/h5p/preview-sessions` | Impor `.h5p` jadi sesi pratinjau TTL 24 jam (`package` + `title`/`projectId`) |
| GET | `/api/h5p/player/:sessionId` | Halaman player mandiri (di-iframe) |
| GET | `/api/h5p/session/:sessionId/*` | `h5p.json` / file `content/*` sesi |
| GET | `/api/h5p/libraries/:uber/*` | File library H5P |
| POST | `/api/h5p/session/:sessionId/finish` | Catat skor xAPI `{score, maxScore}` |
| GET | `/api/h5p/session/:sessionId/attempts` | Daftar skor sesi |
| GET | `/api/projects/:id/player` | 302 ke player sesi (ekspor → impor otomatis) |
| GET | `/api/projects/:id/attempts` | Daftar skor proyek |

Batas: file ≤50 MB, hanya `.pptx`/`.pdf`. Folder `storage/tmp` dibersihkan
otomatis bila lebih tua dari 24 jam (NFR-06).

## Paket H5P via Lumi (Tahap 4)

```bash
npm run h5p:seed   # sekali: instal CoursePresentation + dependensi dari H5P Hub
```

- `src/h5p/` = `h5pService` (singleton Lumi: editor, exporter, storage file
  di `storage/h5p/`), `contentMapper` (**salinan logika** dari
  `frontend/.../h5pPackager.ts` — ubah di frontend lalu salin, lihat SYNC.md),
  `exporter` (rakit paket + laporan + validasi), `seed`.
- Paket yang dihasilkan **penuh** (konten + seluruh library, ~struktur ekspor
  H5P.org): `h5p.json` di akar, `content/`, folder `H5P.X-1.0/` — tanpa entri
  direktori (§5).
- Versi library = yang terinstal dari Hub (saat ini CoursePresentation **1.26**).
  Bila LMS internal lebih tua, upgrade library LMS-nya (alur H5P standar)
  atau pin versi seed ke rilis GitHub yang sesuai.
- Latar presisi belum ada → gradien pengganti via `sharp` (SVG→PNG 1920px).
- Frontend `ExportStep` tetap unduh lokal sebagai utama + tombol
  "Cek validasi server (Lumi)".

## Player server + xAPI (Tahap 5)

- `src/h5p/player.ts`: sesi pratinjau (impor `.h5p` → konten Lumi + baris
  `PreviewSession` TTL 24 jam), halaman player mandiri (engine
  `h5p-standalone` yang di-vendor di `public/h5p-vendor/`), penyajian file
  konten/library, pencatatan skor (`PreviewAttempt`, batas 50/sesi),
  dan purge sesi kedaluwarsa (ikut job cleanup per jam).
- Frontend Tahap 4 dapat mode ketiga "Player server + nilai": iframe +
  polling skor. Dua mode lama (simulasi, standalone lokal) tetap ada.
- Player proyek (`GET /projects/:id/player`) = ekspor → sesi → redirect 302.

## Konverter (Tahap 3)

- `src/converter/` = **salinan manual** dari 4 modul frontend
  (`h5pModel`, `pptxParser`, `pptxConverter`, `pdfInspector`) + shim Node
  (`domShim`, `pipeline`, `renderer`). Aturan sinkron: lihat `SYNC.md`.
- Hyperlink → hotspot, notes → dialog, media + posisi, penanda
  `[ke:N]/[kuis]/[sembunyi]`, batas 60 slide — sama persis dengan frontend.
- Media gambar dioptimasi `sharp` (lebar ≤1600px). Latar presisi butuh
  LibreOffice + `pdftoppm` (otomatis ada di Docker, tidak ada di dev
  Windows → slide tersimpan dengan `backgroundPending: true`).

## Docker

```bash
npm run build
docker build -t h5pgen-backend .
docker run -p 3000:3000 \
  -e DATABASE_URL="postgresql://postgres@host.docker.internal:5432/H5P_Generator?schema=public" \
  -v h5pgen-storage:/app/storage h5pgen-backend
```

## Catatan versi

Prisma dikunci v6 (`^6`). Jangan upgrade ke v8 tanpa migrasi
skema+CLI — v8 merombak total struktur perintah.
