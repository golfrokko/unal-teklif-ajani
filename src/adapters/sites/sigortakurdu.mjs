import { FormPortalAdapter } from "../form-adapter.mjs";

// sigortakurdu (sigortakurdu) — genel karşılaştırma sitesi akışını kullanır.
// Siteye özel bir DOM/akış farkı canlı ortamda doğrulandığında, bu dosya
// FormPortalAdapter'ı miras alıp yalnız farklı olan kısmı (ör. giriş adımı,
// alan eşlemesi) override edecek şekilde genişletilebilir; şu an ortak
// mantığın aynısını kullanıyor.
export default new FormPortalAdapter();
