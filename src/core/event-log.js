import { randomUUID } from 'node:crypto';
import { appendFile, mkdir, readFile, stat } from 'node:fs/promises';
import path from 'node:path';

export const EVENT_SCHEMA_VERSION = 1;
export class EventLog {
  constructor(root = 'data/learning') {
    this.file = path.join(root, 'events', 'v1', 'events.jsonl'); this.queue = Promise.resolve();
    this.cached = null; this.cachedSize = null; this.cachedMtime = null;
  }
  append(event) {
    const operation = this.queue.then(async () => {
      const row = { ...event, schemaVersion: EVENT_SCHEMA_VERSION,
        id: event.id || randomUUID(), timestamp: event.timestamp || new Date().toISOString(),
        timezone: event.timezone || Intl.DateTimeFormat().resolvedOptions().timeZone };
      await mkdir(path.dirname(this.file), { recursive: true });
      const line = `${JSON.stringify(row)}\n`;
      const before = await stat(this.file).catch(error => { if (error.code === 'ENOENT') return { size: 0, mtimeMs: null }; throw error; });
      await appendFile(this.file, line);
      const after = await stat(this.file);
      if (this.cached && this.cachedSize === before.size && this.cachedMtime === before.mtimeMs &&
        after.size === before.size + Buffer.byteLength(line)) {
        this.cached.push(row); this.cachedSize = after.size; this.cachedMtime = after.mtimeMs;
      } else this.cached = null;
      return row;
    });
    this.queue = operation.catch(() => {}); return operation;
  }
  async read() {
    await this.queue;
    try {
      const metadata = await stat(this.file);
      if (this.cached && this.cachedSize === metadata.size && this.cachedMtime === metadata.mtimeMs) return [...this.cached];
      const text = await readFile(this.file, 'utf8');
      const rows = text.split('\n').filter(Boolean).map(line => JSON.parse(line));
      this.cached = rows; this.cachedSize = metadata.size; this.cachedMtime = metadata.mtimeMs;
      return [...rows];
    } catch (error) { if (error.code === 'ENOENT') return []; throw error; }
  }
}
