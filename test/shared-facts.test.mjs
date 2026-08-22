import test from "node:test";
import assert from "node:assert/strict";
import { captureSharedFacts, pageState } from "../src/adapters/form-adapter.mjs";

// Bir portalın EGM ekranında gördüğü "Hasarsızlık Kademesi" bilgisi, aynı
// sorgu içindeki başka bir portalın (ör. Sigorta Kurdu) kendi formunda
// tekrar sorulmasına gerek kalmadan kullanılabilsin diye job üzerinde
// saklanıyor (bkz. form-adapter.mjs fillQuoteForm).
test("hasarsızlık kademesini metinden yakalayıp job'a kaydeder", () => {
  const job = {};
  captureSharedFacts(job, "EGM Sonucu: Hasarsızlık Kademesi: 4. Devam edin.");
  assert.equal(job.capturedFacts.hasarsizlikKademesi.value, "4");
});

test("noktalı/noktasız İ varyantlarının hepsini yakalar", () => {
  const jobDotted = {};
  captureSharedFacts(jobDotted, "HASARSIZLIK KADEMESİ: 2");
  assert.equal(jobDotted.capturedFacts.hasarsizlikKademesi.value, "2");

  const jobLower = {};
  captureSharedFacts(jobLower, "hasarsızlık kademesi 0");
  assert.equal(jobLower.capturedFacts.hasarsizlikKademesi.value, "0");
});

test("ilk yakalanan değeri korur, sonrakiyle üzerine yazmaz", () => {
  const job = {};
  captureSharedFacts(job, "Hasarsızlık Kademesi: 4");
  captureSharedFacts(job, "Hasarsızlık Kademesi: 0");
  assert.equal(job.capturedFacts.hasarsizlikKademesi.value, "4");
});

test("eşleşme yoksa job'u değiştirmez", () => {
  const job = {};
  captureSharedFacts(job, "Herhangi bir bilgi yok");
  assert.equal(job.capturedFacts, undefined);
});

test("hız sınırı metnini tanır (İskenderun tipi paylaşımlı backend hatası)", () => {
  assert.equal(pageState("ÇOK FAZLA İSTEK GÖNDERİLDİ"), "rate_limited");
});
