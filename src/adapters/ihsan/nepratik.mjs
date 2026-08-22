import { IhsanPortalAdapter } from "./shared.mjs";

// Ne Pratik Sigorta (nepratik) — İhsan altyapısı ortak akışını kullanır.
// Bu dosya, siteye özel bir davranış farkı tespit edildiğinde (örn. farklı
// buton metni, ekstra bir adım) IhsanPortalAdapter'ı miras alıp yalnız o
// kısmı override edecek şekilde genişletilebilir; şu an ortak mantığın
// aynısını kullanıyor.
export default new IhsanPortalAdapter();
