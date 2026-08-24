import { FormPortalAdapter, ensurePlateAvailable, fillBirthDate, fillFirst, resolveTarget } from "../form-adapter.mjs";
import { clickStep, fillExplicitIdentity, finishFlow, personalFormJob } from "./flow-tools.mjs";

export class SigortaYeriAdapter extends FormPortalAdapter {
  async run(context) {
    const { page, portal, job, navigationTimeoutMs, setState } = context;
    await setState("opening", "Sigorta Yeri açılıyor");
    await page.goto(portal.url, { waitUntil: "domcontentloaded", timeout: navigationTimeoutMs });
    const target = await resolveTarget(page, portal);
    await ensurePlateAvailable(target);
    await fillFirst(target, job.vehicle.plate,
      ['input[name*="plate" i]', 'input[name*="plaka" i]', 'input[placeholder*="plaka" i]'], ["Plaka"]);
    await fillExplicitIdentity(target, personalFormJob(job));
    await fillBirthDate(target, job.vehicle.birthDate);
    if (!await clickStep(target, ["Fiyatı Gör", "Fiyat Gör"], 3)) return { status: "mapping_required", message: "Fiyatı Gör düğmesi bulunamadı" };
    await setState("collecting", "Sigorta Yeri teklifleri hazırlanıyor");
    return finishFlow(context, 150000);
  }
}

export default new SigortaYeriAdapter();
