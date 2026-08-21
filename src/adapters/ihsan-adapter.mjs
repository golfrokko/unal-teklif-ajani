import { extractOffersFromText } from "../lib/results.mjs";
import {
  acceptRequiredConsents,
  clickNamedButton,
  clickSubmit,
  detectCaptcha,
  fillFirst,
  findOtpInput,
  pageState,
  resolveTarget,
  visibleText,
} from "./form-adapter.mjs";

const BLOCK_PATTERN = /(SORRY, YOU HAVE BEEN BLOCKED|YOU ARE UNABLE TO ACCESS|ACCESS DENIED|ERİŞİM ENGELLENDİ|REQUEST BLOCKED)/i;
const VALIDATION_PATTERN = /(LÜTFEN GEÇERLİ|BU ALAN ZORUNLUDUR|ALANI ZORUNLUDUR|DEVAM ETMEK İÇİN BU ALANI|EKSİK BİLGİ)/i;
const RESULT_PROGRESS_PATTERN = /(TEKLİF SONUÇLARI|TEKLİFLER SORGULANIYOR|SORGULAMA DURUMU|FİYATLAR HAZIRLANIYOR|ŞİRKETLERDEN TEKLİF)/i;
const SESSION_SMS_PATTERN = /(SMS|TEK KULLANIMLIK|DOĞRULAMA KODU|ONAY KODU|CEP TELEFONUNUZA)/i;

function normalize(value) {
  return String(value || "")
    .toLocaleUpperCase("tr-TR")
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/[^A-Z0-9]+/g, " ")
    .trim();
}

export function chooseBestOption(options, candidates) {
  const wanted = candidates.map(normalize).filter(Boolean);
  let best = null;
  for (const option of options) {
    if (option.disabled || !String(option.value || "").trim()) continue;
    const label = normalize(option.label);
    if (!label || /^(SECINIZ|SEÇINIZ|SEC|SEÇ)$/.test(label)) continue;
    for (const candidate of wanted) {
      const candidateTokens = new Set(candidate.split(" ").filter((token) => token.length > 1));
      const labelTokens = new Set(label.split(" ").filter((token) => token.length > 1));
      const overlap = [...labelTokens].filter((token) => candidateTokens.has(token)).length;
      const score = label === candidate ? 1000 : candidate.includes(label) ? 700 + label.length : label.includes(candidate) ? 600 + candidate.length : overlap * 100;
      if (score > 0 && (!best || score > best.score)) best = { ...option, score };
    }
  }
  return best;
}

async function selectLabeled(target, { labels, selectors, candidates }) {
  const locators = [];
  for (const label of labels) locators.push(target.getByLabel(new RegExp(label, "i")).first());
  for (const selector of selectors) locators.push(target.locator(selector).first());
  for (const select of locators) {
    if (!await select.isVisible({ timeout: 350 }).catch(() => false)) continue;
    const tagName = await select.evaluate((element) => element.tagName.toLowerCase()).catch(() => "");
    if (tagName !== "select") continue;
    const options = await select.locator("option").evaluateAll((nodes) => nodes.slice(0, 250).map((node) => ({
      value: node.value,
      label: node.textContent?.trim() || "",
      disabled: node.disabled,
      selected: node.selected,
    })));
    if (options.some((option) => option.selected && !option.disabled && String(option.value || "").trim())) return true;
    const option = chooseBestOption(options, candidates);
    if (!option) continue;
    await select.selectOption(option.value, { timeout: 4000 });
    return true;
  }
  return false;
}

async function anyVisible(target, selectors) {
  for (const selector of selectors) {
    if (await target.locator(selector).first().isVisible({ timeout: 250 }).catch(() => false)) return true;
  }
  return false;
}

async function revealDynamicSection(target, page) {
  const selectors = ["#aracCinsi", "#aracModelYil", "#aracMarka", "#aracModeli", "#sasiNo", "#motorNo"];
  if (await anyVisible(target, selectors)) return true;
  const opened = await clickNamedButton(target, [/^Ekstra Bilgiler$/i, /Araç Bilgileri/i]);
  if (!opened) return false;
  await page.waitForTimeout(450);
  return anyVisible(target, selectors);
}

async function missingVisibleDynamicFields(target) {
  const fields = [
    ["araç cinsi", "#aracCinsi"],
    ["model yılı", "#aracModelYil"],
    ["marka kodu", "#aracMarkaKodu"],
    ["araç markası", "#aracMarka"],
    ["tip kodu", "#aracTipKodu"],
    ["araç tipi", "#aracModeli"],
    ["şasi numarası", "#sasiNo"],
    ["motor numarası", "#motorNo"],
  ];
  const missing = [];
  for (const [label, selector] of fields) {
    const control = target.locator(selector).first();
    if (!await control.isVisible({ timeout: 200 }).catch(() => false)) continue;
    const value = await control.inputValue({ timeout: 500 }).catch(() => "");
    if (!String(value || "").trim()) missing.push(label);
  }
  return missing;
}

function vehicleCandidates(vehicleText) {
  const text = String(vehicleText || "").trim();
  const values = [text];
  if (/KAMYONET|PANELVAN/i.test(text)) values.push("KAMYONET");
  else if (/MOTOS[Iİ]KLET|MOTOR/i.test(text)) values.push("MOTOSİKLET", "MOTOSIKLET");
  else if (text) values.push("OTOMOBİL", "OTOMOBIL");
  return values;
}

async function fillIhsanFields(target, job, { includeDynamic = false, page = null } = {}) {
  const vehicle = job.vehicle;
  const filled = {
    identity: await fillFirst(target, vehicle.identity,
      ['input[placeholder*="kimlik numaranızı" i]', 'input[name*="identity" i]', 'input[name*="kimlik" i]', 'input[name*="tc" i]'],
      ["Kimlik Numarası", "TC Kimlik No", "TC/Vergi"]),
    birthDate: await fillFirst(target, vehicle.birthDate,
      ['input[placeholder="GG.AA.YYYY"]', 'input[name*="birth" i]', 'input[name*="dogum" i]'], ["Doğum Tarihi"]),
    plate: await fillFirst(target, vehicle.plate,
      ['input[placeholder*="34 ABC" i]', 'input[name*="plate" i]', 'input[name*="plaka" i]'], ["Plaka"]),
    registration: await fillFirst(target, vehicle.registration,
      ['input[placeholder*="Ruhsat numaranızı" i]', 'input[name*="registration" i]', 'input[name*="ruhsat" i]', 'input[name*="belge" i]'],
      ["Ruhsat Numarası", "Ruhsat Seri", "Belge Seri"]),
  };

  if (includeDynamic) {
    filled.vehicleType = await selectLabeled(target, {
      labels: ["Araç Cinsi"], selectors: ['select[name*="vehicle" i]', 'select[name*="arac" i]', 'select[name*="cins" i]'],
      candidates: vehicleCandidates(vehicle.vehicle),
    });
    if (filled.vehicleType) await page?.waitForTimeout(350);
    filled.yearSelect = await selectLabeled(target, {
      labels: ["Araç Model Yılı", "Model Yılı"], selectors: ['select[name*="year" i]', 'select[name*="modelY" i]', 'select[name*="yil" i]'],
      candidates: [vehicle.year],
    });
    if (filled.yearSelect) await page?.waitForTimeout(250);
    filled.brandSelect = await selectLabeled(target, {
      labels: ["Araç Markası", "Marka"], selectors: ['select[name*="brand" i]', 'select[name*="marka" i]'],
      candidates: [vehicle.vehicle],
    });
    if (filled.brandSelect) await page?.waitForTimeout(500);
    filled.typeSelect = await selectLabeled(target, {
      labels: ["Araç Tipi", "Tip"], selectors: ['select[name*="type" i]', 'select[name*="tip" i]'],
      candidates: [vehicle.vehicle],
    });
    filled.yearInput = await fillFirst(target, vehicle.year,
      ['input[name*="year" i]', 'input[name*="modelY" i]', 'input[name*="yil" i]'], ["Araç Model Yılı", "Model Yılı"]);
    filled.chassis = await fillFirst(target, vehicle.chassis,
      ['input[placeholder*="Şasi numarasını" i]', 'input[name*="chassis" i]', 'input[name*="sasi" i]'], ["Şasi Numarası", "Şasi No"]);
    filled.engine = await fillFirst(target, vehicle.engine,
      ['input[placeholder*="Motor numarasını" i]', 'input[name*="engine" i]', 'input[name*="motor" i]'], ["Motor Numarası", "Motor No"]);
  }
  await acceptRequiredConsents(target);
  return filled;
}

async function pageProfile(target, page) {
  const controls = await target.locator("input,select,textarea,button").evaluateAll((nodes) => nodes.slice(0, 120).map((node) => ({
    tag: node.tagName.toLowerCase(),
    type: node.getAttribute("type") || "",
    name: node.getAttribute("name") || "",
    id: node.id || "",
    placeholder: node.getAttribute("placeholder") || "",
    ariaLabel: node.getAttribute("aria-label") || "",
    text: node.tagName === "BUTTON" ? (node.textContent?.trim() || "").slice(0, 80) : "",
    visible: Boolean(node.offsetWidth || node.offsetHeight || node.getClientRects().length),
  }))).catch(() => []);
  const labels = await target.locator("label").allTextContents().catch(() => []);
  return {
    url: String(page.url()).slice(0, 300),
    labels: labels.map((value) => value.replace(/\s+/g, " ").trim()).filter(Boolean).slice(0, 80),
    controls,
  };
}

async function waitForSessionOtp(target, page, timeoutMs = 15000) {
  const startedAt = Date.now();
  while (Date.now() - startedAt < timeoutMs) {
    const otpInput = await findOtpInput(target);
    if (otpInput) return otpInput;
    await page.waitForTimeout(500);
  }
  return null;
}

async function sessionDialogTarget(target) {
  const dialogs = target.locator('[role="dialog"], .modal.show, dialog[open], .offcanvas.show');
  const count = Math.min(await dialogs.count().catch(() => 0), 20);
  for (let index = count - 1; index >= 0; index -= 1) {
    const dialog = dialogs.nth(index);
    if (await dialog.isVisible({ timeout: 250 }).catch(() => false)) return dialog;
  }
  return target;
}

async function sessionTargetText(loginTarget, fallbackTarget) {
  if (loginTarget !== fallbackTarget) {
    const text = await loginTarget.innerText({ timeout: 3000 }).catch(() => "");
    if (text) return text.slice(0, 50000);
  }
  return visibleText(fallbackTarget);
}

async function namedControlVisible(target, names) {
  for (const name of names) {
    for (const role of ["button", "link"]) {
      if (await target.getByRole(role, { name }).first().isVisible({ timeout: 300 }).catch(() => false)) return true;
    }
    if (await target.getByText(name, { exact: true }).first().isVisible({ timeout: 300 }).catch(() => false)) return true;
  }
  return false;
}

async function fillSessionPhone(target, phone) {
  return fillFirst(target, phone.replace(/^0/, ""),
    [
      'input[name*="phone" i]', 'input[name*="telefon" i]', 'input[name*="gsm" i]',
      'input[name*="cep" i]', 'input[id*="phone" i]', 'input[id*="telefon" i]', 'input[id*="gsm" i]',
      'input[id*="cep" i]', 'input[placeholder*="telefon" i]', 'input[placeholder*="gsm" i]', 'input[placeholder*="cep" i]',
      'input[type="tel"]:not([name*="kimlik" i]):not([id*="kimlik" i]):not([name*="identity" i]):not([id*="identity" i]):not([name*="tc" i]):not([id*="tc" i])',
    ],
    ["GSM", "Cep Telefonu", "Telefon Numarası", "Telefon"]);
}

async function latestSessionTarget(page, target, portal) {
  const pages = page.context().pages().filter((candidate) => !candidate.isClosed());
  const latest = pages.at(-1);
  if (!latest || latest === page) return target;
  await latest.waitForLoadState("domcontentloaded", { timeout: 5000 }).catch(() => {});
  return resolveTarget(latest, portal);
}

async function completeSessionLogin({ page, target, job, portal, requestOtp, setState, openIfNeeded = true }) {
  if (portal.smsPolicy !== "session_once" || job.mode !== "ask_sms") return null;
  let loginTarget = await sessionDialogTarget(target);
  let otpInput = await findOtpInput(loginTarget);
  let phoneFilled = false;
  if (!otpInput) {
    phoneFilled = await fillSessionPhone(loginTarget, job.phone);
  }

  let opened = false;
  if (!otpInput && !phoneFilled && openIfNeeded) {
    const loginVisible = await namedControlVisible(target, [/^Giriş Yap$/i]);
    if (!loginVisible) return null;
    await setState("opening", "Portal oturumu için SMS doğrulaması hazırlanıyor");
    if (!await clickNamedButton(target, [/^Giriş Yap$/i])) return null;
    opened = true;
    await page.waitForTimeout(700);
    const activeTarget = await latestSessionTarget(page, target, portal);
    loginTarget = await sessionDialogTarget(activeTarget);
    otpInput = await findOtpInput(loginTarget);
    if (!otpInput) phoneFilled = await fillSessionPhone(loginTarget, job.phone);
  }

  if (!otpInput) {
    if (!phoneFilled) {
      if (!opened) return null;
      const text = await sessionTargetText(loginTarget, target);
      return {
        status: "auth_required",
        message: /(ŞİFRE|PASSWORD|E-?POSTA)/i.test(text)
          ? "Lion oturumu kullanıcı adı/şifre istiyor; portal oturumu bir kez manuel açılmalı"
          : "Lion giriş penceresindeki telefon alanı eşleştirilemedi",
        diagnostics: await pageProfile(loginTarget, page),
      };
    }
    const sent = await clickNamedButton(loginTarget, [/Kod(?:u)? Gönder/i, /SMS Gönder/i, /Devam/i, /^Giriş Yap$/i]);
    if (!sent) {
      return { status: "mapping_required", message: "Lion SMS gönderme düğmesi eşleştirilemedi", diagnostics: await pageProfile(loginTarget, page) };
    }
    otpInput = await waitForSessionOtp(loginTarget, page);
  }

  const loginText = await sessionTargetText(loginTarget, target);
  if (!otpInput) {
    return { status: "auth_required", message: "Lion SMS kodu alanına geçemedi", diagnostics: await pageProfile(loginTarget, page) };
  }

  const code = await requestOtp();
  await otpInput.fill(code, { timeout: 4000 });
  if (!await clickNamedButton(loginTarget, [/Doğrula/i, /Onayla/i, /^Giriş Yap$/i, /Devam/i])) await otpInput.press("Enter").catch(() => {});
  await page.waitForTimeout(1100);
  const stillWaiting = await findOtpInput(loginTarget);
  if (stillWaiting && SESSION_SMS_PATTERN.test(loginText)) {
    return { status: "auth_required", message: "Lion SMS kodunu kabul etmedi; kodu ve süresini kontrol edin", diagnostics: await pageProfile(loginTarget, page) };
  }
  await setState("filling", "Lion oturumu açıldı; araç sorgusu hazırlanıyor");
  return { handled: true };
}

function missingInputMessage(job) {
  const missing = [];
  if (!job.vehicle.registration) missing.push("ruhsat seri numarası");
  if (job.vehicle.identity.length === 11 && !job.vehicle.birthDate) missing.push("doğum tarihi");
  if (!missing.length) return null;
  return `İhsan altyapılı portal için ${missing.join(" ve ")} zorunludur`;
}

async function waitForIhsanOutcome({ page, target, job, portal, resultTimeoutMs, requestOtp, setState, isCancelled }) {
  const startedAt = Date.now();
  let dynamicAttempted = false;
  let lastOffers = [];
  let lastOfferChangeAt = 0;
  let sessionChallengeCompleted = false;
  while (Date.now() - startedAt < resultTimeoutMs) {
    if (isCancelled()) return { status: "cancelled", message: "Sorgu iptal edildi" };
    const text = await visibleText(target);
    if (BLOCK_PATTERN.test(text)) return { status: "access_blocked", message: "Portal güvenlik duvarı bu sunucunun erişimini engelledi" };
    if (await detectCaptcha(page, text)) return { status: "manual_required", message: "CAPTCHA / güvenlik kontrolü kullanıcı tarafından tamamlanmalı" };

    if (!sessionChallengeCompleted) {
      const sessionOutcome = await completeSessionLogin({ page, target, job, portal, requestOtp, setState, openIfNeeded: false });
      if (sessionOutcome?.status) return sessionOutcome;
      if (sessionOutcome?.handled) {
        sessionChallengeCompleted = true;
        await page.waitForTimeout(900);
        continue;
      }
    }
    const detectedState = pageState(text);
    if (detectedState) return { status: detectedState, message: detectedState === "no_offer" ? "Portal teklif bulunamadığını bildirdi" : "Portal oturum veya hız sınırı bildirdi" };

    const otpInput = await findOtpInput(target);
    const smsLanguage = SESSION_SMS_PATTERN.test(text);
    if (otpInput && smsLanguage) {
      if (job.mode === "no_sms") return { status: "skipped_sms", message: "SMS istendiği için atlandı" };
      const code = await requestOtp();
      await otpInput.fill(code, { timeout: 4000 });
      if (!await clickSubmit(target)) await otpInput.press("Enter").catch(() => {});
      await setState("collecting", "SMS doğrulandı; gerçek teklifler bekleniyor");
      await page.waitForTimeout(1000);
      continue;
    }

    const offers = extractOffersFromText(text, portal);
    if (offers.length) {
      const fingerprint = JSON.stringify(offers.map((offer) => [offer.company, offer.price]));
      if (fingerprint !== JSON.stringify(lastOffers.map((offer) => [offer.company, offer.price]))) {
        lastOffers = offers;
        lastOfferChangeAt = Date.now();
      }
      if (Date.now() - lastOfferChangeAt >= 5000) return { status: "completed", message: `${offers.length} şirket teklifi doğrulandı`, offers };
    }

    const hasDynamicStep = /(EKSTRA BİLGİLER|ARAÇ CİNSİ|ARAÇ MODEL YILI|MARKA KODU|ŞASİ NUMARASI)/i.test(text);
    if (hasDynamicStep && !dynamicAttempted) {
      dynamicAttempted = true;
      await setState("filling", "Portalın istediği ek araç bilgileri dolduruluyor");
      const revealed = await revealDynamicSection(target, page);
      if (!revealed) {
        return { status: "mapping_required", message: "Ekstra araç bilgileri bölümü açılamadı", diagnostics: await pageProfile(target, page) };
      }
      const dynamic = await fillIhsanFields(target, job, { includeDynamic: true, page });
      const changed = ["vehicleType", "yearSelect", "brandSelect", "typeSelect", "yearInput", "chassis", "engine"]
        .some((key) => dynamic[key]);
      const missingDynamic = await missingVisibleDynamicFields(target);
      if (missingDynamic.length) {
        return {
          status: "input_required",
          message: `Portalın ek araç alanları tamamlanamadı: ${missingDynamic.join(", ")}`,
          diagnostics: await pageProfile(target, page),
        };
      }
      if (changed && await clickSubmit(target)) {
        await setState("submitted", "Ek araç bilgileri gönderildi; portal cevabı bekleniyor");
        await page.waitForTimeout(1200);
        continue;
      }
    }

    if (VALIDATION_PATTERN.test(text) && dynamicAttempted) {
      return {
        status: "input_required",
        message: "Portal ek araç bilgilerini doğrulayamadı; marka/model, yıl, şasi ve motor alanlarını kontrol edin",
        diagnostics: await pageProfile(target, page),
      };
    }
    if (RESULT_PROGRESS_PATTERN.test(text)) await setState("collecting", "Sigorta şirketlerinden doğrulanmış fiyat bekleniyor");
    await page.waitForTimeout(1500);
  }
  if (lastOffers.length) return { status: "completed", message: `${lastOffers.length} şirket teklifi doğrulandı`, offers: lastOffers };
  return { status: "timeout", message: "Portal süre içinde doğrulanmış teklif veya teklif-yok cevabı vermedi", diagnostics: await pageProfile(target, page) };
}

export class IhsanPortalAdapter {
  async probe({ page, portal, navigationTimeoutMs }) {
    await page.goto(portal.url, { waitUntil: "domcontentloaded", timeout: navigationTimeoutMs });
    await page.waitForTimeout(900);
    const text = await visibleText(page);
    if (BLOCK_PATTERN.test(text)) return { state: "access_blocked", message: "Güvenlik duvarı erişimi engelledi" };
    if (await detectCaptcha(page, text)) return { state: "manual_required", message: "Güvenlik doğrulaması gerekiyor" };
    const target = await resolveTarget(page, portal);
    const profile = await pageProfile(target, page);
    const hasIdentity = profile.labels.some((label) => /KİMLİK/i.test(label)) || profile.controls.some((control) => /kimlik|identity|\btc\b/i.test(`${control.name} ${control.placeholder}`));
    const hasPlate = profile.labels.some((label) => /PLAKA/i.test(label)) || profile.controls.some((control) => /plaka|plate/i.test(`${control.name} ${control.placeholder}`));
    let sessionProfile = null;
    if (portal.smsPolicy === "session_once" && await namedControlVisible(target, [/^Giriş Yap$/i])) {
      await clickNamedButton(target, [/^Giriş Yap$/i]);
      await page.waitForTimeout(700);
      const activeTarget = await latestSessionTarget(page, target, portal);
      const loginTarget = await sessionDialogTarget(activeTarget);
      sessionProfile = await pageProfile(loginTarget, page);
    }
    return {
      state: hasIdentity && hasPlate ? "form_detected" : "mapping_required",
      ...profile,
      ...(sessionProfile ? { sessionProfile } : {}),
    };
  }

  async run(context) {
    const { page, portal, job, navigationTimeoutMs, resultTimeoutMs, setState, requestOtp, isCancelled } = context;
    const missing = missingInputMessage(job);
    if (missing) return { status: "input_required", message: missing };
    await setState("opening", "İhsan portalı açılıyor");
    await page.goto(portal.url, { waitUntil: "domcontentloaded", timeout: navigationTimeoutMs });
    await page.waitForTimeout(900);
    if (isCancelled()) return { status: "cancelled", message: "Sorgu iptal edildi" };

    const firstText = await visibleText(page);
    if (BLOCK_PATTERN.test(firstText)) return { status: "access_blocked", message: "Portal güvenlik duvarı bu sunucunun erişimini engelledi" };
    if (await detectCaptcha(page, firstText)) return { status: "manual_required", message: "CAPTCHA / güvenlik kontrolü kullanıcı tarafından tamamlanmalı" };
    const target = await resolveTarget(page, portal);
    const sessionOutcome = await completeSessionLogin({ page, target, job, portal, requestOtp, setState });
    if (sessionOutcome?.status) return sessionOutcome;

    const initialState = pageState(await visibleText(target));
    if (initialState) return { status: initialState, message: initialState === "auth_required" ? "Portal oturumu açılmalı" : "Portal isteği kabul etmedi" };
    await setState("filling", "Kimlik, plaka ve ruhsat bilgileri dolduruluyor");
    const filled = await fillIhsanFields(target, job);
    const requiredFilled = filled.identity && filled.plate && filled.registration && (job.vehicle.identity.length !== 11 || filled.birthDate);
    if (!requiredFilled) return { status: "mapping_required", message: "İhsan formunun zorunlu alanları eşleştirilemedi", diagnostics: await pageProfile(target, page) };
    if (!await clickSubmit(target)) return { status: "mapping_required", message: "İhsan formunun Gönder düğmesi eşleştirilemedi", diagnostics: await pageProfile(target, page) };

    await setState("submitted", "İlk form gönderildi; portalın cevabı doğrulanıyor");
    return waitForIhsanOutcome({ page, target, job, portal, resultTimeoutMs, requestOtp, setState, isCancelled });
  }
}
