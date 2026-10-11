"""Explicit temporary configuration for offline research unit tests only."""
from contextlib import contextmanager
import os
from pathlib import Path
import tempfile
from unittest.mock import patch


@contextmanager
def configured_private_environment():
    with tempfile.TemporaryDirectory(prefix='ecp-unit-config-') as directory:
        directory = str(Path(directory).resolve())
        with patch.dict(os.environ, {
            'ECP_CEPH_ROOT': directory + '/ceph',
            'ECP_CORPUS_ROOT': directory + '/corpus',
            'ECP_LOCAL_CONFIG': directory + '/absent-local.json',
            'RAY_DASHBOARD': 'https://ray.example.test',
        }):
            yield Path(directory)
