# Modul converter: SALINAN MANUAL dari frontend

Sumber kebenaran = `frontend/src`:
- `features/studio/constants/h5pModel.ts` → `backend/src/converter/h5pModel.ts`
- `features/studio/api/pptxParser.ts` → `backend/src/converter/pptxParser.ts`
- `features/ingest/api/pptxConverter.ts` → `backend/src/converter/pptxConverter.ts`
- `features/studio/api/pdfInspector.ts` → `backend/src/converter/pdfInspector.ts`

Aturan:
1. Ubah logika HANYA di frontend (di sanalah unit runtime-nya terverifikasi).
2. Salin ulang keempat file, lalu di backend sesuaikan HANYA:
   - header komentar SYNC ini,
   - import relatif `pptxConverter.ts` (`./h5pModel`, `./pptxParser`).
3. Jalankan `npm run build` backend + uji ingest (lihat README).

Backend TIDAK BOLEH memiliki logika parsing sendiri — semua yang
spesifik Node (DOMParser shim, tulis aset, render) tinggal di:
- `domShim.ts`, `pipeline.ts`, `renderer.ts` (file milik backend).
