import rateLimit from "express-rate-limit";

/**
 * Rate Limiter untuk Endpoint Autentikasi (Login & Register).
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
 * Menjaga stabilitas server dari spamming request berlebihan.
 */
export const apiRateLimiter = rateLimit({
  windowMs: 60 * 1000, // 1 menit
  limit: 200, // Maksimal 200 request per menit
  standardHeaders: "draft-8",
  legacyHeaders: false,
  message: {
    error: "Terlalu banyak permintaan ke server. Silakan perlambat laju request Anda.",
  },
});
