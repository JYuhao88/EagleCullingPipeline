import { requireLocalSetting } from '../src/core/local-config.js';
import crypto from "node:crypto";
import { readFile, readdir } from "node:fs/promises";
import path from "node:path";

const library = process.argv[2] || requireLocalSetting('EAGLE_LIBRARY_PATH');
const manifest = JSON.parse(await readFile("exports/mac-fixture-v2/manifest.json", "utf8"));
const files = new Map();
for (const directory of await readdir(path.join(library, "images"), { withFileTypes: true })) {
  if (!directory.name.endsWith(".info")) continue;
  const info = path.join(library, "images", directory.name);
  for (const file of await readdir(info)) {
    const match = file.match(/^(.*)\.([^.]+)$/);
    if (match) files.set(`${match[1]}|${match[2].toLowerCase()}`, path.join(info, file));
  }
}
let matched = 0;
let mismatched = 0;
for (const item of manifest.items) {
  const file = files.get(`${item.name}|${item.ext.toLowerCase()}`);
  if (!file) { mismatched += 1; continue; }
  const hash = crypto.createHash("sha256");
  const data = await readFile(file);
  hash.update(data);
  if (hash.digest("hex") === item.sha256) matched += 1;
  else mismatched += 1;
}
console.log(JSON.stringify({ matched, mismatched, total: manifest.items.length }, null, 2));
