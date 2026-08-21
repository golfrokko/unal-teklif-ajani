import { getAdapter } from "./adapters/index.mjs";
import { deduplicateOffers } from "./lib/results.mjs";
import { isPortalTerminal, publicJob } from "./lib/store.mjs";
import { safeMessage } from "./lib/validation.mjs";

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

export class QueryEngine {
  #otpWaiters = new Map();

  constructor({ store, events, browserManager, portalRegistry, config }) {
    this.store = store;
    this.events = events;
    this.browserManager = browserManager;
    this.portalRegistry = portalRegistry;
    this.config = config;
    this.lastError = null;
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

  async probePortal(portal) {
    const adapter = getAdapter(portal);
    if (typeof adapter.probe !== "function") return { state: "unsupported", message: "Bu adaptörde form teşhisi yok" };
    return this.browserManager.withPortalPage(portal, (page) => adapter.probe({
      page,
      portal,
      navigationTimeoutMs: portal.navigationTimeoutMs || this.config.navigationTimeoutMs,
    }));
  }

  submitOtp(jobId, portalId, code) {
    const key = `${jobId}:${portalId}`;
    const waiter = this.#otpWaiters.get(key);
    if (!waiter) return false;
    waiter.resolve(code);
    return true;
  }

  async cancel(jobId) {
    const job = this.store.getJob(jobId);
    if (!job || ["completed", "partial", "failed", "cancelled", "interrupted"].includes(job.status)) return false;
    job.cancelRequested = true;
    if (job.status !== "queued") job.status = "cancelling";
    for (const [key, waiter] of this.#otpWaiters) {
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
        const outcome = await this.browserManager.withPortalPage(portal, (page) => adapter.run({
          page,
          portal,
          job,
          navigationTimeoutMs: portal.navigationTimeoutMs || this.config.navigationTimeoutMs,
          resultTimeoutMs: portal.resultTimeoutMs || this.config.resultTimeoutMs,
          isCancelled: () => Boolean(job.cancelRequested),
          setState: (status, message, extra = {}) => this.#setPortalState(job, portal, status, message, { attempt: attempt + 1, ...extra }),
          requestOtp: () => this.#waitForOtp(job, portal),
        }));
        if (outcome.offers?.length) job.results.push(...outcome.offers);
        await this.#setPortalState(job, portal, outcome.status, outcome.message, {
          offerCount: outcome.offers?.length || 0,
          attempt: attempt + 1,
          ...(outcome.diagnostics ? { diagnostics: outcome.diagnostics } : {}),
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

  #waitForOtp(job, portal) {
    const key = `${job.id}:${portal.id}`;
    return new Promise(async (resolve, reject) => {
      const timeout = setTimeout(() => {
        this.#otpWaiters.delete(key);
        reject(new Error("SMS kodu zaman aşımına uğradı"));
      }, this.config.otpTimeoutMs);
      this.#otpWaiters.set(key, {
        resolve: (code) => {
          clearTimeout(timeout);
          this.#otpWaiters.delete(key);
          resolve(code);
        },
        reject: (error) => {
          clearTimeout(timeout);
          this.#otpWaiters.delete(key);
          reject(error);
        },
      });
      await this.#setPortalState(job, portal, "waiting_otp", `${job.phone} numarasına gelen SMS kodu bekleniyor`);
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
