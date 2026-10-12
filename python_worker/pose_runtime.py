"""Provider policy, kept dependency-free for configuration tests."""
import sys

ORDER = ['DmlExecutionProvider', 'CUDAExecutionProvider', 'CoreMLExecutionProvider', 'CPUExecutionProvider']


def select_providers(available, requested=None, platform=None):
    platform = sys.platform if platform is None else platform
    if requested and requested not in available:
        raise RuntimeError(f'Unavailable provider: {requested}')
    if requested:
        providers = [requested]
    elif platform == 'darwin':
        providers = ['CPUExecutionProvider']
    else:
        providers = [p for p in ORDER if p in available]
    if 'CPUExecutionProvider' not in providers:
        providers.append('CPUExecutionProvider')
    return providers


def cpu_threads(value='3'):
    if not isinstance(value, str) or len(value) != 1 or value not in '12345678':
        raise ValueError('EAGLE_POSE_THREADS must be an integer from 1 to 8')
    return int(value)
