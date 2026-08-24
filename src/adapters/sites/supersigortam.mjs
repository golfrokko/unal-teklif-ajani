import { FormPortalAdapter, fillQuoteForm, resolveTarget } from "../form-adapter.mjs";
import { clickStep, fillPersonAndContact, finishFlow, personalFormJob } from "./flow-tools.mjs";

export class SuperSigortamAdapter extends FormPortalAdapter {
  async run(context) {
    const { page, portal, job, navigationTimeoutMs, setState } = context;
    await setState("opening", "SüperSigortam açılıyor");
    await page.goto(portal.url, { waitUntil: "domcontentloaded", timeout: navigationTimeoutMs });
    let target = await resolveTarget(page, portal);
    await setState("filling", "Ad, soyad, telefon ve e-posta dolduruluyor");
    await fillPersonAndContact(target, personalFormJob(job));
    if (!await clickStep(target, ["Devam Et"], 5)) return { status: "mapping_required", message: "İlk Devam Et düğmesi formu ilerletmedi" };
    await page.waitForTimeout(1000);
    target = await resolveTarget(page, portal);
    await fillQuoteForm(target, personalFormJob(job), { ...portal, fieldOrder: ["identity", "birthDate", "plate", "registration"] });
    if (!await clickStep(target, ["Teklifleri Hazırla"], 4)) return { status: "mapping_required", message: "Teklifleri Hazırla düğmesi bulunamadı" };
    await setState("collecting", "SüperSigortam teklifleri hazırlanıyor");
    return finishFlow(context, 150000);
  }
}

export default new SuperSigortamAdapter();
