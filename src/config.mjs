import path from "node:path";
import { fileURLToPath } from "node:url";

const sourceDir = path.dirname(fileURLToPath(import.meta.url));

function boundedNumber(value, fallback, min, max) {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? Math.max(min, Math.min(parsed, max)) : fallback;
}

export const config = Object.freeze({
  appRoot: path.resolve(sourceDir, ".."),
  dataDir: path.resolve(process.env.DATA_DIR || path.join(sourceDir, "..", "data")),
  port: boundedNumber(process.env.PORT, 4318, 1, 65535),
  panelUser: String(process.env.PANEL_USER || "").trim(),
  panelPassword: String(process.env.PANEL_PASSWORD || ""),
  defaultPhone: String(process.env.DEFAULT_PHONE || ""),
  defaultEmail: String(process.env.DEFAULT_EMAIL || "").trim(),
  maxConcurrency: boundedNumber(process.env.MAX_CONCURRENCY, 3, 1, 5),
  genericConcurrency: boundedNumber(process.env.GENERIC_CONCURRENCY, 10, 1, 20),
  probeConcurrency: boundedNumber(process.env.PROBE_CONCURRENCY, 8, 1, 15),
  maxActiveJobs: boundedNumber(process.env.MAX_ACTIVE_JOBS, 1, 1, 2),
  navigationTimeoutMs: boundedNumber(process.env.NAVIGATION_TIMEOUT_MS, 45000, 10000, 120000),
  resultTimeoutMs: boundedNumber(process.env.RESULT_TIMEOUT_MS, 180000, 30000, 300000),
  // Bir portal hata durumuna düştüğünde sayfayı hemen kapatmak yerine geç
  // gelen yanıt/render için son bir bekleme penceresi bırakılır.
  failureGraceMs: boundedNumber(process.env.FAILURE_GRACE_MS, 30000, 0, 60000),
  otpTimeoutMs: boundedNumber(process.env.OTP_TIMEOUT_MS, 300000, 60000, 600000),
  approvalTimeoutMs: boundedNumber(process.env.APPROVAL_TIMEOUT_MS, 600000, 60000, 1800000),
  historyLookupDelayMs: boundedNumber(process.env.HISTORY_LOOKUP_DELAY_MS, 60000, 0, 180000),
  ihsanSmsCooldownMs: boundedNumber(process.env.IHSAN_SMS_COOLDOWN_MS, 65000, 0, 180000),
  retryCount: boundedNumber(process.env.PORTAL_RETRY_COUNT, 1, 0, 2),
  retentionDays: boundedNumber(process.env.JOB_RETENTION_DAYS, 30, 1, 365),
  // Bazı portallarda masaüstü yerleşimi 1440px viewport'a sığmayıp yazılar
  // üst üste biniyor ve öğeler tıklanamaz hale geliyor. Sayfayı tarayıcı
  // yakınlaştırmasıyla (CSS zoom) küçültmek, medya sorgusu genişliğini
  // değiştirmeden içeriğin ekrana sığmasını sağlıyor.
  pageZoom: boundedNumber(process.env.PAGE_ZOOM, 0.7, 0.4, 1),
  headless: process.env.HEADLESS !== "false",
  allowedOrigins: [
    "https://unal-teklif-avcisi.golfrokko.chatgpt.site",
    "http://127.0.0.1:4318",
    "http://localhost:4318",
    "http://terminal.local:4173",
    ...String(process.env.ALLOWED_ORIGINS || "").split(",").map((value) => value.trim()).filter(Boolean),
  ],
});

export const paths = Object.freeze({
  publicDir: path.join(config.appRoot, "public"),
  jobsDir: path.join(config.dataDir, "jobs"),
  sessionsDir: path.join(config.dataDir, "sessions"),
  settingsFile: path.join(config.dataDir, "portal-settings.json"),
  screenshotsDir: path.join(config.dataDir, "screenshots"),
});
