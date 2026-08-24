import { FormPortalAdapter, acceptRequiredConsents, fillQuoteForm, resolveTarget } from "../form-adapter.mjs";
import { clickStep, fillPersonAndContact, finishFlow, handleOptionalOtp, personalFormJob } from "./flow-tools.mjs";

export class PoliceKesAdapter extends FormPortalAdapter {
  async run(context) {
    const { page, portal, job, navigationTimeoutMs, requestOtp, setState } = context;
    await setState("opening", "PoliçeKes açılıyor");
    await page.goto(portal.url, { waitUntil: "domcontentloaded", timeout: navigationTimeoutMs });
    let target = await resolveTarget(page, portal);
    await clickStep(target, ["Aracımın Sigortası Bitiyor"], 2);
    if (!await clickStep(target, ["Devam"], 3)) return { status: "mapping_required", message: "PoliçeKes başlangıç Devam düğmesi bulunamadı" };
    await page.waitForTimeout(700);
    target = await resolveTarget(page, portal);
    await fillPersonAndContact(target, personalFormJob(job));
    await acceptRequiredConsents(target, { checkAllBoxes: true });
    if (!await clickStep(target, ["Devam"], 4)) return { status: "mapping_required", message: "PoliçeKes kişisel bilgiler adımı ilerletilemedi" };
    await page.waitForTimeout(800);
    target = await resolveTarget(page, portal);
    await fillQuoteForm(target, job, { ...portal, fieldOrder: ["plate", "registration"] });
    if (!await clickStep(target, ["Devam"], 4)) return { status: "mapping_required", message: "PoliçeKes ruhsat adımı ilerletilemedi" };
    await page.waitForTimeout(700);
    target = await resolveTarget(page, portal);
    if (!await clickStep(target, ["Teklif Al"], 3)) return { status: "mapping_required", message: "PoliçeKes Teklif Al düğmesi bulunamadı" };
    const otp = await handleOptionalOtp({ page, portal, job, requestOtp, waitMs: 30000 });
    if (otp.status) return otp;
    await setState("collecting", "PoliçeKes teklifleri hazırlanıyor");
    return finishFlow(context, 180000);
  }
}

export default new PoliceKesAdapter();
