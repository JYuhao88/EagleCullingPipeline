import test from 'node:test';
import assert from 'node:assert/strict';
import { access } from 'node:fs/promises';
import { spawnSync } from 'node:child_process';

const root = new URL('..', import.meta.url);
const run = (python, args) => spawnSync(python, args, { cwd: root, encoding: 'utf8', timeout: 120_000 });

test('python worker unit tests pass in the worker interpreter', async t => {
  const python = process.env.EAGLE_PYTHON || 'python_worker/.venv/bin/python';
  try { await access(new URL(python, root)); }
  catch { t.skip(`Python worker interpreter unavailable: ${python}`); return; }
  const result = run(python, ['-m', 'unittest', 'discover', '-s', 'python_worker', '-p', 'test_*.py']);
  assert.equal(result.status, 0, `${result.stdout}\n${result.stderr}`);
});

test('shared ml unit tests pass; observation head training needs numpy', t => {
  const program = String.raw`
import importlib.util, sys, unittest
names = ['ml.common.test_file_lock', 'ml.observe.test_critique_sensitivity', 'scripts.test_aihub_ray']
if importlib.util.find_spec('numpy'): names.append('ml.observe.test_train_heads')
else: print('SKIP ml.observe.test_train_heads: numpy unavailable')
result = unittest.TextTestRunner(stream=sys.stderr).run(unittest.defaultTestLoader.loadTestsFromNames(names))
sys.exit(0 if result.wasSuccessful() else 1)
`;
  const result = run(process.env.EAGLE_PYTHON || 'python3', ['-c', program]);
  if (result.stdout.includes('SKIP')) t.diagnostic(result.stdout.trim());
  assert.equal(result.status, 0, `${result.stdout}\n${result.stderr}`);
});
