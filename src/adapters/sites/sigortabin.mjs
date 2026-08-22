import { FormPortalAdapter } from "../form-adapter.mjs";

// SigortaBin (sigortabin) — genel karşılaştırma sitesi akışını kullanır.
// Gözlemlenen akış: TC+Telefon → SMS → Plaka + ayrı Belge Seri/Belge No →
// ~15-16 sn süren EGM/Tramer sorgu-onay ekranı (doldurulacak alan yok,
// yalnız "Devam" düğmesi) → teklif listesi. portals.mjs'te `fresh: true`
// ile işaretli: bu sitenin önbelleği ardışık sorguları karıştırdığından
// browser-manager her seferinde oturum kaydetmeden/okumadan tertemiz bir
// bağlamda açar. Belge Seri/No ayrımı ve boş-alanlı "Devam" ekranı ortak
// adaptördeki genel mekanizmalarla (fillSplitRegistrationIfPresent,
// alan doldurulmasa da Devam denemesi) zaten karşılanıyor.
export default new FormPortalAdapter();
