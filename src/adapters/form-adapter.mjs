import { extractOffersFromText } from "../lib/results.mjs";

function escapeRegex(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

export async function fillFirst(target, value, selectors, labelTerms) {
  if (!value) return false;
  for (const selector of selectors) {
    try {
      const input = target.locator(selector).first();
      if (await input.isVisible({ timeout: 400 })) {
        await input.fill(value, { timeout: 3000 });
        return true;
      }
    } catch {}
  }
  for (const term of labelTerms) {
    try {
      const input = target.getByLabel(new RegExp(escapeRegex(term), "i")).first();
      if (await input.isVisible({ timeout: 400 })) {
        await input.fill(value, { timeout: 3000 });
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
        await inside.fill(value, { timeout: 3000 });
        return true;
      }
      const forId = await label.getAttribute("for");
      if (forId) {
        await target.locator(`[id="${forId.replace(/(["\\])/g, "\\$1")}"]`).first().fill(value, { timeout: 3000 });
        return true;
      }
    } catch {}
  }
  return false;
}

export async function acceptRequiredConsents(target) {
  const labels = target.locator("label");
  const count = Math.min(await labels.count(), 140);
  for (let index = 0; index < count; index += 1) {
    const label = labels.nth(index);
    const text = (await label.innerText({ timeout: 300 }).catch(() => "")).toLocaleUpperCase("tr-TR");
    if (!/(KVKK|AYDINLATMA|KULLANICI SÖZLEŞMESİ|GİZLİLİK SÖZLEŞMESİ|KİŞİSEL VERİ)/.test(text)) continue;
    const input = label.locator('input[type="checkbox"]').first();
    if (await input.count()) await input.check({ force: true }).catch(() => {});
  }
}

export async function resolveTarget(page, portal) {
  if (portal.adapter !== "ihsan-frame") return page;
  await page.waitForTimeout(1200);
  return page.frames().find((frame) => frame !== page.mainFrame() && /sigorta\.online/i.test(frame.url())) || page;
}

export async function fillQuoteForm(target, job) {
  const vehicle = job.vehicle;
  const phone10 = job.phone.replace(/^0/, "");
  const filled = {
    identity: await fillFirst(target, vehicle.identity,
      ['input[name*="identity" i]', 'input[name*="kimlik" i]', 'input[name*="tc" i]', 'input[placeholder*="TC" i]', 'input[placeholder*="kimlik" i]'],
      ["Kimlik Numarası", "TC Kimlik No", "TC/Vergi", "T.C. Kimlik"]),
    birthDate: await fillFirst(target, vehicle.birthDate,
      ['input[name*="birth" i]', 'input[name*="dogum" i]', 'input[placeholder*="GG.AA.YYYY" i]'], ["Doğum Tarihi"]),
    plate: await fillFirst(target, vehicle.plate,
      ['input[name*="plate" i]', 'input[name*="plaka" i]', 'input[placeholder*="plaka" i]'], ["Plaka"]),
    registration: await fillFirst(target, vehicle.registration,
      ['input[name*="registration" i]', 'input[name*="ruhsat" i]', 'input[name*="belge" i]', 'input[placeholder*="ruhsat" i]'],
      ["Ruhsat Numarası", "Ruhsat Seri", "Belge Seri"]),
    phone: await fillFirst(target, phone10,
      [
        'input[name*="phone" i]', 'input[name*="telefon" i]', 'input[name*="gsm" i]', 'input[name*="cep" i]',
        'input[id*="phone" i]', 'input[id*="telefon" i]', 'input[id*="gsm" i]', 'input[id*="cep" i]',
        'input[placeholder*="telefon" i]', 'input[placeholder*="gsm" i]', 'input[placeholder*="cep" i]', 'input[placeholder*="5__" i]',
        'input[type="tel"]:not([name*="kimlik" i]):not([id*="kimlik" i]):not([name*="identity" i]):not([id*="identity" i]):not([name*="tc" i]):not([id*="tc" i])',
      ],
      ["GSM", "Cep Telefonu", "Telefon"]),
    chassis: await fillFirst(target, vehicle.chassis,
      ['input[name*="chassis" i]', 'input[name*="sasi" i]'], ["Şasi Numarası", "Şasi No"]),
    engine: await fillFirst(target, vehicle.engine,
      ['input[name*="engine" i]', 'input[name*="motor" i]'], ["Motor Numarası", "Motor No"]),
  };
  await acceptRequiredConsents(target);
  return filled;
}

export async function clickSubmit(target) {
  for (const name of [/Gönder/i, /Teklif(?:i)? Al/i, /Sorgula/i, /Devam/i, /Hemen Teklif/i, /Doğrula/i, /Onayla/i]) {
    try {
      const button = target.getByRole("button", { name }).first();
      if (await button.isVisible({ timeout: 500 }) && await button.isEnabled({ timeout: 500 })) {
        await button.click({ timeout: 5000 });
        return true;
      }
    } catch {}
  }
  for (const selector of ['button[type="submit"]', 'input[type="submit"]']) {
    try {
      const button = target.locator(selector).first();
      if (await button.isVisible({ timeout: 500 }) && await button.isEnabled({ timeout: 500 })) {
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
  const before = await quoteFormProfile(target);
  if ((before.hasIdentity || before.hasPlate || before.hasRegistration) && before.hasSubmit) return before;
  const opened = await clickNamedButton(target, [
    /Trafik Sigortası Teklif/i,
    /Trafik Teklifi/i,
    /Teklif Al/i,
    /Hemen Teklif/i,
    /Fiyat Al/i,
  ]);
  if (!opened) return before;
  await page.waitForTimeout(1000);
  return quoteFormProfile(target);
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
      const code = await requestOtp();
      if (!await fillOtpCode(target, code)) return { status: "mapping_required", message: "SMS kodu alanı doldurulamadı" };
      if (!await clickSubmit(target)) await otpInput.press("Enter").catch(() => {});
      await setState("collecting", "SMS doğrulandı; gerçek teklifler bekleniyor");
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
      await setState("collecting", "Sigorta şirketlerinden fiyat bekleniyor");
    }

    const signature = await formSignature(target);
    if (signature !== "[]" && !attemptedStages.has(signature)) {
      attemptedStages.add(signature);
      const filled = await fillQuoteForm(target, job);
      const filledCount = Object.values(filled).filter(Boolean).length;
      if (filledCount && await clickSubmit(target)) {
        await setState("submitted", "Portalın sonraki adımı dolduruldu; cevap bekleniyor");
        await page.waitForTimeout(1000);
        continue;
      }
    }
    await page.waitForTimeout(2000);
  }
  if (lastOffers.length) return { status: "completed", message: `${lastOffers.length} şirket teklifi alındı`, offers: lastOffers };
  return { status: "timeout", message: "Portal cevap vermedi; teklif yok olarak işaretlenmedi" };
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
