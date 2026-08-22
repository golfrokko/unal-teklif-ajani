import { execFileSync } from "node:child_process";
import { readdirSync, statSync } from "node:fs";
import path from "node:path";

const roots = ["src", "public"];

function collectFiles(dir) {
  const entries = readdirSync(dir);
  let files = [];
  for (const entry of entries) {
    const fullPath = path.join(dir, entry);
    const stats = statSync(fullPath);
    if (stats.isDirectory()) files = files.concat(collectFiles(fullPath));
    else if (entry.endsWith(".mjs") || entry.endsWith(".js")) files.push(fullPath);
  }
  return files;
}

const files = roots.flatMap((root) => collectFiles(root));
let failed = false;
for (const file of files) {
  try {
    execFileSync(process.execPath, ["--check", file], { stdio: "pipe" });
  } catch (error) {
    failed = true;
    console.error(`✗ ${file}`);
    console.error(error.stderr?.toString() || error.message);
  }
}
if (failed) {
  process.exit(1);
} else {
  console.log(`${files.length} dosya sözdizimi kontrolünden geçti.`);
}
