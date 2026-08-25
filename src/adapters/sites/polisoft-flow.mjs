import {
  FormPortalAdapter,
  acceptRequiredConsents,
  clickNamedButton,
  clickSubmit,
  fillQuoteForm,
  formSignature,
  pageState,
  turkishFoldExact,
  visibleText,
  waitForOutcome,
} from "../form-adapter.mjs";

const RENEWAL_TEXT = /Aracımın Sigortası Bitiyor/i;
const ACCEPT_TEXT = turkishFoldExact("Kabul Et");

async function clickFirstVisible(target, selectors) {
  for (const selector of selectors) {
    const candidates = target.locator(selector);
    const count = Math.min(await candidates.count().catch(() => 0), 8);
    for (let index = 0; index < count; index += 1) {
      const candidate = candidates.nth(index);
      if (!await candidate.isVisible({ timeout: 350 }).catch(() => false)) continue;
      await candidate.click({ timeout: 5000 });
      return true;
    }
  }
  return false;
}

async function dismissCookieBanner(target) {
  await clickNamedButton(target, [
    turkishFoldExact("Reddet"),
    turkishFoldExact("Kabul Et"),
    turkishFoldExact("Tamam"),
  ], { maxTextLength: 24 }).catch(() => false);
}

async function openRenewalFlow(target, page, { continueAfterSelection }) {
  await dismissCookieBanner(target);
  const renewal = target.locator("#carRenewalSection").first();
  if (await renewal.isVisible({ timeout: 1000 }).catch(() => false)) {
    await renewal.click({ timeout: 5000 });
  } else {
    const selected = await clickNamedButton(target, [RENEWAL_TEXT], { maxTextLength: 80 });
    if (!selected) return false;
  }
  await page.waitForTimeout(600);
  if (continueAfterSelection) {
    const continued = await clickFirstVisible(target, ["#wl_continue_button", "button[type='submit']"])
      || await clickNamedButton(target, [turkishFoldExact("Devam")]);
    if (!continued) return false;
    await page.waitForTimeout(700);
  }
  return true;
}

async function acceptPolisoftConsents(target, page) {
  // Bu iki kutu doğrudan işaretlenemiyor. İlgili metin penceresi açılıp
  // "Kabul Et" denince portal kutuyu etkinleştiriyor/işaretliyor.
  const links = target.locator([
    "a[ng-click*='openConfirmationModal']",
    "button[ng-click*='openConfirmationModal']",
    "[data-bs-toggle='modal']",
  ].join(","));
  const count = Math.min(await links.count().catch(() => 0), 8);
  for (let index = 0; index < count; index += 1) {
    const link = links.nth(index);
    if (!await link.isVisible({ timeout: 300 }).catch(() => false)) continue;
    const text = (await link.innerText({ timeout: 300 }).catch(() => "")).toLocaleUpperCase("tr-TR");
    const action = (await link.getAttribute("ng-click").catch(() => "") || "").toLocaleUpperCase("tr-TR");
    if (!/(KVKK|AYDINLATMA|GİZLİLİK|PRIVACY|KİŞİSEL VERİ)/.test(`${text} ${action}`)) continue;
    await link.click({ timeout: 5000 }).catch(() => {});
    await page.waitForTimeout(250);
    await clickNamedButton(target, [ACCEPT_TEXT], { maxTextLength: 32 }).catch(() => false);
    await page.waitForTimeout(250);
  }
  await acceptRequiredConsents(target, { checkAllBoxes: false });
}

async function hasPersonalForm(target) {
  const candidates = target.locator([
    "input[name*='identity' i]",
    "input[name*='kimlik' i]",
    "input[name*='tc' i]",
    "input[placeholder*='TC' i]",
  ].join(","));
  const count = Math.min(await candidates.count().catch(() => 0), 12);
  for (let index = 0; index < count; index += 1) {
    if (await candidates.nth(index).isVisible({ timeout: 250 }).catch(() => false)) return true;
  }
  return false;
}

export class PolisoftPortalAdapter extends FormPortalAdapter {
  constructor({ continueAfterSelection = false } = {}) {
    super();
    this.continueAfterSelection = continueAfterSelection;
  }

  async probe({ page, portal, navigationTimeoutMs }) {
    await page.goto(portal.url, { waitUntil: "domcontentloaded", timeout: navigationTimeoutMs });
    await page.waitForTimeout(700);
    const state = pageState(await visibleText(page));
    if (state) return { state, message: "Portal isteği kabul etmedi" };
    const opened = await openRenewalFlow(page, page, this);
    const personalForm = opened && await hasPersonalForm(page);
    return {
      state: personalForm ? "form_detected" : "mapping_required",
      message: personalForm ? "Polisoft kişisel bilgi formu bulundu" : "Aracımın Sigortası Bitiyor akışı açılamadı",
      fields: { renewalFlow: opened, personalForm },
    };
  }

  async run(context) {
    const {
      page, portal, job, navigationTimeoutMs, resultTimeoutMs, setState,
      requestOtp, requestCaptchaSolve, requestCaptchaCode, isCancelled,
    } = context;
    await setState("opening", `${portal.name} teklif akışı açılıyor`);
    await page.goto(portal.url, { waitUntil: "domcontentloaded", timeout: navigationTimeoutMs });
    await page.waitForTimeout(700);
    if (isCancelled()) return { status: "cancelled", message: "Sorgu iptal edildi" };

    const initialState = pageState(await visibleText(page));
    if (initialState) return { status: initialState, message: "Portal isteği kabul etmedi" };
    if (!await openRenewalFlow(page, page, this)) {
      return { status: "mapping_required", message: "Aracımın Sigortası Bitiyor başlangıç adımı açılamadı" };
    }
    if (!await hasPersonalForm(page)) {
      return { status: "mapping_required", message: "Kişisel/kurumsal bilgi formu bulunamadı" };
    }

    await setState("filling", "Kimlik, iletişim ve doğum tarihi bilgileri dolduruluyor");
    const filled = await fillQuoteForm(page, job, portal);
    if (!filled.identity) {
      return { status: "mapping_required", message: "T.C./VKN alanı eşleştirilemedi" };
    }
    await acceptPolisoftConsents(page, page);
    const attemptedStages = new Set([await formSignature(page)]);
    if (!await clickSubmit(page)) {
      return { status: "mapping_required", message: "Kişisel bilgiler ekranındaki Devam düğmesi bulunamadı" };
    }

    await setState("submitted", "Kişisel bilgiler gönderildi; plaka ve ruhsat adımı bekleniyor");
    return waitForOutcome({
      page,
      target: page,
      job,
      portal,
      resultTimeoutMs: Math.max(Number(resultTimeoutMs) || 0, Number(portal.resultTimeoutMs) || 0, 60000),
      requestOtp,
      requestCaptchaSolve,
      requestCaptchaCode,
      setState,
      isCancelled,
      attemptedStages,
    });
  }
}
