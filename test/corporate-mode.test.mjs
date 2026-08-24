import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import { isCorporateName, isCorporateJob } from "../src/lib/validation.mjs";

const formAdapterSource = fs.readFileSync(new URL("../src/adapters/form-adapter.mjs", import.meta.url), "utf8");

// Kullanıcı talebi: ad/soyad alanında GIDA, SANAYİ, TİCARET, LİMİTED, ŞİRKET
// gibi ibareler varsa tüm portallarda Vergi Kimlik No / Kurumsal seçilmeli.
test("kurumsal ünvan ibareleri tanınır", () => {
  assert.ok(isCorporateName("ERDEM GIDA SANAYİ VE TİCARET LİMİTED ŞİRKETİ"));
  assert.ok(isCorporateName("ABC OTOMOTİV A.Ş"));
  assert.ok(isCorporateName("XYZ İNŞAAT LTD. ŞTİ."));
});

test("Türkçe küçük/büyük harf farkı kurumsal tespitini bozmaz", () => {
  assert.ok(isCorporateName("erdem gida sanayi ticaret limited sirketi"));
  assert.ok(isCorporateName("Erdem Gıda Sanayi ve Ticaret Limited Şirketi"));
});

test("gerçek kişi adları kurumsal sayılmaz", () => {
  assert.equal(isCorporateName("MEHMET YILMAZ"), false);
  assert.equal(isCorporateName("Ayşe Demir"), false);
  assert.equal(isCorporateName(""), false);
});

test("10 haneli kimlik (VKN) kurumsal sayılır, 11 hane (TC) sayılmaz", () => {
  assert.ok(isCorporateJob({ fullName: "MEHMET YILMAZ", identity: "5250073539" }));
  assert.equal(isCorporateJob({ fullName: "MEHMET YILMAZ", identity: "12345678901" }), false);
});

test("kurumsal sorguda doğum tarihi yetkili TC ile karıştırılmaz", () => {
  const authorizedBlock = formAdapterSource.slice(
    formAdapterSource.indexOf('authorizedIdentity: async () =>'),
    formAdapterSource.indexOf('birthDate: async () =>'),
  );
  const birthDateBlock = formAdapterSource.slice(
    formAdapterSource.indexOf('birthDate: async () =>'),
    formAdapterSource.indexOf('plate: async () =>'),
  );
  assert.doesNotMatch(authorizedBlock, /Doğum Tarihi/);
  assert.doesNotMatch(birthDateBlock, /isCorporateJob/);
  assert.match(birthDateBlock, /fillBirthDate/);
});
