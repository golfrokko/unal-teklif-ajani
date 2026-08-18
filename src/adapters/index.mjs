import { FormPortalAdapter } from "./form-adapter.mjs";

const formAdapter = new FormPortalAdapter();

export function getAdapter(portal) {
  if (["generic", "ihsan", "ihsan-frame"].includes(portal.adapter)) return formAdapter;
  throw new Error(`Bilinmeyen portal adaptörü: ${portal.adapter}`);
}
