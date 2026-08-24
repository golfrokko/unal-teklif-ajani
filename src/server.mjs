import express from "express";
import path from "node:path";
import { randomUUID, timingSafeEqual } from "node:crypto";
import { config, paths } from "./config.mjs";
import { portals } from "./portals.mjs";
import { BrowserManager } from "./lib/browser-manager.mjs";
import { JobEvents } from "./lib/events.mjs";
import { JobQueue } from "./lib/queue.mjs";
import { FileStore, publicJob } from "./lib/store.mjs";
import { normalizeOtp, normalizePhone, safeMessage, validateJobInput } from "./lib/validation.mjs";
import { QueryEngine } from "./engine.mjs";

const VERSION = "1.13.0";
const portalRegistry = new Map(portals.map((portal) => [portal.id, Object.freeze({ ...portal })]));
const store = new FileStore({ jobsDir: paths.jobsDir, settingsFile: paths.settingsFile, retentionDays: config.retentionDays });
const events = new JobEvents();
const browserManager = new BrowserManager({ sessionsDir: paths.sessionsDir, headless: config.headless, pageZoom: config.pageZoom });
await Promise.all([store.init(), browserManager.init()]);
let portalSettings = await store.getPortalSettings();
let lastRuntimeError = null;
let portalProbes = {};
let sessionStatus = {};
let sessionCheckRunning = false;

function portalView(portal) {
  const setting = portalSettings[portal.id] || {};
  const probe = portalProbes[portal.id] || null;
  const session = sessionStatus[portal.id] || null;
  const discoveredReady = portal.adapter === "generic" && probe?.state === "form_detected";
  const enabled = typeof setting.enabled === "boolean" ? setting.enabled : portal.defaultEnabled === true;
  return {
    ...portal,
    enabled,
    available: enabled || discoveredReady,
    integrationStatus: setting.integrationStatus || portal.integrationStatus || (portal.verifiedForm ? "configured_unverified" : "discovery"),
    lastVerifiedAt: setting.lastVerifiedAt || null,
    note: setting.note || "",
    probeState: probe?.state || null,
    probeMessage: probe?.message || "",
    probeCheckedAt: probe?.checkedAt || null,
    probeHasScreenshot: probe?.hasScreenshot || false,
    sessionLoggedIn: session?.loggedIn ?? null,
    sessionMessage: session?.message || "",
    sessionCheckedAt: session?.checkedAt || null,
    sessionHasScreenshot: session?.hasScreenshot || false,
  };
}

async function checkAllSessions() {
  if (sessionCheckRunning) return;
  sessionCheckRunning = true;
  try {
    const targets = portals.filter((portal) => portal.smsPolicy === "session_once");
    let nextIndex = 0;
    const workers = Array.from({ length: Math.min(config.probeConcurrency, targets.length) }, async () => {
      while (nextIndex < targets.length) {
        const portal = targets[nextIndex];
        nextIndex += 1;
        try {
          const result = await engine.checkPortalSession(portal, {
            navigationTimeoutMs: portal.navigationTimeoutMs || Math.min(config.navigationTimeoutMs, 20000),
          });
          sessionStatus = { ...sessionStatus, [portal.id]: { ...result, checkedAt: new Date().toISOString() } };
        } catch (error) {
          sessionStatus = { ...sessionStatus, [portal.id]: { loggedIn: null, message: safeMessage(error, 200), checkedAt: new Date().toISOString() } };
        }
      }
    });
    await Promise.all(workers);
  } finally {
    sessionCheckRunning = false;
  }
}

function probeSummary() {
  return Object.values(portalProbes).reduce((summary, probe) => {
    summary[probe.state] = (summary[probe.state] || 0) + 1;
    return summary;
  }, {});
}

function conciseProbe(result) {
  const messages = {
    form_detected: "Canlı teklif formu bulundu",
    mapping_required: "Teklif formu eşleştirilemedi",
    manual_required: "CAPTCHA / güvenlik doğrulaması gerekiyor",
    access_blocked: "Portal sunucu erişimini engelledi",
    auth_required: "Portal oturumu gerekiyor",
    redirect_only: "Bağımsız kaynak değil; başka portala yönlendiriyor",
    client_error: "Portalın kendi web uygulaması formu yükleyemiyor",
    timeout: "Portal bağlantısı zaman aşımına uğradı",
    unsupported: "Bu adaptörde canlı form teşhisi yok",
  };
  return {
    state: result.state || "error",
    message: result.message || messages[result.state] || "Portal teşhisi tamamlandı",
    ...(result.hasScreenshot ? { hasScreenshot: true } : {}),
    ...(result.fields ? { fields: result.fields } : {}),
    ...(!result.fields && Array.isArray(result.controls) ? { fields: { controlCount: result.controls.length, labelCount: result.labels?.length || 0 } } : {}),
  };
}

function safeEqual(actual, expected) {
  const actualBuffer = Buffer.from(actual);
  const expectedBuffer = Buffer.from(expected);
  return actualBuffer.length === expectedBuffer.length && timingSafeEqual(actualBuffer, expectedBuffer);
}

function basicAuth(req, res, next) {
  if (req.path === "/health") return next();
  if (!config.panelUser || !config.panelPassword) return res.status(503).send("Panel erişim bilgileri henüz yapılandırılmadı.");
  const authorization = String(req.headers.authorization || "");
  if (authorization.startsWith("Basic ")) {
    try {
      const decoded = Buffer.from(authorization.slice(6), "base64").toString("utf8");
      const separator = decoded.indexOf(":");
      if (separator >= 0 && safeEqual(decoded.slice(0, separator), config.panelUser) && safeEqual(decoded.slice(separator + 1), config.panelPassword)) return next();
    } catch {}
  }
  res.setHeader("WWW-Authenticate", 'Basic realm="Unal Sigorta Teklif Avcisi", charset="UTF-8"');
  return res.status(401).send("Kullanıcı adı veya şifre hatalı.");
}

const engine = new QueryEngine({ store, events, browserManager, portalRegistry, config, paths });
const queue = new JobQueue({
  maxActive: config.maxActiveJobs,
  handler: (jobId) => engine.executeJob(jobId),
  onError: (jobId, error) => engine.handleQueueError(jobId, error),
});

const app = express();
app.disable("x-powered-by");
app.set("trust proxy", 1);
const allowedOrigins = new Set(config.allowedOrigins);
app.use((req, res, next) => {
  const origin = req.headers.origin;
  let sameOrigin = false;
  try { sameOrigin = Boolean(origin && new URL(origin).host === req.headers.host); } catch {}
  if (origin && !sameOrigin && !allowedOrigins.has(origin)) return res.status(403).json({ error: "Bu sayfanın sorgu ajanına erişim izni yok" });
  if (origin) {
    res.setHeader("Access-Control-Allow-Origin", origin);
    res.setHeader("Vary", "Origin");
  }
  res.setHeader("Access-Control-Allow-Headers", "Content-Type");
  res.setHeader("Access-Control-Allow-Methods", "GET,POST,PATCH,OPTIONS");
  res.setHeader("Access-Control-Allow-Private-Network", "true");
  if (req.method === "OPTIONS") return res.sendStatus(204);
  next();
});
app.use((req, res, next) => {
  res.setHeader("X-Content-Type-Options", "nosniff");
  res.setHeader("X-Frame-Options", "DENY");
  res.setHeader("Referrer-Policy", "no-referrer");
  res.setHeader("X-Robots-Tag", "noindex, nofollow, noarchive");
  res.setHeader("Permissions-Policy", "camera=(), microphone=(), geolocation=()");
  next();
});
app.use(basicAuth);
app.use(express.json({ limit: "1mb" }));

app.get("/health", (req, res) => res.json({
  ok: true,
  name: "Ünal Sigorta Teklif Ajanı",
  version: VERSION,
  portalCount: portals.length,
  enabledPortalCount: portals.filter((portal) => portalView(portal).enabled).length,
  defaultPhone: normalizePhone(config.defaultPhone),
  maxConcurrency: config.maxConcurrency,
  genericConcurrency: config.genericConcurrency,
  queue: queue.stats,
  browser: { state: browserManager.state, activeContexts: browserManager.activeContextCount },
  portalProbes,
  probeSummary: probeSummary(),
  lastRuntimeError: lastRuntimeError || engine.lastError || browserManager.lastError,
  panelAuthConfigured: Boolean(config.panelUser && config.panelPassword),
}));

app.get(["/api/v1/system", "/api/system"], (req, res) => res.json({
  version: VERSION,
  queue: queue.stats,
  browser: { state: browserManager.state, activeContexts: browserManager.activeContextCount },
  retentionDays: config.retentionDays,
  maxConcurrency: config.maxConcurrency,
  genericConcurrency: config.genericConcurrency,
  safety: { captchaBypass: false, smsBypass: false, authorizedUseOnly: true },
}));

app.get(["/api/v1/portals", "/api/portals"], (req, res) => res.json({
  portals: portals.map(portalView),
  maxConcurrency: config.maxConcurrency,
  genericConcurrency: config.genericConcurrency,
  defaultEmail: config.defaultEmail,
  probeSummary: probeSummary(),
}));
app.patch("/api/v1/portals/:id", async (req, res, next) => {
  try {
    const portal = portalRegistry.get(req.params.id);
    if (!portal) return res.status(404).json({ error: "Portal bulunamadı" });
    portalSettings = {
      ...portalSettings,
      [portal.id]: {
        ...(portalSettings[portal.id] || {}),
        ...(typeof req.body?.enabled === "boolean" ? { enabled: req.body.enabled } : {}),
        ...(typeof req.body?.note === "string" ? { note: req.body.note.trim().slice(0, 300) } : {}),
      },
    };
    await store.savePortalSettings(portalSettings);
    res.json({ portal: portalView(portal) });
  } catch (error) { next(error); }
});

app.post(["/api/v1/portals/reset-sessions", "/api/portals/reset-sessions"], async (req, res, next) => {
  try {
    const requestedIds = Array.isArray(req.body?.portalIds) ? req.body.portalIds.filter((id) => portalRegistry.has(id)) : null;
    const targetIds = requestedIds?.length ? requestedIds : [...portalRegistry.keys()];
    const reset = await browserManager.resetSessions(targetIds);
    res.json({ ok: true, reset });
  } catch (error) { next(error); }
});

app.post(["/api/v1/sessions/check", "/api/sessions/check"], async (req, res, next) => {
  try {
    if (sessionCheckRunning) return res.status(409).json({ error: "Oturum kontrolü zaten çalışıyor" });
    await checkAllSessions();
    res.json({ ok: true, portals: portals.map(portalView) });
  } catch (error) { next(error); }
});

app.get(["/api/v1/portals/:portalId/screenshot/:kind", "/api/portals/:portalId/screenshot/:kind"], (req, res) => {
  const portalId = String(req.params.portalId || "");
  const kind = String(req.params.kind || "");
  if (!/^[a-z0-9_-]+$/i.test(portalId)) return res.status(400).json({ error: "Geçersiz portal" });
  if (!["probe", "session"].includes(kind)) return res.status(400).json({ error: "Geçersiz ekran görüntüsü türü" });
  const file = path.join(paths.screenshotsDir, `${kind}-${portalId}.jpg`);
  res.sendFile(file, (error) => {
    if (error && !res.headersSent) res.status(404).json({ error: "Ekran görüntüsü bulunamadı" });
  });
});

// "Oturum Aç": sorgu öncesinde kullanıcının bir portala kalıcı olarak
// (kendi elleriyle) giriş yapmasını sağlayan canlı, job'a bağlı olmayan
// oturum akışı. CAPTCHA canlı çözümüyle aynı tıklama-iletme mantığını
// kullanır, ayrıca metin/tuş iletimi de destekler (kullanıcı adı/şifre).
function validatePortalIdParam(req, res) {
  const portalId = String(req.params.portalId || "");
  if (!/^[a-z0-9_-]+$/i.test(portalId) || !portalRegistry.has(portalId)) {
    res.status(404).json({ error: "Portal bulunamadı" });
    return null;
  }
  return portalId;
}

app.post(["/api/v1/portals/:portalId/session-open/start", "/api/portals/:portalId/session-open/start"], (req, res) => {
  const portalId = validatePortalIdParam(req, res);
  if (!portalId) return;
  const result = engine.startPortalSession(portalId);
  if (result.error) return res.status(409).json({ error: result.error });
  res.json({ ok: true });
});

app.get(["/api/v1/portals/:portalId/session-open/status", "/api/portals/:portalId/session-open/status"], (req, res) => {
  const portalId = validatePortalIdParam(req, res);
  if (!portalId) return;
  const status = engine.getPortalSessionStatus(portalId);
  if (!status) return res.status(404).json({ error: "Oturum açma bulunamadı" });
  res.json(status);
});

app.get(["/api/v1/portals/:portalId/session-open/live", "/api/portals/:portalId/session-open/live"], async (req, res, next) => {
  try {
    const portalId = validatePortalIdParam(req, res);
    if (!portalId) return;
    const buffer = await engine.screenshotPortalSession(portalId);
    if (!buffer) return res.status(404).json({ error: "Canlı görüntü bulunamadı" });
    res.set("Cache-Control", "no-store");
    res.type("image/jpeg").send(buffer);
  } catch (error) { next(error); }
});

app.post(["/api/v1/portals/:portalId/session-open/click", "/api/portals/:portalId/session-open/click"], async (req, res, next) => {
  try {
    const portalId = validatePortalIdParam(req, res);
    if (!portalId) return;
    const x = Number(req.body?.x);
    const y = Number(req.body?.y);
    if (!Number.isFinite(x) || !Number.isFinite(y)) return res.status(400).json({ error: "Geçersiz koordinat" });
    const ok = await engine.clickPortalSession(portalId, x, y);
    if (!ok) return res.status(409).json({ error: "Canlı oturum bulunamadı" });
    res.json({ ok: true });
  } catch (error) { next(error); }
});

app.post(["/api/v1/portals/:portalId/session-open/type", "/api/portals/:portalId/session-open/type"], async (req, res, next) => {
  try {
    const portalId = validatePortalIdParam(req, res);
    if (!portalId) return;
    const text = String(req.body?.text ?? "").slice(0, 200);
    if (!text) return res.status(400).json({ error: "Metin boş olamaz" });
    const ok = await engine.typePortalSession(portalId, text);
    if (!ok) return res.status(409).json({ error: "Canlı oturum bulunamadı" });
    res.json({ ok: true });
  } catch (error) { next(error); }
});

app.post(["/api/v1/portals/:portalId/session-open/key", "/api/portals/:portalId/session-open/key"], async (req, res, next) => {
  try {
    const portalId = validatePortalIdParam(req, res);
    if (!portalId) return;
    const key = String(req.body?.key || "");
    if (!/^[A-Za-z0-9]+$/.test(key)) return res.status(400).json({ error: "Geçersiz tuş" });
    const ok = await engine.pressKeyPortalSession(portalId, key);
    if (!ok) return res.status(409).json({ error: "Canlı oturum bulunamadı" });
    res.json({ ok: true });
  } catch (error) { next(error); }
});

app.post(["/api/v1/portals/:portalId/session-open/finish", "/api/portals/:portalId/session-open/finish"], (req, res) => {
  const portalId = validatePortalIdParam(req, res);
  if (!portalId) return;
  const ok = engine.finishPortalSession(portalId);
  if (!ok) return res.status(409).json({ error: "Canlı oturum bulunamadı" });
  res.json({ ok: true });
});

app.get(["/api/v1/jobs", "/api/jobs"], (req, res) => res.json({ jobs: store.listJobs(30).map(publicJob), queue: queue.stats }));
app.get(["/api/v1/jobs/:id", "/api/jobs/:id"], (req, res) => {
  const job = store.getJob(req.params.id);
  if (!job) return res.status(404).json({ error: "Sorgu bulunamadı" });
  res.json(publicJob(job));
});

async function createJob(req, res, next) {
  try {
    const validated = validateJobInput(req.body, config.defaultPhone, config.defaultEmail);
    if (validated.error) return res.status(400).json({ error: validated.error });
    const hasExplicitSelection = Array.isArray(req.body?.portalIds);
    const requested = hasExplicitSelection ? new Set(req.body.portalIds) : new Set(portals.filter((portal) => portalView(portal).enabled).map((portal) => portal.id));
    // Kullanıcı panelden açıkça bir portal seçtiyse "hazır/enabled" şartı
    // aranmaz: bir portal çoğu zaman tam da elle giriş/CAPTCHA tamamlanmadığı
    // için hazır görünmüyor, ama kullanıcı Oturum Aç ile hazırlayıp yine de
    // sorgulamak isteyebiliyor. Seçim yoksa eski davranış (yalnız enabled).
    const selected = portals.filter((portal) => (
      requested.has(portal.id) && (hasExplicitSelection || portalView(portal).enabled)
    ));
    if (!selected.length) return res.status(400).json({ error: "Etkin en az bir portal seçilmelidir" });
    const emailPortal = selected.find((portal) => portal.requiredFields?.includes("email"));
    if (emailPortal && !validated.value.email) return res.status(400).json({ error: `${emailPortal.name} için geçerli teklif e-postası zorunludur` });
    if (selected.some((portal) => ["ihsan", "ihsan-frame"].includes(portal.adapter))) {
      if (!validated.value.vehicle.registration) return res.status(400).json({ error: "İhsan altyapılı sorgular için ruhsat seri numarası zorunludur" });
      if (validated.value.vehicle.identity.length === 11 && !/^\d{1,2}[./-]\d{1,2}[./-]\d{4}$/.test(validated.value.vehicle.birthDate)) {
        return res.status(400).json({ error: "İhsan altyapılı sorgular için doğum tarihi GG.AA.YYYY biçiminde zorunludur" });
      }
    }
    const now = new Date().toISOString();
    const SESSION_HINT_FRESH_MS = 15 * 60 * 1000;
    const sessionHints = Object.fromEntries(selected
      .map((portal) => [portal.id, sessionStatus[portal.id]])
      .filter(([, status]) => status?.loggedIn === true && Date.now() - Date.parse(status.checkedAt || 0) < SESSION_HINT_FRESH_MS));
    const job = {
      id: randomUUID(), createdAt: now, updatedAt: now, startedAt: null, finishedAt: null, status: "queued",
      ...validated.value,
      portalIds: selected.map((portal) => portal.id),
      sessionHints,
      results: [],
      portalStates: Object.fromEntries(selected.map((portal) => [portal.id, {
        portalId: portal.id, portalName: portal.name, status: "queued", message: "Sırada", updatedAt: now,
      }])),
    };
    store.putJob(job);
    await store.saveJob(job);
    queue.add(job.id);
    events.publish(job.id, "job.queued", { job: publicJob(job) });
    res.status(202).json(publicJob(job));
  } catch (error) { next(error); }
}
app.post(["/api/v1/jobs", "/api/jobs"], createJob);

async function submitOtp(req, res) {
  const job = store.getJob(req.params.jobId);
  if (!job) return res.status(404).json({ error: "Sorgu bulunamadı" });
  const code = normalizeOtp(req.body?.code);
  if (!code) return res.status(400).json({ error: "Geçerli SMS kodu girin" });
  if (!engine.submitOtp(job.id, req.params.portalId, code)) return res.status(409).json({ error: "Bu portal şu anda SMS kodu beklemiyor" });
  res.json({ ok: true });
}
app.post(["/api/v1/jobs/:jobId/otp/:portalId", "/api/jobs/:jobId/otp/:portalId"], submitOtp);

async function submitInput(req, res) {
  const job = store.getJob(req.params.jobId);
  if (!job) return res.status(404).json({ error: "Sorgu bulunamadı" });
  const inputId = String(req.params.inputId || "").trim();
  const value = String(req.body?.value ?? "").trim().slice(0, 300);
  if (!inputId || !value) return res.status(400).json({ error: "Geçerli bir değer girin" });
  if (!engine.submitInput(job.id, req.params.portalId, inputId, value)) return res.status(409).json({ error: "Bu portal şu anda bu bilgiyi beklemiyor" });
  res.json({ ok: true });
}
app.post(["/api/v1/jobs/:jobId/input/:portalId/:inputId", "/api/jobs/:jobId/input/:portalId/:inputId"], submitInput);

app.post(["/api/v1/jobs/:jobId/resend/:portalId", "/api/jobs/:jobId/resend/:portalId"], (req, res) => {
  const job = store.getJob(req.params.jobId);
  if (!job) return res.status(404).json({ error: "Sorgu bulunamadı" });
  if (!engine.requestResend(job.id, req.params.portalId)) return res.status(409).json({ error: "Bu portal şu anda SMS kodu beklemiyor" });
  res.json({ ok: true });
});

app.post(["/api/v1/jobs/:jobId/approve/:portalId", "/api/jobs/:jobId/approve/:portalId"], (req, res) => {
  const job = store.getJob(req.params.jobId);
  if (!job) return res.status(404).json({ error: "Sorgu bulunamadı" });
  if (!engine.approvePortal(job.id, req.params.portalId)) return res.status(409).json({ error: "Bu portal şu anda onay beklemiyor" });
  res.json({ ok: true });
});

app.get(["/api/v1/jobs/:jobId/screenshot/:portalId", "/api/jobs/:jobId/screenshot/:portalId"], (req, res) => {
  const job = store.getJob(req.params.jobId);
  if (!job) return res.status(404).json({ error: "Sorgu bulunamadı" });
  const portalId = String(req.params.portalId || "");
  if (!/^[a-z0-9_-]+$/i.test(portalId)) return res.status(400).json({ error: "Geçersiz portal" });
  const file = path.join(paths.screenshotsDir, `${job.id}-${portalId}.jpg`);
  res.sendFile(file, (error) => {
    if (error && !res.headersSent) res.status(404).json({ error: "Ekran görüntüsü bulunamadı" });
  });
});

app.post(["/api/v1/jobs/:jobId/captcha/:portalId/continue", "/api/jobs/:jobId/captcha/:portalId/continue"], (req, res) => {
  const job = store.getJob(req.params.jobId);
  if (!job) return res.status(404).json({ error: "Sorgu bulunamadı" });
  if (!engine.resumeCaptcha(job.id, req.params.portalId)) return res.status(409).json({ error: "Bu portal şu anda CAPTCHA çözümü beklemiyor" });
  res.json({ ok: true });
});

// "Site site ilerle, her aşamada ekran ver, devam et'i ben uygulayayım":
// her aşama geçişinde (opening/filling/submitted/collecting) engine
// duraklıyor; bu uç nokta kullanıcının panelden "Devam Et"ine basınca bir
// sonraki adıma geçişi tetikler. Canlı ekran/tıklama için mevcut
// captcha/:portalId/live ve /click uç noktaları (yalnız jobId:portalId
// anahtarına bakıyorlar) aynen tekrar kullanılıyor.
app.post(["/api/v1/jobs/:jobId/step/:portalId/continue", "/api/jobs/:jobId/step/:portalId/continue"], (req, res) => {
  const job = store.getJob(req.params.jobId);
  if (!job) return res.status(404).json({ error: "Sorgu bulunamadı" });
  if (!engine.continueStep(job.id, req.params.portalId)) return res.status(409).json({ error: "Bu portal şu anda devam onayı beklemiyor" });
  res.json({ ok: true });
});

app.get(["/api/v1/jobs/:jobId/captcha/:portalId/live", "/api/jobs/:jobId/captcha/:portalId/live"], async (req, res, next) => {
  try {
    const job = store.getJob(req.params.jobId);
    if (!job) return res.status(404).json({ error: "Sorgu bulunamadı" });
    const portalId = String(req.params.portalId || "");
    if (!/^[a-z0-9_-]+$/i.test(portalId)) return res.status(400).json({ error: "Geçersiz portal" });
    const buffer = await engine.screenshotLivePage(job.id, portalId);
    if (!buffer) return res.status(404).json({ error: "Canlı görüntü bulunamadı" });
    res.set("Cache-Control", "no-store");
    res.type("image/jpeg").send(buffer);
  } catch (error) { next(error); }
});

app.post(["/api/v1/jobs/:jobId/captcha/:portalId/click", "/api/jobs/:jobId/captcha/:portalId/click"], async (req, res, next) => {
  try {
    const job = store.getJob(req.params.jobId);
    if (!job) return res.status(404).json({ error: "Sorgu bulunamadı" });
    const x = Number(req.body?.x);
    const y = Number(req.body?.y);
    if (!Number.isFinite(x) || !Number.isFinite(y) || x < 0 || y < 0) return res.status(400).json({ error: "Geçersiz koordinat" });
    const ok = await engine.clickLivePage(job.id, req.params.portalId, x, y);
    if (!ok) return res.status(409).json({ error: "Bu portal şu anda canlı etkileşim beklemiyor" });
    res.json({ ok: true });
  } catch (error) { next(error); }
});

app.post(["/api/v1/jobs/:id/cancel", "/api/jobs/:id/cancel"], async (req, res, next) => {
  try {
    const job = store.getJob(req.params.id);
    if (!job) return res.status(404).json({ error: "Sorgu bulunamadı" });
    if (queue.cancelPending(job.id)) await engine.markPendingCancelled(job.id);
    else if (!await engine.cancel(job.id)) return res.status(409).json({ error: "Bu sorgu artık iptal edilemez" });
    res.json(publicJob(store.getJob(job.id)));
  } catch (error) { next(error); }
});

app.get("/api/v1/jobs/:id/events", (req, res) => {
  const job = store.getJob(req.params.id);
  if (!job) return res.status(404).json({ error: "Sorgu bulunamadı" });
  res.status(200);
  res.setHeader("Content-Type", "text/event-stream");
  res.setHeader("Cache-Control", "no-cache, no-transform");
  res.setHeader("Connection", "keep-alive");
  res.flushHeaders();
  res.write(`event: snapshot\ndata: ${JSON.stringify({ job: publicJob(job) })}\n\n`);
  const unsubscribe = events.subscribe(job.id, (event) => res.write(`event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`));
  const heartbeat = setInterval(() => res.write(": heartbeat\n\n"), 20000);
  req.on("close", () => { clearInterval(heartbeat); unsubscribe(); });
});

app.use(express.static(paths.publicDir, {
  index: "index.html",
  maxAge: 0,
  setHeaders: (res, filePath) => {
    if (/\.(?:html|js|css)$/i.test(filePath)) res.setHeader("Cache-Control", "no-cache, must-revalidate");
  },
}));
app.use((req, res) => {
  if (req.path.startsWith("/api/")) return res.status(404).json({ error: "API yolu bulunamadı" });
  res.sendFile(`${paths.publicDir}/index.html`);
});
app.use((error, req, res, next) => {
  lastRuntimeError = safeMessage(error, 300);
  console.error(`[http] ${req.method} ${req.path}: ${lastRuntimeError}`);
  if (res.headersSent) return next(error);
  res.status(500).json({ error: "Sunucu işlemi tamamlanamadı", detail: process.env.NODE_ENV === "production" ? undefined : lastRuntimeError });
});

const server = app.listen(config.port, "0.0.0.0", () => {
  console.log(`Ünal Sigorta Teklif Ajanı v${VERSION}: http://0.0.0.0:${config.port}`);
  console.log(`${portals.length} portal | İhsan: ${config.maxConcurrency} eşzamanlı, diğer: ${config.genericConcurrency} eşzamanlı | ${config.maxActiveJobs} aktif iş`);
});

async function probeConfiguredPortals() {
  const targets = [...portals];
  let nextIndex = 0;
  // Bu, gerçek sorgu gönderimlerinden farklı, salt okunur bir bağlantı
  // testi olduğu için, sorgu sırasındaki hız sınırı kaygısı olmadan daha
  // yüksek paralellikle çalıştırılıp portal havuzu daha hızlı hazır hale
  // getirilebilir.
  const workers = Array.from({ length: Math.min(config.probeConcurrency, targets.length) }, async () => {
    while (nextIndex < targets.length) {
      const portal = targets[nextIndex];
      nextIndex += 1;
      portalProbes = { ...portalProbes, [portal.id]: { state: "running", message: "Canlı bağlantı test ediliyor", checkedAt: new Date().toISOString() } };
      try {
        if (portal.diagnosticState) {
          portalProbes = { ...portalProbes, [portal.id]: { state: portal.diagnosticState, message: portal.diagnosticMessage, checkedAt: new Date().toISOString() } };
          console.log(`[probe:${portal.id}] ${portal.diagnosticState}`);
          continue;
        }
        const result = conciseProbe(await engine.probePortal(portal, {
          navigationTimeoutMs: portal.navigationTimeoutMs || Math.min(config.navigationTimeoutMs, 20000)
        }));
        portalProbes = { ...portalProbes, [portal.id]: { ...result, checkedAt: new Date().toISOString() } };
        console.log(`[probe:${portal.id}] ${result.state}`);
      } catch (error) {
        const message = safeMessage(error, 240);
        const state = /Timeout/i.test(message) ? "timeout" : "error";
        portalProbes = { ...portalProbes, [portal.id]: { state, message, checkedAt: new Date().toISOString() } };
        console.warn(`[probe:${portal.id}] ${message}`);
      }
    }
  });
  await Promise.all(workers);
}
setTimeout(() => probeConfiguredPortals().catch((error) => {
  lastRuntimeError = `Portal teşhisi: ${safeMessage(error, 240)}`;
}), 1500).unref();
process.on("unhandledRejection", (error) => {
  lastRuntimeError = `Beklenmeyen hata: ${safeMessage(error, 300)}`;
  console.error(lastRuntimeError);
});
for (const signal of ["SIGTERM", "SIGINT"]) {
  process.on(signal, async () => {
    server.close();
    await browserManager.close();
    process.exit(0);
  });
}
