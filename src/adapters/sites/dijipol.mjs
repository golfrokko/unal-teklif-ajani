import {
  FormPortalAdapter,
  clickNamedButton,
  detectCaptcha,
  dismissLeadCaptureModal,
  fillVisibleInputsByOrder,
  formSignature,
  humanPause,
  resolveTarget,
  visibleText,
  waitForOutcome,
} from "../form-adapter.mjs";

// Dijipol (dijipol) — kullanıcı gözlemine göre canlı formun ilk ekranı
// belirgin bir isim/etiket taşımıyor; sıraya göre doldurulmalı: 1) TC,
// 2) telefon, 3) plaka, ardından "Trafik Sigortası Teklifi Al" tıklanıyor.
// Bundan sonrası (SMS doğrulaması, "Beni Ara" popup'ının X ile kapatılması,
// sigortalı bilgileri ekranındaki "Meslek: Diğer" seçimi, ruhsat seri/no
// ayrımı, doğrulama ekranında "Devam Et") genel motorun (waitForOutcome +
// fillQuoteForm) zaten desteklediği davranışlar olduğundan oraya devredilir.
export class DijipolAdapter extends FormPortalAdapter {
  async run(context) {
    const { page, portal, job, navigationTimeoutMs, resultTimeoutMs, requestOtp, requestCaptchaSolve, setState, isCancelled } = context;
    await setState("opening", "Dijipol açılıyor");
    await page.goto(portal.url, { waitUntil: "domcontentloaded", timeout: navigationTimeoutMs });
    await page.waitForTimeout(900);
    if (isCancelled()) return { status: "cancelled", message: "Sorgu iptal edildi" };

    let firstText = await visibleText(page);
    for (let attempt = 0; await detectCaptcha(page, firstText); attempt += 1) {
      if (typeof requestCaptchaSolve !== "function" || attempt >= 5) {
        return { status: "manual_required", message: "CAPTCHA / güvenlik kontrolü kullanıcı tarafından tamamlanmalı" };
      }
      await requestCaptchaSolve();
      if (isCancelled()) return { status: "cancelled", message: "Sorgu iptal edildi" };
      firstText = await visibleText(page);
    }

    const target = await resolveTarget(page, portal);
    await dismissLeadCaptureModal(target);
    const phone10 = job.phone.replace(/^0/, "");
    await setState("filling", "TC, telefon ve plaka dolduruluyor");
    const [identityFilled] = await fillVisibleInputsByOrder(target, [job.vehicle.identity, phone10, job.vehicle.plate]);
    if (!identityFilled) return { status: "mapping_required", message: "Dijipol'ün ilk canlı veri alanları bulunamadı" };
    await humanPause();
    await dismissLeadCaptureModal(target);
    if (!await clickNamedButton(target, [/Trafik Sigortası Teklifi Al/i])) {
      return { status: "mapping_required", message: "'Trafik Sigortası Teklifi Al' düğmesi bulunamadı" };
    }

    await setState("submitted", "Form gönderildi; portal cevabı bekleniyor");
    const attemptedStages = new Set([await formSignature(target)]);
    return waitForOutcome({ page, target, job, portal, resultTimeoutMs, requestOtp, requestCaptchaSolve, setState, isCancelled, attemptedStages });
  }
}

export default new DijipolAdapter();
