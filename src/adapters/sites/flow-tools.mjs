import {
  acceptRequiredConsents,
  clickNamedButton,
  clickSubmit,
  fillBirthDate,
  fillFirst,
  fillNameAndEmail,
  fillOtpCode,
  fillQuoteForm,
  fillSplitRegistrationIfPresent,
  findOtpInput,
  formSignature,
  humanPause,
  resolveTarget,
  turkishFoldRegex,
  waitForOutcome,
} from "../form-adapter.mjs";
import { isCorporateJob, RESEND_SENTINEL } from "../../lib/validation.mjs";

export function personalFormJob(job) {
  if (!isCorporateJob(job.vehicle) || !job.vehicle.authorizedIdentity) return job;
  return { ...job, vehicle: { ...job.vehicle, identity: job.vehicle.authorizedIdentity } };
}

export async function targetFor(page, portal) {
  return resolveTarget(page, portal);
}

export async function fillCurrentStep(page, portal, job, fieldOrder = null) {
  const target = await targetFor(page, portal);
  const scopedPortal = fieldOrder ? { ...portal, fieldOrder } : portal;
  await fillQuoteForm(target, job, scopedPortal);
  return target;
}

export async function clickStep(target, names, retries = 3) {
  for (let attempt = 0; attempt < retries; attempt += 1) {
    if (await clickNamedButton(target, names.map((name) => turkishFoldRegex(name)))) return true;
    if (!names.length && await clickSubmit(target)) return true;
    await target.waitForTimeout(650).catch(() => {});
  }
  return false;
}

export async function fillExplicitIdentity(target, job) {
  const effective = personalFormJob(job);
  return fillFirst(target, effective.vehicle.identity,
    ['input[name*="identity" i]', 'input[name*="kimlik" i]', 'input[name*="tc" i]', 'input[placeholder*="TC" i]'],
    ["TC Kimlik No", "T.C. Kimlik", "Kimlik Numarası"]);
}

export async function fillExplicitVehicle(target, job) {
  const plate = await fillFirst(target, job.vehicle.plate,
    ['input[name*="plate" i]', 'input[name*="plaka" i]', 'input[placeholder*="plaka" i]'], ["Plaka"]);
  const registration = (await fillSplitRegistrationIfPresent(target, job.vehicle.registration)) || await fillFirst(target, job.vehicle.registration,
    ['input[name*="registration" i]', 'input[name*="ruhsat" i]', 'input[name*="belge" i]', 'input[placeholder*="ruhsat" i]'],
    ["Ruhsat Seri No", "Ruhsat Numarası", "Belge Seri"]);
  return plate || registration;
}

export async function handleOptionalOtp({ page, portal, job, requestOtp, waitMs = 20000 }) {
  const deadline = Date.now() + waitMs;
  while (Date.now() < deadline) {
    const target = await targetFor(page, portal);
    const otpInput = await findOtpInput(target);
    if (otpInput) {
      if (job.mode === "no_sms") return { status: "skipped_sms", message: "SMS istendiği için atlandı" };
      let code = await requestOtp();
      while (code === RESEND_SENTINEL) {
        if (!await clickStep(target, ["Tekrar Gönder", "Yeniden Gönder", "SMS Gönder"], 1)) {
          return { status: "mapping_required", message: "SMS tekrar gönderme düğmesi bulunamadı" };
        }
        code = await requestOtp();
      }
      if (!await fillOtpCode(target, code)) return { status: "mapping_required", message: "SMS kodu alanı doldurulamadı" };
      await acceptRequiredConsents(target, { checkAllBoxes: portal.checkAllBoxes === true });
      if (!await clickStep(target, ["Onayla", "Doğrula", "Devam Et", "Devam"], 2)) await otpInput.press("Enter").catch(() => {});
      await page.waitForTimeout(1200);
      return { verified: true };
    }
    await page.waitForTimeout(450);
  }
  return { verified: false };
}

export async function finishFlow(context, minimumTimeoutMs = 180000) {
  const { page, portal, job, requestOtp, requestCaptchaSolve, setState, isCancelled } = context;
  const target = await targetFor(page, portal);
  const attemptedStages = new Set([await formSignature(target)]);
  return waitForOutcome({
    page, target, job, portal,
    resultTimeoutMs: Math.max(context.resultTimeoutMs, minimumTimeoutMs),
    requestOtp, requestCaptchaSolve, setState, isCancelled, attemptedStages,
  });
}

export async function fillPersonAndContact(target, job) {
  const effective = personalFormJob(job);
  await fillExplicitIdentity(target, effective);
  await fillNameAndEmail(target, effective);
  await fillFirst(target, job.phone.replace(/^0/, ""),
    ['input[type="tel"]', 'input[name*="phone" i]', 'input[name*="telefon" i]', 'input[name*="gsm" i]'],
    ["Cep Telefonu", "Telefon"]);
  if (!isCorporateJob(job.vehicle)) await fillBirthDate(target, job.vehicle.birthDate);
  await acceptRequiredConsents(target, { checkAllBoxes: true });
  await humanPause();
}
