import { FormPortalAdapter, clickNamedButton, fillQuoteForm, resolveTarget, turkishFoldRegex } from "../form-adapter.mjs";
import { clickStep, fillCurrentStep, finishFlow, personalFormJob } from "./flow-tools.mjs";

export class SigortaladimAdapter extends FormPortalAdapter {
  async run(context) {
    const { page, portal, job, navigationTimeoutMs, setState, isCancelled } = context;
    await setState("opening", "Sigortaladım açılıyor");
    await page.goto(portal.url, { waitUntil: "domcontentloaded", timeout: navigationTimeoutMs });
    if (isCancelled()) return { status: "cancelled", message: "Sorgu iptal edildi" };
    await setState("filling", "Kişisel bilgiler dolduruluyor");
    let target = await fillCurrentStep(page, portal, personalFormJob(job), ["identity", "nameEmail", "phone", "birthDate", "city", "district", "occupation"]);
    if (!await clickStep(target, ["Onayla"], 3)) return { status: "mapping_required", message: "Kişisel bilgilerde Onayla düğmesi bulunamadı" };
    await page.waitForTimeout(1000);
    target = await resolveTarget(page, portal);
    await clickNamedButton(target, [turkishFoldRegex("Plakam Var")], { maxTextLength: 24 });
    await page.waitForTimeout(600);
    target = await resolveTarget(page, portal);
    await fillQuoteForm(target, job, { ...portal, fieldOrder: ["plate", "registration"] });
    if (!await clickStep(target, ["Devam Et", "Devam"], 3)) return { status: "mapping_required", message: "Ruhsat bilgilerinde Devam düğmesi bulunamadı" };
    await page.waitForTimeout(900);
    target = await resolveTarget(page, portal);
    if (!await clickStep(target, ["Devam Et", "Devam"], 3)) return { status: "mapping_required", message: "Araç bilgilerinde Devam düğmesi bulunamadı" };
    await setState("collecting", "Sigortaladım teklifleri hazırlanıyor");
    return finishFlow(context, 120000);
  }
}

export default new SigortaladimAdapter();
