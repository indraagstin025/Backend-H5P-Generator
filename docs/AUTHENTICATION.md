# Dokumentasi Arsitektur & Spesifikasi Fitur Autentikasi

Dokumen ini mendefinisikan arsitektur, spesifikasi teknis, mekanisme keamanan, dan panduan integrasi sistem Autentikasi dan Otorisasi (RBAC) pada backend H5P Content Generator.

---

## 1. Ringkasan & Arsitektur Sistem

Sistem autentikasi dibangun menggunakan pola **Token-Based Authentication (JWT)** dengan standar keamanan industri:
* **Metode Login**: Email & Password *(sudah aktif)* serta Google OAuth 2.0 *(spesifikasi siap integrasi)*.
* **Model Hak Akses (RBAC)**:
  * `USER`: Pembuat konten (dapat mengunggah materi, mengedit di Studio, dan mengekspor paket .h5p).
  * `ADMIN`: Administrator sistem (**khusus untuk mengelola pengguna**: melihat daftar user, mengubah role, mengaktifkan/menonaktifkan akun, dan menghapus akun).
* **Lapisan Keamanan**:
  * Bcrypt password hashing (Cost factor 12).
  * Rate Limiting brute-force pada endpoint autentikasi (maksimal 10 request / 15 menit).
  * Perlindungan Timing Attack saat validasi password.
  * Sanitasi data respons (hash password tidak pernah diekspos ke klien).

### Diagram Alur Autentikasi (JWT)

```mermaid
sequenceDiagram
    autonumber
    actor Client as Frontend / User
    participant Route as Express Router
    participant Limit as Rate Limiter
    participant Svc as Auth Service
    participant DB as PostgreSQL (Prisma)

    Client->>Route: POST /api/auth/login { email, password }
    Route->>Limit: Cek kuota request per IP
    alt Melebihi kuota (10 req/15 min)
        Limit-->>Client: 429 Too Many Requests
    else Kuota aman
        Limit->>Svc: loginUser(email, password)
        Svc->>DB: Cari user berdasarkan email
        alt User tidak ditemukan
            Svc->>Svc: Dummy bcrypt compare (anti-timing attack)
            Svc-->>Client: 401 Email atau kata sandi tidak valid
        else User ditemukan tapi nonaktif
            Svc-->>Client: 403 Akun telah dinonaktifkan
        else Password cocok
            Svc->>Svc: Generate JWT Token (payload: id, email, role)
            Svc-->>Client: 200 OK { user, token }
        end
    end
```

---

## 2. Fitur 1: Autentikasi Email & Kata Sandi (Implementasi Saat Ini)

### A. Format & Validasi Input
* **Email (Wajib `@gmail.com`)**:
  * Wajib menggunakan domain `@gmail.com` dengan format valid (`^[a-z0-9._%+-]+@gmail\.com$`, menolak *double dot* `..` dan karakter non-valid).
  * Dibersihkan (*trimmed*) dan diubah ke huruf kecil (*lowercase*) sebelum disimpan / dicek.
* **Nama Pengguna**:
  * Karakter kontrol (`\x00-\x1F`, `\x7F`) dihapus, panjang minimal **2 karakter** dan maksimal **100 karakter**.
* **Kata Sandi**:
  * Minimal **8 karakter** dan maksimal **128 karakter** (proteksi bcrypt CPU exhaustion / DoS).
  * Wajib memuat kombinasi **huruf dan angka** (`/[A-Za-z]/` dan `/[0-9]/`).
  * Di-hash menggunakan library `bcryptjs` dengan salt round 12.

### B. Endpoint Autentikasi

#### 1. Registrasi Akun Baru
* **Endpoint**: `POST /api/auth/register`
* **Proteksi**: `authRateLimiter` (10 request / 15 menit) + role dipaksa `"USER"` di server (payload `role` diabaikan untuk mencegah privilege escalation)
* **Request Body**:
  ```json
  {
    "email": "budi.guru@gmail.com",
    "password": "Password123!",
    "name": "Budi Santoso"
  }
  ```
* **Response (201 Created)**:
  ```json
  {
    "message": "Pendaftaran akun berhasil.",
    "data": {
      "user": {
        "id": "e93f9409-f529-4d23-b1d5-bc75143a4111",
        "email": "budi.guru@gmail.com",
        "name": "Budi Santoso",
        "role": "USER",
        "isActive": true,
        "avatarUrl": null,
        "createdAt": "2026-11-10T06:50:00.000Z",
        "updatedAt": "2026-11-10T06:50:00.000Z"
      },
      "token": "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9..."
    }
  }
  ```

#### 2. Masuk ke Sistem (Login)
* **Endpoint**: `POST /api/auth/login`
* **Proteksi**: `authRateLimiter` (10 request / 15 menit) + Timing Attack Mitigation (`TIMING_DUMMY_HASH`)
* **Request Body**:
  ```json
  {
    "email": "budi.guru@gmail.com",
    "password": "Password123!"
  }
  ```
* **Response (200 OK)**:
  ```json
  {
    "message": "Berhasil masuk ke sistem.",
    "data": {
      "user": {
        "id": "e93f9409-f529-4d23-b1d5-bc75143a4111",
        "email": "budi.guru@gmail.com",
        "name": "Budi Santoso",
        "role": "USER",
        "isActive": true,
        "avatarUrl": null,
        "createdAt": "2026-11-10T06:50:00.000Z",
        "updatedAt": "2026-11-10T06:50:00.000Z"
      },
      "token": "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9..."
    }
  }
  ```

#### 3. Cek Profil Pengguna Aktif
* **Endpoint**: `GET /api/auth/me`
* **Header Wajib**: `Authorization: Bearer <token>`
* **Response (200 OK)**:
  ```json
  {
    "data": {
      "id": "e93f9409-f529-4d23-b1d5-bc75143a4111",
      "email": "budi.guru@gmail.com",
      "name": "Budi Santoso",
      "role": "USER",
      "isActive": true,
      "avatarUrl": null,
      "createdAt": "2026-11-10T06:50:00.000Z",
      "updatedAt": "2026-11-10T06:50:00.000Z"
    }
  }
  ```

### C. Akun Bawaan (Default Seeder)
Sistem secara otomatis menginisialisasi dua akun awal (domain `@gmail.com`) ketika server pertama kali dijalankan (non-fatal bila database belum tersedia pada proses startup):
1. **Akun Administrator**:
   * Email: `admin.h5p@gmail.com`
   * Password: `Admin1234!`
   * Role: `ADMIN`
2. **Akun Pengguna Biasa**:
   * Email: `user.h5p@gmail.com`
   * Password: `User1234!`
   * Role: `USER`

*(Endpoint inisialisasi manual `POST /api/auth/seed` dilindungi `authRateLimiter` dan otomatis diblokir (`403 Forbidden`) saat `NODE_ENV=production`.)*

---

## 3. Fitur 2: Google OAuth 2.0 (Spesifikasi & Roadmap Integrasi)

Fitur Google Auth dirancang menggunakan alur modern **Google Identity Services (GIS)** berbasis ID Token (JWT Google).

### Alur Kerja (GIS Flow):
1. **Frontend**: Pengguna menekan tombol *"Sign in with Google"*. Google One-Tap SDK mengembalikan `credential` (ID Token yang ditandatangani Google).
2. **Frontend -> Backend**: Mengirimkan ID Token ke `POST /api/auth/google`.
3. **Backend Verifikasi**:
   * Memvalidasi token ke Google API (`https://oauth2.googleapis.com/tokeninfo?id_token=...` atau via `google-auth-library`).
   * Mengambil `sub` (Google ID unik), `email`, `name`, dan `picture`.
4. **Sinkronisasi Akun**:
   * Jika user dengan `googleId` sudah ada -> Langsung buat sesi JWT.
   * Jika user dengan `email` sudah ada (sebelumnya daftar via password) -> Tautkan `googleId` ke akun tersebut (*account linking*).
   * Jika belum ada sama sekali -> Buat user baru dengan `role: "USER"`.

### Skema Kontrak API Google Auth:
* **Endpoint**: `POST /api/auth/google`
* **Request**:
  ```json
  {
    "idToken": "eyJhbGciOiJSUzI1NiIsImtpZCI6IjEy..."
  }
  ```
* **Respons**: Mengembalikan objek `user` dan `token` JWT lokal (format identik dengan respons login biasa).

---

## 4. Fitur 3: Rate Limiting & Proteksi Keamanan

| Vektor Serangan | Mekanisme Pertahanan | Implementasi |
| :--- | :--- | :--- |
| **Brute Force & Credential Stuffing** | Pembatasan frekuensi request per IP | `authRateLimiter` (10 request / 15 menit pada `/api/auth/login`, `/register`, `/seed`) dan `apiRateLimiter` (300 request / menit untuk `/api/*`) di [`src/middleware/rateLimiter.ts`](file:///C:/Users/Indra/Documents/Documents/Semester%207/H5P-Content-Generator/backend/src/middleware/rateLimiter.ts). |
| **Timing Attacks (User Enumeration)** | Menyamakan waktu eksekusi hash compare | Menggunakan `TIMING_DUMMY_HASH` yang di-generate valid dengan `bcrypt.hashSync(..., 12)` agar pengecekan user tidak ditemukan memakan waktu komputasi bcrypt yang identik. |
| **JWT Algorithm Confusion (`alg: none`) & Weak Secret** | Algorithm pinning & validasi secret | `jwt.sign` & `jwt.verify` dikunci ketat pada algoritma `HS256`, struktur payload divalidasi eksplisit, serta `NODE_ENV=production` mewajibkan `JWT_SECRET` minimal 32 karakter dan menolak fallback secret. |
| **Bcrypt CPU Exhaustion (DoS)** | Batas atas panjang password | Input kata sandi dibatasi maksimal **128 karakter** sebelum masuk proses bcrypt hashing/compare. |
| **Password Leakage & Role Escalation** | Sanitasi objek model & server-locked role | Fungsi `sanitizeUser` menghapus `passwordHash`; endpoint `/register` selalu memaksa `role: "USER"` secara eksplisit di server. |
| **Penyalahgunaan Akun Dinonaktifkan** | Validasi status realtime di middleware | Middleware `authenticateToken` mengecek status `isActive` ke database dengan error handling aman (`try/catch`). Jika akun dinonaktifkan Admin, token langsung ditolak dengan HTTP `403`. |
| **CORS & Clickjacking / MIME Sniffing** | Security Headers & Allowlisted Origins | `app.disable("x-powered-by")`, CORS dikunci ke `CORS_ORIGINS`, header `X-Content-Type-Options: nosniff`, `Referrer-Policy`, `Permissions-Policy`, `X-Frame-Options: DENY` + `CSP frame-ancestors 'none'` untuk API, serta pengecualian terukur `CSP frame-ancestors` hanya untuk iframe `/api/h5p/player/` & `/h5p-vendor`. |
| **Seeder Abuse di Production** | Environment guard | `POST /api/auth/seed` otomatis mengembalikan `403 Forbidden` saat `NODE_ENV=production`. |
| **SQL Injection & Invalid Params** | Parameterized Queries & UUID validation | Prisma ORM membungkus seluruh query dalam prepared statements; route `/api/admin/users/:id` memvalidasi format UUID sebelum query dan memetakan Prisma `P2025` menjadi `404`. |
| **Data Payload Flooding** | Batas ukuran body parser Express | `express.json({ limit: "50mb" })` untuk mendukung ekspor/impor presentasi besar tanpa buffer overflow. |

---

## 5. Fitur 4: Role Admin & Manajemen Pengguna (User Management)

Hak akses `ADMIN` dirancang secara spesifik **hanya untuk mengelola akun pengguna**:
* Memeriksa seluruh pengguna yang terdaftar di platform.
* Mengubah peran pengguna (menjadikan pengguna lain sebagai Admin atau sebaliknya).
* Memblokir (*suspend*) akses pengguna yang melanggar aturan tanpa menghapus data materinya.
* Menghapus akun pengguna yang tidak aktif.

### Aturan Keamanan Khusus Admin:
1. **Perlindungan Akun Sendiri**: Admin tidak dapat menghapus akunnya sendiri melalui endpoint ini.
2. **Perlindungan Hak Akses Tunggal**: Admin tidak dapat mencopot status admin dirinya sendiri jika sedang login.
3. **Validasi UUID & Tipe Ketat**: Parameter `:id` divalidasi harus berformat UUID v1–v5, field `isActive` wajib bertipe boolean (`true`/`false`), panjang query `q` dibatasi maksimal 100 karakter, dan target yang tidak ditemukan (`P2025`) ditangani bersih dengan `404`.

### API Manajemen Pengguna (Prefix: `/api/admin`):
*Seluruh endpoint di bawah ini wajib menyertakan header `Authorization: Bearer <token>` milik pengguna dengan role `ADMIN`.*

#### 1. Daftar Pengguna (List Users)
* **Endpoint**: `GET /api/admin/users?q=budi&role=USER&page=1&limit=20`
* **Parameter Query**:
  * `q` *(opsional)*: Kata kunci pencarian berdasarkan nama atau email (maks 100 karakter).
  * `role` *(opsional)*: Filter role (`ADMIN` atau `USER`).
  * `page` *(opsional)*: Halaman data (default: 1).
  * `limit` *(opsional)*: Jumlah per halaman (default: 20, maks: 100).
* **Response (200 OK)**:
  ```json
  {
    "data": [
      {
        "id": "e93f9409-f529-4d23-b1d5-bc75143a4111",
        "email": "budi.guru@gmail.com",
        "name": "Budi Santoso",
        "role": "USER",
        "isActive": true,
        "avatarUrl": null,
        "projectsCount": 5,
        "createdAt": "2026-11-10T06:50:00.000Z",
        "updatedAt": "2026-11-10T06:50:00.000Z"
      }
    ],
    "pagination": {
      "total": 1,
      "page": 1,
      "limit": 20,
      "totalPages": 1
    }
  }
  ```

#### 2. Detail Pengguna
* **Endpoint**: `GET /api/admin/users/:id`
* **Response (200 OK)**: Mengembalikan profil lengkap user beserta jumlah proyek materi yang dimiliki.

#### 3. Ubah Role Pengguna
* **Endpoint**: `PATCH /api/admin/users/:id/role`
* **Request Body**:
  ```json
  { "role": "ADMIN" }
  ```
* **Response (200 OK)**: Mengembalikan data user dengan role baru.

#### 4. Aktifkan / Nonaktifkan Pengguna (Blokir Akun)
* **Endpoint**: `PATCH /api/admin/users/:id/status`
* **Request Body**:
  ```json
  { "isActive": false }
  ```
* **Response (200 OK)**: Mengembalikan data user dengan status `isActive: false`.

#### 5. Hapus Pengguna
* **Endpoint**: `DELETE /api/admin/users/:id`
* **Response (204 No Content)**.

---

## 6. Verifikasi & Pengujian Otomatis

Seluruh logika bisnis dan hardening keamanan autentikasi telah diuji secara otomatis dan dapat dijalankan kapan saja dengan perintah:
```bash
npm run test:auth
```

Output pengujian:
```text
=== MEMULAI TEST UNIT & SECURITY AUTENTIKASI ===
✓ Test 1 Lolos: Bcrypt hashing, salt unik, dan TIMING_DUMMY_HASH terverifikasi.
✓ Test 2 Lolos: Kebijakan wajib @gmail.com, sanitasi, dan anti-type-confusion bekerja akurat.
✓ Test 3 Lolos: Validasi kompleksitas dan batas atas panjang password (DoS guard) lolos.
✓ Test 4 Lolos: Sanitasi karakter kontrol pada nama pengguna bekerja.
✓ Test 5 Lolos: JWT HS256 signing, signature check, dan penolakan alg:none terverifikasi.
✓ Test 6 Lolos: Sanitasi objek user tidak membocorkan hash password.
========================================================
SEMUA 6 SKENARIO TEST & SECURITY HARDENING BERHASIL!
========================================================
```
