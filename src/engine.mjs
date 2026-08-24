import { mkdir } from "node:fs/promises";
import path from "node:path";
import { getAdapter } from "./adapters/index.mjs";
import { deduplicateOffers } from "./lib/results.mjs";
import { isPortalTerminal, publicJob } from "./lib/store.mjs";
import { RESEND_SENTINEL, safeMessage } from "./lib/validation.mjs";

const SUCCESS_PORTAL_STATES = new Set(["completed", "no_offer", "skipped_sms"]);
const FAILURE_PORTAL_STATES = new Set(["mapping_required", "input_required", "access_blocked", "auth_required", "manual_required", "rate_limited", "timeout", "error", "interrupted"]);
// Kullanıcı talebi: her aşamada canlı ekran gösterilip "Devam Et" onayı
// beklensin. Adaptörler zaten yalnız bu dört durumla ilerleme bildiriyor
// (bkz. src/adapters/**/*.mjs içindeki tüm setState/track çağrıları);
// waiting_otp/waiting_captcha/waiting_input gibi durumların zaten kendi
// bekleme mekanizması var, burada tekrar beklenmiyor.
const STEP_GATE_STATUSES = new Set(["opening", "filling", "submitted", "collecting"]);

function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
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
  #livePages = new Map();
  #ihsanSmsGate;
  // "Oturum Aç": sorgu öncesinde, kullanıcının bir portala kendi elleriyle
  // (kalıcı olarak) giriş yapmasını sağlayan canlı oturum akışı. Job'a bağlı
  // değildir; portalId ile anahtarlanır. #openSessionPages canlı Playwright
  // Page referanslarını, #openSessionWaiters "bitti" sinyalini bekleyen
  // resolve fonksiyonlarını, #openSessionStatus ise panelin gösterdiği
  // durum metnini tutar.
  #openSessionPages = new Map();
  #openSessionWaiters = new Map();
  #openSessionStatus = new Map();

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
    // Kullanıcı talebi: portallar artık eşzamanlı değil, sırayla (biri
    // bitmeden diğeri başlamadan) çalıştırılıyor; her aşamada canlı ekran
    // gösterilip kullanıcının "Devam Et" demesi bekleniyor (bkz.
    // #executePortal içindeki setState sarmalayıcısı ve #waitForStepContinue).
    for (const portal of selected) {
      if (job.cancelRequested) {
        await this.#setPortalState(job, portal, "cancelled", "Sorgu iptal edildi");
        continue;
      }
      await this.#executePortal(job, portal);
    }

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
    return this.browserManager.withPortalPage(portal, async (page) => {
      try {
        return await adapter.probe({
          page,
          portal,
          navigationTimeoutMs: navigationTimeoutMs || portal.navigationTimeoutMs || this.config.navigationTimeoutMs,
        });
      } catch (error) {
        // Sayfa hâlâ açıkken (ör. CAPTCHA/güvenlik engeli görünürken) ekran
        // görüntüsü alınabiliyorsa portal havuzunda teşhis için gösterilir.
        const message = safeMessage(error, 240);
        const hasScreenshot = await this.#captureScreenshot(page, "probe", portal.id);
        return { state: /Timeout/i.test(message) ? "timeout" : "error", message, hasScreenshot };
      }
    });
  }

  async checkPortalSession(portal, { navigationTimeoutMs } = {}) {
    const adapter = getAdapter(portal);
    if (typeof adapter.checkSession !== "function") return { loggedIn: null, message: "Bu portal için oturum kavramı yok" };
    return this.browserManager.withPortalPage(portal, async (page) => {
      try {
        return await adapter.checkSession({
          page,
          portal,
          navigationTimeoutMs: navigationTimeoutMs || portal.navigationTimeoutMs || this.config.navigationTimeoutMs,
        });
      } catch (error) {
        const hasScreenshot = await this.#captureScreenshot(page, "session", portal.id);
        return { loggedIn: null, message: safeMessage(error, 200), hasScreenshot };
      }
    });
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

  // CAPTCHA'yı biz çözmeyiz; kullanıcı panelden gerçek zamanlı ekran
  // görüntüsüne bakıp aynı tarayıcı sayfasına tıklayarak kendisi çözer.
  // Bu üç metod o canlı etkileşimi taşır.
  resumeCaptcha(jobId, portalId) {
    const key = `${jobId}:${portalId}:captcha`;
    const waiter = this.#inputWaiters.get(key);
    if (!waiter) return false;
    waiter.resolve();
    return true;
  }

  // Her aşamada gösterilen canlı ekrandan "Devam Et" ile bir sonraki adıma
  // geçişi tetikler (bkz. #waitForStepContinue).
  continueStep(jobId, portalId) {
    const key = `${jobId}:${portalId}:step`;
    const waiter = this.#inputWaiters.get(key);
    if (!waiter) return false;
    waiter.resolve();
    return true;
  }

  async clickLivePage(jobId, portalId, x, y) {
    const page = this.#livePages.get(`${jobId}:${portalId}`);
    if (!page) return false;
    await page.mouse.click(x, y).catch(() => {});
    return true;
  }

  async screenshotLivePage(jobId, portalId) {
    const page = this.#livePages.get(`${jobId}:${portalId}`);
    if (!page) return null;
    return page.screenshot({ type: "jpeg", quality: 60, timeout: 4000 }).catch(() => null);
  }

  // "Oturum Aç": bu, checkPortalSession/probePortal gibi salt okunur ve kısa
  // ömürlü değil; kullanıcı "bitti" demeden kapanmayan, kalıcı giriş yapmayı
  // amaçlayan CANLI bir tarayıcı sayfası açar. browserManager.withPortalPage
  // zaten callback dönünce (portal.fresh olmadığı sürece) storageState'i
  // diske kaydediyor; biz de callback'i kullanıcı "bitti" deyip
  // finishPortalSession çağırana kadar bekleterek bu mekanizmayı olduğu gibi
  // kullanıyoruz — ayrı bir oturum kaydetme kodu yazmaya gerek yok.
  startPortalSession(portalId) {
    const portal = this.portalRegistry.get(portalId);
    if (!portal) return { error: "Portal bulunamadı" };
    if (this.#openSessionWaiters.has(portalId)) return { error: "Bu portal için oturum açma zaten çalışıyor" };
    const statusEntry = { status: "opening", message: "Portal açılıyor…", startedAt: new Date().toISOString() };
    this.#openSessionStatus.set(portalId, statusEntry);
    this.browserManager.withPortalPage(portal, async (page) => {
      await page.goto(portal.url, { waitUntil: "domcontentloaded", timeout: this.config.navigationTimeoutMs });
      this.#openSessionPages.set(portalId, page);
      statusEntry.status = "ready";
      statusEntry.message = "Sağ üstten hesabınıza giriş yapın; bittiğinde \"Bu portalı bitir\"e basın";
      await new Promise((resolve) => this.#openSessionWaiters.set(portalId, resolve));
      statusEntry.status = "saving";
      statusEntry.message = "Oturum kaydediliyor…";
    }).then(() => {
      statusEntry.status = "closed";
      statusEntry.message = "Oturum kaydedildi";
    }).catch((error) => {
      statusEntry.status = "error";
      statusEntry.message = safeMessage(error, 200);
    }).finally(() => {
      this.#openSessionPages.delete(portalId);
      this.#openSessionWaiters.delete(portalId);
    });
    return { ok: true };
  }

  getPortalSessionStatus(portalId) {
    return this.#openSessionStatus.get(portalId) || null;
  }

  finishPortalSession(portalId) {
    const resolve = this.#openSessionWaiters.get(portalId);
    if (!resolve) return false;
    resolve();
    return true;
  }

  async clickPortalSession(portalId, x, y) {
    const page = this.#openSessionPages.get(portalId);
    if (!page) return false;
    await page.mouse.click(x, y).catch(() => {});
    return true;
  }

  async typePortalSession(portalId, text) {
    const page = this.#openSessionPages.get(portalId);
    if (!page) return false;
    await page.keyboard.type(text, { delay: 25 }).catch(() => {});
    return true;
  }

  async pressKeyPortalSession(portalId, key) {
    const page = this.#openSessionPages.get(portalId);
    if (!page) return false;
    await page.keyboard.press(key).catch(() => {});
    return true;
  }

  async screenshotPortalSession(portalId) {
    const page = this.#openSessionPages.get(portalId);
    if (!page) return null;
    return page.screenshot({ type: "jpeg", quality: 60, timeout: 4000 }).catch(() => null);
  }

  async cancel(jobId) {
    const job = this.store.getJob(jobId);
    if (!job || ["completed", "partial", "failed", "cancelled", "interrupted"].includes(job.status)) return false;
    job.cancelRequested = true;
    if (job.status !== "queued") job.status = "cancelling";
    for (const [key, waiter] of this.#inputWaiters) {
      if (key.startsWith(`${jobId}:`)) waiter.reject(new Error("Sorgu iptal edildi"));
    }
    for (const key of this.#livePages.keys()) {
      if (key.startsWith(`${jobId}:`)) this.#livePages.delete(key);
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
            setState: async (status, message, extra = {}) => {
              await this.#setPortalState(job, portal, status, message, { attempt: attempt + 1, ...extra });
              if (STEP_GATE_STATUSES.has(status) && !job.cancelRequested) {
                await this.#waitForStepContinue(job, portal, page, status, message);
              }
            },
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
            requestCaptchaSolve: () => this.#waitForCaptcha(job, portal, page),
            requestCaptchaCode: (imageDataUrl) => this.#waitForInput(job, portal, {
              inputId: "captcha_code",
              status: "waiting_input",
              message: `${portal.name} resim güvenlik kodunu bekliyor`,
              extra: { inputLabel: "Güvenlik kodu", inputKind: "image_captcha", captchaImage: imageDataUrl },
            }),
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

  #waitForCaptcha(job, portal, page) {
    const key = `${job.id}:${portal.id}:captcha`;
    const pageKey = `${job.id}:${portal.id}`;
    return new Promise(async (resolve) => {
      const timeout = setTimeout(() => {
        this.#inputWaiters.delete(key);
        this.#livePages.delete(pageKey);
        resolve();
      }, this.config.approvalTimeoutMs);
      this.#inputWaiters.set(key, {
        resolve: () => {
          clearTimeout(timeout);
          this.#inputWaiters.delete(key);
          this.#livePages.delete(pageKey);
          resolve();
        },
        reject: () => {
          clearTimeout(timeout);
          this.#inputWaiters.delete(key);
          this.#livePages.delete(pageKey);
          resolve();
        },
      });
      this.#livePages.set(pageKey, page);
      await this.#setPortalState(job, portal, "waiting_captcha", `${portal.name} güvenlik kontrolü (CAPTCHA) gösteriyor; panelden canlı ekrana tıklayıp kendiniz çözün, sonra devam edin`);
    });
  }

  // Kullanıcı talebi: "site site ilerleyelim, her aşamada ekran ver, devam
  // et'i ben uygulayayım". Adaptör her aşama geçişinde (opening/filling/
  // submitted/collecting) setState çağırdığında burada duraklatılıp canlı
  // ekran gösteriliyor; kullanıcı panelden "Devam Et" demeden bir sonraki
  // adıma geçilmiyor. approvalTimeoutMs yalnız terk edilmiş bir işi süresiz
  // kilitlememek için güvenlik ağı; normal akışta kullanıcının kendi hızı
  // belirleyici.
  #waitForStepContinue(job, portal, page, stageStatus, stageMessage) {
    const key = `${job.id}:${portal.id}:step`;
    const pageKey = `${job.id}:${portal.id}`;
    return new Promise(async (resolve) => {
      const timeout = setTimeout(() => {
        this.#inputWaiters.delete(key);
        this.#livePages.delete(pageKey);
        resolve();
      }, this.config.approvalTimeoutMs);
      this.#inputWaiters.set(key, {
        resolve: () => {
          clearTimeout(timeout);
          this.#inputWaiters.delete(key);
          this.#livePages.delete(pageKey);
          resolve();
        },
        reject: () => {
          clearTimeout(timeout);
          this.#inputWaiters.delete(key);
          this.#livePages.delete(pageKey);
          resolve();
        },
      });
      this.#livePages.set(pageKey, page);
      await this.#setPortalState(job, portal, "awaiting_continue", `${stageMessage} — devam etmek için "Devam Et"e basın`, {
        pendingStatus: stageStatus,
        pendingMessage: stageMessage,
      });
    });
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
