import { FormPortalAdapter, fillQuoteForm, resolveTarget } from "../form-adapter.mjs";
import { clickStep, finishFlow, personalFormJob } from "./flow-tools.mjs";

export class KoalayAdapter extends FormPortalAdapter {
  async run(context) {
    const { page, portal, job, navigationTimeoutMs, setState } = context;
    await setState("opening", "Koalay açılıyor");
    await page.goto(portal.url, { waitUntil: "domcontentloaded", timeout: navigationTimeoutMs });
    const target = await resolveTarget(page, portal);
    await setState("filling", "TC, doğum tarihi, telefon ve e-posta dolduruluyor");
    await fillQuoteForm(target, personalFormJob(job), { ...portal, fieldOrder: ["identity", "birthDate", "phone", "nameEmail"] });
    if (!await clickStep(target, ["Teklif Al"], 3)) return { status: "mapping_required", message: "Koalay Teklif Al düğmesi bulunamadı" };
    await setState("collecting", "Koalay teklifleri hazırlanıyor");
    return finishFlow(context, 150000);
  }
}

export default new KoalayAdapter();
