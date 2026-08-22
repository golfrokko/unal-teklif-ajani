import { getIhsanAdapter } from "./ihsan/index.mjs";
import { getGenericAdapter } from "./sites/index.mjs";

export function getAdapter(portal) {
  if (["ihsan", "ihsan-frame"].includes(portal.adapter)) return getIhsanAdapter(portal.id);
  if (portal.adapter === "generic") return getGenericAdapter(portal.id);
  throw new Error(`Bilinmeyen portal adaptörü: ${portal.adapter}`);
}
