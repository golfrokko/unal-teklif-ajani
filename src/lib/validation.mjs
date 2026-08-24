export const RESEND_SENTINEL = "__RESEND__";

export function normalizePhone(value) {
  let digits = String(value || "").replace(/\D/g, "");
  if (digits.startsWith("90") && digits.length === 12) digits = digits.slice(2);
  if (digits.length === 10) digits = `0${digits}`;
  return /^05\d{9}$/.test(digits) ? digits : "";
}

export function normalizeEmail(value) {
  const email = String(value || "").trim().toLowerCase().slice(0, 254);
  return /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/.test(email) ? email : "";
}

// Sigortalı bir tüzel kişiyse (ör. "... GIDA SANAYİ VE TİCARET LİMİTED
// ŞİRKETİ") portalların çoğu "Bireysel/Kurumsal" sekmesi veya "TC Kimlik No /
// Vergi Kimlik No" seçimi istiyor; yanlış seçim sorguyu baştan geçersiz
// kılıyor. Ad/soyad metnindeki bu tür ibareler kurumsal işareti sayılır.
// Not: Türkçe büyük harf dönüşümü ve İ/ı katlaması için trUpper mantığı
// (toLocaleUpperCase("tr-TR")) kullanılıyor; desenler bu yüzden büyük harfli.
const CORPORATE_NAME_PATTERN = /\b(GIDA|SANAY[İI]|T[İI]CARET|L[İI]M[İI]TED|Ş[İI]RKET[İI]?|ANON[İI]M|LTD|A\.?Ş|ŞT[İI]|HOLD[İI]NG|[İI]NŞAAT|OTOMOT[İI]V|NAKL[İI]YAT|TUR[İI]ZM|PAZARLAMA|MÜHEND[İI]SL[İI]K|KOOPERAT[İI]F|VAKF[İI]?|DERNEĞ[İI]?)\b/;

export function isCorporateName(fullName) {
  return CORPORATE_NAME_PATTERN.test(String(fullName || "").toLocaleUpperCase("tr-TR"));
}

// Kurumsal sorgu kararı: ad/soyad kurumsal ibare içeriyorsa VEYA kimlik
// numarası 10 haneliyse (VKN 10, TC 11 hane) kurumsal kabul edilir.
export function isCorporateJob(vehicle = {}) {
  return isCorporateName(vehicle.fullName) || String(vehicle.identity || "").replace(/\D/g, "").length === 10;
}

export function normalizeVehicle(input = {}) {
  return {
    fullName: String(input.fullName || "").replace(/\s+/g, " ").trim().slice(0, 80),
    identity: String(input.identity || "").replace(/\D/g, "").slice(0, 11),
    authorizedIdentity: String(input.authorizedIdentity || "").replace(/\D/g, "").slice(0, 11),
    birthDate: String(input.birthDate || "").trim().slice(0, 10),
    plate: String(input.plate || "").replace(/\s+/g, " ").trim().toLocaleUpperCase("tr-TR").slice(0, 12),
    registration: String(input.registration || "").replace(/\s+/g, "").trim().toLocaleUpperCase("tr-TR").slice(0, 24),
    vehicle: String(input.vehicle || "").trim().slice(0, 120),
    year: String(input.year || "").replace(/\D/g, "").slice(0, 4),
    chassis: String(input.chassis || "").replace(/\s+/g, "").trim().toUpperCase().slice(0, 32),
    engine: String(input.engine || "").replace(/\s+/g, "").trim().toUpperCase().slice(0, 32),
    usageType: String(input.usageType || "").replace(/\s+/g, " ").trim().slice(0, 40),
    registrationDate: String(input.registrationDate || "").trim().slice(0, 10),
  };
}

export function validateJobInput(body, defaultPhone, defaultEmail = "") {
  if (body?.customerConsent !== true) return { error: "Müşteri sorgulama onayı işaretlenmelidir" };
  const vehicle = normalizeVehicle(body?.vehicle);
  if (!/^\d{10,11}$/.test(vehicle.identity)) return { error: "Geçerli TC/VKN zorunludur" };
  if (vehicle.identity.length === 10 && !/^\d{11}$/.test(vehicle.authorizedIdentity)) return { error: "VKN sorgularında şirket yetkilisinin 11 haneli TC numarası zorunludur" };
  if (!vehicle.plate) return { error: "Plaka zorunludur" };
  const mode = body?.mode === "no_sms" ? "no_sms" : "ask_sms";
  const phone = normalizePhone(body?.phone) || normalizePhone(defaultPhone);
  const email = normalizeEmail(body?.email) || normalizeEmail(defaultEmail);
  if (mode === "ask_sms" && !phone) return { error: "Geçerli bir SMS telefon numarası girilmelidir" };
  return {
    value: {
      vehicle,
      phone,
      email,
      mode,
    },
  };
}

export function normalizeOtp(value) {
  const code = String(value || "").replace(/\D/g, "").slice(0, 8);
  return code.length >= 4 ? code : "";
}

export function safeMessage(error, maxLength = 240) {
  return String(error?.message || error || "Bilinmeyen hata").replace(/\s+/g, " ").trim().slice(0, maxLength);
}
