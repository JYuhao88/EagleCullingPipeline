import sys as _test_sys
from pathlib import Path as _TestPath
_test_sys.path.insert(0, str(_TestPath(__file__).resolve().parents[2]))

from ml.common.private_env_test_fixture import configured_private_environment as _configured_private_environment
_import_private_environment = _configured_private_environment()
_import_private_environment.__enter__()

import contextlib
import io
import contextlib
import io
import json
import os
from pathlib import Path
import tempfile
import unittest
import zipfile

from backup_wulin_extracted import WORKER, build_package, manifest, manifest_digest


class BackupTests(unittest.TestCase):
    def test_package_contains_exact_manifest_and_detects_changed_input(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory) / 'extracted'
            episode = root / 'BV1example'
            episode.mkdir(parents=True)
            source = episode / '0001.json'
            source.write_text('{"verdict":"keep"}')
            (episode / 'transcript.txt').write_text('not selected')
            files = manifest(root)
            self.assertEqual([item['path'] for item in files], ['BV1example/0001.json'])
            package = Path(directory) / 'package.zip'
            build_package(root, package, files, 'test-owner')
            with zipfile.ZipFile(package) as archive:
                self.assertEqual(json.loads(archive.read('manifest.json')), files)
                self.assertEqual(archive.read('payload/BV1example/0001.json'), source.read_bytes())
                self.assertNotIn('payload/BV1example/transcript.txt', archive.namelist())
            self.assertEqual(len(manifest_digest(files)), 64)
            source.write_text('{}')
            with self.assertRaisesRegex(ValueError, 'source changed'):
                build_package(root, package, files, 'test-owner')

    def test_worker_verifies_destination_and_rejects_conflict(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory) / 'source'
            root.mkdir()
            (root / '0001.json').write_text('{}')
            files = manifest(root)
            package = Path(directory) / 'package.zip'
            build_package(root, package, files, 'test')
            working = Path(directory) / 'working'
            working.mkdir()
            with zipfile.ZipFile(package) as archive:
                archive.extractall(working)
            remote = Path(directory) / 'remote'
            cwd = Path.cwd()
            try:
                os.chdir(working)
                output = io.StringIO()
                with contextlib.redirect_stdout(output):
                    exec(WORKER, {'config': {'remote': str(remote), 'token': 'test'}})
                result = json.loads(output.getvalue().split('BACKUP_RESULT ', 1)[1])
                self.assertEqual(result['manifest_sha256'], manifest_digest(files))
                self.assertEqual((remote / '0001.json').read_text(), '{}')
                self.assertEqual(list(remote.glob('*.part')), [])
                (remote / '0001.json').write_text('{"changed":true}')
                with self.assertRaisesRegex(ValueError, 'existing destination differs'):
                    exec(WORKER, {'config': {'remote': str(remote), 'token': 'test'}})
            finally:
                os.chdir(cwd)

    def test_rejects_symlink_and_empty_source(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            with self.assertRaisesRegex(ValueError, 'no extracted'):
                manifest(root)
            (root / 'actual.txt').write_text('{}')
            (root / 'linked.json').symlink_to(root / 'actual.txt')
            with self.assertRaisesRegex(ValueError, 'regular contained'):
                manifest(root)


_import_private_environment.__exit__(None, None, None)


def setUpModule():
    global _running_private_environment
    _running_private_environment = _configured_private_environment()
    _running_private_environment.__enter__()


def tearDownModule():
    _running_private_environment.__exit__(None, None, None)

if __name__ == '__main__':
    unittest.main()
