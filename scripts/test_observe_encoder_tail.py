import base64
import contextlib
import hashlib
import importlib.util
import io
import json
from pathlib import Path
import tempfile
import unittest
from unittest.mock import patch

SPEC = importlib.util.spec_from_file_location('encoder_tail', Path(__file__).with_name('observe-encoder-tail.py'))
tail = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(tail)
JOB = 'w33-encoder-' + 'a' * 12


def chunks(name, content, size=8):
    encoded = base64.b64encode(content).decode()
    pieces = [encoded[index:index + size] for index in range(0, len(encoded), size)] or ['']
    return [{'name': name, 'index': index, 'count': len(pieces), 'sha256': hashlib.sha256(content).hexdigest(),
             'data': piece} for index, piece in enumerate(pieces)]


class EncoderTailTest(unittest.TestCase):
    def setUp(self):
        self.directory = self.enterContext(tempfile.TemporaryDirectory())
        self.cache = Path(self.directory) / 'cache'
        self.enterContext(patch.object(tail, 'CACHE', self.cache))
        self.stdout = self.enterContext(contextlib.redirect_stdout(io.StringIO()))

    def collector(self, name='run'):
        collector = tail.Collector(JOB, self.cache / name)
        self.addCleanup(collector.close)
        return collector

    def complete(self, collector, expected=2):
        for row in chunks('encoder-results.json', b'{}'):
            collector.artifact(row)
        collector.line(tail.REPORT + json.dumps({'stage': 'complete', 'artifacts': expected}))
        return collector.finish('SUCCEEDED')

    def test_split_lines_write_nested_artifacts_and_all_reports_with_coarse_stdout(self):
        collector = self.collector()
        source = 'siglip2-base/fp32/oi'
        for done in (16, 2000, 2016):
            collector.line(tail.REPORT + json.dumps({'stage': source, 'completed': done, 'total': 3000}))
        content = b'features across ordered chunks'
        stream = 'ordinary log content\n' + ''.join(tail.ARTIFACT + json.dumps(row) + '\n'
                                                      for row in chunks(source + '.npz', content))
        for index in range(0, len(stream), 17):
            collector.feed(stream[index:index + 17])
        result = self.complete(collector)
        self.assertTrue(result['complete'])
        self.assertEqual((collector.output / (source + '.npz')).read_bytes(), content)
        self.assertFalse((collector.output / (source + '.npz.part')).exists())
        reports = [json.loads(line) for line in (collector.output / collector.report_name).read_text().splitlines()]
        self.assertEqual([row['completed'] for row in reports[:-1]], [16, 2000, 2016])
        printed = [json.loads(line) for line in self.stdout.getvalue().splitlines()]
        self.assertEqual([row['report']['completed'] for row in printed if 'completed' in row.get('report', {})],
                         [2000, 2016])
        self.assertNotIn('ordinary log content', self.stdout.getvalue())

    def test_existing_verified_artifacts_accept_full_duplicate_replay_without_rewrite(self):
        collector = self.collector()
        rows = chunks('dinov2-base/fp16/p0.npz', b'already verified')
        for row in rows:
            collector.artifact(row)
        target = collector.output / rows[0]['name']
        modified = target.stat().st_mtime_ns
        for row in rows:
            collector.artifact(row)
        collector.close()
        replay = self.collector()
        for row in rows:
            replay.artifact(row)
        self.assertEqual(target.stat().st_mtime_ns, modified)
        self.assertEqual(len(replay.saved), 1)
        self.assertIn('"reused": true', self.stdout.getvalue())
        self.complete(replay)

    def test_corrupt_stream_preserves_previous_file_and_records_incomplete_transfer(self):
        collector = self.collector()
        name = 'siglip2-base/model-fp32.json'
        target = collector.output / name
        target.parent.mkdir(parents=True)
        target.write_bytes(b'previous verified artifact')
        rows = chunks(name, b'replacement')
        rows[-1]['data'] = base64.b64encode(b'bad').decode()
        with self.assertRaisesRegex(ValueError, 'checksum mismatch'):
            for row in rows:
                collector.artifact(row)
        with self.assertRaisesRegex(ValueError, 'incomplete encoder collection'):
            collector.finish('SUCCEEDED')
        self.assertEqual(target.read_bytes(), b'previous verified artifact')
        self.assertTrue(Path(str(target) + '.part').exists())
        self.assertFalse(json.loads((collector.output / 'collection.json').read_text())['complete'])

    def test_missing_or_out_of_order_chunks_cannot_publish(self):
        collector = self.collector()
        rows = chunks('dinov2-large/fp32/panel.npz', b'incomplete data')
        with self.assertRaisesRegex(ValueError, 'start at chunk zero'):
            collector.artifact(rows[1])
        collector.artifact(rows[0])
        with self.assertRaisesRegex(ValueError, 'sequence or metadata mismatch'):
            collector.artifact(rows[2])
        with self.assertRaisesRegex(ValueError, 'incomplete encoder collection'):
            collector.finish('SUCCEEDED')
        result = json.loads((collector.output / 'collection.json').read_text())
        self.assertEqual(result['incomplete'][0]['received'], 1)
        self.assertFalse((collector.output / rows[0]['name']).exists())

    def test_completion_requires_successful_job_and_all_expected_artifacts(self):
        collector = self.collector()
        for index in range(40):
            collector.line('private error ' + str(index) + 'x' * 3000)
        with self.assertRaisesRegex(ValueError, 'incomplete encoder collection'):
            self.complete(collector, expected=2)
        with self.assertRaisesRegex(ValueError, 'incomplete encoder collection'):
            collector.finish('RUNNING')
        result = json.loads((collector.output / 'collection.json').read_text())
        self.assertIn('encoder artifact count differs from completion report', result['reasons'])
        self.assertEqual(result['jobStatus'], 'RUNNING')
        log = collector.output / (JOB + '-errors.log')
        self.assertLessEqual(log.stat().st_size, 32 * 2049)
        self.assertEqual(log.stat().st_mode & 0o777, 0o600)
        self.assertEqual((collector.output / collector.report_name).stat().st_mode & 0o777, 0o600)
        self.assertNotIn('private error', self.stdout.getvalue())

    def test_verified_model_requires_training_reports_in_addition_to_extraction_count(self):
        collector = self.collector()
        collector.line(tail.REPORT + json.dumps({'stage': 'verified', 'models': ['siglip2-base']}))
        missing = 'siglip2-base/training-fp16.json'
        for name in sorted(collector.required - {missing}):
            for row in chunks(name, b'{}'):
                collector.artifact(row)
        with self.assertRaisesRegex(ValueError, 'incomplete encoder collection'):
            self.complete(collector, expected=15)
        result = json.loads((collector.output / 'collection.json').read_text())
        self.assertIn('missing required encoder, feature or training artifacts', result['reasons'])
        self.assertNotIn('encoder artifact count differs from completion report', result['reasons'])
        for row in chunks(missing, b'{}'):
            collector.artifact(row)
        self.assertTrue(collector.finish('SUCCEEDED')['complete'])

    def test_job_output_and_nested_paths_are_bounded_and_unknown_long_logs_are_discarded(self):
        for job in ('w1-encoder-' + 'a' * 12, 'w33-encoder-../x', ''):
            with self.assertRaises(ValueError):
                tail.Collector(job, self.cache / 'invalid')
        with self.assertRaisesRegex(ValueError, 'must remain under'):
            tail.Collector(JOB, Path(self.directory) / 'outside')
        collector = self.collector()
        for name in ('../outside.json', '/tmp/oi.npz', 'siglip2-base/model.onnx'):
            with self.assertRaisesRegex(ValueError, 'unexpected encoder artifact'):
                collector.artifact(chunks(name, b'x')[0])
        (collector.output / 'siglip2-base').symlink_to(Path(self.directory), target_is_directory=True)
        with self.assertRaisesRegex(ValueError, 'escapes its output'):
            collector.artifact(chunks('siglip2-base/fp32/oi.npz', b'x')[0])
        collector.feed('x' * (tail.MAX_LINE + 1))
        self.assertEqual(collector.pending, '')
        collector.feed('discarded\n' + tail.REPORT + '{"stage":"verified"}\n')
        self.assertEqual(collector.report_count, 1)

    def test_recovery_requires_all_selected_precisions_and_rejects_invalid_selection(self):
        collector = self.collector()
        collector.line(tail.REPORT + json.dumps({'stage': 'verified', 'models': ['siglip2-base'],
                                                'precisions': {'siglip2-base': ['fp16']}}))
        self.assertTrue(collector.required)
        self.assertFalse(any('fp32' in name for name in collector.required))
        for name in sorted(collector.required):
            for row in chunks(name, b'{}'):
                collector.artifact(row)
        self.assertTrue(self.complete(collector, expected=8)['complete'])
        for selection in ({}, {'siglip2-base': []}, {'siglip2-base': ['fp16', 'fp16']},
                          {'siglip2-base': ['int8']}, {'siglip2-base': 'fp16'}):
            with self.assertRaisesRegex(ValueError, 'precision selection'):
                collector.line(tail.REPORT + json.dumps({'stage': 'verified', 'models': ['siglip2-base'],
                                                        'precisions': selection}))

    def test_partial_final_json_leaves_an_honest_collection_manifest(self):
        collector = self.collector()
        collector.feed(tail.ARTIFACT + '{"name":')
        with self.assertRaisesRegex(ValueError, 'incomplete encoder collection'):
            collector.finish('SUCCEEDED')
        result = json.loads((collector.output / 'collection.json').read_text())
        self.assertFalse(result['complete'])
        self.assertIn('invalid final encoder log record', result['reasons'])


if __name__ == '__main__':
    unittest.main()
