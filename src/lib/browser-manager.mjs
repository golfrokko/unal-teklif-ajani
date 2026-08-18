import { chromium } from "playwright";
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import path from "node:path";

export class BrowserManager {
  #browser = null;
  #browserPromise = null;
  #activeContexts = new Set();

  constructor({ sessionsDir, headless = true }) {
    this.sessionsDir = sessionsDir;
    this.headless = headless;
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
    const storageState = await this.#readSession(sessionFile);
    const context = await browser.newContext({
      ...(storageState ? { storageState } : {}),
      viewport: { width: 1440, height: 1000 },
      locale: "tr-TR",
      timezoneId: "Europe/Istanbul",
      userAgent: "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0 Safari/537.36",
    });
    this.#activeContexts.add(context);
    const page = await context.newPage();
    try {
      return await callback(page, context);
    } finally {
      await this.#saveSession(context, sessionFile).catch((error) => {
        console.warn(`[browser:${portal.id}] Oturum kaydedilemedi: ${error.message}`);
      });
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
