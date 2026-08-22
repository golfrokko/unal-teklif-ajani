import { insurerAliases } from "../portals.mjs";

function parseTry(value) {
  const normalized = String(value).replace(/\s/g, "").replace(/\./g, "").replace(",", ".").replace(/[^0-9.]/g, "");
  const number = Number(normalized);
  return Number.isFinite(number) && number >= 100 && number <= 1000000 ? number : null;
}

const AMOUNT = String.raw`\d{1,3}(?:\.\d{3})*(?:,\d{2})?|\d{3,6}(?:,\d{2})?`;
// Bazı portallar tutarı yalnız önüne ("₺15.399,53"), bazıları yalnız
// arkasına ("15.399,53 TL") para birimi koyuyor; ikisi de yakalanmalı,
// aksi halde o şirketin teklifi sessizce atlanır (Quick gibi).
const PRICE_PATTERN = new RegExp(`₺\\s*(${AMOUNT})|(${AMOUNT})\\s*(?:TL|₺)`, "gi");

function priceFromMatch(match) {
  return parseTry(match[1] || match[2]);
}

// Fiyatın hemen yanında genelde taksit bilgisi de yazıyor (ör. "12 Taksit",
// "3x Taksit", "Peşin Fiyat"). Sitelere özel bir alan olmadığından, fiyat
// eşleşmesinin etrafındaki dar bir pencerede metinle arıyoruz; bulunamazsa
// alan boş bırakılır (uydurma veri gösterilmez).
// Not: JS'nin /i bayrağı Türkçe noktalı İ ile düz i'yi eşleştirmiyor
// (standart Unicode büyük/küçük harf katlamasında İ -> "i̇" olur, salt "i"
// değil); bu yüzden İ/I/ı/i varyantlarının hepsini karakter sınıfıyla kapsıyoruz.
const INSTALLMENT_PATTERN = /(\d{1,2})\s*(?:x\s*)?TAKS[İIıi]T/i;
const CASH_ONLY_PATTERN = /PEŞ[İIıi]N(?:\s+F[İIıi]YAT)?/i;

function installmentFromSegment(segment, matchIndex) {
  const windowText = segment.slice(Math.max(0, matchIndex - 40), matchIndex + 80);
  const installmentMatch = windowText.match(INSTALLMENT_PATTERN);
  if (installmentMatch) return `${installmentMatch[1]} taksit`;
  if (CASH_ONLY_PATTERN.test(windowText)) return "Peşin";
  return null;
}

// Bazı şirket satırları gerçek bir fiyat yerine hata/oturum durumu
// gösteriyor (ör. "Oturum süresi dolmuş veya geçersiz token", "Hata id:
// 999"). Böyle bir ibare şirket adıyla bulunan fiyat arasındaysa, o fiyat
// aslında bu şirkete ait DEĞİLDİR (uzak bir komşu satırdan sızmış olabilir);
// bu durumda teklifi hiç eklemiyoruz.
const NO_OFFER_INDICATOR_PATTERN = /(OTURUM SÜRESİ DOLMUŞ|GEÇERSİZ TOKEN|SİSTEMDE BEKLENMEYEN|BEKLENMEYEN B[İI]R HATA|HATA\s*[İI]D|HATA\s*:|TEKL[İI]F VERMEYEN|REDDED[İI]LD[İI]|BAŞARISIZ)/;

// Şirket adı çok kısaysa (ör. "AK", "RAY") ham metin taraması komşu bir
// kelimenin İÇİNDE yanlışlıkla eşleşebilir (ör. "AKBANK" içindeki "AK").
// 4 karakter ve altındaki takma adlar için, eşleşmenin her iki yanının da
// harf/rakam OLMADIĞINI (yani gerçekten ayrı bir kelime olduğunu) doğruluyoruz.
function isWordChar(character) {
  return /[A-ZÇĞİÖŞÜ0-9]/.test(character || "");
}

function findAliasPositions(upper, alias) {
  const positions = [];
  const boundaryRequired = alias.length <= 4;
  let index = upper.indexOf(alias);
  while (index >= 0) {
    if (!boundaryRequired || (!isWordChar(upper[index - 1]) && !isWordChar(upper[index + alias.length]))) {
      positions.push(index);
    }
    index = upper.indexOf(alias, index + alias.length);
  }
  return positions;
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
      for (const position of findAliasPositions(upper, alias)) {
        allPositions.push({ company, position });
      }
    }
  }
  allPositions.sort((a, b) => a.position - b.position);

  for (const [company, aliases] of insurerAliases) {
    const matches = aliases
      .flatMap((alias) => findAliasPositions(upper, alias).map((position) => ({ alias, position })));
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
    const priceMatches = [...segment.matchAll(PRICE_PATTERN)];

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
    const betweenNameAndPrice = segment.slice(Math.min(chosen.index, nameStartInSegment), Math.max(chosen.index, nameEndInSegment)).toLocaleUpperCase("tr-TR");
    if (NO_OFFER_INDICATOR_PATTERN.test(betweenNameAndPrice)) continue;
    const price = priceFromMatch(chosen);
    if (!price) continue;
    const installments = installmentFromSegment(segment, chosen.index);
    offers.push({
      company,
      price,
      currency: "TRY",
      sourcePortalId: portal.id,
      sourcePortal: portal.name,
      sourceUrl: portal.url,
      capturedAt: new Date().toISOString(),
      ...(installments ? { installments } : {}),
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
