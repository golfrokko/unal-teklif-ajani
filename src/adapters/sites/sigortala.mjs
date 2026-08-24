import { FormPortalAdapter, acceptRequiredConsents, fillQuoteForm, resolveTarget, selectCorporateMode } from "../form-adapter.mjs";
import { clickStep, fillPersonAndContact, finishFlow, handleOptionalOtp, personalFormJob } from "./flow-tools.mjs";
import { isCorporateJob } from "../../lib/validation.mjs";

export class SigortalaAdapter extends FormPortalAdapter {
  async run(context) {
    const { page, portal, job, navigationTimeoutMs, requestOtp, setState } = context;
    await setState("opening", "Sigorta.la açılıyor");
    await page.goto(portal.url, { waitUntil: "domcontentloaded", timeout: navigationTimeoutMs });
    let target = await resolveTarget(page, portal);
    if (!await clickStep(target, ["Aracımın Sigortası Bitiyor"], 3)) return { status: "mapping_required", message: "Sigorta.la başlangıç seçeneği bulunamadı" };
    await page.waitForTimeout(700);
    target = await resolveTarget(page, portal);
    if (isCorporateJob(job.vehicle)) await selectCorporateMode(target);
    await fillPersonAndContact(target, personalFormJob(job));
    await acceptRequiredConsents(target, { checkAllBoxes: true });
    for (let index = 0; index < 3; index += 1) {
      if (!await clickStep(target, ["Kabul Et"], 1)) break;
      await page.waitForTimeout(350);
    }
    if (!await clickStep(target, ["Devam"], 4)) return { status: "mapping_required", message: "Sigorta.la kişisel bilgiler adımı ilerletilemedi" };
    await page.waitForTimeout(800);
    target = await resolveTarget(page, portal);
    await fillQuoteForm(target, job, { ...portal, fieldOrder: ["plate", "registration"] });
    if (!await clickStep(target, ["Devam"], 4)) return { status: "mapping_required", message: "Sigorta.la ruhsat adımı ilerletilemedi" };
    await page.waitForTimeout(700);
    target = await resolveTarget(page, portal);
    if (!await clickStep(target, ["Teklif Al"], 3)) return { status: "mapping_required", message: "Sigorta.la Teklif Al düğmesi bulunamadı" };
    const otp = await handleOptionalOtp({ page, portal, job, requestOtp, waitMs: 30000 });
    if (otp.status) return otp;
    await setState("collecting", "Sigorta.la teklifleri hazırlanıyor");
    return finishFlow(context, 180000);
  }
}

export default new SigortalaAdapter();
