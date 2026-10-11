"""Alignment contract checks, runnable with python -m unittest discovery."""
import sys as _test_sys
from pathlib import Path as _TestPath
_test_sys.path.insert(0, str(_TestPath(__file__).resolve().parents[2]))

from ml.common.private_env_test_fixture import configured_private_environment as _configured_private_environment
_import_private_environment = _configured_private_environment()
_import_private_environment.__enter__()

import importlib.util
import json
from pathlib import Path
import tempfile
import unittest

spec = importlib.util.spec_from_file_location("align_job", Path(__file__).with_name("align_job.py"))
align = importlib.util.module_from_spec(spec)
spec.loader.exec_module(align)


class AlignmentTest(unittest.TestCase):
    def test_boundary_once_and_other(self):
        segments = [{"start": 0, "end": 10}, {"start": 10, "end": 20}, {"start": 20, "end": 30}]
        sentences = [{"start": 8, "end": 12, "text": "跨界"}, {"start": 21, "end": 25, "text": "其他画面"},
                     {"start": 40, "end": 41, "text": "范围外"}]
        assigned, unused = align.allocate(sentences, segments)
        self.assertEqual(assigned, [[], [sentences[0]], [sentences[1]]])
        self.assertEqual(unused, [sentences[2]])
        self.assertEqual(sum(len(t) for t in assigned), 2)

    def test_contract_skip_and_changed_inputs(self):
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            for name in ("asr", "segments", "frames/BVtest"):
                (root / name).mkdir(parents=True)
            (root / "frames/BVtest/001.jpg").write_bytes(b"frame")
            asr = root / "asr/BVtest.jsonl"
            asr.write_text(json.dumps({"start": 0, "end": 3, "text": "直闪色温"}) + "\n" + json.dumps({"start": 7, "end": 9, "text": "片尾"}) + "\n")
            segments = [{"index": 1, "start": 0, "end": 5, "kind": "photo", "frame": "frames/BVtest/001.jpg", "phash": "abc"},
                        {"index": 2, "start": 5, "end": 10, "kind": "other"}]
            (root / "segments/BVtest.json").write_text(json.dumps(segments))
            video = {"bvid": "BVtest", "duration": 10}
            first, _, _ = align.align_video(video, root)
            second, _, _ = align.align_video(video, root)
            self.assertFalse(first["skipped"])
            self.assertTrue(second["skipped"])
            self.assertEqual(first["photo_coverage_ratio"], 0.5)
            self.assertEqual(first["asr_sentences_assigned_to_other"], 1)
            rows = align.read_jsonl(root / "critiques/BVtest.jsonl")
            self.assertEqual(len(rows), 1)
            self.assertEqual(rows[0]["transcript"], "直闪色温")
            self.assertEqual(rows[0]["tier"], None)
            self.assertEqual(rows[0]["transcript_segments"][0]["start"], 0)
            asr.write_text(json.dumps({"start": 0, "end": 3, "text": "套头逆光85mm"}) + "\n")
            changed, _, _ = align.align_video(video, root)
            self.assertFalse(changed["skipped"])
            self.assertEqual(align.read_jsonl(root / "critiques/BVtest.jsonl")[0]["transcript"], "套头逆光85mm")

    def test_wulin_source_and_cache_identity(self):
        from unittest.mock import patch
        with tempfile.TemporaryDirectory() as tmp:
            root=Path(tmp)
            for name in ('asr','segments','frames/BVtest'):(root/name).mkdir(parents=True)
            (root/'frames/BVtest/0.jpg').write_bytes(b'frame')
            (root/'asr/BVtest.jsonl').write_text(json.dumps({'start':0,'end':2,'text':'测试主体'})+'\n')
            (root/'segments/BVtest.json').write_text(json.dumps([{'index':0,'start':0,'end':3,'kind':'photo','frame':'frames/BVtest/0.jpg'}]))
            align.align_video({'bvid':'BVtest','duration':3},root)
            with patch.dict('os.environ',{'REF_SOURCE':'wulin'}):
                stats,_,_=align.align_video({'bvid':'BVtest','duration':3},root)
                self.assertFalse(stats['skipped'])
                self.assertEqual(align.read_jsonl(root/'critiques/BVtest.jsonl')[0]['source'],'wulin')
                self.assertTrue(align.align_video({'bvid':'BVtest','duration':3},root)[0]['skipped'])

    def test_bridged_dialog_is_not_photo_coverage(self):
        segment = {"start": 0, "end": 9, "intervals": [{"start": 0, "end": 4}, {"start": 5, "end": 9}]}
        self.assertEqual(align.union_duration([segment]), 8)
        sentence = {"start": 4.1, "end": 4.9, "text": "弹窗"}
        assigned, unused = align.allocate([sentence], [segment])
        self.assertEqual(assigned, [[]])
        self.assertEqual(unused, [sentence])

    def test_union_coverage(self):
        self.assertEqual(align.union_duration([{"start": 4, "end": 8}, {"start": 0, "end": 5}, {"start": 10, "end": 12}]), 10)



_import_private_environment.__exit__(None, None, None)


def setUpModule():
    global _running_private_environment
    _running_private_environment = _configured_private_environment()
    _running_private_environment.__enter__()


def tearDownModule():
    _running_private_environment.__exit__(None, None, None)

if __name__ == "__main__":
    unittest.main()
