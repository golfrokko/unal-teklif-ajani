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
