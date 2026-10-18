import importlib.util
import contextlib
import io
import hashlib
import json
from pathlib import Path
import tempfile
import unittest
import zipfile
from types import SimpleNamespace
from unittest.mock import patch

from PIL import Image

SPEC = importlib.util.spec_from_file_location('encoder_submit', Path(__file__).with_name('observe-encoder-ray.py'))
submit = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(submit)


class EncoderSubmissionTest(unittest.TestCase):
    def test_package_pins_exact_data_bytes_and_includes_no_full_images(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            cache = root / 'observe'
            oi = root / 'observe-oi'
            oi.mkdir()
            (oi / 'manifest.jsonl').write_text(json.dumps({'id': 'a' * 16, 'face': 'face/test.jpg'}) + '\n')
            for group in ('p0', 'p1-panel', 'p1-oi'):
                source = cache / group
                source.mkdir(parents=True)
                (source / 'labels.jsonl').write_text('{}\n')
                if group == 'p1-oi':
                    continue
                Image.new('RGB', (16, 16)).save(source / 'face.jpg')
                (source / 'items.jsonl').write_text(json.dumps({'id': group,
                    'images': {'face': 'face.jpg', 'full': 'original.jpg'}}) + '\n')
            config = {}
            content = submit.package(config, cache)
            with zipfile.ZipFile(io.BytesIO(content)) as archive:
                packed = json.loads(archive.read('encoder-config.json'))
                self.assertEqual(packed['inputSha256'], config['inputSha256'])
                self.assertEqual(len(packed['inputSha256']), 10)
                for name, checksum in packed['inputSha256'].items():
                    self.assertEqual(hashlib.sha256(archive.read(name)).hexdigest(), checksum)
                self.assertFalse(any('original.jpg' in name for name in archive.namelist()))

    def test_admission_sleeps_five_minutes_without_holding_lock(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            config = root / 'config.json'
            config.write_text('{}')
            args = SimpleNamespace(config=config, cache=root, output=root / 'out', timeout=60, admission_timeout=14400)
            occupied = [{'submission_id': 'w1-a', 'status': 'RUNNING'},
                        {'submission_id': 'w39-b', 'status': 'PENDING'}]
            calls, clock = [], [0.0]

            def request(path, body=None, **kwargs):
                calls.append((path, body))
                if path == '/api/jobs/' and body is None:
                    return occupied if sum(p == path and b is None for p, b in calls) == 1 else occupied[:1]
                return {}

            def sleep(seconds):
                self.assertEqual(seconds, 300)
                self.assertFalse(submit.LOCK.exists())
                clock[0] += seconds

            with patch.object(submit, 'LOCK', root / 'lock'), patch.object(submit, 'package', return_value=b'zip'), \
                    patch.object(submit, 'request', side_effect=request), patch.object(submit, 'setting', return_value=''), \
                    patch.object(submit, 'require_path', return_value='/storage'), \
                    patch.object(submit.time, 'monotonic', side_effect=lambda: clock[0]), \
                    patch.object(submit.time, 'sleep', side_effect=sleep), contextlib.redirect_stdout(io.StringIO()):
                job = submit.submit(args)
                self.assertTrue(job.startswith(submit.PREFIX))
                self.assertFalse(submit.LOCK.exists())
            submitted = [body for path, body in calls if path == '/api/jobs/' and body]
            self.assertEqual(len(submitted), 1)
            self.assertIn('onnxruntime-gpu[cuda,cudnn]==1.24.4', submitted[0]['runtime_env']['pip'])

    def test_admission_expires_without_submitting_when_slots_stay_full(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            config = root / 'config.json'
            config.write_text('{}')
            args = SimpleNamespace(config=config, cache=root, output=root / 'out', timeout=60, admission_timeout=600)
            occupied = [{'submission_id': 'w1-a', 'status': 'RUNNING'},
                        {'submission_id': 'w39-b', 'status': 'PENDING'}]
            clock, mutations = [0.0], []

            def request(path, body=None, **kwargs):
                if path == '/api/jobs/' and body:
                    mutations.append(body)
                return occupied if path == '/api/jobs/' else {}

            def sleep(seconds):
                self.assertFalse(submit.LOCK.exists())
                clock[0] += seconds

            with patch.object(submit, 'LOCK', root / 'lock'), patch.object(submit, 'package', return_value=b'zip'), \
                    patch.object(submit, 'request', side_effect=request), patch.object(submit, 'setting', return_value=''), \
                    patch.object(submit, 'require_path', return_value='/storage'), \
                    patch.object(submit.time, 'monotonic', side_effect=lambda: clock[0]), \
                    patch.object(submit.time, 'sleep', side_effect=sleep), contextlib.redirect_stdout(io.StringIO()):
                with self.assertRaises(TimeoutError):
                    submit.submit(args)
                self.assertFalse(submit.LOCK.exists())
            self.assertEqual(mutations, [])
            self.assertEqual(clock[0], 600)

    def test_shared_admission_counts_all_project_lines(self):
        jobs = [{'submission_id': name, 'status': status} for name, status in
                [('w1-a', 'RUNNING'), ('w39-a', 'PENDING'), ('w40-a', 'RUNNING'),
                 ('w33-a', 'SUCCEEDED'), ('unrelated', 'RUNNING')]]
        self.assertEqual([j['submission_id'] for j in submit.active_jobs(jobs)], ['w1-a', 'w39-a'])

    def test_only_own_job_ids_and_safe_feature_artifacts(self):
        self.assertEqual(submit.checked_job('w33-encoder-' + 'a' * 12), 'w33-encoder-' + 'a' * 12)
        for name in ('w31-embed-' + 'a' * 12, 'w33-encoder-../x', ''):
            with self.assertRaises(ValueError):
                submit.checked_job(name)
        for name in ('siglip2-base/fp32/oi.npz', 'dinov2-large/training-fp16.json'):
            self.assertIsNotNone(submit.ARTIFACT.fullmatch(name))
        for name in ('../oi.npz', '/tmp/oi.npz', 'siglip2-base/model.onnx'):
            self.assertIsNone(submit.ARTIFACT.fullmatch(name))

    def test_lock_release_checks_pid_and_line(self):
        with tempfile.TemporaryDirectory() as directory, patch.object(submit, 'LOCK', Path(directory) / 'lock'):
            submit.acquire_lock()
            marker = submit.LOCK / 'owner.json'
            owner = json.loads(marker.read_text())
            marker.write_text(json.dumps({**owner, 'pid': owner['pid'] + 1}))
            with self.assertRaises(RuntimeError):
                submit.release_lock()
            marker.write_text(json.dumps(owner))
            submit.release_lock()
            self.assertFalse(submit.LOCK.exists())

    def test_only_sanitized_bounded_crops_are_packaged(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            path = root / 'crop.jpg'
            Image.new('RGB', (384, 384)).save(path)
            rows = [{'id': 'one', 'images': {'face': 'crop.jpg'}}, {'id': 'no-face', 'images': {}}]
            self.assertEqual(len(submit.face_files(root, rows)), 1)
            Image.new('RGB', (769, 384)).save(path)
            with self.assertRaises(ValueError):
                submit.face_files(root, rows)
            exif = Image.Exif()
            exif[270] = 'private metadata'
            Image.new('RGB', (384, 384)).save(path, exif=exif)
            with self.assertRaises(ValueError):
                submit.face_files(root, rows)
            with self.assertRaises(ValueError):
                submit.face_files(root, [{'id': 'unsafe', 'images': {'face': '../crop.jpg'}}])


if __name__ == '__main__':
    unittest.main()
