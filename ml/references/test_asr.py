"""Timestamp contract checks independent of ASR heavyweight dependencies."""
import sys as _test_sys
from pathlib import Path as _TestPath
_test_sys.path.insert(0, str(_TestPath(__file__).resolve().parents[2]))

from ml.common.private_env_test_fixture import configured_private_environment as _configured_private_environment
_import_private_environment = _configured_private_environment()
_import_private_environment.__enter__()

import unittest
from asr_job import funasr_rows, valid

class TimestampTests(unittest.TestCase):
    def test_milliseconds_and_duration_clipping(self):
        rows=funasr_rows([{'sentence_info':[{'start':1000,'end':3200,'text':'逆光，色温。','timestamp':[[1000,1500],[1600,3200]]}]}],3.)
        self.assertEqual(rows[0]['start'],1.)
        self.assertEqual(rows[0]['end'],3.)
        self.assertEqual(rows[0]['text'],'逆光，色温。')
        self.assertTrue(valid(rows,3.))
    def test_refuse_untimed_asr(self):
        with self.assertRaises(RuntimeError): funasr_rows([{'text':'没有时间戳'}],5.)
    def test_bad_intervals(self):
        self.assertFalse(valid([{'start':2.,'end':1.,'text':'错误'}],5.))
        self.assertFalse(valid([],5.))


_import_private_environment.__exit__(None, None, None)


def setUpModule():
    global _running_private_environment
    _running_private_environment = _configured_private_environment()
    _running_private_environment.__enter__()


def tearDownModule():
    _running_private_environment.__exit__(None, None, None)

if __name__=='__main__': unittest.main()
