import { performanceMode, performanceWorkerCap, nativeChildLaunch } from './performance-mode.js';
import { spawn } from 'node:child_process';
import os from 'node:os';
import path from 'node:path';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { localSetting } from './local-config.js';

export function workerLimit(name, fallback = 1) {
  const cap = performanceWorkerCap();
  const value = Number(localSetting(name, String(performanceMode() === 'turbo' ? cap : fallback)));
  return Math.max(1, Math.min(cap, Number.isSafeInteger(value) ? value : fallback));
}

function start(program, args) {
  const launch = nativeChildLaunch(program, args);
  const child = spawn(launch.command, launch.args, { windowsHide: true });
  if (process.platform === 'win32') child.once('spawn', () => {
    try { os.setPriority(child.pid, performanceMode() === 'turbo' ? os.constants.priority.PRIORITY_NORMAL
      : os.constants.priority.PRIORITY_BELOW_NORMAL); }
    catch (error) { child.kill(); child.emit('error', error); }
  });
  return child;
}

// Binary payloads go to private temporary files, never through the ready-marker stream.
export class ExiftoolPool {
  constructor({ program = localSetting('EAGLE_EXIFTOOL', 'exiftool'),
    size = workerLimit('EAGLE_EXIFTOOL_WORKERS'), timeoutMs = 60000, idleMs = 5000,
    maxBytes = 128 * 1024 * 1024, spawnChild = start } = {}) {
    this.program = program;
    this.size = Number.isSafeInteger(size) ? Math.max(1, Math.min(performanceWorkerCap(), size)) : 1;
    this.timeoutMs = timeoutMs;
    this.idleMs = idleMs;
    this.maxBytes = maxBytes;
    this.spawnChild = spawnChild;
    this.workers = [];
    this.pending = [];
    this.sequence = 0;
    this.closed = false;
  }

  async request(args, { binary = false, fallback, signal } = {}) {
    try {
      signal?.throwIfAborted();
      if (this.closed || args.some(arg => /[\r\n\0]/.test(arg))) throw new Error('Unsafe stay-open arguments');
      if (localSetting('EAGLE_EXIFTOOL_STAY_OPEN', '1') === '0') throw new Error('Stay-open disabled');
      const temporary = binary ? await mkdtemp(path.join(os.tmpdir(), 'eagle-exif-')) : null;
      try {
        const file = temporary && path.join(temporary, 'payload.bin');
        // -w treats a name without format codes as an extension. %0f selects
        // filename-format mode without adding the source basename.
        const format = temporary && path.join(temporary.replaceAll('%', '%%'), '%0fpayload.bin');
        const commandArgs = file ? [...args, '-w!', format] : args;
        if (commandArgs.some(arg => /[\r\n\0]/.test(arg))) throw new Error('Unsafe temporary path');
        const output = await new Promise((resolve, reject) => {
          const cleanup = () => signal?.removeEventListener('abort', abort);
          const job = { args: commandArgs,
            resolve: value => { cleanup(); resolve(value); }, reject: error => { cleanup(); reject(error); } };
          const abort = () => {
            const error = signal.reason || new Error('Exiftool cancelled');
            const index = this.pending.indexOf(job);
            if (index >= 0) { this.pending.splice(index, 1); job.reject(error); }
            else {
              const worker = this.workers.find(item => item.job === job);
              if (worker) this.fail(worker, error);
            }
          };
          this.pending.push(job);
          signal?.addEventListener('abort', abort, { once: true });
          if (signal?.aborted) abort();
          this.drain();
        });
        if (!file) return output;
        const data = await readFile(file);
        if (data.length > this.maxBytes) throw new Error('Exiftool payload exceeds limit');
        return data;
      } finally { if (temporary) await rm(temporary, { force: true, recursive: true }); }
    } catch (error) {
      signal?.throwIfAborted();
      if (!fallback) throw error;
      return fallback();
    }
  }

  drain() {
    if (this.closed) return;
    while (this.pending.length) {
      let worker = this.workers.find(item => !item.job);
      if (!worker && this.workers.length < this.size) {
        try { worker = this.createWorker(); }
        catch (error) { this.pending.shift().reject(error); continue; }
      }
      if (!worker) return;
      clearTimeout(worker.idle);
      const job = this.pending.shift();
      worker.job = job;
      worker.output = '';
      job.id = ++this.sequence;
      job.timer = setTimeout(() => this.fail(worker, new Error('Exiftool stay-open timeout')), this.timeoutMs);
      try { worker.child.stdin.write([...job.args, `-execute${job.id}`, ''].join('\n'), error => {
        if (error) this.fail(worker, error);
      }); } catch (error) { this.fail(worker, error); }
    }
  }

  createWorker() {
    const args = [...(process.platform === 'win32' ? ['-charset', 'filename=UTF8'] : []), '-stay_open', 'True', '-@', '-'];
    const worker = { child: this.spawnChild(this.program, args), job: null, output: '' };
    this.workers.push(worker);
    worker.child.stdout.setEncoding('utf8');
    worker.child.stdout.on('data', chunk => {
      if (!worker.job) return;
      worker.output += chunk;
      if (Buffer.byteLength(worker.output) > 1024 * 1024) return this.fail(worker, new Error('Exiftool output exceeds limit'));
      const marker = new RegExp(`(?:^|\\r?\\n)\\{ready${worker.job.id}\\}\\r?\\n`);
      const match = marker.exec(worker.output);
      if (!match) return;
      const job = worker.job;
      worker.job = null;
      clearTimeout(job.timer);
      job.resolve(worker.output.slice(0, match.index));
      worker.output = '';
      worker.idle = setTimeout(() => this.retire(worker), this.idleMs);
      this.drain();
    });
    // Drain stderr so a verbose exiftool cannot block the pipe. Extraction errors
    // are detected by the missing payload; malformed JSON is handled by callers.
    worker.child.stderr.on('data', () => {});
    worker.child.on('error', error => this.fail(worker, error));
    worker.child.on('close', () => this.fail(worker, new Error('Exiftool exited before ready')));
    return worker;
  }

  retire(worker) {
    clearTimeout(worker.idle);
    const index = this.workers.indexOf(worker);
    if (index < 0) return;
    this.workers.splice(index, 1);
    worker.child.kill();
  }

  fail(worker, error) {
    if (!this.workers.includes(worker)) return;
    const job = worker.job;
    worker.job = null;
    if (job) { clearTimeout(job.timer); job.reject(error); }
    this.retire(worker);
    this.drain();
  }

  close() {
    this.closed = true;
    for (const job of this.pending.splice(0)) job.reject(new Error('Exiftool pool closed'));
    for (const worker of [...this.workers]) this.fail(worker, new Error('Exiftool pool closed'));
  }
}

const pools = new Map();
export function exiftoolRequest(args, options) {
  const key = `${performanceMode()}:${workerLimit('EAGLE_EXIFTOOL_WORKERS')}`;
  if (!pools.has(key)) pools.set(key, new ExiftoolPool());
  return pools.get(key).request(args, options);
}
