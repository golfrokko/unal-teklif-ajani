import {
  FormPortalAdapter, clickNamedButton, ensurePlateAvailable, fillQuoteForm,
  formSignature, resolveTarget, turkishFoldExact, waitForOutcome,
} from "../form-adapter.mjs";

export class SigortaYeriAdapter extends FormPortalAdapter {
  async run(context) {
    const { page, portal, job, navigationTimeoutMs, resultTimeoutMs, requestOtp, requestCaptchaSolve, requestCaptchaCode, setState, isCancelled } = context;
    await setState("opening", "Sigorta Yeri açılıyor");
    await page.goto(portal.url, { waitUntil: "domcontentloaded", timeout: navigationTimeoutMs });
    await page.waitForTimeout(900);
    const target = await resolveTarget(page, portal);
    await ensurePlateAvailable(target);
    await page.waitForTimeout(350);
    await setState("filling", "Plaka, kimlik, doğum tarihi ve iletişim bilgileri dolduruluyor");
    const filled = await fillQuoteForm(target, job, { ...portal, fieldOrder: ["plate", "identity", "birthDate", "nameEmail", "phone"] });
    if (!filled.plate || !filled.identity || !filled.birthDate) return { status: "mapping_required", message: "Sigorta Yeri plaka, T.C./VKN veya doğum tarihi alanı eşleştirilemedi" };
    const attemptedStages = new Set([await formSignature(target)]);
    if (!await clickNamedButton(target, [turkishFoldExact("Fiyatı Gör"), turkishFoldExact("Fiyat Gör")])) return { status: "mapping_required", message: "Fiyatı Gör düğmesi bulunamadı" };
    await setState("submitted", "Sigorta Yeri formu gönderildi; sonraki adımlar izleniyor");
    return waitForOutcome({ page, target, job, portal, resultTimeoutMs, requestOtp, requestCaptchaSolve, requestCaptchaCode, setState, isCancelled, attemptedStages });
  }
}

export default new SigortaYeriAdapter();
