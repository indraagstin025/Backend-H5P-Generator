# Panduan Konfigurasi Google OAuth 2.0

Dokumen ini berisi langkah-langkah konfigurasi **Google Cloud Console** dan variabel lingkungan (`backend/.env`) agar fitur **Login dengan Google** berfungsi tanpa error `redirect_uri_mismatch`.

---

## 1. Pengaturan di Google Cloud Console

1. Buka [Google Cloud Console](https://console.cloud.google.com/) dan pilih project yang digunakan.
2. Masuk ke **APIs & Services** → **OAuth consent screen**:
   * Pastikan tipe **External** (atau **Internal** jika khusus Workspace) sudah dikonfigurasi dengan nama aplikasi dan email pengembang.
   * Jika status masih **Testing**, tambahkan email akun Google yang akan dipakai uji coba pada bagian **Test users**.
3. Masuk ke **APIs & Services** → **Credentials**:
   * Buat atau buka **OAuth 2.0 Client ID** dengan tipe **Web application**.
   * Pada bagian **Authorized JavaScript origins**, tambahkan:
     ```text
     http://localhost:5173
     http://localhost:3000
     ```
   * Pada bagian **Authorized redirect URIs**, tambahkan persis:
     ```text
     http://localhost:3000/api/auth/google/callback
     ```
     *(Opsional: Anda juga dapat menambahkan `http://localhost:5173/api/auth/google/callback` jika suatu saat menggunakan URL proxy Vite.)*
   * Klik **SAVE** dan tunggu sekitar **1–2 menit** agar perubahan tersinkronisasi di sisi Google.

> [!NOTE]
> Untuk lingkungan **Produksi**, ganti `http://localhost:3000` dan `http://localhost:5173` dengan domain HTTPS produksi masing-masing (misalnya `https://api.domainanda.com/api/auth/google/callback`).

---

## 2. Pengaturan di `backend/.env`

Salin `Client ID` dan `Client Secret` dari Google Cloud Console ke `backend/.env`:

```env
FRONTEND_URL="http://localhost:5173"
GOOGLE_CLIENT_ID="isi-client-id-dari-google-cloud"
GOOGLE_CLIENT_SECRET="isi-client-secret-dari-google-cloud"
GOOGLE_REDIRECT_URI="http://localhost:3000/api/auth/google/callback"
```

Pastikan:
* Nilai `GOOGLE_REDIRECT_URI` **sama persis** (termasuk protokol `http://`, port `:3000`, dan tanpa garis miring di akhir) dengan yang didaftarkan di **Authorized redirect URIs** pada Google Cloud Console.
* Setelah mengubah `backend/.env`, **restart server backend** (`npm run dev` atau `npm start`) agar konfigurasi terbaru dimuat.

---

## 3. Verifikasi Cepat

1. Pastikan endpoint status provider mengembalikan `true`:
   ```text
   GET http://localhost:3000/api/auth/providers
   → {"data":{"google":true}}
   ```
2. Buka `http://localhost:5173/login`, tombol **"Lanjutkan dengan Google"** akan aktif.
3. Klik tombol tersebut dan login dengan akun Google terverifikasi (mendukung `@gmail.com` maupun domain Google Workspace):
   * Pengguna baru otomatis masuk dan diarahkan ke `/complete-profile` untuk mengisi **Nama Lengkap**, **Tanggal Lahir**, **Foto Profil**, serta melihat/mengubah **Sandi Bawaan Otomatis**.
   * Setelah disimpan, pengguna dapat login menggunakan **Google** maupun **form Email + Kata Sandi**.

---

## 4. Troubleshooting

* **Error `400: redirect_uri_mismatch`**:
  Periksa kembali apakah `GOOGLE_REDIRECT_URI` di `backend/.env` sudah persis sama dengan salah satu entri di **Authorized redirect URIs** pada Google Cloud Console.
* **Tombol Google masih bertuliskan `"Google belum tersedia"`**:
  Pastikan `GOOGLE_CLIENT_ID` dan `GOOGLE_CLIENT_SECRET` di `backend/.env` tidak kosong dan server backend sudah di-restart.

---

## 5. Berbagi Kredensial di Tim (Development Lokal)

Untuk pengembangan bersama di tim:

1. **Berbagi Kredensial Bersama (Paling Praktis)**:
   * Satu orang membuat OAuth Client ID di Google Cloud Console, lalu membagikan `GOOGLE_CLIENT_ID` dan `GOOGLE_CLIENT_SECRET` melalui **jalur privat** (chat pribadi/grup tim internal) untuk di-copy-paste ke `backend/.env` masing-masing.
   * **Wajib**: Tambahkan email Google seluruh anggota tim ke daftar **Test users** di *OAuth consent screen* bila status aplikasi masih **Testing**.
2. **Atau Buat Kredensial Sendiri**:
   * Setiap developer juga boleh membuat OAuth Client ID sendiri di akun Google Cloud masing-masing dengan `http://localhost:3000/api/auth/google/callback` dan mengisinya di `backend/.env` lokal.
3. **Aturan Keamanan**:
   * **Jangan pernah** meng-commit `backend/.env` ke Git/GitHub (hanya `.env.example` yang boleh masuk repositori).
   * Saat rilis ke **produksi**, buat OAuth Client ID & Secret baru khusus domain produksi (atau *rotate* secret) agar kredensial produksi terpisah dari kredensial development.

