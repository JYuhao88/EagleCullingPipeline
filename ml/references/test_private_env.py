import json
import os
from pathlib import Path
import sys
import tempfile
import unittest
from unittest.mock import patch

sys.path.insert(0, str(Path(__file__).resolve().parents[2]))
from ml.common import private_env


class PrivateEnvTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.config = Path(self.temp.name) / 'local.json'
        self.config.write_text('{}')
        self.environ = patch.dict(os.environ, {}, clear=True)
        self.environ.start()
        self.addCleanup(self.environ.stop)

    def test_body_contains_config_and_environment_without_endpoint(self):
        self.config.write_text(json.dumps({'ECP_CEPH_ROOT': self.temp.name,
                                          'ECP_CORPUS_ROOT': self.temp.name,
                                          'RAY_DASHBOARD': 'https://ray.example.test'}))
        os.environ.update(ECP_CEPH_ROOT=self.temp.name + '/override', ECP_HTTP_PROXY='https://proxy.example.test')
        body = {'runtime_env': {'pip': ['requests'], 'working_dir': '.', 'env_vars': {'JOB_FLAG': '1'}}}
        self.assertIs(private_env.merge_private_env(body, self.config), body)
        self.assertEqual(body['runtime_env']['env_vars'], {
            'ECP_CEPH_ROOT': self.temp.name + '/override', 'ECP_CORPUS_ROOT': self.temp.name,
            'ECP_HTTP_PROXY': 'https://proxy.example.test', 'JOB_FLAG': '1', 'ECP_RAY_WORKER': '1'})
        self.assertEqual(body['runtime_env']['pip'], ['requests'])
        self.assertEqual(body['runtime_env']['working_dir'], '.')
        self.assertNotIn('ECP_CORPUS_ROOT', os.environ)

    def test_job_specific_environment_takes_precedence(self):
        os.environ['ECP_CEPH_ROOT'] = self.temp.name
        body = {'runtime_env': {'env_vars': {'ECP_CEPH_ROOT': self.temp.name + '/job'}}}
        private_env.merge_private_env(body, self.config)
        self.assertEqual(body['runtime_env']['env_vars']['ECP_CEPH_ROOT'], self.temp.name + '/job')

    def test_missing_paths_and_dashboard_fail(self):
        for name in ('ECP_CEPH_ROOT', 'ECP_CORPUS_ROOT'):
            with self.subTest(name=name), self.assertRaisesRegex(ValueError, name + '.*required'):
                private_env.require_path(name, self.config)
        with self.assertRaisesRegex(ValueError, 'RAY_DASHBOARD.*required'):
            private_env.dashboard_url(self.config)
        os.environ['RAY_JOBS_URL'] = 'https://ray.example.test/api/jobs/'
        with self.assertRaisesRegex(ValueError, 'RAY_DASHBOARD.*required'):
            private_env.jobs_url(self.config)

    def test_invalid_paths_and_placeholder_values_fail(self):
        for value in ('', ' ', '<CEPH_ROOT>', 'data/private-references'):
            with self.subTest(value=value):
                os.environ['ECP_CEPH_ROOT'] = value
                with self.assertRaisesRegex(ValueError, 'ECP_CEPH_ROOT'):
                    private_env.require_path('ECP_CEPH_ROOT', self.config)

    def test_environment_overrides_local_settings_even_if_empty(self):
        self.config.write_text(json.dumps({'ECP_CEPH_ROOT': self.temp.name, 'RAY_DASHBOARD': 'https://ray.example.test/'}))
        self.assertEqual(private_env.require_path('ECP_CEPH_ROOT', self.config), self.temp.name)
        self.assertEqual(private_env.jobs_url(self.config), 'https://ray.example.test/api/jobs/')
        os.environ['ECP_CEPH_ROOT'] = ''
        with self.assertRaisesRegex(ValueError, 'ECP_CEPH_ROOT'):
            private_env.require_path('ECP_CEPH_ROOT', self.config)

    def test_remote_source_reads_only_propagated_environment(self):
        scope = {}
        with patch.dict(sys.modules):
            sys.modules.pop('ml.common.private_env', None)
            exec(compile(private_env.remote_prelude(), '<ray-prelude>', 'exec'), scope)
            self.config.write_text(json.dumps({'ECP_CEPH_ROOT': self.temp.name}))
            with self.assertRaisesRegex(ValueError, 'ECP_CEPH_ROOT.*required on the Ray worker'):
                scope['require_path']('ECP_CEPH_ROOT', self.config)
            os.environ['ECP_CEPH_ROOT'] = self.temp.name
            self.assertEqual(scope['require_path']('ECP_CEPH_ROOT'), self.temp.name)
        sys.modules['ml.common'].private_env = private_env

    def test_local_config_environment_override(self):
        self.config.write_text(json.dumps({'ECP_CEPH_ROOT': self.temp.name}))
        os.environ['ECP_LOCAL_CONFIG'] = str(self.config)
        self.assertEqual(private_env.require_path('ECP_CEPH_ROOT'), self.temp.name)


if __name__ == '__main__':
    unittest.main()
