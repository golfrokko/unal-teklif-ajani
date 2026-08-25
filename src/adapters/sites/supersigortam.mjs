import {
  FormPortalAdapter, acceptRequiredConsents, clickNamedButton, fillFirst,
  fillNameAndEmail, fillQuoteForm, formSignature, resolveTarget,
  turkishFoldExact, waitForOutcome,
} from "../form-adapter.mjs";

async function hasSecondStage(target) {
  const fields = target.locator([
    'input[name*="identity" i]', 'input[name*="kimlik" i]', 'input[name*="tc" i]',
    'input[name*="plate" i]', 'input[name*="plaka" i]', 'input[name*="ruhsat" i]',
  ].join(","));
  const count = Math.min(await fields.count().catch(() => 0), 20);
  for (let index = 0; index < count; index += 1) {
    if (await fields.nth(index).isVisible({ timeout: 300 }).catch(() => false)) return true;
  }
  return false;
}

export class SuperSigortamAdapter extends FormPortalAdapter {
  async run(context) {
    const { page, portal, job, navigationTimeoutMs, resultTimeoutMs, requestOtp, requestCaptchaSolve, requestCaptchaCode, setState, isCancelled } = context;
    await setState("opening", "SüperSigortam açılıyor");
    await page.goto(portal.url, { waitUntil: "domcontentloaded", timeout: navigationTimeoutMs });
    await page.waitForTimeout(900);
    if (isCancelled()) return { status: "cancelled", message: "Sorgu iptal edildi" };

    let target = await resolveTarget(page, portal);
    await setState("filling", "Ad, soyad, telefon ve e-posta dolduruluyor");
    const contact = await fillNameAndEmail(target, job);
    const phone10 = job.phone.replace(/^0/, "");
    const phone = await fillFirst(target, phone10,
      ['input[type="tel"]', 'input[name*="phone" i]', 'input[name*="telefon" i]', 'input[name*="gsm" i]'],
      ["Telefon", "Cep Telefonu"]);
    await acceptRequiredConsents(target, { checkAllBoxes: portal.checkAllBoxes === true });
    if (!contact.fullName || !phone) return { status: "mapping_required", message: "İlk ekrandaki ad/soyad veya telefon alanları eşleştirilemedi" };

    let secondStage = false;
    for (let attempt = 1; attempt <= 3 && !secondStage; attempt += 1) {
      const clicked = await clickNamedButton(target, [turkishFoldExact("Devam Et"), turkishFoldExact("Devam")]);
      if (!clicked) break;
      await page.waitForTimeout(1200);
      target = await resolveTarget(page, portal);
      secondStage = await hasSecondStage(target);
      if (!secondStage) {
        await fillNameAndEmail(target, job);
        await fillFirst(target, phone10, ['input[type="tel"]', 'input[name*="telefon" i]', 'input[name*="phone" i]'], ["Telefon"]);
        await acceptRequiredConsents(target, { checkAllBoxes: portal.checkAllBoxes === true });
      }
    }
    if (!secondStage) return { status: "mapping_required", message: "Devam Et sonrası kimlik ve araç bilgileri ekranı açılmadı" };

    await setState("filling", "T.C., doğum tarihi, plaka ve ruhsat dolduruluyor");
    const filled = await fillQuoteForm(target, job, { ...portal, fieldOrder: ["identity", "birthDate", "plate", "registration"] });
    if (!filled.identity || !filled.plate || !filled.registration) return { status: "mapping_required", message: "İkinci ekrandaki T.C., plaka veya ruhsat alanları eşleştirilemedi" };
    const attemptedStages = new Set([await formSignature(target)]);
    if (!await clickNamedButton(target, [turkishFoldExact("Teklifleri Hazırla"), turkishFoldExact("Teklif Hazırla")])) {
      return { status: "mapping_required", message: "Teklifleri Hazırla düğmesi bulunamadı" };
    }
    await setState("collecting", "SüperSigortam teklifleri hazırlanıyor");
    return waitForOutcome({
      page, target, job, portal: { ...portal, offerCollectionWindowMs: 30000 },
      resultTimeoutMs: Math.max(Number(resultTimeoutMs) || 0, 150000),
      requestOtp, requestCaptchaSolve, requestCaptchaCode, setState, isCancelled, attemptedStages,
    });
  }
}

export default new SuperSigortamAdapter();
