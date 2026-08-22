const sampleData = `Ad Soyad: Ahmet Yılmaz
T.C. / VKN: 12345678901
Doğum Tarihi: 12.04.1988
Plaka: 78 SR 283
Ruhsat Seri No: AB123456
Araç: HYUNDAI ACCENT ERA 1.4
Model Yılı: 2008
Kullanım Tarzı: Hususi
E-posta: ahmet.yilmaz@example.com`;

const statusNames = {
  queued: "Sırada",
  opening: "Portal açılıyor",
  filling: "Bilgiler dolduruluyor",
  submitted: "Sorgu gönderildi",
  collecting: "Teklifler toplanıyor",
  waiting_otp: "SMS kodu bekliyor",
  waiting_input: "Ek bilgi bekleniyor",
  waiting_approval: "Onayınız bekleniyor",
  waiting_captcha: "CAPTCHA sizi bekliyor",
  retrying: "Yeniden deneniyor",
  completed: "Tamamlandı",
  no_offer: "Teklif yok",
  skipped_sms: "SMS nedeniyle atlandı",
  mapping_required: "Adaptör eşlemesi gerekli",
  input_required: "Eksik / geçersiz bilgi",
  access_blocked: "Portal erişimi engelledi",
  auth_required: "Portal oturumu gerekli",
  redirect_only: "Başka kaynağa yönlendiriyor",
  client_error: "Portal uygulaması yüklenemedi",
  manual_required: "Manuel işlem gerekli",
  rate_limited: "Portal hız sınırı",
  timeout: "Zaman aşımı",
  cancelled: "İptal edildi",
  interrupted: "Sunucu yeniden başladı",
  error: "Hata",
};

const elements = Object.fromEntries([
  "raw-data", "full-name", "identity", "birth-date", "plate", "registration", "vehicle", "year", "chassis", "engine", "usage-type",
  "phone", "email", "consent", "start-button", "parse-status", "portal-groups", "progress", "progress-list",
  "progress-title", "progress-subtitle", "job-status", "cancel-button", "log", "log-list", "log-count",
  "error-log", "error-log-list", "error-log-count", "session-check-status",
  "results", "results-body", "result-count", "otp-dock",
  "otp-cards", "otp-count", "error-banner", "portal-count", "max-concurrency", "concurrency-stat",
  "open-session-panel", "open-session-title", "open-session-subtitle", "open-session-cancel",
  "open-session-queue", "open-session-live-image", "open-session-type-input", "open-session-type-send",
  "open-session-key-enter", "open-session-key-tab", "open-session-key-backspace",
  "open-session-status", "open-session-finish",
].map((id) => [id, document.getElementById(id)]));

let portals = [];
let activeJobId = null;
let pollTimer = null;
let announcedOtpPortals = new Set();
const otpSubmissionState = new Map();
const otpErrorState = new Map();
const ACTIVE_JOB_STATUSES = new Set(["queued", "running", "cancelling"]);
const ACTIVE_JOB_STORAGE_KEY = "unal-teklif-active-job";
let portalRefreshTimer = null;
let portalSelectionTouched = false;
let jobLog = [];
let loggedJobId = null;
let loggedJobStatus = null;
const loggedPortalUpdates = new Map();
let techLog = [];
const loggedTechPortalUpdates = new Map();
const expandedResultCompanies = new Set();
let openSessionQueue = [];
let openSessionIndex = -1;
let openSessionPollTimer = null;

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

const LOG_LEVELS = {
  success: ["completed", "no_offer"],
  error: ["error", "timeout", "mapping_required", "input_required", "access_blocked", "auth_required", "manual_required", "rate_limited", "failed"],
  warn: ["skipped_sms", "cancelled", "interrupted", "retrying", "partial", "waiting_approval", "waiting_captcha"],
};
function logLevelForStatus(status) {
  if (LOG_LEVELS.success.includes(status)) return "success";
  if (LOG_LEVELS.error.includes(status)) return "error";
  if (LOG_LEVELS.warn.includes(status)) return "warn";
  return "info";
}

function renderLog() {
  elements.log.classList.toggle("hidden", jobLog.length === 0);
  elements["log-count"].textContent = `${jobLog.length} kayıt`;
  elements["log-list"].innerHTML = jobLog.length
    ? [...jobLog].reverse().map((entry) => `<div class="sidebar-log-row" data-level="${entry.level}"><i></i><div><time>${entry.time.toLocaleTimeString("tr-TR")}</time><p>${entry.html}</p></div></div>`).join("")
    : `<div class="sidebar-log-empty">Henüz kayıt yok.</div>`;
}

function appendLog(html, level = "info") {
  jobLog.push({ time: new Date(), html, level });
  if (jobLog.length > 300) jobLog.shift();
  renderLog();
}

function updateJobLog(job) {
  if (job.id !== loggedJobId) {
    jobLog = [];
    loggedPortalUpdates.clear();
    loggedJobStatus = null;
    loggedJobId = job.id;
    appendLog(`API: sorgu oluşturuldu, ${Object.keys(job.portalStates || {}).length} portal kuyruğa alındı.`, "info");
  }
  for (const state of Object.values(job.portalStates || {})) {
    if (loggedPortalUpdates.get(state.portalId) === state.updatedAt) continue;
    loggedPortalUpdates.set(state.portalId, state.updatedAt);
    const stage = statusNames[state.status] || state.status;
    const attempt = state.attempt > 1 ? ` · deneme ${state.attempt}` : "";
    const detail = state.message && state.message !== stage ? ` — ${escapeHtml(state.message)}` : "";
    appendLog(`<b>${escapeHtml(state.portalName)}</b> <em>${escapeHtml(stage)}${attempt}</em>${detail}`, logLevelForStatus(state.status));
    const siteText = state.diagnostics?.lastVisibleText;
    if (siteText) {
      appendLog(`<b>${escapeHtml(state.portalName)}</b> sitede görünen metin: <em class="log-quote">${escapeHtml(siteText.slice(0, 220))}${siteText.length > 220 ? "…" : ""}</em>`, "warn");
    }
    if (state.status === "error" && loggedTechPortalUpdates.get(state.portalId) !== state.updatedAt) {
      loggedTechPortalUpdates.set(state.portalId, state.updatedAt);
      appendTechLog(`<b>${escapeHtml(state.portalName)}</b> adaptör kodu istisna fırlattı<br /><em class="log-quote">${escapeHtml(String(state.message || "").slice(0, 400))}</em>`);
    }
  }
  if (job.status !== loggedJobStatus) {
    loggedJobStatus = job.status;
    const jobLabels = { completed: "API: sorgu tamamlandı.", partial: "API: sorgu kısmi sonuçla tamamlandı.", failed: "API: sorgu başarısız oldu.", cancelled: "API: sorgu iptal edildi.", interrupted: "API: sunucu yeniden başladığı için sorgu kesintiye uğradı." };
    if (jobLabels[job.status]) appendLog(jobLabels[job.status], logLevelForStatus(job.status));
  }
}

function renderTechLog() {
  elements["error-log"].classList.toggle("hidden", techLog.length === 0);
  elements["error-log-count"].textContent = `${techLog.length} kayıt`;
  elements["error-log-list"].innerHTML = techLog.length
    ? [...techLog].reverse().map((entry) => `<div class="sidebar-log-row" data-level="error"><i></i><div><time>${entry.time.toLocaleTimeString("tr-TR")}</time><p>${entry.html}</p></div></div>`).join("")
    : `<div class="sidebar-log-empty">Teknik hata yok.</div>`;
}

function appendTechLog(html) {
  techLog.push({ time: new Date(), html });
  if (techLog.length > 200) techLog.shift();
  renderTechLog();
}

function logTechError(context, error) {
  const detail = error?.stack || error?.message || String(error);
  appendTechLog(`<b>${escapeHtml(context)}</b><br /><em class="log-quote">${escapeHtml(detail.slice(0, 400))}</em>`);
}

window.addEventListener("error", (event) => {
  appendTechLog(`<b>Tarayıcı hatası</b> ${escapeHtml(event.filename ? `${event.filename.split("/").pop()}:${event.lineno}:${event.colno}` : "")}<br /><em class="log-quote">${escapeHtml(String(event.message || event.error?.message || "Bilinmeyen hata").slice(0, 400))}</em>`);
});

window.addEventListener("unhandledrejection", (event) => {
  logTechError("Yakalanmamış promise hatası", event.reason);
});

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
    const message = error.name === "AbortError" ? "Sorgu sunucusu 15 saniye içinde yanıt vermedi." : error.message;
    logTechError(`API isteği başarısız: ${url}`, new Error(message));
    if (error.name === "AbortError") throw new Error(message);
    throw error;
  } finally {
    window.clearTimeout(timeout);
  }
}

function parseVehicleData(raw) {
  return {
    fullName: raw.match(/(?:ad\s*soyad(?:ı)?|sigortalı(?:\s*adı\s*soyadı)?|müşteri\s*adı\s*soyadı|isim\s*soyisim|poliçe\s*sahibi)[^:\n]*:\s*([^\n\d:]{3,60})/i)?.[1]?.replace(/\s+/g, " ").trim() || "",
    identity: raw.match(/(?:t\.?c\.?|tc|vkn|vergi)[^0-9]*(\d{10,11})/i)?.[1] || "",
    birthDate: raw.match(/(?:doğum(?:\s+tarihi)?|dogum(?:\s+tarihi)?)[^0-9]*(\d{1,2}[./-]\d{1,2}[./-]\d{4})/i)?.[1] || "",
    plate: raw.match(/(?:plaka)[^A-ZÇĞİÖŞÜ0-9]*((?:0[1-9]|[1-7]\d|8[01])\s*[A-ZÇĞİÖŞÜ]{1,3}\s*\d{2,5})/i)?.[1]?.replace(/\s+/g, " ").toUpperCase() || "",
    registration: raw.match(/(?:ruhsat(?:\s+tescil)?(?:\s+seri)?(?:\s+belge)?(?:\s+no(?:su)?)?|tescil(?:\s+belge)?(?:\s+seri)?(?:\s+no(?:su)?)?|belge(?:\s+seri(?:\s+no)?)?)[^A-ZÇĞİÖŞÜ0-9]*([A-ZÇĞİÖŞÜ]{1,3}\s*\d{5,8})/i)?.[1]?.replace(/\s+/g, "").toUpperCase() || "",
    vehicle: raw.match(/(?:araç|arac|marka\s*model)[^:\n]*:\s*([^\n]+)/i)?.[1]?.trim() || "",
    year: raw.match(/(?:model\s*yılı|model\s*yili|yıl|yil)[^0-9]*(19\d{2}|20\d{2})/i)?.[1] || "",
    chassis: raw.match(/(?:şasi|sasi)(?:\s+no|\s+numarası)?[^A-Z0-9]*([A-Z0-9]{8,20})/i)?.[1]?.toUpperCase() || "",
    engine: raw.match(/(?:motor)(?:\s+no|\s+numarası)?[^A-Z0-9]*([A-Z0-9]{5,20})/i)?.[1]?.toUpperCase() || "",
    usageType: raw.match(/(?:kullanım\s*tarz[ıi]|kullanim\s*tarz[ıi]|kullanım\s*şekli|kullanim\s*sekli)[^:\n]*:\s*([^\n]{2,40})/i)?.[1]?.trim() || "",
    email: raw.match(/[a-z0-9._%+-]+@[a-z0-9.-]+\.[a-z]{2,}/i)?.[0]?.toLowerCase() || "",
  };
}

function setParsed(data) {
  elements["full-name"].value = data.fullName || "";
  elements.identity.value = data.identity || "";
  elements["birth-date"].value = data.birthDate || "";
  elements.plate.value = data.plate || "";
  elements.registration.value = data.registration || "";
  elements.vehicle.value = data.vehicle || "";
  elements.year.value = data.year || "";
  elements.chassis.value = data.chassis || "";
  elements.engine.value = data.engine || "";
  elements["usage-type"].value = data.usageType || "";
  if (data.email) elements.email.value = data.email;
  const count = Object.values(data).filter(Boolean).length;
  elements["parse-status"].textContent = `${count} alan algılandı`;
}

function getVehicle() {
  return {
    fullName: elements["full-name"].value,
    identity: elements.identity.value,
    birthDate: elements["birth-date"].value,
    plate: elements.plate.value,
    registration: elements.registration.value,
    vehicle: elements.vehicle.value,
    year: elements.year.value,
    chassis: elements.chassis.value,
    engine: elements.engine.value,
    usageType: elements["usage-type"].value,
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

function relativeTime(isoString) {
  const ms = Date.now() - new Date(isoString).getTime();
  if (!Number.isFinite(ms) || ms < 0) return "";
  const minutes = Math.floor(ms / 60000);
  if (minutes < 1) return "az önce";
  if (minutes < 60) return `${minutes} dk önce`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours} sa önce`;
  return `${Math.floor(hours / 24)} gün önce`;
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
            redirect_only: "Bağımsız kaynak değil • başka portala yönlendiriyor",
            client_error: "Portalın kendi formu yüklenemiyor",
            error: "Bağlantı hatası",
            timeout: "Bağlantı zaman aşımı",
            unsupported: "Adaptör teşhisi eksik",
          };
          const readiness = probeLabels[portal.probeState]
            || (portal.enabled ? ({ verified: "Canlı doğrulandı", beta: "Canlı test aşaması" }[portal.integrationStatus] || "Adaptör testi gerekli") : "Canlı test bekleniyor");
          const available = portal.available ?? portal.enabled;
          const checked = available && (previousSelection ? previousSelection.has(portal.id) : portal.enabled);
          const sessionBadge = portal.smsPolicy === "session_once"
            ? `<em class="session-badge" data-state="${portal.sessionLoggedIn === true ? "on" : portal.sessionLoggedIn === false ? "off" : "unknown"}" title="${escapeHtml(portal.sessionMessage || "")}">${portal.sessionLoggedIn === true ? "● Bağlı" : portal.sessionLoggedIn === false ? "● Bağlı değil" : "○ Kontrol edilmedi"}${portal.sessionCheckedAt ? ` · ${relativeTime(portal.sessionCheckedAt)}` : ""}</em>`
            : "";
          const screenshotKind = portal.sessionHasScreenshot ? "session" : (portal.probeHasScreenshot ? "probe" : null);
          const screenshotLink = screenshotKind
            ? `<a class="portal-screenshot-link" href="/api/portals/${encodeURIComponent(portal.id)}/screenshot/${screenshotKind}?t=${Date.now()}" target="_blank" rel="noopener" title="Hata anındaki ekran görüntüsü">📷 Ekran görüntüsü</a>`
            : "";
          return `<label class="portal-check" title="${escapeHtml(portal.probeMessage || portal.smsEvidence || "")}"><input type="checkbox" value="${escapeHtml(portal.id)}" ${checked ? "checked" : ""} ${available ? "" : "disabled"} /><span></span><div><strong>${escapeHtml(portal.name)}</strong><small>${escapeHtml(readiness)}<br />${escapeHtml(smsLabels[portal.smsPolicy] || smsLabels.unknown)}</small>${sessionBadge}${screenshotLink}</div></label>`;
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
  const otpDrafts = new Map([...document.querySelectorAll("#progress-list .otp-entry")].map((form) => [form.dataset.portalId, form.querySelector("input, select")?.value || ""]));
  const focusedOtpForm = document.activeElement?.closest?.(".otp-entry");
  const focusedPortalId = focusedOtpForm?.dataset.portalId || null;
  const focusedInputEl = focusedOtpForm?.querySelector("input, select");
  const focusedSelection = focusedInputEl?.tagName === "INPUT" ? focusedInputEl.selectionStart ?? null : null;
  elements.progress.classList.remove("hidden");
  elements["progress-title"].textContent = `${done} / ${states.length} portal tamamlandı`;
  elements["progress-subtitle"].textContent = job.mode === "no_sms" ? "SMS isteyen portallar otomatik atlanıyor." : "SMS isteyen portallar kod baloncuğunda bekliyor.";
  elements["job-status"].textContent = ({ completed: "Sorgu tamamlandı", partial: "Kısmi tamamlandı", failed: "Sorgu başarısız", cancelled: "İptal edildi", interrupted: "Kesintiye uğradı" })[job.status] || "Sorgulanıyor";
  const cancellable = ["queued", "running", "cancelling"].includes(job.status);
  elements["cancel-button"].classList.toggle("hidden", !cancellable);
  elements["cancel-button"].disabled = job.status === "cancelling";
  elements["cancel-button"].textContent = job.status === "cancelling" ? "İptal ediliyor…" : "Sorguyu durdur";
  elements["progress-list"].innerHTML = states.map((state) => {
    const portalId = escapeHtml(state.portalId);
    const portalName = escapeHtml(state.portalName);
    const message = escapeHtml(state.message || statusNames[state.status] || state.status);
    const otpState = otpSubmissionState.get(state.portalId);
    const waitingForOtp = state.status === "waiting_otp";
    const waitingForInput = state.status === "waiting_input";
    const waitingForApproval = state.status === "waiting_approval";
    const waitingForCaptcha = state.status === "waiting_captcha";
    const inputId = waitingForOtp ? "otp" : escapeHtml(state.inputId || "");
    const inputLabel = waitingForOtp ? "SMS doğrulaması" : escapeHtml(state.inputLabel || "Ek bilgi");
    const inputCopy = waitingForOtp ? "Telefona gelen kodu aşağıya yazın. Kod yalnız bu firmaya gönderilir." : "Portal bu bilgiyi istiyor; aşağıya yazıp gönderin.";
    const choices = !waitingForOtp && Array.isArray(state.inputChoices) ? state.inputChoices : null;
    const field = choices?.length
      ? `<select aria-label="${portalName} ${inputLabel}" required ${otpState ? "disabled" : ""}><option value="">Seçiniz</option>${choices.map((choice) => `<option value="${escapeHtml(choice.value)}">${escapeHtml(choice.label)}</option>`).join("")}</select>`
      : `<input inputmode="${waitingForOtp ? "numeric" : "text"}" autocomplete="${waitingForOtp ? "one-time-code" : "off"}" maxlength="${waitingForOtp ? 8 : 64}" placeholder="${waitingForOtp ? "SMS kodu" : inputLabel}" aria-label="${portalName} ${inputLabel}" required ${otpState ? "disabled" : ""} />`;
    return `
      <article class="progress-item" data-status="${escapeHtml(state.status)}">
        <div class="progress-row" data-status="${escapeHtml(state.status)}">
          <i></i><div><strong>${portalName}</strong><small>${message}</small></div><b>${escapeHtml(statusNames[state.status] || state.status)}</b>
        </div>
        ${(waitingForOtp || waitingForInput) ? `
          <form class="otp-entry otp-inline" data-portal-id="${portalId}" data-input-id="${inputId}">
            <div class="otp-inline-copy"><strong>${portalName} ${inputLabel}</strong><small>${inputCopy}</small></div>
            <div class="otp-inline-fields">${field}<button type="submit" ${otpState ? "disabled" : ""}>${otpState === "sending" ? "Gönderiliyor…" : otpState === "sent" ? "Gönderildi" : (waitingForOtp ? "Kodu doğrula" : "Gönder")}</button></div>
            ${waitingForOtp ? `<button type="button" class="otp-resend" data-portal-id="${portalId}" ${otpState ? "disabled" : ""}>SMS gelmedi mi? Kodu tekrar gönder</button>` : ""}
            ${otpErrorState.has(state.portalId) ? `<p class="otp-inline-error">${escapeHtml(otpErrorState.get(state.portalId))}</p>` : ""}
          </form>` : ""}
        ${waitingForApproval ? `
          <div class="approval-inline" data-portal-id="${portalId}">
            <div class="otp-inline-copy"><strong>${portalName} devam etmek için onay bekliyor</strong><small>${escapeHtml(state.pendingMessage || message)}</small></div>
            <div class="approval-inline-actions">
              ${state.hasScreenshot ? `<a href="/api/jobs/${encodeURIComponent(activeJobId || "")}/screenshot/${portalId}" target="_blank" rel="noopener">Ekran görüntüsünü gör</a>` : ""}
              <button type="button" class="approval-continue" data-portal-id="${portalId}">Devam Et</button>
            </div>
          </div>` : ""}
        ${waitingForCaptcha ? `
          <div class="captcha-inline" data-portal-id="${portalId}">
            <div class="otp-inline-copy"><strong>${portalName} güvenlik kontrolü (CAPTCHA) bekliyor</strong><small>Aşağıdaki canlı ekrana tıklayarak CAPTCHA'yı kendiniz çözün; bittiğinde "Devam Et"e basın.</small></div>
            <div class="captcha-live-wrap">
              <img class="captcha-live-image" data-portal-id="${portalId}" src="/api/jobs/${encodeURIComponent(activeJobId || "")}/captcha/${portalId}/live?t=${Date.now()}" alt="${portalName} canlı ekran" />
            </div>
            <div class="approval-inline-actions">
              <button type="button" class="captcha-continue" data-portal-id="${portalId}">Devam Et, çözdüm</button>
            </div>
          </div>` : ""}
      </article>`;
  }).join("");

  document.querySelectorAll("#progress-list .otp-entry").forEach((form) => {
    const input = form.querySelector("input, select");
    if (input && otpDrafts.has(form.dataset.portalId)) input.value = otpDrafts.get(form.dataset.portalId);
  });
  if (focusedPortalId) {
    const nextForm = [...document.querySelectorAll("#progress-list .otp-entry")].find((form) => form.dataset.portalId === focusedPortalId);
    const nextInput = nextForm?.querySelector("input:not(:disabled), select:not(:disabled)");
    if (nextInput) {
      nextInput.focus({ preventScroll: true });
      if (focusedSelection !== null && nextInput.tagName === "INPUT") nextInput.setSelectionRange(focusedSelection, focusedSelection);
    }
  }
}

function renderOtp(job) {
  const waiting = Object.values(job.portalStates || {}).filter((state) => state.status === "waiting_otp" || state.status === "waiting_input");
  const waitingApproval = Object.values(job.portalStates || {}).filter((state) => state.status === "waiting_approval");
  const waitingCaptcha = Object.values(job.portalStates || {}).filter((state) => state.status === "waiting_captcha");
  elements["otp-dock"].classList.add("hidden");
  elements["otp-count"].textContent = `${waiting.length} portal panelden bilgi bekliyor`;
  elements["otp-cards"].innerHTML = "";
  document.querySelectorAll(".otp-entry").forEach((form) => form.addEventListener("submit", submitInlineValue));
  document.querySelectorAll(".otp-resend").forEach((button) => button.addEventListener("click", requestResend));
  document.querySelectorAll(".approval-continue").forEach((button) => button.addEventListener("click", approvePortal));
  document.querySelectorAll(".captcha-continue").forEach((button) => button.addEventListener("click", continueCaptcha));
  document.querySelectorAll(".captcha-live-image").forEach((image) => image.addEventListener("click", forwardCaptchaClick));

  const waitingIds = new Set(waiting.map((state) => state.portalId));
  const announceIds = new Set([...waitingIds, ...waitingApproval.map((state) => state.portalId), ...waitingCaptcha.map((state) => state.portalId)]);
  for (const portalId of [...announcedOtpPortals]) {
    if (!announceIds.has(portalId)) announcedOtpPortals.delete(portalId);
  }
  for (const portalId of [...otpSubmissionState.keys()]) {
    if (!waitingIds.has(portalId)) otpSubmissionState.delete(portalId);
  }
  for (const portalId of [...otpErrorState.keys()]) {
    if (!waitingIds.has(portalId)) otpErrorState.delete(portalId);
  }
  const freshOtp = waiting.find((state) => !announcedOtpPortals.has(state.portalId))
    || waitingApproval.find((state) => !announcedOtpPortals.has(state.portalId))
    || waitingCaptcha.find((state) => !announcedOtpPortals.has(state.portalId));
  if (freshOtp) {
    announcedOtpPortals.add(freshOtp.portalId);
    window.requestAnimationFrame(() => {
      const form = [...document.querySelectorAll("#progress-list .otp-entry, #progress-list .approval-inline, #progress-list .captcha-inline")].find((item) => item.dataset.portalId === freshOtp.portalId);
      form?.scrollIntoView({ behavior: "smooth", block: "center" });
      form?.querySelector("input, select")?.focus({ preventScroll: true });
    });
  }
}

function formatTry(value) {
  return new Intl.NumberFormat("tr-TR", { style: "currency", currency: "TRY", minimumFractionDigits: 2 }).format(value);
}

// Şirket logoları: gerçek logo dosyaları için public/logos/<slug>.png bekleniyor
// (bu sanal ortamda dışa ağ erişimi olmadığından gerçek logo görselleri elle
// eklenmedi). Dosya yoksa <img onerror> tetiklenip yerine renkli baş harf
// rozeti gösteriliyor; ileride gerçek logo dosyaları buraya eklenirse
// otomatik olarak kullanılır.
const COMPANY_LOGO_SLUGS = {
  "AKSİGORTA": "aksigorta", "ALLIANZ": "allianz", "ANADOLU SİGORTA": "anadolu",
  "ANKARA SİGORTA": "ankara", "ATLAS MUTUEL": "atlas", "AXA SİGORTA": "axa",
  "BEREKET SİGORTA": "bereket", "CORPUS SİGORTA": "corpus", "DOĞA SİGORTA": "doga",
  "ETHICA SİGORTA": "ethica", "EUREKO SİGORTA": "eureko", "GENERALI": "generali",
  "HDI SİGORTA": "hdi", "HEPİYİ SİGORTA": "hepiyi", "KORU SİGORTA": "koru",
  "MAGDEBURGER": "magdeburger", "MAPFRE SİGORTA": "mapfre", "NEOVA SİGORTA": "neova",
  "ORİENT SİGORTA": "orient", "QUICK SİGORTA": "quick", "RAY SİGORTA": "ray",
  "SOMPO SİGORTA": "sompo", "TÜRK NİPPON": "turknippon", "TÜRKİYE SİGORTA": "turkiye",
  "UNICO SİGORTA": "unico", "ZURICH SİGORTA": "zurich",
};

function companyLogoSlug(company) {
  return COMPANY_LOGO_SLUGS[company] || String(company).toLocaleLowerCase("tr").replace(/[^a-z0-9]+/g, "");
}

function companyInitials(company) {
  const words = String(company).replace(/SİGORTA|SIGORTA/gi, "").trim().split(/\s+/).filter(Boolean);
  return (words.slice(0, 2).map((word) => word[0]).join("") || String(company)[0] || "?").toUpperCase();
}

function companyLogoColor(company) {
  let hash = 0;
  for (const character of String(company)) hash = (hash * 31 + character.charCodeAt(0)) >>> 0;
  return `hsl(${hash % 360} 55% 40%)`;
}

function companyLogoHtml(company) {
  const slug = escapeHtml(companyLogoSlug(company));
  const initials = escapeHtml(companyInitials(company));
  const color = companyLogoColor(company);
  return `<span class="company-logo" data-fallback="${initials}" style="background:${color}"><img src="/logos/${slug}.png" alt="" loading="lazy" onerror="this.style.display='none';this.parentElement.classList.add('logo-fallback')" /></span>`;
}

function renderResults(job) {
  const rows = job.summary || [];
  if (!rows.length && job.status !== "completed") return;
  elements.results.classList.remove("hidden");
  elements["result-count"].textContent = `${rows.length} şirket`;
  const currentCompanies = new Set(rows.map((row) => row.company));
  for (const company of [...expandedResultCompanies]) {
    if (!currentCompanies.has(company)) expandedResultCompanies.delete(company);
  }
  elements["results-body"].innerHTML = rows.length ? rows.map((row, index) => {
    const sorted = [...row.sources].sort((a, b) => a.price - b.price);
    const best = sorted[0] || row.sources[0];
    const company = escapeHtml(row.company);
    const expandable = row.sources.length > 1;
    const expanded = expandable && expandedResultCompanies.has(row.company);
    const toggleLabel = expandable ? `${row.sources.length} portal <span class="result-caret">${expanded ? "▴" : "▾"}</span>` : `${row.sources.length} portal`;
    const detailRows = sorted.map((source) => `
      <tr class="result-detail-row">
        <td></td>
        <td>${escapeHtml(source.sourcePortal)}</td>
        <td class="price">${formatTry(source.price)}</td>
        <td>${source.installments ? escapeHtml(source.installments) : ""}</td>
        <td colspan="2">${source.capturedAt ? relativeTime(source.capturedAt) : ""}</td>
      </tr>`).join("");
    return `
      <tr class="result-row ${expandable ? "expandable" : ""}" data-company="${company}">
        <td>${index + 1}</td><td><div class="company-cell">${companyLogoHtml(row.company)}<strong>${company}</strong></div></td><td class="price">${formatTry(row.bestPrice)}</td><td class="installments">${best.installments ? escapeHtml(best.installments) : "<span class=\"muted\">—</span>"}</td><td>${escapeHtml(best.sourcePortal)}</td><td class="result-toggle">${toggleLabel}</td>
      </tr>
      ${expandable ? `<tr class="result-detail-wrap ${expanded ? "" : "hidden"}" data-company-detail="${company}"><td colspan="6"><table class="result-detail-table"><tbody>${detailRows}</tbody></table></td></tr>` : ""}`;
  }).join("") : `<tr><td colspan="6">Henüz fiyat teklifi alınamadı. Portal durumlarını kontrol edin.</td></tr>`;
}

function toggleResultDetail(event) {
  const row = event.currentTarget;
  if (!row.classList.contains("expandable")) return;
  const company = row.dataset.company;
  const detail = elements["results-body"].querySelector(`.result-detail-wrap[data-company-detail="${CSS.escape(company)}"]`);
  if (!detail) return;
  if (expandedResultCompanies.has(company)) {
    expandedResultCompanies.delete(company);
    detail.classList.add("hidden");
  } else {
    expandedResultCompanies.add(company);
    detail.classList.remove("hidden");
  }
  const caret = row.querySelector(".result-caret");
  if (caret) caret.textContent = expandedResultCompanies.has(company) ? "▴" : "▾";
}

function showInlineError(form, portalId, message) {
  otpErrorState.set(portalId, message);
  let errorEl = form.querySelector(".otp-inline-error");
  if (!errorEl) {
    errorEl = document.createElement("p");
    errorEl.className = "otp-inline-error";
    form.appendChild(errorEl);
  }
  errorEl.textContent = message;
}

async function submitInlineValue(event) {
  event.preventDefault();
  const form = event.currentTarget;
  const input = form.querySelector("input, select");
  const button = form.querySelector("button[type=submit]");
  const portalId = form.dataset.portalId;
  const inputId = form.dataset.inputId || "otp";
  const isOtp = inputId === "otp";
  const value = input.value.trim();
  if (isOtp && !/^\d{4,8}$/.test(value)) return showInlineError(form, portalId, "SMS kodu 4-8 rakam olmalıdır.");
  if (!isOtp && !value) return showInlineError(form, portalId, "Bir değer girin.");
  otpErrorState.delete(portalId);
  form.querySelector(".otp-inline-error")?.remove();
  otpSubmissionState.set(portalId, "sending");
  button.disabled = true;
  input.disabled = true;
  button.textContent = "Gönderiliyor…";
  try {
    const url = isOtp ? `/api/jobs/${activeJobId}/otp/${portalId}` : `/api/jobs/${activeJobId}/input/${portalId}/${encodeURIComponent(inputId)}`;
    const payload = isOtp ? { code: value } : { value };
    const response = await fetch(url, {
      method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(payload)
    });
    const body = await response.json();
    if (!response.ok) throw new Error(body.error || "Gönderilemedi");
    otpSubmissionState.set(portalId, "sent");
    button.textContent = "Gönderildi";
    await pollJob();
  } catch (error) {
    otpSubmissionState.delete(portalId);
    button.disabled = false;
    input.disabled = false;
    button.textContent = isOtp ? "Kodu doğrula" : "Gönder";
    showInlineError(form, portalId, error.message);
  }
}

async function requestResend(event) {
  const button = event.currentTarget;
  const portalId = button.dataset.portalId;
  const original = button.textContent;
  button.disabled = true;
  button.textContent = "Gönderiliyor…";
  try {
    const response = await fetch(`/api/jobs/${activeJobId}/resend/${portalId}`, { method: "POST" });
    const body = await response.json();
    if (!response.ok) throw new Error(body.error || "Gönderilemedi");
    button.textContent = "Yeni kod istendi";
  } catch (error) {
    const form = button.closest(".otp-inline");
    if (form) showInlineError(form, portalId, error.message);
    button.textContent = original;
  } finally {
    window.setTimeout(() => { button.disabled = false; if (button.textContent !== original) button.textContent = original; }, 3000);
  }
}

async function approvePortal(event) {
  const button = event.currentTarget;
  const portalId = button.dataset.portalId;
  button.disabled = true;
  button.textContent = "Devam ediliyor…";
  try {
    const response = await fetch(`/api/jobs/${activeJobId}/approve/${portalId}`, { method: "POST" });
    const body = await response.json();
    if (!response.ok) throw new Error(body.error || "Onaylanamadı");
    await pollJob();
  } catch (error) {
    showError(error.message);
    button.disabled = false;
    button.textContent = "Devam Et";
  }
}

const CAPTCHA_VIEWPORT = { width: 1440, height: 1000 };

async function forwardCaptchaClick(event) {
  const image = event.currentTarget;
  const portalId = image.dataset.portalId;
  const rect = image.getBoundingClientRect();
  const x = Math.round(((event.clientX - rect.left) / rect.width) * CAPTCHA_VIEWPORT.width);
  const y = Math.round(((event.clientY - rect.top) / rect.height) * CAPTCHA_VIEWPORT.height);
  image.classList.add("captcha-live-busy");
  try {
    const response = await fetch(`/api/jobs/${activeJobId}/captcha/${portalId}/click`, {
      method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ x, y })
    });
    if (!response.ok) {
      const body = await response.json().catch(() => ({}));
      throw new Error(body.error || "Tıklama iletilemedi");
    }
    image.src = `/api/jobs/${activeJobId}/captcha/${portalId}/live?t=${Date.now()}`;
  } catch (error) {
    showError(error.message);
  } finally {
    image.classList.remove("captcha-live-busy");
  }
}

async function continueCaptcha(event) {
  const button = event.currentTarget;
  const portalId = button.dataset.portalId;
  button.disabled = true;
  button.textContent = "Devam ediliyor…";
  try {
    const response = await fetch(`/api/jobs/${activeJobId}/captcha/${portalId}/continue`, { method: "POST" });
    const body = await response.json();
    if (!response.ok) throw new Error(body.error || "Devam edilemedi");
    await pollJob();
  } catch (error) {
    showError(error.message);
    button.disabled = false;
    button.textContent = "Devam Et, çözdüm";
  }
}

async function pollJob() {
  if (!activeJobId) return;
  try {
    const job = await fetchJson(`/api/jobs/${activeJobId}`, {}, 10000);
    renderProgress(job);
    renderOtp(job);
    renderResults(job);
    updateJobLog(job);
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
      body: JSON.stringify({ vehicle, mode, phone: phoneDigits(), email: elements.email.value.trim(), portalIds, customerConsent: true })
    }, 15000);
    rememberActiveJob(body.id);
    renderProgress(body);
    updateJobLog(body);
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
    if (portalData.defaultEmail) elements.email.value = portalData.defaultEmail;
    portals = portalData.portals;
    elements["max-concurrency"].textContent = `İhsan: ${portalData.maxConcurrency} · Diğer: ${portalData.genericConcurrency} eşzamanlı`;
    elements["concurrency-stat"].textContent = portalData.maxConcurrency + portalData.genericConcurrency;
    renderPortals();
    const lastChecked = portals.map((portal) => portal.sessionCheckedAt).filter(Boolean).sort().at(-1);
    if (lastChecked) {
      const onCount = portals.filter((portal) => portal.sessionLoggedIn === true).length;
      const sessionPortalCount = portals.filter((portal) => portal.smsPolicy === "session_once").length;
      elements["session-check-status"].classList.remove("hidden");
      elements["session-check-status"].textContent = `Son kontrol: ${new Date(lastChecked).toLocaleTimeString("tr-TR")} · ${onCount}/${sessionPortalCount} oturum açık`;
    }

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
      updateJobLog(resumable);
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
elements["cancel-button"].addEventListener("click", async () => {
  if (!activeJobId) return;
  elements["cancel-button"].disabled = true;
  elements["cancel-button"].textContent = "İptal ediliyor…";
  try {
    await fetchJson(`/api/jobs/${activeJobId}/cancel`, { method: "POST" }, 10000);
    await pollJob();
  } catch (error) {
    elements["cancel-button"].disabled = false;
    elements["cancel-button"].textContent = "Sorguyu durdur";
    showError(error.message);
  }
});
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
document.getElementById("reset-sessions").addEventListener("click", async (event) => {
  const button = event.currentTarget;
  const original = button.textContent;
  button.disabled = true;
  button.textContent = "Sıfırlanıyor…";
  try {
    await fetchJson("/api/portals/reset-sessions", { method: "POST" }, 20000);
    button.textContent = "Sıfırlandı ✓";
  } catch (error) {
    showError(error.message);
    button.textContent = original;
  } finally {
    window.setTimeout(() => { button.disabled = false; button.textContent = original; }, 2500);
  }
});

document.getElementById("check-sessions").addEventListener("click", async (event) => {
  const button = event.currentTarget;
  const original = button.textContent;
  button.disabled = true;
  button.textContent = "Oturumlar kontrol ediliyor…";
  elements["session-check-status"].classList.remove("hidden");
  elements["session-check-status"].textContent = "Kontrol ediliyor, birkaç dakika sürebilir…";
  try {
    const body = await fetchJson("/api/sessions/check", { method: "POST" }, 120000);
    portals = body.portals;
    renderPortals({ preserveSelection: true });
    const checkedAt = new Date().toLocaleTimeString("tr-TR");
    const onCount = portals.filter((portal) => portal.sessionLoggedIn === true).length;
    const sessionPortalCount = portals.filter((portal) => portal.smsPolicy === "session_once").length;
    elements["session-check-status"].textContent = `Son kontrol: ${checkedAt} · ${onCount}/${sessionPortalCount} oturum açık`;
  } catch (error) {
    showError(error.message);
    elements["session-check-status"].textContent = `Kontrol başarısız: ${error.message}`;
  } finally {
    button.disabled = false;
    button.textContent = original;
  }
});

// "Oturum Aç": kullanıcının sorgu öncesinde İhsan altyapılı portallara
// sağ üstten "Hesap" ile kalıcı olarak giriş yapmasını sağlar. Portallar
// sırayla açılır; canlı ekrana tıklama CAPTCHA panelindeki mekanizmayla
// aynı ölçeklemeyi kullanır, ayrıca kullanıcı adı/şifre yazmak için metin
// ve tuş iletimi de eklenir.
function stopOpenSessionPolling() {
  if (openSessionPollTimer) { window.clearInterval(openSessionPollTimer); openSessionPollTimer = null; }
}

function renderOpenSessionQueue(currentPortalId) {
  elements["open-session-queue"].innerHTML = openSessionQueue.map((portalId) => {
    const portal = portals.find((item) => item.id === portalId);
    const name = escapeHtml(portal?.name || portalId);
    const state = portalId === currentPortalId ? "active" : (openSessionQueue.indexOf(portalId) < openSessionIndex ? "done" : "pending");
    return `<span class="open-session-chip" data-state="${state}">${name}</span>`;
  }).join("");
}

async function pollOpenSessionStatus(portalId) {
  try {
    const status = await fetchJson(`/api/portals/${encodeURIComponent(portalId)}/session-open/status`, {}, 8000);
    elements["open-session-status"].textContent = status.message || status.status;
    if (status.status === "ready" || status.status === "opening") {
      elements["open-session-live-image"].src = `/api/portals/${encodeURIComponent(portalId)}/session-open/live?t=${Date.now()}`;
    }
    if (status.status === "closed" || status.status === "error") {
      stopOpenSessionPolling();
      if (status.status === "error") showError(`Oturum açma hatası: ${status.message}`);
      await advanceOpenSessionQueue();
    }
  } catch (error) {
    // Geçici ağ hatası; bir sonraki pollde tekrar denenecek.
  }
}

async function startCurrentOpenSession() {
  const portalId = openSessionQueue[openSessionIndex];
  const portal = portals.find((item) => item.id === portalId);
  elements["open-session-title"].textContent = `${portal?.name || portalId} — oturum açılıyor`;
  elements["open-session-status"].textContent = "Portal açılıyor…";
  elements["open-session-live-image"].removeAttribute("src");
  renderOpenSessionQueue(portalId);
  try {
    await fetchJson(`/api/portals/${encodeURIComponent(portalId)}/session-open/start`, { method: "POST" }, 15000);
    stopOpenSessionPolling();
    openSessionPollTimer = window.setInterval(() => pollOpenSessionStatus(portalId), 900);
    await pollOpenSessionStatus(portalId);
  } catch (error) {
    showError(`${portal?.name || portalId}: ${error.message}`);
    await advanceOpenSessionQueue();
  }
}

async function advanceOpenSessionQueue() {
  openSessionIndex += 1;
  if (openSessionIndex >= openSessionQueue.length) {
    stopOpenSessionPolling();
    elements["open-session-panel"].classList.add("hidden");
    openSessionQueue = [];
    openSessionIndex = -1;
    try {
      const body = await fetchJson("/api/sessions/check", { method: "POST" }, 120000);
      portals = body.portals;
      renderPortals({ preserveSelection: true });
    } catch {}
    return;
  }
  await startCurrentOpenSession();
}

document.getElementById("open-sessions").addEventListener("click", () => {
  const candidates = portals.filter((portal) => portal.smsPolicy === "session_once" && (portal.available ?? portal.enabled));
  const selectedIds = new Set(selectedPortalIds());
  const targeted = candidates.filter((portal) => selectedIds.has(portal.id));
  openSessionQueue = (targeted.length ? targeted : candidates).map((portal) => portal.id);
  if (!openSessionQueue.length) return showError("Oturum açılabilecek portal bulunamadı.");
  openSessionIndex = -1;
  elements["open-session-panel"].classList.remove("hidden");
  elements["open-session-panel"].scrollIntoView({ behavior: "smooth", block: "start" });
  advanceOpenSessionQueue();
});

elements["open-session-live-image"].addEventListener("click", async (event) => {
  const portalId = openSessionQueue[openSessionIndex];
  if (!portalId) return;
  const rect = event.currentTarget.getBoundingClientRect();
  const x = Math.round(((event.clientX - rect.left) / rect.width) * CAPTCHA_VIEWPORT.width);
  const y = Math.round(((event.clientY - rect.top) / rect.height) * CAPTCHA_VIEWPORT.height);
  try {
    await fetchJson(`/api/portals/${encodeURIComponent(portalId)}/session-open/click`, {
      method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ x, y })
    }, 8000);
    elements["open-session-live-image"].src = `/api/portals/${encodeURIComponent(portalId)}/session-open/live?t=${Date.now()}`;
  } catch (error) { showError(error.message); }
});

async function sendOpenSessionText() {
  const portalId = openSessionQueue[openSessionIndex];
  const input = elements["open-session-type-input"];
  if (!portalId || !input.value) return;
  try {
    await fetchJson(`/api/portals/${encodeURIComponent(portalId)}/session-open/type`, {
      method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ text: input.value })
    }, 8000);
    input.value = "";
    input.focus();
  } catch (error) { showError(error.message); }
}

async function sendOpenSessionKey(key) {
  const portalId = openSessionQueue[openSessionIndex];
  if (!portalId) return;
  try {
    await fetchJson(`/api/portals/${encodeURIComponent(portalId)}/session-open/key`, {
      method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ key })
    }, 8000);
  } catch (error) { showError(error.message); }
}

elements["open-session-type-send"].addEventListener("click", sendOpenSessionText);
elements["open-session-type-input"].addEventListener("keydown", (event) => {
  if (event.key === "Enter") { event.preventDefault(); sendOpenSessionText(); }
});
elements["open-session-key-enter"].addEventListener("click", () => sendOpenSessionKey("Enter"));
elements["open-session-key-tab"].addEventListener("click", () => sendOpenSessionKey("Tab"));
elements["open-session-key-backspace"].addEventListener("click", () => sendOpenSessionKey("Backspace"));

elements["open-session-finish"].addEventListener("click", async () => {
  const portalId = openSessionQueue[openSessionIndex];
  if (!portalId) return;
  try {
    await fetchJson(`/api/portals/${encodeURIComponent(portalId)}/session-open/finish`, { method: "POST" }, 8000);
  } catch (error) { showError(error.message); }
});

elements["open-session-cancel"].addEventListener("click", async () => {
  const portalId = openSessionQueue[openSessionIndex];
  stopOpenSessionPolling();
  if (portalId) {
    try { await fetchJson(`/api/portals/${encodeURIComponent(portalId)}/session-open/finish`, { method: "POST" }, 8000); } catch {}
  }
  elements["open-session-panel"].classList.add("hidden");
  openSessionQueue = [];
  openSessionIndex = -1;
});

document.getElementById("ruhsat-photo").addEventListener("change", async (event) => {
  const file = event.target.files?.[0];
  const statusEl = document.getElementById("ruhsat-scan-status");
  if (!file) return;
  statusEl.classList.remove("hidden");
  statusEl.textContent = "Görsel işleniyor…";
  try {
    if ("BarcodeDetector" in window) {
      const bitmap = await createImageBitmap(file);
      const detector = new window.BarcodeDetector({ formats: ["qr_code"] });
      const codes = await detector.detect(bitmap);
      if (codes.length && codes[0].rawValue) {
        const raw = codes[0].rawValue;
        elements["raw-data"].value = raw;
        setParsed(parseVehicleData(raw));
        statusEl.textContent = `QR okundu: ${raw.slice(0, 90)}${raw.length > 90 ? "…" : ""}`;
        return;
      }
    }
    statusEl.textContent = "QR kod bulunamadı. Bu ortamda fotoğraftan otomatik metin okuma (OCR) yapılandırılmadı; bilgileri elle girin.";
  } catch (error) {
    statusEl.textContent = `Görsel işlenemedi: ${error.message}`;
    logTechError("Ruhsat görseli işleme", error);
  } finally {
    event.target.value = "";
  }
});

elements["results-body"].addEventListener("click", (event) => {
  const row = event.target.closest(".result-row");
  if (row) toggleResultDetail({ currentTarget: row });
});

boot();
