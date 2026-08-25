import { PolisoftPortalAdapter } from "./polisoft-flow.mjs";

// Sigorta.la'da yenileme kartına tıklanınca kişisel bilgi formu doğrudan
// açılır; başlangıçta ayrıca "Devam" düğmesi yoktur.
export default new PolisoftPortalAdapter({ continueAfterSelection: false });
