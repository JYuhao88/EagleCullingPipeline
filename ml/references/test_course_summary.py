import sys as _test_sys
from pathlib import Path as _TestPath
_test_sys.path.insert(0, str(_TestPath(__file__).resolve().parents[2]))

from ml.common.private_env_test_fixture import configured_private_environment as _configured_private_environment
_import_private_environment = _configured_private_environment()
_import_private_environment.__enter__()

import hashlib
import json
from pathlib import Path
import tempfile
import unittest
from course_summary import summary


class SummaryTests(unittest.TestCase):
    def setup_files(self, root):
        video={'bvid':'e','episode':1,'duration_seconds':10,'sha256':'rawhash','count_only':False}
        (root/'hanjing-manifest.json').write_text(json.dumps({'videos':[video]}))
        (root/'hanjing-arrived.json').write_text(json.dumps({'videos':[video],'probe_id':'probe'}))
        for stage in ('asr','topics'):(root/'hanjing'/stage).mkdir(parents=True)
        asr=root/'hanjing/asr/e.jsonl';asr.write_text(json.dumps({'start':1,'end':2,'text':'合成句'})+'\n')
        (root/'hanjing/asr/e.stats.json').write_text(json.dumps({'duration':10,'sentences':1,'source_sha256':'rawhash'}))
        topic=root/'hanjing/topics/e.jsonl'
        topic.write_text(json.dumps({'start':1,'end':2,'sentences':[{'index':0}], 'frames':[{'path':'synthetic.jpg'}]})+'\n')
        stats={'video_sha256':'rawhash','asr_input_sha256':hashlib.sha256(asr.read_bytes()).hexdigest(),
               'topics_sha256':hashlib.sha256(topic.read_bytes()).hexdigest(),
               'topic_segments':1,'frames':1,'topics':{'手位':1}}
        side=root/'hanjing/topics/e.stats.json';side.write_text(json.dumps(stats))
        return asr,side

    def test_completed_counts_require_matching_text_hashes(self):
        with tempfile.TemporaryDirectory() as folder:
            root=Path(folder);asr,side=self.setup_files(root)
            result=summary(root,'hanjing')
            self.assertEqual((result['asr_episodes'],result['topics_episodes'],result['frames']),(1,1,1))
            self.assertEqual(result['errors'],[])
            asr.write_text(json.dumps({'start':1,'end':2,'text':'不同的合成句'})+'\n')
            result=summary(root,'hanjing')
            self.assertEqual(result['topics_episodes'],0)
            self.assertIn('ASR hash',result['errors'][0]['error'])

    def test_bad_source_hash_cannot_count_as_completed(self):
        with tempfile.TemporaryDirectory() as folder:
            root=Path(folder);self.setup_files(root)
            side=root/'hanjing/asr/e.stats.json';stats=json.loads(side.read_text());stats['source_sha256']='wrong'
            side.write_text(json.dumps(stats))
            result=summary(root,'hanjing')
            self.assertEqual(result['asr_episodes'],0)
            self.assertEqual(len(result['errors']),1)


_import_private_environment.__exit__(None, None, None)


def setUpModule():
    global _running_private_environment
    _running_private_environment = _configured_private_environment()
    _running_private_environment.__enter__()


def tearDownModule():
    _running_private_environment.__exit__(None, None, None)

if __name__=='__main__':unittest.main()
