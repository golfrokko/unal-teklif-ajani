import {
  FormPortalAdapter,
  acceptRequiredConsents,
  clickNamedButton,
  clickSubmit,
  detectCaptcha,
  dismissNoPopup,
  fillBirthDate,
  fillFirst,
  fillOtpCode,
  fillSplitRegistrationIfPresent,
  fillVisibleInputsByOrder,
  findOtpInput,
  formSignature,
  humanPause,
  resolveTarget,
  selectCorporateMode,
  turkishFoldExact,
  turkishFoldRegex,
  visibleText,
  waitForOutcome,
} from "../form-adapter.mjs";
import { isCorporateJob, RESEND_SENTINEL } from "../../lib/validation.mjs";

// Sigorta7 (sigorta7) — kullanıcının adım adım tarif ettiği akış:
//  1) Canlı formda sırayla TC, doğum tarihi, telefon, e-posta; alttaki
//     onay kutuları işaretlenip "Devam Et".
//  2) Açılan pencerede Ad + Yaşadığınız İl + İlçe istenir. Elimizde adres
//     bilgisi olmadığından kullanıcı talebi gereği varsayılan olarak
//     KARABÜK / ESKİPAZAR seçilir; "Onayla".
//  3) SMS doğrulama penceresi: panelden gelen kod yazılıp "Doğrula".
//  4) Çıkan tanıtım/izin pencerelerinde "Hayır".
//  5) Ruhsat bilgileri (plaka + belge seri + belge no) girilip "Onayla".
//  6) EGM sorgusundan sonra "İleri"; geçmiş poliçe adımında "poliçem yok"
//     seçeneği işaretlenip "Teklifleri Getir".
//  7) Teklifler ~30 sn içinde birer birer düştüğünden ortak bekleme
//     döngüsüne devredilir (tüm şirketler toplanana kadar bekler).
const DEFAULT_CITY = "KARABÜK";
const DEFAULT_DISTRICT = "ESKİPAZAR";

export class Sigorta7Adapter extends FormPortalAdapter {
  async run(context) {
    const { page, portal, job, navigationTimeoutMs, resultTimeoutMs, requestOtp, requestCaptchaSolve, setState, isCancelled } = context;
    const cancelled = () => ({ status: "cancelled", message: "Sorgu iptal edildi" });

    await setState("opening", "Sigorta7 açılıyor");
    await page.goto(portal.url, { waitUntil: "domcontentloaded", timeout: navigationTimeoutMs });
    await page.waitForTimeout(900);
    if (isCancelled()) return cancelled();

    let firstText = await visibleText(page);
    for (let attempt = 0; await detectCaptcha(page, firstText); attempt += 1) {
      if (typeof requestCaptchaSolve !== "function" || attempt >= 5) {
        return { status: "manual_required", message: "CAPTCHA / güvenlik kontrolü kullanıcı tarafından tamamlanmalı" };
      }
      await requestCaptchaSolve();
      if (isCancelled()) return cancelled();
      firstText = await visibleText(page);
    }

    // 1) Kimlik / doğum tarihi / telefon / e-posta
    const target = await resolveTarget(page, portal);
    await dismissNoPopup(target);
    if (isCorporateJob(job.vehicle)) {
      await selectCorporateMode(target);
      await humanPause();
    }
    await setState("filling", "Kimlik, doğum tarihi ve iletişim bilgileri dolduruluyor");
    const phone10 = job.phone.replace(/^0/, "");
    const identityFilled = await fillFirst(target, job.vehicle.identity,
      ['input[name*="tc" i]', 'input[name*="kimlik" i]', 'input[name*="vergi" i]'],
      ["T.C. Kimlik No", "TC Kimlik No", "Vergi No", "Kimlik Numarası"]);
    await fillBirthDate(target, job.vehicle.birthDate);
    const phoneFilled = await fillFirst(target, phone10,
      ['input[name*="phone" i]', 'input[name*="telefon" i]', 'input[name*="gsm" i]'],
      ["Cep Telefonu", "Telefon"]);
    await fillFirst(target, job.email,
      ['input[type="email"]', 'input[name*="email" i]', 'input[name*="eposta" i]'],
      ["E-posta adresi", "E-posta", "E-Posta Adresi"]);
    if (!identityFilled && !phoneFilled) {
      // Alanlar etiketten tanınamadıysa kullanıcının tarif ettiği sırayla dene.
      const [byOrder] = await fillVisibleInputsByOrder(target, [job.vehicle.identity, job.vehicle.birthDate, phone10, job.email]);
      if (!byOrder) return { status: "mapping_required", message: "Sigorta7'nin ilk canlı veri alanları bulunamadı" };
    }
    await acceptRequiredConsents(target, { checkAllBoxes: portal?.checkAllBoxes === true });
    await humanPause();
    if (!await clickNamedButton(target, [turkishFoldRegex("Devam Et")]) && !await clickSubmit(target)) {
      return { status: "mapping_required", message: "'Devam Et' düğmesi bulunamadı" };
    }
    if (isCancelled()) return cancelled();
    await page.waitForTimeout(1500);

    // 2) Ad + il/ilçe penceresi
    await setState("filling", "Ad ve adres bilgileri dolduruluyor");
    const detailsTarget = await resolveTarget(page, portal);
    await fillFirst(detailsTarget, job.vehicle.fullName,
      ['input[name*="ad" i]:not([name*="soyad" i])', 'input[name*="name" i]', 'input[name*="unvan" i]'],
      ["Ad", "Adı", "Ünvan", "Şirket Ünvanı"]);
    await this.#selectLocation(detailsTarget, ["Yaşadığınız İl", "İl", "Şehir"], DEFAULT_CITY);
    await this.#selectLocation(detailsTarget, ["İlçe"], DEFAULT_DISTRICT);
    await humanPause();
    await clickNamedButton(detailsTarget, [turkishFoldRegex("Onayla")]).catch(() => {});
    if (isCancelled()) return cancelled();
    await page.waitForTimeout(1500);

    // 3) SMS doğrulaması
    const smsTarget = await resolveTarget(page, portal);
    const otpInput = await this.#waitFor(page, () => findOtpInput(smsTarget), 30000);
    if (otpInput) {
      if (job.mode === "no_sms") return { status: "skipped_sms", message: "SMS istendiği için atlandı" };
      await setState("submitted", "SMS doğrulama kodu bekleniyor");
      let code = await requestOtp();
      while (code === RESEND_SENTINEL) {
        if (!await clickNamedButton(smsTarget, [turkishFoldRegex("Yeniden Gönder"), turkishFoldRegex("Tekrar Gönder")])) {
          return { status: "mapping_required", message: "Kodu tekrar gönderme düğmesi bulunamadı" };
        }
        code = await requestOtp();
      }
      if (!await fillOtpCode(smsTarget, code)) return { status: "mapping_required", message: "SMS kodu alanı doldurulamadı" };
      await acceptRequiredConsents(smsTarget, { checkAllBoxes: portal?.checkAllBoxes === true });
      await humanPause();
      if (!await clickNamedButton(smsTarget, [turkishFoldRegex("Doğrula"), turkishFoldRegex("Onayla")]) && !await clickSubmit(smsTarget)) {
        return { status: "mapping_required", message: "SMS doğrulamasında 'Doğrula' düğmesi bulunamadı" };
      }
      if (isCancelled()) return cancelled();
      await page.waitForTimeout(1500);
    }

    // 4) Tanıtım/izin pencerelerinde "Hayır"
    for (let attempt = 0; attempt < 3; attempt += 1) {
      if (!await dismissNoPopup(await resolveTarget(page, portal))) break;
      await page.waitForTimeout(600);
    }
    if (isCancelled()) return cancelled();

    // 5) Ruhsat bilgileri (plaka + belge seri + belge no)
    await setState("filling", "Plaka ve ruhsat bilgileri dolduruluyor");
    const vehicleTarget = await resolveTarget(page, portal);
    await clickNamedButton(vehicleTarget, [turkishFoldRegex("Plakam Var")], { maxTextLength: 24 }).catch(() => {});
    const plateFilled = await fillFirst(vehicleTarget, job.vehicle.plate,
      ['input[name*="plaka" i]', 'input[name*="plate" i]', 'input[placeholder*="plaka" i]'],
      ["Araç Plaka No", "Plaka No", "Plaka"]);
    const registrationFilled = await fillSplitRegistrationIfPresent(vehicleTarget, job.vehicle.registration);
    if (!plateFilled && !registrationFilled) {
      return { status: "mapping_required", message: "Ruhsat ekranındaki alanlar bulunamadı" };
    }
    await humanPause();
    if (!await clickNamedButton(vehicleTarget, [turkishFoldRegex("Onayla")]) && !await clickSubmit(vehicleTarget)) {
      return { status: "mapping_required", message: "Ruhsat ekranında 'Onayla' düğmesi bulunamadı" };
    }
    if (isCancelled()) return cancelled();

    // 6) EGM sonrası "İleri", ardından geçmiş poliçe adımı
    await setState("collecting", "EGM sorgusu bekleniyor");
    const egmTarget = await resolveTarget(page, portal);
    await this.#waitFor(page, async () => (
      await clickNamedButton(egmTarget, [turkishFoldExact("İleri"), turkishFoldRegex("Devam Et")]) ? true : null
    ), 40000);

    // Sabit bir gecikme yetmiyor: düğme tıklaması ile bir sonraki ekranın
    // çizilmesi arasındaki süre değişken. Geçmiş poliçe adımının kendi
    // işaretini (seçenek ya da "Teklifleri Getir") görene kadar beklenir.
    await setState("filling", "Geçmiş poliçe adımı bekleniyor");
    const policyTarget = await this.#waitFor(page, async () => {
      const candidate = await resolveTarget(page, portal);
      const marker = candidate.getByRole("button", { name: turkishFoldRegex("Teklifleri Getir") }).first();
      if (await marker.isVisible({ timeout: 300 }).catch(() => false)) return candidate;
      const option = candidate.locator("label, li, div").filter({ hasText: turkishFoldRegex("poliçem yok") }).last();
      return await option.isVisible({ timeout: 300 }).catch(() => false) ? candidate : null;
    }, 40000) || await resolveTarget(page, portal);

    await setState("filling", "Geçmiş poliçe adımı geçiliyor");
    await this.#selectNoPolicyOption(policyTarget);
    await humanPause();
    if (!await clickNamedButton(policyTarget, [turkishFoldRegex("Teklifleri Getir")]) && !await clickSubmit(policyTarget)) {
      return { status: "mapping_required", message: "'Teklifleri Getir' düğmesi bulunamadı" };
    }

    // 7) Teklifler (ortak döngü tüm şirketler toplanana kadar bekler)
    await setState("submitted", "Teklifler bekleniyor");
    const outcomeTarget = await resolveTarget(page, portal);
    const attemptedStages = new Set([await formSignature(outcomeTarget)]);
    return waitForOutcome({ page, target: outcomeTarget, job, portal, resultTimeoutMs, requestOtp, requestCaptchaSolve, setState, isCancelled, attemptedStages });
  }

  // "Mevcut ya da yeni Trafik poliçem yok" gibi, içinde "yok" geçen seçeneği
  // işaretler (hasarsızlık indirimi sorusu; elimizde poliçe bilgisi yok).
  async #selectNoPolicyOption(target) {
    const option = target.locator('label, .form-check, li, div')
      .filter({ hasText: turkishFoldRegex("poliçem yok") }).last();
    if (await option.isVisible({ timeout: 500 }).catch(() => false)) {
      const radio = option.locator('input[type="radio"], input[type="checkbox"]').first();
      if (await radio.count().catch(() => 0)) {
        if (!await radio.isChecked({ timeout: 300 }).catch(() => false)) {
          await radio.check({ force: true, timeout: 3000 }).catch(() => {});
        }
        return true;
      }
      await option.click({ force: true, timeout: 3000 }).catch(() => {});
      return true;
    }
    return false;
  }

  async #selectLocation(target, labels, value) {
    for (const label of labels) {
      const control = target.getByLabel(turkishFoldRegex(label)).first();
      if (!await control.isVisible({ timeout: 300 }).catch(() => false)) continue;
      const tag = await control.evaluate((element) => element.tagName.toLowerCase()).catch(() => "");
      if (tag === "select") {
        if (await this.#selectOptionByLabel(control, value)) return true;
        continue;
      }
      // Arama kutulu (autocomplete) açılır listeler: yaz, sonra öneriye tıkla.
      await control.click({ timeout: 2000 }).catch(() => {});
      await control.fill(value, { timeout: 2000 }).catch(() => {});
      await target.page().waitForTimeout(600);
      const suggestion = target.getByRole("option", { name: turkishFoldRegex(value) }).first();
      if (await suggestion.isVisible({ timeout: 800 }).catch(() => false)) {
        await suggestion.click({ timeout: 2000 }).catch(() => {});
        return true;
      }
      return true;
    }
    return false;
  }

  async #selectOptionByLabel(select, value) {
    const options = await select.locator("option").evaluateAll((nodes) => nodes.map((node) => ({
      value: node.value,
      label: (node.textContent || "").trim(),
      disabled: node.disabled,
    }))).catch(() => []);
    const wanted = String(value).toLocaleUpperCase("tr-TR");
    const match = options.find((option) => !option.disabled && String(option.value || "").trim()
      && option.label.toLocaleUpperCase("tr-TR").includes(wanted));
    if (!match) return false;
    return select.selectOption(match.value, { timeout: 4000 }).then(() => true).catch(() => false);
  }

  async #waitFor(page, probe, timeoutMs) {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      const value = await probe().catch(() => null);
      if (value) return value;
      await page.waitForTimeout(500);
    }
    return null;
  }
}

export default new Sigorta7Adapter();
