import { replaceFile } from './atomic-file.js';
import path from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import { mkdir, readFile, readdir, writeFile } from 'node:fs/promises';
import { OffsetJournal } from './offset-journal.js';
export class ResultsStore {
  constructor(root = 'data/cache') {
    this.root = path.resolve(root);
    this.file = path.join(this.root, 'results.jsonl');
    // Shared legacy cache is read-only: another service may be appending it.
    this.journal = new OffsetJournal(this.file, row => row.fingerprint, { repairTail: false });
    this.ready = this.journal.ready;
  }
  key(fingerprint) { return createHash('sha256').update(fingerprint).digest('hex'); }
  location(fingerprint) {
    const key = this.key(fingerprint);
    return path.join(this.root, 'results-v2', key.slice(0, 2), `${key}.json`);
  }
  async get(fingerprint) {
    try { return JSON.parse(await readFile(this.location(fingerprint), 'utf8')).result; }
    catch (error) { if (error.code !== 'ENOENT') throw error; }
    return (await this.journal.get(fingerprint))?.result || null;
  }
  async put(fingerprint, result) {
    const file = this.location(fingerprint);
    await mkdir(path.dirname(file), { recursive: true });
    const temporary = `${file}.${randomUUID()}.tmp`;
    await writeFile(temporary, JSON.stringify({ fingerprint, result }));
    await replaceFile(temporary, file);
    return result;
  }
  async size() {
    await this.ready;
    const keys = new Set([...this.journal.index.keys()].map(key => this.key(key)));
    try {
      for (const directory of await readdir(path.join(this.root, 'results-v2'), { withFileTypes: true })) {
        if (!directory.isDirectory()) continue;
        for (const name of await readdir(path.join(this.root, 'results-v2', directory.name))) {
          if (/^[a-f0-9]{64}\.json$/.test(name)) keys.add(name.slice(0, -5));
        }
      }
    } catch (error) { if (error.code !== 'ENOENT') throw error; }
    return keys.size;
  }
}
