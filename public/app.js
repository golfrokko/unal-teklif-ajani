const sampleData = `T.C. / VKN: 12345678901
Doğum Tarihi: 12.04.1988
Plaka: 78 SR 283
Ruhsat Seri No: AB123456
Araç: HYUNDAI ACCENT ERA 1.4
Model Yılı: 2008`;

const statusNames = {
  queued: "Sırada",
  opening: "Portal açılıyor",
  filling: "Bilgiler dolduruluyor",
  submitted: "Sorgu gönderildi",
  collecting: "Teklifler toplanıyor",
  waiting_otp: "SMS kodu bekliyor",
  retrying: "Yeniden deneniyor",
  completed: "Tamamlandı",
  no_offer: "Teklif yok",
  skipped_sms: "SMS nedeniyle atlandı",
  mapping_required: "Adaptör eşlemesi gerekli",
  input_required: "Eksik / geçersiz bilgi",
  access_blocked: "Portal erişimi engelledi",
  auth_required: "Portal oturumu gerekli",
  manual_required: "Manuel işlem gerekli",
  rate_limited: "Portal hız sınırı",
  timeout: "Zaman aşımı",
  cancelled: "İptal edildi",
  interrupted: "Sunucu yeniden başladı",
  error: "Hata",
};

const elements = Object.fromEntries([
  "raw-data", "identity", "birth-date", "plate", "registration", "vehicle", "year", "chassis", "engine",
  "phone", "consent", "start-button", "parse-status", "portal-groups", "progress", "progress-list",
  "progress-title", "progress-subtitle", "job-status", "results", "results-body", "result-count", "otp-dock",
  "otp-cards", "otp-count", "error-banner", "portal-count", "max-concurrency", "concurrency-stat"
].map((id) => [id, document.getElementById(id)]));

let portals = [];
let activeJobId = null;
let pollTimer = null;
let announcedOtpPortals = new Set();
const otpSubmissionState = new Map();
const ACTIVE_JOB_STATUSES = new Set(["queued", "running", "cancelling"]);
const ACTIVE_JOB_STORAGE_KEY = "unal-teklif-active-job";
let portalRefreshTimer = null;
let portalSelectionTouched = false;

function rememberActiveJob(jobId) {
  activeJobId = jobId || null;
  if (activeJobId) window.localStorage.setItem(ACTIVE_JOB_STORAGE_KEY, activeJobId);
  else window.localStorage.removeItem(ACTIVE_JOB_STORAGE_KEY);
}

function startPolling() {
  if (pollTimer) window.clearInterval(pollTimer);
  pollTimer = window.setInterval(pollJob, 1200);
}

function escapeHtml(value) {
  return String(value ?? "").replace(/[&<>"']/g, (character) => ({
    "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#039;",
  })[character]);
}

async function fetchJson(url, options = {}, timeoutMs = 15000) {
  const controller = new AbortController();
  const timeout = window.setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetch(url, { ...options, signal: controller.signal });
    const contentType = response.headers.get("content-type") || "";
    const body = contentType.includes("application/json")
      ? await response.json()
      : { error: (await response.text()).slice(0, 240) || `HTTP ${response.status}` };
    if (!response.ok) throw new Error(body.error || `HTTP ${response.status}`);
    return body;
  } catch (error) {
    if (error.name === "AbortError") throw new Error("Sorgu sunucusu 15 saniye içinde yanıt vermedi.");
    throw error;
  } finally {
    window.clearTimeout(timeout);
  }
}

function parseVehicleData(raw) {
  return {
    identity: raw.match(/(?:t\.?c\.?|tc|vkn|vergi)[^0-9]*(\d{10,11})/i)?.[1] || "",
    birthDate: raw.match(/(?:doğum(?:\s+tarihi)?|dogum(?:\s+tarihi)?)[^0-9]*(\d{1,2}[./-]\d{1,2}[./-]\d{4})/i)?.[1] || "",
    plate: raw.match(/(?:plaka)[^A-ZÇĞİÖŞÜ0-9]*((?:0[1-9]|[1-7]\d|8[01])\s*[A-ZÇĞİÖŞÜ]{1,3}\s*\d{2,5})/i)?.[1]?.replace(/\s+/g, " ").toUpperCase() || "",
    registration: raw.match(/(?:ruhsat(?:\s+seri(?:\s+no)?)?|belge(?:\s+seri(?:\s+no)?)?)[^A-ZÇĞİÖŞÜ0-9]*([A-ZÇĞİÖŞÜ]{1,3}\s*\d{5,8})/i)?.[1]?.replace(/\s+/g, "").toUpperCase() || "",
    vehicle: raw.match(/(?:araç|arac|marka\s*model)[^:\n]*:\s*([^\n]+)/i)?.[1]?.trim() || "",
    year: raw.match(/(?:model\s*yılı|model\s*yili|yıl|yil)[^0-9]*(19\d{2}|20\d{2})/i)?.[1] || "",
    chassis: raw.match(/(?:şasi|sasi)(?:\s+no|\s+numarası)?[^A-Z0-9]*([A-Z0-9]{8,20})/i)?.[1]?.toUpperCase() || "",
    engine: raw.match(/(?:motor)(?:\s+no|\s+numarası)?[^A-Z0-9]*([A-Z0-9]{5,20})/i)?.[1]?.toUpperCase() || "",
  };
}

function setParsed(data) {
  elements.identity.value = data.identity || "";
  elements["birth-date"].value = data.birthDate || "";
  elements.plate.value = data.plate || "";
  elements.registration.value = data.registration || "";
  elements.vehicle.value = data.vehicle || "";
  elements.year.value = data.year || "";
  elements.chassis.value = data.chassis || "";
  elements.engine.value = data.engine || "";
  const count = Object.values(data).filter(Boolean).length;
  elements["parse-status"].textContent = `${count} alan algılandı`;
}

function getVehicle() {
  return {
    identity: elements.identity.value,
    birthDate: elements["birth-date"].value,
    plate: elements.plate.value,
    registration: elements.registration.value,
    vehicle: elements.vehicle.value,
    year: elements.year.value,
    chassis: elements.chassis.value,
    engine: elements.engine.value,
  };
}

function phoneDigits() {
  return elements.phone.value.replace(/\D/g, "");
}

function formatPhone(value) {
  let digits = String(value).replace(/\D/g, "");
  if (digits.startsWith("90") && digits.length === 12) digits = digits.slice(2);
  if (digits.length === 10) digits = `0${digits}`;
  return digits.length === 11 ? `${digits.slice(0,4)} ${digits.slice(4,7)} ${digits.slice(7,9)} ${digits.slice(9,11)}` : value;
}

function showError(message) {
  elements["error-banner"].textContent = message;
  elements["error-banner"].classList.remove("hidden");
  window.setTimeout(() => elements["error-banner"].classList.add("hidden"), 7000);
}

function selectedPortalIds() {
  return [...document.querySelectorAll('.portal-check input:checked')].map((input) => input.value);
}

function renderPortals({ preserveSelection = false } = {}) {
  const previousSelection = preserveSelection && portalSelectionTouched ? new Set(selectedPortalIds()) : null;
  const smsLabels = {
    none: "SMS yok • doğrulandı",
    per_query: "Her sorguda SMS",
    session_once: "Oturum açarken bir kez SMS",
    unknown: "SMS durumu belirsiz",
  };
  const grouped = portals.reduce((map, portal) => {
    if (!map.has(portal.group)) map.set(portal.group, []);
    map.get(portal.group).push(portal);
    return map;
  }, new Map());
  elements["portal-groups"].innerHTML = [...grouped.entries()].map(([group, items]) => `
    <article class="portal-group">
      <h4>${group} • ${items.length}</h4>
      <div class="portal-items">
        ${items.map((portal) => {
          const probeLabels = {
            running: "Canlı bağlantı test ediliyor",
            form_detected: "Canlı form bulundu",
            mapping_required: "Teklif formu eşleştirilemedi",
            manual_required: "CAPTCHA / manuel doğrulama gerekli",
            access_blocked: "Sunucu erişimi engellendi",
            auth_required: "Portal oturumu gerekli",
            error: "Bağlantı hatası",
            timeout: "Bağlantı zaman aşımı",
            unsupported: "Adaptör teşhisi eksik",
          };
          const readiness = probeLabels[portal.probeState]
            || (portal.enabled ? ({ verified: "Canlı doğrulandı", beta: "Canlı test aşaması" }[portal.integrationStatus] || "Adaptör testi gerekli") : "Canlı test bekleniyor");
          const available = portal.available ?? portal.enabled;
          const checked = available && (previousSelection ? previousSelection.has(portal.id) : portal.enabled);
          return `<label class="portal-check" title="${escapeHtml(portal.probeMessage || portal.smsEvidence || "")}"><input type="checkbox" value="${escapeHtml(portal.id)}" ${checked ? "checked" : ""} ${available ? "" : "disabled"} /><span></span><div><strong>${escapeHtml(portal.name)}</strong><small>${escapeHtml(readiness)}<br />${escapeHtml(smsLabels[portal.smsPolicy] || smsLabels.unknown)}</small></div></label>`;
        }).join("")}
      </div>
    </article>
  `).join("");
  const availableCount = portals.filter((portal) => portal.available ?? portal.enabled).length;
  elements["portal-count"].textContent = `${availableCount} hazır / ${portals.length} portal`;
}

function renderProgress(job) {
  const states = Object.values(job.portalStates || {});
  const doneStatuses = ["completed", "no_offer", "skipped_sms", "mapping_required", "input_required", "access_blocked", "auth_required", "manual_required", "rate_limited", "timeout", "error", "cancelled", "interrupted"];
  const done = states.filter((state) => doneStatuses.includes(state.status)).length;
  const otpDrafts = new Map([...document.querySelectorAll("#progress-list .otp-entry")].map((form) => [form.dataset.portalId, form.querySelector("input")?.value || ""]));
  const focusedOtpForm = document.activeElement?.closest?.(".otp-entry");
  const focusedPortalId = focusedOtpForm?.dataset.portalId || null;
  const focusedSelection = focusedOtpForm?.querySelector("input")?.selectionStart ?? null;
  elements.progress.classList.remove("hidden");
  elements["progress-title"].textContent = `${done} / ${states.length} portal tamamlandı`;
  elements["progress-subtitle"].textContent = job.mode === "no_sms" ? "SMS isteyen portallar otomatik atlanıyor." : "SMS isteyen portallar kod baloncuğunda bekliyor.";
  elements["job-status"].textContent = ({ completed: "Sorgu tamamlandı", partial: "Kısmi tamamlandı", failed: "Sorgu başarısız", cancelled: "İptal edildi", interrupted: "Kesintiye uğradı" })[job.status] || "Sorgulanıyor";
  elements["progress-list"].innerHTML = states.map((state) => {
    const portalId = escapeHtml(state.portalId);
    const portalName = escapeHtml(state.portalName);
    const message = escapeHtml(state.message || statusNames[state.status] || state.status);
    const otpState = otpSubmissionState.get(state.portalId);
    const waitingForOtp = state.status === "waiting_otp";
    return `
      <article class="progress-item" data-status="${escapeHtml(state.status)}">
        <div class="progress-row" data-status="${escapeHtml(state.status)}">
          <i></i><div><strong>${portalName}</strong><small>${message}</small></div><b>${escapeHtml(statusNames[state.status] || state.status)}</b>
        </div>
        ${waitingForOtp ? `
          <form class="otp-entry otp-inline" data-portal-id="${portalId}">
            <div class="otp-inline-copy"><strong>${portalName} SMS doğrulaması</strong><small>Telefona gelen kodu aşağıya yazın. Kod yalnız bu firmaya gönderilir.</small></div>
            <div class="otp-inline-fields"><input inputmode="numeric" autocomplete="one-time-code" maxlength="8" placeholder="SMS kodu" aria-label="${portalName} SMS kodu" required ${otpState ? "disabled" : ""} /><button type="submit" ${otpState ? "disabled" : ""}>${otpState === "sending" ? "Gönderiliyor…" : otpState === "sent" ? "Kod gönderildi" : "Kodu doğrula"}</button></div>
          </form>` : ""}
      </article>`;
  }).join("");

  document.querySelectorAll("#progress-list .otp-entry").forEach((form) => {
    const input = form.querySelector("input");
    if (input && otpDrafts.has(form.dataset.portalId)) input.value = otpDrafts.get(form.dataset.portalId);
  });
  if (focusedPortalId) {
    const nextForm = [...document.querySelectorAll("#progress-list .otp-entry")].find((form) => form.dataset.portalId === focusedPortalId);
    const nextInput = nextForm?.querySelector("input:not(:disabled)");
    if (nextInput) {
      nextInput.focus({ preventScroll: true });
      if (focusedSelection !== null) nextInput.setSelectionRange(focusedSelection, focusedSelection);
    }
  }
}

function renderOtp(job) {
  const waiting = Object.values(job.portalStates || {}).filter((state) => state.status === "waiting_otp");
  elements["otp-dock"].classList.add("hidden");
  elements["otp-count"].textContent = `${waiting.length} portal kod bekliyor`;
  elements["otp-cards"].innerHTML = "";
  document.querySelectorAll(".otp-entry").forEach((form) => form.addEventListener("submit", submitOtp));

  const waitingIds = new Set(waiting.map((state) => state.portalId));
  for (const portalId of [...announcedOtpPortals]) {
    if (!waitingIds.has(portalId)) announcedOtpPortals.delete(portalId);
  }
  for (const portalId of [...otpSubmissionState.keys()]) {
    if (!waitingIds.has(portalId)) otpSubmissionState.delete(portalId);
  }
  const freshOtp = waiting.find((state) => !announcedOtpPortals.has(state.portalId));
  if (freshOtp) {
    announcedOtpPortals.add(freshOtp.portalId);
    window.requestAnimationFrame(() => {
      const form = [...document.querySelectorAll("#progress-list .otp-entry")].find((item) => item.dataset.portalId === freshOtp.portalId);
      form?.scrollIntoView({ behavior: "smooth", block: "center" });
      form?.querySelector("input")?.focus({ preventScroll: true });
    });
  }
}

function formatTry(value) {
  return new Intl.NumberFormat("tr-TR", { style: "currency", currency: "TRY", minimumFractionDigits: 2 }).format(value);
}

function renderResults(job) {
  const rows = job.summary || [];
  if (!rows.length && job.status !== "completed") return;
  elements.results.classList.remove("hidden");
  elements["result-count"].textContent = `${rows.length} şirket`;
  elements["results-body"].innerHTML = rows.length ? rows.map((row, index) => {
    const best = row.sources.find((source) => source.price === row.bestPrice) || row.sources[0];
    return `<tr><td>${index + 1}</td><td><strong>${row.company}</strong></td><td class="price">${formatTry(row.bestPrice)}</td><td>${best.sourcePortal}</td><td>${row.sources.length} portal</td></tr>`;
  }).join("") : `<tr><td colspan="5">Henüz fiyat teklifi alınamadı. Portal durumlarını kontrol edin.</td></tr>`;
}

async function submitOtp(event) {
  event.preventDefault();
  const form = event.currentTarget;
  const input = form.querySelector("input");
  const button = form.querySelector("button");
  const portalId = form.dataset.portalId;
  const code = input.value.trim();
  if (!/^\d{4,8}$/.test(code)) return showError("SMS kodu 4-8 rakam olmalıdır.");
  otpSubmissionState.set(portalId, "sending");
  button.disabled = true;
  input.disabled = true;
  button.textContent = "Gönderiliyor…";
  try {
    const response = await fetch(`/api/jobs/${activeJobId}/otp/${portalId}`, {
      method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ code })
    });
    const body = await response.json();
    if (!response.ok) throw new Error(body.error || "Kod gönderilemedi");
    otpSubmissionState.set(portalId, "sent");
    button.textContent = "Kod gönderildi";
    await pollJob();
  } catch (error) {
    otpSubmissionState.delete(portalId);
    button.disabled = false;
    input.disabled = false;
    button.textContent = "Kodu doğrula";
    showError(error.message);
  }
}

async function pollJob() {
  if (!activeJobId) return;
  try {
    const job = await fetchJson(`/api/jobs/${activeJobId}`, {}, 10000);
    renderProgress(job);
    renderOtp(job);
    renderResults(job);
    if (["completed", "partial", "failed", "cancelled", "interrupted"].includes(job.status)) {
      window.clearInterval(pollTimer);
      pollTimer = null;
      rememberActiveJob(null);
      elements["start-button"].disabled = false;
      elements["start-button"].innerHTML = "Yeni sorgu başlat <span>→</span>";
    }
  } catch (error) {
    showError(error.message);
  }
}

async function startJob() {
  const vehicle = getVehicle();
  if (!/^\d{10,11}$/.test(vehicle.identity.replace(/\D/g, "")) || !vehicle.plate) return showError("TC/VKN ve plaka zorunludur.");
  if (!elements.consent.checked) return showError("Müşteri sorgulama onayını işaretleyin.");
  const portalIds = selectedPortalIds();
  if (!portalIds.length) return showError("En az bir portal seçin.");
  const mode = document.querySelector('input[name="mode"]:checked').value;
  elements["start-button"].disabled = true;
  elements["start-button"].textContent = "Sorgu başlatılıyor...";
  announcedOtpPortals = new Set();
  otpSubmissionState.clear();
  try {
    const body = await fetchJson("/api/jobs", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ vehicle, mode, phone: phoneDigits(), portalIds, customerConsent: true })
    }, 15000);
    rememberActiveJob(body.id);
    renderProgress(body);
    elements.progress.scrollIntoView({ behavior: "smooth", block: "start" });
    startPolling();
    await pollJob();
  } catch (error) {
    elements["start-button"].disabled = false;
    elements["start-button"].innerHTML = "Tüm seçili portallarda sorgula <span>→</span>";
    showError(error.message);
  }
}

async function boot() {
  try {
    const [health, portalData, jobData] = await Promise.all([fetchJson("/health"), fetchJson("/api/portals"), fetchJson("/api/jobs")]);
    if (!health.ok) throw new Error("Çevrimiçi sorgu ajanı başlatılamadı");
    if (health.defaultPhone) elements.phone.value = formatPhone(health.defaultPhone);
    portals = portalData.portals;
    elements["max-concurrency"].textContent = `En fazla ${portalData.maxConcurrency} eşzamanlı sorgu`;
    elements["concurrency-stat"].textContent = portalData.maxConcurrency;
    renderPortals();

    const rememberedJobId = window.localStorage.getItem(ACTIVE_JOB_STORAGE_KEY);
    const jobs = Array.isArray(jobData.jobs) ? jobData.jobs : [];
    const resumable = jobs.find((job) => job.id === rememberedJobId && ACTIVE_JOB_STATUSES.has(job.status))
      || jobs.find((job) => ACTIVE_JOB_STATUSES.has(job.status) || Object.values(job.portalStates || {}).some((state) => state.status === "waiting_otp"));
    if (resumable) {
      rememberActiveJob(resumable.id);
      elements["start-button"].disabled = true;
      elements["start-button"].textContent = "Aktif sorgu devam ediyor...";
      renderProgress(resumable);
      renderOtp(resumable);
      renderResults(resumable);
      startPolling();
      await pollJob();
    } else {
      rememberActiveJob(null);
    }

    let refreshCount = 0;
    portalRefreshTimer = window.setInterval(async () => {
      if (refreshCount >= 18) return window.clearInterval(portalRefreshTimer);
      refreshCount += 1;
      try {
        const refreshed = await fetchJson("/api/portals", {}, 10000);
        portals = refreshed.portals;
        renderPortals({ preserveSelection: true });
        if (portals.every((portal) => portal.probeState && portal.probeState !== "running")) window.clearInterval(portalRefreshTimer);
      } catch {}
    }, 5000);
  } catch (error) {
    showError(`Sorgu sunucusu bağlantı hatası: ${error.message}`);
  }
}

elements["raw-data"].addEventListener("input", (event) => setParsed(parseVehicleData(event.target.value)));
elements["sample-button"] = document.getElementById("sample-button");
elements["sample-button"].addEventListener("click", () => { elements["raw-data"].value = sampleData; setParsed(parseVehicleData(sampleData)); });
document.getElementById("clear-button").addEventListener("click", () => { elements["raw-data"].value = ""; setParsed({}); });
elements.phone.addEventListener("blur", () => { elements.phone.value = formatPhone(elements.phone.value); });
elements["start-button"].addEventListener("click", startJob);
document.querySelectorAll('.mode input').forEach((input) => input.addEventListener("change", () => document.querySelectorAll(".mode").forEach((label) => label.classList.toggle("selected", label.contains(document.querySelector('input[name="mode"]:checked'))))));
elements["portal-groups"].addEventListener("change", (event) => {
  if (event.target.matches('.portal-check input')) portalSelectionTouched = true;
});
document.getElementById("select-all").addEventListener("click", () => {
  portalSelectionTouched = true;
  document.querySelectorAll('.portal-check input:not(:disabled)').forEach((input) => { input.checked = true; });
});
document.getElementById("select-none").addEventListener("click", () => {
  portalSelectionTouched = true;
  document.querySelectorAll('.portal-check input').forEach((input) => { input.checked = false; });
});
document.getElementById("select-ihsan").addEventListener("click", () => {
  portalSelectionTouched = true;
  document.querySelectorAll('.portal-check input').forEach((input) => { input.checked = !input.disabled && portals.find((portal) => portal.id === input.value)?.group === "İhsan altyapısı"; });
});

boot();
