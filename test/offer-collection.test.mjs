import test from "node:test";
import assert from "node:assert/strict";
import { mergeOffers } from "../src/lib/results.mjs";

// Kullanıcı gözlemi: portal 21 şirket teklifi verirken panele yalnız 3 tanesi
// düşüyordu. Kök neden, her yoklamada o anki ekran görüntüsünün "son durum"
// sayılmasıydı; teklifler birer birer yüklendiği ve ara render'larda geçici
// olarak azalabildiği için liste küçülüyordu. mergeOffers sorgu boyunca
// görülen tüm teklifleri biriktirir.
test("mergeOffers farklı şirketleri biriktirir", () => {
  const first = [{ company: "HDI SİGORTA", price: 100, sourcePortalId: "dijipol" }];
  const second = [{ company: "AXA SİGORTA", price: 200, sourcePortalId: "dijipol" }];
  assert.equal(mergeOffers(first, second).length, 2);
});

test("ekranda geçici olarak azalan teklifler listeyi küçültmez", () => {
  const first = [{ company: "HDI SİGORTA", price: 100, sourcePortalId: "dijipol" }];
  const second = [{ company: "AXA SİGORTA", price: 200, sourcePortalId: "dijipol" }];
  const both = mergeOffers(first, second);
  assert.equal(mergeOffers(both, first).length, 2);
});

test("aynı şirket için en düşük fiyat korunur", () => {
  const expensive = [{ company: "HDI SİGORTA", price: 100, sourcePortalId: "dijipol" }];
  const cheap = [{ company: "HDI SİGORTA", price: 80, sourcePortalId: "dijipol" }];
  const merged = mergeOffers(expensive, cheap);
  assert.equal(merged.length, 1);
  assert.equal(merged[0].price, 80);
});

test("aynı şirket farklı portallardan geldiğinde ayrı tutulur", () => {
  const fromA = [{ company: "HDI SİGORTA", price: 100, sourcePortalId: "dijipol" }];
  const fromB = [{ company: "HDI SİGORTA", price: 120, sourcePortalId: "koalay" }];
  assert.equal(mergeOffers(fromA, fromB).length, 2);
});

test("geçersiz kayıtlar (fiyatsız/şirketsiz) atılır", () => {
  const valid = [{ company: "HDI SİGORTA", price: 100, sourcePortalId: "dijipol" }];
  const invalid = [{ company: "", price: 50 }, { company: "AXA", price: Number.NaN }];
  assert.equal(mergeOffers(valid, invalid).length, 1);
});
