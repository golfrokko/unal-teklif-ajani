import { FormPortalAdapter } from "../form-adapter.mjs";

// Sompo Sigorta (sompo) — şu an portals.mjs içinde devre dışı (yorum
// satırında). Yeniden etkinleştirilmeden önce siteye canlı erişimle DOM'u
// tekrar doğrulanmalı; bu dosya o zaman FormPortalAdapter'ı miras alıp
// siteye özel farkları override edecek şekilde genişletilebilir.
export default new FormPortalAdapter();
