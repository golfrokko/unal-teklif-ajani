import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { fillOtpCode } from "../src/adapters/form-adapter.mjs";

class FakeLocator {
  constructor(items = []) { this.items = items; }
  first() { return new FakeLocator(this.items.slice(0, 1)); }
  nth(index) { return new FakeLocator(this.items.slice(index, index + 1)); }
  async count() { return this.items.length; }
  async isVisible() { return Boolean(this.items[0]?.visible); }
  async evaluate(callback) { return callback(this.items[0].element); }
  async fill(value) { this.items[0].value = value; }
}

function otpItem() {
  const attributes = { type: "text", maxlength: "1", inputmode: "numeric" };
  return {
    visible: true,
    value: "",
    element: {
      name: "",
      id: "",
      placeholder: "",
      maxLength: 1,
      parentElement: { innerText: "SMS doğrulama kodu" },
      getAttribute: (name) => attributes[name] || null,
    },
  };
}

test("parçalı SMS kodunu ayrı kutulara yazar", async () => {
  const items = Array.from({ length: 6 }, otpItem);
  const target = {
    locator(selector) {
      if (selector.includes('input[inputmode="numeric"]') || selector.includes('input[maxlength="1"]')) return new FakeLocator(items);
      return new FakeLocator();
    },
  };
  assert.equal(await fillOtpCode(target, "123456"), true);
  assert.deepEqual(items.map((item) => item.value), ["1", "2", "3", "4", "5", "6"]);
});

test("panel yenilenince aktif sorguya yeniden bağlanma kodu korunur", async () => {
  const source = await readFile(new URL("../public/app.js", import.meta.url), "utf8");
  assert.match(source, /unal-teklif-active-job/);
  assert.match(source, /fetchJson\("\/api\/jobs"\)/);
  assert.match(source, /Object\.values\(job\.portalStates/);
});

test("SMS gönderilir gönderilmez panel bekleme durumuna geçirilir", async () => {
  const source = await readFile(new URL("../src/adapters/ihsan/shared.mjs", import.meta.url), "utf8");
  const sendIndex = source.indexOf("pendingCode = requestOtp()");
  const portalInputIndex = source.indexOf("otpInput = await waitForSessionOtp", sendIndex);
  assert.ok(sendIndex > 0);
  assert.ok(portalInputIndex > sendIndex);
});

test("SMS alanı panelde kalır, canlı ekran ve manuel devam tetiklenmez", async () => {
  const engine = await readFile(new URL("../src/engine.mjs", import.meta.url), "utf8");
  const panel = await readFile(new URL("../public/app.js", import.meta.url), "utf8");
  assert.match(engine, /requestCaptchaSolve: undefined/);
  assert.match(panel, /const waitingForCaptcha = false/);
  assert.match(panel, /state\.status === "waiting_otp"/);
});

test("canlı keşif portalları otomatik sorgulanmaz, kullanıcı seçimi bekler", async () => {
  const source = await readFile(new URL("../src/server.mjs", import.meta.url), "utf8");
  assert.match(source, /available: portal\.deactivated \? false : \(enabled \|\| discoveredReady\)/);
  // Açık seçim yoksa yalnız "enabled" portallar sorgulanır; kullanıcı elle
  // seçtiyse hazır görünmeyen portal da (ör. önce Oturum Aç ile hazırlanan)
  // sorguya dahil edilebilir.
  assert.match(source, /!portal\.deactivated && \(hasExplicitSelection \|\| portalView\(portal\)\.enabled\)/);
  assert.doesNotMatch(source, /enabled:.*discoveredReady/);
});
