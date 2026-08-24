import { extractOffersFromText, mergeOffers } from "../lib/results.mjs";
import { isCorporateJob, RESEND_SENTINEL } from "../lib/validation.mjs";

function escapeRegex(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

// ÖNEMLİ: JS regex'in /i (case-insensitive) bayrağı Türkçe İ/ı/i/I harflerini
// birbirine KATLAMAZ (standart Unicode büyük/küçük harf dönüşümü Türkçe'ye
// özgü değildir). Yani örn. pattern'de "AYDINLATMA" (düz I ile) yazıp sayfa
// metninde gerçek Türkçe "Aydınlatma" (noktasız ı ile) aranırsa /i bayrağıyla
// bile EŞLEŞMEZ; aynı şekilde "İSTEK" (noktalı İ) düz "istek" ile eşleşmez.
// Bu yüzden Türkçe metin desenleri iki kural izlemeli: (1) metni ÖNCE
// toLocaleUpperCase("tr-TR") ile Türkçe kurallarına göre büyült (ı->I,
// i->İ), (2) pattern'i BÜYÜK HARF ve /i bayrağı OLMADAN, bu dönüşümle
// tutarlı yaz. trTest() bunu tek adımda yapar.
export function trUpper(text) {
  return String(text ?? "").toLocaleUpperCase("tr-TR");
}

export function trTest(pattern, text) {
  return pattern.test(trUpper(text));
}

// Playwright locator'ları (getByText/getByRole name) doğrudan regex bekler;
// bu durumlarda metni önceden büyültemediğimiz için pattern'in KENDİSİ her
// i/I/ı/İ konumunda dört varyantı da kabul etmeli. turkishFoldPattern(word)
// bunu elle harf harf denemek yerine otomatik/güvenli şekilde üretir.
export function turkishFoldPattern(phrase) {
  return phrase.split("").map((character) => (
    "iİıI".includes(character) ? "[iİıI]" : escapeRegex(character)
  )).join("");
}

export function turkishFoldRegex(phrase, flags = "i") {
  return new RegExp(turkishFoldPattern(phrase), flags);
}

// DİKKAT: kısa düğme adları alt dize olarak eşleşince yanlış öğeye tıklanıyor.
// Gerçek örnek: "İleri" deseni "Araç ve Ruhsat Bilgileri" başlığındaki
// "Bilg-ileri" ile eşleşip başlığa tıklıyor ve akış yanlış ilerliyordu.
// Bu tür adlar için baştan sona tam eşleşme kullanılmalı.
export function turkishFoldExact(phrase, flags = "i") {
  return new RegExp(`^\\s*${turkishFoldPattern(phrase)}\\s*$`, flags);
}

function valuesEffectivelyMatch(actual, expected) {
  const a = String(actual || "");
  const e = String(expected || "");
  if (a.replace(/\s+/g, "") === e.replace(/\s+/g, "")) return true;
  // Maskeli alanlar (telefon, TC vb.) ayraç/parantez ekleyebilir; rakamları
  // sırayla karşılaştırmak biçimlendirmeden bağımsız doğru sonucu verir.
  const digitsA = a.replace(/\D/g, "");
  const digitsE = e.replace(/\D/g, "");
  return digitsE.length > 0 && digitsA === digitsE;
}

async function typeIntoInput(input, value, delay) {
  // Not: burada bilerek clickCount:3 (üçlü tıklama) KULLANILMIYOR. Eğer
  // hedef locator gerçek bir metin girişine değil de (yanlış eşleşme
  // sonucu) bir label/wrapper elementine denk gelirse, üçlü tıklama
  // tarayıcının doğal paragraf/kelime seçme davranışını tetikleyip sayfadaki
  // ilgisiz metinleri mavi vurgulu şekilde seçebiliyor. Tek tıkla odaklanıp
  // seçimi klavyeden (Control+A) yapmak aynı sonucu güvenli şekilde verir.
  await input.click({ timeout: 3000 }).catch(() => {});
  await input.press("Control+A").catch(() => {});
  await input.press("Backspace").catch(() => {});
  await input.fill("", { timeout: 2000 }).catch(() => {});
  await input.pressSequentially(String(value), { timeout: 8000, delay }).catch(() => {});
}

export async function fillHumanLike(input, value) {
  await typeIntoInput(input, value, 28);
  let actual = await input.inputValue({ timeout: 1000 }).catch(() => "");
  if (!valuesEffectivelyMatch(actual, value)) {
    // Bazı maskeleme kütüphaneleri hızlı yazımı yakalayamıyor; daha yavaş
    // ikinci bir deneme yapılır.
    await typeIntoInput(input, value, 60);
    actual = await input.inputValue({ timeout: 1000 }).catch(() => "");
  }
  if (!valuesEffectivelyMatch(actual, value)) {
    await input.fill(String(value), { timeout: 3000 }).catch(() => {});
  }
}

// Bir etiket metni ("TC Kimlik No" gibi) hem bir RADYO/onay kutusunu hem de
// asıl metin kutusunu tanımlıyor olabilir (ör. "TC Kimlik No / Vergi Kimlik
// No" seçimi + altındaki numara alanı). Metin yazmak istediğimiz yerde
// yanlışlıkla radyoya denk gelirsek fillHumanLike onu TIKLAR ve formun
// kimlik tipi seçimini bozar (kurumsal sorgu bireysele düşer). Bu yüzden
// metin girilebilir olmayan kontroller atlanır.
async function controlKind(locator) {
  return locator.evaluate((element) => {
    const tag = element.tagName?.toLowerCase();
    if (tag === "select") return "select";
    if (tag === "textarea") return "text";
    if (tag !== "input") return "other";
    const type = (element.getAttribute("type") || "text").toLowerCase();
    return ["radio", "checkbox", "button", "submit", "reset", "image", "file", "range", "color"].includes(type) ? "other" : "text";
  }).catch(() => "other");
}

// Açılır listelerde metin yazmak yerine seçenek seçilir; etiket birebir
// tutmayabileceğinden (ör. "Diğer" / "DİĞER" / "Diger") Türkçe büyük harfe
// normalize edilip önce tam, sonra kısmi eşleşme aranır.
async function selectClosestOption(locator, value) {
  const options = await locator.locator("option").evaluateAll((nodes) => nodes.map((node) => ({
    value: node.value,
    label: (node.textContent || "").trim(),
    disabled: node.disabled,
  }))).catch(() => []);
  const wanted = trUpper(value).trim();
  const usable = options.filter((option) => !option.disabled && String(option.value || "").trim());
  const exact = usable.find((option) => trUpper(option.label).trim() === wanted);
  const partial = usable.find((option) => trUpper(option.label).includes(wanted));
  const chosen = exact || partial;
  if (!chosen) return false;
  return locator.selectOption(chosen.value, { timeout: 4000 }).then(() => true).catch(() => false);
}

async function fillIfTextField(locator, value) {
  if (!await locator.isVisible({ timeout: 400 }).catch(() => false)) return false;
  const kind = await controlKind(locator);
  if (kind === "select") return selectClosestOption(locator, value);
  if (kind !== "text") return false;
  await fillHumanLike(locator, value);
  return true;
}

export async function fillFirst(target, value, selectors, labelTerms) {
  if (!value) return false;
  for (const selector of selectors) {
    try {
      if (await fillIfTextField(target.locator(selector).first(), value)) return true;
    } catch {}
  }
  for (const term of labelTerms) {
    try {
      if (await fillIfTextField(target.getByLabel(new RegExp(escapeRegex(term), "i")).first(), value)) return true;
    } catch {}
  }
  for (const term of labelTerms) {
    try {
      const label = target.locator("label").filter({ hasText: new RegExp(escapeRegex(term), "i") }).first();
      if (!(await label.isVisible({ timeout: 400 }))) continue;
      const inside = label.locator("input").first();
      if (await inside.count() && await fillIfTextField(inside, value)) return true;
      const forId = await label.getAttribute("for");
      if (forId) {
        const linked = target.locator(`[id="${forId.replace(/(["\\])/g, "\\$1")}"]`).first();
        if (await fillIfTextField(linked, value)) return true;
      }
    } catch {}
  }
  return false;
}

// Bazı sitelerde canlı formun alanları isim/etiket olarak eşleşecek net bir
// name/id/placeholder taşımıyor; kullanıcı bu durumda "ilk alan TC, ikinci
// alan telefon" gibi sadece DOM SIRASINA göre tarif ediyor (ör. Polinet,
// Dijipol, Bisigorta). Bu yardımcı, görünür metin girişlerini sırasıyla
// dolduruyor; her değeri bir sonraki görünür (ve henüz boş) alana yazar.
export async function fillVisibleInputsByOrder(target, values) {
  const inputs = target.locator('input:not([type="hidden"]):not([type="checkbox"]):not([type="radio"]):not([type="submit"]):not([type="button"])');
  const count = Math.min(await inputs.count().catch(() => 0), values.length + 10);
  const filled = new Array(values.length).fill(false);
  let valueIndex = 0;
  for (let index = 0; index < count && valueIndex < values.length; index += 1) {
    const input = inputs.nth(index);
    if (!await input.isVisible({ timeout: 300 }).catch(() => false)) continue;
    const existing = await input.inputValue({ timeout: 300 }).catch(() => "");
    if (existing) continue;
    if (!values[valueIndex]) { valueIndex += 1; continue; }
    await fillHumanLike(input, values[valueIndex]);
    filled[valueIndex] = true;
    valueIndex += 1;
  }
  return filled;
}

export function splitFullName(fullName) {
  const parts = String(fullName || "").trim().split(/\s+/).filter(Boolean);
  if (!parts.length) return { first: "", last: "" };
  if (parts.length === 1) return { first: parts[0], last: "" };
  return { first: parts.slice(0, -1).join(" "), last: parts.at(-1) };
}

export async function fillNameAndEmail(target, job) {
  const fullName = job.vehicle?.fullName || "";
  const { first, last } = splitFullName(fullName);
  const filledFullName = await fillFirst(target, fullName,
    ['input[name*="fullname" i]', 'input[name*="ad_soyad" i]', 'input[name*="adsoyad" i]', 'input[name*="namesurname" i]', 'input[placeholder*="ad soyad" i]', 'input[placeholder*="adınız soyadınız" i]'],
    ["Ad Soyad", "Ad ve Soyad", "Adı Soyadı", "Adınız Soyadınız", "Sigortalı Adı Soyadı"]);
  let filledFirst = false;
  let filledLast = false;
  if (!filledFullName && first && last) {
    filledFirst = await fillFirst(target, first,
      ['input[name*="firstname" i]', 'input[name="ad" i]', 'input[id="ad" i]', 'input[placeholder="Adınız" i]', 'input[placeholder="Adı" i]'],
      ["Adınız", "İsminiz"]);
    filledLast = await fillFirst(target, last,
      ['input[name*="lastname" i]', 'input[name*="soyad" i]', 'input[id*="soyad" i]', 'input[placeholder*="soyadınız" i]'],
      ["Soyadınız", "Soyadı"]);
    // Bazı sitelerde alan etiketi yalnızca çıplak "Ad" / "Soyad" (ör.
    // Enuygun). "Ad" gibi kısa bir etiketi substring eşleştirmesiyle aramak
    // "Adres" gibi alakasız alanları da yakalayabileceğinden, burada
    // yalnızca TAM eşleşen etiketle (getByLabel exact) deniyoruz.
    if (!filledFirst) {
      const adField = target.getByLabel(/^Ad[ıi]?$/i, { exact: true }).first();
      if (await adField.isVisible({ timeout: 300 }).catch(() => false)) {
        await fillHumanLike(adField, first);
        filledFirst = true;
      }
    }
    if (!filledLast) {
      const soyadField = target.getByLabel(/^Soyad[ıi]?$/i, { exact: true }).first();
      if (await soyadField.isVisible({ timeout: 300 }).catch(() => false)) {
        await fillHumanLike(soyadField, last);
        filledLast = true;
      }
    }
  }
  const filledEmail = await fillFirst(target, job.email,
    ['input[type="email"]', 'input[name*="email" i]', 'input[name*="eposta" i]', 'input[name*="e_posta" i]', 'input[placeholder*="e-posta" i]', 'input[placeholder*="eposta" i]'],
    ["E-posta", "E-Posta Adresi", "Eposta", "Email"]);
  return { fullName: filledFullName || (filledFirst && filledLast), email: filledEmail };
}

function convertDateFormat(ddmmyyyy, targetFormat) {
  const match = String(ddmmyyyy || "").match(/^(\d{1,2})[.\/-](\d{1,2})[.\/-](\d{4})$/);
  if (!match) return ddmmyyyy;
  const [, dd, mm, yyyy] = match;
  const pad = (part) => part.padStart(2, "0");
  if (targetFormat === "mm/dd/yyyy") return `${pad(mm)}/${pad(dd)}/${yyyy}`;
  if (targetFormat === "yyyy-mm-dd") return `${yyyy}-${pad(mm)}-${pad(dd)}`;
  return `${pad(dd)}.${pad(mm)}.${yyyy}`;
}

// Bazı sitelerde "Plakam Var / Plakam Yok" sekmesi veya "Plakam yok"
// anahtarı bulunuyor; biz her zaman gerçek plaka bilgisiyle sorgu yaptığımız
// için "plakam yok" modunun açık kalması formu yanlış akışa sokuyor.
export async function ensurePlateAvailable(target) {
  const plakamVarButton = target.getByRole("button", { name: /^Plakam Var$/i }).first();
  if (await plakamVarButton.isVisible({ timeout: 400 }).catch(() => false)) {
    const alreadySelected = await plakamVarButton.evaluate((element) => (
      element.classList.contains("active") || element.getAttribute("aria-selected") === "true" || element.getAttribute("aria-pressed") === "true"
    )).catch(() => false);
    if (!alreadySelected) await plakamVarButton.click({ timeout: 3000 }).catch(() => {});
    return true;
  }
  // "Plakam yok" her sitede <label> içinde değil; Sigortayeri'nde metin bir
  // satırda, anahtar (switch) onun yanında ayrı bir öğe. Bu yüzden metni
  // içeren HERHANGİ bir kapsayıcı taranıp içindeki/komşusundaki anahtar
  // bulunuyor. Anahtar açıksa kapatılır — açık kalırsa site plakayı hiç
  // sormayıp sorguyu yanlış akışa sokuyor.
  const noPlateRow = target.locator(
    'label, [role="switch"], .form-check, .switch, .toggle, li, tr, div'
  ).filter({ hasText: turkishFoldRegex("Plakam yok") }).last();
  if (!await noPlateRow.isVisible({ timeout: 400 }).catch(() => false)) return false;

  const toggle = noPlateRow.locator('input[type="checkbox"], input[type="radio"], [role="switch"]').first();
  if (await toggle.count().catch(() => 0)) {
    const isOn = await toggle.isChecked({ timeout: 400 }).catch(() => null)
      ?? (await toggle.getAttribute("aria-checked").catch(() => null)) === "true";
    if (isOn) {
      await toggle.click({ force: true, timeout: 3000 })
        .catch(async () => { await noPlateRow.click({ force: true, timeout: 3000 }).catch(() => {}); });
    }
    return true;
  }
  const rowIsSwitch = await noPlateRow.getAttribute("aria-checked").catch(() => null);
  if (rowIsSwitch === "true") await noPlateRow.click({ force: true, timeout: 3000 }).catch(() => {});
  return true;
}

export async function fillBirthDate(target, birthDate) {
  if (!birthDate) return false;
  const selectors = [
    'input[placeholder="GG.AA.YYYY" i]', 'input[placeholder="DD.MM.YYYY" i]', 'input[placeholder="MM/DD/YYYY" i]',
    'input[placeholder="DD/MM/YYYY" i]', 'input[type="date"]', 'input[name*="birth" i]', 'input[name*="dogum" i]',
    'input[id*="birth" i]', 'input[id*="dogum" i]',
  ];
  for (const selector of selectors) {
    try {
      const input = target.locator(selector).first();
      if (!(await input.isVisible({ timeout: 400 }))) continue;
      const meta = await input.evaluate((element) => ({
        placeholder: element.getAttribute("placeholder") || "",
        type: element.getAttribute("type") || "",
      })).catch(() => ({}));
      let value = birthDate;
      if (meta.type === "date") value = convertDateFormat(birthDate, "yyyy-mm-dd");
      else if (/^mm/i.test(meta.placeholder)) value = convertDateFormat(birthDate, "mm/dd/yyyy");
      await fillHumanLike(input, value);
      return true;
    } catch {}
  }
  return fillFirst(target, birthDate, [], ["Doğum Tarihi"]);
}

export async function fillRegistrationDate(target, registrationDate) {
  if (!registrationDate) return false;
  const selectors = [
    'input[name*="tescil" i][type="date"]', 'input[id*="tescil" i][type="date"]',
    'input[name*="tescil" i]', 'input[id*="tescil" i]', 'input[placeholder*="tescil" i]',
  ];
  for (const selector of selectors) {
    try {
      const input = target.locator(selector).first();
      if (!(await input.isVisible({ timeout: 400 }))) continue;
      const meta = await input.evaluate((element) => ({
        placeholder: element.getAttribute("placeholder") || "",
        type: element.getAttribute("type") || "",
      })).catch(() => ({}));
      let value = registrationDate;
      if (meta.type === "date") value = convertDateFormat(registrationDate, "yyyy-mm-dd");
      else if (/^mm/i.test(meta.placeholder)) value = convertDateFormat(registrationDate, "mm/dd/yyyy");
      await fillHumanLike(input, value);
      return true;
    } catch {}
  }
  return fillFirst(target, registrationDate, [], ["Tescil Tarihi", "Ruhsat Tescil Tarihi"]);
}

function splitRegistrationParts(registration) {
  const match = String(registration || "").match(/^([A-ZÇĞİÖŞÜ]+)(\d+)$/);
  if (!match) return { seri: registration, no: registration };
  return { seri: match[1], no: match[2] };
}

async function locateVisibleField(target, selectors, labelTerms) {
  for (const selector of selectors) {
    const input = target.locator(selector).first();
    if (await input.isVisible({ timeout: 300 }).catch(() => false)) return input;
  }
  for (const term of labelTerms) {
    try {
      const input = target.getByLabel(new RegExp(escapeRegex(term), "i")).first();
      if (await input.isVisible({ timeout: 300 })) return input;
    } catch {}
  }
  return null;
}

// Bazı sitelerde ruhsat/belge bilgisi "Belge Seri" (harf) ve "Belge No"
// (rakam) olarak İKİ AYRI alana bölünmüş oluyor (örn. SigortaBin). Bu
// durumda tek bir alana tüm değeri ("GT377874") yazmak yanlış olur; ikisi
// ayrı ayrı doldurulmalı. Yalnızca gerçekten iki ayrı alan görülüyorsa
// devreye girer, aksi halde tek-alan mantığına bırakılır.
// Seri alanı bulunduğu halde "no" alanı etiketten tanınamazsa, DOM sırasında
// serinin hemen ardından gelen boş metin kutusu kullanılır. Bu olmadan
// (kullanıcı gözlemi: Koalay, Bisigorta) tüm ruhsat değeri tek alana yazılıp
// alanın maxlength'i tarafından kırpılıyor ("FV343973" -> "FV") ve belge no
// hiç doldurulmadan kalıyordu.
async function nextVisibleTextInputAfter(target, referenceField) {
  const inputs = target.locator('input:not([type="hidden"]):not([type="checkbox"]):not([type="radio"]):not([type="submit"]):not([type="button"])');
  const count = Math.min(await inputs.count().catch(() => 0), 60);
  const reference = await referenceField.elementHandle().catch(() => null);
  if (!reference) return null;
  let seenReference = false;
  for (let index = 0; index < count; index += 1) {
    const candidate = inputs.nth(index);
    const handle = await candidate.elementHandle().catch(() => null);
    if (!handle) continue;
    if (!seenReference) {
      seenReference = await reference.evaluate((node, other) => node === other, handle).catch(() => false);
      continue;
    }
    if (!await candidate.isVisible({ timeout: 250 }).catch(() => false)) continue;
    if (await candidate.inputValue({ timeout: 250 }).catch(() => "")) continue;
    return candidate;
  }
  return null;
}

export async function fillSplitRegistrationIfPresent(target, registration) {
  const { seri, no } = splitRegistrationParts(registration);
  if (seri === registration || no === registration || !seri || !no) return false;
  const seriField = await locateVisibleField(target,
    ['input[name*="belgeseri" i]', 'input[name*="ruhsatseri" i]', 'input[placeholder*="belge seri" i]', 'input[placeholder*="ruhsat seri" i]'],
    ["Belge Seri", "Ruhsat Belge Seri", "Ruhsat Seri", "Belge Seri No", "Seri No"]);
  if (!seriField) return false;
  const noField = await locateVisibleField(target,
    ['input[name*="belgeno" i]', 'input[name*="belge_no" i]', 'input[name*="ruhsatno" i]', 'input[placeholder*="belge no" i]'],
    ["Belge No", "Ruhsat Belge No", "Belge Numarası", "Tescil No", "Ruhsat No"])
    || await nextVisibleTextInputAfter(target, seriField);
  if (!noField) return false;
  await fillHumanLike(seriField, seri);
  await fillHumanLike(noField, no);
  return true;
}

export async function fillMatbuVehicleFields(target, vehicle) {
  const filled = {};
  const vehicleText = String(vehicle.vehicle || "").trim();
  const words = vehicleText.split(/\s+/).filter(Boolean);
  const brand = words[0] || "";
  const model = words.slice(1).join(" ") || vehicleText;
  filled.brand = await fillFirst(target, brand,
    ['select[name*="brand" i]', 'select[name*="marka" i]', 'input[name*="brand" i]', 'input[name*="marka" i]'],
    ["Araç Markası", "Marka"]);
  filled.model = await fillFirst(target, model,
    ['select[name*="model" i]:not([name*="yil" i])', 'input[name*="model" i]:not([name*="yil" i])'],
    ["Araç Modeli", "Model"]);
  filled.year = await fillFirst(target, vehicle.year,
    ['select[name*="year" i]', 'select[name*="modelyil" i]', 'select[name*="model_yil" i]', 'input[name*="year" i]', 'input[name*="modelyil" i]'],
    ["Model Yılı", "Araç Model Yılı"]);
  return filled;
}

export async function fillSecondaryRegistrationFields(target, registration) {
  const { no } = splitRegistrationParts(registration);
  return fillFirst(target, no,
    ['input[name*="belgeno" i]', 'input[name*="belge_no" i]', 'input[id*="belgeno" i]', 'input[placeholder*="belge no" i]'],
    ["Ruhsat Belge No", "Belge No", "Tescil No", "Tescil Belge No"]);
}

const CONSENT_TEXT_PATTERN = /(KVKK|AYDINLATMA|KULLANICI SÖZLEŞMESİ|ÜYELİK SÖZLEŞMESİ|GİZLİLİK SÖZLEŞMESİ|KİŞİSEL VERİ|AÇIK RIZA|ELEKTRONİK İLETİ|ONAY VERİYORUM|KABUL EDİYORUM|ŞARTLARI KABUL)/;

export async function acceptRequiredConsents(target, { checkAllBoxes = false } = {}) {
  const labels = target.locator("label");
  const labelCount = Math.min(await labels.count().catch(() => 0), 140);
  for (let index = 0; index < labelCount; index += 1) {
    const label = labels.nth(index);
    const text = (await label.innerText({ timeout: 300 }).catch(() => "")).toLocaleUpperCase("tr-TR");
    if (!CONSENT_TEXT_PATTERN.test(text)) continue;
    const input = label.locator('input[type="checkbox"]').first();
    if (await input.count()) {
      if (!await input.isChecked({ timeout: 300 }).catch(() => false)) {
        await input.check({ force: true }).catch(() => {});
        if (!await input.isChecked({ timeout: 300 }).catch(() => false)) await label.click({ force: true }).catch(() => {});
      }
      continue;
    }
    const forId = await label.getAttribute("for");
    if (forId) {
      const linked = target.locator(`[id="${forId.replace(/(["\\])/g, "\\$1")}"]`).first();
      if (await linked.count() && !await linked.isChecked({ timeout: 300 }).catch(() => false)) {
        await linked.check({ force: true }).catch(() => {});
      }
    }
  }
  const boxes = target.locator('input[type="checkbox"]');
  const boxCount = Math.min(await boxes.count().catch(() => 0), 60);
  for (let index = 0; index < boxCount; index += 1) {
    const box = boxes.nth(index);
    if (!await box.isVisible({ timeout: 200 }).catch(() => false)) continue;
    if (await box.isChecked({ timeout: 200 }).catch(() => false)) continue;
    if (checkAllBoxes) { await box.check({ force: true }).catch(() => {}); continue; }
    const nearbyText = await box.evaluate((element) => (element.closest("label, .form-check, .checkbox, li, div")?.innerText || "")
      .toLocaleUpperCase("tr-TR")).catch(() => "");
    if (CONSENT_TEXT_PATTERN.test(nearbyText)) await box.check({ force: true }).catch(() => {});
  }
}

export async function humanPause(minMs = 180, maxMs = 420) {
  const ms = minMs + Math.floor(Math.random() * (maxMs - minMs));
  await new Promise((resolve) => setTimeout(resolve, ms));
}

export async function resolveTarget(page, portal) {
  if (portal.adapter !== "ihsan-frame") return page;
  await page.waitForTimeout(1200);
  return page.frames().find((frame) => frame !== page.mainFrame() && /sigorta\.online/i.test(frame.url())) || page;
}

const PHONE_SELECTORS = [
  'input[name*="phone" i]', 'input[name*="telefon" i]', 'input[name*="gsm" i]', 'input[name*="cep" i]',
  'input[id*="phone" i]', 'input[id*="telefon" i]', 'input[id*="gsm" i]', 'input[id*="cep" i]',
  'input[placeholder*="telefon" i]', 'input[placeholder*="gsm" i]', 'input[placeholder*="cep" i]', 'input[placeholder*="5__" i]',
  'input[type="tel"]:not([name*="kimlik" i]):not([id*="kimlik" i]):not([name*="identity" i]):not([id*="identity" i]):not([name*="tc" i]):not([id*="tc" i])',
];
const PHONE_LABELS = ["GSM", "Cep Telefonu", "Telefon"];

// Alanların hangi sırayla doldurulacağı çoğu sitede önemsiz, ama bazı
// siteler alanı sırayla açığa çıkarıyor/doğruluyor ve yanlış sırada
// doldurulunca form takılabiliyor (ör. Sigortambir: TC, plaka, telefon;
// Sigortayeri: plaka, TC). portal.fieldOrder bu adımların BİR KISMINI
// (veya tamamını) öne alabilir; listelenmeyen adımlar varsayılan
// sıralarında sona eklenir, hiçbir alan atlanmaz.
const DEFAULT_FIELD_ORDER = ["corporateMode", "identity", "authorizedIdentity", "birthDate", "plate", "registration", "phone", "chassis", "engine", "matbuVehicle", "registrationDate", "usageType", "city", "district", "occupation", "title", "seatCount", "fuelType", "hasarsizlik", "nameEmail"];

// Tüzel kişi sorgularında portallar "Bireysel/Kurumsal" sekmesi ya da
// "TC Kimlik No / Vergi Kimlik No" seçimi istiyor. Yanlış (varsayılan
// bireysel) seçimle devam etmek sorguyu baştan geçersiz kılıyordu.
const CORPORATE_TAB_NAMES = ["Kurumsal", "Tüzel Kişi", "Şirket"].map((phrase) => new RegExp(`^${turkishFoldPattern(phrase)}`, "i"));
const CORPORATE_RADIO_LABELS = ["Vergi Kimlik No", "Vergi No", "VKN", "Kurumsal", "Tüzel"];

export async function selectCorporateMode(target) {
  let applied = false;
  // 1) "Kurumsal" sekmesi/düğmesi (ör. Sigorta7).
  if (await clickNamedButton(target, CORPORATE_TAB_NAMES, { maxTextLength: 24 })) applied = true;
  // 2) "Vergi Kimlik No" radyo düğmesi (ör. Bitikla, Sigortayeri).
  for (const label of CORPORATE_RADIO_LABELS) {
    const radio = target.getByLabel(turkishFoldRegex(label)).first();
    if (!await radio.isVisible({ timeout: 250 }).catch(() => false)) continue;
    const type = await radio.evaluate((element) => element.getAttribute("type")).catch(() => null);
    if (type !== "radio" && type !== "checkbox") continue;
    if (await radio.isChecked({ timeout: 250 }).catch(() => false)) return true;
    await radio.check({ force: true, timeout: 3000 }).catch(() => {});
    applied = true;
    break;
  }
  return applied;
}

export async function fillQuoteForm(target, job, portal) {
  const vehicle = job.vehicle;
  const phone10 = job.phone.replace(/^0/, "");
  const filled = {};

  const steps = {
    // Kimlik alanından ÖNCE çalışır: kurumsal seçim çoğu sitede formu
    // yeniden çizdiğinden (TC alanı -> Vergi No alanı) sonra doldurulmalı.
    corporateMode: async () => {
      if (!isCorporateJob(vehicle)) return;
      filled.corporateMode = await selectCorporateMode(target);
      if (filled.corporateMode) await humanPause();
    },
    identity: async () => {
      filled.identity = await fillFirst(target, vehicle.identity,
        ['input[name*="identity" i]', 'input[name*="kimlik" i]', 'input[name*="tc" i]', 'input[placeholder*="TC" i]', 'input[placeholder*="kimlik" i]'],
        ["Kimlik Numarası", "TC Kimlik No", "TC/Vergi", "T.C. Kimlik", "TC Kimlik Numarası", "Vergi Kimlik No"]);
    },
    authorizedIdentity: async () => {
      if (!isCorporateJob(vehicle) || !vehicle.authorizedIdentity) return;
      filled.authorizedIdentity = await fillFirst(target, vehicle.authorizedIdentity,
        ['input[name*="yetkili" i]', 'input[id*="yetkili" i]', 'input[name*="authorized" i]', 'input[id*="authorized" i]'],
        ["Yetkili TC", "Şirket Yetkilisi TC", "Yetkili Kimlik", "Doğum Tarihi"]);
    },
    birthDate: async () => {
      if (isCorporateJob(vehicle) && vehicle.authorizedIdentity) return;
      filled.birthDate = await fillBirthDate(target, vehicle.birthDate);
    },
    plate: async () => {
      await ensurePlateAvailable(target);
      filled.plate = await fillFirst(target, vehicle.plate,
        ['input[name*="plate" i]', 'input[name*="plaka" i]', 'input[placeholder*="plaka" i]'], ["Plaka"]);
    },
    registration: async () => {
      if (Array.isArray(portal?.registrationInputOrder)) {
        const parts = String(vehicle.registration || "").match(/^([A-ZÇĞİÖŞÜ]+)(\d+)$/i);
        const inputs = target.locator('input:not([type="hidden"]):not([type="checkbox"]):not([type="radio"]):not([type="submit"]):not([type="button"])');
        if (parts) {
          const [serialIndex, numberIndex] = portal.registrationInputOrder;
          const serialInput = inputs.nth(serialIndex);
          const numberInput = inputs.nth(numberIndex);
          if (await serialInput.isVisible({ timeout: 300 }).catch(() => false) && await numberInput.isVisible({ timeout: 300 }).catch(() => false)) {
            await fillHumanLike(serialInput, parts[1]);
            await fillHumanLike(numberInput, parts[2]);
            filled.registration = true;
            return;
          }
        }
      }
      filled.registration = (await fillSplitRegistrationIfPresent(target, vehicle.registration)) || (await fillFirst(target, vehicle.registration,
        ['input[name*="registration" i]', 'input[name*="ruhsat" i]', 'input[name*="belge" i]', 'input[name*="tescil" i]', 'input[placeholder*="ruhsat" i]'],
        ["Ruhsat Numarası", "Ruhsat Seri", "Belge Seri", "Ruhsat Tescil Belge Seri No", "Tescil Belge Seri No", "Ruhsat Seri No"]));
      await fillSecondaryRegistrationFields(target, vehicle.registration);
    },
    phone: async () => {
      filled.phone = (await fillFirst(target, phone10, PHONE_SELECTORS, PHONE_LABELS)) || (await fillFirst(target, job.phone, PHONE_SELECTORS, PHONE_LABELS));
    },
    chassis: async () => {
      filled.chassis = await fillFirst(target, vehicle.chassis,
        ['input[name*="chassis" i]', 'input[name*="sasi" i]'], ["Şasi Numarası", "Şasi No"]);
    },
    engine: async () => {
      filled.engine = await fillFirst(target, vehicle.engine,
        ['input[name*="engine" i]', 'input[name*="motor" i]'], ["Motor Numarası", "Motor No"]);
    },
    matbuVehicle: async () => { await fillMatbuVehicleFields(target, vehicle); },
    registrationDate: async () => { filled.registrationDate = await fillRegistrationDate(target, vehicle.registrationDate); },
    city: async () => {
      if (!portal?.defaultCity) return;
      filled.city = await fillFirst(target, portal.defaultCity,
        ['select[name*="city" i]', 'select[name="il" i]', 'select[id="il" i]', 'input[name*="city" i]'], ["İl", "Şehir"]);
      if (filled.city) await target.waitForTimeout(700).catch(() => {});
    },
    district: async () => {
      if (!portal?.defaultDistrict) return;
      filled.district = await fillFirst(target, portal.defaultDistrict,
        ['select[name*="district" i]', 'select[name="ilce" i]', 'select[name="ilçe" i]', 'select[id="ilce" i]', 'input[name*="district" i]'], ["İlçe"]);
    },
    // Bazı sitelerde sigortalı bilgileri ekranında "Meslek" gibi elimizde
    // hiç verisi olmayan bir çoktan seçmeli soruluyor (ör. Dijipol). Elimizde
    // gerçek bir meslek bilgisi olmadığından güvenli/genel "Diğer"
    // seçeneğini deniyoruz; alan yoksa no-op.
    // Meslek elimizde olmayan bir bilgi; açılır listede de serbest metin
    // alanında da güvenli/genel "Diğer" kullanılır (ör. Sigortaladım).
    occupation: async () => {
      filled.occupation = await fillFirst(target, portal?.defaultOccupation || "Diğer",
        ['select[name*="meslek" i]', 'select[name*="occupation" i]', 'input[name*="meslek" i]', 'input[name*="occupation" i]'],
        ["Meslek", "Mesleğiniz", "Meslek Bilgisi"]);
    },
    // "Ünvan" / "Şirket Ünvanı" alanı istendiğinde sigortalının tam adı
    // doğrudan yapıştırılır (tüzel kişilerde ünvanın kendisidir).
    title: async () => {
      filled.title = await fillFirst(target, vehicle.fullName,
        ['input[name*="unvan" i]', 'input[name*="title" i]', 'input[placeholder*="ünvan" i]', 'input[placeholder*="unvan" i]'],
        ["Ünvan", "Unvan", "Şirket Ünvanı", "Firma Ünvanı", "Ticaret Ünvanı"]);
    },
    usageType: async () => {
      filled.usageType = await fillFirst(target, vehicle.usageType,
        ['select[name*="kullanim" i]', 'select[name*="usage" i]', 'select[name*="kullanımtarz" i]'],
        ["Kullanım Tarzı", "Kullanım Şekli", "Araç Kullanım Tarzı"]);
    },
    hasarsizlik: async () => {
      const hasarsizlikKademesi = job.capturedFacts?.hasarsizlikKademesi?.value;
      if (!hasarsizlikKademesi) return;
      filled.hasarsizlikKademesi = await fillFirst(target, hasarsizlikKademesi,
        ['select[name*="hasarsizlik" i]', 'select[name*="kademe" i]', 'input[name*="hasarsizlik" i]', 'input[name*="kademe" i]'],
        ["Hasarsızlık Kademesi", "Hasarsızlık Basamağı"]);
    },
    // Koltuk sayısı ve yakıt tipi de matbu/vehicle verimizde yok; kullanıcı
    // gözlemine göre (ör. Bisigorta) koltuk sayısı her zaman "5", yakıt
    // tipi "Benzin" seçilerek geçiliyor. Alan yoksa no-op.
    seatCount: async () => {
      filled.seatCount = await fillFirst(target, "5",
        ['select[name*="koltuk" i]', 'select[name*="seat" i]', 'input[name*="koltuk" i]'],
        ["Koltuk Sayısı", "Koltuk Adedi"]);
    },
    fuelType: async () => {
      filled.fuelType = await fillFirst(target, "Benzin",
        ['select[name*="yakit" i]', 'select[name*="fuel" i]'],
        ["Yakıt Tipi", "Yakıt Türü"]);
    },
    nameEmail: async () => { await fillNameAndEmail(target, job); },
  };

  const customOrder = Array.isArray(portal?.fieldOrder) ? portal.fieldOrder : [];
  const order = [...customOrder, ...DEFAULT_FIELD_ORDER.filter((step) => !customOrder.includes(step))];
  for (const step of order) {
    if (!steps[step]) continue;
    await steps[step]();
    await humanPause();
  }
  await acceptRequiredConsents(target, { checkAllBoxes: portal?.checkAllBoxes === true });
  return filled;
}

async function waitUntilEnabled(locator, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await locator.isEnabled({ timeout: 300 }).catch(() => false)) return true;
    await locator.page().waitForTimeout(300);
  }
  return false;
}

// Bazı sitelerde asıl "Teklif Al" düğmesinin yanında, eksik/varsayılan
// veriyle özet bir teklif üreten "Hızlı Teklif Al" kısayolu da bulunuyor
// (ör. Koalay). İkisi de aynı /Teklif(?:i)? Al/i deseniyle eşleştiğinden,
// DOM sırasına göre yanlışlıkla kısayol tıklanabiliyor. Bu yüzden eşleşen
// düğmeler arasında "hızlı/ekspres" içermeyeni önceliklendiriyoruz; asıl
// düğme yoksa son çare olarak kısayola geri dönüyoruz.
const SHORTCUT_BUTTON_PATTERN = new RegExp(`(${turkishFoldPattern("hızlı")}|quick|express|ekspres)`, "i");

// Uzun/ayırt edici adlar alt dize olarak güvenle aranabilir; tek kelimelik
// kısa adlar ("İleri", "Devam", "Gönder", "Hesapla") sayfa metninde başka
// kelimelerin içinde geçebildiğinden TAM eşleşme ister (bkz. turkishFoldExact).
const SUBMIT_BUTTON_NAMES = [
  ...["Teklif Al", "Teklifi Al", "Hemen Teklif", "Fiyat Gör", "Fiyatları Gör", "Fiyat Getir",
    "Fiyatları Getir", "Fiyat Hesapla", "Fiyatları Hesapla", "Teklifleri Görüntüle", "Teklifleri Getir",
    "Devam Et", "Karşılaştır", "Sorgula", "Doğrula", "Onayla"].map((phrase) => turkishFoldRegex(phrase)),
  ...["Gönder", "Devam", "İleri", "Hesapla"].map((phrase) => turkishFoldExact(phrase)),
];

export async function clickSubmit(target) {
  for (const name of SUBMIT_BUTTON_NAMES) {
    try {
      const candidates = target.getByRole("button", { name });
      const count = Math.min(await candidates.count().catch(() => 0), 6);
      let shortcutFallback = null;
      for (let index = 0; index < count; index += 1) {
        const button = candidates.nth(index);
        if (!await button.isVisible({ timeout: 500 }).catch(() => false)) continue;
        const text = (await button.innerText({ timeout: 500 }).catch(() => "")).trim();
        if (SHORTCUT_BUTTON_PATTERN.test(text)) { if (!shortcutFallback) shortcutFallback = button; continue; }
        if (await button.isEnabled({ timeout: 500 }) || await waitUntilEnabled(button, 2500)) {
          await button.click({ timeout: 5000 });
          return true;
        }
      }
      if (shortcutFallback && (await shortcutFallback.isEnabled({ timeout: 500 }) || await waitUntilEnabled(shortcutFallback, 2500))) {
        await shortcutFallback.click({ timeout: 5000 });
        return true;
      }
    } catch {}
  }
  for (const selector of ['button[type="submit"]', 'input[type="submit"]']) {
    try {
      const button = target.locator(selector).first();
      if (!await button.isVisible({ timeout: 500 })) continue;
      if (await button.isEnabled({ timeout: 500 }) || await waitUntilEnabled(button, 2500)) {
        await button.click({ timeout: 5000 });
        return true;
      }
    } catch {}
  }
  // Bazı sitelerde "Devam Et" gibi düğmeler gerçek <button>/role="button"
  // değil, tıklanabilir yapılmış düz <div>/<span> etiketleri; getByRole bu
  // yüzden onları hiç bulamıyor (ekranda görünse ve scroll edilse bile).
  // Son çare olarak tam metin eşleşmesiyle herhangi bir görünür elementi dene.
  for (const name of [/^Devam Et$/i, /^Devam$/i, /^Gönder$/i, /^Onayla$/i, new RegExp(`^${turkishFoldPattern("İleri")}$`, "i")]) {
    try {
      const control = target.getByText(name, { exact: true }).first();
      if (!await control.isVisible({ timeout: 400 }).catch(() => false)) continue;
      await control.scrollIntoViewIfNeeded({ timeout: 2000 }).catch(() => {});
      await control.click({ timeout: 5000 });
      return true;
    } catch {}
  }
  return false;
}

async function isShortEnoughControl(control, maxTextLength) {
  const text = await control.innerText({ timeout: 500 }).catch(() => "");
  return text.trim().length <= maxTextLength;
}

// Bazı sitelerde "Teklif Al" gibi kısa CTA metinleri, sayfa içindeki uzun
// pazarlama/blog cümlelerinin (örn. "... Tekliflerini Gör, Karşılaştır ve
// Avantajlı Fiyatlarla Hemen Al.") içinde de geçiyor. Regex ile eşleşen ama
// metni çok uzun olan bağlantılar gerçek giriş düğmesi olamaz; bunları atlayıp
// asıl kısa CTA'yı arıyoruz.
export async function clickNamedButton(target, names, { maxTextLength = 60 } = {}) {
  for (const name of names) {
    for (const role of ["button", "link"]) {
      try {
        const controls = target.getByRole(role, { name });
        const count = Math.min(await controls.count().catch(() => 0), 8);
        for (let index = 0; index < count; index += 1) {
          const control = controls.nth(index);
          if (!await control.isVisible({ timeout: 500 }).catch(() => false)) continue;
          if (!await control.isEnabled({ timeout: 500 }).catch(() => false)) continue;
          if (!await isShortEnoughControl(control, maxTextLength)) continue;
          await control.click({ timeout: 5000 });
          return true;
        }
      } catch {}
    }
    try {
      const control = target.getByText(name, { exact: true }).first();
      if (await control.isVisible({ timeout: 500 }) && await control.isEnabled({ timeout: 500 })) {
        await control.click({ timeout: 5000 });
        return true;
      }
    } catch {}
  }
  return false;
}

export async function visibleText(target) {
  return (await target.locator("body").innerText({ timeout: 3000 }).catch(() => "")).slice(0, 300000);
}

const CAPTCHA_TEXT_PATTERN = new RegExp(
  `(VERIFY YOU ARE HUMAN|${turkishFoldPattern("İNSAN OLDUĞUNUZU DOĞRULAYIN")}|${turkishFoldPattern("ROBOT OLMADIĞINIZI")}|${turkishFoldPattern("GÜVENLİK KONTROLÜ")}|CHECKING YOUR BROWSER)`,
  "i",
);

export async function detectCaptcha(page, text) {
  if (CAPTCHA_TEXT_PATTERN.test(text)) return true;
  // Not: birçok site, kullanıcıya hiç görünmeyen (invisible reCAPTCHA v3
  // rozeti, arka planda çalışan gizli container gibi) bir CAPTCHA elementini
  // HER sayfada boilerplate olarak DOM'da tutuyor. Yalnızca eleman VAR mı
  // diye bakmak (görünürlüğe bakmadan) SMS kodu ekranı gibi alakasız
  // ekranları da yanlışlıkla CAPTCHA sanıyordu (ör. Koalay). Gerçek bir
  // CAPTCHA'nın kullanıcıya GÖRÜNÜR olması gerekir.
  const candidates = page.locator('iframe[src*="recaptcha" i], iframe[src*="hcaptcha" i], [class*="captcha" i], [id*="captcha" i]');
  const count = Math.min(await candidates.count().catch(() => 0), 10);
  for (let index = 0; index < count; index += 1) {
    if (await candidates.nth(index).isVisible({ timeout: 200 }).catch(() => false)) return true;
  }
  return false;
}

export async function solveImageCaptcha(target, requestCaptchaCode) {
  if (typeof requestCaptchaCode !== "function") return false;
  const images = target.locator('img[src*="captcha" i], img[id*="captcha" i], img[class*="captcha" i], canvas[id*="captcha" i], canvas[class*="captcha" i]');
  let image = null;
  const imageCount = Math.min(await images.count().catch(() => 0), 12);
  for (let index = 0; index < imageCount; index += 1) {
    const candidate = images.nth(index);
    if (await candidate.isVisible({ timeout: 250 }).catch(() => false)) { image = candidate; break; }
  }
  if (!image) return false;
  const inputSelectors = [
    'input[name*="captcha" i]', 'input[id*="captcha" i]', 'input[name*="security" i]', 'input[id*="security" i]',
    'input[placeholder*="güvenlik kod" i]', 'input[placeholder*="resimde" i]', 'input[placeholder*="kodu gir" i]',
  ];
  let input = null;
  for (const selector of inputSelectors) {
    const candidate = target.locator(selector).first();
    if (await candidate.isVisible({ timeout: 250 }).catch(() => false)) { input = candidate; break; }
  }
  if (!input) return false;
  const buffer = await image.screenshot({ type: "png", timeout: 4000 }).catch(() => null);
  if (!buffer) return false;
  const code = String(await requestCaptchaCode(`data:image/png;base64,${buffer.toString("base64")}`) || "").trim();
  if (!code) return false;
  await fillHumanLike(input, code);
  return true;
}

export async function scrollOfferResults(target) {
  await target.evaluate(() => {
    const scrollables = [...document.querySelectorAll("*")].filter((element) => {
      const style = getComputedStyle(element);
      return /(auto|scroll)/.test(style.overflowY) && element.scrollHeight > element.clientHeight + 80;
    });
    for (const element of scrollables) element.scrollTop = Math.min(element.scrollHeight, element.scrollTop + Math.max(500, element.clientHeight));
    window.scrollTo(0, Math.min(document.documentElement.scrollHeight, window.scrollY + Math.max(700, window.innerHeight * .8)));
  }).catch(() => {});
}

export async function findOtpInput(target) {
  for (const selector of [
    'input[autocomplete="one-time-code"]', 'input[name*="otp" i]', 'input[name*="sms" i]', 'input[id*="otp" i]',
    'input[id*="sms" i]', 'input[placeholder*="doğrulama" i]', 'input[placeholder*="kod" i]',
  ]) {
    const input = target.locator(selector).first();
    if (await input.isVisible({ timeout: 300 }).catch(() => false)) return input;
  }
  const candidates = target.locator('input[inputmode="numeric"], input[type="number"], input[maxlength]');
  const count = Math.min(await candidates.count().catch(() => 0), 30);
  const singleCharacterInputs = [];
  for (let index = 0; index < count; index += 1) {
    const input = candidates.nth(index);
    if (!await input.isVisible({ timeout: 200 }).catch(() => false)) continue;
    const meta = await input.evaluate((element) => ({
      type: (element.getAttribute("type") || "text").toLowerCase(),
      maxLength: Number(element.getAttribute("maxlength") || element.maxLength || 0),
      semantic: [element.name, element.id, element.placeholder, element.getAttribute("aria-label"), element.parentElement?.innerText]
        .filter(Boolean).join(" ").toLocaleLowerCase("tr-TR"),
    })).catch(() => null);
    if (!meta || meta.type === "tel" || /(telefon|phone|gsm|cep|kimlik|identity|\btc\b|vergi|vkn|plaka|plate|ruhsat|registration|model|year|yıl|sasi|şasi|chassis|motor)/i.test(meta.semantic)) continue;
    if (meta.maxLength >= 4 && meta.maxLength <= 8) return input;
    if (meta.maxLength === 1) singleCharacterInputs.push(input);
  }
  if (singleCharacterInputs.length >= 4 && singleCharacterInputs.length <= 8) return singleCharacterInputs[0];
  return null;
}

export async function fillOtpCode(target, code) {
  const input = await findOtpInput(target);
  if (!input) return false;
  const maxLength = await input.evaluate((element) => Number(element.getAttribute("maxlength") || element.maxLength || 0)).catch(() => 0);
  if (maxLength !== 1) {
    await input.fill(code, { timeout: 4000 });
    return true;
  }

  const candidates = target.locator('input[maxlength="1"], input[inputmode="numeric"][maxlength="1"]');
  const count = Math.min(await candidates.count().catch(() => 0), 12);
  const visible = [];
  for (let index = 0; index < count; index += 1) {
    const candidate = candidates.nth(index);
    if (await candidate.isVisible({ timeout: 200 }).catch(() => false)) visible.push(candidate);
  }
  if (visible.length < code.length) return false;
  for (let index = 0; index < code.length; index += 1) await visible[index].fill(code[index], { timeout: 2000 });
  return true;
}

export async function formSignature(target) {
  const controls = target.locator("input, select, textarea, button");
  const signature = await controls.evaluateAll((nodes) => nodes.filter((node) => {
    const style = window.getComputedStyle(node);
    return style.display !== "none" && style.visibility !== "hidden" && !node.disabled;
  }).slice(0, 100).map((node) => [
    node.tagName,
    node.getAttribute("type") || "",
    node.getAttribute("name") || "",
    node.id || "",
    node.getAttribute("placeholder") || "",
    node.tagName === "BUTTON" ? (node.textContent || "").trim().slice(0, 80) : "",
  ].join(":"))).catch(() => []);
  return JSON.stringify(signature);
}

async function quoteFormProfile(target) {
  const controls = target.locator("input, select, textarea, button");
  const items = await controls.evaluateAll((nodes) => nodes.filter((node) => {
    const style = window.getComputedStyle(node);
    return style.display !== "none" && style.visibility !== "hidden";
  }).slice(0, 120).map((node) => ({
    tag: node.tagName.toLowerCase(),
    type: node.getAttribute("type") || "",
    name: node.getAttribute("name") || "",
    id: node.id || "",
    placeholder: node.getAttribute("placeholder") || "",
    label: node.getAttribute("aria-label") || "",
    text: node.tagName === "BUTTON" ? (node.textContent || "").trim().slice(0, 100) : "",
  }))).catch(() => []);
  const haystack = items.map((item) => `${item.name} ${item.id} ${item.placeholder} ${item.label}`).join(" ");
  const buttonText = items.filter((item) => item.tag === "button" || item.type === "submit").map((item) => item.text).join(" ");
  return {
    controlCount: items.length,
    hasIdentity: /(identity|kimlik|\btc\b|vergi|vkn)/i.test(haystack),
    hasPlate: /(plate|plaka)/i.test(haystack),
    hasRegistration: /(registration|ruhsat|belge)/i.test(haystack),
    hasPhone: /(phone|telefon|gsm|cep)/i.test(haystack),
    hasSubmit: items.some((item) => item.type === "submit") || /(teklif|sorgula|devam|gönder|başla)/i.test(buttonText),
  };
}

async function openQuoteFlow(target, page) {
  let profile = await quoteFormProfile(target);
  for (let attempt = 0; attempt < 4; attempt += 1) {
    if ((profile.hasIdentity || profile.hasPlate || profile.hasRegistration) && profile.hasSubmit) return profile;
    // "Bir sigorta seç" gibi ürün seçim menülerinde önce en spesifik/kısa
    // eşleşmeyi (tam "Trafik Sigortası" satırı) dene; bu, uzun tanıtım
    // metinlerindeki "... Teklif Al" gibi genel ifadelerden önce gelmeli.
    const selectedCategory = await clickNamedButton(target, [
      new RegExp(`^${turkishFoldPattern("Zorunlu Trafik Sigortası")}$`, "i"),
      new RegExp(`^${turkishFoldPattern("Trafik Sigortası")}$`, "i"),
    ], { maxTextLength: 32 });
    const dismissed = selectedCategory || await clickNamedButton(target, [turkishFoldRegex("Şimdi Değil"), /Vazgeç/i, /Daha Sonra/i, /Atla/i, /Kapat/i]);
    const opened = dismissed || await clickNamedButton(target, [
      turkishFoldRegex("Trafik Sigortası Teklif"),
      turkishFoldRegex("Trafik Teklifi"),
      turkishFoldRegex("Teklif Al"),
      turkishFoldRegex("Hemen Teklif"),
      turkishFoldRegex("Fiyat Al"),
      /Sorgula/i,
    ]);
    if (!opened) return profile;
    await page.waitForTimeout(1000);
    profile = await quoteFormProfile(target);
  }
  return profile;
}

// Bazı sitelerde sorgu akışıyla ilgisiz, pazarlama amaçlı "Beni Ara / bize
// ulaşın" tarzı bir iletişim penceresi çıkabiliyor (ör. Dijipol). Bu pencere
// kapatılmazsa hem müşterinin telefon numarası yanlışlıkla o forma
// yazılabilir hem de sürekli değişen içeriği "yeni adım" sanılıp akış
// gereksiz yere döngüye girebilir. Görüldüğünde sessizce kapatılır.
const LEAD_CAPTURE_PATTERN = new RegExp(
  `(${turkishFoldPattern("BENİ ARA")}|${turkishFoldPattern("SİZİ ARAYALIM")}|${turkishFoldPattern("GERİ ARAMA TALEBİ")})`,
  "i",
);

export async function dismissLeadCaptureModal(target) {
  const heading = target.getByText(LEAD_CAPTURE_PATTERN).first();
  if (!await heading.isVisible({ timeout: 250 }).catch(() => false)) return false;
  const dialog = target.locator('[role="dialog"], .modal, .modal-content, .popup').filter({ has: heading }).first();
  const scope = (await dialog.count().catch(() => 0)) ? dialog : target;
  const closeCandidates = [
    scope.getByRole("button", { name: /^(kapat|close|×|x)$/i }).first(),
    scope.locator('[aria-label="Close" i], [aria-label="Kapat" i]').first(),
    scope.locator("button.close, .close-button, .modal-close, .popup-close").first(),
  ];
  for (const candidate of closeCandidates) {
    if (await candidate.isVisible({ timeout: 300 }).catch(() => false)) {
      await candidate.click({ timeout: 2000 }).catch(() => {});
      return true;
    }
  }
  await target.keyboard.press("Escape").catch(() => {});
  return true;
}

// Sorgu ilerlerken tanımadığımız bir onay penceresi çıkabiliyor (ör. Bitikla
// "Biyometrik Girişi Aktifleştirmek ister misiniz?" — Evet/Sonra/Hayır).
// Kullanıcı talebi: böyle bir pencerede "Hayır" varsa doğrudan o seçilsin.
// Güvenli varsayılan zaten "Hayır"; akış kullanıcı müdahalesi beklemeden
// devam eder.
const NO_BUTTON_PATTERN = new RegExp(`^${turkishFoldPattern("Hayır")}`, "i");

// İSTİSNA: akışın kendisinde bilerek "Evet" dediğimiz sorular (ör. Sigortambir
// "Ruhsat seri/belge numaranızı biliyor musunuz?") otomatik reddedilmemeli;
// aksi halde adaptör kendi doldurma adımını kapatmış olur.
const DELIBERATE_YES_QUESTION_PATTERN = new RegExp(
  `(${["RUHSAT", "BELGE SERİ", "BELGE NO", "SERİ NO"].map(turkishFoldPattern).join("|")})`,
  "i",
);

async function visibleDialog(target) {
  const dialogs = target.locator('[role="dialog"], .modal.show, dialog[open], .offcanvas.show, .swal2-popup');
  const count = Math.min(await dialogs.count().catch(() => 0), 20);
  for (let index = count - 1; index >= 0; index -= 1) {
    const dialog = dialogs.nth(index);
    if (await dialog.isVisible({ timeout: 250 }).catch(() => false)) return dialog;
  }
  return null;
}

export async function dismissNoPopup(target) {
  const dialog = await visibleDialog(target);
  if (!dialog) return false;
  const text = await dialog.innerText({ timeout: 500 }).catch(() => "");
  if (DELIBERATE_YES_QUESTION_PATTERN.test(text)) return false;
  const noButton = dialog.getByRole("button", { name: NO_BUTTON_PATTERN }).first();
  if (!await noButton.isVisible({ timeout: 300 }).catch(() => false)) return false;
  await noButton.click({ timeout: 3000 }).catch(() => {});
  return true;
}

// Bazı portallar (İhsan altyapısı dahil) EGM sorgusu sırasında ekranda
// "Hasarsızlık Kademesi" bilgisini gösteriyor. Bu bilgi Sigorta Kurdu gibi
// başka bir sitenin kendi formunda AYRICA soruluyor olabilir; burada
// yakalanan değer job üzerinde saklanıp, aynı sorgu içindeki diğer
// portallar kendi adımlarını doldururken (bkz. fillQuoteForm) fırsat
// bulunca kullanılıyor. Not: paralel çalışan portallar arasında sıralama
// garantisi YOK; değer henüz yakalanmamışsa sessizce atlanır, uydurma veri
// yazılmaz.
const HASARSIZLIK_PATTERN = /HASARS[İIıi]ZL[İIıi]K\s*KADEMES[İIıi]\s*[:\-]?\s*(-?\d{1,2})/i;

export function captureSharedFacts(job, text) {
  if (!job || job.capturedFacts?.hasarsizlikKademesi) return;
  const match = String(text).match(HASARSIZLIK_PATTERN);
  if (!match) return;
  job.capturedFacts = job.capturedFacts || {};
  job.capturedFacts.hasarsizlikKademesi = { value: match[1], capturedAt: new Date().toISOString() };
}

function foldAnyPattern(phrases) {
  return new RegExp(`(${phrases.map(turkishFoldPattern).join("|")})`, "i");
}

const RATE_LIMITED_PATTERN = foldAnyPattern(["ÇOK FAZLA İSTEK", "TOO MANY REQUESTS", "RATE LIMIT", "429"]);
const AUTH_LOGIN_PATTERN = foldAnyPattern(["GİRİŞ YAP", "OTURUM AÇ", "KULLANICI ADI", "ACENTE GİRİŞİ"]);
const AUTH_PASSWORD_PATTERN = foldAnyPattern(["ŞİFRE", "PASSWORD"]);
const NO_OFFER_PATTERN = foldAnyPattern(["TEKLİF BULUNAMADI", "UYGUN TEKLİF YOK", "FİYAT ALINAMADI", "SONUÇ BULUNAMADI"]);
const SMS_LANGUAGE_PATTERN = foldAnyPattern(["SMS", "TEK KULLANIMLIK", "DOĞRULAMA KODU", "ONAY KODU", "CEP TELEFONUNUZA"]);
const RESULT_PROGRESS_PATTERN = foldAnyPattern(["TEKLİF SONUÇLARI", "TEKLİFLER SORGULANIYOR", "SORGULAMA DURUMU", "FİYATLAR HAZIRLANIYOR"]);

// Kullanıcı gözlemi: portalların tüm sigorta şirketlerini listelemesi ~30
// saniye sürüyor; teklifler tek seferde değil birer birer düşüyor. Sonucu
// kapatmadan önce hem bu toplama penceresinin dolması hem de yeni teklif
// gelmeyi bırakması (durağanlık) bekleniyor.
export const OFFER_COLLECTION_WINDOW_MS = 30000;
export const OFFER_SETTLE_MS = 8000;

// Bazı karşılaştırma sitelerinde başlangıçta tek (öne çıkan/en ucuz) teklif
// gösterilip diğerleri bu tür bir düğmenin arkasında saklı kalıyor.
export const REVEAL_ALL_OFFERS_BUTTON_NAMES = [
  "Tüm Teklifleri Gör", "Diğer Teklifleri Gör", "Tüm Teklifler", "Bütün Teklifler",
  "Daha Fazla Teklif", "Tümünü Gör", "Diğer Şirketler", "Diğer Teklifler",
].map((phrase) => turkishFoldRegex(phrase));

export function pageState(text) {
  if (RATE_LIMITED_PATTERN.test(text)) return "rate_limited";
  if (AUTH_LOGIN_PATTERN.test(text) && AUTH_PASSWORD_PATTERN.test(text)) return "auth_required";
  if (NO_OFFER_PATTERN.test(text)) return "no_offer";
  return null;
}

// Bazı sitelerde bir sonraki adım (ör. "Sigortalı Bilgileri") DOM'a önceden
// yerleşmiş, yalnızca bir akordeon/adım geçişiyle görünür hale geliyor;
// formSignature() görünürlüğü computed style üzerinden ölçtüğü için bu
// durumda imza baştan beri AYNI kalabiliyor ve attemptedStages onu "zaten
// dolduruldu" sanıp bir daha denemiyor — TC/Ad Soyad/telefon gibi alanlar
// boş kalıyor. Bu yüzden imza daha önce görülmüş olsa bile, kimlik alanı
// görünür ve hâlâ boşsa yeniden dolduruluyor.
async function hasEmptyIdentityField(target) {
  const input = await locateVisibleField(target,
    ['input[name*="identity" i]', 'input[name*="kimlik" i]', 'input[name*="tc" i]', 'input[placeholder*="TC" i]', 'input[placeholder*="kimlik" i]'],
    ["Kimlik Numarası", "TC Kimlik No", "TC/Vergi", "T.C. Kimlik", "TC Kimlik Numarası", "Vergi Kimlik No"]);
  if (!input) return false;
  const value = await input.inputValue({ timeout: 300 }).catch(() => "");
  return !String(value || "").trim();
}

export async function waitForOutcome({ page, target, job, portal, resultTimeoutMs, requestOtp, requestCaptchaSolve, requestCaptchaCode, setState, isCancelled, attemptedStages = new Set() }) {
  const startedAt = Date.now();
  let lastOffers = [];
  let lastOfferChangeAt = 0;
  let firstOfferAt = 0;
  let lastStage = "Portal formu gönderildi; cevap bekleniyor";
  const track = (status, message, extra) => {
    lastStage = message;
    return setState(status, message, extra);
  };
  while (Date.now() - startedAt < resultTimeoutMs) {
    if (isCancelled()) return { status: "cancelled", message: "Sorgu iptal edildi" };
    if (await dismissLeadCaptureModal(target)) {
      await page.waitForTimeout(400);
      continue;
    }
    // Beklenmeyen onay penceresinde "Hayır" varsa doğrudan seçilir.
    if (await dismissNoPopup(target)) {
      await page.waitForTimeout(400);
      continue;
    }
    const text = await visibleText(target);
    captureSharedFacts(job, text);
    // Bazı sitelerde SMS/doğrulama servisi geçici olarak yanıt vermiyor
    // (ör. SigortaBin: "SMS servisi şu anda yanıt vermiyor. Lütfen tekrar
    // deneyin."). Bu, kalıcı bir eşleme sorunu değil geçici bir arıza
    // olduğundan, sessizce zaman aşımına düşmek yerine hata fırlatıp
    // motorun mevcut yeniden deneme mekanizmasına (yeni, temiz bir
    // tarayıcı bağlamıyla) devrediyoruz.
    if (/SMS SERV[İIıi]S[İIıi].{0,20}YAN[İIıi]T VERM[İIıi]YOR/i.test(text)) {
      throw new Error("Portal SMS servisi geçici olarak yanıt vermiyor (Timeout)");
    }
    if (await detectCaptcha(page, text)) {
      if (portal?.imageCaptcha && await solveImageCaptcha(target, requestCaptchaCode)) {
        if (!await clickSubmit(target)) return { status: "mapping_required", message: "Güvenlik kodu dolduruldu ancak Gönder düğmesi bulunamadı" };
        await track("submitted", "Güvenlik kodu gönderildi; portal cevabı bekleniyor");
        await page.waitForTimeout(900);
        continue;
      }
      if (typeof requestCaptchaSolve !== "function") {
        return { status: "manual_required", message: "CAPTCHA / güvenlik kontrolü kullanıcı tarafından tamamlanmalı" };
      }
      await requestCaptchaSolve();
      await page.waitForTimeout(600);
      continue;
    }
    const detectedState = pageState(text);
    if (detectedState) return { status: detectedState, message: detectedState === "no_offer" ? "Portal teklif bulunamadığını bildirdi" : "Portal oturum veya hız sınırı bildirdi" };

    const otpInput = await findOtpInput(target);
    const smsLanguage = SMS_LANGUAGE_PATTERN.test(text);
    if (otpInput && smsLanguage) {
      if (job.mode === "no_sms") return { status: "skipped_sms", message: "SMS istendiği için atlandı" };
      let code = await requestOtp();
      while (code === RESEND_SENTINEL) {
        const resent = await clickNamedButton(target, [/Tekrar Gönder/i, /Yeniden Gönder/i, /Kod(?:u)? Gönder/i, /SMS Gönder/i]);
        if (!resent) return { status: "mapping_required", message: "Kodu tekrar gönderme düğmesi bulunamadı" };
        code = await requestOtp();
      }
      if (!await fillOtpCode(target, code)) return { status: "mapping_required", message: "SMS kodu alanı doldurulamadı" };
      // Bazı sitelerde SMS kodu kutusunun altında ayrıca onaylanması gereken
      // kutucuklar da oluyor (ör. Dijipol); "Onayla" tıklanmadan önce bunları
      // da işaretlemeye çalış.
      await acceptRequiredConsents(target, { checkAllBoxes: portal?.checkAllBoxes === true });
      if (!await clickSubmit(target)) await otpInput.press("Enter").catch(() => {});
      await track("collecting", "SMS doğrulandı; gerçek teklifler bekleniyor");
      await page.waitForTimeout(1200);
      continue;
    }

    // Bazı karşılaştırma sitelerinde başlangıçta yalnızca öne çıkan/en ucuz
    // tek teklif gösterilip geri kalanı "Tüm Teklifleri Gör" gibi bir
    // düğmenin arkasında saklı tutuluyor (kullanıcı gözlemi: Dijipol tek
    // teklif döndürüyordu). Böyle bir düğme varsa açığa çıkarmayı dener;
    // yoksa no-op (sayfada yoksa hızlıca vazgeçer).
    await clickNamedButton(target, REVEAL_ALL_OFFERS_BUTTON_NAMES).catch(() => {});
    await scrollOfferResults(target);

    const visibleOffers = extractOffersFromText(text, portal);
    if (visibleOffers.length) {
      // Teklifler birer birer yüklendiği ve ara render'larda ekranda geçici
      // olarak azalabildiği için o anki görüntü değil, sorgu boyunca görülen
      // TÜM teklifler biriktiriliyor (bkz. mergeOffers).
      const merged = mergeOffers(lastOffers, visibleOffers);
      if (merged.length !== lastOffers.length) lastOfferChangeAt = Date.now();
      lastOffers = merged;
      if (!firstOfferAt) firstOfferAt = Date.now();
      // Kullanıcı gözlemi: portalların tüm şirketleri listelemesi ~30 saniye
      // sürebiliyor; ilk teklif görüldükten sonra bu süre dolmadan ve üstüne
      // yeni teklif gelmeyi bırakmadan sonuç kapatılmıyor.
      const collectedLongEnough = Date.now() - firstOfferAt >= OFFER_COLLECTION_WINDOW_MS;
      const settled = Date.now() - lastOfferChangeAt >= OFFER_SETTLE_MS;
      if (collectedLongEnough && settled) {
        return { status: "completed", message: `${lastOffers.length} şirket teklifi alındı`, offers: lastOffers };
      }
      await track("collecting", `${lastOffers.length} teklif alındı; diğer şirketler bekleniyor`);
    }
    if (RESULT_PROGRESS_PATTERN.test(text)) {
      await track("collecting", "Sigorta şirketlerinden fiyat bekleniyor");
    }

    const signature = await formSignature(target);
    const seenBefore = attemptedStages.has(signature);
    const needsRefill = seenBefore && await hasEmptyIdentityField(target);
    if (signature !== "[]" && (!seenBefore || needsRefill)) {
      attemptedStages.add(signature);
      const filled = await fillQuoteForm(target, job, portal);
      const filledCount = Object.values(filled).filter(Boolean).length;
      // Bazı adımlarda (ör. EGM/Tramer sorgu sonucu onay ekranı) doldurulacak
      // yeni bir alan olmaz, sadece "Devam" gibi bir düğme vardır; yine de
      // tıklamayı denemeliyiz, yoksa akış orada donup kalır.
      if (await clickSubmit(target)) {
        await track("submitted", filledCount ? "Portalın sonraki adımı dolduruldu; cevap bekleniyor" : "Portalın sonraki ekranı onaylandı; cevap bekleniyor");
        await page.waitForTimeout(1000);
        continue;
      }
    }
    await page.waitForTimeout(2000);
  }
  if (lastOffers.length) return { status: "completed", message: `${lastOffers.length} şirket teklifi alındı`, offers: lastOffers };
  return {
    status: "timeout",
    message: `Portal cevap vermedi; teklif yok olarak işaretlenmedi (son aşama: ${lastStage})`,
    diagnostics: { lastVisibleText: (await visibleText(target)).replace(/\s+/g, " ").trim().slice(0, 400) },
  };
}

export class FormPortalAdapter {
  async probe({ page, portal, navigationTimeoutMs }) {
    await page.goto(portal.url, { waitUntil: "domcontentloaded", timeout: navigationTimeoutMs });
    await page.waitForTimeout(700);
    const text = await visibleText(page);
    if (await detectCaptcha(page, text)) return { state: "manual_required", message: "CAPTCHA / güvenlik doğrulaması gerekiyor" };
    const state = pageState(text);
    if (state) return { state, message: state === "auth_required" ? "Portal oturumu gerekiyor" : "Portal isteği kabul etmedi" };
    const target = await resolveTarget(page, portal);
    const profile = await openQuoteFlow(target, page);
    const formDetected = (profile.hasIdentity || profile.hasPlate || profile.hasRegistration) && profile.hasSubmit;
    return {
      state: formDetected ? "form_detected" : "mapping_required",
      message: formDetected ? "Canlı teklif formu bulundu" : "Teklif formu veya başlangıç düğmesi bulunamadı",
      fields: profile,
    };
  }

  async run(context) {
    const { page, portal, job, navigationTimeoutMs, resultTimeoutMs, setState, requestOtp, requestCaptchaSolve, requestCaptchaCode, isCancelled } = context;
    await setState("opening", "Portal açılıyor");
    await page.goto(portal.url, { waitUntil: "domcontentloaded", timeout: navigationTimeoutMs });
    await page.waitForTimeout(800);
    if (isCancelled()) return { status: "cancelled", message: "Sorgu iptal edildi" };

    let firstText = await visibleText(page);
    for (let attempt = 0; !portal.imageCaptcha && await detectCaptcha(page, firstText); attempt += 1) {
      if (typeof requestCaptchaSolve !== "function" || attempt >= 5) {
        return { status: "manual_required", message: "CAPTCHA / güvenlik kontrolü kullanıcı tarafından tamamlanmalı" };
      }
      await requestCaptchaSolve();
      if (isCancelled()) return { status: "cancelled", message: "Sorgu iptal edildi" };
      firstText = await visibleText(page);
    }
    const initialState = pageState(firstText);
    if (initialState) return { status: initialState, message: initialState === "auth_required" ? "Portal oturumu açılmalı" : "Portal isteği kabul etmedi" };

    const target = await resolveTarget(page, portal);
    const profile = await openQuoteFlow(target, page);
    if (!(profile.hasIdentity || profile.hasPlate || profile.hasRegistration)) {
      return { status: "mapping_required", message: "Portalın canlı teklif başlangıç formu bulunamadı", diagnostics: { fields: profile } };
    }
    await setState("filling", "Araç ve müşteri bilgileri dolduruluyor");
    const filled = await fillQuoteForm(target, job, portal);
    if (!filled.identity && !filled.plate && !filled.registration) return { status: "mapping_required", message: "İlk adımdaki kimlik, plaka veya ruhsat alanı eşleştirilemedi" };
    const attemptedStages = new Set([await formSignature(target)]);
    if (portal.imageCaptcha && await detectCaptcha(page, await visibleText(target))) {
      if (!await solveImageCaptcha(target, requestCaptchaCode)) return { status: "mapping_required", message: "Resim güvenlik kodu veya giriş alanı bulunamadı" };
    }
    if (!await clickSubmit(target)) return { status: "mapping_required", message: "Sorgu düğmesi eşleştirilemedi" };

    await setState("submitted", "Form gönderildi; portal cevabı bekleniyor");
    return waitForOutcome({ page, target, job, portal, resultTimeoutMs, requestOtp, requestCaptchaSolve, requestCaptchaCode, setState, isCancelled, attemptedStages });
  }
}
