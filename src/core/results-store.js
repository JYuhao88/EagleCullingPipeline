import { mkdir, appendFile, readFile } from "node:fs/promises";
import path from "node:path";
export class ResultsStore {
  constructor(root = "data/cache") {
    this.root = path.resolve(root);
    this.file = path.join(this.root, "results.jsonl");
    this.index = new Map();
    this.ready = this.load();
  }
  async load() {
    await mkdir(this.root, { recursive: true });
    try {
      for (const line of (await readFile(this.file, "utf8")).split("\n")) {
        if (!line.trim()) continue;
        const x = JSON.parse(line);
        if (x.fingerprint) this.index.set(x.fingerprint, x.result);
      }
    } catch (e) {
      if (e.code !== "ENOENT") throw e;
    }
  }
  async get(fingerprint) {
    await this.ready;
    return this.index.get(fingerprint);
  }
  async put(fingerprint, result) {
    await this.ready;
    const row = { fingerprint, result, storedAt: new Date().toISOString() };
    await appendFile(this.file, JSON.stringify(row) + "\n");
    this.index.set(fingerprint, result);
    return result;
  }
  async size() {
    await this.ready;
    return this.index.size;
  }
}
