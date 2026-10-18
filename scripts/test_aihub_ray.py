"""Offline checks for packaged and Ceph-backed teacher image requests."""
import base64
import importlib.util
import io
import json
import os
import tempfile
import threading
import unittest
import urllib.error
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


class StrictRateLimitTest(unittest.TestCase):
    def runner(self, **changes):
        config = {'strictBudget': True, 'transportPolicy': 'single-request-v1', 'inputTokenReserve': 16000,
                  'budgetCny': 1, 'pauseSeconds': 0, 'rateLimitPolicy': 'unprocessed-429-v1',
                  'rateLimitRetries': 4, 'rateLimitBackoffSeconds': 2, 'rateLimitBackoffMaxSeconds': 5,
                  'pricing': {'offline': {'input': 1, 'output': 2, 'usdToCny': 7}}, **changes}
        return worker.Runner({'url': 'unused', 'key': 'unused'}, config)

    def row(self, identity='one'):
        return {'id': identity, 'body': {'model': 'offline', 'max_completion_tokens': 3000,
                                      'messages': [{'role': 'user', 'content': '核验'}]}}

    def limited(self):
        return urllib.error.HTTPError('unused', 429, 'not processed', {}, None)

    def success(self):
        return {'usage': {'prompt_tokens': 100, 'completion_tokens': 10},
                'choices': [{'message': {'content': '正确'}}]}

    def test_only_429_retries_same_request_and_accounts_one_possible_paid_attempt(self):
        runner = self.runner()
        with patch.object(worker, 'call', side_effect=[self.limited(), self.limited(), self.success()]) as call, \
                patch.object(worker.time, 'sleep') as sleep:
            result = runner.run(self.row())
        self.assertEqual(result['id'], 'one')
        self.assertEqual((result['status'], result['attempts'], result['httpAttempts'], result['transportAttempts']),
                         (200, 3, 3, 3))
        self.assertEqual((result['rejected429Attempts'], result['paidAttempts']), (2, 1))
        self.assertEqual(result['rateLimitPolicy'], 'unprocessed-429-v1')
        self.assertEqual([item.args[0] for item in sleep.call_args_list], [2, 4, 0])
        self.assertEqual(call.call_count, 3)
        self.assertTrue(all(item.args[2] == self.row()['body'] for item in call.call_args_list))
        self.assertAlmostEqual(runner.spent, runner.cost('offline', self.success()['usage']))

    def test_429_exhaustion_is_bounded_unprocessed_and_releases_its_reservation(self):
        runner = self.runner()
        with patch.object(worker, 'call', side_effect=self.limited()) as call, patch.object(worker.time, 'sleep') as sleep:
            result = runner.run(self.row())
        self.assertEqual(call.call_count, 5)
        self.assertEqual([item.args[0] for item in sleep.call_args_list], [2, 4, 5, 5])
        self.assertEqual((result['status'], result['attempts'], result['rejected429Attempts'], result['paidAttempts']),
                         (429, 5, 5, 0))
        self.assertEqual((result['costStatus'], result['reservedCny'], runner.spent), ('unprocessed_429', 0, 0))

    def test_other_http_network_and_json_errors_never_retry_or_release_unknown_spend(self):
        for error in [urllib.error.HTTPError('unused', status, 'failure', {}, None) for status in (400, 403, 407, 500, 503)] + [
                TimeoutError('hidden detail'), urllib.error.URLError('hidden detail'), ValueError('hidden detail')]:
            with self.subTest(error=type(error).__name__, status=getattr(error, 'code', None)):
                runner = self.runner()
                with patch.object(worker, 'call', side_effect=error) as call, patch.object(worker.time, 'sleep') as sleep:
                    result = runner.run(self.row())
                self.assertEqual(call.call_count, 1)
                self.assertEqual((result['attempts'], result['httpAttempts'], result['paidAttempts'], result['rejected429Attempts']),
                                 (1, 1, 1, 0))
                self.assertEqual(result['costStatus'], 'reserved_unknown')
                self.assertAlmostEqual(result['reservedCny'], runner.spent)
                self.assertGreater(runner.spent, 0)
                self.assertNotIn('hidden detail', json.dumps(result))
                sleep.assert_not_called()

    def test_timeout_after_429_is_one_possible_paid_attempt_and_keeps_one_reserve(self):
        runner = self.runner()
        with patch.object(worker, 'call', side_effect=[self.limited(), TimeoutError('hidden')]) as call, \
                patch.object(worker.time, 'sleep') as sleep:
            result = runner.run(self.row())
        self.assertEqual(call.call_count, 2)
        self.assertEqual((result['attempts'], result['rejected429Attempts'], result['paidAttempts']), (2, 1, 1))
        self.assertEqual(result['costStatus'], 'reserved_unknown')
        self.assertAlmostEqual(runner.spent, runner.cost('offline', {'prompt_tokens': 16000, 'completion_tokens': 3000}))
        self.assertEqual([item.args[0] for item in sleep.call_args_list], [2])

    def test_no_new_policy_config_keeps_one_http_attempt_and_429_does_not_switch_routes(self):
        runner = self.runner(rateLimitRetries=0)
        runner.routes = [None, 'offline-proxy']
        with patch.object(worker, 'call', side_effect=self.limited()) as call, patch.object(worker.time, 'sleep'):
            result = runner.run(self.row())
        self.assertEqual(call.call_count, 1)
        self.assertEqual((result['attempts'], result['paidAttempts'], result['rejected429Attempts']), (1, 0, 1))
        self.assertEqual(runner.routes, [None, 'offline-proxy'])
        self.assertEqual(worker.rate_limit_settings({}), (0, 2, 30))
        legacy = self.runner()
        for key in ('rateLimitPolicy', 'rateLimitRetries', 'rateLimitBackoffSeconds', 'rateLimitBackoffMaxSeconds'):
            legacy.config.pop(key)
        legacy = worker.Runner(legacy.secret, legacy.config)
        with patch.object(worker, 'call', side_effect=self.limited()) as call:
            result = legacy.run(self.row())
        self.assertEqual(call.call_count, 1)
        self.assertEqual(result['costStatus'], 'reserved_unknown')
        self.assertNotIn('rateLimitPolicy', result)
        self.assertNotIn('paidAttempts', result)

    def test_exhausted_unprocessed_request_does_not_consume_the_next_request_budget(self):
        runner = self.runner(budgetCny=.154, rateLimitRetries=1)
        with patch.object(worker, 'call', side_effect=[self.limited(), self.limited(), self.success()]), \
                patch.object(worker.time, 'sleep'):
            first, second = runner.run(self.row('first')), runner.run(self.row('second'))
        self.assertEqual(first['costStatus'], 'unprocessed_429')
        self.assertEqual((second['status'], second['paidAttempts']), (200, 1))
        self.assertAlmostEqual(runner.spent, runner.cost('offline', self.success()['usage']))

    def test_missing_usage_after_429_keeps_exactly_one_possible_paid_request_reserve(self):
        runner = self.runner()
        with patch.object(worker, 'call', side_effect=[self.limited(), {'choices': []}]), \
                patch.object(worker.time, 'sleep'):
            result = runner.run(self.row())
        self.assertEqual((result['status'], result['httpAttempts'], result['paidAttempts'], result['rejected429Attempts']),
                         (200, 2, 1, 1))
        self.assertEqual(result['costStatus'], 'reserved_unknown')
        self.assertAlmostEqual(runner.spent, result['reservedCny'])

    def test_retry_configuration_cannot_allow_unbounded_or_tight_loop_retries(self):
        for changes in [{'rateLimitRetries': -1}, {'rateLimitRetries': 7}, {'rateLimitRetries': True},
                        {'rateLimitRetries': 1.5}, {'rateLimitBackoffSeconds': 0},
                        {'rateLimitBackoffSeconds': float('nan')}, {'rateLimitBackoffSeconds': float('inf')},
                        {'rateLimitBackoffMaxSeconds': 61}, {'rateLimitBackoffMaxSeconds': 1},
                        {'rateLimitPolicy': 'retry-all'}]:
            with self.subTest(changes=changes), self.assertRaises(ValueError):
                self.runner(**changes)
        with self.assertRaises(ValueError):
            worker.rate_limit_settings({'rateLimitRetries': 1})

    def test_submitter_refuses_invalid_retry_configuration_before_reading_any_job_files(self):
        base = {'strictBudget': True, 'transportPolicy': 'single-request-v1', 'inputTokenReserve': 16000,
                'rateLimitPolicy': 'unprocessed-429-v1', 'rateLimitRetries': 4}
        for changes in [{'rateLimitRetries': 7}, {'rateLimitRetries': True}, {'rateLimitPolicy': 'retry-any-error'},
                        {'rateLimitBackoffSeconds': 0}, {'rateLimitBackoffMaxSeconds': 61}]:
            with self.subTest(changes=changes), patch.dict(os.environ, {'ECP_AIHUB_BUDGET_RMB': '2000'}, clear=True):
                with self.assertRaisesRegex(ValueError, 'HTTP429 retry policy'):
                    submitter.validate_w36_batch(Path('nonexistent-job'), {**base, **changes})


class TeacherSchedulingTest(unittest.TestCase):
    def test_slow_teacher_queue_does_not_block_an_independent_family(self):
        release, fast_done = threading.Event(), threading.Event()
        mutex, active, peaks, done = threading.Lock(), {}, {}, {}
        runner = type('Runner', (), {'config': {'rateLimitPolicy': worker.RATE_LIMIT_POLICY,
                                               'concurrency': {'slow': 1, 'fast': 1}}})()

        def one(row):
            model = row['body']['model']
            with mutex:
                active[model] = active.get(model, 0) + 1
                peaks[model] = max(peaks.get(model, 0), active[model])
            if model == 'slow':
                release.wait(3)
            with mutex:
                active[model] -= 1
                done[model] = done.get(model, 0) + 1
                if model == 'fast' and done[model] == 2:
                    fast_done.set()

        rows = [{'body': {'model': model}} for model in ('slow', 'slow', 'fast', 'fast')]
        thread = threading.Thread(target=worker.run_rows, args=(runner, rows, one))
        thread.start()
        try:
            self.assertTrue(fast_done.wait(2), 'fast family waited behind queued slow requests')
        finally:
            release.set()
            thread.join(3)
        self.assertFalse(thread.is_alive())
        self.assertEqual(done, {'slow': 2, 'fast': 2})
        self.assertEqual(peaks, {'slow': 1, 'fast': 1})


if __name__ == '__main__':
    unittest.main()
