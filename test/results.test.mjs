import test from "node:test";
import assert from "node:assert/strict";
import { deduplicateOffers, extractOffersFromText, summarizeResults } from "../src/lib/results.mjs";

const portal = { id: "test", name: "Test Portal", url: "https://example.test" };

test("metinden gerçek şirket ve TRY fiyatlarını çıkarır", () => {
  const offers = extractOffersFromText("MAPFRE SİGORTA trafik teklifi 12.450,75 TL ALLIANZ toplam ₺ 13.200,00", portal);
  assert.equal(offers.length, 2);
  assert.equal(offers.find((offer) => offer.company === "MAPFRE SİGORTA").price, 12450.75);
});

test("komşu şirketlerin fiyatları birbirine karışmaz (Dijipol tipi tablo)", () => {
  const offers = extractOffersFromText(
    "HDI SİGORTA 950,00 TL ANADOLU SİGORTA 1.200,00 TL AXA SİGORTA 800,00 TL",
    portal,
  );
  assert.equal(offers.find((offer) => offer.company === "HDI SİGORTA").price, 950);
  assert.equal(offers.find((offer) => offer.company === "ANADOLU SİGORTA").price, 1200);
  assert.equal(offers.find((offer) => offer.company === "AXA SİGORTA").price, 800);
});

test("yalnız önüne ₺ konan fiyatları da yakalar (sonrasında TL/₺ olmasa bile)", () => {
  const offers = extractOffersFromText("QUICK SİGORTA en düşük fiyat ₺9.850,40 hemen satın al", portal);
  assert.equal(offers.length, 1);
  assert.equal(offers[0].company, "QUICK SİGORTA");
  assert.equal(offers[0].price, 9850.40);
});

test("aynı portal fiyatını tekilleştirip en iyi teklifi özetler", () => {
  const input = [
    { company: "ALLIANZ", price: 10000, sourcePortalId: "a" },
    { company: "ALLIANZ", price: 10000, sourcePortalId: "a" },
    { company: "ALLIANZ", price: 9500, sourcePortalId: "b" },
  ];
  assert.equal(deduplicateOffers(input).length, 2);
  const summary = summarizeResults(input);
  assert.equal(summary[0].bestPrice, 9500);
  assert.equal(summary[0].sources.length, 2);
});
