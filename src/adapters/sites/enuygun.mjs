import { FormPortalAdapter, fillNameAndEmail, fillQuoteForm, resolveTarget } from "../form-adapter.mjs";
import { clickStep, finishFlow, personalFormJob } from "./flow-tools.mjs";

export class EnuygunAdapter extends FormPortalAdapter {
  async run(context) {
    const { page, portal, job, navigationTimeoutMs, setState } = context;
    await setState("opening", "Enuygun Sigorta açılıyor");
    await page.goto(portal.url, { waitUntil: "domcontentloaded", timeout: navigationTimeoutMs });
    let target = await resolveTarget(page, portal);
    await setState("filling", "Ad ve soyad ayrı alanlara yazılıyor");
    await fillNameAndEmail(target, personalFormJob(job));
    await fillQuoteForm(target, personalFormJob(job), { ...portal, fieldOrder: ["plate"] });
    if (!await clickStep(target, ["İleri", "Devam"], 3)) return { status: "mapping_required", message: "Enuygun ilk adım ilerletilemedi" };
    await page.waitForTimeout(800);
    target = await resolveTarget(page, portal);
    await fillQuoteForm(target, personalFormJob(job), portal);
    await clickStep(target, ["İleri", "Devam Et", "Teklif Al"], 3);
    return finishFlow(context, 180000);
  }
}

export default new EnuygunAdapter();
