import test from "node:test";
import assert from "node:assert/strict";
import { chooseBestOption, DETECTED_STATE_MESSAGES } from "../src/adapters/ihsan/shared.mjs";
import { pageState } from "../src/adapters/form-adapter.mjs";

test("İhsan seçimlerinde tam model yılını seçer", () => {
  const option = chooseBestOption([
    { value: "", label: "Seçiniz", disabled: false },
    { value: "2011", label: "2011", disabled: false },
    { value: "2012", label: "2012", disabled: false },
  ], ["2012"]);
  assert.equal(option.value, "2012");
});

test("İhsan seçimlerinde araç metninden marka seçer", () => {
  const option = chooseBestOption([
    { value: "1", label: "RENAULT", disabled: false },
    { value: "2", label: "HYUNDAI", disabled: false },
    { value: "3", label: "VOLKSWAGEN", disabled: false },
  ], ["HYUNDAI ACCENT ERA 1.4"]);
  assert.equal(option.value, "2");
});

test("boş ve devre dışı seçenekleri kullanmaz", () => {
  const option = chooseBestOption([
    { value: "", label: "Otomobil", disabled: false },
    { value: "car", label: "Otomobil", disabled: true },
  ], ["Otomobil"]);
  assert.equal(option, null);
});

test("İhsan altyapısı hız sınırı bildirdiğinde açık bir bekleme mesajı gösterir (İskenderun tipi)", () => {
  assert.equal(pageState("ÇOK FAZLA İSTEK GÖNDERİLDİ, LÜTFEN DAHA SONRA TEKRAR DENEYİN"), "rate_limited");
  assert.match(DETECTED_STATE_MESSAGES.rate_limited, /1 dakika sonra oluşturulacak/);
});
