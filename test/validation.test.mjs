import test from "node:test";
import assert from "node:assert/strict";
import { normalizeEmail, normalizeOtp, normalizePhone, normalizeVehicle, validateJobInput } from "../src/lib/validation.mjs";

test("telefon numarasını Türkiye mobil biçimine getirir", () => {
  assert.equal(normalizePhone("+90 545 401 29 62"), "05454012962");
  assert.equal(normalizePhone("5454012962"), "05454012962");
  assert.equal(normalizePhone("123"), "");
});

test("teklif e-postasını doğrular", () => {
  assert.equal(normalizeEmail(" Teklif@Firma.COM "), "teklif@firma.com");
  assert.equal(normalizeEmail("gecersiz"), "");
});

test("araç alanlarını güvenli biçimde normalize eder", () => {
  const vehicle = normalizeVehicle({ identity: "123 456 789 01", authorizedIdentity: "111 222 333 44", plate: "16 jd 625", chassis: " w0la hl48 " });
  assert.equal(vehicle.identity, "12345678901");
  assert.equal(vehicle.authorizedIdentity, "11122233344");
  assert.equal(vehicle.plate, "16 JD 625");
  assert.equal(vehicle.chassis, "W0LAHL48");
});

test("VKN sorgusunda şirket yetkilisi TC zorunludur", () => {
  const missing = validateJobInput({ customerConsent: true, mode: "no_sms", vehicle: { identity: "1234567890", plate: "16JD625" } }, "");
  assert.match(missing.error, /yetkilisinin/);
  const valid = validateJobInput({ customerConsent: true, mode: "no_sms", vehicle: { identity: "1234567890", authorizedIdentity: "12345678901", plate: "16JD625" } }, "");
  assert.equal(valid.error, undefined);
});

test("müşteri onayı olmadan iş oluşturmaz", () => {
  assert.match(validateJobInput({ customerConsent: false }, "05454012962").error, /onayı/);
  const validated = validateJobInput({
    customerConsent: true,
    phone: "5454012962",
    vehicle: { identity: "12345678901", plate: "16JD625" },
  }, "");
  assert.equal(validated.value.phone, "05454012962");
});

test("SMS'siz mod telefon numarası olmadan çalışır", () => {
  const validated = validateJobInput({
    customerConsent: true,
    mode: "no_sms",
    phone: "",
    vehicle: { identity: "12345678901", plate: "16JD625" },
  }, "");
  assert.equal(validated.error, undefined);
  assert.equal(validated.value.phone, "");
  assert.equal(validated.value.mode, "no_sms");
});

test("SMS kodunu yalnızca rakam olarak kabul eder", () => {
  assert.equal(normalizeOtp("12 34-56"), "123456");
  assert.equal(normalizeOtp("12"), "");
});
