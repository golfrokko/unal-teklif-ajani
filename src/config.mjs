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
  maxActiveJobs: boundedNumber(process.env.MAX_ACTIVE_JOBS, 1, 1, 2),
  navigationTimeoutMs: boundedNumber(process.env.NAVIGATION_TIMEOUT_MS, 45000, 10000, 120000),
  resultTimeoutMs: boundedNumber(process.env.RESULT_TIMEOUT_MS, 120000, 30000, 300000),
  otpTimeoutMs: boundedNumber(process.env.OTP_TIMEOUT_MS, 300000, 60000, 600000),
  retryCount: boundedNumber(process.env.PORTAL_RETRY_COUNT, 1, 0, 2),
  retentionDays: boundedNumber(process.env.JOB_RETENTION_DAYS, 30, 1, 365),
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
});
