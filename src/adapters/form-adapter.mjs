import { extractOffersFromText } from "../lib/results.mjs";
import { RESEND_SENTINEL } from "../lib/validation.mjs";

function escapeRegex(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

export async function fillHumanLike(input, value) {
  await input.click({ timeout: 3000, clickCount: 3 }).catch(() => {});
  await input.fill("", { timeout: 2000 }).catch(() => {});
  await input.pressSequentially(String(value), { timeout: 8000, delay: 28 }).catch(async () => {
    await input.fill(String(value), { timeout: 3000 }).catch(() => {});
  });
  const actual = await input.inputValue({ timeout: 1000 }).catch(() => "");
  if (actual.replace(/\s+/g, "") !== String(value).replace(/\s+/g, "")) {
    await input.fill(String(value), { timeout: 3000 }).catch(() => {});
  }
}

export async function fillFirst(target, value, selectors, labelTerms) {
  if (!value) return false;
  for (const selector of selectors) {
    try {
      const input = target.locator(selector).first();
      if (await input.isVisible({ timeout: 400 })) {
        await fillHumanLike(input, value);
        return true;
      }
    } catch {}
  }
  for (const term of labelTerms) {
    try {
      const input = target.getByLabel(new RegExp(escapeRegex(term), "i")).first();
      if (await input.isVisible({ timeout: 400 })) {
        await fillHumanLike(input, value);
        return true;
      }
    } catch {}
  }
  for (const term of labelTerms) {
    try {
      const label = target.locator("label").filter({ hasText: new RegExp(escapeRegex(term), "i") }).first();
      if (!(await label.isVisible({ timeout: 400 }))) continue;
      const inside = label.locator("input").first();
      if (await inside.count()) {
        await fillHumanLike(inside, value);
        return true;
      }
      const forId = await label.getAttribute("for");
      if (forId) {
        const linked = target.locator(`[id="${forId.replace(/(["\\])/g, "\\$1")}"]`).first();
        await fillHumanLike(linked, value);
        return true;
      }
    } catch {}
  }
  return false;
}

export function splitFullName(fullName) {
  const parts = String(fullName || "").trim().split(/\s+/).filter(Boolean);
  if (!parts.length) return { first: "", last: "" };
  if (parts.length === 1) return { first: parts[0], last: "" };
  return { first: parts.slice(0, -1).join(" "), last: parts.at(-1) };
}

export async function fillNameAndEmail(target, job) {
  const fullName = job.vehicle?.fullName || "";
  const { first, last } = splitFullName(fullName);
  const filledFullName = await fillFirst(target, fullName,
    ['input[name*="fullname" i]', 'input[name*="ad_soyad" i]', 'input[name*="adsoyad" i]', 'input[name*="namesurname" i]', 'input[placeholder*="ad soyad" i]', 'input[placeholder*="adınız soyadınız" i]'],
    ["Ad Soyad", "Ad ve Soyad", "Adı Soyadı", "Adınız Soyadınız", "Sigortalı Adı Soyadı"]);
  let filledFirst = false;
  let filledLast = false;
  if (!filledFullName && first && last) {
    filledFirst = await fillFirst(target, first,
      ['input[name*="firstname" i]', 'input[name="ad" i]', 'input[id="ad" i]', 'input[placeholder="Adınız" i]', 'input[placeholder="Adı" i]'],
      ["Adınız", "İsminiz"]);
    filledLast = await fillFirst(target, last,
      ['input[name*="lastname" i]', 'input[name*="soyad" i]', 'input[id*="soyad" i]', 'input[placeholder*="soyadınız" i]'],
      ["Soyadınız", "Soyadı"]);
  }
  const filledEmail = await fillFirst(target, job.email,
    ['input[type="email"]', 'input[name*="email" i]', 'input[name*="eposta" i]', 'input[name*="e_posta" i]', 'input[placeholder*="e-posta" i]', 'input[placeholder*="eposta" i]'],
    ["E-posta", "E-Posta Adresi", "Eposta", "Email"]);
  return { fullName: filledFullName || (filledFirst && filledLast), email: filledEmail };
}

function convertDateFormat(ddmmyyyy, targetFormat) {
  const match = String(ddmmyyyy || "").match(/^(\d{1,2})[.\/-](\d{1,2})[.\/-](\d{4})$/);
  if (!match) return ddmmyyyy;
  const [, dd, mm, yyyy] = match;
  const pad = (part) => part.padStart(2, "0");
  if (targetFormat === "mm/dd/yyyy") return `${pad(mm)}/${pad(dd)}/${yyyy}`;
  if (targetFormat === "yyyy-mm-dd") return `${yyyy}-${pad(mm)}-${pad(dd)}`;
  return `${pad(dd)}.${pad(mm)}.${yyyy}`;
}

export async function fillBirthDate(target, birthDate) {
  if (!birthDate) return false;
  const selectors = [
    'input[placeholder="GG.AA.YYYY" i]', 'input[placeholder="DD.MM.YYYY" i]', 'input[placeholder="MM/DD/YYYY" i]',
    'input[placeholder="DD/MM/YYYY" i]', 'input[type="date"]', 'input[name*="birth" i]', 'input[name*="dogum" i]',
    'input[id*="birth" i]', 'input[id*="dogum" i]',
  ];
  for (const selector of selectors) {
    try {
      const input = target.locator(selector).first();
      if (!(await input.isVisible({ timeout: 400 }))) continue;
      const meta = await input.evaluate((element) => ({
        placeholder: element.getAttribute("placeholder") || "",
        type: element.getAttribute("type") || "",
      })).catch(() => ({}));
      let value = birthDate;
      if (meta.type === "date") value = convertDateFormat(birthDate, "yyyy-mm-dd");
      else if (/^mm/i.test(meta.placeholder)) value = convertDateFormat(birthDate, "mm/dd/yyyy");
      await fillHumanLike(input, value);
      return true;
    } catch {}
  }
  return fillFirst(target, birthDate, [], ["Doğum Tarihi"]);
}

function splitRegistrationParts(registration) {
  const match = String(registration || "").match(/^([A-ZÇĞİÖŞÜ]+)(\d+)$/);
  if (!match) return { seri: registration, no: registration };
  return { seri: match[1], no: match[2] };
}

export async function fillMatbuVehicleFields(target, vehicle) {
  const filled = {};
  const vehicleText = String(vehicle.vehicle || "").trim();
  const words = vehicleText.split(/\s+/).filter(Boolean);
  const brand = words[0] || "";
  const model = words.slice(1).join(" ") || vehicleText;
  filled.brand = await fillFirst(target, brand,
    ['select[name*="brand" i]', 'select[name*="marka" i]', 'input[name*="brand" i]', 'input[name*="marka" i]'],
    ["Araç Markası", "Marka"]);
  filled.model = await fillFirst(target, model,
    ['select[name*="model" i]:not([name*="yil" i])', 'input[name*="model" i]:not([name*="yil" i])'],
    ["Araç Modeli", "Model"]);
  filled.year = await fillFirst(target, vehicle.year,
    ['select[name*="year" i]', 'select[name*="modelyil" i]', 'select[name*="model_yil" i]', 'input[name*="year" i]', 'input[name*="modelyil" i]'],
    ["Model Yılı", "Araç Model Yılı"]);
  return filled;
}

export async function fillSecondaryRegistrationFields(target, registration) {
  const { no } = splitRegistrationParts(registration);
  return fillFirst(target, no,
    ['input[name*="belgeno" i]', 'input[name*="belge_no" i]', 'input[id*="belgeno" i]', 'input[placeholder*="belge no" i]'],
    ["Ruhsat Belge No", "Belge No", "Tescil No", "Tescil Belge No"]);
}

const CONSENT_TEXT_PATTERN = /(KVKK|AYDINLATMA|KULLANICI SÖZLEŞMESİ|ÜYELİK SÖZLEŞMESİ|GİZLİLİK SÖZLEŞMESİ|KİŞİSEL VERİ|AÇIK RIZA|ELEKTRONİK İLETİ|ONAY VERİYORUM|KABUL EDİYORUM|ŞARTLARI KABUL)/;

export async function acceptRequiredConsents(target) {
  const labels = target.locator("label");
  const labelCount = Math.min(await labels.count().catch(() => 0), 140);
  for (let index = 0; index < labelCount; index += 1) {
    const label = labels.nth(index);
    const text = (await label.innerText({ timeout: 300 }).catch(() => "")).toLocaleUpperCase("tr-TR");
    if (!CONSENT_TEXT_PATTERN.test(text)) continue;
    const input = label.locator('input[type="checkbox"]').first();
    if (await input.count()) {
      if (!await input.isChecked({ timeout: 300 }).catch(() => false)) {
        await input.check({ force: true }).catch(() => {});
        if (!await input.isChecked({ timeout: 300 }).catch(() => false)) await label.click({ force: true }).catch(() => {});
      }
      continue;
    }
    const forId = await label.getAttribute("for");
    if (forId) {
      const linked = target.locator(`[id="${forId.replace(/(["\\])/g, "\\$1")}"]`).first();
      if (await linked.count() && !await linked.isChecked({ timeout: 300 }).catch(() => false)) {
        await linked.check({ force: true }).catch(() => {});
      }
    }
  }
  const boxes = target.locator('input[type="checkbox"]');
  const boxCount = Math.min(await boxes.count().catch(() => 0), 60);
  for (let index = 0; index < boxCount; index += 1) {
    const box = boxes.nth(index);
    if (!await box.isVisible({ timeout: 200 }).catch(() => false)) continue;
    if (await box.isChecked({ timeout: 200 }).catch(() => false)) continue;
    const nearbyText = await box.evaluate((element) => (element.closest("label, .form-check, .checkbox, li, div")?.innerText || "")
      .toLocaleUpperCase("tr-TR")).catch(() => "");
    if (CONSENT_TEXT_PATTERN.test(nearbyText)) await box.check({ force: true }).catch(() => {});
  }
}

export async function humanPause(minMs = 180, maxMs = 420) {
  const ms = minMs + Math.floor(Math.random() * (maxMs - minMs));
  await new Promise((resolve) => setTimeout(resolve, ms));
}

export async function resolveTarget(page, portal) {
  if (portal.adapter !== "ihsan-frame") return page;
  await page.waitForTimeout(1200);
  return page.frames().find((frame) => frame !== page.mainFrame() && /sigorta\.online/i.test(frame.url())) || page;
}

const PHONE_SELECTORS = [
  'input[name*="phone" i]', 'input[name*="telefon" i]', 'input[name*="gsm" i]', 'input[name*="cep" i]',
  'input[id*="phone" i]', 'input[id*="telefon" i]', 'input[id*="gsm" i]', 'input[id*="cep" i]',
  'input[placeholder*="telefon" i]', 'input[placeholder*="gsm" i]', 'input[placeholder*="cep" i]', 'input[placeholder*="5__" i]',
  'input[type="tel"]:not([name*="kimlik" i]):not([id*="kimlik" i]):not([name*="identity" i]):not([id*="identity" i]):not([name*="tc" i]):not([id*="tc" i])',
];
const PHONE_LABELS = ["GSM", "Cep Telefonu", "Telefon"];

export async function fillQuoteForm(target, job) {
  const vehicle = job.vehicle;
  const phone10 = job.phone.replace(/^0/, "");
  const filled = {};
  filled.identity = await fillFirst(target, vehicle.identity,
    ['input[name*="identity" i]', 'input[name*="kimlik" i]', 'input[name*="tc" i]', 'input[placeholder*="TC" i]', 'input[placeholder*="kimlik" i]'],
    ["Kimlik Numarası", "TC Kimlik No", "TC/Vergi", "T.C. Kimlik", "TC Kimlik Numarası", "Vergi Kimlik No"]);
  await humanPause();
  filled.birthDate = await fillBirthDate(target, vehicle.birthDate);
  await humanPause();
  filled.plate = await fillFirst(target, vehicle.plate,
    ['input[name*="plate" i]', 'input[name*="plaka" i]', 'input[placeholder*="plaka" i]'], ["Plaka"]);
  await humanPause();
  filled.registration = await fillFirst(target, vehicle.registration,
    ['input[name*="registration" i]', 'input[name*="ruhsat" i]', 'input[name*="belge" i]', 'input[name*="tescil" i]', 'input[placeholder*="ruhsat" i]'],
    ["Ruhsat Numarası", "Ruhsat Seri", "Belge Seri", "Ruhsat Tescil Belge Seri No", "Tescil Belge Seri No", "Ruhsat Seri No"]);
  await fillSecondaryRegistrationFields(target, vehicle.registration);
  await humanPause();
  filled.phone = (await fillFirst(target, phone10, PHONE_SELECTORS, PHONE_LABELS)) || (await fillFirst(target, job.phone, PHONE_SELECTORS, PHONE_LABELS));
  await humanPause();
  filled.chassis = await fillFirst(target, vehicle.chassis,
    ['input[name*="chassis" i]', 'input[name*="sasi" i]'], ["Şasi Numarası", "Şasi No"]);
  filled.engine = await fillFirst(target, vehicle.engine,
    ['input[name*="engine" i]', 'input[name*="motor" i]'], ["Motor Numarası", "Motor No"]);
  await humanPause();
  await fillMatbuVehicleFields(target, vehicle);
  await humanPause();
  await fillNameAndEmail(target, job);
  await acceptRequiredConsents(target);
  return filled;
}

async function waitUntilEnabled(locator, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await locator.isEnabled({ timeout: 300 }).catch(() => false)) return true;
    await locator.page().waitForTimeout(300);
  }
  return false;
}

export async function clickSubmit(target) {
  for (const name of [/Gönder/i, /Teklif(?:i)? Al/i, /Sorgula/i, /Devam/i, /Hemen Teklif/i, /Doğrula/i, /Onayla/i, /Fiyat(?:ları)? (?:Gör|Getir|Hesapla)/i, /Karşılaştır/i, /Teklifleri Görüntüle/i, /Devam Et/i, /İleri/i, /Hesapla/i]) {
    try {
      const button = target.getByRole("button", { name }).first();
      if (!await button.isVisible({ timeout: 500 })) continue;
      if (await button.isEnabled({ timeout: 500 }) || await waitUntilEnabled(button, 2500)) {
        await button.click({ timeout: 5000 });
        return true;
      }
    } catch {}
  }
  for (const selector of ['button[type="submit"]', 'input[type="submit"]']) {
    try {
      const button = target.locator(selector).first();
      if (!await button.isVisible({ timeout: 500 })) continue;
      if (await button.isEnabled({ timeout: 500 }) || await waitUntilEnabled(button, 2500)) {
        await button.click({ timeout: 5000 });
        return true;
      }
    } catch {}
  }
  return false;
}

export async function clickNamedButton(target, names) {
  for (const name of names) {
    for (const role of ["button", "link"]) {
      try {
        const control = target.getByRole(role, { name }).first();
        if (await control.isVisible({ timeout: 500 }) && await control.isEnabled({ timeout: 500 })) {
          await control.click({ timeout: 5000 });
          return true;
        }
      } catch {}
    }
    try {
      const control = target.getByText(name, { exact: true }).first();
      if (await control.isVisible({ timeout: 500 }) && await control.isEnabled({ timeout: 500 })) {
        await control.click({ timeout: 5000 });
        return true;
      }
    } catch {}
  }
  return false;
}

export async function visibleText(target) {
  return (await target.locator("body").innerText({ timeout: 3000 }).catch(() => "")).slice(0, 300000);
}

export async function detectCaptcha(page, text) {
  if (/(VERIFY YOU ARE HUMAN|İNSAN OLDUĞUNUZU DOĞRULAYIN|ROBOT OLMADIĞINIZI|GÜVENLİK KONTROLÜ|CHECKING YOUR BROWSER)/i.test(text)) return true;
  return (await page.locator('iframe[src*="recaptcha" i], iframe[src*="hcaptcha" i], [class*="captcha" i], [id*="captcha" i]').count()) > 0;
}

export async function findOtpInput(target) {
  for (const selector of [
    'input[autocomplete="one-time-code"]', 'input[name*="otp" i]', 'input[name*="sms" i]', 'input[id*="otp" i]',
    'input[id*="sms" i]', 'input[placeholder*="doğrulama" i]', 'input[placeholder*="kod" i]',
  ]) {
    const input = target.locator(selector).first();
    if (await input.isVisible({ timeout: 300 }).catch(() => false)) return input;
  }
  const candidates = target.locator('input[inputmode="numeric"], input[type="number"], input[maxlength]');
  const count = Math.min(await candidates.count().catch(() => 0), 30);
  const singleCharacterInputs = [];
  for (let index = 0; index < count; index += 1) {
    const input = candidates.nth(index);
    if (!await input.isVisible({ timeout: 200 }).catch(() => false)) continue;
    const meta = await input.evaluate((element) => ({
      type: (element.getAttribute("type") || "text").toLowerCase(),
      maxLength: Number(element.getAttribute("maxlength") || element.maxLength || 0),
      semantic: [element.name, element.id, element.placeholder, element.getAttribute("aria-label"), element.parentElement?.innerText]
        .filter(Boolean).join(" ").toLocaleLowerCase("tr-TR"),
    })).catch(() => null);
    if (!meta || meta.type === "tel" || /(telefon|phone|gsm|cep|kimlik|identity|\btc\b|vergi|vkn|plaka|plate|ruhsat|registration|model|year|yıl|sasi|şasi|chassis|motor)/i.test(meta.semantic)) continue;
    if (meta.maxLength >= 4 && meta.maxLength <= 8) return input;
    if (meta.maxLength === 1) singleCharacterInputs.push(input);
  }
  if (singleCharacterInputs.length >= 4 && singleCharacterInputs.length <= 8) return singleCharacterInputs[0];
  return null;
}

export async function fillOtpCode(target, code) {
  const input = await findOtpInput(target);
  if (!input) return false;
  const maxLength = await input.evaluate((element) => Number(element.getAttribute("maxlength") || element.maxLength || 0)).catch(() => 0);
  if (maxLength !== 1) {
    await input.fill(code, { timeout: 4000 });
    return true;
  }

  const candidates = target.locator('input[maxlength="1"], input[inputmode="numeric"][maxlength="1"]');
  const count = Math.min(await candidates.count().catch(() => 0), 12);
  const visible = [];
  for (let index = 0; index < count; index += 1) {
    const candidate = candidates.nth(index);
    if (await candidate.isVisible({ timeout: 200 }).catch(() => false)) visible.push(candidate);
  }
  if (visible.length < code.length) return false;
  for (let index = 0; index < code.length; index += 1) await visible[index].fill(code[index], { timeout: 2000 });
  return true;
}

async function formSignature(target) {
  const controls = target.locator("input, select, textarea, button");
  const signature = await controls.evaluateAll((nodes) => nodes.filter((node) => {
    const style = window.getComputedStyle(node);
    return style.display !== "none" && style.visibility !== "hidden" && !node.disabled;
  }).slice(0, 100).map((node) => [
    node.tagName,
    node.getAttribute("type") || "",
    node.getAttribute("name") || "",
    node.id || "",
    node.getAttribute("placeholder") || "",
    node.tagName === "BUTTON" ? (node.textContent || "").trim().slice(0, 80) : "",
  ].join(":"))).catch(() => []);
  return JSON.stringify(signature);
}

async function quoteFormProfile(target) {
  const controls = target.locator("input, select, textarea, button");
  const items = await controls.evaluateAll((nodes) => nodes.filter((node) => {
    const style = window.getComputedStyle(node);
    return style.display !== "none" && style.visibility !== "hidden";
  }).slice(0, 120).map((node) => ({
    tag: node.tagName.toLowerCase(),
    type: node.getAttribute("type") || "",
    name: node.getAttribute("name") || "",
    id: node.id || "",
    placeholder: node.getAttribute("placeholder") || "",
    label: node.getAttribute("aria-label") || "",
    text: node.tagName === "BUTTON" ? (node.textContent || "").trim().slice(0, 100) : "",
  }))).catch(() => []);
  const haystack = items.map((item) => `${item.name} ${item.id} ${item.placeholder} ${item.label}`).join(" ");
  const buttonText = items.filter((item) => item.tag === "button" || item.type === "submit").map((item) => item.text).join(" ");
  return {
    controlCount: items.length,
    hasIdentity: /(identity|kimlik|\btc\b|vergi|vkn)/i.test(haystack),
    hasPlate: /(plate|plaka)/i.test(haystack),
    hasRegistration: /(registration|ruhsat|belge)/i.test(haystack),
    hasPhone: /(phone|telefon|gsm|cep)/i.test(haystack),
    hasSubmit: items.some((item) => item.type === "submit") || /(teklif|sorgula|devam|gönder|başla)/i.test(buttonText),
  };
}

async function openQuoteFlow(target, page) {
  let profile = await quoteFormProfile(target);
  for (let attempt = 0; attempt < 3; attempt += 1) {
    if ((profile.hasIdentity || profile.hasPlate || profile.hasRegistration) && profile.hasSubmit) return profile;
    const dismissed = await clickNamedButton(target, [/Şimdi Değil/i, /Vazgeç/i, /Daha Sonra/i, /Atla/i, /Kapat/i]);
    const opened = dismissed || await clickNamedButton(target, [
      /Trafik Sigortası Teklif/i,
      /Trafik Teklifi/i,
      /Teklif Al/i,
      /Hemen Teklif/i,
      /Fiyat Al/i,
      /Sorgula/i,
    ]);
    if (!opened) return profile;
    await page.waitForTimeout(1000);
    profile = await quoteFormProfile(target);
  }
  return profile;
}

export function pageState(text) {
  if (/(ÇOK FAZLA İSTEK|TOO MANY REQUESTS|RATE LIMIT|429)/i.test(text)) return "rate_limited";
  if (/(GİRİŞ YAP|OTURUM AÇ|KULLANICI ADI|ACENTE GİRİŞİ)/i.test(text) && /(ŞİFRE|PASSWORD)/i.test(text)) return "auth_required";
  if (/(TEKLİF BULUNAMADI|UYGUN TEKLİF YOK|FİYAT ALINAMADI|SONUÇ BULUNAMADI)/i.test(text)) return "no_offer";
  return null;
}

export async function waitForOutcome({ page, target, job, portal, resultTimeoutMs, requestOtp, setState, isCancelled, attemptedStages = new Set() }) {
  const startedAt = Date.now();
  let lastOffers = [];
  let lastOfferChangeAt = 0;
  let lastStage = "Portal formu gönderildi; cevap bekleniyor";
  const track = (status, message, extra) => {
    lastStage = message;
    return setState(status, message, extra);
  };
  while (Date.now() - startedAt < resultTimeoutMs) {
    if (isCancelled()) return { status: "cancelled", message: "Sorgu iptal edildi" };
    const text = await visibleText(target);
    if (await detectCaptcha(page, text)) return { status: "manual_required", message: "CAPTCHA / güvenlik kontrolü kullanıcı tarafından tamamlanmalı" };
    const detectedState = pageState(text);
    if (detectedState) return { status: detectedState, message: detectedState === "no_offer" ? "Portal teklif bulunamadığını bildirdi" : "Portal oturum veya hız sınırı bildirdi" };

    const otpInput = await findOtpInput(target);
    const smsLanguage = /(SMS|TEK KULLANIMLIK|DOĞRULAMA KODU|ONAY KODU|CEP TELEFONUNUZA)/i.test(text);
    if (otpInput && smsLanguage) {
      if (job.mode === "no_sms") return { status: "skipped_sms", message: "SMS istendiği için atlandı" };
      let code = await requestOtp();
      while (code === RESEND_SENTINEL) {
        const resent = await clickNamedButton(target, [/Tekrar Gönder/i, /Yeniden Gönder/i, /Kod(?:u)? Gönder/i, /SMS Gönder/i]);
        if (!resent) return { status: "mapping_required", message: "Kodu tekrar gönderme düğmesi bulunamadı" };
        code = await requestOtp();
      }
      if (!await fillOtpCode(target, code)) return { status: "mapping_required", message: "SMS kodu alanı doldurulamadı" };
      if (!await clickSubmit(target)) await otpInput.press("Enter").catch(() => {});
      await track("collecting", "SMS doğrulandı; gerçek teklifler bekleniyor");
      await page.waitForTimeout(1200);
      continue;
    }

    const offers = extractOffersFromText(text, portal);
    if (offers.length) {
      const fingerprint = JSON.stringify(offers.map((offer) => [offer.company, offer.price]));
      const previousFingerprint = JSON.stringify(lastOffers.map((offer) => [offer.company, offer.price]));
      if (fingerprint !== previousFingerprint) {
        lastOffers = offers;
        lastOfferChangeAt = Date.now();
      }
      if (Date.now() - lastOfferChangeAt >= 8000) return { status: "completed", message: `${offers.length} şirket teklifi alındı`, offers };
    }
    if (/(TEKLİF SONUÇLARI|TEKLİFLER SORGULANIYOR|SORGULAMA DURUMU|FİYATLAR HAZIRLANIYOR)/i.test(text)) {
      await track("collecting", "Sigorta şirketlerinden fiyat bekleniyor");
    }

    const signature = await formSignature(target);
    if (signature !== "[]" && !attemptedStages.has(signature)) {
      attemptedStages.add(signature);
      const filled = await fillQuoteForm(target, job);
      const filledCount = Object.values(filled).filter(Boolean).length;
      if (filledCount && await clickSubmit(target)) {
        await track("submitted", "Portalın sonraki adımı dolduruldu; cevap bekleniyor");
        await page.waitForTimeout(1000);
        continue;
      }
    }
    await page.waitForTimeout(2000);
  }
  if (lastOffers.length) return { status: "completed", message: `${lastOffers.length} şirket teklifi alındı`, offers: lastOffers };
  return {
    status: "timeout",
    message: `Portal cevap vermedi; teklif yok olarak işaretlenmedi (son aşama: ${lastStage})`,
    diagnostics: { lastVisibleText: (await visibleText(target)).replace(/\s+/g, " ").trim().slice(0, 400) },
  };
}

export class FormPortalAdapter {
  async probe({ page, portal, navigationTimeoutMs }) {
    await page.goto(portal.url, { waitUntil: "domcontentloaded", timeout: navigationTimeoutMs });
    await page.waitForTimeout(700);
    const text = await visibleText(page);
    if (await detectCaptcha(page, text)) return { state: "manual_required", message: "CAPTCHA / güvenlik doğrulaması gerekiyor" };
    const state = pageState(text);
    if (state) return { state, message: state === "auth_required" ? "Portal oturumu gerekiyor" : "Portal isteği kabul etmedi" };
    const target = await resolveTarget(page, portal);
    const profile = await openQuoteFlow(target, page);
    const formDetected = (profile.hasIdentity || profile.hasPlate || profile.hasRegistration) && profile.hasSubmit;
    return {
      state: formDetected ? "form_detected" : "mapping_required",
      message: formDetected ? "Canlı teklif formu bulundu" : "Teklif formu veya başlangıç düğmesi bulunamadı",
      fields: profile,
    };
  }

  async run(context) {
    const { page, portal, job, navigationTimeoutMs, resultTimeoutMs, setState, requestOtp, isCancelled } = context;
    await setState("opening", "Portal açılıyor");
    await page.goto(portal.url, { waitUntil: "domcontentloaded", timeout: navigationTimeoutMs });
    await page.waitForTimeout(800);
    if (isCancelled()) return { status: "cancelled", message: "Sorgu iptal edildi" };

    const firstText = await visibleText(page);
    if (await detectCaptcha(page, firstText)) return { status: "manual_required", message: "CAPTCHA / güvenlik kontrolü kullanıcı tarafından tamamlanmalı" };
    const initialState = pageState(firstText);
    if (initialState) return { status: initialState, message: initialState === "auth_required" ? "Portal oturumu açılmalı" : "Portal isteği kabul etmedi" };

    const target = await resolveTarget(page, portal);
    const profile = await openQuoteFlow(target, page);
    if (!(profile.hasIdentity || profile.hasPlate || profile.hasRegistration)) {
      return { status: "mapping_required", message: "Portalın canlı teklif başlangıç formu bulunamadı", diagnostics: { fields: profile } };
    }
    await setState("filling", "Araç ve müşteri bilgileri dolduruluyor");
    const filled = await fillQuoteForm(target, job);
    if (!filled.identity && !filled.plate && !filled.registration) return { status: "mapping_required", message: "İlk adımdaki kimlik, plaka veya ruhsat alanı eşleştirilemedi" };
    const attemptedStages = new Set([await formSignature(target)]);
    if (!await clickSubmit(target)) return { status: "mapping_required", message: "Sorgu düğmesi eşleştirilemedi" };

    await setState("submitted", "Form gönderildi; portal cevabı bekleniyor");
    return waitForOutcome({ page, target, job, portal, resultTimeoutMs, requestOtp, setState, isCancelled, attemptedStages });
  }
}
