import { chmod, mkdir, readdir, readFile, rename, unlink, writeFile } from "node:fs/promises";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { summarizeResults } from "./results.mjs";

const ACTIVE_STATES = new Set(["queued", "running", "waiting_otp", "cancelling"]);

export function publicJob(job) {
  return {
    id: job.id,
    createdAt: job.createdAt,
    updatedAt: job.updatedAt,
    startedAt: job.startedAt || null,
    finishedAt: job.finishedAt || null,
    status: job.status,
    mode: job.mode,
    phone: job.phone,
    vehicle: job.vehicle,
    portalStates: job.portalStates,
    results: job.results || [],
    summary: summarizeResults(job.results || []),
    failure: job.failure || null,
  };
}

async function atomicJsonWrite(file, value) {
  const temporary = `${file}.${randomUUID()}.tmp`;
  await writeFile(temporary, `${JSON.stringify(value, null, 2)}\n`, { encoding: "utf8", mode: 0o600 });
  await rename(temporary, file);
  await chmod(file, 0o600).catch(() => {});
}

export class FileStore {
  #jobs = new Map();

  constructor({ jobsDir, settingsFile, retentionDays = 30 }) {
    this.jobsDir = jobsDir;
    this.settingsFile = settingsFile;
    this.retentionDays = retentionDays;
  }

  async init() {
    await mkdir(this.jobsDir, { recursive: true, mode: 0o700 });
    const files = (await readdir(this.jobsDir).catch(() => [])).filter((name) => name.endsWith(".json")).sort();
    for (const file of files.slice(-250)) {
      try {
        const job = JSON.parse(await readFile(path.join(this.jobsDir, file), "utf8"));
        if (ACTIVE_STATES.has(job.status)) {
          job.status = "interrupted";
          job.finishedAt = new Date().toISOString();
          job.failure = "Sunucu yeniden başladığı için sorgu güvenli şekilde durduruldu";
          for (const state of Object.values(job.portalStates || {})) {
            if (!isPortalTerminal(state.status)) {
              state.status = "interrupted";
              state.message = "Sunucu yeniden başladı";
              state.updatedAt = job.finishedAt;
            }
          }
          await this.saveJob(job);
        }
        this.#jobs.set(job.id, job);
      } catch (error) {
        console.error(`[store] ${file} okunamadı: ${error.message}`);
      }
    }
    await this.cleanup();
  }

  getJob(id) {
    return this.#jobs.get(id) || null;
  }

  putJob(job) {
    this.#jobs.set(job.id, job);
    return job;
  }

  listJobs(limit = 30) {
    return [...this.#jobs.values()]
      .sort((a, b) => String(b.createdAt).localeCompare(String(a.createdAt)))
      .slice(0, limit);
  }

  async saveJob(job) {
    job.updatedAt = new Date().toISOString();
    this.#jobs.set(job.id, job);
    await atomicJsonWrite(path.join(this.jobsDir, `${job.id}.json`), publicJob(job));
  }

  async getPortalSettings() {
    try {
      return JSON.parse(await readFile(this.settingsFile, "utf8"));
    } catch {
      return {};
    }
  }

  async savePortalSettings(settings) {
    await mkdir(path.dirname(this.settingsFile), { recursive: true, mode: 0o700 });
    await atomicJsonWrite(this.settingsFile, settings);
  }

  async cleanup() {
    const cutoff = Date.now() - this.retentionDays * 86400000;
    for (const [id, job] of this.#jobs) {
      const timestamp = Date.parse(job.createdAt || "");
      if (!Number.isFinite(timestamp) || timestamp >= cutoff || ACTIVE_STATES.has(job.status)) continue;
      this.#jobs.delete(id);
      await unlink(path.join(this.jobsDir, `${id}.json`)).catch(() => {});
    }
  }
}

export function isPortalTerminal(status) {
  return [
    "completed", "no_offer", "skipped_sms", "mapping_required", "auth_required", "manual_required",
    "rate_limited", "timeout", "error", "cancelled", "interrupted",
  ].includes(status);
}
