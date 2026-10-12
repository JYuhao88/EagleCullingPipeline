import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { Script } from 'node:vm';

test('preview serves every DARK/LIGHT state with valid mock scripts and service status codes', async t => {
  const launch = process.platform === 'win32' ? ['node', []] : ['nice', ['-n', '15', 'node']];
  const child = spawn(launch[0], [...launch[1], 'scripts/dev-panel-fixture.mjs'], { stdio: ['ignore', 'pipe', 'pipe'] });
  let stderr = '';
  child.stderr.on('data', bytes => { stderr += bytes; });
  t.after(async () => {
    if (child.exitCode !== null || child.signalCode !== null) return;
    const exited = new Promise(resolve => child.once('exit', resolve)); child.kill('SIGINT'); await exited;
  });
  try {
    await new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('fixture startup timeout')), 5000);
      child.stdout.once('data', () => { clearTimeout(timer); resolve(); });
      child.once('error', error => { clearTimeout(timer); reject(error); });
      child.once('exit', () => { clearTimeout(timer); reject(new Error(stderr)); });
    });
  } catch (error) {
    if (/EPERM|EACCES|EADDRINUSE/.test(error.message)) { t.skip('fixture loopback listen unavailable'); return; }
    throw error;
  }
  const base = 'http://127.0.0.1:43441';
  const states = ['offline', 'starting', 'none', 'selected', 'folder', 'running', 'completed', 'settings', 'history',
    'inspector-result', 'inspector-empty', 'inspector-offline'];
  for (const theme of ['DARK', 'LIGHT']) for (const state of states) {
    const response = await fetch(`${base}/?state=${state}&theme=${theme}`);
    assert.equal(response.status, 200);
    const html = await response.text(); assert.ok(html.includes('window.eagle='));
    for (const match of html.matchAll(/<script>([\s\S]*?)<\/script>/g)) new Script(match[1]);
  }
  const lab = await (await fetch(`${base}/lab`)).text();
  for (const match of lab.matchAll(/<script>([\s\S]*?)<\/script>/g)) new Script(match[1]);
  for (const [state, code] of [['offline', 503], ['starting', 503], ['selected', 200]])
    assert.equal((await fetch(`${base}/health?fixture=${state}`)).status, code);
  for (const [state, code] of [['inspector-result', 200], ['inspector-empty', 404], ['inspector-offline', 503]])
    assert.equal((await fetch(`${base}/items/photo/analysis?libraryPath=/fixture.library&fixture=${state}`)).status, code);
});
