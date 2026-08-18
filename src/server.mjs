import express from "express";
import { chromium } from "playwright";
import { randomUUID, timingSafeEqual } from "node:crypto";
import { mkdir, readdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { insurerAliases, portals } from "./portals.mjs";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const appRoot = path.resolve(__dirname, "..");
const publicDir = path.join(appRoot, "public");
const dataDir = path.join(appRoot, "data");
const profileDir = path.join(dataDir, "chrome-profile");
const jobsDir = path.join(dataDir, "jobs");
const PORT = Number(process.env.PORT || 4318);
const DEFAULT_PHONE = normalizePhone(process.env.DEFAULT_PHONE);
const MAX_CONCURRENCY = Math.max(1, Math.min(Number(process.env.MAX_CONCURRENCY || 3), 5));
const PANEL_USER = String(process.env.PANEL_USER || "").trim();
const PANEL_PASSWORD = String(process.env.PANEL_PASSWORD || "");
const jobs = new Map();
const otpWaiters = new Map();
const pendingRuns = [];
let queueWorkerActive = false;
let browserContext = null;

await mkdir(jobsDir, { recursive: true });

const app = express();
app.set("trust proxy", 1);
const allowedOrigins = new Set([
  "https://unal-teklif-avcisi.golfrokko.chatgpt.site",
  "http://127.0.0.1:4318",
  "http://localhost:4318",
  "http://terminal.local:4173",
  ...String(process.env.ALLOWED_ORIGINS || "").split(",").map((value) => value.trim()).filter(Boolean),
]);
app.use((req, res, next) => {
  const origin = req.headers.origin;
  let sameOrigin = false;
  try {
    sameOrigin = Boolean(origin && new URL(origin).host === req.headers.host);
  } catch {}
  if (origin && !sameOrigin && !allowedOrigins.has(origin)) return res.status(403).json({ error: "Bu sayfanın sorgu ajanına erişim izni yok" });
  if (origin) {
    res.setHeader("Access-Control-Allow-Origin", origin);
    res.setHeader("Vary", "Origin");
  }
  res.setHeader("Access-Control-Allow-Headers", "Content-Type");
  res.setHeader("Access-Control-Allow-Methods", "GET,POST,OPTIONS");
  res.setHeader("Access-Control-Allow-Private-Network", "true");
  if (req.method === "OPTIONS") return res.sendStatus(204);
  next();
});
app.use((req, res, next) => {
  res.setHeader("X-Content-Type-Options", "nosniff");
  res.setHeader("X-Frame-Options", "DENY");
  res.setHeader("Referrer-Policy", "no-referrer");
  res.setHeader("X-Robots-Tag", "noindex, nofollow, noarchive");
  if (req.path === "/health") return next();
  if (!PANEL_USER || !PANEL_PASSWORD) return res.status(503).send("Panel erişim bilgileri henüz yapılandırılmadı.");
  const authorization = String(req.headers.authorization || "");
  if (authorization.startsWith("Basic ")) {
    try {
      const decoded = Buffer.from(authorization.slice(6), "base64").toString("utf8");
      const separator = decoded.indexOf(":");
      const user = decoded.slice(0, separator);
      const password = decoded.slice(separator + 1);
      const expectedUser = Buffer.from(PANEL_USER);
      const actualUser = Buffer.from(user);
      const expectedPassword = Buffer.from(PANEL_PASSWORD);
      const actualPassword = Buffer.from(password);
      const userMatches = expectedUser.length === actualUser.length && timingSafeEqual(expectedUser, actualUser);
      const passwordMatches = expectedPassword.length === actualPassword.length && timingSafeEqual(expectedPassword, actualPassword);
      if (userMatches && passwordMatches) return next();
    } catch {}
  }
  res.setHeader("WWW-Authenticate", 'Basic realm="Unal Sigorta Teklif Avcisi", charset="UTF-8"');
  return res.status(401).send("Kullanıcı adı veya şifre hatalı.");
});
app.use(express.json({ limit: "1mb" }));
app.use(express.static(publicDir));

function publicJob(job) {
  return {
    id: job.id,
    createdAt: job.createdAt,
    updatedAt: job.updatedAt,
    status: job.status,
    mode: job.mode,
    phone: job.phone,
    vehicle: job.vehicle,
    portalStates: job.portalStates,
    results: job.results,
    summary: summarizeResults(job.results),
  };
}

async function persistJob(job) {
  job.updatedAt = new Date().toISOString();
  await writeFile(path.join(jobsDir, `${job.id}.json`), JSON.stringify(publicJob(job), null, 2), "utf8").catch(() => {});
}

async function setPortalState(job, portalId, patch) {
  job.portalStates[portalId] = { ...job.portalStates[portalId], ...patch, updatedAt: new Date().toISOString() };
  await persistJob(job);
}

function normalizePhone(value) {
  let digits = String(value || "").replace(/\D/g, "");
  if (digits.startsWith("90") && digits.length === 12) digits = digits.slice(2);
  if (digits.length === 10) digits = `0${digits}`;
  return /^05\d{9}$/.test(digits) ? digits : "";
}

function sanitizePhone(value) {
  return normalizePhone(value) || DEFAULT_PHONE;
}

function normalizeVehicle(input = {}) {
  return {
    identity: String(input.identity || "").replace(/\D/g, "").slice(0, 11),
    birthDate: String(input.birthDate || "").trim(),
    plate: String(input.plate || "").replace(/\s+/g, " ").trim().toUpperCase(),
    registration: String(input.registration || "").replace(/\s+/g, "").trim().toUpperCase(),
    vehicle: String(input.vehicle || "").trim(),
    year: String(input.year || "").replace(/\D/g, "").slice(0, 4),
    chassis: String(input.chassis || "").replace(/\s+/g, "").trim().toUpperCase(),
    engine: String(input.engine || "").replace(/\s+/g, "").trim().toUpperCase(),
  };
}

async function getBrowserContext() {
  if (browserContext) return browserContext;
  const launchOptions = {
    headless: process.env.HEADLESS !== "false",
    viewport: { width: 1440, height: 1000 },
    locale: "tr-TR",
    timezoneId: "Europe/Istanbul",
    args: ["--no-sandbox", "--disable-dev-shm-usage", "--disable-gpu", "--disable-session-crashed-bubble"],
  };
  try {
    browserContext = await chromium.launchPersistentContext(profileDir, launchOptions);
  } catch (browserError) {
    throw new Error(`Sunucu tarayıcısı başlatılamadı: ${browserError.message}`);
  }
  browserContext.on("close", () => { browserContext = null; });
  return browserContext;
}

function escapeRegex(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

async function fillFirst(target, value, selectors, labelTerms) {
  if (!value) return false;
  for (const selector of selectors) {
    try {
      const input = target.locator(selector).first();
      if (await input.isVisible({ timeout: 350 })) {
        await input.fill(value, { timeout: 2500 });
        return true;
      }
    } catch {}
  }
  for (const term of labelTerms) {
    try {
      const input = target.getByLabel(new RegExp(escapeRegex(term), "i")).first();
      if (await input.isVisible({ timeout: 350 })) {
        await input.fill(value, { timeout: 2500 });
        return true;
      }
    } catch {}
  }
  for (const term of labelTerms) {
    try {
      const label = target.locator("label").filter({ hasText: new RegExp(escapeRegex(term), "i") }).first();
      if (!(await label.isVisible({ timeout: 350 }))) continue;
      const inside = label.locator("input").first();
      if (await inside.count()) {
        await inside.fill(value, { timeout: 2500 });
        return true;
      }
      const forId = await label.getAttribute("for");
      if (forId) {
        const safeId = forId.replace(/(["\\])/g, "\\$1");
        const byId = target.locator(`[id="${safeId}"]`).first();
        await byId.fill(value, { timeout: 2500 });
        return true;
      }
    } catch {}
  }
  return false;
}

async function acceptRequiredConsents(target) {
  const labels = target.locator("label");
  const count = Math.min(await labels.count(), 120);
  for (let index = 0; index < count; index += 1) {
    const label = labels.nth(index);
    const text = (await label.innerText({ timeout: 300 }).catch(() => "")).toLocaleUpperCase("tr-TR");
    if (!/(KVKK|AYDINLATMA|KULLANICI SÖZLEŞMESİ|GİZLİLİK SÖZLEŞMESİ|KİŞİSEL VERİ)/.test(text)) continue;
    const input = label.locator('input[type="checkbox"]').first();
    if (await input.count()) await input.check({ force: true }).catch(() => {});
  }
}

async function resolveTarget(page, portal) {
  if (portal.adapter !== "ihsan-frame") return page;
  await page.waitForTimeout(1200);
  return page.frames().find((frame) => frame !== page.mainFrame() && /sigorta\.online/i.test(frame.url())) || page;
}

async function fillQuoteForm(target, job) {
  const v = job.vehicle;
  const phone10 = job.phone.replace(/^0/, "");
  const filled = {
    identity: await fillFirst(target, v.identity,
      ['input[name*="identity" i]', 'input[name*="kimlik" i]', 'input[name*="tc" i]', 'input[placeholder*="TC" i]', 'input[placeholder*="kimlik" i]'],
      ["Kimlik Numarası", "TC Kimlik No", "TC/Vergi", "T.C. Kimlik"]),
    birthDate: await fillFirst(target, v.birthDate,
      ['input[name*="birth" i]', 'input[name*="dogum" i]', 'input[placeholder*="GG.AA.YYYY" i]'],
      ["Doğum Tarihi"]),
    plate: await fillFirst(target, v.plate,
      ['input[name*="plate" i]', 'input[name*="plaka" i]', 'input[placeholder*="plaka" i]'],
      ["Plaka"]),
    registration: await fillFirst(target, v.registration,
      ['input[name*="registration" i]', 'input[name*="ruhsat" i]', 'input[name*="belge" i]', 'input[placeholder*="ruhsat" i]'],
      ["Ruhsat Numarası", "Ruhsat Seri", "Belge Seri"]),
    phone: await fillFirst(target, phone10,
      ['input[type="tel"]', 'input[name*="phone" i]', 'input[name*="gsm" i]', 'input[placeholder*="5__" i]'],
      ["GSM", "Cep Telefonu", "Telefon"]),
    chassis: await fillFirst(target, v.chassis,
      ['input[name*="chassis" i]', 'input[name*="sasi" i]'], ["Şasi Numarası", "Şasi No"]),
    engine: await fillFirst(target, v.engine,
      ['input[name*="engine" i]', 'input[name*="motor" i]'], ["Motor Numarası", "Motor No"]),
  };
  await acceptRequiredConsents(target);
  return filled;
}

async function clickSubmit(target) {
  const names = [/Gönder/i, /Teklif(?:i)? Al/i, /Sorgula/i, /Devam/i, /Hemen Teklif/i];
  for (const name of names) {
    try {
      const button = target.getByRole("button", { name }).filter({ visible: true }).first();
      if (await button.isEnabled({ timeout: 500 })) {
        await button.click({ timeout: 4000 });
        return true;
      }
    } catch {}
  }
  for (const selector of ['button[type="submit"]', 'input[type="submit"]']) {
    try {
      const button = target.locator(selector).first();
      if (await button.isEnabled({ timeout: 500 })) {
        await button.click({ timeout: 4000 });
        return true;
      }
    } catch {}
  }
  return false;
}

async function visibleText(page) {
  return (await page.locator("body").innerText({ timeout: 2500 }).catch(() => "")).slice(0, 250000);
}

async function detectCaptcha(page, bodyText = "") {
  if (/(verify you are human|insan olduğunuzu doğrulayın|robot olmadığınızı|güvenlik kontrolü|checking your browser)/i.test(bodyText)) return true;
  return (await page.locator('iframe[src*="recaptcha" i], iframe[src*="hcaptcha" i], [class*="captcha" i], [id*="captcha" i]').count()) > 0;
}

async function findOtpInput(page) {
  const candidates = [
    'input[autocomplete="one-time-code"]',
    'input[name*="otp" i]',
    'input[name*="sms" i]',
    'input[id*="otp" i]',
    'input[id*="sms" i]',
    'input[placeholder*="doğrulama" i]',
    'input[placeholder*="kod" i]'
  ];
  for (const selector of candidates) {
    const input = page.locator(selector).first();
    if (await input.isVisible({ timeout: 250 }).catch(() => false)) return input;
  }
  return null;
}

function parseTry(value) {
  const normalized = value.replace(/\s/g, "").replace(/\./g, "").replace(",", ".").replace(/[^0-9.]/g, "");
  const number = Number(normalized);
  return Number.isFinite(number) && number >= 100 && number <= 1000000 ? number : null;
}

function extractOffersFromText(text, portal) {
  const upper = text.toLocaleUpperCase("tr-TR");
  const offers = [];
  for (const [company, aliases] of insurerAliases) {
    const positions = aliases.map((alias) => upper.indexOf(alias)).filter((position) => position >= 0);
    if (!positions.length) continue;
    const position = Math.min(...positions);
    const segment = text.slice(Math.max(0, position - 120), position + 420);
    const prices = [...segment.matchAll(/(?:₺\s*)?(\d{1,3}(?:\.\d{3})*(?:,\d{2})?|\d{3,6}(?:,\d{2})?)\s*(?:TL|₺)/gi)]
      .map((match) => parseTry(match[1]))
      .filter(Boolean);
    if (!prices.length) continue;
    offers.push({
      company,
      price: Math.min(...prices),
      currency: "TRY",
      sourcePortalId: portal.id,
      sourcePortal: portal.name,
      sourceUrl: portal.url,
      capturedAt: new Date().toISOString(),
    });
  }
  return offers;
}

function summarizeResults(results) {
  const grouped = new Map();
  for (const result of results) {
    const current = grouped.get(result.company) || { company: result.company, bestPrice: result.price, sources: [] };
    current.bestPrice = Math.min(current.bestPrice, result.price);
    current.sources.push(result);
    grouped.set(result.company, current);
  }
  return [...grouped.values()].sort((a, b) => a.bestPrice - b.bestPrice);
}

function waitForOtp(job, portal) {
  return new Promise((resolve, reject) => {
    const key = `${job.id}:${portal.id}`;
    const timeout = setTimeout(() => {
      otpWaiters.delete(key);
      reject(new Error("SMS kodu zaman aşımına uğradı"));
    }, 5 * 60 * 1000);
    otpWaiters.set(key, (code) => {
      clearTimeout(timeout);
      otpWaiters.delete(key);
      resolve(code);
    });
  });
}

async function waitForOutcome(page, target, job, portal) {
  const started = Date.now();
  let resultsSeenAt = null;
  while (Date.now() - started < 180000) {
    const text = await visibleText(target);
    if (await detectCaptcha(page, text)) return { kind: "manual", reason: "CAPTCHA / güvenlik kontrolü" };

    const otpInput = await findOtpInput(target);
    const smsLanguage = /(SMS|TEK KULLANIMLIK|DOĞRULAMA KODU|ONAY KODU|CEP TELEFONUNUZA)/i.test(text);
    if (otpInput && (smsLanguage || /sms|otp|dogrulama/i.test(target.url()))) {
      if (job.mode === "no_sms") return { kind: "skipped_sms" };
      await setPortalState(job, portal.id, { status: "waiting_otp", message: `${job.phone} numarasına gelen kod bekleniyor` });
      const code = await waitForOtp(job, portal);
      await otpInput.fill(code, { timeout: 4000 });
      const submitted = await clickSubmit(target);
      if (!submitted) await otpInput.press("Enter").catch(() => {});
      await setPortalState(job, portal.id, { status: "collecting", message: "SMS doğrulandı, teklifler bekleniyor" });
      await page.waitForTimeout(1500);
      continue;
    }

    const offers = extractOffersFromText(text, portal);
    if (offers.length) {
      if (!resultsSeenAt) resultsSeenAt = Date.now();
      if (Date.now() - resultsSeenAt > 10000) return { kind: "offers", offers };
    }

    if (/(TEKLİF SONUÇLARI|TEKLİFLER SORGULANIYOR|SORGULAMA DURUMU)/i.test(text)) {
      await setPortalState(job, portal.id, { status: "collecting", message: "Sigorta şirketleri sorgulanıyor" });
    }
    await page.waitForTimeout(2500);
  }
  const finalOffers = extractOffersFromText(await visibleText(target), portal);
  return finalOffers.length ? { kind: "offers", offers: finalOffers } : { kind: "no_offer" };
}

async function runPortal(job, portal) {
  let page;
  try {
    await setPortalState(job, portal.id, { status: "opening", message: "Portal açılıyor" });
    const context = await getBrowserContext();
    page = await context.newPage();
    await page.goto(portal.url, { waitUntil: "domcontentloaded", timeout: 45000 });
    await page.waitForTimeout(1000);
    const textBefore = await visibleText(page);
    if (await detectCaptcha(page, textBefore)) {
      await setPortalState(job, portal.id, { status: "manual_required", message: "CAPTCHA / güvenlik kontrolü" });
      return;
    }

    const target = await resolveTarget(page, portal);
    await setPortalState(job, portal.id, { status: "filling", message: "Araç bilgileri dolduruluyor" });
    const filled = await fillQuoteForm(target, job);
    if (!filled.identity || !filled.plate) {
      await setPortalState(job, portal.id, { status: "mapping_required", message: "Bu portal için alan eşlemesi gerekiyor" });
      return;
    }

    const submitted = await clickSubmit(target);
    if (!submitted) {
      await setPortalState(job, portal.id, { status: "mapping_required", message: "Sorgu düğmesi eşleştirilemedi" });
      return;
    }
    await setPortalState(job, portal.id, { status: "submitted", message: "Sorgu gönderildi" });
    const outcome = await waitForOutcome(page, target, job, portal);

    if (outcome.kind === "offers") {
      job.results.push(...outcome.offers);
      await setPortalState(job, portal.id, { status: "completed", message: `${outcome.offers.length} şirket teklifi alındı`, offerCount: outcome.offers.length });
    } else if (outcome.kind === "skipped_sms") {
      await setPortalState(job, portal.id, { status: "skipped_sms", message: "SMS istendiği için atlandı" });
    } else if (outcome.kind === "manual") {
      await setPortalState(job, portal.id, { status: "manual_required", message: outcome.reason });
    } else {
      await setPortalState(job, portal.id, { status: "no_offer", message: "Teklif bulunamadı veya süre doldu" });
    }
  } catch (error) {
    await setPortalState(job, portal.id, { status: "error", message: String(error.message || error).slice(0, 220) });
  } finally {
    if (page) await page.close().catch(() => {});
  }
}

async function runJob(job, selected) {
  job.status = "running";
  await persistJob(job);
  for (let index = 0; index < selected.length; index += MAX_CONCURRENCY) {
    const batch = selected.slice(index, index + MAX_CONCURRENCY);
    await Promise.all(batch.map((portal) => runPortal(job, portal)));
  }
  job.status = "completed";
  await persistJob(job);
}

async function drainQueue() {
  if (queueWorkerActive) return;
  queueWorkerActive = true;
  try {
    while (pendingRuns.length) {
      const { job, selected } = pendingRuns.shift();
      try {
        await runJob(job, selected);
      } catch (error) {
        job.status = "failed";
        job.failure = String(error.message || error);
        await persistJob(job);
      }
    }
  } finally {
    queueWorkerActive = false;
  }
}

async function loadJobHistory() {
  const files = await readdir(jobsDir).catch(() => []);
  for (const file of files.filter((name) => name.endsWith(".json")).slice(-50)) {
    try {
      const stored = JSON.parse(await readFile(path.join(jobsDir, file), "utf8"));
      if (["queued", "running"].includes(stored.status)) stored.status = "interrupted";
      jobs.set(stored.id, stored);
    } catch {}
  }
}

await loadJobHistory();

app.get("/health", (req, res) => res.json({ ok: true, name: "Ünal Sigorta Teklif Ajanı", version: "0.4.0", portalCount: portals.length, defaultPhone: DEFAULT_PHONE, maxConcurrency: MAX_CONCURRENCY, queueLength: pendingRuns.length, panelAuthConfigured: Boolean(PANEL_USER && PANEL_PASSWORD) }));
app.get("/api/portals", (req, res) => res.json({ portals, maxConcurrency: MAX_CONCURRENCY }));
app.get("/api/jobs", (req, res) => {
  const history = [...jobs.values()].sort((a, b) => String(b.createdAt).localeCompare(String(a.createdAt))).slice(0, 30).map(publicJob);
  res.json({ jobs: history, queued: pendingRuns.length, running: queueWorkerActive });
});
app.get("/api/jobs/:id", (req, res) => {
  const job = jobs.get(req.params.id);
  if (!job) return res.status(404).json({ error: "Sorgu bulunamadı" });
  res.json(publicJob(job));
});

app.post("/api/jobs", async (req, res) => {
  if (req.body?.customerConsent !== true) return res.status(400).json({ error: "Müşteri sorgulama onayı işaretlenmelidir" });
  const vehicle = normalizeVehicle(req.body?.vehicle);
  if (!/^\d{10,11}$/.test(vehicle.identity) || !vehicle.plate) return res.status(400).json({ error: "TC/VKN ve plaka zorunludur" });
  const requested = Array.isArray(req.body?.portalIds) ? req.body.portalIds : portals.map((portal) => portal.id);
  const selected = portals.filter((portal) => requested.includes(portal.id));
  if (!selected.length) return res.status(400).json({ error: "En az bir portal seçilmelidir" });
  const phone = sanitizePhone(req.body?.phone);
  if (!phone) return res.status(400).json({ error: "Geçerli bir SMS telefon numarası girilmelidir" });

  const job = {
    id: randomUUID(),
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    status: "queued",
    mode: req.body?.mode === "no_sms" ? "no_sms" : "ask_sms",
    phone,
    vehicle,
    results: [],
    portalStates: Object.fromEntries(selected.map((portal) => [portal.id, { portalId: portal.id, portalName: portal.name, status: "queued", message: "Sırada", updatedAt: new Date().toISOString() }])),
  };
  jobs.set(job.id, job);
  await persistJob(job);
  res.status(202).json(publicJob(job));
  pendingRuns.push({ job, selected });
  void drainQueue();
});

app.post("/api/jobs/:jobId/otp/:portalId", (req, res) => {
  const job = jobs.get(req.params.jobId);
  if (!job) return res.status(404).json({ error: "Sorgu bulunamadı" });
  const code = String(req.body?.code || "").replace(/\D/g, "").slice(0, 8);
  if (code.length < 4) return res.status(400).json({ error: "Geçerli SMS kodu girin" });
  const key = `${job.id}:${req.params.portalId}`;
  const resolve = otpWaiters.get(key);
  if (!resolve) return res.status(409).json({ error: "Bu portal şu anda SMS kodu beklemiyor" });
  resolve(code);
  res.json({ ok: true });
});

app.listen(PORT, "0.0.0.0", () => {
  console.log(`Ünal Sigorta Teklif Ajanı hazır: http://0.0.0.0:${PORT}`);
  console.log(`Portal sayısı: ${portals.length} | Eşzamanlı sorgu: ${MAX_CONCURRENCY}`);
});
