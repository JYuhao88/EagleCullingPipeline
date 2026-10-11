"""Exercise generated CPU job code against synthetic private files, never real Ray."""
import sys as _test_sys
from pathlib import Path as _TestPath
_test_sys.path.insert(0, str(_TestPath(__file__).resolve().parents[2]))

from ml.common.private_env_test_fixture import configured_private_environment as _configured_private_environment
_import_private_environment = _configured_private_environment()
_import_private_environment.__enter__()

import contextlib
from concurrent.futures import ThreadPoolExecutor
import hashlib
import importlib.util
import io
import json
from pathlib import Path
import sys
import tempfile
import threading
import types
import unittest
from unittest.mock import Mock, patch


def load_module(name, filename):
    spec = importlib.util.spec_from_file_location(name, Path(__file__).parent / 'courses_texts' / filename)
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


extract = load_module('course_text_extract_ray_test', 'extract.py')
with patch.dict(sys.modules, {'extract': extract}), patch.object(sys, 'path', list(sys.path)):
    ray = load_module('course_text_ray_test', 'ray.py')


class RayControlTests(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.addCleanup(self.tmp.cleanup)
        self.root = Path(self.tmp.name)
        self.local = self.root / 'local'
        self.local.mkdir()
        self.manifest = self.root / 'inputs.json'
        self.manifest.write_text(json.dumps({'files': []}))
        self.ledger = self.local / 'ray-jobs.json'
        self.ledger.write_text(json.dumps(['w4-mastercourses-old']))
        self.local_patch = patch.object(ray, 'LOCAL', self.local)
        self.local_patch.start()
        self.addCleanup(self.local_patch.stop)
        # Every test blocks the real Jobs API, even when production code changes.
        self.request_patch = patch.object(ray, 'request', side_effect=AssertionError('unexpected Jobs API request'))
        self.request_patch.start()
        self.addCleanup(self.request_patch.stop)

    def main(self, *args):
        with patch.object(sys, 'argv', ['ray.py', *args, '--manifest', str(self.manifest)]), contextlib.redirect_stderr(io.StringIO()), contextlib.redirect_stdout(io.StringIO()):
            return ray.main()

    def test_submit_queries_only_ledger_and_reserves_one_cpu_no_gpu(self):
        request = Mock(side_effect=[{'status': 'SUCCEEDED'}, {'submission_id': 'accepted'}])
        with patch.object(ray, 'request', request), contextlib.redirect_stdout(io.StringIO()):
            job = ray.submit('print("synthetic")', 'extract', ['pypdf==6.1.1'])
        self.assertEqual(request.call_args_list[0].args, ('w4-mastercourses-old',))
        body = request.call_args_list[1].kwargs['body']
        self.assertEqual((body['entrypoint_num_cpus'], body['entrypoint_num_gpus']), (1, 0))
        self.assertEqual(body['runtime_env']['pip'], ['pypdf==6.1.1'])
        self.assertTrue(job.startswith('w4-mastercourses-extract-'))
        self.assertEqual(json.loads(self.ledger.read_text()), ['w4-mastercourses-old', job])

    def test_two_running_or_pending_own_jobs_refuse_submission(self):
        self.ledger.write_text(json.dumps(['w4-mastercourses-a', 'w4-mastercourses-b']))
        request = Mock(side_effect=[{'status': 'RUNNING'}, {'status': 'PENDING'}])
        with patch.object(ray, 'request', request):
            with self.assertRaisesRegex(ValueError, 'two own jobs'):
                ray.submit('pass', 'check')
        self.assertEqual(request.call_count, 2)
        self.assertTrue(all('body' not in call.kwargs for call in request.call_args_list))

    def test_readiness_cooldown_blocks_299_seconds_allows_300(self):
        stamp = self.local / 'last-check.json'
        stamp.write_text(json.dumps({'time': 1000, 'id': 'w4-mastercourses-old'}))
        with patch.object(ray, 'request', return_value={'status':'SUCCEEDED', 'end_time':0}), patch.object(ray.time, 'time', return_value=1299), patch.object(ray, 'submit') as submit:
            with self.assertRaisesRegex(ValueError, '>=300s'):
                self.main('check')
            submit.assert_not_called()
        with patch.object(ray, 'request', return_value={'status':'SUCCEEDED', 'end_time':0}), patch.object(ray.time, 'time', return_value=1300), patch.object(ray, 'submit', return_value='w4-mastercourses-next') as submit:
            self.main('check')
            submit.assert_called_once()
        self.assertEqual(json.loads(stamp.read_text()), {'time': 1300, 'id': 'w4-mastercourses-next'})

    def test_readiness_uses_job_end_time_and_refuses_active_watch(self):
        (self.local / 'last-check.json').write_text(json.dumps({'time':1000, 'id':'w4-mastercourses-old'}))
        for info, message in (({'status':'RUNNING'}, 'already active'),
                              ({'status':'SUCCEEDED', 'end_time':1200_000}, '>=300s')):
            with patch.object(ray, 'request', return_value=info), patch.object(ray.time, 'time', return_value=1499), patch.object(ray, 'submit') as submit:
                with self.assertRaisesRegex(ValueError, message):
                    self.main('check')
                submit.assert_not_called()

    def test_concurrent_submit_cannot_exceed_two_own_jobs(self):
        queried = threading.Event()
        second_attempt = threading.Event()
        statuses = {'w4-mastercourses-old': 'RUNNING'}
        def request(path='', body=None):
            if body is not None:
                statuses[body['submission_id']] = 'PENDING'
                return {'submission_id':body['submission_id']}
            if path == 'w4-mastercourses-old' and not queried.is_set():
                queried.set()
                if not second_attempt.wait(2):raise AssertionError('second caller did not start')
            return {'status':statuses[path]}
        def second():
            if not queried.wait(2):raise AssertionError('first caller did not start')
            second_attempt.set()
            return ray.submit('pass', 'check')
        with patch.object(ray, 'request', side_effect=request), contextlib.redirect_stdout(io.StringIO()), ThreadPoolExecutor(max_workers=2) as pool:
            first = pool.submit(ray.submit, 'pass', 'check')
            other = pool.submit(second)
            self.assertTrue(first.result(timeout=3).startswith('w4-mastercourses-check-'))
            with self.assertRaisesRegex(ValueError, 'two own jobs'):
                other.result(timeout=3)
        self.assertEqual(len(json.loads(self.ledger.read_text())), 2)

    def test_export_cli_requires_explicit_ids_or_manifest_only(self):
        with patch.object(ray, 'submit') as submit:
            with self.assertRaises(SystemExit):
                self.main('export')
            submit.assert_not_called()
            self.main('export', '--manifest-only')
            submit.assert_called_once()

    def test_receive_refuses_other_job_and_unsuccessful_export(self):
        with patch.object(ray, 'request') as request:
            with self.assertRaises(SystemExit):
                self.main('receive', '--id', 'someone-else-upload')
            request.assert_not_called()
        with patch.object(ray, 'request', return_value={'status': 'RUNNING'}) as request:
            with self.assertRaisesRegex(ValueError, 'not successful'):
                self.main('receive', '--id', 'w4-mastercourses-old')
            request.assert_called_once_with('w4-mastercourses-old')

    def test_watch_generated_code_waits_300_seconds_between_probes(self):
        clock = types.ModuleType('time')
        clock.monotonic = Mock(side_effect=[0, 0])
        clock.sleep = Mock()
        fake_extract = types.SimpleNamespace(audited=Mock(side_effect=[ValueError('not arrived'), b'ready']))
        with patch.object(ray, 'prefix', return_value=''), patch.dict(sys.modules, {'time': clock}), contextlib.redirect_stdout(io.StringIO()) as logs:
            code = ray.check_source([{'bvid': 'synthetic'}], wait_seconds=300)
            exec(code, {'extractor': fake_extract, 'root': '/synthetic', 'files': [{'bvid': 'synthetic'}]})
        clock.sleep.assert_called_once_with(300)
        self.assertEqual(fake_extract.audited.call_count, 2)
        self.assertIn('TEXT_READY_DONE', logs.getvalue())


class VerifiedExportTests(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.addCleanup(self.tmp.cleanup)
        self.root = Path(self.tmp.name)
        self.text = self.root / extract.SOURCE / 'text'
        self.text.mkdir(parents=True)
        self.videos = []
        for identity in ('selected', 'unselected'):
            raw = json.dumps({'sentences': [{'text': 'Synthetic only.', 'start': 1, 'end': 2}]}).encode()
            output = f'sample/{identity}.json'
            target = self.text / output
            target.parent.mkdir(exist_ok=True)
            target.write_bytes(raw)
            self.videos.append({'bvid': identity, 'slug':'sample', 'episode':1, 'title':identity,
                                'output': output, 'output_size': len(raw),
                                'output_sha256': hashlib.sha256(raw).hexdigest()})
        self.save_manifest()

    def save_manifest(self, complete=True):
        (self.text / (extract.SOURCE + '-manifest.json')).write_text(json.dumps({'complete': complete, 'videos': self.videos}))

    def export(self, ids=None, manifest_only=False):
        with patch.object(ray, 'CEPH', str(self.root)), contextlib.redirect_stdout(io.StringIO()) as logs:
            exec(ray.export_source(ids, manifest_only), {})
        return logs.getvalue()

    def test_selected_export_roundtrips_and_does_not_export_unselected_text(self):
        logs = self.export(['selected'])
        dest = self.root / 'received'
        self.assertEqual(ray.receive(logs, dest), 2)
        self.assertEqual((dest / self.videos[0]['output']).read_bytes(), (self.text / self.videos[0]['output']).read_bytes())
        self.assertFalse((dest / self.videos[1]['output']).exists())
        # Metadata is deliberately exported, but never the unselected document body.
        names = [json.loads(line[9:])['path'] for line in logs.splitlines() if line.startswith('W2_CHUNK ')]
        self.assertNotIn(self.videos[1]['output'], names)

    def test_unknown_duplicate_ids_and_incomplete_manifest_refused(self):
        for ids in (['unknown'], ['selected', 'selected']):
            with self.assertRaisesRegex(ValueError, 'unknown/duplicate'):
                self.export(ids)
        self.save_manifest(complete=False)
        with self.assertRaisesRegex(ValueError, 'incomplete extraction'):
            self.export(['selected'])

    def test_corrupt_output_hash_or_size_refused_before_any_chunks(self):
        target = self.text / self.videos[0]['output']
        original = target.read_bytes()
        for raw in (b'x' * len(original), original + b'extra'):
            target.write_bytes(raw)
            with self.assertRaisesRegex(ValueError, 'output checksum'):
                self.export(['selected'])

    def test_export_refuses_traversal_and_outside_symlink(self):
        outside = self.root / 'outside.json'
        outside.write_bytes(b'private synthetic')
        for output in ('../../outside.json', str(outside)):
            self.videos[0]['output'] = output
            self.save_manifest()
            with self.assertRaisesRegex(ValueError, 'unsafe output'):
                self.export(['selected'])
        link = self.text / 'outside-link.json'
        link.symlink_to(outside)
        self.videos[0]['output'] = link.name
        self.save_manifest()
        with self.assertRaisesRegex(ValueError, 'unsafe output'):
            self.export(['selected'])

    def test_receive_detects_corrupt_chunk_hash(self):
        lines = self.export(['selected']).splitlines()
        item = json.loads(lines[0][9:])
        item['chunk_sha256'] = '0' * 64
        lines[0] = 'W2_CHUNK ' + json.dumps(item)
        dest = self.root / 'bad-received'
        with self.assertRaisesRegex(ValueError, 'chunk checksum'):
            ray.receive('\n'.join(lines), dest)
        self.assertFalse(any(dest.rglob('*.json')))

    def test_search_concordance_executes_with_casefolded_hits_and_context(self):
        rows = [{'text':text, 'start':i, 'end':i+1} for i,text in enumerate(
            ['before two', 'before one', 'EDITING selection.', 'after one', 'after two', 'out of context'])]
        raw = json.dumps({'sentences':rows}).encode()
        v = self.videos[0]
        (self.text / v['output']).write_bytes(raw)
        v.update(output_size=len(raw), output_sha256=hashlib.sha256(raw).hexdigest())
        self.save_manifest()
        with patch.object(ray, 'CEPH', str(self.root)), contextlib.redirect_stdout(io.StringIO()) as logs:
            exec(ray.search_source(['editing']), {})
        dest = self.root / 'search-received'
        self.assertEqual(ray.receive(logs.getvalue(), dest), 2)
        concordance = json.loads((dest / 'concordance.json').read_text())
        self.assertEqual([row['index'] for row in concordance[0]['rows']], [0,1,2,3,4])
        self.assertEqual([row['index'] for row in concordance[0]['rows'] if row['hit']], [2])
        self.assertEqual(concordance[1]['rows'], [])
        self.assertFalse((dest / v['output']).exists())
        for terms in ([], [''], [1]):
            with self.assertRaisesRegex(ValueError, 'nonempty search'):
                ray.search_source(terms)


class ExtractionPathTests(unittest.TestCase):
    def test_audited_rejects_part_files_and_symlinks_outside_raw(self):
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            raw = root / extract.SOURCE / 'raw'
            raw.mkdir(parents=True)
            outside = root / 'outside.srt'
            outside.write_bytes(b'synthetic')
            (raw / 'link.srt').symlink_to(outside)
            (raw / 'waiting.srt.part').write_bytes(b'synthetic')
            f = {'bvid':'synthetic', 'size':9, 'sha256':hashlib.sha256(b'synthetic').hexdigest()}
            for name in ('link.srt', 'waiting.srt.part', '../../outside.srt'):
                with self.assertRaisesRegex(ValueError, 'unsafe input'):
                    extract.audited(root, dict(f, remote_rel=name))

    def test_extract_refuses_course_output_symlink_before_writing(self):
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            raw = b'1\n00:00:01,000 --> 00:00:02,000\nSynthetic.\n'
            f = extract.select({'files':[{'source':extract.SOURCE,
                'remote_rel':'courses/04-大师课/Magnum-The Art of Street Photography/01 Synthetic.srt',
                'size':len(raw), 'sha256':hashlib.sha256(raw).hexdigest()}]})[0]
            source = root / extract.SOURCE / 'raw' / f['remote_rel']
            source.parent.mkdir(parents=True)
            source.write_bytes(raw)
            text = root / extract.SOURCE / 'text'
            text.mkdir()
            outside = root / 'outside'
            outside.mkdir()
            (text / f['slug']).symlink_to(outside, target_is_directory=True)
            with self.assertRaisesRegex(ValueError, 'unsafe output'):
                extract.extract(root, [f])
            self.assertEqual(list(outside.iterdir()), [])
            self.assertEqual(source.read_bytes(), raw)



_import_private_environment.__exit__(None, None, None)


def setUpModule():
    global _running_private_environment
    _running_private_environment = _configured_private_environment()
    _running_private_environment.__enter__()


def tearDownModule():
    _running_private_environment.__exit__(None, None, None)

if __name__ == '__main__':
    unittest.main()
