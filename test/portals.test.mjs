import test from "node:test";
import assert from "node:assert/strict";
import { portals } from "../src/portals.mjs";

test("25 portalın SMS politikası tanımlıdır", () => {
  assert.equal(portals.length, 25);
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
  assert.equal(portals.find((portal) => portal.id === "hepiyi").smsPolicy, "per_query");
});

test("yönlendirme ve bozuk istemci portalları çalışıyor gibi sunulmaz", () => {
  assert.equal(portals.find((portal) => portal.id === "hangikredi").diagnosticState, "redirect_only");
  assert.equal(portals.find((portal) => portal.id === "enpara").diagnosticState, "auth_required");
  assert.equal(portals.find((portal) => portal.id === "sigortala").diagnosticState, "client_error");
  assert.equal(portals.find((portal) => portal.id === "policekes").diagnosticState, "client_error");
  assert.equal(portals.find((portal) => portal.id === "quick").url, "https://www.quicksigorta.com/uretim/trafik");
});

test("SigortaBaz yavaş açılışlar için daha uzun gezinme süresi kullanır", () => {
  const portal = portals.find((item) => item.id === "sigortabaz");
  assert.ok(portal.navigationTimeoutMs >= 60000);
});

test("dokuz İhsan portalı canlı beta havuzunda açıktır", () => {
  const ihsan = portals.filter((portal) => ["ihsan", "ihsan-frame"].includes(portal.adapter));
  assert.equal(ihsan.length, 9);
  assert.equal(ihsan.filter((portal) => portal.defaultEnabled).length, 9);
  assert.ok(ihsan.every((portal) => portal.integrationStatus === "beta"));
});
