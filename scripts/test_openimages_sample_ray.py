"""Offline checks for Open Images filtering, geometry, quotas and resumable pixel exports."""
import csv
import importlib.util
import io
import json
import os
import tempfile
import threading
import unittest
import zipfile
from collections import Counter
from pathlib import Path
from types import SimpleNamespace
from unittest.mock import Mock, patch

from PIL import Image

SPEC = importlib.util.spec_from_file_location('openimages_sample_ray', Path(__file__).with_name('openimages-sample-ray.py'))
SAMPLER = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(SAMPLER)


class OpenImagesSampleTests(unittest.TestCase):
    def setUp(self):
        self.temporary = tempfile.TemporaryDirectory(prefix='openimages-offline-')
        self.addCleanup(self.temporary.cleanup)
        self.root = Path(self.temporary.name)
        for folder in ('full', 'face', 'records'):
            (self.root / folder).mkdir()
        self.fetch = patch.object(SAMPLER, 'fetch', side_effect=AssertionError('Network forbidden in offline tests')).start()
        self.addCleanup(patch.stopall)
        patch.object(SAMPLER, 'emit').start()
        patch.object(SAMPLER.time, 'sleep').start()

    @staticmethod
    def image_row(image_id, **changes):
        return {'ImageID': image_id, 'License': SAMPLER.LICENSE, 'Author': 'Example',
                'OriginalURL': 'https://example.org/photo', 'Rotation': '0', **changes}

    @staticmethod
    def box_row(image_id, box=(.1, 0, .3, .1), label=None, **changes):
        x0, y0, x1, y1 = box
        return {'ImageID': image_id, 'LabelName': label or SAMPLER.FACE, 'Source': 'xclick', 'Confidence': '1',
                'XMin': x0, 'YMin': y0, 'XMax': x1, 'YMax': y1, 'IsGroupOf': '0', 'IsDepiction': '0', **changes}

    def candidate_rows(self, images, boxes):
        paths = {}
        for name, rows in (('images', images), ('boxes', boxes)):
            paths[name] = self.root / (name + '.csv')
            with paths[name].open('w', newline='') as stream:
                writer = csv.DictWriter(stream, fieldnames=list(rows[0]))
                writer.writeheader()
                writer.writerows(rows)
        stats = Counter()
        with patch.object(SAMPLER, 'metadata_file', side_effect=lambda root, split, kind, prefixes: paths[kind]):
            rows = SAMPLER.candidates(self.root, 'validation', '0', stats)
        return rows, stats

    def test_train_metadata_scans_unsorted_ids_and_reuses_cached_csv_without_network(self):
        rows = [self.image_row(image_id) for image_id in ('f0', '00', 'ef', '01')]
        csv_bytes = io.StringIO(newline='')
        writer = csv.DictWriter(csv_bytes, fieldnames=list(rows[0]))
        writer.writeheader()
        writer.writerows(rows)
        self.fetch.side_effect = lambda url: io.BytesIO(csv_bytes.getvalue().encode())
        target = SAMPLER.metadata_file(self.root, 'train', 'images', '0')
        with target.open(newline='') as stream:
            self.assertEqual([row['ImageID'] for row in csv.DictReader(stream)], ['00', '01'])
        self.fetch.reset_mock()
        self.fetch.side_effect = AssertionError('Cached metadata must not access network')
        self.assertEqual(SAMPLER.metadata_file(self.root, 'train', 'images', '0'), target)
        self.fetch.assert_not_called()

    def test_rotated_boxes_follow_actual_counterclockwise_pixels_at_90_and_270(self):
        source = Image.new('RGB', (100, 60), 'white')
        for x in range(10, 30):
            for y in range(12, 36):
                source.putpixel((x, y), (255, 0, 0))
        raw = io.BytesIO()
        source.save(raw, 'PNG')
        original_box = [.1, .2, .3, .6]
        for rotation, expected in ((90, [.2, .7, .6, .9]), (270, [.4, .1, .8, .3])):
            with self.subTest(rotation=rotation):
                box = SAMPLER.rotated_box(original_box, rotation)
                for actual, value in zip(box, expected):
                    self.assertAlmostEqual(actual, value)
                row = {'id': str(rotation), 'split': 'test', 'rotation': rotation, 'faceBox': box}
                self.fetch.side_effect = lambda url: io.BytesIO(raw.getvalue())
                saved, outcome = SAMPLER.prepare(row, self.root)
                self.assertEqual(outcome, 'downloaded')
                self.assertEqual(saved['sourceSize'], [60, 100])
                with Image.open(self.root / saved['full']) as image:
                    self.assertEqual(max(image.size), 768)
                    center = (round((box[0] + box[2]) * image.width / 2),
                              round((box[1] + box[3]) * image.height / 2))
                    red, green, blue = image.getpixel(center)
                    self.assertGreater(red, 230)
                    self.assertLess(max(green, blue), 30)
                    self.assertEqual(image.getpixel((0, 0)), (255, 255, 255))
                with Image.open(self.root / saved['face']) as image:
                    self.assertEqual(image.size, (384, 384))

    def test_views_are_reencoded_without_exif_icc_or_comments(self):
        source = Image.new('RGB', (100, 50), 'white')
        exif = Image.Exif()
        exif[270] = 'private description'
        raw = io.BytesIO()
        source.save(raw, 'JPEG', exif=exif, icc_profile=b'test-profile', comment=b'private comment')
        self.fetch.side_effect = lambda url: io.BytesIO(raw.getvalue())
        row = {'id': 'clean', 'split': 'test', 'rotation': 0, 'faceBox': [.1, .1, .3, .3]}
        saved, outcome = SAMPLER.prepare(row, self.root)
        self.assertEqual(outcome, 'downloaded')
        for kind in ('full', 'face'):
            with Image.open(self.root / saved[kind]) as image:
                self.assertFalse(image.getexif())
                self.assertFalse(image.info.get('icc_profile'))
                self.assertFalse(image.info.get('comment'))
        with Image.open(self.root / saved['full']) as image:
            self.assertEqual(image.size, (768, 384))

    def test_collect_rejects_incomplete_exports_and_preserves_existing_manifest(self):
        output = self.root / 'collected'
        output.mkdir()
        manifest = output / 'manifest.jsonl'
        manifest.write_text('existing manifest')
        with patch.object(SAMPLER, 'request', return_value={'logs': 'OI_PROGRESS {}'}):
            with self.assertRaisesRegex(ValueError, 'completed result'):
                SAMPLER.collect('offline', output)
        self.assertEqual(manifest.read_text(), 'existing manifest')
        with patch.object(SAMPLER, 'request', return_value={'logs': 'OI_DONE {}'}):
            with self.assertRaisesRegex(ValueError, 'Incomplete sample export'):
                SAMPLER.collect('offline', output)
        self.assertEqual(manifest.read_text(), 'existing manifest')

    def test_collect_supports_a_check_with_fewer_than_ten_pairs(self):
        SAMPLER.emit.reset_mock()
        source = self.root / 'preview'
        source.write_bytes(b'offline preview')
        names = ['check/0000000000000001-full.jpg', 'check/0000000000000001-face.jpg', 'check/check.json']
        for name in names:
            SAMPLER.export_file(source, name)
        logs = '\n'.join(tag + ' ' + json.dumps(row) for tag, row in (call.args for call in SAMPLER.emit.call_args_list))
        logs += '\nOI_CHECK_DONE ' + json.dumps({'pairs': 1, 'views': 2})
        output = self.root / 'collected'
        with patch.object(SAMPLER, 'request', return_value={'logs': logs}):
            SAMPLER.collect('offline', output)
        for name in names:
            self.assertEqual((output / name).read_bytes(), b'offline preview')

    def test_check_uses_packaged_resolver_for_ten_ceph_image_pairs(self):
        reader_source = Path(SAMPLER.__file__).with_name('aihub-ray-worker.py').read_bytes()
        (self.root / 'ceph-reader.py').write_bytes(reader_source)
        ceph = self.root / 'ceph'
        dataset = ceph / SAMPLER.IMAGE_ROOT
        for folder in ('full', 'face'):
            (dataset / folder).mkdir(parents=True)
        rows = []
        for index in range(10):
            image_id = format(index, '016x')
            box = [.25, .25, .75, .75]
            row = {'id': image_id, 'rotation': 0, 'stratum': 'large', 'sourceSize': [64, 64],
                   'faceBox': box, 'crop': SAMPLER.crop_geometry((64, 64), box),
                   'full': 'full/' + image_id + '.jpg', 'face': 'face/' + image_id + '.jpg'}
            for kind, size in (('full', (64, 64)), ('face', (384, 384))):
                Image.new('RGB', size, (index, 80, 160)).save(dataset / row[kind], 'JPEG')
            rows.append(row)
        (dataset / 'manifest.jsonl').write_text(''.join(json.dumps(row) + '\n' for row in rows))
        with patch.object(SAMPLER, '__file__', str(self.root / 'worker.py')), \
                patch.dict(os.environ, {'ECP_CEPH_ROOT': str(ceph)}, clear=True), \
                patch('urllib.request.OpenerDirector.open', side_effect=AssertionError('Model and network access forbidden')):
            SAMPLER.check(SimpleNamespace(seed=10), dataset)
        report = json.loads((dataset / 'check.json').read_text())
        self.assertEqual(len(report['pairs']), 10)
        self.assertTrue(all(row['resolverMatches'] for row in report['pairs']))
        self.assertTrue(all(view['resolverMatches'] for row in report['pairs'] for view in row['views'].values()))
        done = [call.args[1] for call in SAMPLER.emit.call_args_list if call.args[0] == 'OI_CHECK_DONE'][-1]
        self.assertEqual((done['pairs'], done['views'], done['resolverMatches']), (10, 20, True))

    def test_submit_packages_the_existing_ceph_reader_without_secrets(self):
        requests = []
        def request(path, body=None, data=None, method=None):
            requests.append((path, body, data, method))
            return [] if path == '/api/jobs/' and body is None else {}
        args = SimpleNamespace(timeout=60, mode='check', count=10, seed=10,
                               concurrency=1, train_prefixes='0', output=self.root / 'submitted')
        with patch.object(SAMPLER, 'request', side_effect=request), \
                patch('ml.common.private_env.setting', return_value=''), \
                patch('ml.common.private_env.require_path', return_value=str(self.root)):
            SAMPLER.submit(args)
        uploaded = next(data for path, body, data, method in requests if method == 'PUT')
        with zipfile.ZipFile(io.BytesIO(uploaded)) as archive:
            self.assertEqual(set(archive.namelist()), {'worker.py', 'ceph-reader.py'})
            self.assertEqual(archive.read('ceph-reader.py'), Path(SAMPLER.__file__).with_name('aihub-ray-worker.py').read_bytes())

    def test_crop_matches_photos_floor_round_and_frame_clamp(self):
        # Positive .5 rounds upward in JavaScript, unlike Python's ties-to-even round().
        self.assertEqual(SAMPLER.crop_geometry((100, 100), [.125, .125, .375, .375]), [3, 3, 45])
        # Preserve photos()'s raw IEEE-754 floor: this nominal 18-pixel side floors to 17 in JavaScript too.
        self.assertEqual(SAMPLER.crop_geometry((100, 100), [.4, .4, .5, .5]), [37, 37, 17])
        self.assertEqual(SAMPLER.crop_geometry((100, 60), [.9, .8, 1, 1]), [79, 39, 21])
        self.assertEqual(SAMPLER.crop_geometry((200, 100), [0, 0, 1, 1]), [50, 0, 100])
        with self.assertRaisesRegex(ValueError, 'Empty face crop'):
            SAMPLER.crop_geometry((1, 1), [0, 0, .01, .01])

    def test_five_eight_and_thirteen_percent_boundaries(self):
        images = [self.image_row(str(i)) for i in range(7)]
        heights = [(0, .049), (.4, .45), (.4, .4799), (.4, .48), (.4, .53), (.4, .5301), (0, .13)]
        boxes = [self.box_row(str(i), (.1, low, .3, high)) for i, (low, high) in enumerate(heights)]
        rows, stats = self.candidate_rows(images, boxes)
        self.assertEqual({row['id']: row['stratum'] for row in rows},
                         {'1': 'small', '2': 'small', '3': 'mid', '4': 'mid', '5': 'large', '6': 'mid'})
        self.assertEqual(stats['excludedImages:faceBelow5Percent'], 1)

    def test_license_human_box_filters_and_attribution_are_explicit(self):
        ids = ['good', 'license', 'depiction', 'group', 'source', 'confidence', 'geometry', 'rotation', 'author', 'url']
        images = [self.image_row(name) for name in ids]
        images[1]['License'] = 'https://creativecommons.org/licenses/by-sa/2.0/'
        images[7]['Rotation'] = '45'
        images[8]['Author'] = ' '
        images[9]['OriginalURL'] = ' '
        boxes = [self.box_row(name) for name in ids]
        for index, key, value in ((2, 'IsDepiction', '1'), (3, 'IsGroupOf', '1'),
                                  (4, 'Source', 'machine'), (5, 'Confidence', '0'), (6, 'XMax', '.05')):
            boxes[index][key] = value
        boxes += [self.box_row('good', label=SAMPLER.PERSON),
                  self.box_row('good', label=SAMPLER.PERSON, Source='activemil'),
                  self.box_row('good', label=SAMPLER.PERSON, IsGroupOf='1'),
                  self.box_row('good', label='/unrelated')]
        rows, stats = self.candidate_rows(images, boxes)
        self.assertEqual([row['id'] for row in rows], ['good'])
        self.assertEqual(len(rows[0]['persons']), 2)
        self.assertEqual(stats['excludedImages:licenseNotExplicitCCBY20'], 1)
        self.assertEqual(stats['excludedImages:noEligibleFace'], 5)
        self.assertEqual(stats['excludedImages:unknownRotation'], 1)
        self.assertEqual(stats['excludedImages:missingAttribution'], 2)
        self.assertEqual(stats['excludedBoxes:faces:depictionOrGroup'], 2)
        self.assertEqual(stats['excludedBoxes:faces:notHumanVerified'], 2)
        self.assertEqual(stats['excludedBoxes:faces:invalidGeometry'], 1)
        self.assertEqual(stats['excludedBoxes:persons:depictionOrGroup'], 1)
        self.assertEqual(stats['licenseValues'][SAMPLER.LICENSE], 9)

    def test_largest_face_and_size_threshold_use_upright_coordinates(self):
        rows, stats = self.candidate_rows([self.image_row('rotated', Rotation='90')], [
            self.box_row('rotated', (.1, .1, .16, .5)), self.box_row('rotated', (.3, .2, .5, .3))])
        self.assertEqual(stats['candidates'], 1)
        self.assertEqual(rows[0]['stratum'], 'large')
        expected = SAMPLER.rotated_box([.3, .2, .5, .3], 90)
        self.assertEqual(rows[0]['faceBox'], expected)

    def test_quota_balance_and_global_multi_person_minimum(self):
        self.assertEqual(SAMPLER.quotas(8000), {'small': 2667, 'mid': 2667, 'large': 2666})
        self.assertEqual(SAMPLER.quotas(2), {'small': 1, 'mid': 1, 'large': 0})
        rows = [{'stratum': key, 'persons': [[], []] if i < 3 else [[]]}
                for key in SAMPLER.STRATA for i in range(10)]
        self.assertTrue(SAMPLER.enough(rows, 30))
        self.assertFalse(SAMPLER.enough(rows[:-1], 30))
        rows[0]['persons'] = [[]]
        self.assertFalse(SAMPLER.enough(rows, 30))

    def test_multi_person_quota_moves_to_other_strata_when_portraits_lack_person_boxes(self):
        rows = [{'stratum': key, 'persons': [[], []] if i < multi else [[]]}
                for key, multi in [('small', 6), ('mid', 5), ('large', 0)] for i in range(10)]
        self.assertTrue(SAMPLER.enough(rows, 30))
        targets = SAMPLER.multi_quotas(rows, 30)
        self.assertEqual(targets, {'small': 6, 'mid': 3, 'large': 0})
        self.assertEqual(sum(targets.values()), 9)

    def test_resume_checks_saved_files_and_rotation_before_fetching(self):
        row = {'id': 'resume', 'split': 'validation', 'rotation': 0, 'faceBox': [.1, .1, .3, .3]}
        saved = {**row, 'full': 'full/resume.jpg', 'face': 'face/resume.jpg'}
        (self.root / saved['full']).write_bytes(b'cached-full')
        (self.root / saved['face']).write_bytes(b'cached-face')
        (self.root / 'records/resume.json').write_text(json.dumps(saved))
        result, outcome = SAMPLER.prepare(row, self.root)
        self.assertEqual((result, outcome), (saved, 'resumed'))
        self.fetch.assert_not_called()
        (self.root / saved['face']).unlink()
        self.assertEqual(SAMPLER.prepare(row, self.root)[1], 'failed')
        self.assertEqual(self.fetch.call_count, 4)
        (self.root / saved['face']).write_bytes(b'cached-face')
        self.fetch.reset_mock()
        self.assertEqual(SAMPLER.prepare({**row, 'rotation': 90}, self.root)[1], 'failed')
        self.assertEqual(self.fetch.call_count, 4)

    def test_resume_uses_current_metadata_after_stratum_boundary_correction(self):
        row = {'id': 'boundary', 'split': 'validation', 'rotation': 0, 'stratum': 'mid',
               'faceBox': [.4, .4, .5, .48]}
        stale = {**row, 'stratum': 'small', 'full': 'full/boundary.jpg', 'face': 'face/boundary.jpg'}
        for key in ('full', 'face'):
            (self.root / stale[key]).write_bytes(b'cached-view')
        (self.root / 'records/boundary.json').write_text(json.dumps(stale))
        result, outcome = SAMPLER.prepare(row, self.root)
        self.assertEqual(outcome, 'resumed')
        self.assertEqual(result['stratum'], 'mid')
        self.fetch.assert_not_called()

    def test_sample_preserves_balanced_targets_with_failures_and_resume(self):
        rows = []
        for key in SAMPLER.STRATA:
            for i in range(8):
                rows.append({'id': key + str(i), 'stratum': key, 'persons': [[], []] if i < 4 else [[]],
                             'split': 'validation', 'rotation': 0})
        args = SimpleNamespace(count=12, seed=10, train_prefixes='0', concurrency=2)
        def prepare(row, root):
            if row['id'].endswith('0'):
                return {'id': row['id'], 'error': 'offline fixture'}, 'failed'
            return {**row, 'full': 'full/' + row['id'] + '.jpg', 'face': 'face/' + row['id'] + '.jpg'}, 'resumed'
        def candidates(root, split, prefixes, stats):
            return rows if split == 'validation' else []
        with patch.object(SAMPLER, 'candidates', side_effect=candidates), \
                patch.object(SAMPLER, 'prepare', side_effect=prepare), patch.object(SAMPLER, 'export_file'):
            SAMPLER.sample(args, self.root)
        manifest = [json.loads(line) for line in (self.root / 'manifest.jsonl').read_text().splitlines()]
        self.assertEqual(Counter(row['stratum'] for row in manifest), {'small': 4, 'mid': 4, 'large': 4})
        self.assertEqual(len({row['id'] for row in manifest}), 12)
        self.assertGreaterEqual(sum(len(row['persons']) >= 2 for row in manifest), 6)
        summary = json.loads((self.root / 'summary.json').read_text())
        self.assertEqual(summary['outcomes']['resumed'], 12)
        self.assertEqual(summary['downloadFailures'], summary['outcomes'].get('failed', 0))
        self.assertGreater(summary['downloadFailures'], 0)
        self.fetch.assert_not_called()


class ImageFetchTests(unittest.TestCase):
    def setUp(self):
        self.url = SAMPLER.MIRROR.format(split='validation', id='0000000000000000')
        self.sessions = patch.object(SAMPLER, 'IMAGE_SESSIONS', threading.local())
        self.sessions.start()
        self.addCleanup(self.sessions.stop)

    def test_same_thread_reuses_session_and_fully_read_connection_returns_to_pool(self):
        import requests
        from urllib3.response import HTTPResponse
        responses, pools, connections = [], [], []
        for _ in range(2):
            pool, connection = Mock(), Mock()
            original = Mock()
            original.isclosed.return_value = True
            raw = HTTPResponse(body=io.BytesIO(b'jpeg-pixels'), preload_content=False,
                               pool=pool, connection=connection, original_response=original)
            response = requests.Response()
            response.status_code, response.url, response.raw = 200, self.url, raw
            responses.append(response)
            pools.append(pool)
            connections.append(connection)
        with patch('requests.Session') as factory, patch('urllib.request.urlopen') as urlopen:
            factory.return_value.get.side_effect = responses
            for _ in range(2):
                with SAMPLER.fetch(self.url) as stream:
                    self.assertEqual(stream.read(1024), b'jpeg-pixels')
            factory.assert_called_once_with()
            self.assertEqual(factory.return_value.get.call_count, 2)
            factory.return_value.get.assert_called_with(
                self.url, stream=True, timeout=90, headers={'Accept-Encoding': 'identity'})
            urlopen.assert_not_called()
        for pool, connection in zip(pools, connections):
            pool._put_conn.assert_called_once_with(connection)
            connection.close.assert_not_called()

    def test_status_redirect_and_read_errors_close_the_response(self):
        import requests
        for failure in ('status', 'redirect', 'read'):
            response = Mock(url=self.url)
            response.raise_for_status.return_value = None
            expected = requests.HTTPError if failure == 'status' else ValueError if failure == 'redirect' else OSError
            if failure == 'status':
                response.raise_for_status.side_effect = requests.HTTPError('offline status failure')
            elif failure == 'redirect':
                response.url = self.url.replace('https:', 'http:')
            else:
                response.raw.read.side_effect = OSError('offline read failure')
            with self.subTest(failure=failure), patch('requests.Session') as factory:
                SAMPLER.IMAGE_SESSIONS.__dict__.clear()
                factory.return_value.get.return_value = response
                with self.assertRaises(expected):
                    with SAMPLER.fetch(self.url) as stream:
                        stream.read(1024)
                response.close.assert_called_once_with()

    def test_metadata_keeps_urllib_and_http_sources_are_rejected(self):
        metadata = SAMPLER.SOURCES['validation'][0]
        response = Mock(url=metadata)
        with patch('requests.Session') as factory, patch('urllib.request.urlopen', return_value=response) as urlopen:
            self.assertIs(SAMPLER.fetch(metadata), response)
            urlopen.assert_called_once_with(metadata, timeout=90)
            with self.assertRaisesRegex(ValueError, 'Only HTTPS'):
                SAMPLER.fetch(self.url.replace('https:', 'http:'))
            factory.assert_not_called()


if __name__ == '__main__':
    unittest.main()
