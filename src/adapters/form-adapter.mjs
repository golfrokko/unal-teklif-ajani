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

async function fillQuoteForm(target, job) {
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
      ['input[type="tel"]', 'input[name*="phone" i]', 'input[name*="gsm" i]', 'input[placeholder*="5__" i]'],
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
  return null;
}

export function pageState(text) {
  if (/(ÇOK FAZLA İSTEK|TOO MANY REQUESTS|RATE LIMIT|429)/i.test(text)) return "rate_limited";
  if (/(GİRİŞ YAP|OTURUM AÇ|KULLANICI ADI|ACENTE GİRİŞİ)/i.test(text) && /(ŞİFRE|PASSWORD)/i.test(text)) return "auth_required";
  if (/(TEKLİF BULUNAMADI|UYGUN TEKLİF YOK|FİYAT ALINAMADI|SONUÇ BULUNAMADI)/i.test(text)) return "no_offer";
  return null;
}

export async function waitForOutcome({ page, target, job, portal, resultTimeoutMs, requestOtp, setState, isCancelled }) {
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
      await otpInput.fill(code, { timeout: 4000 });
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
    await page.waitForTimeout(2000);
  }
  if (lastOffers.length) return { status: "completed", message: `${lastOffers.length} şirket teklifi alındı`, offers: lastOffers };
  return { status: "timeout", message: "Portal cevap vermedi; teklif yok olarak işaretlenmedi" };
}

export class FormPortalAdapter {
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
    await setState("filling", "Araç ve müşteri bilgileri dolduruluyor");
    const filled = await fillQuoteForm(target, job);
    if (!filled.identity || !filled.plate) return { status: "mapping_required", message: "Zorunlu alanlar bu portal için eşleştirilemedi" };
    if (!await clickSubmit(target)) return { status: "mapping_required", message: "Sorgu düğmesi eşleştirilemedi" };

    await setState("submitted", "Form gönderildi; portal cevabı bekleniyor");
    return waitForOutcome({ page, target, job, portal, resultTimeoutMs, requestOtp, setState, isCancelled });
  }
}
