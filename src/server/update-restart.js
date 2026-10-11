import { spawn } from 'node:child_process';
import { open } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import { lowerNode } from '../core/update-process.js';

async function health(port, token) {
  const response = await fetch(`http://127.0.0.1:${port}/health`, { signal: AbortSignal.timeout(3000) });
  const value = await response.json();
  if (!response.ok || !value.ok || value.updateToken !== token) throw new Error('新服务健康检查失败');
}
function message(child, type, timeout = 30000) {
  return new Promise((resolve, reject) => {
    const cleanup = () => { clearTimeout(timer); child.off('message', receive); child.off('exit', exited); child.off('error', failed); };
    const receive = value => { if (value?.type === type) { cleanup(); resolve(value); } };
    const failed = error => { cleanup(); reject(error); };
    const exited = () => { cleanup(); reject(new Error('新服务启动失败')); };
    const timer = setTimeout(() => { cleanup(); reject(new Error('新服务启动超时')); }, timeout);
    child.on('error', failed);
    child.on('message', receive);
    child.on('exit', exited);
  });
}

export function restartService(instance, {
  cwd = process.cwd(), port, args = process.argv.slice(2), entry = process.argv[1], exit = () => process.exit(0),
  execArgs = process.execArgv.filter(value => !value.startsWith('--inspect')),
} = {}) {
  return async ({ logFile }) => {
    const token = randomUUID();
    const log = await open(logFile, 'a');
    const nodeArgs = ['--max-old-space-size=2048', ...execArgs, entry, ...args];
    const posix = process.platform !== 'win32';
    const child = spawn(posix ? 'nice' : process.execPath,
      posix ? ['-n', '15', process.execPath, ...nodeArgs] : nodeArgs, {
        cwd, env: { ...process.env, EAGLE_UPDATE_CANDIDATE: token },
        stdio: ['ignore', log.fd, log.fd, 'ipc'], detached: true,
      });
    let released = false;
    try {
      lowerNode(child);
      child.on('error', () => {});
      const ready = await message(child, 'update-ready');
      await health(ready.port, token);
      await instance.close();
      released = true;
      const promoted = message(child, 'update-promoted');
      child.send({ type: 'update-promote', port });
      await promoted;
      await health(port, token);
      return {
        finish() {
          child.disconnect();
          child.unref();
          setTimeout(exit, 2000).unref();
        },
        async abort() {
          child.kill('SIGKILL');
          await new Promise(resolve => child.exitCode !== null ? resolve() : child.once('exit', resolve));
          await instance.listen();
        },
      };
    } catch (error) {
      child.kill('SIGKILL');
      await new Promise(resolve => !child.pid || child.exitCode !== null ? resolve() : child.once('exit', resolve));
      if (released) await instance.listen();
      throw error;
    } finally { await log.close(); }
  };
}

export async function candidateService(instance) {
  const token = process.env.EAGLE_UPDATE_CANDIDATE;
  if (!token || !process.send) return false;
  await new Promise((resolve, reject) => {
    instance.server.once('error', reject);
    instance.server.listen(0, '127.0.0.1', resolve);
  });
  process.send({ type: 'update-ready', port: instance.server.address().port });
  process.on('message', async value => {
    if (value?.type !== 'update-promote') return;
    try {
      await instance.close();
      await new Promise((resolve, reject) => {
        instance.server.once('error', reject);
        instance.server.listen(value.port, '127.0.0.1', resolve);
      });
      process.send({ type: 'update-promoted' });
    } catch { process.exit(1); }
  });
  return true;
}
