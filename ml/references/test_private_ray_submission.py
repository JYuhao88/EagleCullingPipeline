"""Capture real submission bodies and replay only synthetic code, without contacting Ray."""
from contextlib import redirect_stdout
import importlib.util
import io
import json
import os
from pathlib import Path
import shlex
import subprocess
import sys
import tempfile
import unittest
from unittest.mock import Mock, patch

REPO = Path(__file__).resolve().parents[2]
sys.path.insert(0, str(REPO))
sys.path.insert(0, str(REPO / 'ml/references'))
from ml.common.private_env_test_fixture import configured_private_environment
from ml.common.private_env import worker_source


def load(name, relative):
    spec = importlib.util.spec_from_file_location(name, REPO / relative)
    module = importlib.util.module_from_spec(spec)
    with patch.object(sys, 'path', [str((REPO / relative).parent), *sys.path]):
        spec.loader.exec_module(module)
    return module


with configured_private_environment():
    import submit
    import upload_to_ceph
    import backup_wulin_extracted
    import courses
    import course_frames_ray
    import transfer_rules
    import transfer_genres
    books = load('private_test_books_ray', 'ml/references/books/photo_books_ray.py')
    refbooks = load('private_test_refbooks_ray', 'ml/references/books/ref_books_ray.py')
    texts = load('private_test_texts_ray', 'ml/references/courses_texts/ray.py')
    cbooks = load('private_test_cbooks', 'ml/references/corpus/fetch_corpus_books.py')
    papers = load('private_test_papers', 'ml/references/corpus/fetch_corpus_papers.py')
    triage = load('private_test_triage', 'ml/bench/phototriage.py')
    stress = load('private_test_stress', 'scripts/stress-ray.py')


class RayPrivateConfigurationTests(unittest.TestCase):
    def setUp(self):
        self.settings = configured_private_environment()
        self.root = self.settings.__enter__()
        self.addCleanup(self.settings.__exit__, None, None, None)
        self.ceph = os.environ['ECP_CEPH_ROOT']
        self.corpus = os.environ['ECP_CORPUS_ROOT']
        os.environ['ECP_TEST_FLAG'] = 'propagated'
        self.addCleanup(os.environ.pop, 'ECP_TEST_FLAG', None)

    def assert_private_body(self, body):
        env = body['runtime_env']['env_vars']
        self.assertEqual(env['ECP_CEPH_ROOT'], self.ceph)
        self.assertEqual(env['ECP_CORPUS_ROOT'], self.corpus)
        self.assertEqual(env['ECP_TEST_FLAG'], 'propagated')
        self.assertEqual(env['ECP_RAY_WORKER'], '1')
        self.assertNotIn('RAY_DASHBOARD', env)
        self.assertNotIn('ECP_LOCAL_CONFIG', env)

    def replay(self, body, omit=None):
        command = shlex.split(body['entrypoint'])
        self.assertEqual(command[1], '-c')
        env = {k: v for k, v in os.environ.items() if not k.startswith('ECP_') and not k.startswith('RAY_')}
        env.update(body['runtime_env']['env_vars'])
        if omit:
            env.pop(omit, None)
        return subprocess.run([sys.executable, '-c', command[2]], cwd=self.root,
                              env=env, text=True, capture_output=True, timeout=15)

    def test_real_submitters_propagate_and_self_contained_workers_fail_closed(self):
        synthetic = "from __future__ import annotations\nfrom ml.common.private_env import require_path\nprint(require_path('ECP_CEPH_ROOT'))"
        corpus_synthetic = synthetic.replace('ECP_CEPH_ROOT', 'ECP_CORPUS_ROOT')
        cases = [
            (courses, lambda: courses.submit_code(synthetic, 'w4-courses-private-test'), 'ECP_CEPH_ROOT'),
            (course_frames_ray, lambda: course_frames_ray.submit(synthetic, 'private-test'), 'ECP_CEPH_ROOT'),
            (books, lambda: books.submit(synthetic, 'private-test'), 'ECP_CEPH_ROOT'),
            (refbooks, lambda: refbooks.submit(synthetic, 'private-test'), 'ECP_CEPH_ROOT'),
            (texts, lambda: texts.submit(synthetic, 'private-test'), 'ECP_CEPH_ROOT'),
            (cbooks, lambda: cbooks.submit_source(corpus_synthetic, 'private-test'), 'ECP_CORPUS_ROOT'),
        ]
        for module, call, required in cases:
            with self.subTest(module=module.__name__), patch.object(module, 'request', return_value=[] ) as request:
                local = 'DATA' if module is course_frames_ray else 'LOCAL'
                with patch.object(module, local, self.root / module.__name__, create=True), redirect_stdout(io.StringIO()):
                    call()
                body = request.call_args.kwargs['body']
                self.assert_private_body(body)
                result = self.replay(body)
                self.assertEqual(result.returncode, 0, result.stderr)
                self.assertEqual(result.stdout.strip(), os.environ[required])
                missing = self.replay(body, required)
                self.assertNotEqual(missing.returncode, 0)
                self.assertIn(required + ' is required on the Ray worker', missing.stderr)

    def test_reference_stage_and_transfers_merge_before_transport(self):
        manifest = self.root / 'manifest.json'
        manifest.write_text(json.dumps({'videos': []}))
        cases = [
            (submit, ['submit.py', 'align', '--manifest', str(manifest)]),
            (transfer_rules, ['transfer_rules.py', 'ocr', '--id', 'private-test']),
            (transfer_genres, ['transfer_genres.py', 'export', '--source', 'wulin', '--id', 'private-test']),
        ]
        for module, argv in cases:
            with self.subTest(module=module.__name__), patch('sys.argv', argv), \
                 patch.object(module, 'request', return_value={}) as request, redirect_stdout(io.StringIO()):
                module.main()
                body = request.call_args.kwargs['body']
                self.assert_private_body(body)
                result = self.replay(body, 'ECP_CEPH_ROOT')
                self.assertIn('ECP_CEPH_ROOT is required on the Ray worker', result.stderr)

    def test_corpus_paper_submission_and_missing_node_root(self):
        with patch.object(papers, 'request', return_value=[]) as request:
            papers.submit('scan', 'w3-papers-private-test', {})
            body = request.call_args.kwargs['body']
        self.assert_private_body(body)
        result = self.replay(body, 'ECP_CORPUS_ROOT')
        self.assertIn('ECP_CORPUS_ROOT is required on the Ray worker', result.stderr)

    def test_upload_bodies_with_and_without_working_dir(self):
        with patch.object(upload_to_ceph, 'TEMP', self.root / 'upload-state'):
            uploader = upload_to_ceph.Uploader('private-test', [], Mock(), self.root / 'receipts')
        self.addCleanup(uploader.lock.close)
        uploader.http.request.return_value = {'logs': 'UPLOAD_RESULT []'}
        for uri in (None, 'gcs://synthetic-package.zip'):
            with self.subTest(working_dir=uri), patch.object(uploader, 'wait', return_value={'status': 'SUCCEEDED'}):
                uploader.run_job('verify', uri=uri)
                body = next(call.args[2] for call in reversed(uploader.http.request.call_args_list)
                            if call.args[:2] == ('POST', '/api/jobs/'))
                self.assert_private_body(body)
                if uri:
                    self.assertEqual(body['runtime_env']['working_dir'], uri)
                else:
                    result = self.replay(body, 'ECP_CEPH_ROOT')
                    self.assertIn('ECP_CEPH_ROOT is required on the Ray worker', result.stderr)

    def test_backup_submission_preserves_package_and_private_environment(self):
        source = self.root / 'extracted'
        episode = source / 'BVExample'
        episode.mkdir(parents=True)
        (episode / '0001.json').write_text('{}')
        expected = backup_wulin_extracted.manifest_digest(backup_wulin_extracted.manifest(source))
        http = Mock()
        logs = iter([{'files': 1, 'manifest_sha256': expected}, {'exists_after': False}])

        def response(method, path, body=None):
            if path.endswith('/logs'):
                return {'logs': 'BACKUP_RESULT ' + json.dumps(next(logs))}
            if method == 'GET' and path == '/api/jobs/':
                return []
            return {'status': 'SUCCEEDED'}

        http.request.side_effect = response
        args = ['backup_wulin_extracted.py', '--source', str(source), '--receipt', str(self.root / 'backup.json')]
        with patch('sys.argv', args), patch.object(backup_wulin_extracted, 'HTTP', return_value=http), \
             patch.object(backup_wulin_extracted.time, 'sleep'), redirect_stdout(io.StringIO()):
            backup_wulin_extracted.main()
        bodies = [call.args[2] for call in http.request.call_args_list if call.args[:2] == ('POST', '/api/jobs/')]
        self.assertEqual(len(bodies), 2)
        for body in bodies:
            self.assert_private_body(body)
        self.assertIn('working_dir', bodies[0]['runtime_env'])

    def test_benchmark_and_stress_submitters_use_shared_environment(self):
        args = ['phototriage.py', 'probe', '--id', 'w2-bench-triage-private-test']
        with patch('sys.argv', args), patch.object(triage, 'request', return_value={}) as request, \
             redirect_stdout(io.StringIO()):
            triage.main()
        self.assert_private_body(request.call_args.kwargs['body'])
        result = self.replay(request.call_args.kwargs['body'], 'ECP_CEPH_ROOT')
        self.assertIn('ECP_CEPH_ROOT is required on the Ray worker', result.stderr)
        with patch('sys.argv', ['stress-ray.py', 'submit']), patch.object(stress, 'LOCAL', self.root / 'stress'), \
             patch.object(stress, 'request', return_value=[]) as request, \
             patch.object(stress.OPENER, 'open') as opener, redirect_stdout(io.StringIO()):
            stress.main()
        body = request.call_args.args[1]
        self.assert_private_body(body)
        self.assertIn('working_dir', body['runtime_env'])
        package = opener.call_args.args[0].data
        import zipfile
        with zipfile.ZipFile(io.BytesIO(package)) as archive:
            self.assertIn('ml/common/private_env.py', archive.namelist())
            self.assertNotIn('config/local.json', archive.namelist())

    def test_http_transports_serialize_merged_environment(self):
        for module in (submit, triage, stress):
            with self.subTest(transport=module.__name__), patch.object(module.OPENER, 'open') as opener:
                handle = opener.return_value.__enter__.return_value
                opener.return_value.read.return_value = b'{}'
                handle.read.return_value = b'{}'
                if module is stress:
                    module.request('/api/jobs/', {'entrypoint': 'print(1)'})
                else:
                    module.request(body={'entrypoint': 'print(1)'})
                body = json.loads(opener.call_args.args[0].data)
                self.assert_private_body(body)

    def test_worker_config_cannot_read_a_local_json_on_execution_host(self):
        config = self.root / 'local.json'
        config.write_text(json.dumps({'ECP_CEPH_ROOT': self.ceph}))
        body = {'entrypoint': 'python -c ' + shlex.quote(worker_source('print("must not run")', ('ECP_CEPH_ROOT',))),
                'runtime_env': {'env_vars': {'ECP_LOCAL_CONFIG': str(config)}}}
        result = self.replay(body)
        self.assertNotEqual(result.returncode, 0)
        self.assertIn('ECP_CEPH_ROOT is required on the Ray worker', result.stderr)

    def test_missing_dashboard_never_opens_network_transport(self):
        with patch.dict(os.environ, {}, clear=True), patch.object(submit.OPENER, 'open') as opener:
            with self.assertRaisesRegex(ValueError, 'RAY_DASHBOARD.*required'):
                submit.request()
            opener.assert_not_called()

    def test_direct_worker_modules_require_an_explicit_root(self):
        for relative, root in [
            ('ml/references/tier_ocr_job.py', 'ECP_CEPH_ROOT'),
            ('ml/references/align_job.py', 'ECP_CEPH_ROOT'),
            ('ml/references/asr_job.py', 'ECP_CEPH_ROOT'),
            ('ml/references/segment_job.py', 'ECP_CEPH_ROOT'),
            ('ml/references/books/ocr_pdf_job.py', 'ECP_CEPH_ROOT'),
            ('ml/references/books/ocr_ref_pdf_job.py', 'ECP_CEPH_ROOT'),
            ('ml/references/corpus/fetch_corpus_books.py', 'ECP_CORPUS_ROOT'),
            ('ml/eval/export_topiq_iaa.py', 'ECP_CEPH_ROOT'),
            ('ml/research/search_corpus_facets.py', 'ECP_CORPUS_ROOT'),
            ('scripts/stress-ray-worker.py', 'ECP_CEPH_ROOT'),
        ]:
            with self.subTest(worker=relative):
                env = {k: v for k, v in os.environ.items() if not k.startswith('ECP_')}
                env['ECP_LOCAL_CONFIG'] = str(self.root / 'absent.json')
                result = subprocess.run([sys.executable, str(REPO / relative)], env=env,
                                        text=True, capture_output=True, timeout=15)
                self.assertNotEqual(result.returncode, 0)
                self.assertIn(root + ' is required', result.stderr)


if __name__ == '__main__':
    unittest.main()
