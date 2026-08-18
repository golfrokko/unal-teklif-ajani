import { insurerAliases } from "../portals.mjs";

function parseTry(value) {
  const normalized = String(value).replace(/\s/g, "").replace(/\./g, "").replace(",", ".").replace(/[^0-9.]/g, "");
  const number = Number(normalized);
  return Number.isFinite(number) && number >= 100 && number <= 1000000 ? number : null;
}

export function extractOffersFromText(text, portal) {
  const upper = String(text).toLocaleUpperCase("tr-TR");
  const offers = [];
  for (const [company, aliases] of insurerAliases) {
    const positions = aliases.map((alias) => upper.indexOf(alias)).filter((position) => position >= 0);
    if (!positions.length) continue;
    const position = Math.min(...positions);
    const segment = String(text).slice(Math.max(0, position - 140), position + 520);
    const prices = [...segment.matchAll(/(?:₺\s*)?(\d{1,3}(?:\.\d{3})*(?:,\d{2})?|\d{3,6}(?:,\d{2})?)\s*(?:TL|₺)/gi)]
      .map((match) => parseTry(match[1]))
      .filter(Boolean);
    if (!prices.length) continue;
    offers.push({
      company,
      price: Math.min(...prices),
      currency: "TRY",
      sourcePortalId: portal.id,
      sourcePortal: portal.name,
      sourceUrl: portal.url,
      capturedAt: new Date().toISOString(),
    });
  }
  return deduplicateOffers(offers);
}

export function deduplicateOffers(results = []) {
  const unique = new Map();
  for (const result of results) {
    if (!result?.company || !Number.isFinite(result?.price)) continue;
    const key = `${result.company}:${result.sourcePortalId}:${result.price}`;
    if (!unique.has(key)) unique.set(key, result);
  }
  return [...unique.values()];
}

export function summarizeResults(results = []) {
  const grouped = new Map();
  for (const result of deduplicateOffers(results)) {
    const current = grouped.get(result.company) || { company: result.company, bestPrice: result.price, sources: [] };
    current.bestPrice = Math.min(current.bestPrice, result.price);
    current.sources.push(result);
    grouped.set(result.company, current);
  }
  return [...grouped.values()].sort((a, b) => a.bestPrice - b.bestPrice);
}
