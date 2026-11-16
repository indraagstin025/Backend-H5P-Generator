import rateLimit from "express-rate-limit";

/**
 * Rate Limiter untuk Endpoint Autentikasi (Login, Register, Seed).
 * Membatasi maksimal 10 request per jendela 15 menit per IP untuk mencegah
 * serangan brute-force dan credential stuffing.
 */
export const authRateLimiter = rateLimit({
  windowMs: 15 * 60 * 1000, // 15 menit
  limit: 10, // Maksimal 10 percobaan per 15 menit
  standardHeaders: "draft-8",
  legacyHeaders: false,
  message: {
    error: "Terlalu banyak percobaan autentikasi. Harap tunggu selama 15 menit sebelum mencoba kembali.",
  },
});

/**
 * Rate Limiter Umum untuk endpoint API.
 * Menjaga stabilitas server dari request flooding sambil tetap mengakomodasi
 * polling status job dan pemuatan aset slide.
 */
export const apiRateLimiter = rateLimit({
  windowMs: 60 * 1000, // 1 menit
  limit: 300, // Maksimal 300 request per menit per IP
  standardHeaders: "draft-8",
  legacyHeaders: false,
  message: {
    error: "Terlalu banyak permintaan ke server. Silakan perlambat laju request Anda.",
  },
});
