import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";

const engineSource = await readFile(new URL("../src/engine.mjs", import.meta.url), "utf8");
const panelSource = await readFile(new URL("../public/app.js", import.meta.url), "utf8");
const htmlSource = await readFile(new URL("../public/index.html", import.meta.url), "utf8");

test("İhsan ve genel portallar ayrı havuzlarda paralel çalışır", () => {
  assert.match(engineSource, /runPool\(ihsanPortals, this\.config\.maxConcurrency, execute\)/);
  assert.match(engineSource, /runPool\(genericPortals, this\.config\.genericConcurrency, execute\)/);
  assert.match(engineSource, /await Promise\.all\(\[/);
  assert.doesNotMatch(engineSource, /for \(const portal of selected\)/);
});

test("normal sorgu aşamaları manuel devam onayı beklemez", () => {
  assert.doesNotMatch(engineSource, /STEP_GATE_STATUSES/);
  assert.doesNotMatch(engineSource, /#waitForStepContinue/);
  assert.doesNotMatch(engineSource, /#waitForApproval/);
  assert.doesNotMatch(panelSource, /awaiting_continue|waiting_approval/);
  assert.doesNotMatch(htmlSource, /portal tek tek|Sıralı/);
});

