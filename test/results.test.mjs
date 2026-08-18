import test from "node:test";
import assert from "node:assert/strict";
import { deduplicateOffers, extractOffersFromText, summarizeResults } from "../src/lib/results.mjs";

const portal = { id: "test", name: "Test Portal", url: "https://example.test" };

test("metinden gerçek şirket ve TRY fiyatlarını çıkarır", () => {
  const offers = extractOffersFromText("MAPFRE SİGORTA trafik teklifi 12.450,75 TL ALLIANZ toplam ₺ 13.200,00", portal);
  assert.equal(offers.length, 2);
  assert.equal(offers.find((offer) => offer.company === "MAPFRE SİGORTA").price, 12450.75);
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
