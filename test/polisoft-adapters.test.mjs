import test from "node:test";
import assert from "node:assert/strict";
import policekes from "../src/adapters/sites/policekes.mjs";
import sigortala from "../src/adapters/sites/sigortala.mjs";
import { PolisoftPortalAdapter } from "../src/adapters/sites/polisoft-flow.mjs";

test("Sigorta.la ve PoliçeKes ortak Polisoft adaptörünü kullanır", () => {
  assert.ok(sigortala instanceof PolisoftPortalAdapter);
  assert.ok(policekes instanceof PolisoftPortalAdapter);
});

test("iki portalın farklı başlangıç davranışı korunur", () => {
  assert.equal(sigortala.continueAfterSelection, false);
  assert.equal(policekes.continueAfterSelection, true);
});
