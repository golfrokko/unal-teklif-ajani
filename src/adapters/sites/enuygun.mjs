import {
  FormPortalAdapter, clickNamedButton, ensurePlateAvailable, fillFirst,
  fillNameAndEmail, formSignature, resolveTarget, turkishFoldExact,
  waitForOutcome,
} from "../form-adapter.mjs";

export class EnuygunAdapter extends FormPortalAdapter {
  async run(context) {
    const { page, portal, job, navigationTimeoutMs, resultTimeoutMs, requestOtp, requestCaptchaSolve, requestCaptchaCode, setState, isCancelled } = context;
    await setState("opening", "Enuygun Sigorta açılıyor");
    await page.goto(portal.url, { waitUntil: "domcontentloaded", timeout: navigationTimeoutMs });
    await page.waitForTimeout(900);
    const target = await resolveTarget(page, portal);
    await ensurePlateAvailable(target);
    await setState("filling", "Ad, soyad, e-posta ve plaka dolduruluyor");
    const contact = await fillNameAndEmail(target, job);
    const plate = await fillFirst(target, job.vehicle.plate,
      ['input[name*="plate" i]', 'input[name*="plaka" i]', 'input[placeholder*="plaka" i]'], ["Plaka"]);
    if (!contact.fullName || !contact.email || !plate) return { status: "mapping_required", message: "Enuygun ad, soyad, e-posta veya plaka alanı eşleştirilemedi" };
    const attemptedStages = new Set([await formSignature(target)]);
    if (!await clickNamedButton(target, [turkishFoldExact("İleri")])) return { status: "mapping_required", message: "Enuygun İleri düğmesi bulunamadı" };
    await setState("submitted", "Kimlik bilgileri gönderildi; sonraki adımlar izleniyor");
    return waitForOutcome({ page, target, job, portal, resultTimeoutMs, requestOtp, requestCaptchaSolve, requestCaptchaCode, setState, isCancelled, attemptedStages });
  }
}

export default new EnuygunAdapter();
