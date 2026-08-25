import test from "node:test";
import assert from "node:assert/strict";
import supersigortam, { SuperSigortamAdapter } from "../src/adapters/sites/supersigortam.mjs";
import enuygun, { EnuygunAdapter } from "../src/adapters/sites/enuygun.mjs";
import sigortayeri, { SigortaYeriAdapter } from "../src/adapters/sites/sigortayeri.mjs";
import sigortambir, { SigortambirAdapter } from "../src/adapters/sites/sigortambir.mjs";
import { portals } from "../src/portals.mjs";
import { config } from "../src/config.mjs";

test("özel portal akışları genel adaptör yerine kendi sınıflarını kullanır", () => {
  assert.ok(supersigortam instanceof SuperSigortamAdapter);
  assert.ok(enuygun instanceof EnuygunAdapter);
  assert.ok(sigortayeri instanceof SigortaYeriAdapter);
  assert.ok(sigortambir instanceof SigortambirAdapter);
});

test("SüperSigortam ve Sigortambir uzun sonuç pencerelerini korur", () => {
  assert.equal(portals.find((portal) => portal.id === "supersigortam").resultTimeoutMs, 150000);
  assert.equal(portals.find((portal) => portal.id === "sigortambir").offerCollectionWindowMs, 60000);
});

test("portal hataları kapanmadan önce 30 saniye beklenir", () => {
  assert.equal(config.failureGraceMs, 30000);
});
