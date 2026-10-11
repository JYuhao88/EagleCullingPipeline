import path from 'node:path';
import { OffsetJournal } from './offset-journal.js';
export class Checkpoints {
  constructor(directory) {
    this.journal = new OffsetJournal(path.join(directory, 'checkpoints.jsonl'));
  }
  async get(key) { return (await this.journal.get(key))?.value ?? null; }
  async put(key, value) { await this.journal.put({ key, value }); }
}
export function checkCancelled(signal) { signal?.throwIfAborted(); }
