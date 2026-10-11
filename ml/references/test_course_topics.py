"""No local audio/video decoding: pure segmentation and mocked frame tests."""
import sys as _test_sys
from pathlib import Path as _TestPath
_test_sys.path.insert(0, str(_TestPath(__file__).resolve().parents[2]))

from ml.common.private_env_test_fixture import configured_private_environment as _configured_private_environment
_import_private_environment = _configured_private_environment()
_import_private_environment.__enter__()

import hashlib
import io
import json
from pathlib import Path
import tempfile
import sys
from types import SimpleNamespace
import unittest
from unittest.mock import patch

import course_topics_job as job


def sentences(texts):
    return [{'start': i*10, 'end': i*10+8, 'text': text} for i, text in enumerate(texts)]


class CourseTopicsTests(unittest.TestCase):
    def test_all_sentences_once_and_topic_changes(self):
        rows = sentences(['大家好', '手指保持放松', '这样更加自然', '坐在椅子上', '逆光的阴影', '修图液化'])
        groups = job.extract_topics(rows)
        self.assertEqual([row['index'] for group in groups for row in group['sentences']], list(range(len(rows))))
        self.assertEqual([group['topic'] for group in groups], ['闲聊', '手位', '坐靠', '用光方向', '后期'])
        self.assertEqual(len(groups[1]['sentences']), 2)
        self.assertTrue(all(a['end'] <= b['start'] for a, b in zip(groups, groups[1:])))
        self.assertEqual(groups[1]['sentence_end'], 2)

    def test_long_pause_duration_limit_and_single_long_sentence(self):
        rows = [{'start': 0, 'end': 10, 'text': '手'}, {'start': 31, 'end': 41, 'text': '手'}, {'start': 42, 'end': 250, 'text': '手'}, {'start': 251, 'end': 255, 'text': '手'}]
        groups = job.extract_topics(rows)
        self.assertEqual(len(groups), 4)
        self.assertEqual((groups[2]['start'], groups[2]['end']), (42, 250))
        exact = job.extract_topics([{'start': 0, 'end': 10, 'text': '手'}, {'start': 30, 'end': 40, 'text': '手'}])
        self.assertEqual(len(exact), 1)

    def test_overlapping_asr_utterances_stay_in_one_segment(self):
        groups = job.extract_topics([{'start': 0, 'end': 5, 'text': '手'}, {'start': 4, 'end': 8, 'text': '逆光'}, {'start': 9, 'end': 11, 'text': '坐'}])
        self.assertEqual(len(groups), 2)
        self.assertEqual(groups[0]['end'], 8)
        self.assertIn('用光方向', groups[0]['tags'])

    def test_invalid_input_rejected(self):
        for rows in ([{'text':'手', 'start':2, 'end':1}], [{'text':' ', 'start':0, 'end':1}], [{'text':'手', 'start':float('nan'), 'end':1}], [{'text':'手', 'start':2, 'end':3}, {'text':'手', 'start':1, 'end':2}]):
            with self.assertRaises(ValueError):
                job.extract_topics(rows)
        with self.assertRaises(ValueError):
            job.extract_topics([], max_seconds=0)
        self.assertEqual(job.extract_topics([]), [])

    def test_frame_sample_times_and_specific_labels(self):
        self.assertEqual(job.frame_times(10, 110), [25, 60, 95])
        self.assertEqual(job.frame_times(10, 20), [15])
        self.assertEqual(job.classify('手的姿势')[0], '手位')
        self.assertEqual(job.classify('这一节不知道')[0], None)
        self.assertEqual(set(job.TOPICS), {'姿势部位', '手位', '坐靠', '表情', '视线', '用光方向', '光质', '背景', '构图', '服装造型', '后期', '营销', '闲聊', '观看评判', '画面边缘', '多重事件', '色彩', '瞬间', '选片编辑'})

    def test_english_retrieval_topics_and_word_boundaries(self):
        examples = {
            '观看评判': 'LOOKING AT\nPICTURES trains perception.',
            '画面边缘': 'Watch the edges and corners of the frame.',
            '多重事件': 'Simultaneous events make layers and relationships.',
            '色彩': 'COLOR and colour: red against blue.',
            '瞬间': 'Timing the gesture gives us a moment.',
            '选片编辑': 'Choose the best frame from the contact sheet.',
            '用光方向': 'The sunlight makes shadows.',
        }
        for expected, text in examples.items():
            with self.subTest(expected=expected):
                primary, tags = job.classify(text)
                self.assertEqual(primary, expected)
                self.assertIn(expected, tags)
        self.assertEqual(job.classify('delightful colourful framework recollection')[0], None)
        # English support must not change existing Chinese labels or priorities.
        self.assertEqual(job.classify('手指保持放松，姿势自然')[0], '手位')

    def test_english_topic_changes_preserve_every_sentence(self):
        rows = sentences(['Looking at pictures.', 'There is something here.',
                          'The edges of the frame.', 'Choose a contact sheet selection.',
                          'Colour and blue.', 'Timing and the moment.'])
        groups = job.extract_topics(rows)
        self.assertEqual([group['topic'] for group in groups],
                         ['观看评判', '画面边缘', '选片编辑', '色彩', '瞬间'])
        self.assertEqual([row['index'] for group in groups for row in group['sentences']], list(range(len(rows))))
        self.assertEqual(len(groups[0]['sentences']), 2)

    def test_atomic_outputs_and_artifact_cache_integrity(self):
        with tempfile.TemporaryDirectory() as temp:
            root = Path(temp)
            frame = root/'frames'/'e'/'1.jpg'
            qa = root/'qa'/'e.html'
            job.atomic_bytes(frame, b'synthetic JPEG placeholder')
            job.atomic_bytes(qa, b'QA')
            topics = root/'topics'/'e.jsonl'
            job.atomic(topics, [{'frames':[{'path':str(frame), 'sha256':job.sha256(frame)}]}], lines=True)
            stats = {'asr_input_sha256':'a', 'code_sha256':'b', 'video_sha256':'c', 'parameters':{}, 'topics_sha256':job.sha256(topics), 'qa_artifacts':[{'path':str(qa), 'sha256':job.sha256(qa)}]}
            job.atomic(root/'topics'/'e.stats.json', stats)
            self.assertEqual(job.valid_cache(root, 'e', 'a', 'b', 'c', {}), stats)
            self.assertIsNone(job.valid_cache(root, 'e', 'changed', 'b', 'c', {}))
            frame.write_bytes(b'truncated')
            self.assertIsNone(job.valid_cache(root, 'e', 'a', 'b', 'c', {}))
            self.assertFalse(list(root.rglob('*.part')))

    def test_generic_pose_is_not_clothing(self):
        topic,tags=job.classify('摆姿造型要展示胯部')
        self.assertEqual(topic,'姿势部位')
        self.assertNotIn('服装造型',tags)

    def test_body_curve_is_not_retouch(self):
        topic,tags=job.classify('身体的曲线需要和造型配合')
        self.assertNotIn('后期',tags)

    def test_process_rejects_local_media_without_opening_it(self):
        with tempfile.TemporaryDirectory() as temp:
            with self.assertRaisesRegex(ValueError, 'Ceph'):
                job.process_video(Path(temp), {'bvid':'e', 'source_path':temp+'/video.mp4'}, 'hanjing', 'code', {})
            with self.assertRaisesRegex(ValueError, 'unsafe'):
                job.process_video(Path(temp), {'bvid':'../escape'}, 'hanjing', 'code', {})

    def test_mocked_decoder_limits_jpeg_and_records_hash(self):
        from PIL import Image
        with tempfile.TemporaryDirectory() as temp:
            buf = io.BytesIO()
            Image.new('RGB', (1200, 800), 'red').save(buf, 'JPEG')
            target = Path(temp)/'frame.jpg'
            with patch.dict(sys.modules, {'imageio_ffmpeg': SimpleNamespace(get_ffmpeg_exe=lambda: 'ffmpeg')}), patch.object(job.subprocess, 'run', return_value=SimpleNamespace(stdout=buf.getvalue())) as run:
                artifact = job.capture_frame('not-opened.mp4', 12.5, target)
            with Image.open(target) as image:
                self.assertLessEqual(max(image.size), 640)
                self.assertEqual(image.format, 'JPEG')
            self.assertEqual(artifact['time'], 12.5)
            self.assertEqual(artifact['sha256'], job.sha256(target))
            self.assertIn('-ss', run.call_args.args[0])
            self.assertEqual(run.call_args.kwargs['timeout'], 120)

    def test_mocked_pipeline_checks_source_and_skips_complete_cache(self):
        with tempfile.TemporaryDirectory() as temp:
            root = Path(temp)
            source = root/'raw'/'episode.mp4'
            job.atomic_bytes(source, b'not media; decoder mocked')
            job.atomic(root/'asr'/'e.jsonl', sentences(['手', '手', '逆光']), lines=True)
            video = {'bvid':'e', 'title':'synthetic', 'episode':1, 'course':'test', 'source_path':str(source), 'size':source.stat().st_size, 'sha256':job.sha256(source), 'duration_seconds':30}
            def capture(source, timestamp, target):
                job.atomic_bytes(target, b'frame')
                return {'path':str(target), 'time':timestamp, 'sha256':job.sha256(target)}
            def qa(root, video, segments):
                path = root/'qa'/'e.html'
                job.atomic_bytes(path, b'QA')
                return [{'path':str(path), 'sha256':job.sha256(path)}]
            parameters = {'max_gap':20, 'max_seconds':180}
            with patch.object(job, 'CEPH', root.resolve()), patch.object(job, 'capture_frame', side_effect=capture) as decode, patch.object(job, 'make_qa', side_effect=qa):
                stats = job.process_video(root, video, 'test', 'code', parameters)
                self.assertEqual(stats['sentence_coverage'], 1)
                self.assertEqual(stats['frames'], 2)
                cached = job.process_video(root, video, 'test', 'code', parameters)
                self.assertTrue(cached['cached'])
                self.assertEqual(decode.call_count, 2)
                video['duration_seconds'] = None
                job.atomic(root/'asr'/'e.stats.json',{'duration':40,'source_sha256':video['sha256']})
                decoded = job.process_video(root, video, 'test', 'new-code', parameters)
                self.assertEqual(decoded['duration'],40)
                job.atomic(root/'asr'/'e.stats.json',{'duration':40,'source_sha256':'wrong'})
                with self.assertRaisesRegex(ValueError,'duration source checksum'):
                    job.process_video(root, video, 'test', 'another-code', parameters)
                video['sha256'] = 'incorrect'
                with self.assertRaisesRegex(ValueError, 'SHA-256'):
                    job.process_video(root, video, 'test', 'code', parameters)

    def test_qa_html_escapes_transcription_and_embeds_frames(self):
        try:
            from PIL import Image
        except ImportError:
            self.skipTest('Pillow unavailable; installed in Ray segment runtime')
        with tempfile.TemporaryDirectory() as temp:
            root = Path(temp)
            frame = root/'frames'/'e'/'1.jpg'
            output = io.BytesIO()
            Image.new('RGB', (320, 200)).save(output, 'JPEG')
            job.atomic_bytes(frame, output.getvalue())
            segments = [{'segment':1, 'start':0, 'end':10, 'tags':['手位'], 'sentences':[{'text':'<script>private</script>'}], 'frames':[{'path':str(frame), 'time':5}]}]
            artifacts = job.make_qa(root, {'bvid':'e', 'title':'<title>'}, segments)
            page = (root/'qa'/'e.html').read_text()
            self.assertIn('data:image/jpeg;base64,', page)
            self.assertIn('&lt;script&gt;', page)
            self.assertNotIn('<script>private', page)
            self.assertEqual(len(artifacts), 2)
            self.assertTrue(all(job.sha256(item['path']) == item['sha256'] for item in artifacts))



_import_private_environment.__exit__(None, None, None)


def setUpModule():
    global _running_private_environment
    _running_private_environment = _configured_private_environment()
    _running_private_environment.__enter__()


def tearDownModule():
    _running_private_environment.__exit__(None, None, None)

if __name__ == '__main__':
    unittest.main()
