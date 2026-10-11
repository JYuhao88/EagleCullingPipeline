"""Job submission manifests and resource contracts without contacting Ray."""
import sys as _test_sys
from pathlib import Path as _TestPath
_test_sys.path.insert(0, str(_TestPath(__file__).resolve().parents[2]))

from ml.common.private_env_test_fixture import configured_private_environment as _configured_private_environment
_import_private_environment = _configured_private_environment()
_import_private_environment.__enter__()

import contextlib
import io
from contextlib import redirect_stdout
import io
import json
from pathlib import Path
import tempfile
import unittest
from unittest.mock import patch
import submit

class SubmissionTests(unittest.TestCase):
    def submit_stage(self, stage, extra=()):
        with tempfile.TemporaryDirectory() as temp:
            manifest=Path(temp)/'manifest.json'
            manifest.write_text(json.dumps({'videos':[{'bvid':'BVOne'},{'bvid':'BVTwo'}]}))
            args=['submit.py',stage,'--manifest',str(manifest),'--bvids','BVTwo','--id','test-genre',
                  '--env','REF_OUT=/test/wulin',*extra]
            with patch('sys.argv',args), patch.object(submit,'request',return_value={'submission_id':'test-genre'}) as request, redirect_stdout(io.StringIO()):
                submit.main()
            return request.call_args.kwargs['body']

    def test_new_manifest_subset_and_cpu_stages(self):
        for stage in ('fetch','topics'):
            with self.subTest(stage=stage):
                body=self.submit_stage(stage)
                self.assertEqual(body['entrypoint_num_gpus'],0)
                env=body['runtime_env']['env_vars']
                self.assertEqual(json.loads(env['REF_MANIFEST'])['videos'],[{'bvid':'BVTwo'}])
                self.assertEqual(env['REF_OUT'],'/test/wulin')
                self.assertEqual(len(env['REF_CODE_SHA256']),64)
                self.assertNotIn('BILI_COOKIE_FILE',env)

    def test_whisper_cuda12_libraries_visible_before_process_start(self):
        body=self.submit_stage('asr',['--env','REF_ASR_BACKEND=whisper','--env','REF_ASR_LANGUAGE=en'])
        self.assertIn('nvidia-cublas-cu12',body['runtime_env']['pip'])
        self.assertIn('nvidia-cudnn-cu12',body['runtime_env']['pip'])
        self.assertIn('LD_LIBRARY_PATH',body['entrypoint'])
        self.assertIn('os.execv',body['entrypoint'])
        self.assertEqual(body['runtime_env']['env_vars']['REF_ASR_LANGUAGE'],'en')
        self.assertEqual(body['entrypoint_num_gpus'],1)

    def test_asr_reserves_exactly_one_gpu(self):
        body=self.submit_stage('asr')
        self.assertEqual(body['entrypoint_num_gpus'],1)
        self.assertEqual(body['entrypoint_num_cpus'],2)

_import_private_environment.__exit__(None, None, None)


def setUpModule():
    global _running_private_environment
    _running_private_environment = _configured_private_environment()
    _running_private_environment.__enter__()


def tearDownModule():
    _running_private_environment.__exit__(None, None, None)

if __name__ == '__main__':unittest.main()
