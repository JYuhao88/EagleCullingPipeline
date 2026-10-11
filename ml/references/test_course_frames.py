import sys as _test_sys
from pathlib import Path as _TestPath
_test_sys.path.insert(0, str(_TestPath(__file__).resolve().parents[2]))

from ml.common.private_env_test_fixture import configured_private_environment as _configured_private_environment
_import_private_environment = _configured_private_environment()
_import_private_environment.__enter__()

import hashlib
import tempfile
import unittest
from pathlib import Path
from course_frames import audit, safe_path, select_videos, windows, validate_pair, validate_decision

class FramesTests(unittest.TestCase):
    def test_paths_and_symlinks(self):
        with tempfile.TemporaryDirectory() as d:
            for p in ('../x','/x','x.part','a\\x'):
                with self.assertRaises(ValueError):safe_path(d,p)
            (Path(d)/'escape').symlink_to('/etc')
            with self.assertRaises(ValueError):safe_path(d,'escape/passwd')
    def test_integrity(self):
        with tempfile.TemporaryDirectory() as d:
            p=Path(d)/'materials-courses/raw/x.mp4';p.parent.mkdir(parents=True);p.write_bytes(b'ok')
            v={'remote_rel':'x.mp4','size':2,'sha256':hashlib.sha256(b'ok').hexdigest()}
            self.assertEqual(audit(d,v),p.resolve())
            p.write_bytes(b'no')
            with self.assertRaises(ValueError):audit(d,v)
            v['size']=3
            with self.assertRaises(ValueError):audit(d,v)
    def test_keywords_are_not_labels(self):
        rows=[{'start':10,'end':12,'text':'Avoid bad marketing.'},
              {'start':20,'end':22,'text':'See the difference between these hand poses.'},
              {'start':27,'end':30,'text':'Instead lower the elbow.'},
              {'start':120,'end':125,'text':'前后对比：手腕要放松。'}]
        found=windows(rows)
        self.assertEqual(len(found),2);self.assertEqual(found[0]['sentence_indices'],[1,2])
        self.assertNotIn('positive',found[0]);self.assertEqual(found[0]['score'],3)
    def test_invalid_timestamps(self):
        for start,end in ((5,3),(-1,2),(float('nan'),4),(2,float('inf'))):
            with self.assertRaises(ValueError):windows([{'start':start,'end':end,'text':'better pose'}])
    def test_review_contract(self):
        p={'rule_id':'P-HAND-NATURAL','paraphrase':'手腕放松后线条自然','start':0,'end':10,'positive':'b',
           'review':'subtitle-and-visual','frames':{'a':{'path':'lindsay-adler/a.jpg','time':2,'sha256':'a'*64},
                                                'b':{'path':'lindsay-adler/b.jpg','time':6,'sha256':'b'*64}}}
        validate_pair(p,{'P-HAND-NATURAL'})
        for extra in ({'positive':None},{'paraphrase':'长'*41},{'quote':'raw'},{'review':'heuristic'}):
            with self.assertRaises(ValueError):validate_pair(dict(p,**extra),{'P-HAND-NATURAL'})
    def test_scope(self):
        f={'source':'materials-courses','remote_rel':'courses/01-人像姿势/Lindsay Adler-The Posing Series/1.mp4','size':2,'sha256':'a'*64}
        self.assertEqual(select_videos({'files':[f]})[0]['slug'],'lindsay-adler')
        self.assertEqual(select_videos({'files':[dict(f,source='other')]}),[])
        with self.assertRaises(ValueError):select_videos({'files':[f,f]})

    def test_reviewed_viewports(self):
        w={'frames':[{},{}]}
        d={'a':0,'b':1,'positive':'b','rule_id':'P-HAND-NATURAL',
           'paraphrase':'放松手指','review':'subtitle-and-visual',
           'crop_a':[0,0,1,1],'crop_b':[0,0,1,1]}
        validate_decision(d,w,{'P-HAND-NATURAL'})
        for change in ({'a':True},{'b':2},{'crop_a':[0,0,float('nan'),1]},
                       {'crop_b':[0,1,1,0]},{'a':1},{'positive':None}):
            with self.subTest(change=change),self.assertRaises(ValueError):
                validate_decision(dict(d,**change),w,{'P-HAND-NATURAL'})
        # Two different photo panels in the same source frame are valid.
        validate_decision(dict(d,b=0,crop_a=[0,0,.5,1],crop_b=[.5,0,1,1]),w,{'P-HAND-NATURAL'})


_import_private_environment.__exit__(None, None, None)


def setUpModule():
    global _running_private_environment
    _running_private_environment = _configured_private_environment()
    _running_private_environment.__enter__()


def tearDownModule():
    _running_private_environment.__exit__(None, None, None)

if __name__=='__main__':unittest.main()
