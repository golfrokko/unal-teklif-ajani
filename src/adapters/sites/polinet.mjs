import {
  FormPortalAdapter,
  clickNamedButton,
  clickSubmit,
  detectCaptcha,
  fillBirthDate,
  fillFirst,
  fillOtpCode,
  fillSplitRegistrationIfPresent,
  fillVisibleInputsByOrder,
  findOtpInput,
  formSignature,
  humanPause,
  resolveTarget,
  visibleText,
  waitForOutcome,
} from "../form-adapter.mjs";
import { RESEND_SENTINEL } from "../../lib/validation.mjs";
import { personalFormJob } from "./flow-tools.mjs";

// Polinet (polinet) — kullanıcı gözlemine göre canlı formun alanları belirgin
// bir isim/etiket taşımıyor; sıraya göre doldurulmalı:
// 1) İlk ekran: 1. alan TC, 2. alan telefon (10 hane, başında 0 yok),
//    ardından "Trafik Sigortası Teklifi Al" tıklanıyor.
// 2) Açılan doğum tarihi ekranı doldurulup "Devam Et" tıklanıyor.
// 3) Script'in yüklenmesi ~20sn sürüyor.
// 4) Sonraki ekran (kullanıcının ekran görüntüsüyle doğrulandı): "Plaka"
//    etiketli bir alan, ardından AYRI "Belge Seri" ve "Belge No" alanları
//    var (ilk varsayımın aksine tek alana yapıştırıp site otomatik
//    ayırmıyor); GT377874 -> seri "GT", no "377874" olacak şekilde ayrı
//    ayrı dolduruluyor, ardından "Devam" tıklanıp teklifler hazırlanıyor.
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
    const effectiveJob = personalFormJob(job);
    const [identityFilled] = await fillVisibleInputsByOrder(target, [effectiveJob.vehicle.identity, phone10]);
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

    // Doğum tarihinden sonra, plaka/ruhsat ekranından önce Polinet SMS
    // doğrulaması gösterebiliyor. Kod alanı görünürse panelden alınan kodu
    // aynı canlı forma yazıp onaylıyoruz; görünmezse oturum açık kabul edilip
    // normal akış sürüyor.
    const otpDeadline = Date.now() + 20000;
    let otpTarget = await resolveTarget(page, portal);
    let otpInput = null;
    while (Date.now() < otpDeadline && !(otpInput = await findOtpInput(otpTarget))) {
      const currentText = await visibleText(otpTarget);
      if (/PLAKA|RUHSAT|BELGE SER[İI]/i.test(currentText.toLocaleUpperCase("tr-TR"))) break;
      await page.waitForTimeout(500);
      otpTarget = await resolveTarget(page, portal);
    }
    if (otpInput) {
      if (job.mode === "no_sms") return { status: "skipped_sms", message: "SMS istendiği için atlandı" };
      let code = await requestOtp();
      while (code === RESEND_SENTINEL) {
        if (!await clickNamedButton(otpTarget, [/Tekrar Gönder/i, /Yeniden Gönder/i, /SMS Gönder/i])) return { status: "mapping_required", message: "SMS tekrar gönderme düğmesi bulunamadı" };
        code = await requestOtp();
      }
      if (!await fillOtpCode(otpTarget, code)) return { status: "mapping_required", message: "Polinet SMS kodu alanı doldurulamadı" };
      if (!await clickNamedButton(otpTarget, [/Doğrula/i, /Onayla/i, /Devam/i])) await otpInput.press("Enter").catch(() => {});
      await page.waitForTimeout(1200);
    }

    // Kullanıcı gözlemi: bu adımdan sonra script'in yüklenip plaka/ruhsat
    // ekranını hazırlaması ortalama ~20 saniye sürüyor.
    await setState("collecting", "Script yükleniyor; plaka/ruhsat ekranı bekleniyor");
    await page.waitForTimeout(otpInput ? 5000 : 20000);
    if (isCancelled()) return { status: "cancelled", message: "Sorgu iptal edildi" };

    await setState("filling", "Plaka ve ruhsat bilgileri dolduruluyor");
    const vehicleTarget = await resolveTarget(page, portal);
    const plateFilled = await fillFirst(vehicleTarget, job.vehicle.plate,
      ['input[name*="plate" i]', 'input[name*="plaka" i]', 'input[placeholder*="plaka" i]'], ["Plaka"]);
    const registrationFilled = (await fillSplitRegistrationIfPresent(vehicleTarget, job.vehicle.registration)) || (await fillFirst(vehicleTarget, job.vehicle.registration,
      ['input[name*="belgeseri" i]', 'input[placeholder*="belge seri" i]'], ["Belge Seri"]));
    if (!plateFilled && !registrationFilled) {
      // Ekran hâlâ tanınamıyorsa, son çare olarak sırayla doldurmayı dene.
      const [plateByOrder, registrationByOrder] = await fillVisibleInputsByOrder(vehicleTarget, [job.vehicle.plate, job.vehicle.registration]);
      if (!plateByOrder && !registrationByOrder) {
        return { status: "mapping_required", message: "Plaka/ruhsat ekranındaki canlı veri alanları bulunamadı" };
      }
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
