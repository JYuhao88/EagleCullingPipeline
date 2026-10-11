import sys as _test_sys
from pathlib import Path as _TestPath
_test_sys.path.insert(0, str(_TestPath(__file__).resolve().parents[2]))

from ml.common.private_env_test_fixture import configured_private_environment as _configured_private_environment
_import_private_environment = _configured_private_environment()
_import_private_environment.__enter__()

import contextlib
import hashlib
import io
import json
from pathlib import Path
import tempfile
import unittest
from unittest.mock import Mock, patch
import zipfile

import upload_to_ceph as upload


class UploadTests(unittest.TestCase):
    def setUp(self):
        self.temporary = tempfile.TemporaryDirectory()
        self.root = Path(self.temporary.name)
        self.addCleanup(self.temporary.cleanup)
        self.patch = patch.object(upload, 'TEMP', self.root / 'state')
        self.patch.start()
        self.addCleanup(self.patch.stop)

    def file(self, name='example.mp4', data=b'abcdefghijk'):
        path = self.root / name
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_bytes(data)
        return {'local': str(path), 'remote_rel': name, 'source': 'test',
                'size': len(data), 'sha256': hashlib.sha256(data).hexdigest()}

    def uploader(self, files):
        result = upload.Uploader('test', files, Mock(), self.root / 'receipts')
        self.addCleanup(result.lock.close)
        return result

    def test_chunk_budget_offsets_and_final(self):
        item = self.file()
        batches = list(upload.chunks([item], {}, 4))
        self.assertEqual([batch[0]['length'] for batch in batches], [4, 4, 3])
        self.assertEqual([batch[0]['offset'] for batch in batches], [0, 4, 8])
        self.assertEqual([batch[0]['final'] for batch in batches], [False, False, True])
        self.assertEqual(list(upload.chunks([item], {item['remote_rel']: 11}, 4)), [])

    def test_batch_spans_files_and_resumes(self):
        first, second = self.file('first.mp4', b'12345'), self.file('second.mp4', b'6789')
        batches = list(upload.chunks([first, second], {'first.mp4': 3}, 4))
        self.assertEqual([sum(chunk['length'] for chunk in batch) for batch in batches], [4, 2])
        self.assertEqual(batches[0][0]['offset'], 3)

    def test_batch_entry_limit(self):
        files = [self.file(f'small-{index}.srt', b'x') for index in range(5)]
        batches = list(upload.chunks(files, {}, 1024, max_entries=2))
        self.assertEqual([len(batch) for batch in batches], [2, 2, 1])

    def test_zero_size(self):
        self.assertTrue(list(upload.chunks([self.file(data=b'')], {}))[0][0]['final'])

    def test_zip_contains_exact_slices(self):
        item = self.file()
        batch = next(upload.chunks([item], {'example.mp4': 3}, 4))
        path = self.root / 'package.zip'
        entries = upload.build_zip(path, batch, 'unique-owner')
        with zipfile.ZipFile(path) as archive:
            self.assertEqual(archive.read('chunk-0'), b'defg')
            self.assertEqual(archive.read('owner.txt'), b'unique-owner')
            self.assertIn('worker.py', archive.namelist())
        self.assertEqual(entries[0]['chunk_sha256'], hashlib.sha256(b'defg').hexdigest())

    def test_state_reconcile_remote_ahead_and_behind(self):
        item = self.file()
        uploader = self.uploader([item])
        uploader.state['offsets'] = {'example.mp4': 9}
        remote = [{'remote_rel': 'example.mp4', 'complete': False, 'size': 4,
                   'sha256': upload.digest(item['local'], 4)}]
        self.assertEqual(uploader.reconcile(remote)['example.mp4'], 4)
        remote[0].update(size=8, sha256=upload.digest(item['local'], 8))
        self.assertEqual(uploader.reconcile(remote)['example.mp4'], 8)
        self.assertEqual(json.loads(uploader.state_path.read_text())['offsets']['example.mp4'], 8)

    def test_corrupt_remote_prefix_rejected(self):
        item = self.file()
        uploader = self.uploader([item])
        with self.assertRaisesRegex(ValueError, 'prefix'):
            uploader.reconcile([{'remote_rel': 'example.mp4', 'complete': False, 'size': 4, 'sha256': 'bad'}])

    def test_changed_manifest_state_rejected(self):
        item = self.file()
        uploader = self.uploader([item])
        uploader.lock.close()
        item['sha256'] = 'bad'
        with self.assertRaisesRegex(ValueError, 'manifest changed'):
            self.uploader([item])

    def test_moved_local_file_keeps_state(self):
        item = self.file()
        uploader = self.uploader([item])
        uploader.state['offsets'] = {'example.mp4': 4}
        uploader.persist()
        uploader.lock.close()
        moved = self.root / 'moved' / 'example.mp4'
        moved.parent.mkdir()
        Path(item['local']).rename(moved)
        resumed = self.uploader([{**item, 'local': str(moved)}])
        self.assertEqual(resumed.state['offsets'], {'example.mp4': 4})

    def test_path_traversal_and_changed_local_rejected(self):
        for name in ('../escape', '/absolute', 'bad\\path', 'file.part'):
            with self.assertRaises(ValueError):
                upload.safe_relative(name)
        item = self.file()
        Path(item['local']).write_bytes(b'changed')
        with self.assertRaises(ValueError):
            upload.validate_files([item])

    def test_plan_allowlist_encrypted_and_duplicates(self):
        self.file('拍照姿势教学课程_韩晶/1.mp4')
        self.file('拍照姿势教学课程_韩晶/danger.exe')
        self.file('林海音/林海音：商业人像摄影课/1.vip.mp4', b'duplicate')
        self.file('林海音/林海音/林/copy.mp4', b'duplicate')
        self.file('林海音/林海音第三期/locked.vip')
        self.file('摄影/拍照姿势.pdf')
        self.file('摄影/摄影必修课（套装4册）.pdf')
        manifest = upload.plan(self.root, probe=False)
        self.assertEqual(len(manifest['files']), 3)
        duplicates = [item for item in manifest['skipped'] if 'duplicate_of' in item]
        self.assertEqual(len(duplicates), 1)
        self.assertIn('SHA-256', duplicates[0]['reason'])
        self.assertTrue(any('encrypted' in item['reason'] for item in manifest['skipped']))
        Path(duplicates[0]['local']).write_bytes(b'different')
        with self.assertRaisesRegex(ValueError, 'duplicate not verified'):
            upload.plan(self.root, probe=False)

    def test_plan_ffprobe_metadata(self):
        self.file('拍照姿势教学课程_韩晶/1.mp4')
        response = Mock(stdout=json.dumps({'format': {'duration': '12.5'},
                                          'streams': [{'codec_type': 'video', 'codec_name': 'h264'}]}), stderr='')
        with patch.object(upload.subprocess, 'run', return_value=response) as probe:
            manifest = upload.plan(self.root)
        self.assertEqual(manifest['files'][0]['duration_seconds'], 12.5)
        self.assertEqual(probe.call_args.args[0][0], 'ffprobe')

    def test_mock_http_cpu_job_and_owned_deletion(self):
        uploader = self.uploader([self.file()])
        def request(method, path, body=None):
            if method == 'POST':
                self.assertEqual(body['entrypoint_num_cpus'], 1)
                self.assertEqual(body['entrypoint_num_gpus'], 0)
                return {'job_id': body['submission_id']}
            if path.endswith('/logs'):
                return {'logs': 'UPLOAD_RESULT []\n'}
            return {'status': 'SUCCEEDED'}
        uploader.http.request.side_effect = request
        self.assertEqual(uploader.run_job('inspect'), [])
        job = uploader.state['jobs'][0]
        uploader.http.request.assert_any_call('DELETE', '/api/jobs/' + job['id'])
        self.assertTrue(job['deleted'])

    def test_mock_put_stream_and_proxy_free(self):
        path = self.root / 'tiny.zip'
        path.write_bytes(b'zip')
        response = Mock(status=200)
        response.read.return_value = b'{}'
        connection = Mock()
        connection.getresponse.return_value = response
        with patch.object(upload.http.client, 'HTTPConnection', return_value=connection):
            result = upload.HTTP('http://ray:8081').upload(path, '_ray_pkg_owned.zip')
        connection.putrequest.assert_called_once_with('PUT', '/api/packages/gcs/_ray_pkg_owned.zip')
        connection.send.assert_called_once_with(b'zip')
        self.assertEqual(result['bytes'], 3)

    def test_completed_remote_file_skips_put_and_is_audited(self):
        item = self.file()
        uploader = self.uploader([item])
        uploader.http.dashboard = 'http://mock-ray'
        uploader.http.request.side_effect = lambda method, path, body=None: (
            {'ray_version': '2.51.1'} if path == '/api/version' else [])
        observed = [{'remote_rel': item['remote_rel'], 'complete': True,
                     'size': item['size'], 'sha256': item['sha256']}]
        with patch.object(uploader, 'run_job', side_effect=[observed, observed, []]) as job, patch.object(upload.time, 'sleep'):
            uploader.upload()
        uploader.http.upload.assert_not_called()
        self.assertEqual(job.call_args_list[1].args[0], 'audit')
        self.assertEqual(uploader.state['status'], 'complete')
        self.assertEqual(json.loads(uploader.receipt.read_text())['ray_version'], '2.51.1')

    def test_resurrected_owned_record_redeleted_not_other_jobs(self):
        item = self.file()
        uploader = self.uploader([item])
        uploader.http.dashboard = 'http://mock-ray'
        observed = [{'remote_rel': item['remote_rel'], 'complete': True,
                     'size': item['size'], 'sha256': item['sha256']}]
        counter = [0]
        def request(method, path, body=None):
            if path == '/api/version':
                return {'ray_version': '2.51.1'}
            if path == '/api/jobs/':
                counter[0] += 1
                other = {'submission_id': 'someone-else', 'status': 'RUNNING'}
                return [other, {'submission_id': 'owned', 'status': 'FAILED'}] if counter[0] == 1 else [other]
            return {}
        uploader.http.request.side_effect = request
        def job(action, **kwargs):
            if action == 'inspect':
                uploader.state['jobs'].append({'id': 'owned', 'deleted': True})
                return observed
            return observed if action == 'audit' else []
        with patch.object(uploader, 'run_job', side_effect=job), patch.object(upload.time, 'sleep'):
            uploader.upload()
        uploader.http.request.assert_any_call('DELETE', '/api/jobs/owned')
        self.assertEqual(uploader.state['redeleted_job_records'], ['owned'])
        self.assertEqual(uploader.state['cleanup_stable_empty_checks'], 3)
        self.assertFalse(any(call.args[:2] == ('DELETE', '/api/jobs/someone-else') for call in uploader.http.request.call_args_list))

    def test_worker_partial_finalize_and_audit(self):
        item = self.file(data=b'complete')
        target = self.root / 'ceph/test/raw/example.mp4'
        target.parent.mkdir(parents=True)
        part = Path(str(target) + '.part')
        part.write_bytes(b'complete')
        config = {'root': str(self.root / 'ceph'), 'files': [item], 'action': 'inspect'}
        with contextlib.redirect_stdout(io.StringIO()):
            exec(upload.WORKER, {'config': config})
        self.assertTrue(target.exists())
        self.assertFalse(part.exists())
        for directory in (target.parent, target.parent.parent, target.parent.parent.parent):
            directory.chmod(0o700)
        config['action'] = 'audit'
        with contextlib.redirect_stdout(io.StringIO()):
            exec(upload.WORKER, {'config': config})
        target.write_bytes(b'corrupt')
        with self.assertRaises(ValueError):
            exec(upload.WORKER, {'config': config})

    def test_worker_refuses_part_symlink(self):
        item = self.file()
        target = self.root / 'ceph/test/raw/example.mp4'
        target.parent.mkdir(parents=True)
        Path(str(target) + '.part').symlink_to(item['local'])
        config = {'root': str(self.root / 'ceph'), 'files': [item], 'action': 'inspect'}
        with self.assertRaisesRegex(ValueError, 'symlink'):
            exec(upload.WORKER, {'config': config})



_import_private_environment.__exit__(None, None, None)


def setUpModule():
    global _running_private_environment
    _running_private_environment = _configured_private_environment()
    _running_private_environment.__enter__()


def tearDownModule():
    _running_private_environment.__exit__(None, None, None)

if __name__ == '__main__':
    unittest.main()
