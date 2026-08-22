import { extractOffersFromText } from "../../lib/results.mjs";
import { RESEND_SENTINEL } from "../../lib/validation.mjs";
import {
  acceptRequiredConsents,
  captureSharedFacts,
  clickNamedButton,
  clickSubmit,
  detectCaptcha,
  ensurePlateAvailable,
  fillBirthDate,
  fillFirst,
  fillNameAndEmail,
  fillOtpCode,
  fillRegistrationDate,
  fillSecondaryRegistrationFields,
  fillSplitRegistrationIfPresent,
  findOtpInput,
  humanPause,
  pageState,
  resolveTarget,
  turkishFoldPattern,
  turkishFoldRegex,
  visibleText,
} from "../form-adapter.mjs";

// Not: JS regex'in /i bayrağı Türkçe İ/ı/i/I harflerini birbirine katlamaz;
// bu yüzden buradaki tüm Türkçe kalıplar turkishFoldPattern ile üretiliyor
// (bkz. form-adapter.mjs). Detaylı açıklama orada.
function foldAnyPattern(phrases) {
  return new RegExp(`(${phrases.map(turkishFoldPattern).join("|")})`, "i");
}

const BLOCK_PATTERN = foldAnyPattern(["SORRY, YOU HAVE BEEN BLOCKED", "YOU ARE UNABLE TO ACCESS", "ACCESS DENIED", "ERİŞİM ENGELLENDİ", "REQUEST BLOCKED"]);
const VALIDATION_PATTERN = foldAnyPattern(["LÜTFEN GEÇERLİ", "BU ALAN ZORUNLUDUR", "ALANI ZORUNLUDUR", "DEVAM ETMEK İÇİN BU ALANI", "EKSİK BİLGİ"]);
const RESULT_PROGRESS_PATTERN = foldAnyPattern(["TEKLİF SONUÇLARI", "TEKLİFLER SORGULANIYOR", "SORGULAMA DURUMU", "FİYATLAR HAZIRLANIYOR", "ŞİRKETLERDEN TEKLİF"]);
const SESSION_SMS_PATTERN = foldAnyPattern(["SMS", "TEK KULLANIMLIK", "DOĞRULAMA KODU", "ONAY KODU", "CEP TELEFONUNUZA"]);
const SESSION_CREDENTIAL_PATTERN = foldAnyPattern(["ŞİFRE", "PASSWORD", "E-POSTA", "EPOSTA"]);
const DYNAMIC_STEP_PATTERN = foldAnyPattern(["EKSTRA BİLGİLER", "ARAÇ CİNSİ", "ARAÇ MODEL YILI", "MARKA KODU", "ŞASİ NUMARASI"]);
const MOTORCYCLE_PATTERN = foldAnyPattern(["MOTOSİKLET", "MOTOR"]);
const KAMYONET_PATTERN = foldAnyPattern(["KAMYONET", "PANELVAN"]);
const GIRIS_YAP_PATTERN = new RegExp(`^${turkishFoldPattern("Giriş Yap")}$`, "i");

// İhsan altyapısı birden çok markayı (Lion, Sert, Bi Tıkla, İskenderun vb.)
// aynı paylaşımlı sunucu üzerinden çalıştırıyor. Sunucu aynı anda çok fazla
// sorgu görürse "rate_limited" durumunu tetikliyor; bu durumda kullanıcı
// az bekleyip tekrar denerse sorgu genelde kısa süre içinde oluşuyor. Panelde
// bunu net bir bekleme mesajıyla göstermek, kullanıcının "hata" sanıp
// portalı tekrar tekrar denemesini önlüyor.
export const DETECTED_STATE_MESSAGES = {
  no_offer: "Portal teklif bulunamadığını bildirdi",
  rate_limited: "İhsan altyapısı paylaşımlı; yoğunluktan bu sorgu reddedildi. Sorgu yaklaşık 1 dakika sonra oluşturulacak, birazdan tekrar deneyin.",
  auth_required: "Portal oturumu açılmalı",
};

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

async function getSelectOptions(target, selector) {
  return target.locator(selector).first().locator("option").evaluateAll((nodes) => nodes.slice(0, 250).map((node) => ({
    value: node.value,
    label: node.textContent?.trim() || "",
    disabled: node.disabled,
  }))).catch(() => []);
}

async function fillSelectByUserValue(target, selector, value) {
  const options = await getSelectOptions(target, selector);
  const select = target.locator(selector).first();
  const exact = options.find((option) => option.value === value && !option.disabled);
  if (exact) return select.selectOption(exact.value, { timeout: 4000 }).then(() => true).catch(() => false);
  const option = chooseBestOption(options, [value]);
  if (!option) return false;
  return select.selectOption(option.value, { timeout: 4000 }).then(() => true).catch(() => false);
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
    if (String(value || "").trim()) continue;
    const tag = await control.evaluate((element) => element.tagName.toLowerCase()).catch(() => "select");
    missing.push({ label, selector, requestable: tag === "input" });
  }
  return missing;
}

function vehicleCandidates(vehicleText) {
  const text = String(vehicleText || "").trim();
  const values = [text];
  if (KAMYONET_PATTERN.test(text)) values.push("KAMYONET");
  else if (MOTORCYCLE_PATTERN.test(text)) values.push("MOTOSİKLET", "MOTOSIKLET");
  else if (text) values.push("OTOMOBİL", "OTOMOBIL");
  return values;
}

async function fillIhsanFields(target, job, { includeDynamic = false, page = null } = {}) {
  const vehicle = job.vehicle;
  const filled = {};
  filled.identity = await fillFirst(target, vehicle.identity,
    ['input[placeholder*="kimlik numaranızı" i]', 'input[name*="identity" i]', 'input[name*="kimlik" i]', 'input[name*="tc" i]'],
    ["Kimlik Numarası", "TC Kimlik No", "TC/Vergi", "TC Kimlik Numarası", "Vergi Kimlik No"]);
  await humanPause();
  filled.birthDate = await fillBirthDate(target, vehicle.birthDate);
  await humanPause();
  await ensurePlateAvailable(target);
  filled.plate = await fillFirst(target, vehicle.plate,
    ['input[placeholder*="34 ABC" i]', 'input[name*="plate" i]', 'input[name*="plaka" i]'], ["Plaka"]);
  await humanPause();
  filled.registration = (await fillSplitRegistrationIfPresent(target, vehicle.registration)) || (await fillFirst(target, vehicle.registration,
    ['input[placeholder*="Ruhsat numaranızı" i]', 'input[name*="registration" i]', 'input[name*="ruhsat" i]', 'input[name*="belge" i]', 'input[name*="tescil" i]'],
    ["Ruhsat Numarası", "Ruhsat Seri", "Belge Seri", "Ruhsat Tescil Belge Seri No", "Tescil Belge Seri No", "Ruhsat Seri No"]));
  await fillSecondaryRegistrationFields(target, vehicle.registration);
  await humanPause();
  await fillRegistrationDate(target, vehicle.registrationDate);
  await humanPause();
  await fillNameAndEmail(target, job);

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

async function hasIdentityOrPlateField(target) {
  const identityVisible = await target.locator('input[name*="kimlik" i], input[name*="identity" i], input[name*="tc" i], input[placeholder*="kimlik" i]').first().isVisible({ timeout: 400 }).catch(() => false);
  if (identityVisible) return true;
  return target.locator('input[name*="plaka" i], input[name*="plate" i], input[placeholder*="plaka" i]').first().isVisible({ timeout: 400 }).catch(() => false);
}

async function escapeNonQueryScreens(target, page) {
  for (let attempt = 0; attempt < 3; attempt += 1) {
    if (await hasIdentityOrPlateField(target)) return true;
    const selectedCategory = await clickNamedButton(target, [
      new RegExp(`^${turkishFoldPattern("Zorunlu Trafik Sigortası")}$`, "i"),
      new RegExp(`^${turkishFoldPattern("Trafik Sigortası")}$`, "i"),
    ], { maxTextLength: 32 });
    const dismissed = selectedCategory
      || await clickNamedButton(target, [turkishFoldRegex("Şimdi Değil"), /Vazgeç/i, /Daha Sonra/i, /Atla/i, /Kapat/i])
      || await clickNamedButton(target, [turkishFoldRegex("Trafik Sigortası Teklif"), turkishFoldRegex("Trafik Teklifi"), turkishFoldRegex("Hemen Teklif Al"), turkishFoldRegex("Teklif Al"), /Sorgula/i]);
    if (!dismissed) return false;
    await page.waitForTimeout(900);
  }
  return hasIdentityOrPlateField(target);
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

// ihsan-frame portallarında (ör. Sigortam Milli) giriş/telefon doğrulama
// penceresi bazen gömülü widget'ın (iframe) içinde değil, siteyi saran ANA
// SAYFADA açılıyor. sessionDialogTarget yalnız kendisine verilen target
// içinde arar; bu yüzden önce iframe içine, bulamazsa ana sayfaya bakar.
async function sessionDialogTargetAnywhere(page, target) {
  const inTarget = await sessionDialogTarget(target);
  if (inTarget !== target) return inTarget;
  if (target === page) return inTarget;
  const inPage = await sessionDialogTarget(page);
  if (inPage !== page) return inPage;
  return inTarget;
}

// Sorgu ilerlerken tanımadığımız bir Evet/Hayır onay penceresi çıkabiliyor
// (ör. "Ek bir ürün eklemek ister misiniz?"). Bunu ne diye soracağını
// bilmediğimizden güvenli varsayılan olan "Hayır" otomatik tıklanır; akış
// kullanıcı müdahalesi beklemeden devam eder.
async function dismissUnknownYesNoPopup(target) {
  const dialog = await sessionDialogTarget(target);
  if (dialog === target) return false;
  // Not: gerçek düğme metni tam "Hayır"/"Evet" olmayabilir (ör. "Hayır,
  // teşekkürler", "Evet, istiyorum"); bu yüzden BAŞLANGIÇ eşleşmesi
  // kullanılıyor (^Hayır, ^Evet), tam eşleşme değil.
  const noButton = dialog.getByRole("button", { name: /^Hayır/i }).first();
  const hasYes = await namedControlVisible(dialog, [/^Evet/i]);
  if (!hasYes || !await noButton.isVisible({ timeout: 300 }).catch(() => false)) return false;
  await noButton.click({ timeout: 3000 }).catch(() => {});
  return true;
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
  const selectors = [
    'input[name*="phone" i]', 'input[name*="telefon" i]', 'input[name*="gsm" i]',
    'input[name*="cep" i]', 'input[id*="phone" i]', 'input[id*="telefon" i]', 'input[id*="gsm" i]',
    'input[id*="cep" i]', 'input[placeholder*="telefon" i]', 'input[placeholder*="gsm" i]', 'input[placeholder*="cep" i]',
    'input[type="tel"]:not([name*="kimlik" i]):not([id*="kimlik" i]):not([name*="identity" i]):not([id*="identity" i]):not([name*="tc" i]):not([id*="tc" i])',
  ];
  const labels = ["GSM", "Cep Telefonu", "Telefon Numarası", "Telefon"];
  const withoutLeadingZero = phone.replace(/^0/, "");
  return (await fillFirst(target, withoutLeadingZero, selectors, labels))
    || (await fillFirst(target, phone, selectors, labels));
}

async function latestSessionTarget(page, target, portal) {
  const pages = page.context().pages().filter((candidate) => !candidate.isClosed());
  const latest = pages.at(-1);
  if (!latest || latest === page) return target;
  await latest.waitForLoadState("domcontentloaded", { timeout: 5000 }).catch(() => {});
  return resolveTarget(latest, portal);
}

async function completeSessionLogin({ page, target, job, portal, requestOtp, setState, requestSmsSlot, openIfNeeded = true }) {
  if (portal.smsPolicy !== "session_once" || job.mode !== "ask_sms") return null;
  let loginTarget = await sessionDialogTargetAnywhere(page, target);
  let otpInput = await findOtpInput(loginTarget);
  let pendingCode = null;
  let phoneFilled = false;

  // "Oturumları Sorgula" ile yakın zamanda oturumun açık olduğu doğrulandıysa
  // "Giriş Yap" düğmesi için ayrı bir DOM sorgusu atlanır; SMS metnine göre
  // yapılan denetim (aşağıda) yine de gerçek bir giriş gerekiyorsa bunu yakalar.
  const sessionHint = job.sessionHints?.[portal.id];
  const loginVisible = !otpInput && sessionHint?.loggedIn !== true && await namedControlVisible(target, [GIRIS_YAP_PATTERN]);
  const smsStepLikely = loginVisible || (!otpInput && SESSION_SMS_PATTERN.test(await visibleText(loginTarget)));
  if (!otpInput && !smsStepLikely) {
    // Ne SMS/giriş kutusu ne "Giriş Yap" görünüyor: portal önceki oturumdan zaten
    // giriş yapılmış olabilir. Bu portalda yapılacak bir şey yok, akışa devam.
    return null;
  }
  if (!otpInput) {
    phoneFilled = await fillSessionPhone(loginTarget, job.phone);
  }

  let opened = false;
  if (!otpInput && !phoneFilled && loginVisible && openIfNeeded) {
    await setState("opening", `${portal.name} oturumu için SMS doğrulaması hazırlanıyor`);
    if (!await clickNamedButton(target, [GIRIS_YAP_PATTERN])) return null;
    opened = true;
    const dialogDeadline = Date.now() + 6000;
    let dialogBlocked = null;
    while (Date.now() < dialogDeadline) {
      await page.waitForTimeout(400);
      const activeTarget = await latestSessionTarget(page, target, portal);
      loginTarget = await sessionDialogTargetAnywhere(page, activeTarget);
      const dialogText = await visibleText(loginTarget);
      if (BLOCK_PATTERN.test(dialogText)) {
        dialogBlocked = { status: "access_blocked", message: "Giriş penceresi açılırken portal güvenlik duvarı erişimi engelledi" };
        break;
      }
      if (await detectCaptcha(page, dialogText)) {
        dialogBlocked = { status: "manual_required", message: "Giriş penceresinde CAPTCHA / güvenlik doğrulaması çıktı" };
        break;
      }
      otpInput = await findOtpInput(loginTarget);
      if (otpInput) break;
      phoneFilled = await fillSessionPhone(loginTarget, job.phone);
      if (phoneFilled) break;
    }
    if (dialogBlocked) return { ...dialogBlocked, diagnostics: await pageProfile(loginTarget, page) };
  }

  if (!otpInput) {
    if (!phoneFilled) {
      if (!opened) return null;
      const text = await sessionTargetText(loginTarget, target);
      return {
        status: "auth_required",
        message: SESSION_CREDENTIAL_PATTERN.test(text)
          ? `${portal.name} oturumu kullanıcı adı/şifre istiyor; portal oturumu bir kez manuel açılmalı`
          : `${portal.name} giriş penceresindeki telefon alanı eşleştirilemedi`,
        diagnostics: await pageProfile(loginTarget, page),
      };
    }
    if (requestSmsSlot) {
      await setState("opening", `${portal.name} için SMS gönderim sırası bekleniyor (paylaşılan altyapı hız sınırı)`);
      await requestSmsSlot();
    }
    const sent = await clickNamedButton(loginTarget, [/Kod(?:u)? Gönder/i, /SMS Gönder/i, /Devam/i, GIRIS_YAP_PATTERN, /^Gönder$/i, /Doğrula/i, /Onayla/i]);
    if (!sent) {
      return { status: "mapping_required", message: `${portal.name} SMS gönderme düğmesi eşleştirilemedi`, diagnostics: await pageProfile(loginTarget, page) };
    }
    // SMS isteği portal tarafından kabul edildiği anda panelde kod alanını aç.
    // Portalın tek kutu veya parçalı OTP arayüzünü çizmesini beklemek kullanıcı
    // tarafındaki kod girişini geciktirmemeli.
    pendingCode = requestOtp();
    otpInput = await waitForSessionOtp(loginTarget, page, 30000);
  }

  if (!otpInput) {
    if (pendingCode) {
      await pendingCode;
      otpInput = await waitForSessionOtp(loginTarget, page, 20000);
    }
    if (!otpInput) return { status: "auth_required", message: `${portal.name} SMS gönderdi ancak portal kod alanını göstermedi`, diagnostics: await pageProfile(loginTarget, page) };
  }

  let code = pendingCode ? await pendingCode : await requestOtp();
  while (code === RESEND_SENTINEL) {
    if (requestSmsSlot) await requestSmsSlot();
    const resent = await clickNamedButton(loginTarget, [/Tekrar Gönder/i, /Yeniden Gönder/i, /Kod(?:u)? Gönder/i, /SMS Gönder/i]);
    if (!resent) {
      return { status: "mapping_required", message: `${portal.name} kodu tekrar gönderme düğmesi bulunamadı`, diagnostics: await pageProfile(loginTarget, page) };
    }
    code = await requestOtp();
  }
  if (!await fillOtpCode(loginTarget, code)) {
    return { status: "mapping_required", message: `${portal.name} SMS kodu kutuları doldurulamadı`, diagnostics: await pageProfile(loginTarget, page) };
  }
  if (!await clickNamedButton(loginTarget, [/Doğrula/i, /Onayla/i, GIRIS_YAP_PATTERN, /Devam/i])) await otpInput.press("Enter").catch(() => {});
  const verificationDeadline = Date.now() + 15000;
  let stillWaiting = true;
  while (Date.now() < verificationDeadline) {
    await page.waitForTimeout(500);
    stillWaiting = Boolean(await findOtpInput(loginTarget));
    if (!stillWaiting) break;
  }
  if (stillWaiting) {
    return { status: "auth_required", message: `${portal.name} SMS kodunu kabul etmedi; kodu ve süresini kontrol edin`, diagnostics: await pageProfile(loginTarget, page) };
  }
  await setState("filling", `${portal.name} oturumu açıldı; araç sorgusu hazırlanıyor`);
  return { handled: true };
}

function missingInputMessage(job) {
  const missing = [];
  if (!job.vehicle.registration) missing.push("ruhsat seri numarası");
  if (job.vehicle.identity.length === 11 && !job.vehicle.birthDate) missing.push("doğum tarihi");
  if (!missing.length) return null;
  return `İhsan altyapılı portal için ${missing.join(" ve ")} zorunludur`;
}

async function lookupOfferFromHistory({ page, target, job, portal }) {
  const historyOpened = await clickNamedButton(target, [turkishFoldRegex("Geçmiş Teklifler"), turkishFoldRegex("Geçmiş Sorgular"), /Tekliflerim/i, turkishFoldRegex("Sorgu Geçmişi")]);
  if (!historyOpened) return null;
  await page.waitForTimeout(1200);
  const historyTarget = await resolveTarget(page, portal);
  const plate = job.vehicle.plate;
  const row = historyTarget.locator(`tr:has-text("${plate}"), li:has-text("${plate}"), [class*="row" i]:has-text("${plate}")`).first();
  if (!await row.isVisible({ timeout: 2000 }).catch(() => false)) return null;
  const viewNamePattern = foldAnyPattern(["Teklifleri Görüntüle", "Görüntüle", "İncele"]);
  const viewButton = row.getByRole("button", { name: viewNamePattern }).first();
  const viewLink = row.getByRole("link", { name: viewNamePattern }).first();
  const clicked = await viewButton.isVisible({ timeout: 500 }).then(async (visible) => {
    if (!visible) return false;
    await viewButton.click({ timeout: 4000 });
    return true;
  }).catch(() => false) || await viewLink.isVisible({ timeout: 500 }).then(async (visible) => {
    if (!visible) return false;
    await viewLink.click({ timeout: 4000 });
    return true;
  }).catch(() => false);
  if (!clicked) return null;
  await page.waitForTimeout(1200);
  const resultTarget = await resolveTarget(page, portal);
  const text = await visibleText(resultTarget);
  const offers = extractOffersFromText(text, portal);
  return offers.length ? offers : null;
}

async function waitForIhsanOutcome({ page, target, job, portal, resultTimeoutMs, historyLookupDelayMs, requestOtp, requestField, requestSmsSlot, setState, isCancelled }) {
  const startedAt = Date.now();
  let dynamicAttempted = false;
  let lastOffers = [];
  let lastOfferChangeAt = 0;
  let sessionChallengeCompleted = false;
  let lastStage = "Portal formu gönderildi; cevap bekleniyor";
  const track = (status, message, extra) => {
    lastStage = message;
    return setState(status, message, extra);
  };
  while (Date.now() - startedAt < resultTimeoutMs) {
    if (isCancelled()) return { status: "cancelled", message: "Sorgu iptal edildi" };
    if (await dismissUnknownYesNoPopup(target)) {
      await page.waitForTimeout(500);
      continue;
    }
    const text = await visibleText(target);
    captureSharedFacts(job, text);
    if (BLOCK_PATTERN.test(text)) return { status: "access_blocked", message: "Portal güvenlik duvarı bu sunucunun erişimini engelledi" };
    if (await detectCaptcha(page, text)) {
      return { status: "manual_required", message: "CAPTCHA / güvenlik kontrolü kullanıcı tarafından tamamlanmalı" };
    }

    if (!sessionChallengeCompleted) {
      const sessionOutcome = await completeSessionLogin({ page, target, job, portal, requestOtp, requestSmsSlot, setState: track, openIfNeeded: true });
      if (sessionOutcome?.status) return sessionOutcome;
      if (sessionOutcome?.handled) {
        sessionChallengeCompleted = true;
        await page.waitForTimeout(900);
        continue;
      }
    }
    const detectedState = pageState(text);
    if (detectedState) return { status: detectedState, message: DETECTED_STATE_MESSAGES[detectedState] || "Portal oturum veya hız sınırı bildirdi" };

    const otpInput = await findOtpInput(target);
    const smsLanguage = SESSION_SMS_PATTERN.test(text);
    if (otpInput && smsLanguage) {
      if (job.mode === "no_sms") return { status: "skipped_sms", message: "SMS istendiği için atlandı" };
      const code = await requestOtp();
      if (!await fillOtpCode(target, code)) return { status: "mapping_required", message: "SMS kodu kutuları doldurulamadı", diagnostics: await pageProfile(target, page) };
      if (!await clickSubmit(target)) await otpInput.press("Enter").catch(() => {});
      await track("collecting", "SMS doğrulandı; gerçek teklifler bekleniyor");
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

    const hasDynamicStep = DYNAMIC_STEP_PATTERN.test(text);
    if (hasDynamicStep && !dynamicAttempted) {
      dynamicAttempted = true;
      await track("filling", "Portalın istediği ek araç bilgileri dolduruluyor");
      const revealed = await revealDynamicSection(target, page);
      if (!revealed) {
        // "Ekstra Bilgiler" etiketi sayfada görünse bile bazen aslında
        // doldurulacak aktif bir alan kalmamış oluyor (ör. teklifler zaten
        // oluşmaya başlamış). Elimizde teklif varsa (Lion'da rapor edilen
        // durum) akışı burada KESMEYELİM; gerçekten hiç teklif yoksa
        // eskisi gibi hata döndürülür.
        if (!offers.length && !lastOffers.length) {
          // Lion gibi sitelerde bu ekran hiç açılamasa bile portal arka
          // planda teklifi zaten oluşturmuş olabiliyor; "hata" döndürmeden
          // önce İskenderun'daki gibi "Tekliflerim" geçmiş sekmesinden
          // aynı plakanın teklifini son bir kez deniyoruz.
          const historyOffers = !isCancelled() && await lookupOfferFromHistory({ page, target, job, portal }).catch(() => null);
          if (historyOffers?.length) return { status: "completed", message: `${historyOffers.length} şirket teklifi geçmiş teklifler sekmesinden alındı`, offers: historyOffers };
          return { status: "mapping_required", message: "Ekstra araç bilgileri bölümü açılamadı", diagnostics: await pageProfile(target, page) };
        }
        await page.waitForTimeout(1200);
        continue;
      }
      const dynamic = await fillIhsanFields(target, job, { includeDynamic: true, page });
      let changed = ["vehicleType", "yearSelect", "brandSelect", "typeSelect", "yearInput", "chassis", "engine"]
        .some((key) => dynamic[key]);
      const missingDynamic = await missingVisibleDynamicFields(target);
      if (missingDynamic.length) {
        for (const field of missingDynamic) {
          if (isCancelled()) return { status: "cancelled", message: "Sorgu iptal edildi" };
          const choices = field.requestable ? null : (await getSelectOptions(target, field.selector))
            .filter((option) => !option.disabled && String(option.value || "").trim())
            .slice(0, 60)
            .map((option) => ({ value: option.value, label: option.label || option.value }));
          const value = await requestField(field.label, field.selector, choices).catch(() => null);
          if (!value) {
            return {
              status: "input_required",
              message: `"${field.label}" bilgisi için panelden yanıt alınamadı`,
              diagnostics: await pageProfile(target, page),
            };
          }
          const filled = field.requestable
            ? await target.locator(field.selector).first().fill(value, { timeout: 3000 }).then(() => true).catch(() => false)
            : await fillSelectByUserValue(target, field.selector, value);
          if (!filled) {
            return {
              status: "input_required",
              message: `"${field.label}" için girilen "${value}" değeri portalın seçenekleriyle eşleşmedi`,
              diagnostics: await pageProfile(target, page),
            };
          }
          changed = true;
        }
        await track("filling", "Panelden girilen ek bilgiler dolduruldu");
      }
      if (changed && await clickSubmit(target)) {
        await track("submitted", "Ek araç bilgileri gönderildi; portal cevabı bekleniyor");
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
    if (RESULT_PROGRESS_PATTERN.test(text)) await track("collecting", "Sigorta şirketlerinden doğrulanmış fiyat bekleniyor");
    await page.waitForTimeout(1500);
  }
  if (lastOffers.length) return { status: "completed", message: `${lastOffers.length} şirket teklifi doğrulandı`, offers: lastOffers };

  if (historyLookupDelayMs > 0 && !isCancelled()) {
    await track("collecting", `Portal doğrudan cevap vermedi; ${Math.round(historyLookupDelayMs / 1000)} saniye bekleyip geçmiş teklifler sekmesi denenecek`);
    await page.waitForTimeout(historyLookupDelayMs);
    if (!isCancelled()) {
      const historyOffers = await lookupOfferFromHistory({ page, target, job, portal }).catch(() => null);
      if (historyOffers?.length) return { status: "completed", message: `${historyOffers.length} şirket teklifi geçmiş teklifler sekmesinden alındı`, offers: historyOffers };
    }
  }

  return {
    status: "timeout",
    message: `Portal süre içinde doğrulanmış teklif veya teklif-yok cevabı vermedi (son aşama: ${lastStage})`,
    diagnostics: { ...await pageProfile(target, page), lastVisibleText: (await visibleText(target)).replace(/\s+/g, " ").trim().slice(0, 400) },
  };
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
    const hasIdentity = profile.labels.some((label) => turkishFoldRegex("KİMLİK").test(label)) || profile.controls.some((control) => /kimlik|identity|\btc\b/i.test(`${control.name} ${control.placeholder}`));
    const hasPlate = profile.labels.some((label) => /PLAKA/i.test(label)) || profile.controls.some((control) => /plaka|plate/i.test(`${control.name} ${control.placeholder}`));
    let sessionProfile = null;
    if (portal.smsPolicy === "session_once" && await namedControlVisible(target, [GIRIS_YAP_PATTERN])) {
      await clickNamedButton(target, [GIRIS_YAP_PATTERN]);
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

  // Gerçek bir sorgu göndermeden yalnız oturumun açık olup olmadığını
  // kontrol eder. "Oturumları Sorgula" paneli ve gerçek sorgu başlamadan
  // önceki hızlı ön kontrol için kullanılır.
  async checkSession({ page, portal, navigationTimeoutMs }) {
    if (portal.smsPolicy !== "session_once") return { loggedIn: null, message: "Bu portal için oturum kavramı yok" };
    await page.goto(portal.url, { waitUntil: "domcontentloaded", timeout: navigationTimeoutMs });
    // Not: sayfa render'ı bazı portallarda geç tamamlanabiliyor; "Giriş Yap"
    // düğmesi henüz DOM'a gelmeden kontrol edilirse yanlışlıkla "oturum
    // açık" sanılabiliyordu. completeSessionLogin'deki gerçek sorgu akışıyla
    // aynı bekleme/iframe-tarama mantığını (sessionDialogTargetAnywhere)
    // kullanıyoruz ki iki kontrol birbirinden farklı sonuç vermesin.
    await page.waitForTimeout(1200);
    const text = await visibleText(page);
    if (BLOCK_PATTERN.test(text)) return { loggedIn: null, message: "Güvenlik duvarı erişimi engelledi" };
    if (await detectCaptcha(page, text)) return { loggedIn: null, message: "Güvenlik doğrulaması gerekiyor" };
    const target = await resolveTarget(page, portal);
    const scannedTarget = await sessionDialogTargetAnywhere(page, target);
    // Bazı sitelerde "Giriş Yap" üst menüde oturum durumundan bağımsız
    // sabit bir gezinme bağlantısı olabiliyor; bu durumda yokluğuna
    // güvenmek yanlış "girişli değil" sonucu verebiliyor. "Çıkış Yap" /
    // "Hesabım" gibi net bir oturum-açık işareti varsa buna öncelik ver.
    const loggedInSignal = await namedControlVisible(scannedTarget, [
      new RegExp(`^${turkishFoldPattern("Çıkış Yap")}$`, "i"),
      new RegExp(`^${turkishFoldPattern("Oturumu Kapat")}$`, "i"),
      new RegExp(`^${turkishFoldPattern("Hesabım")}$`, "i"),
    ]);
    if (loggedInSignal) return { loggedIn: true, message: "Oturum açık görünüyor (hesap/çıkış bağlantısı görüldü)" };
    const loginVisible = await namedControlVisible(scannedTarget, [GIRIS_YAP_PATTERN]);
    return loginVisible
      ? { loggedIn: false, message: "Giriş yapılmamış; sorguda SMS istenecek" }
      : { loggedIn: true, message: "Oturum açık görünüyor" };
  }

  async run(context) {
    const { page, portal, job, navigationTimeoutMs, resultTimeoutMs, historyLookupDelayMs, setState, requestOtp, requestField, requestSmsSlot, isCancelled } = context;
    const missing = missingInputMessage(job);
    if (missing) return { status: "input_required", message: missing };
    await setState("opening", "İhsan portalı açılıyor");
    await page.goto(portal.url, { waitUntil: "domcontentloaded", timeout: navigationTimeoutMs });
    await page.waitForTimeout(900);
    if (isCancelled()) return { status: "cancelled", message: "Sorgu iptal edildi" };

    // Not: İhsan altyapısı paylaşımlı bir arka uç kullanıyor ve gerçek
    // CAPTCHA göstermiyor; bu yüzden burada canlı CAPTCHA-çözüm akışı
    // uygulanmıyor (yalnız genel karşılaştırma sitelerinde var, bkz.
    // form-adapter.mjs). Yine de CAPTCHA benzeri bir engel görülürse akış
    // güvenli şekilde manuel gerekiyor olarak işaretlenir.
    const firstText = await visibleText(page);
    if (BLOCK_PATTERN.test(firstText)) return { status: "access_blocked", message: "Portal güvenlik duvarı bu sunucunun erişimini engelledi" };
    if (await detectCaptcha(page, firstText)) {
      return { status: "manual_required", message: "CAPTCHA / güvenlik kontrolü kullanıcı tarafından tamamlanmalı" };
    }
    const target = await resolveTarget(page, portal);
    const initialState = pageState(await visibleText(target));
    if (initialState) return { status: initialState, message: initialState === "auth_required" ? "Portal oturumu açılmalı" : "Portal isteği kabul etmedi" };
    if (!await hasIdentityOrPlateField(target)) {
      await setState("opening", "Portal sorgu formu yerine başka bir ekranda; sorgu sayfasına geçiliyor");
      await escapeNonQueryScreens(target, page);
    }
    await setState("filling", "Kimlik, plaka ve ruhsat bilgileri dolduruluyor");
    const filled = await fillIhsanFields(target, job);
    const requiredFilled = filled.identity && filled.plate && filled.registration && (job.vehicle.identity.length !== 11 || filled.birthDate);
    if (!requiredFilled) return { status: "mapping_required", message: "İhsan formunun zorunlu alanları eşleştirilemedi", diagnostics: await pageProfile(target, page) };
    if (!await clickSubmit(target)) return { status: "mapping_required", message: "İhsan formunun Gönder düğmesi eşleştirilemedi", diagnostics: await pageProfile(target, page) };

    await setState("submitted", "İlk form gönderildi; portalın cevabı doğrulanıyor");
    return waitForIhsanOutcome({ page, target, job, portal, resultTimeoutMs, historyLookupDelayMs, requestOtp, requestField, requestSmsSlot, setState, isCancelled });
  }
}
