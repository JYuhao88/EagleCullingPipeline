"""Completion audit rejects altered text or wrong source provenance."""
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
from unittest.mock import patch
import verify_job

class VerificationTests(unittest.TestCase):
    def test_sha_and_source_audit(self):
        with tempfile.TemporaryDirectory() as temp:
            root=Path(temp);b='BVTest'
            for directory in ('asr','segments','critiques','frames/BVTest','raw/BVTest'):(root/directory).mkdir(parents=True)
            (root/'asr/BVTest.jsonl').write_text(json.dumps({'start':0,'end':2,'text':'测试主体'})+'\n')
            (root/'asr/BVTest.stats.json').write_text(json.dumps({'duration':3}))
            (root/'segments/BVTest.stats.json').write_text(json.dumps({'identity_version':'wulin-central-sift@1'}))
            (root/'frames/BVTest/0.jpg').write_bytes(b'\xff\xd8synthetic')
            (root/'segments/BVTest.json').write_text(json.dumps([{'index':0,'start':0,'end':3,'kind':'photo','frame':'frames/BVTest/0.jpg'}]))
            critique=root/'critiques/BVTest.jsonl'
            row={'contractVersion':1,'source':'wulin','bvid':b,'tier':None,'verdict':None,'issues':[],'praises':[],'topics':[]}
            critique.write_text(json.dumps(row)+'\n')
            metadata=critique.with_suffix('.meta.json')
            metadata.write_text(json.dumps({'output_sha256':hashlib.sha256(critique.read_bytes()).hexdigest()}))
            for name in ('audio.m4s','video1080.m4s','info.json'):(root/'raw'/b/name).write_bytes(b'synthetic raw')
            with patch.object(verify_job,'ROOT',root),patch.dict('os.environ',{'REF_SOURCE':'wulin','REF_VIDEO_NAME':'video1080.m4s'}):
                self.assertNotIn('error',verify_job.verify_video({'bvid':b}))
                (root/'asr/BVTest.stats.json').write_text(json.dumps({'duration':10}))
                self.assertIn('duration',verify_job.verify_video({'bvid':b})['error'])
                (root/'asr/BVTest.stats.json').write_text(json.dumps({'duration':3}))
                (root/'segments/BVTest.stats.json').write_text(json.dumps({'identity_version':'old'}))
                self.assertIn('obsolete',verify_job.verify_video({'bvid':b})['error'])
                (root/'segments/BVTest.stats.json').write_text(json.dumps({'identity_version':'wulin-central-sift@1'}))
                (root/'segments/BVTest.stats.json').write_text(json.dumps({'identity_version':'wulin-central-sift@1','host_negative_templates':2}))
                self.assertIn('host exclusion',verify_job.verify_video({'bvid':b})['error'])
                (root/'segments/BVTest.stats.json').write_text(json.dumps({'identity_version':'wulin-central-sift@1','host_negative_templates':0}))
                critique.write_text(critique.read_text()+'\n')
                self.assertIn('checksum',verify_job.verify_video({'bvid':b})['error'])
                metadata.write_text(json.dumps({'output_sha256':hashlib.sha256(critique.read_bytes()).hexdigest()}))
                with patch.dict('os.environ',{'REF_SOURCE':'yidao'}):
                    self.assertIn('source',verify_job.verify_video({'bvid':b})['error'])


_import_private_environment.__exit__(None, None, None)


def setUpModule():
    global _running_private_environment
    _running_private_environment = _configured_private_environment()
    _running_private_environment.__enter__()


def tearDownModule():
    _running_private_environment.__exit__(None, None, None)

if __name__ == '__main__':unittest.main()
