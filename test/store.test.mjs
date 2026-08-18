import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { FileStore } from "../src/lib/store.mjs";

test("işi atomik olarak kaydeder ve yeniden açar", async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), "unal-store-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const jobsDir = path.join(root, "jobs");
  const settingsFile = path.join(root, "portal-settings.json");
  const store = new FileStore({ jobsDir, settingsFile, retentionDays: 30 });
  await store.init();
  const now = new Date().toISOString();
  const job = { id: "job-1", createdAt: now, updatedAt: now, status: "completed", mode: "no_sms", phone: "05454012962", vehicle: {}, portalStates: {}, results: [] };
  store.putJob(job);
  await store.saveJob(job);
  assert.equal(JSON.parse(await readFile(path.join(jobsDir, "job-1.json"), "utf8")).id, "job-1");

  const reopened = new FileStore({ jobsDir, settingsFile, retentionDays: 30 });
  await reopened.init();
  assert.equal(reopened.getJob("job-1").status, "completed");
});

test("sunucu yeniden başladığında çalışan işi interrupted yapar", async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), "unal-recovery-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const options = { jobsDir: path.join(root, "jobs"), settingsFile: path.join(root, "settings.json"), retentionDays: 30 };
  const first = new FileStore(options);
  await first.init();
  const now = new Date().toISOString();
  await first.saveJob({ id: "running-1", createdAt: now, updatedAt: now, status: "running", mode: "no_sms", phone: "", vehicle: {}, results: [], portalStates: { a: { status: "opening" } } });
  const second = new FileStore(options);
  await second.init();
  assert.equal(second.getJob("running-1").status, "interrupted");
  assert.equal(second.getJob("running-1").portalStates.a.status, "interrupted");
});
