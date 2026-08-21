const SMS_REVIEWED_AT = "2026-08-21";

function portal(definition) {
  return {
    smsPolicy: "unknown",
    smsEvidence: "Gerçek müşteri verisi gönderilmeden SMS adımı doğrulanamadı",
    smsReviewedAt: SMS_REVIEWED_AT,
    ...definition,
  };
}

export const portals = [
  portal({ id: "lion", name: "Sigorta Lion", url: "https://lion.sigorta.online/trafik", adapter: "ihsan", group: "İhsan altyapısı", verifiedForm: true, defaultEnabled: true, integrationStatus: "beta", smsPolicy: "session_once", smsEvidence: "Kullanıcı gözlemi: oturum açılırken bir kez SMS istiyor; açık oturum sonraki sorgularda kullanılabiliyor" }),
  portal({ id: "bitikla", name: "Bi Tıkla Sigorta", url: "https://bitikla.sigorta.online/trafik", adapter: "ihsan", group: "İhsan altyapısı", verifiedForm: true, defaultEnabled: true, integrationStatus: "beta" }),
  portal({ id: "sigortabaz", name: "SigortaBaz", url: "https://teklif.sigortabaz.com/trafik", adapter: "ihsan", group: "İhsan altyapısı", verifiedForm: true, defaultEnabled: true, integrationStatus: "beta", navigationTimeoutMs: 60000 }),
  portal({ id: "sigortamobil", name: "SigortaMobil", url: "https://sigortamobil.sigorta.online/trafik", adapter: "ihsan", group: "İhsan altyapısı", verifiedForm: true, defaultEnabled: true, integrationStatus: "beta" }),
  portal({ id: "tasalti", name: "Taşaltı Teklif", url: "https://tasalti.sigorta.online/trafik", adapter: "ihsan", group: "İhsan altyapısı", verifiedForm: true, defaultEnabled: true, integrationStatus: "beta" }),
  portal({ id: "sert", name: "Sert Sigorta", url: "https://sert.sigorta.online/trafik", adapter: "ihsan", group: "İhsan altyapısı", verifiedForm: false, defaultEnabled: true, integrationStatus: "beta" }),
  portal({ id: "nepratik", name: "Ne Pratik Sigorta", url: "https://nepratiksigorta.com/Trafik", adapter: "ihsan", group: "İhsan altyapısı", verifiedForm: false, defaultEnabled: true, integrationStatus: "beta" }),
  portal({ id: "iskenderun", name: "İskenderun Teklif", url: "https://iskenderun.sigorta.online/trafik", adapter: "ihsan", group: "İhsan altyapısı", verifiedForm: false, defaultEnabled: true, integrationStatus: "beta" }),
  portal({ id: "sigortammilli", name: "Sigortam Milli", url: "https://sigortammilli.com.tr/trafik-sigortasi/", adapter: "ihsan-frame", group: "İhsan altyapısı", verifiedForm: true, defaultEnabled: true, integrationStatus: "beta" }),
  portal({ id: "sigortam", name: "Sigortam.net", url: "https://www.sigortam.net/trafik-sigortasi", adapter: "generic", group: "Karşılaştırma sitesi", verifiedForm: true }),
  portal({ id: "sigortaladim", name: "Sigortaladım", url: "https://www.sigortaladim.com/zorunlu-trafik-sigortasi", adapter: "generic", group: "Karşılaştırma sitesi", verifiedForm: true }),
  portal({ id: "koalay", name: "Koalay", url: "https://www.koalay.com/zorunlu-trafik-sigortasi", adapter: "generic", group: "Karşılaştırma sitesi", verifiedForm: true }),
  portal({ id: "enuygun", name: "Enuygun Sigorta", url: "https://www.enuygunsigorta.com/zorunlu-trafik-sigortasi/", adapter: "generic", group: "Karşılaştırma sitesi", verifiedForm: true, otpTrigger: "after_phone_submit", smsPolicy: "per_query", smsEvidence: "Resmî trafik teklif formu: cep telefonu numarasına birazdan SMS ile doğrulama kodu iletileceğini açıkça belirtiyor" }),
  portal({ id: "sigortambir", name: "Sigortambir", url: "https://www.sigortambir.com/zorunlu-trafik-sigortasi", adapter: "generic", group: "Karşılaştırma sitesi", verifiedForm: true }),
  portal({ id: "sigorta7", name: "Sigorta7", url: "https://www.sigorta7.com/trafik-sigortasi", adapter: "generic", group: "Karşılaştırma sitesi", verifiedForm: true }),
  portal({ id: "sigortayeri", name: "Sigorta Yeri", url: "https://www.sigortayeri.com/arac-sigortasi/trafik-sigortasi", adapter: "generic", group: "Karşılaştırma sitesi", verifiedForm: true }),
  portal({ id: "sigortala", name: "Sigorta.la", url: "https://sigorta.la/page/trafik-sigortasi", adapter: "generic", group: "Karşılaştırma sitesi", verifiedForm: false, diagnosticState: "client_error", diagnosticMessage: "Portal sunucuda yalnız eksik uygulama kabuğu döndürüyor; teklif formu yüklenmiyor" }),
  portal({ id: "dijipol", name: "Dijipol", url: "https://www.dijipol.com/", adapter: "generic", group: "Karşılaştırma sitesi", verifiedForm: true }),
  portal({ id: "hangikredi", name: "HangiKredi Sigorta", url: "https://www.hangikredi.com/sigorta/zorunlu-trafik-sigortasi", adapter: "generic", group: "Banka / platform", verifiedForm: false, diagnosticState: "redirect_only", diagnosticMessage: "Bağımsız teklif kaynağı değil; resmî sayfa Sigortam.net'e yönlendiriyor", duplicateOf: "sigortam" }),
  portal({ id: "enpara", name: "Enpara Sigorta", url: "https://www.enpara.com/sigortalar/trafik-sigortasi", adapter: "generic", group: "Banka / platform", verifiedForm: false, diagnosticState: "auth_required", diagnosticMessage: "Teklif akışı Enpara müşteri girişi / mobil uygulama oturumu gerektiriyor" }),
  portal({ id: "hepiyi", name: "Hepiyi", url: "https://hepiyi.com.tr/trafik-sigortasi/form/arac-bilgileri", adapter: "generic", group: "Sigorta şirketi", verifiedForm: true, requiredFields: ["email"], otpTrigger: "after_phone_submit", smsPolicy: "per_query", smsEvidence: "Resmî form, girilen cep telefonu numarasına onay kodu gönderileceğini ve e-posta adresinin zorunlu olduğunu belirtiyor" }),
  portal({ id: "quick", name: "Quick Sigorta", url: "https://www.quicksigorta.com/uretim/trafik", adapter: "generic", group: "Sigorta şirketi", verifiedForm: false, smsEvidence: "Resmî üretim formu Google reCAPTCHA ile korunuyor; otomatik CAPTCHA çözümü uygulanmaz" }),
  portal({ id: "sompo", name: "Sompo Sigorta", url: "https://www.somposigorta.com.tr/trafik-sigortasi", adapter: "generic", group: "Sigorta şirketi", verifiedForm: true }),
  portal({ id: "ethica", name: "Ethica Sigorta", url: "https://www.ethicasigorta.com.tr/trafik-sigortasi", adapter: "generic", group: "Sigorta şirketi", verifiedForm: true }),
  portal({ id: "policekes", name: "PoliçeKes", url: "https://www.policekes.com/", adapter: "generic", group: "Karşılaştırma sitesi", verifiedForm: false, diagnosticState: "client_error", diagnosticMessage: "Portal sunucuda eksik uygulama kabuğu döndürüyor; teklif formu yüklenmiyor" }),
];

export const insurerAliases = [
  ["AKSİGORTA", ["AKSİGORTA", "AK SIGORTA"]],
  ["ALLIANZ", ["ALLIANZ"]],
  ["ANADOLU SİGORTA", ["ANADOLU SİGORTA", "ANADOLU SIGORTA"]],
  ["ANKARA SİGORTA", ["ANKARA SİGORTA", "ANKARA SIGORTA"]],
  ["ATLAS MUTUEL", ["ATLAS MUTUEL", "ATLAS"]],
  ["AXA SİGORTA", ["AXA SİGORTA", "AXA SIGORTA", "AXA"]],
  ["BEREKET SİGORTA", ["BEREKET"]],
  ["CORPUS SİGORTA", ["CORPUS"]],
  ["DOĞA SİGORTA", ["DOĞA SİGORTA", "DOGA SIGORTA", "DOĞA"]],
  ["ETHICA SİGORTA", ["ETHICA"]],
  ["EUREKO SİGORTA", ["EUREKO"]],
  ["GENERALI", ["GENERALI"]],
  ["HDI SİGORTA", ["HDI SİGORTA", "HDI SIGORTA", "HDI"]],
  ["HEPİYİ SİGORTA", ["HEPİYİ", "HEPIYI"]],
  ["KORU SİGORTA", ["KORU SİGORTA", "KORU SIGORTA"]],
  ["MAGDEBURGER", ["MAGDEBURGER"]],
  ["MAPFRE SİGORTA", ["MAPFRE SİGORTA", "MAPFRE SIGORTA", "MAPFRE"]],
  ["NEOVA SİGORTA", ["NEOVA"]],
  ["ORİENT SİGORTA", ["ORIENT", "ORİENT"]],
  ["QUICK SİGORTA", ["QUICK"]],
  ["RAY SİGORTA", ["RAY SİGORTA", "RAY SIGORTA"]],
  ["SOMPO SİGORTA", ["SOMPO"]],
  ["TÜRK NİPPON", ["TÜRK NİPPON", "TURK NIPPON"]],
  ["TÜRKİYE SİGORTA", ["TÜRKİYE SİGORTA", "TURKIYE SIGORTA"]],
  ["UNICO SİGORTA", ["UNICO"]],
  ["ZURICH SİGORTA", ["ZURICH"]]
];
