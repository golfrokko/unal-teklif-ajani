import sigortaladim from "./sigortaladim.mjs";
import polinet from "./polinet.mjs";
import supersigortam from "./supersigortam.mjs";
import bisigorta from "./bisigorta.mjs";
import koalay from "./koalay.mjs";
import enuygun from "./enuygun.mjs";
import sigortambir from "./sigortambir.mjs";
import sigorta7 from "./sigorta7.mjs";
import sigortayeri from "./sigortayeri.mjs";
import sigortala from "./sigortala.mjs";
import dijipol from "./dijipol.mjs";
import policekes from "./policekes.mjs";
import sigortabin from "./sigortabin.mjs";
import sigortam from "./sigortam.mjs";
import hangikredi from "./hangikredi.mjs";
import enpara from "./enpara.mjs";
import hepiyi from "./hepiyi.mjs";
import quick from "./quick.mjs";
import sompo from "./sompo.mjs";
import ethica from "./ethica.mjs";
import { FormPortalAdapter } from "../form-adapter.mjs";

export const genericAdaptersById = {
  sigortaladim,
  polinet,
  supersigortam,
  bisigorta,
  koalay,
  enuygun,
  sigortambir,
  sigorta7,
  sigortayeri,
  sigortala,
  dijipol,
  policekes,
  sigortabin,
  sigortam,
  hangikredi,
  enpara,
  hepiyi,
  quick,
  sompo,
  ethica,
};

const defaultGenericAdapter = new FormPortalAdapter();

export function getGenericAdapter(portalId) {
  return genericAdaptersById[portalId] || defaultGenericAdapter;
}
