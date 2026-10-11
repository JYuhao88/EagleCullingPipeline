import sys as _test_sys
from pathlib import Path as _TestPath
_test_sys.path.insert(0, str(_TestPath(__file__).resolve().parents[2]))

from ml.common.private_env_test_fixture import configured_private_environment as _configured_private_environment
_import_private_environment = _configured_private_environment()
_import_private_environment.__enter__()

import json
from pathlib import Path
import tempfile
import unittest
from unittest.mock import patch
import course_frames_ray as runner

class RayFramesTests(unittest.TestCase):
    def test_own_job_only(self):
        with patch.object(runner,'jobs',return_value=['w4-frames-a']):
            self.assertEqual(runner.own('w4-frames-a'),'w4-frames-a')
            for j in ('upload-a','w4-frames-unknown','../w4-frames-a'):
                with self.assertRaises(ValueError):runner.own(j)
    def test_two_job_cap(self):
        with tempfile.TemporaryDirectory() as d, patch.object(runner,'DATA',Path(d)), patch.object(runner,'request',return_value={'status':'RUNNING'}) as req:
            (Path(d)/'ray-jobs.json').write_text(json.dumps(['w4-frames-a','w4-frames-b']))
            with self.assertRaises(ValueError):runner.submit('print(1)','test')
            self.assertEqual(req.call_count,2)
    def test_submission_resources(self):
        with tempfile.TemporaryDirectory() as d, patch.object(runner,'DATA',Path(d)), patch.object(runner,'request',return_value={'ok':True}) as req:
            identity=runner.submit('print(1)','test')
            self.assertTrue(identity.startswith(runner.PREFIX))
            body=req.call_args.kwargs['body']
            self.assertEqual((body['entrypoint_num_cpus'],body['entrypoint_num_gpus']),(1,0))
            self.assertEqual(json.loads((Path(d)/'ray-jobs.json').read_text()),[identity])
    def test_source_polling_limits(self):
        with self.assertRaises(ValueError):runner.probe_source([],299)
        self.assertIn('time.sleep(300)',runner.probe_source([],300))
        compile(runner.probe_source([],300),'probe','exec')
        compile(runner.text_source(),'text','exec')
        with self.assertRaises(ValueError):runner.decode_source([],[],3)
        compile(runner.decode_source([],[]),'decode','exec')
    def test_unknown_window(self):
        with self.assertRaises(ValueError):runner.decode_source([{'slug':'other','video_remote_rel':'a'}],[])

    def test_compact_export_preserves_panels_and_indices(self):
        frames=[{'time':i} for i in range(20)]
        windows=[{'id':'same','frames':frames},{'id':'two','frames':frames}]
        decisions=[{'window_id':'same','a':17,'b':17,'crop_a':[0,0,.5,1],
                    'crop_b':[.5,0,1,1]}, {'window_id':'two','a':12,'b':3}]
        ds,ws=runner.compact_export(decisions,windows)
        self.assertEqual((ds[0]['a'],ds[0]['b']),(0,0))
        self.assertEqual(ws[0]['frames'],[{'time':17}])
        self.assertEqual((ds[1]['a'],ds[1]['b']),(0,1))
        self.assertEqual(ws[1]['frames'],[{'time':12},{'time':3}])
        self.assertEqual(ds[0]['crop_a'],decisions[0]['crop_a'])
        self.assertEqual(len(windows[0]['frames']),20)


_import_private_environment.__exit__(None, None, None)


def setUpModule():
    global _running_private_environment
    _running_private_environment = _configured_private_environment()
    _running_private_environment.__enter__()


def tearDownModule():
    _running_private_environment.__exit__(None, None, None)

if __name__=='__main__':unittest.main()
