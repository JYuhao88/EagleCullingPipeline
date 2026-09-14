import { mkdir, rename, writeFile } from "node:fs/promises";
import path from "node:path";

const INVENTORY_FIELDS = [
  "id",
  "name",
  "ext",
  "width",
  "height",
  "size",
  "tags",
  "folders",
  "star",
  "annotation",
  "modificationTime",
  "isDeleted",
];

export async function collectInventory(api) {
  const items = [];
  // Build 23 currently returns HTTP 500 for the optional `fields` query
  // parameter, so request the stable full item shape and retain only the
  // fields needed by the inventory schema.
  for await (const item of api.items()) {
    items.push(Object.fromEntries(INVENTORY_FIELDS.map((field) => [field, item[field]])));
  }
  return {
    schemaVersion: 1,
    generatedAt: new Date().toISOString(),
    itemCount: items.length,
    items,
  };
}

export async function writeInventoryAtomic(inventory, outputPath) {
  await mkdir(path.dirname(outputPath), { recursive: true });
  const temporaryPath = `${outputPath}.tmp`;
  await writeFile(temporaryPath, `${JSON.stringify(inventory, null, 2)}\n`, "utf8");
  await rename(temporaryPath, outputPath);
}

export { INVENTORY_FIELDS };
