import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { QueryEngine } from "../src/engine.mjs";
import { portals } from "../src/portals.mjs";

// koalay basit FormPortalAdapter kullanıyor; probe() page.goto çağırıp
// hata fırlatınca engine.probePortal bunu yakalayıp sayfa hâlâ açıkken
// ekran görüntüsü almalı (CAPTCHA/erişim engeli gibi durumlarda portal
// havuzunda teşhis için gösterilecek). Sahte page.screenshot() diske
// yazmıyor, yalnız çağrıldığını ve doğru dosya yoluyla çağrıldığını kaydediyor.
const koalay = portals.find((portal) => portal.id === "koalay");

test("probePortal, adaptör hata fırlattığında ekran görüntüsü alır", async () => {
  const dataDir = await mkdtemp(path.join(tmpdir(), "probe-screenshot-"));
  const screenshotCalls = [];
  const engine = new QueryEngine({
    store: {},
    events: { emit() {} },
    browserManager: {
      withPortalPage: (portal, callback) => callback({
        goto: async () => { throw new Error("page.goto: Timeout 1000ms exceeded"); },
        screenshot: async (options) => { screenshotCalls.push(options); },
      }),
    },
    portalRegistry: new Map(),
    config: {},
    paths: { screenshotsDir: path.join(dataDir, "screenshots") },
  });

  const result = await engine.probePortal(koalay, { navigationTimeoutMs: 1000 });
  await rm(dataDir, { recursive: true, force: true });
  assert.equal(result.state, "timeout");
  assert.equal(result.hasScreenshot, true);
  assert.equal(screenshotCalls.length, 1);
  assert.equal(screenshotCalls[0].path, path.join(dataDir, "screenshots", `probe-${koalay.id}.jpg`));
});

test("checkPortalSession, adaptör hata fırlattığında ekran görüntüsü alır", async () => {
  const dataDir = await mkdtemp(path.join(tmpdir(), "session-screenshot-"));
  const screenshotCalls = [];
  const lion = portals.find((portal) => portal.id === "lion");
  const engine = new QueryEngine({
    store: {},
    events: { emit() {} },
    browserManager: {
      withPortalPage: (portal, callback) => callback({
        goto: async () => { throw new Error("Bağlantı koptu"); },
        screenshot: async (options) => { screenshotCalls.push(options); },
      }),
    },
    portalRegistry: new Map(),
    config: {},
    paths: { screenshotsDir: path.join(dataDir, "screenshots") },
  });

  const result = await engine.checkPortalSession(lion, { navigationTimeoutMs: 1000 });
  await rm(dataDir, { recursive: true, force: true });
  assert.equal(result.loggedIn, null);
  assert.equal(result.hasScreenshot, true);
  assert.equal(screenshotCalls.length, 1);
  assert.equal(screenshotCalls[0].path, path.join(dataDir, "screenshots", `session-${lion.id}.jpg`));
});

test("canlı sorgu istisnası sayfa kapanmadan ekran görüntüsü alır ve duruma işler", async () => {
  const dataDir = await mkdtemp(path.join(tmpdir(), "job-screenshot-"));
  const screenshotCalls = [];
  const now = new Date().toISOString();
  const job = {
    id: "job-screen-1",
    createdAt: now,
    updatedAt: now,
    status: "queued",
    mode: "ask_sms",
    phone: "05454012962",
    vehicle: {},
    portalIds: [koalay.id],
    portalStates: { [koalay.id]: { portalId: koalay.id, portalName: koalay.name, status: "queued" } },
    results: [],
  };
  const engine = new QueryEngine({
    store: {
      getJob: () => job,
      saveJob: async () => {},
    },
    events: { publish() {} },
    browserManager: {
      withPortalPage: (portal, callback) => callback({
        goto: async () => { throw new Error("page.goto: Timeout 1000ms exceeded"); },
        screenshot: async (options) => { screenshotCalls.push(options); },
      }),
    },
    portalRegistry: new Map([[koalay.id, koalay]]),
    config: {
      retryCount: 0,
      maxConcurrency: 1,
      genericConcurrency: 1,
      navigationTimeoutMs: 1000,
      resultTimeoutMs: 1000,
    },
    paths: { screenshotsDir: path.join(dataDir, "screenshots") },
  });

  await engine.executeJob(job.id);
  await rm(dataDir, { recursive: true, force: true });
  assert.equal(job.status, "failed");
  assert.equal(job.portalStates[koalay.id].status, "timeout");
  assert.equal(job.portalStates[koalay.id].hasScreenshot, true);
  assert.equal(screenshotCalls.length, 1);
  assert.equal(screenshotCalls[0].path, path.join(dataDir, "screenshots", `${job.id}-${koalay.id}.jpg`));
});
