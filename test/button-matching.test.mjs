import test from "node:test";
import assert from "node:assert/strict";
import { turkishFoldRegex, turkishFoldExact } from "../src/adapters/form-adapter.mjs";

// Gerçek hata: "İleri" deseni alt dize olarak arandığında "Araç ve Ruhsat
// Bilgileri" başlığındaki "Bilg-İLERİ" ile eşleşiyor ve otomasyon başlığa
// tıklayıp akışı yanlış ilerletiyordu. Kısa düğme adları TAM eşleşme ister.
test("kısa düğme adı sayfa metnindeki kelimenin içinde eşleşmez", () => {
  assert.ok(turkishFoldRegex("İleri").test("Araç ve Ruhsat Bilgileri"), "alt dize deseni yanlış eşleşiyor (hatanın kanıtı)");
  assert.equal(turkishFoldExact("İleri").test("Araç ve Ruhsat Bilgileri"), false);
});

test("tam eşleşme gerçek düğme metnini yakalar", () => {
  assert.ok(turkishFoldExact("İleri").test("İleri"));
  assert.ok(turkishFoldExact("İleri").test("ileri"), "Türkçe İ/i katlaması korunmalı");
  assert.ok(turkishFoldExact("İleri").test("  İleri  "), "kenar boşlukları tolere edilmeli");
});

test("Devam tam eşleşmesi 'Devam Et' başlığına takılmaz", () => {
  assert.equal(turkishFoldExact("Devam").test("Devam Ediyor musunuz"), false);
  assert.ok(turkishFoldExact("Devam").test("Devam"));
});
