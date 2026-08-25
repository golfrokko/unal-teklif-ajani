import { PolisoftPortalAdapter } from "./polisoft-flow.mjs";

// PoliçeKes'te yenileme kartı başlangıçta seçilidir; kişisel bilgi formuna
// geçmek için ilk ekrandaki "Devam" düğmesine ayrıca basılır.
export default new PolisoftPortalAdapter({ continueAfterSelection: true });
