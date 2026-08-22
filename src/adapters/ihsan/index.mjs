import lion from "./lion.mjs";
import bitikla from "./bitikla.mjs";
import sigortabaz from "./sigortabaz.mjs";
import sigortamobil from "./sigortamobil.mjs";
import tasalti from "./tasalti.mjs";
import sert from "./sert.mjs";
import nepratik from "./nepratik.mjs";
import iskenderun from "./iskenderun.mjs";
import sigortammilli from "./sigortammilli.mjs";
import { IhsanPortalAdapter } from "./shared.mjs";

export const ihsanAdaptersById = {
  lion,
  bitikla,
  sigortabaz,
  sigortamobil,
  tasalti,
  sert,
  nepratik,
  iskenderun,
  sigortammilli,
};

const defaultIhsanAdapter = new IhsanPortalAdapter();

export function getIhsanAdapter(portalId) {
  return ihsanAdaptersById[portalId] || defaultIhsanAdapter;
}
