"""Offline checks for packaged and Ceph-backed teacher image requests."""
import base64
import importlib.util
import io
import json
import os
import tempfile
import unittest
import zipfile
from pathlib import Path
from unittest.mock import patch


def load_script(name):
    spec = importlib.util.spec_from_file_location(name.replace('-', '_'), Path(__file__).with_name(name + '.py'))
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


worker = load_script('aihub-ray-worker')
submitter = load_script('aihub-ray')


class ImageResolutionTest(unittest.TestCase):
    def setUp(self):
        self.temporary = tempfile.TemporaryDirectory()
        self.addCleanup(self.temporary.cleanup)
        self.root = Path(self.temporary.name)
        self.package = self.root / 'package'
        self.ceph = self.root / 'ceph'
        self.images = self.ceph / 'observe' / 'openimages-v1'
        self.config = {'imageRoot': 'observe/openimages-v1'}
        (self.package / 'images').mkdir(parents=True)
        (self.images / 'full').mkdir(parents=True)
        (self.package / 'images' / 'local.jpg').write_bytes(b'packaged jpeg')
        (self.images / 'full' / 'sample.jpg').write_bytes(b'remote jpeg')
        here = patch.object(worker, 'HERE', self.package)
        here.start()
        self.addCleanup(here.stop)
        environment = patch.dict(os.environ, {'ECP_CEPH_ROOT': str(self.ceph)}, clear=True)
        environment.start()
        self.addCleanup(environment.stop)

    def body(self, name):
        return {'messages': [{'role': 'user', 'content': [{'type': 'image_url', 'image_file': name}]}]}

    def test_packaged_image_still_resolves_without_ceph(self):
        with patch.dict(os.environ, {}, clear=True):
            body = worker.resolve(self.body('images/local.jpg'))
        part = body['messages'][0]['content'][0]
        self.assertNotIn('image_file', part)
        self.assertEqual(part['image_url']['url'], 'data:image/jpeg;base64,' + base64.b64encode(b'packaged jpeg').decode())

    def test_remote_image_resolves_relative_to_configured_subdirectory(self):
        body = worker.resolve(self.body('full/sample.jpg'), self.config)
        self.assertEqual(body['messages'][0]['content'][0]['image_url']['url'],
                         'data:image/jpeg;base64,' + base64.b64encode(b'remote jpeg').decode())

    def test_image_file_rejects_traversal_absolute_and_non_jpeg(self):
        invalid = ['', None, 3, '../sample.jpg', 'full/../../sample.jpg', 'full/./sample.jpg',
                   'full//sample.jpg', str(self.images / 'full/sample.jpg'), 'full\\sample.jpg',
                   'full/sample.png', 'full/sample.JPG', 'full/sample.jpg?query']
        for name in invalid:
            for config in ({}, self.config):
                with self.subTest(name=name, config=config), self.assertRaises(ValueError):
                    worker.resolve(self.body(name), config)

    def test_image_root_rejects_traversal_absolute_and_empty_values(self):
        invalid = ['', '.', None, 3, '../observe', 'observe/../other', 'observe//other',
                   str(self.images), 'observe\\other']
        for root in invalid:
            with self.subTest(root=root), self.assertRaises(ValueError):
                worker.resolve(self.body('full/sample.jpg'), {'imageRoot': root})

    def test_remote_root_requires_absolute_ceph_environment(self):
        for environment in ({}, {'ECP_CEPH_ROOT': 'relative'}):
            with self.subTest(environment=environment), patch.dict(os.environ, environment, clear=True):
                with self.assertRaises(ValueError):
                    worker.resolve(self.body('full/sample.jpg'), self.config)

    def test_remote_root_symlink_cannot_escape_ceph(self):
        (self.ceph / 'escape').symlink_to(self.package, target_is_directory=True)
        with self.assertRaises(ValueError):
            worker.resolve(self.body('images/local.jpg'), {'imageRoot': 'escape'})

    def test_remote_file_symlink_cannot_escape_image_root(self):
        (self.images / 'full' / 'escape.jpg').symlink_to(self.package / 'images/local.jpg')
        with self.assertRaises(ValueError):
            worker.resolve(self.body('full/escape.jpg'), self.config)

    def test_remote_directory_symlink_cannot_escape_image_root(self):
        (self.images / 'escape').symlink_to(self.package / 'images', target_is_directory=True)
        with self.assertRaises(ValueError):
            worker.resolve(self.body('escape/local.jpg'), self.config)

    def test_packaged_file_cannot_escape_images(self):
        (self.package / 'outside.jpg').write_bytes(b'outside')
        (self.package / 'images' / 'escape.jpg').symlink_to(self.package / 'outside.jpg')
        for name in ('outside.jpg', 'images/escape.jpg'):
            with self.subTest(name=name), self.assertRaises(ValueError):
                worker.resolve(self.body(name))

    def test_runner_passes_image_root_to_resolution(self):
        runner = worker.Runner({'url': 'unused', 'key': 'unused'}, {**self.config, 'pauseSeconds': 0})
        with patch.object(worker, 'call', return_value={'choices': [{'message': {'content': 'ok'}}]}) as call:
            result = runner.run({'id': 'remote', 'body': {**self.body('full/sample.jpg'), 'model': 'offline'}})
        self.assertEqual(result['status'], 200)
        self.assertTrue(call.call_args.args[2]['messages'][0]['content'][0]['image_url']['url'].startswith('data:image/jpeg;'))


class JobEnvironmentTest(unittest.TestCase):
    def test_packaged_job_does_not_read_or_forward_ceph_root(self):
        with patch.object(submitter, 'setting', return_value='') as setting:
            environment = submitter.job_environment({})
        self.assertNotIn('ECP_CEPH_ROOT', environment)
        self.assertEqual(setting.call_args_list[0].args, ('ECP_HTTP_PROXY', ''))
        self.assertEqual(setting.call_count, 1)

    def test_remote_job_only_reads_proxy_and_ceph_root(self):
        with tempfile.TemporaryDirectory() as directory:
            with patch.object(submitter, 'setting', side_effect=['', directory]) as setting:
                environment = submitter.job_environment({'imageRoot': 'observe/openimages-v1'})
            self.assertEqual(environment['ECP_CEPH_ROOT'], directory)
        self.assertEqual(setting.call_args_list[1].args, ('ECP_CEPH_ROOT',))
        self.assertEqual(setting.call_args_list[1].kwargs, {'required': True})
        self.assertFalse(any('AIHUB' in name or 'KEY' in name for name in environment))

    def test_remote_job_rejects_relative_ceph_root(self):
        with patch.object(submitter, 'setting', side_effect=['', 'relative']):
            with self.assertRaises(ValueError):
                submitter.job_environment({'imageRoot': 'observe/openimages-v1'})

    def test_key_only_travels_in_package_secret(self):
        with tempfile.TemporaryDirectory() as directory:
            work = Path(directory)
            (work / 'requests.jsonl').write_text('')
            (work / 'config.json').write_text(json.dumps({'imageRoot': 'observe/openimages-v1'}))
            fake = {'ECP_AIHUB_URL': 'https://example.invalid/chat', 'ECP_AIHUB_KEY': 'offline-test-only'}
            with patch.dict(os.environ, fake, clear=True):
                content = submitter.package(work)
            with zipfile.ZipFile(io.BytesIO(content)) as archive:
                self.assertEqual(json.loads(archive.read('secret.json')), {'url': fake['ECP_AIHUB_URL'], 'key': fake['ECP_AIHUB_KEY']})
                for name in archive.namelist():
                    if name != 'secret.json':
                        self.assertNotIn(fake['ECP_AIHUB_KEY'].encode(), archive.read(name))


if __name__ == '__main__':
    unittest.main()
