import test from "node:test";
import assert from "node:assert/strict";
import { portals } from "../src/portals.mjs";

test("29 portalın SMS politikası tanımlıdır", () => {
  assert.equal(portals.length, 29);
  const validPolicies = new Set(["none", "per_query", "session_once", "unknown"]);
  for (const portal of portals) {
    assert.ok(validPolicies.has(portal.smsPolicy), `${portal.id} SMS politikası geçersiz`);
    assert.match(portal.smsReviewedAt, /^\d{4}-\d{2}-\d{2}$/);
    assert.ok(portal.smsEvidence.length > 10);
  }
});

test("doğrulanmış SMS politikaları korunur", () => {
  assert.equal(portals.find((portal) => portal.id === "lion").smsPolicy, "session_once");
  assert.equal(portals.find((portal) => portal.id === "enuygun").smsPolicy, "per_query");
});

test("yönlendirme ve bozuk istemci portalları çalışıyor gibi sunulmaz", () => {
  assert.equal(portals.find((portal) => portal.id === "sigortala").diagnosticState, "client_error");
  assert.equal(portals.find((portal) => portal.id === "policekes").diagnosticState, "client_error");
});

test("sekiz İhsan portalı canlı beta havuzunda ve varsayılan açık", () => {
  const ihsan = portals.filter((portal) => ["ihsan", "ihsan-frame"].includes(portal.adapter));
  assert.equal(ihsan.length, 8);
  assert.equal(ihsan.filter((portal) => portal.defaultEnabled).length, 8);
  assert.ok(ihsan.every((portal) => portal.integrationStatus === "beta"));
});

test("SigortaBin her sorguda taze oturumla açılır (storageState paylaşılmaz)", () => {
  const portal = portals.find((item) => item.id === "sigortabin");
  assert.equal(portal.fresh, true);
});

test("portal id'leri tekilleşiktir", () => {
  const ids = portals.map((portal) => portal.id);
  assert.equal(new Set(ids).size, ids.length);
});
