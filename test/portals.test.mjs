import test from "node:test";
import assert from "node:assert/strict";
import { portals } from "../src/portals.mjs";

test("20 portalın SMS politikası tanımlıdır", () => {
  assert.equal(portals.length, 20);
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

test("PoliçeKes ve Sigorta.la güncel URL'leri kullanır; kaldırılan portallar listede yoktur", () => {
  assert.equal(portals.find((portal) => portal.id === "policekes").url, "https://www.policekes.com/oto/trafik-sigortasi-satin-al");
  assert.equal(portals.find((portal) => portal.id === "sigortala").url, "https://sigorta.la/oto/trafik-sigortasi-satin-al");
  for (const id of ["emaxsigorta", "ibksigorta", "sigortakurdu"]) assert.equal(portals.some((portal) => portal.id === id), false);
});

test("SigortaBin ve Sigorta7 devre dışıdır", () => {
  assert.equal(portals.find((portal) => portal.id === "sigortabin").deactivated, true);
  assert.equal(portals.find((portal) => portal.id === "sigorta7").deactivated, true);
});

test("yedi İhsan portalı canlı beta havuzunda ve varsayılan açık", () => {
  const ihsan = portals.filter((portal) => ["ihsan", "ihsan-frame"].includes(portal.adapter));
  assert.equal(ihsan.length, 7);
  assert.equal(ihsan.filter((portal) => portal.defaultEnabled).length, 7);
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
