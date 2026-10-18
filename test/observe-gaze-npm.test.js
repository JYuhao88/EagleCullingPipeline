import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';

const run = code => {
  const result = spawnSync(process.env.EAGLE_PYTHON || 'python3', ['-c', code], {
    cwd: new URL('..', import.meta.url), encoding: 'utf8', timeout: 15000,
    env: { ...process.env, OPENBLAS_NUM_THREADS: '1', OMP_NUM_THREADS: '1' }
  });
  assert.equal(result.error, undefined);
  assert.equal(result.status, 0, result.stderr);
};

test('a configured npm mirror tries direct first and verifies native modules with scripts disabled', () => run(`
from types import SimpleNamespace
from unittest.mock import patch
from ml.observe import gaze_accept_ray as worker
mirror = 'https://configured-mirror.invalid/npm/'
proxy = 'http://proxy.invalid:8080'
keys = ['HTTP_PROXY', 'HTTPS_PROXY', 'ALL_PROXY', 'http_proxy', 'https_proxy', 'all_proxy',
        'npm_config_proxy', 'npm_config_https_proxy', 'NPM_CONFIG_PROXY', 'NPM_CONFIG_HTTPS_PROXY']
env = {key: proxy for key in keys}
env.update(PATH='fixture-bin', npm_config_registry=mirror, ONNXRUNTIME_NODE_INSTALL='skip',
           SHARP_IGNORE_GLOBAL_LIBVIPS='1')
original = dict(env)
with patch.object(worker.subprocess, 'run', return_value=SimpleNamespace(returncode=0)) as execute, \\
     patch.object(worker, 'report') as report:
    installed = worker.install_native_dependencies(env)
assert env == original
assert execute.call_count == 2
command, = execute.call_args_list[0].args
options = execute.call_args_list[0].kwargs
assert command[:2] == ['npm', 'install'] and '--ignore-scripts' in command
assert options['check'] and options['capture_output'] and options['text'] and options['timeout'] == 600
assert options['env']['npm_config_registry'] == mirror
assert all(not options['env'].get(key) for key in keys)
assert options['env']['ONNXRUNTIME_NODE_INSTALL'] == 'skip'
assert options['env']['SHARP_IGNORE_GLOBAL_LIBVIPS'] == '1'
native = execute.call_args_list[1]
assert native.args[0][:3] == ['node', '--input-type=module', '-e']
assert 'sharp' in native.args[0][3] and 'onnxruntime-node' in native.args[0][3]
assert native.kwargs['env'] == installed == options['env']
assert native.kwargs['capture_output'] and native.kwargs['text'] and native.kwargs['timeout'] == 60
assert mirror not in str(report.call_args_list) and proxy not in str(report.call_args_list)
`));

test('a configured npm mirror falls back to the configured proxy only after direct failure', () => run(`
import subprocess
from types import SimpleNamespace
from unittest.mock import patch
from ml.observe import gaze_accept_ray as worker
mirror = 'https://configured-mirror.invalid/npm/'
proxy = 'http://proxy.invalid:8080'
env = {'npm_config_registry': mirror, 'HTTP_PROXY': proxy, 'HTTPS_PROXY': proxy,
       'npm_config_proxy': proxy, 'npm_config_https_proxy': proxy}
failed = subprocess.CalledProcessError(1, ['npm'], output=mirror, stderr=proxy)
with patch.object(worker.subprocess, 'run', side_effect=[failed, SimpleNamespace(returncode=0),
                                                       SimpleNamespace(returncode=0)]) as execute, \\
     patch.object(worker, 'report') as report:
    installed = worker.install_native_dependencies(env)
assert execute.call_count == 3
direct, fallback, native = execute.call_args_list
assert not direct.kwargs['env'].get('HTTP_PROXY') and not direct.kwargs['env'].get('npm_config_proxy')
assert fallback.args[0][:2] == ['npm', 'install'] and '--ignore-scripts' in fallback.args[0]
assert fallback.kwargs['env']['npm_config_registry'] == mirror
assert fallback.kwargs['env']['npm_config_proxy'] == proxy
assert fallback.kwargs['env']['npm_config_https_proxy'] == proxy
assert installed == fallback.kwargs['env'] == native.kwargs['env']
assert mirror not in str(report.call_args_list) and proxy not in str(report.call_args_list)
`));

test('a mirror failure without a proxy stops after one safe captured attempt', () => run(`
import subprocess
from unittest.mock import patch
from ml.observe import gaze_accept_ray as worker
mirror = 'https://configured-mirror.invalid/npm/'
failed = subprocess.CalledProcessError(1, ['npm'], output=mirror, stderr='private-install-detail')
with patch.object(worker.subprocess, 'run', side_effect=failed) as execute, \\
     patch.object(worker, 'report') as report:
    try: worker.install_native_dependencies({'npm_config_registry': mirror})
    except RuntimeError as error:
        message = str(error)
        assert 'npm' in message.lower()
        assert mirror not in message and 'private-install-detail' not in message
        assert error.__suppress_context__
    else: raise AssertionError('failed npm installation accepted')
assert execute.call_count == 1
assert mirror not in str(report.call_args_list) and 'private-install-detail' not in str(report.call_args_list)
`));

test('npm without a configured mirror keeps the existing configured proxy route', () => run(`
from types import SimpleNamespace
from unittest.mock import patch
from ml.observe import gaze_accept_ray as worker
proxy = 'http://proxy.invalid:8080'
env = {'HTTP_PROXY': proxy, 'HTTPS_PROXY': proxy, 'npm_config_proxy': proxy,
       'npm_config_https_proxy': proxy, 'ONNXRUNTIME_NODE_INSTALL': 'skip'}
with patch.object(worker.subprocess, 'run', return_value=SimpleNamespace(returncode=0)) as execute, \\
     patch.object(worker, 'report'):
    installed = worker.install_native_dependencies(env)
assert execute.call_count == 2
assert execute.call_args_list[0].kwargs['env'] == env == installed
assert 'npm_config_registry' not in installed
assert '--ignore-scripts' in execute.call_args_list[0].args[0]
`));

test('an optional empty npm mirror is valid and worker settings become npm-only configuration', () => run(`
from types import SimpleNamespace
from unittest.mock import patch
from ml.common.private_env import _validated
from ml.observe import gaze_accept_ray as worker
assert _validated('ECP_NPM_REGISTRY', '') == ''
for value in [None, ' ', '<mirror>']:
    try: _validated('ECP_NPM_REGISTRY', value)
    except ValueError: pass
    else: raise AssertionError('invalid configured value accepted')
try: _validated('ECP_CEPH_ROOT', '')
except ValueError: pass
else: raise AssertionError('empty required path accepted')
mirror = 'https://configured-mirror.invalid/npm/'
for configured in ['', mirror]:
    env = {'ECP_NPM_REGISTRY': configured, 'PATH': 'fixture-bin'}
    with patch.object(worker.subprocess, 'run', return_value=SimpleNamespace(returncode=0)) as execute, \\
         patch.object(worker, 'report') as report:
        installed = worker.install_native_dependencies(env)
    assert env['ECP_NPM_REGISTRY'] == configured and 'ECP_NPM_REGISTRY' not in installed
    assert ('npm_config_registry' in installed) == bool(configured)
    if configured: assert installed['npm_config_registry'] == mirror
    assert execute.call_count == 2 and execute.call_args_list[0].kwargs['env'] == installed
    assert mirror not in str(report.call_args_list)
`));

test('native preflight stops before extraction and reports only a safe missing-module diagnosis', () => run(`
import subprocess
from types import SimpleNamespace
from unittest.mock import patch
from ml.observe import gaze_accept_ray as worker
mirror = 'https://configured-mirror.invalid/npm/'
failure = subprocess.CalledProcessError(1, ['node'], output=mirror,
             stderr='Cannot find module onnxruntime-node/bin/napi-v3/linux/x64/onnxruntime_binding.node private-detail')
with patch.object(worker.subprocess, 'run', side_effect=[SimpleNamespace(returncode=0), failure]) as execute, \\
     patch.object(worker, 'report') as report:
    try: worker.install_native_dependencies({'npm_config_registry': mirror})
    except RuntimeError as error:
        message = str(error)
        assert 'native' in message.lower() and 'onnxruntime' in message.lower()
        assert mirror not in message and 'private-detail' not in message
        assert error.__suppress_context__
    else: raise AssertionError('missing native binding accepted')
assert execute.call_count == 2
assert mirror not in str(report.call_args_list) and 'private-detail' not in str(report.call_args_list)
`));

test('acceptance submission passes an optional npm mirror only through the worker environment', () => run(`
import importlib.util
from pathlib import Path
from tempfile import TemporaryDirectory
from unittest.mock import patch
spec = importlib.util.spec_from_file_location('accept', 'scripts/observe-gaze-accept-ray.py')
worker = importlib.util.module_from_spec(spec); spec.loader.exec_module(worker)
mirror = 'https://configured-mirror.invalid/npm/'
with TemporaryDirectory() as directory:
    for configured in ['', mirror]:
        settings = {'ECP_HTTP_PROXY': 'http://proxy.invalid:8080', 'ECP_NPM_REGISTRY': configured}
        with patch.object(worker, 'setting', side_effect=lambda key, default='': settings.get(key, default)), \\
             patch.object(worker, 'require_path', return_value='/fixture/ceph'), \\
             patch.object(worker, 'package', return_value=(b'fixture-package', {'rows': 1})) as package, \\
             patch.object(worker.GAZE.SHARED, 'digest', return_value='a' * 64), \\
             patch.object(worker.GAZE.SHARED, 'model_packages', return_value=([], {})), \\
             patch.object(worker.GAZE.SHARED, 'request'), \\
             patch.object(worker.GAZE, 'quota_submit', return_value='fixture-job') as submit:
            assert worker.submit(Path(directory)) == 'fixture-job'
        body, output, metadata = submit.call_args.args
        env = body['runtime_env']['env_vars']
        assert env['HTTP_PROXY'] == settings['ECP_HTTP_PROXY']
        assert ('npm_config_registry' in env) == bool(configured)
        if configured: assert env['npm_config_registry'] == configured
        assert 'ECP_NPM_REGISTRY' not in env
        assert mirror not in str(metadata) and mirror not in str(package.call_args)
`));

test('a full project quota releases the shared lock and waits five minutes before rechecking', () => run(`
import importlib.util, json
from pathlib import Path
from tempfile import TemporaryDirectory
from unittest.mock import patch
spec = importlib.util.spec_from_file_location('gaze', 'scripts/observe-gaze-ray.py')
worker = importlib.util.module_from_spec(spec); spec.loader.exec_module(worker)
with TemporaryDirectory() as directory:
    root = Path(directory); worker.LOCK = root / 'lock'
    full = [{'status': 'RUNNING', 'submission_id': 'w1-other'},
            {'status': 'PENDING', 'submission_id': 'w39-other'}]
    available = [{'status': 'RUNNING', 'submission_id': 'w1-other'},
                 {'status': 'RUNNING', 'submission_id': 'w40-outside-project'},
                 {'status': 'SUCCEEDED', 'submission_id': 'w2-terminal'}]
    responses = iter([full, available]); submissions = []
    def request(path, body=None):
        assert worker.LOCK.is_dir()
        owner = json.loads((worker.LOCK / 'owner.json').read_text())
        assert owner['line'] == 'w33-gaze' and owner['pid'] > 0
        if body is None: return next(responses)
        submissions.append(body)
    def sleep(seconds):
        assert seconds == 300 and not worker.LOCK.exists()
    with patch.object(worker.SHARED, 'request', side_effect=request), \\
         patch.object(worker.time, 'sleep', side_effect=sleep) as wait:
        job = worker.quota_submit({'submission_id': 'w33-gaze-0123456789ab'}, root, {})
    assert job == 'w33-gaze-0123456789ab' and len(submissions) == 1
    wait.assert_called_once_with(300)
    assert not worker.LOCK.exists()
`));

test('quota refresh happens outside the lock and every refreshed upload requires a fresh quota check', () => run(`
import importlib.util, json
from pathlib import Path
from tempfile import TemporaryDirectory
from unittest.mock import patch
spec = importlib.util.spec_from_file_location('gaze', 'scripts/observe-gaze-ray.py')
worker = importlib.util.module_from_spec(spec); spec.loader.exec_module(worker)
full = [{'status': 'RUNNING', 'submission_id': 'w1-other'},
        {'status': 'PENDING', 'submission_id': 'w2-other'}]
available = [{'status': 'RUNNING', 'submission_id': 'w1-other'}]
cases = [([full, available, available],
          ['list', 'wait', 'list', 'refresh', 'list', 'submit']),
         ([full, available, full, available, available],
          ['list', 'wait', 'list', 'refresh', 'list', 'wait', 'list', 'refresh', 'list', 'submit'])]
with TemporaryDirectory() as directory:
    root = Path(directory); worker.LOCK = root / 'lock'
    for states, expected in cases:
        responses = iter(states); events = []
        def request(path, body=None):
            assert worker.LOCK.is_dir() and (worker.LOCK / 'owner.json').exists()
            events.append('list' if body is None else 'submit')
            if body is None: return next(responses)
        def refresh():
            assert not worker.LOCK.exists()
            events.append('refresh')
        def sleep(seconds):
            assert seconds == 300 and not worker.LOCK.exists()
            events.append('wait')
        with patch.object(worker.SHARED, 'request', side_effect=request), \\
             patch.object(worker.time, 'sleep', side_effect=sleep):
            result = worker.quota_submit({'submission_id': 'w33-gaze-0123456789ab'}, root, {}, refresh=refresh)
        assert result == 'w33-gaze-0123456789ab' and events == expected
        assert not worker.LOCK.exists()
        assert json.loads((root / 'job.json').read_text())['job'] == result
`));
