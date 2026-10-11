import { createReadStream } from 'node:fs';
import { mkdir, open, truncate } from 'node:fs/promises';
import { createInterface } from 'node:readline';
import path from 'node:path';

// Index only offsets, never retain model payloads. A torn final append is
// discarded on restart; malformed committed lines remain an explicit error.
export class OffsetJournal {
  constructor(file, key = row => row.key, { repairTail = true } = {}) {
    this.file = file;
    this.key = key;
    this.repairTail = repairTail;
    this.index = new Map();
    this.offset = 0;
    this.pending = Promise.resolve();
    this.ready = this.load();
  }
  async load() {
    await mkdir(path.dirname(this.file), { recursive: true });
    let pending = null;
    try {
      for await (const line of createInterface({ input: createReadStream(this.file), crlfDelay: Infinity })) {
        if (pending !== null) this.record(pending);
        pending = line;
      }
      if (pending !== null) {
        const handle = await open(this.file, 'r');
        const info = await handle.stat();
        const last = Buffer.alloc(1);
        await handle.read(last, 0, 1, info.size - 1);
        await handle.close();
        if (last[0] === 10) this.record(pending);
        else if (this.repairTail) await truncate(this.file, this.offset);
      }
    } catch (error) { if (error.code !== 'ENOENT') throw error; }
  }
  record(line) {
    const length = Buffer.byteLength(line) + 1;
    const row = JSON.parse(line);
    this.index.set(this.key(row), [this.offset, length]);
    this.offset += length;
  }
  async get(key) {
    await this.ready;
    await this.pending;
    const location = this.index.get(key);
    if (!location) return null;
    const handle = await open(this.file, 'r');
    try {
      const bytes = Buffer.alloc(location[1]);
      const { bytesRead } = await handle.read(bytes, 0, bytes.length, location[0]);
      if (bytesRead !== bytes.length) throw new Error('Truncated journal');
      return JSON.parse(bytes.toString('utf8'));
    } finally { await handle.close(); }
  }
  async put(row) {
    await this.ready;
    const operation = this.pending.then(async () => {
      const bytes = Buffer.from(JSON.stringify(row) + '\n');
      const handle = await open(this.file, 'a');
      try { await handle.writeFile(bytes); } finally { await handle.close(); }
      this.index.set(this.key(row), [this.offset, bytes.length]);
      this.offset += bytes.length;
    });
    this.pending = operation.catch(() => {});
    await operation;
  }
}
