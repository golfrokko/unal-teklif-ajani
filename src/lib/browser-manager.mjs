import { chromium } from "playwright";
import { mkdir, readFile, rename, unlink, writeFile } from "node:fs/promises";
import path from "node:path";

export class BrowserManager {
  #browser = null;
  #browserPromise = null;
  #activeContexts = new Set();

  constructor({ sessionsDir, headless = true, pageZoom = 1 }) {
    this.sessionsDir = sessionsDir;
    this.headless = headless;
    this.pageZoom = pageZoom;
    this.lastError = null;
  }

  get state() {
    if (this.#browser?.isConnected()) return "ready";
    if (this.#browserPromise) return "starting";
    return "idle";
  }

  get activeContextCount() {
    return this.#activeContexts.size;
  }

  async init() {
    await mkdir(this.sessionsDir, { recursive: true, mode: 0o700 });
  }

  async resetSessions(portalIds) {
    const reset = [];
    for (const portalId of portalIds) {
      try {
        await unlink(path.join(this.sessionsDir, `${portalId}.json`));
        reset.push(portalId);
      } catch (error) {
        if (error.code !== "ENOENT") throw error;
      }
    }
    return reset;
  }

  async getBrowser() {
    if (this.#browser?.isConnected()) return this.#browser;
    if (this.#browserPromise) return this.#browserPromise;
    this.#browserPromise = chromium.launch({
      headless: this.headless,
      args: ["--no-sandbox", "--disable-dev-shm-usage", "--disable-gpu", "--disable-session-crashed-bubble"],
    }).then((browser) => {
      this.#browser = browser;
      this.lastError = null;
      browser.on("disconnected", () => {
        this.#browser = null;
        this.#activeContexts.clear();
        console.warn("[browser] Chromium kapandı; gerektiğinde yeniden başlatılacak");
      });
      return browser;
    }).catch((error) => {
      this.lastError = `Chromium başlatılamadı: ${error.message}`;
      throw error;
    }).finally(() => {
      this.#browserPromise = null;
    });
    return this.#browserPromise;
  }

  async withPortalPage(portal, callback) {
    const browser = await this.getBrowser();
    const sessionFile = path.join(this.sessionsDir, `${portal.id}.json`);
    // portal.fresh: bazı sitelerin (ör. SigortaBin) önbellek/oturum durumu
    // ardışık sorguları birbirine karıştırıyor; bu portallar için kayıtlı
    // oturum hiç okunmaz/yazılmaz, her sorgu tamamen temiz bir bağlamda açılır.
    const storageState = portal.fresh ? null : await this.#readSession(sessionFile);
    const context = await browser.newContext({
      ...(storageState ? { storageState } : {}),
      viewport: { width: 1440, height: 1000 },
      locale: "tr-TR",
      timezoneId: "Europe/Istanbul",
      userAgent: "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0 Safari/537.36",
    });
    await this.#applyPageZoom(context);
    this.#activeContexts.add(context);
    const page = await context.newPage();
    try {
      return await callback(page, context);
    } finally {
      if (!portal.fresh) {
        await this.#saveSession(context, sessionFile).catch((error) => {
          console.warn(`[browser:${portal.id}] Oturum kaydedilemedi: ${error.message}`);
        });
      }
      this.#activeContexts.delete(context);
      await context.close().catch(() => {});
    }
  }

  async close() {
    for (const context of this.#activeContexts) await context.close().catch(() => {});
    this.#activeContexts.clear();
    await this.#browser?.close().catch(() => {});
    this.#browser = null;
  }

  // Sayfayı CSS zoom ile küçültür. Medya sorgusu genişliğini (window.innerWidth)
  // değiştirmediğinden site masaüstü yerleşiminde kalır, yalnız her şey
  // küçülüp viewport'a sığar; böylece dar ekranda üst üste binen yazılar
  // ayrışır. Playwright tıklama koordinatları zoom'u hesaba kattığından
  // otomasyon davranışı bozulmaz (gerçek tarayıcıda doğrulandı).
  async #applyPageZoom(context) {
    if (!(this.pageZoom > 0) || this.pageZoom === 1) return;
    await context.addInitScript((zoom) => {
      const apply = () => {
        if (document.documentElement) document.documentElement.style.zoom = String(zoom);
      };
      apply();
      document.addEventListener("DOMContentLoaded", apply);
    }, this.pageZoom).catch(() => {});
  }

  async #readSession(file) {
    try {
      return JSON.parse(await readFile(file, "utf8"));
    } catch {
      return null;
    }
  }

  async #saveSession(context, file) {
    const state = await context.storageState();
    const temporary = `${file}.tmp`;
    await writeFile(temporary, JSON.stringify(state), { encoding: "utf8", mode: 0o600 });
    await rename(temporary, file);
  }
}
