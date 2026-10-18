"""Private research settings and Ray job environment propagation.

Local settings come from config/local.json, with environment variables taking
precedence. Ray execution deliberately reads only the propagated environment.
"""

import inspect
import json
import os
from pathlib import Path
from urllib.parse import urlsplit


def _config(config_path=None):
    if os.environ.get('ECP_RAY_WORKER') == '1':
        return {}
    if config_path is None:
        config_path = os.environ.get('ECP_LOCAL_CONFIG')
    path = Path(config_path) if config_path is not None else Path(__file__).resolve().parents[2] / 'config' / 'local.json'
    if not path.exists():
        return {}
    try:
        data = json.loads(path.read_text(encoding='utf-8'))
    except (OSError, ValueError) as exc:
        raise ValueError(f'Cannot read private configuration {path}: {exc}') from exc
    if not isinstance(data, dict):
        raise ValueError(f'Private configuration {path} must contain a JSON object')
    return data


def _validated(name, value):
    if name in ('ECP_HTTP_PROXY', 'ECP_NPM_REGISTRY') and value == '':
        return value
    if not isinstance(value, str) or not value.strip() or '<' in value or '>' in value:
        raise ValueError(f'{name} must be a nonempty configured value; set it in local config/local.json or the environment before submitting the Ray job')
    return value


def setting(name, default=None, required=False, config_path=None):
    """Resolve on each call; importing this helper does not require private settings."""
    if name in os.environ:
        return _validated(name, os.environ[name])
    values = _config(config_path)
    if name in values:
        return _validated(name, values[name])
    if required:
        raise ValueError(f'{name} is required; set it in local config/local.json or the environment before submitting the Ray job')
    return default


def require_path(name, config_path=None):
    value = setting(name, required=True, config_path=config_path)
    if not Path(value).is_absolute():
        raise ValueError(f'{name} must be an absolute path; set it in local config/local.json or the environment')
    return value


def dashboard_url(config_path=None):
    value = setting('RAY_DASHBOARD', required=True, config_path=config_path)
    parsed = urlsplit(value)
    if parsed.scheme not in ('http', 'https') or not parsed.netloc:
        raise ValueError('RAY_DASHBOARD must be an absolute HTTP(S) URL')
    return value.rstrip('/')


def jobs_url(config_path=None):
    dashboard = dashboard_url(config_path)
    value = setting('RAY_JOBS_URL', default=dashboard + '/api/jobs/', config_path=config_path)
    parsed = urlsplit(value)
    if parsed.scheme not in ('http', 'https') or not parsed.netloc:
        raise ValueError('RAY_JOBS_URL must be an absolute HTTP(S) URL')
    return value.rstrip('/') + '/'


def _forwarded(key):
    # The Ray job listing shows env_vars, so model-service endpoints and credentials never travel this way.
    return (key.startswith('ECP_') and key != 'ECP_LOCAL_CONFIG' and not key.startswith('ECP_AIHUB_')
            and not any(word in key for word in ('KEY', 'TOKEN', 'SECRET', 'PASSWORD')))


def merge_private_env(body, config_path=None):
    """Add configured ECP_* values without replacing job-specific settings.

    RAY_DASHBOARD is the submission endpoint, not a worker setting. Explicit
    job env_vars take precedence; other runtime_env entries are preserved.
    """
    values = {key: value for key, value in _config(config_path).items() if _forwarded(key)}
    values.update({key: value for key, value in os.environ.items() if _forwarded(key)})
    values = {key: _validated(key, value) for key, value in values.items()}
    runtime = body.setdefault('runtime_env', {})
    values.update(runtime.get('env_vars', {}))
    values['ECP_RAY_WORKER'] = '1'
    runtime['env_vars'] = values
    return body


def remote_prelude():
    """Standalone helpers for Ray entrypoints which exec locally read source.

    The worker must never fall back to a local configuration file or a default
    storage root. This code is shipped before the job source, without relying
    on ml.common being installed on the worker.
    """
    remote_setting = '''def setting(name, default=None, required=False, config_path=None):
    if name in os.environ:
        return _validated(name, os.environ[name])
    if required:
        raise ValueError(f'{name} is required on the Ray worker; set it in local config/local.json or the environment before submitting the Ray job')
    return default
'''
    source = '\n'.join([
        'import os\nfrom pathlib import Path\nfrom urllib.parse import urlsplit',
        inspect.getsource(_validated), remote_setting,
        inspect.getsource(require_path), inspect.getsource(dashboard_url), inspect.getsource(jobs_url),
        "def merge_private_env(*args, **kwargs):\n    raise RuntimeError('Submit Ray jobs from the configured local coordinator')\nremote_prelude = worker_source = merge_private_env\n",
    ]) + '\n'
    return '''import sys as _private_sys
import types as _private_types
if True:  # Always install environment-only helpers in an execution process.
    for _private_package in ('ml', 'ml.common'):
        if _private_package not in _private_sys.modules:
            _private_module = _private_types.ModuleType(_private_package)
            _private_module.__path__ = []
            _private_sys.modules[_private_package] = _private_module
    _private_module = _private_types.ModuleType('ml.common.private_env')
    exec(%r, _private_module.__dict__)
    _private_sys.modules['ml.common.private_env'] = _private_module
    _private_sys.modules['ml'].common = _private_sys.modules['ml.common']
    _private_sys.modules['ml.common'].private_env = _private_module
from ml.common.private_env import setting, require_path, dashboard_url, jobs_url
''' % source


def worker_source(source, required=()):
    """Bootstrap environment-only helpers, then compile the original module independently."""
    checks = "".join("require_path(" + repr(name) + ")\n" for name in required)
    return remote_prelude() + "\n" + checks + "exec(compile(" + repr(source) + ", '<ray-worker>', 'exec'))\n"
