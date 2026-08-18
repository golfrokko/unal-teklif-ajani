export function normalizePhone(value) {
  let digits = String(value || "").replace(/\D/g, "");
  if (digits.startsWith("90") && digits.length === 12) digits = digits.slice(2);
  if (digits.length === 10) digits = `0${digits}`;
  return /^05\d{9}$/.test(digits) ? digits : "";
}

export function normalizeVehicle(input = {}) {
  return {
    identity: String(input.identity || "").replace(/\D/g, "").slice(0, 11),
    birthDate: String(input.birthDate || "").trim().slice(0, 10),
    plate: String(input.plate || "").replace(/\s+/g, " ").trim().toLocaleUpperCase("tr-TR").slice(0, 12),
    registration: String(input.registration || "").replace(/\s+/g, "").trim().toLocaleUpperCase("tr-TR").slice(0, 24),
    vehicle: String(input.vehicle || "").trim().slice(0, 120),
    year: String(input.year || "").replace(/\D/g, "").slice(0, 4),
    chassis: String(input.chassis || "").replace(/\s+/g, "").trim().toUpperCase().slice(0, 32),
    engine: String(input.engine || "").replace(/\s+/g, "").trim().toUpperCase().slice(0, 32),
  };
}

export function validateJobInput(body, defaultPhone) {
  if (body?.customerConsent !== true) return { error: "Müşteri sorgulama onayı işaretlenmelidir" };
  const vehicle = normalizeVehicle(body?.vehicle);
  if (!/^\d{10,11}$/.test(vehicle.identity)) return { error: "Geçerli TC/VKN zorunludur" };
  if (!vehicle.plate) return { error: "Plaka zorunludur" };
  const phone = normalizePhone(body?.phone) || normalizePhone(defaultPhone);
  if (!phone) return { error: "Geçerli bir SMS telefon numarası girilmelidir" };
  return {
    value: {
      vehicle,
      phone,
      mode: body?.mode === "no_sms" ? "no_sms" : "ask_sms",
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
