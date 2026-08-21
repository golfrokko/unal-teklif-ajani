import { insurerAliases } from "../portals.mjs";

function parseTry(value) {
  const normalized = String(value).replace(/\s/g, "").replace(/\./g, "").replace(",", ".").replace(/[^0-9.]/g, "");
  const number = Number(normalized);
  return Number.isFinite(number) && number >= 100 && number <= 1000000 ? number : null;
}

export function extractOffersFromText(text, portal) {
  const upper = String(text).toLocaleUpperCase("tr-TR");
  const offers = [];

  // Her şirket adının metindeki tüm konumlarını topla; bir şirketin fiyat
  // segmenti komşu şirketin adının başladığı yere kadar sınırlanır, aksi
  // halde geniş bir arama penceresi yanlışlıkla komşu satırın fiyatını
  // (örn. Dijipol'de HDI satırına başka bir şirketin fiyatını) yakalayabilir.
  const allPositions = [];
  for (const [company, aliases] of insurerAliases) {
    for (const alias of aliases) {
      let index = upper.indexOf(alias);
      while (index >= 0) {
        allPositions.push({ company, position: index });
        index = upper.indexOf(alias, index + alias.length);
      }
    }
  }
  allPositions.sort((a, b) => a.position - b.position);

  for (const [company, aliases] of insurerAliases) {
    const matches = aliases
      .map((alias) => ({ alias, position: upper.indexOf(alias) }))
      .filter((entry) => entry.position >= 0);
    if (!matches.length) continue;
    const { alias: matchedAlias, position } = matches.reduce((best, entry) => (entry.position < best.position ? entry : best));
    const aliasEnd = position + matchedAlias.length;
    const prevOther = [...allPositions].reverse().find((entry) => entry.position < position && entry.company !== company);
    const nextOther = allPositions.find((entry) => entry.position > position && entry.company !== company);
    const start = Math.max(position - 60, prevOther ? prevOther.position : 0, 0);
    const end = Math.min(position + 520, nextOther ? nextOther.position : text.length);
    const segment = String(text).slice(start, end);
    const nameStartInSegment = position - start;
    const nameEndInSegment = aliasEnd - start;
    const priceMatches = [...segment.matchAll(/(?:₺\s*)?(\d{1,3}(?:\.\d{3})*(?:,\d{2})?|\d{3,6}(?:,\d{2})?)\s*(?:TL|₺)/gi)];

    // Fiyat tablolarında değer genelde şirket adından SONRA gelir; bu yüzden
    // adın bittiği yerden itibaren ilk fiyatı tercih ediyoruz. Yalnızca adın
    // önünde fiyat varsa (ve arkasında yoksa) o değeri kullanırız.
    let chosen = null;
    for (const match of priceMatches) {
      if (match.index < nameEndInSegment) continue;
      if (!chosen || match.index < chosen.index) chosen = match;
    }
    if (!chosen) {
      for (const match of priceMatches) {
        if (match.index >= nameStartInSegment) continue;
        if (!chosen || match.index > chosen.index) chosen = match;
      }
    }
    if (!chosen) continue;
    const price = parseTry(chosen[1]);
    if (!price) continue;
    offers.push({
      company,
      price,
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
