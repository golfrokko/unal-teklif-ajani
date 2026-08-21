import { FormPortalAdapter } from "./form-adapter.mjs";
import { IhsanPortalAdapter } from "./ihsan-adapter.mjs";

const formAdapter = new FormPortalAdapter();
const ihsanAdapter = new IhsanPortalAdapter();

export function getAdapter(portal) {
  if (["ihsan", "ihsan-frame"].includes(portal.adapter)) return ihsanAdapter;
  if (portal.adapter === "generic") return formAdapter;
  throw new Error(`Bilinmeyen portal adaptörü: ${portal.adapter}`);
}
