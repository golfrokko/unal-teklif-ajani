import test from "node:test";
import assert from "node:assert/strict";
import { isCorporateName, isCorporateJob } from "../src/lib/validation.mjs";
import { splitFullName } from "../src/adapters/form-adapter.mjs";
import { personalFormJob } from "../src/adapters/sites/flow-tools.mjs";

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
  assert.ok(isCorporateJob({ fullName: "MEHMET YILMAZ", identity: "1".repeat(10) }));
  assert.equal(isCorporateJob({ fullName: "MEHMET YILMAZ", identity: "1".repeat(11) }), false);
});

test("şirket unvanında son kelime soyad, önceki kelimeler ad olur", () => {
  assert.deepEqual(splitFullName("ÜNAL SİGORTA ARACILIK HİZMETLERİ"), {
    first: "ÜNAL SİGORTA ARACILIK",
    last: "HİZMETLERİ",
  });
});

test("şirket sorgusunda portala kullanıcının verdiği yetkili TC gönderilir", () => {
  const job = {
    vehicle: {
      fullName: "ÜNAL SİGORTA ARACILIK HİZMETLERİ",
      identity: "1".repeat(10),
      authorizedIdentity: "2".repeat(11),
      email: "ornek@example.invalid",
    },
  };
  const effective = personalFormJob(job);
  assert.equal(effective.vehicle.identity, "2".repeat(11));
  assert.equal(effective.vehicle.email, "ornek@example.invalid");
  assert.equal(job.vehicle.identity, "1".repeat(10));
});
