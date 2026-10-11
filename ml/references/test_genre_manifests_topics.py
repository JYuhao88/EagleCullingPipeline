import sys as _test_sys
from pathlib import Path as _TestPath
_test_sys.path.insert(0, str(_TestPath(__file__).resolve().parents[2]))

from ml.common.private_env_test_fixture import configured_private_environment as _configured_private_environment
_import_private_environment = _configured_private_environment()
_import_private_environment.__enter__()

import json
from pathlib import Path
import subprocess
import sys
import tempfile
import unittest

from build_genre_manifests import build_wulin, build_wuxiaolong
from topics_job import covered_seconds, extract_topics

HERE = Path(__file__).resolve().parent


class ManifestTests(unittest.TestCase):
    def test_wulin_inventory_and_missing_dates(self):
        source = json.loads((HERE/'genre_sources_candidates.json').read_text())
        result = build_wulin(source)
        self.assertEqual(result['video_count'], 40)
        self.assertEqual(result['duration_seconds'], 105696)
        self.assertEqual(result['publication_dates_missing'], 40)
        first = result['videos'][0]
        enriched = build_wulin(source, {first['bvid']: {'data': {'pubdate': 1600000000, 'duration': 1200}}})
        self.assertEqual(enriched['videos'][0]['pubdate'], 1600000000)
        self.assertEqual(enriched['publication_dates_missing'], 39)
        self.assertEqual(enriched['videos'][0]['duration'], 1200)

    def test_wulin_duplicate_is_rejected(self):
        source = {'candidates': [{'mid': 474457011, 'videos': [{'bvid': 'BV1', 'title': 't', 'duration_seconds': 1}]*2}]}
        with self.assertRaises(ValueError):
            build_wulin(source)

    def test_courses_only_high_and_stable_ids(self):
        source = json.loads((HERE/'wuxiaolong_manifest.json').read_text())
        result = build_wuxiaolong(source)
        self.assertEqual(result['video_count'], 19)
        self.assertAlmostEqual(result['duration_seconds'], 37933.420195)
        self.assertTrue(all(v['relevance'] == 'high' and v['source_path'].endswith('.mp4') for v in result['videos']))
        reordered = build_wuxiaolong({'episodes': list(reversed(source['episodes']))})
        self.assertEqual({v['bvid'] for v in result['videos']}, {v['bvid'] for v in reordered['videos']})
        self.assertEqual(len({v['bvid'] for v in result['videos']}), 19)

    def test_manifest_cli_writes_metadata(self):
        with tempfile.TemporaryDirectory() as temp:
            subprocess.run([sys.executable, str(HERE/'build_genre_manifests.py'), '--output-dir', temp], check=True, capture_output=True)
            self.assertEqual(json.loads((Path(temp)/'wulin_critique_manifest.json').read_text())['video_count'], 40)
            self.assertEqual(json.loads((Path(temp)/'wuxiaolong_asr_manifest.json').read_text())['video_count'], 19)


class TopicTests(unittest.TestCase):
    def test_topics_timestamps_and_inclusive_ranges(self):
        rows = [{'start': i*5, 'end': i*5+4, 'text': text} for i, text in enumerate(['开场', '风光构图', '普通句', '光线', '结束'])]
        result = extract_topics(rows)
        landscape = next(r for r in result if r['topic'] == 'landscape')
        self.assertEqual((landscape['start'], landscape['end']), (0, 14))
        self.assertEqual((landscape['sentence_start'], landscape['sentence_end']), (0, 2))
        self.assertEqual(landscape['matched_sentence_indices'], [1])
        self.assertEqual([s['index'] for s in landscape['sentences']], [0, 1, 2])
        self.assertEqual({r['topic'] for r in result}, {'landscape', 'composition', 'light'})

    def test_adjacent_windows_merge_but_long_pause_does_not(self):
        rows = [{'start': 0, 'end': 4, 'text': '街拍'}, {'start': 5, 'end': 9, 'text': '街头'}, {'start': 100, 'end': 104, 'text': '街拍'}]
        result = extract_topics(rows, context_sentences=0)
        self.assertEqual(len(result), 2)
        self.assertEqual(result[0]['matched_sentence_indices'], [0, 1])
        self.assertEqual(result[1]['start'], 100)

    def test_pause_context_and_duration_limit(self):
        rows = [{'start': 0, 'end': 4, 'text': '开场'}, {'start': 100, 'end': 104, 'text': '光线'}, {'start': 105, 'end': 109, 'text': '光影'}]
        result = extract_topics(rows, context_sentences=1)
        self.assertEqual(result[0]['start'], 100)
        short = extract_topics(rows, context_sentences=0, max_seconds=5)
        self.assertEqual(len(short), 2)

    def test_coverage_is_union_and_untimed_rows_rejected(self):
        self.assertEqual(covered_seconds([(0, 10), (5, 15), (20, 25)]), 20)
        self.assertEqual(extract_topics([]), [])
        self.assertEqual(extract_topics([{'start': 0, 'end': 1, 'text': '普通句'}]), [])
        with self.assertRaises(ValueError):
            extract_topics([{'start': 2, 'end': 1, 'text': '街拍'}])
        with self.assertRaises(ValueError):
            extract_topics([], context_sentences=-1)

    def test_cpu_cli_reports_coverage_without_video_input(self):
        with tempfile.TemporaryDirectory() as temp:
            root = Path(temp)
            (root/'asr').mkdir()
            (root/'asr'/'episode.jsonl').write_text(json.dumps({'start': 0, 'end': 2, 'text': '风光构图'}, ensure_ascii=False)+'\n')
            manifest = root/'manifest.json'
            manifest.write_text(json.dumps({'videos': [{'bvid': 'episode', 'title': 'lecture', 'duration': 10, 'course':'synthetic', 'episode':12}]}))
            subprocess.run([sys.executable, str(HERE/'topics_job.py'), '--root', temp, '--manifest', str(manifest)], check=True, capture_output=True)
            stats = json.loads((root/'topics'/'episode.stats.json').read_text())
            self.assertEqual(stats['covered_sentences'], 1)
            self.assertEqual(stats['duration_coverage'], 0.2)
            self.assertEqual(stats['topic_segments'], 2)
            topic = json.loads((root/'topics'/'episode.jsonl').read_text().splitlines()[0])
            self.assertEqual((topic['course'],topic['episode'],topic['source']),('synthetic',12,'wuxiaolong'))
            self.assertEqual(len(stats['asr_input_sha256']),64)
            self.assertEqual(json.loads((root/'topics'/'run-report.json').read_text())['resource']['num_gpus'], 0)


_import_private_environment.__exit__(None, None, None)


def setUpModule():
    global _running_private_environment
    _running_private_environment = _configured_private_environment()
    _running_private_environment.__enter__()


def tearDownModule():
    _running_private_environment.__exit__(None, None, None)

if __name__ == '__main__':
    unittest.main()
