import { open, stat } from 'node:fs/promises';
// Read append-only QA evidence incrementally. The simulator and service share a
// Node process: reparsing the entire growing log per action adds artificial GC.
export function createEventReader(file) {
  let rows = [], offset = 0, inode, pending = Buffer.alloc(0), tail = Promise.resolve();
  return () => {
    const operation = tail.then(async () => {
      const metadata = await stat(file);
      if (inode !== metadata.ino || metadata.size < offset) {
        rows = []; offset = 0; pending = Buffer.alloc(0); inode = metadata.ino;
      }
      if (metadata.size > offset) {
        const handle = await open(file, 'r');
        const bytes = Buffer.alloc(metadata.size - offset);
        try {
          let read = 0;
          while (read < bytes.length) {
            const chunk = await handle.read(bytes, read, bytes.length - read, offset + read);
            if (!chunk.bytesRead) throw new Error('QA event log truncated during read');
            read += chunk.bytesRead;
          }
        } finally { await handle.close(); }
        const buffer = Buffer.concat([pending, bytes]), last = buffer.lastIndexOf(10);
        if (last >= 0) rows.push(...buffer.subarray(0, last).toString('utf8').split('\n').filter(Boolean).map(JSON.parse));
        pending = buffer.subarray(last + 1); offset = metadata.size;
      }
      return [...rows];
    });
    tail = operation.catch(() => {}); return operation;
  };
}
