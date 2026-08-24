import {
  FormPortalAdapter,
  acceptRequiredConsents,
  clickNamedButton,
  clickSubmit,
  detectCaptcha,
  dismissNoPopup,
  fillOtpCode,
  fillFirst,
  fillSplitRegistrationIfPresent,
  fillVisibleInputsByOrder,
  findOtpInput,
  formSignature,
  humanPause,
  resolveTarget,
  turkishFoldRegex,
  visibleText,
  waitForOutcome,
} from "../form-adapter.mjs";
import { RESEND_SENTINEL } from "../../lib/validation.mjs";
import { personalFormJob } from "./flow-tools.mjs";

// Sigortambir (sigortambir) — kullanıcının adım adım tarif ettiği akış:
//  1) Canlı formun ilk üç alanı sırayla TC, plaka, telefon; "Devam Et".
//  2) Açılan pencerede SMS doğrulaması: kod yazılır, alttaki onay kutuları
//     işaretlenir, "Onayla".
//  3) Meslek sayfası: "Diğer" zaten seçili gelir, "Devam Et".
//  4) "Ruhsat seri/belge numaranızı biliyor musunuz?" sorusunda
//     "Evet, biliyorum" tıklanır; altında açılan forma seri (ilk iki harf)
//     ve no (kalan rakamlar) AYRI AYRI yazılır, "Devam Et".
//  5) EGM sonucu beklenir, tekrar "Devam Et" ile teklifler toplanır.
export class SigortambirAdapter extends FormPortalAdapter {
  async run(context) {
    const { page, portal, job, navigationTimeoutMs, resultTimeoutMs, requestOtp, requestCaptchaSolve, setState, isCancelled } = context;
    const cancelled = () => isCancelled() && { status: "cancelled", message: "Sorgu iptal edildi" };

    await setState("opening", "Sigortambir açılıyor");
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

    // 1) TC -> plaka -> telefon (alanlar belirgin etiket taşımadığından sırayla)
    const target = await resolveTarget(page, portal);
    await dismissNoPopup(target);
    await setState("filling", "TC, plaka ve telefon dolduruluyor");
    const phone10 = job.phone.replace(/^0/, "");
    const effectiveJob = personalFormJob(job);
    const [identityFilled] = await fillVisibleInputsByOrder(target, [effectiveJob.vehicle.identity, job.vehicle.plate, phone10]);
    if (!identityFilled) return { status: "mapping_required", message: "Sigortambir'in ilk canlı veri alanları bulunamadı" };
    await humanPause();
    if (!await clickNamedButton(target, [turkishFoldRegex("Devam Et")]) && !await clickSubmit(target)) {
      return { status: "mapping_required", message: "'Devam Et' düğmesi bulunamadı" };
    }
    if (isCancelled()) return cancelled();

    // 2) SMS doğrulama penceresi
    await setState("submitted", "Telefon doğrulaması bekleniyor");
    const otpInput = await this.#waitFor(page, () => findOtpInput(target), 30000);
    if (otpInput) {
      if (job.mode === "no_sms") return { status: "skipped_sms", message: "SMS istendiği için atlandı" };
      let code = await requestOtp();
      while (code === RESEND_SENTINEL) {
        if (!await clickNamedButton(target, [turkishFoldRegex("Yeniden Gönder"), turkishFoldRegex("Tekrar Gönder")])) {
          return { status: "mapping_required", message: "Kodu tekrar gönderme düğmesi bulunamadı" };
        }
        code = await requestOtp();
      }
      if (!await fillOtpCode(target, code)) return { status: "mapping_required", message: "SMS kodu alanı doldurulamadı" };
      // Kod kutusunun altındaki zorunlu onay kutuları da işaretlenmeli.
      await acceptRequiredConsents(target, { checkAllBoxes: portal?.checkAllBoxes === true });
      await humanPause();
      if (!await clickNamedButton(target, [turkishFoldRegex("Onayla")]) && !await clickSubmit(target)) {
        return { status: "mapping_required", message: "SMS doğrulamasında 'Onayla' düğmesi bulunamadı" };
      }
      if (isCancelled()) return cancelled();
      await page.waitForTimeout(1500);
    }

    // 3) Meslek sayfasında varsayıma güvenmeden açıkça "Diğer" seçilir.
    await setState("filling", "Meslek olarak Diğer seçiliyor");
    const professionTarget = await resolveTarget(page, portal);
    await dismissNoPopup(professionTarget);
    await fillFirst(professionTarget, "Diğer",
      ['select[name*="meslek" i]', 'select[name*="occupation" i]'], ["Meslek", "Mesleğiniz"]);
    if (!await clickNamedButton(professionTarget, [turkishFoldRegex("Devam Et")])) {
      return { status: "mapping_required", message: "Meslek ekranında Devam Et düğmesi bulunamadı" };
    }
    await page.waitForTimeout(1200);
    if (isCancelled()) return cancelled();

    // 4) "Ruhsat seri biliyor musunuz?" -> Evet -> seri/no ayrı ayrı
    await setState("filling", "Ruhsat seri ve numarası giriliyor");
    const registrationTarget = await resolveTarget(page, portal);
    await clickNamedButton(registrationTarget, [
      turkishFoldRegex("Evet, biliyorum"),
      turkishFoldRegex("Evet"),
    ], { maxTextLength: 24 }).catch(() => {});
    await page.waitForTimeout(900);

    const registrationTargetAfter = await resolveTarget(page, portal);
    const splitFilled = await fillSplitRegistrationIfPresent(registrationTargetAfter, job.vehicle.registration);
    if (!splitFilled) {
      const { seri, no } = this.#splitRegistration(job.vehicle.registration);
      const [seriFilled] = await fillVisibleInputsByOrder(registrationTargetAfter, [seri, no]);
      if (!seriFilled) return { status: "mapping_required", message: "Ruhsat seri/no alanları bulunamadı" };
    }
    await humanPause();
    if (!await clickNamedButton(registrationTargetAfter, [turkishFoldRegex("Devam Et")]) && !await clickSubmit(registrationTargetAfter)) {
      return { status: "mapping_required", message: "Ruhsat ekranında 'Devam Et' düğmesi bulunamadı" };
    }
    if (isCancelled()) return cancelled();

    // 5) EGM sorgusu tamamlanınca Devam Et, ardından çıkan Teklif Al.
    await setState("collecting", "EGM sorgusu bekleniyor");
    const egmTarget = await resolveTarget(page, portal);
    await this.#waitFor(page, async () => (
      await clickNamedButton(egmTarget, [turkishFoldRegex("Devam Et")]) ? true : null
    ), 40000);

    await page.waitForTimeout(900);
    const quoteTarget = await resolveTarget(page, portal);
    if (!await clickNamedButton(quoteTarget, [turkishFoldRegex("Teklif Al")]) && !await clickSubmit(quoteTarget)) {
      return { status: "mapping_required", message: "EGM kontrolünden sonra Teklif Al düğmesi bulunamadı" };
    }

    await setState("submitted", "Teklifler bekleniyor");
    const outcomeTarget = await resolveTarget(page, portal);
    const attemptedStages = new Set([await formSignature(outcomeTarget)]);
    return waitForOutcome({ page, target: outcomeTarget, job, portal, resultTimeoutMs, requestOtp, requestCaptchaSolve, setState, isCancelled, attemptedStages });
  }

  #splitRegistration(registration) {
    const match = String(registration || "").match(/^([A-ZÇĞİÖŞÜ]+)(\d+)$/i);
    return match ? { seri: match[1], no: match[2] } : { seri: registration, no: "" };
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

export default new SigortambirAdapter();
