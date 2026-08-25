import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";

test("başarısız portal kartı kayıtlı ekran görüntüsünü açar", async () => {
  const source = await readFile(new URL("../public/app.js", import.meta.url), "utf8");
  assert.match(source, /state\.hasScreenshot/);
  assert.match(source, /\/api\/jobs\/\$\{encodeURIComponent\(activeJobId \|\| job\.id\)\}\/screenshot\//);
  assert.match(source, /Hata ekranını gör/);
});
