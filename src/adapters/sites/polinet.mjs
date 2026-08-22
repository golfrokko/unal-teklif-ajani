import {
  FormPortalAdapter,
  clickNamedButton,
  clickSubmit,
  detectCaptcha,
  fillBirthDate,
  fillVisibleInputsByOrder,
  formSignature,
  humanPause,
  resolveTarget,
  visibleText,
  waitForOutcome,
} from "../form-adapter.mjs";

// Polinet (polinet) — kullanıcı gözlemine göre canlı formun alanları belirgin
// bir isim/etiket taşımıyor; sıraya göre doldurulmalı:
// 1) İlk ekran: 1. alan TC, 2. alan telefon (10 hane, başında 0 yok),
//    ardından "Trafik Sigortası Teklifi Al" tıklanıyor.
// 2) Açılan doğum tarihi ekranı doldurulup "Devam Et" tıklanıyor.
// 3) Script'in yüklenmesi ~20sn sürüyor.
// 4) Sonraki canlı formda 1. alan plaka, 2. alan ruhsat seri+no BİRLİKTE
//    (site kendi ayırıyor; biz bölmüyoruz), ardından "Devam" tıklanıp
//    teklifler hazırlanıyor.
export class PolinetAdapter extends FormPortalAdapter {
  async run(context) {
    const { page, portal, job, navigationTimeoutMs, resultTimeoutMs, requestOtp, requestCaptchaSolve, setState, isCancelled } = context;
    await setState("opening", "Polinet açılıyor");
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
    const phone10 = job.phone.replace(/^0/, "");
    await setState("filling", "TC ve telefon dolduruluyor");
    const [identityFilled] = await fillVisibleInputsByOrder(target, [job.vehicle.identity, phone10]);
    if (!identityFilled) return { status: "mapping_required", message: "Polinet'in ilk canlı veri alanları bulunamadı" };
    await humanPause();
    if (!await clickNamedButton(target, [/Trafik Sigortası Teklifi Al/i])) {
      return { status: "mapping_required", message: "'Trafik Sigortası Teklifi Al' düğmesi bulunamadı" };
    }
    if (isCancelled()) return { status: "cancelled", message: "Sorgu iptal edildi" };
    await page.waitForTimeout(1200);

    await setState("filling", "Doğum tarihi ekranı dolduruluyor");
    const birthTarget = await resolveTarget(page, portal);
    await fillBirthDate(birthTarget, job.vehicle.birthDate);
    await humanPause();
    if (!await clickSubmit(birthTarget)) {
      return { status: "mapping_required", message: "Doğum tarihi ekranında 'Devam Et' düğmesi bulunamadı" };
    }
    if (isCancelled()) return { status: "cancelled", message: "Sorgu iptal edildi" };

    // Kullanıcı gözlemi: bu adımdan sonra script'in yüklenip plaka/ruhsat
    // ekranını hazırlaması ortalama ~20 saniye sürüyor.
    await setState("collecting", "Script yükleniyor; plaka/ruhsat ekranı bekleniyor");
    await page.waitForTimeout(20000);
    if (isCancelled()) return { status: "cancelled", message: "Sorgu iptal edildi" };

    await setState("filling", "Plaka ve ruhsat bilgileri dolduruluyor");
    const vehicleTarget = await resolveTarget(page, portal);
    // Not: Polinet'te ruhsat seri+no TEK bir alana yapıştırılıyor; site
    // kendi içinde seri/no ayrımını otomatik yapıyor (SigortaBin'in aksine
    // burada manuel bölme YAPILMAMALI).
    const [plateFilled, registrationFilled] = await fillVisibleInputsByOrder(vehicleTarget, [job.vehicle.plate, job.vehicle.registration]);
    if (!plateFilled && !registrationFilled) {
      return { status: "mapping_required", message: "Plaka/ruhsat ekranındaki canlı veri alanları bulunamadı" };
    }
    await humanPause();
    const attemptedStages = new Set([await formSignature(vehicleTarget)]);
    if (!await clickNamedButton(vehicleTarget, [/^Devam$/i]) && !await clickSubmit(vehicleTarget)) {
      return { status: "mapping_required", message: "'Devam' düğmesi bulunamadı" };
    }

    await setState("submitted", "Form gönderildi; portal cevabı bekleniyor");
    return waitForOutcome({ page, target: vehicleTarget, job, portal, resultTimeoutMs, requestOtp, requestCaptchaSolve, setState, isCancelled, attemptedStages });
  }
}

export default new PolinetAdapter();
