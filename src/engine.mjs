import { mkdir } from "node:fs/promises";
import path from "node:path";
import { getAdapter } from "./adapters/index.mjs";
import { deduplicateOffers } from "./lib/results.mjs";
import { isPortalTerminal, publicJob } from "./lib/store.mjs";
import { RESEND_SENTINEL, safeMessage } from "./lib/validation.mjs";

const SUCCESS_PORTAL_STATES = new Set(["completed", "no_offer", "skipped_sms"]);
const FAILURE_PORTAL_STATES = new Set(["mapping_required", "input_required", "access_blocked", "auth_required", "manual_required", "rate_limited", "timeout", "error", "interrupted"]);

function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function mapLimit(items, limit, callback) {
  let nextIndex = 0;
  const workers = Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (nextIndex < items.length) {
      const current = nextIndex;
      nextIndex += 1;
      await callback(items[current], current);
    }
  });
  await Promise.all(workers);
}

function isRetryable(error) {
  return /Timeout|ERR_CONNECTION|ERR_NETWORK|ECONNRESET|ENETUNREACH|EAI_AGAIN|Target page.*closed/i.test(safeMessage(error));
}

class SmsGate {
  constructor(cooldownMs) {
    this.cooldownMs = cooldownMs;
    this.chain = Promise.resolve(0);
  }

  acquire() {
    const next = this.chain.then(async (lastAt) => {
      const wait = lastAt + this.cooldownMs - Date.now();
      if (wait > 0) await delay(wait);
      return Date.now();
    });
    this.chain = next;
    return next.then(() => {});
  }
}

export class QueryEngine {
  #inputWaiters = new Map();
  #ihsanSmsGate;

  constructor({ store, events, browserManager, portalRegistry, config, paths }) {
    this.store = store;
    this.events = events;
    this.browserManager = browserManager;
    this.portalRegistry = portalRegistry;
    this.config = config;
    this.paths = paths;
    this.lastError = null;
    this.#ihsanSmsGate = new SmsGate(config.ihsanSmsCooldownMs ?? 65000);
  }

  async executeJob(jobId) {
    const job = this.store.getJob(jobId);
    if (!job || job.status !== "queued") return;
    job.status = "running";
    job.startedAt = new Date().toISOString();
    await this.#saveAndPublish(job, "job.started");

    const selected = job.portalIds.map((id) => this.portalRegistry.get(id)).filter(Boolean);
    console.log(`[job:${job.id}] ${selected.length} portal ile başladı`);
    await mapLimit(selected, this.config.maxConcurrency, async (portal) => {
      if (job.cancelRequested) {
        await this.#setPortalState(job, portal, "cancelled", "Sorgu iptal edildi");
        return;
      }
      await this.#executePortal(job, portal);
    });

    job.results = deduplicateOffers(job.results);
    const states = Object.values(job.portalStates || {}).map((state) => state.status);
    if (job.cancelRequested) job.status = "cancelled";
    else if (states.some((state) => FAILURE_PORTAL_STATES.has(state)) && states.some((state) => SUCCESS_PORTAL_STATES.has(state))) job.status = "partial";
    else if (states.length && states.every((state) => FAILURE_PORTAL_STATES.has(state))) job.status = "failed";
    else job.status = "completed";
    job.finishedAt = new Date().toISOString();
    await this.#saveAndPublish(job, "job.finished");
    console.log(`[job:${job.id}] ${job.status}; ${job.results.length} doğrulanmış ham teklif`);
  }

  async handleQueueError(jobId, error) {
    const job = this.store.getJob(jobId);
    this.lastError = safeMessage(error, 300);
    if (!job) return;
    job.status = "failed";
    job.failure = this.lastError;
    job.finishedAt = new Date().toISOString();
    await this.#saveAndPublish(job, "job.failed");
  }

  async probePortal(portal, { navigationTimeoutMs } = {}) {
    const adapter = getAdapter(portal);
    if (typeof adapter.probe !== "function") return { state: "unsupported", message: "Bu adaptörde form teşhisi yok" };
    return this.browserManager.withPortalPage(portal, (page) => adapter.probe({
      page,
      portal,
      navigationTimeoutMs: navigationTimeoutMs || portal.navigationTimeoutMs || this.config.navigationTimeoutMs,
    }));
  }

  async checkPortalSession(portal, { navigationTimeoutMs } = {}) {
    const adapter = getAdapter(portal);
    if (typeof adapter.checkSession !== "function") return { loggedIn: null, message: "Bu portal için oturum kavramı yok" };
    return this.browserManager.withPortalPage(portal, (page) => adapter.checkSession({
      page,
      portal,
      navigationTimeoutMs: navigationTimeoutMs || portal.navigationTimeoutMs || this.config.navigationTimeoutMs,
    }));
  }

  submitOtp(jobId, portalId, code) {
    return this.submitInput(jobId, portalId, "otp", code);
  }

  submitInput(jobId, portalId, inputId, value) {
    const key = `${jobId}:${portalId}:${inputId}`;
    const waiter = this.#inputWaiters.get(key);
    if (!waiter) return false;
    waiter.resolve(value);
    return true;
  }

  requestResend(jobId, portalId) {
    return this.submitInput(jobId, portalId, "otp", RESEND_SENTINEL);
  }

  approvePortal(jobId, portalId) {
    const key = `${jobId}:${portalId}:approval`;
    const waiter = this.#inputWaiters.get(key);
    if (!waiter) return false;
    waiter.resolve();
    return true;
  }

  async cancel(jobId) {
    const job = this.store.getJob(jobId);
    if (!job || ["completed", "partial", "failed", "cancelled", "interrupted"].includes(job.status)) return false;
    job.cancelRequested = true;
    if (job.status !== "queued") job.status = "cancelling";
    for (const [key, waiter] of this.#inputWaiters) {
      if (key.startsWith(`${jobId}:`)) waiter.reject(new Error("Sorgu iptal edildi"));
    }
    await this.#saveAndPublish(job, "job.cancelling");
    return true;
  }

  async markPendingCancelled(jobId) {
    const job = this.store.getJob(jobId);
    if (!job) return;
    job.cancelRequested = true;
    job.status = "cancelled";
    job.finishedAt = new Date().toISOString();
    for (const [portalId, state] of Object.entries(job.portalStates || {})) {
      if (!isPortalTerminal(state.status)) {
        job.portalStates[portalId] = { ...state, status: "cancelled", message: "Sorgu başlamadan iptal edildi", updatedAt: job.finishedAt };
      }
    }
    await this.#saveAndPublish(job, "job.cancelled");
  }

  async #executePortal(job, portal) {
    if (job.mode === "no_sms" && ["per_query", "session_once"].includes(portal.smsPolicy)) {
      await this.#setPortalState(job, portal, "skipped_sms", portal.smsPolicy === "session_once"
        ? "Bu portal oturum doğrulaması için SMS isteyebildiğinden tarayıcı açılmadan atlandı"
        : "Bu portal her teklif sorgusunda SMS doğrulaması istediğinden tarayıcı açılmadan atlandı");
      return;
    }
    const adapter = getAdapter(portal);
    for (let attempt = 0; attempt <= this.config.retryCount; attempt += 1) {
      try {
        const outcome = await this.browserManager.withPortalPage(portal, async (page) => {
          const result = await adapter.run({
            page,
            portal,
            job,
            navigationTimeoutMs: portal.navigationTimeoutMs || this.config.navigationTimeoutMs,
            resultTimeoutMs: portal.resultTimeoutMs || this.config.resultTimeoutMs,
            historyLookupDelayMs: this.config.historyLookupDelayMs,
            isCancelled: () => Boolean(job.cancelRequested),
            setState: (status, message, extra = {}) => this.#setPortalState(job, portal, status, message, { attempt: attempt + 1, ...extra }),
            requestOtp: () => this.#waitForInput(job, portal, {
              inputId: "otp",
              status: "waiting_otp",
              message: `${job.phone} numarasına gelen SMS kodu bekleniyor`,
            }),
            requestField: (label, inputId = label, choices = null) => this.#waitForInput(job, portal, {
              inputId,
              status: "waiting_input",
              message: `"${label}" bilgisi panelden bekleniyor`,
              extra: { inputLabel: label, ...(choices?.length ? { inputChoices: choices } : {}) },
            }),
            requestSmsSlot: (portal.adapter === "ihsan" || portal.adapter === "ihsan-frame")
              ? () => this.#ihsanSmsGate.acquire()
              : undefined,
          });
          if (result.status && FAILURE_PORTAL_STATES.has(result.status)) {
            result.screenshotPath = await this.#captureScreenshot(page, job.id, portal.id);
          }
          return result;
        });
        if (outcome.offers?.length) job.results.push(...outcome.offers);
        if (FAILURE_PORTAL_STATES.has(outcome.status)) {
          await this.#waitForApproval(job, portal, outcome);
        }
        await this.#setPortalState(job, portal, outcome.status, outcome.message, {
          offerCount: outcome.offers?.length || 0,
          attempt: attempt + 1,
          ...(outcome.diagnostics ? { diagnostics: outcome.diagnostics } : {}),
          ...(outcome.screenshotPath ? { hasScreenshot: true } : {}),
        });
        return;
      } catch (error) {
        const message = safeMessage(error);
        this.lastError = `${portal.name}: ${message}`;
        console.error(`[job:${job.id}][portal:${portal.id}] deneme ${attempt + 1}: ${message}`);
        if (job.cancelRequested) {
          await this.#setPortalState(job, portal, "cancelled", "Sorgu iptal edildi");
          return;
        }
        if (attempt < this.config.retryCount && isRetryable(error)) {
          await this.#setPortalState(job, portal, "retrying", `Geçici bağlantı hatası; ${attempt + 2}. deneme hazırlanıyor`, { attempt: attempt + 1 });
          await delay(1200 * (attempt + 1));
          continue;
        }
        const status = /Timeout/i.test(message) ? "timeout" : "error";
        await this.#setPortalState(job, portal, status, message, { attempt: attempt + 1 });
        return;
      }
    }
  }

  #waitForInput(job, portal, { inputId, status, message, extra = {} }) {
    const key = `${job.id}:${portal.id}:${inputId}`;
    return new Promise(async (resolve, reject) => {
      const timeout = setTimeout(() => {
        this.#inputWaiters.delete(key);
        reject(new Error(`${inputId} zaman aşımına uğradı`));
      }, this.config.otpTimeoutMs);
      this.#inputWaiters.set(key, {
        resolve: (value) => {
          clearTimeout(timeout);
          this.#inputWaiters.delete(key);
          resolve(value);
        },
        reject: (error) => {
          clearTimeout(timeout);
          this.#inputWaiters.delete(key);
          reject(error);
        },
      });
      await this.#setPortalState(job, portal, status, message, { inputId, ...extra });
    });
  }

  async #captureScreenshot(page, jobId, portalId) {
    if (!this.paths?.screenshotsDir) return false;
    try {
      await mkdir(this.paths.screenshotsDir, { recursive: true, mode: 0o700 });
      const file = path.join(this.paths.screenshotsDir, `${jobId}-${portalId}.jpg`);
      await page.screenshot({ path: file, type: "jpeg", quality: 65, timeout: 5000 });
      return true;
    } catch {
      return false;
    }
  }

  #waitForApproval(job, portal, outcome) {
    const key = `${job.id}:${portal.id}:approval`;
    return new Promise(async (resolve) => {
      const timeout = setTimeout(() => {
        this.#inputWaiters.delete(key);
        resolve();
      }, this.config.approvalTimeoutMs);
      this.#inputWaiters.set(key, {
        resolve: () => {
          clearTimeout(timeout);
          this.#inputWaiters.delete(key);
          resolve();
        },
        reject: () => {
          clearTimeout(timeout);
          this.#inputWaiters.delete(key);
          resolve();
        },
      });
      await this.#setPortalState(job, portal, "waiting_approval", `${portal.name} bu sonuçla bitti: "${outcome.message}". Sıradaki portala geçmek için onayınız bekleniyor.`, {
        pendingStatus: outcome.status,
        pendingMessage: outcome.message,
        ...(outcome.screenshotPath ? { hasScreenshot: true } : {}),
      });
    });
  }

  async #setPortalState(job, portal, status, message, extra = {}) {
    job.portalStates[portal.id] = {
      ...job.portalStates[portal.id],
      portalId: portal.id,
      portalName: portal.name,
      status,
      message,
      ...extra,
      updatedAt: new Date().toISOString(),
    };
    await this.#saveAndPublish(job, "portal.updated", { portalId: portal.id });
  }

  async #saveAndPublish(job, type, payload = {}) {
    await this.store.saveJob(job);
    this.events.publish(job.id, type, { ...payload, job: publicJob(job) });
  }
}
