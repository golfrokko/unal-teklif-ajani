import express from "express";
import { randomUUID, timingSafeEqual } from "node:crypto";
import { config, paths } from "./config.mjs";
import { portals } from "./portals.mjs";
import { BrowserManager } from "./lib/browser-manager.mjs";
import { JobEvents } from "./lib/events.mjs";
import { JobQueue } from "./lib/queue.mjs";
import { FileStore, publicJob } from "./lib/store.mjs";
import { normalizeOtp, normalizePhone, safeMessage, validateJobInput } from "./lib/validation.mjs";
import { QueryEngine } from "./engine.mjs";

const VERSION = "1.1.3";
const portalRegistry = new Map(portals.map((portal) => [portal.id, Object.freeze({ ...portal })]));
const store = new FileStore({ jobsDir: paths.jobsDir, settingsFile: paths.settingsFile, retentionDays: config.retentionDays });
const events = new JobEvents();
const browserManager = new BrowserManager({ sessionsDir: paths.sessionsDir, headless: config.headless });
await Promise.all([store.init(), browserManager.init()]);
let portalSettings = await store.getPortalSettings();
let lastRuntimeError = null;
let portalProbes = {};

function portalView(portal) {
  const setting = portalSettings[portal.id] || {};
  return {
    ...portal,
    enabled: typeof setting.enabled === "boolean" ? setting.enabled : portal.defaultEnabled === true,
    integrationStatus: setting.integrationStatus || portal.integrationStatus || (portal.verifiedForm ? "configured_unverified" : "discovery"),
    lastVerifiedAt: setting.lastVerifiedAt || null,
    note: setting.note || "",
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

const engine = new QueryEngine({ store, events, browserManager, portalRegistry, config });
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
  queue: queue.stats,
  browser: { state: browserManager.state, activeContexts: browserManager.activeContextCount },
  portalProbes,
  lastRuntimeError: lastRuntimeError || engine.lastError || browserManager.lastError,
  panelAuthConfigured: Boolean(config.panelUser && config.panelPassword),
}));

app.get(["/api/v1/system", "/api/system"], (req, res) => res.json({
  version: VERSION,
  queue: queue.stats,
  browser: { state: browserManager.state, activeContexts: browserManager.activeContextCount },
  retentionDays: config.retentionDays,
  maxConcurrency: config.maxConcurrency,
  safety: { captchaBypass: false, smsBypass: false, authorizedUseOnly: true },
}));

app.get(["/api/v1/portals", "/api/portals"], (req, res) => res.json({ portals: portals.map(portalView), maxConcurrency: config.maxConcurrency }));
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

app.get(["/api/v1/jobs", "/api/jobs"], (req, res) => res.json({ jobs: store.listJobs(30).map(publicJob), queue: queue.stats }));
app.get(["/api/v1/jobs/:id", "/api/jobs/:id"], (req, res) => {
  const job = store.getJob(req.params.id);
  if (!job) return res.status(404).json({ error: "Sorgu bulunamadı" });
  res.json(publicJob(job));
});

async function createJob(req, res, next) {
  try {
    const validated = validateJobInput(req.body, config.defaultPhone);
    if (validated.error) return res.status(400).json({ error: validated.error });
    const requested = Array.isArray(req.body?.portalIds) ? new Set(req.body.portalIds) : new Set(portals.map((portal) => portal.id));
    const selected = portals.filter((portal) => requested.has(portal.id) && portalView(portal).enabled);
    if (!selected.length) return res.status(400).json({ error: "Etkin en az bir portal seçilmelidir" });
    if (selected.some((portal) => ["ihsan", "ihsan-frame"].includes(portal.adapter))) {
      if (!validated.value.vehicle.registration) return res.status(400).json({ error: "İhsan altyapılı sorgular için ruhsat seri numarası zorunludur" });
      if (validated.value.vehicle.identity.length === 11 && !/^\d{1,2}[./-]\d{1,2}[./-]\d{4}$/.test(validated.value.vehicle.birthDate)) {
        return res.status(400).json({ error: "İhsan altyapılı sorgular için doğum tarihi GG.AA.YYYY biçiminde zorunludur" });
      }
    }
    const now = new Date().toISOString();
    const job = {
      id: randomUUID(), createdAt: now, updatedAt: now, startedAt: null, finishedAt: null, status: "queued",
      ...validated.value,
      portalIds: selected.map((portal) => portal.id),
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

app.post("/api/v1/jobs/:id/cancel", async (req, res, next) => {
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

app.use(express.static(paths.publicDir, { index: "index.html", maxAge: "5m" }));
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
  console.log(`${portals.length} portal | ${config.maxConcurrency} portal/iş | ${config.maxActiveJobs} aktif iş`);
});

async function probeConfiguredPortals() {
  const targets = portals.filter((portal) => portal.defaultEnabled && ["ihsan", "ihsan-frame"].includes(portal.adapter));
  for (const portal of targets) {
    portalProbes = { ...portalProbes, [portal.id]: { state: "running", checkedAt: new Date().toISOString() } };
    try {
      const result = await engine.probePortal(portal);
      portalProbes = { ...portalProbes, [portal.id]: { ...result, checkedAt: new Date().toISOString() } };
      console.log(`[probe:${portal.id}] ${result.state}`);
    } catch (error) {
      const message = safeMessage(error, 240);
      portalProbes = { ...portalProbes, [portal.id]: { state: "error", message, checkedAt: new Date().toISOString() } };
      console.warn(`[probe:${portal.id}] ${message}`);
    }
  }
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
