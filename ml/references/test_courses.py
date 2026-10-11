"""Manifest identity, readiness, checksum and private transfer regression tests."""
import sys as _test_sys
from pathlib import Path as _TestPath
_test_sys.path.insert(0, str(_TestPath(__file__).resolve().parents[2]))

from ml.common.private_env_test_fixture import configured_private_environment as _configured_private_environment
_import_private_environment = _configured_private_environment()
_import_private_environment.__enter__()

import contextlib
import io
import hashlib
import json
from pathlib import Path
import tempfile
import unittest
from unittest.mock import patch
from asr_job import verify_source, cache_matches
from courses import build, export_code, probe_code, watch_code, MEYEROWITZ, valid_data, asr_env, submit_code, refresh_durations


class CourseTests(unittest.TestCase):
    def item(self, name='hanjing/10_10.坐姿.mp4', source='hanjing'):
        return {'source':source,'remote_rel':name,'size':3,
                'sha256':hashlib.sha256(b'abc').hexdigest(),'duration_seconds':10}

    def test_collision_free_filename_ids_and_remote_path(self):
        files=[self.item('hanjing/31_30.靠姿2.mp4'),self.item('hanjing/32_30.靠姿1.mp4')]
        m=build({'files':files},'hanjing')
        self.assertNotEqual(m['videos'][0]['bvid'],m['videos'][1]['bvid'])
        self.assertEqual([v['episode'] for v in m['videos']],[31,32])
        self.assertIn('/hanjing/raw/hanjing/',m['videos'][0]['source_path'])
        self.assertNotIn('local',m['videos'][0])

    def test_missing_duration_filled_only_from_matching_asr_source(self):
        with tempfile.TemporaryDirectory() as temp:
            root=Path(temp);manifest=root/(MEYEROWITZ+'-manifest.json')
            video=build({'files':[self.item('03.mp4',MEYEROWITZ)]},MEYEROWITZ)['videos'][0]
            video['duration_seconds']=None
            manifest.write_text(json.dumps({'videos':[video]}))
            asr=root/MEYEROWITZ/'asr';asr.mkdir(parents=True)
            stats=asr/(video['bvid']+'.stats.json')
            stats.write_text(json.dumps({'source_sha256':'wrong','duration':23,'error':None}))
            refresh_durations(root,MEYEROWITZ)
            self.assertIsNone(json.loads(manifest.read_text())['videos'][0]['duration_seconds'])
            stats.write_text(json.dumps({'source_sha256':video['sha256'],'duration':23,'error':None}))
            refresh_durations(root,MEYEROWITZ)
            self.assertEqual(json.loads(manifest.read_text())['videos'][0]['duration_seconds'],23)

    def test_cpu_submission_respects_owned_cap_without_touching_other_jobs(self):
        other={'submission_id':'upload-active','status':'RUNNING'}
        owned=[{'submission_id':'w4-courses-own-'+str(i),'status':'RUNNING'} for i in range(2)]
        with patch('courses.request',return_value=[other,*owned]) as request:
            with self.assertRaisesRegex(ValueError,'two owned'):submit_code('pass','w4-courses-test')
            request.assert_called_once_with()
        with patch('courses.request',side_effect=[[other,owned[0]],{'submission_id':'w4-courses-test'}]) as request:
            submit_code('pass','w4-courses-test')
            body=request.call_args.kwargs['body']
            self.assertEqual((body['entrypoint_num_gpus'],body['entrypoint_num_cpus']),(0,1))

    def test_asr_cache_separates_language_and_model(self):
        old={'backend':'whisper','model':'large-v3'}
        self.assertTrue(cache_matches(old,'whisper','zh','large-v3'))
        self.assertFalse(cache_matches(old,'whisper','en','large-v3'))
        en=dict(old,language='en')
        self.assertTrue(cache_matches(en,'whisper','en','large-v3'))
        self.assertFalse(cache_matches(en,'whisper','en','small.en'))
        self.assertFalse(cache_matches(en,'funasr','en','large-v3'))

    def test_english_course_namespace_missing_duration_and_private_root(self):
        item=self.item('courses/master/03-LookingAtPictures.mp4',MEYEROWITZ)
        item.pop('duration_seconds')
        video=build({'files':[item]},MEYEROWITZ)['videos'][0]
        self.assertEqual((video['course'],video['episode']),('joel-meyerowitz',3))
        self.assertIsNone(video['duration_seconds'])
        self.assertIn('/materials-courses-meyerowitz/raw/courses/',video['source_path'])
        self.assertTrue(valid_data(Path('/tmp/w4-meyerowitz-data/sub'),MEYEROWITZ))
        self.assertFalse(valid_data(Path('/tmp/w4-courses-data'),MEYEROWITZ))
        self.assertFalse(valid_data(Path('/tmp/w4-meyerowitz-data/../else'),MEYEROWITZ))
        self.assertIn('REF_ASR_LANGUAGE=en',asr_env(MEYEROWITZ))
        self.assertEqual(asr_env('hanjing'),[])

    def test_unsafe_manifest_rejected(self):
        for name in ('../secret.mp4','/secret.mp4'):
            with self.assertRaises(ValueError):build({'files':[self.item(name)]},'hanjing')
        invalid=self.item();invalid['sha256']='bad'
        with self.assertRaises(ValueError):build({'files':[invalid]},'hanjing')

    def test_count_only_and_course_namespace(self):
        m=build({'files':[self.item('season-2/12.后期修图.mp4','linhaiyin'),
                          self.item('season-3/12.自然光.mp4','linhaiyin')]},'linhaiyin')
        self.assertTrue(m['videos'][0]['count_only'])
        self.assertFalse(m['videos'][1]['count_only'])
        self.assertNotEqual(m['videos'][0]['bvid'],m['videos'][1]['bvid'])

    def test_checksum_before_compute_and_cached_reuse(self):
        with tempfile.TemporaryDirectory() as folder:
            p=Path(folder)/'input.mp4';p.write_bytes(b'abc');v=self.item()
            self.assertEqual(verify_source(p,v),v['sha256'])
            p.write_bytes(b'xyz')
            with self.assertRaisesRegex(ValueError,'SHA-256'):verify_source(p,v)
            p.write_bytes(b'ab')
            with self.assertRaisesRegex(ValueError,'size'):verify_source(p,v)
            part=p.with_suffix('.part');part.write_bytes(b'abc')
            with self.assertRaises(ValueError):verify_source(part,v)

    def test_probe_rejects_partial_and_wrong_size(self):
        with tempfile.TemporaryDirectory() as folder:
            p=Path(folder)/'input.mp4';p.with_suffix('.mp4.part').write_bytes(b'abc')
            m=build({'files':[self.item()]},'hanjing');m['videos'][0]['source_path']=str(p)
            import contextlib,io
            stream=io.StringIO()
            with contextlib.redirect_stdout(stream):exec(probe_code([m]),{})
            line=stream.getvalue().splitlines()[0]
            self.assertFalse(json.loads(line.split(' ',1)[1])['ready'])
            p.write_bytes(b'abc');stream=io.StringIO()
            with contextlib.redirect_stdout(stream):exec(probe_code([m]),{})
            self.assertTrue(json.loads(stream.getvalue().splitlines()[0].split(' ',1)[1])['ready'])
            p.write_bytes(b'xyz');stream=io.StringIO()
            with contextlib.redirect_stdout(stream):exec(probe_code([m]),{})
            self.assertFalse(json.loads(stream.getvalue().splitlines()[0].split(' ',1)[1])['ready'])

    def test_cluster_watch_has_five_minute_interval_and_deadline(self):
        for seconds in (299,10801):
            with self.assertRaises(ValueError):watch_code([],seconds)
        code=watch_code([],900)
        compile(code,'watch','exec')
        self.assertIn('time.sleep(300)',code)
        self.assertIn('time.monotonic()+300<=deadline',code)
        self.assertNotIn('time.sleep(5)',code)

    def test_watch_hash_verification_and_five_minute_tick(self):
        with tempfile.TemporaryDirectory() as folder:
            path=Path(folder)/'complete.mp4';path.write_bytes(b'xyz')
            manifest=build({'files':[self.item()]},'hanjing')
            manifest['videos'][0]['source_path']=str(path)
            output=io.StringIO()
            with patch('time.sleep') as sleep,patch('time.monotonic',side_effect=[0,0,900]),contextlib.redirect_stdout(output):
                exec(watch_code([manifest],900,'hanjing',1),{})
            sleep.assert_called_once_with(300)
            self.assertIn('COURSE_WATCH_TIMEOUT',output.getvalue())
            self.assertNotIn('COURSE_PROBE_DONE',output.getvalue())
            path.write_bytes(b'abc');output=io.StringIO()
            with patch('time.sleep'),patch('time.monotonic',return_value=0),contextlib.redirect_stdout(output):
                exec(watch_code([manifest],900,'hanjing',1),{})
            self.assertIn('COURSE_PROBE_DONE',output.getvalue())
            arrival=next(line for line in output.getvalue().splitlines() if line.startswith('COURSE_ARRIVAL '))
            self.assertEqual(json.loads(arrival.split(' ',1)[1])['sha256'],self.item()['sha256'])

    def test_export_allowlist_and_budget(self):
        code=export_code('hanjing')
        self.assertIn("['asr','topics']",code)
        self.assertIn('300*1024*1024',code)
        self.assertNotIn("['raw']",code)
        with self.assertRaises(ValueError):export_code('../secret')

    def test_qa_export_requires_all_requested_episodes_and_omits_stale_sheets(self):
        import contextlib,io
        with tempfile.TemporaryDirectory() as folder,patch('courses.CEPH',folder):
            root=Path(folder)/'hanjing';(root/'qa').mkdir(parents=True);(root/'topics').mkdir()
            (root/'qa'/'a-sheet-999.jpg').write_bytes(b'obsolete')
            for ident in ('a','b'):
                path=root/'qa'/(ident+'.html');path.write_bytes(b'QA')
                (root/'topics'/(ident+'.stats.json')).write_text(json.dumps({
                    'qa_artifacts':[{'path':str(path),'sha256':hashlib.sha256(b'QA').hexdigest()}]}))
            with contextlib.redirect_stdout(io.StringIO()),self.assertRaisesRegex(ValueError,'incomplete'):
                exec(export_code('hanjing',True,['a','b','c']),{})
            path=root/'qa'/'c.html';path.write_bytes(b'QA')
            (root/'topics'/'c.stats.json').write_text(json.dumps({
                'qa_artifacts':[{'path':str(path),'sha256':hashlib.sha256(b'QA').hexdigest()}]}))
            output=io.StringIO()
            with contextlib.redirect_stdout(output):exec(export_code('hanjing',True,['a','b','c']),{})
            chunks=[json.loads(line[9:]) for line in output.getvalue().splitlines() if line.startswith('W2_CHUNK ')]
            self.assertEqual({c['path'] for c in chunks},{'qa/a.html','qa/b.html','qa/c.html'})



_import_private_environment.__exit__(None, None, None)


def setUpModule():
    global _running_private_environment
    _running_private_environment = _configured_private_environment()
    _running_private_environment.__enter__()


def tearDownModule():
    _running_private_environment.__exit__(None, None, None)

if __name__=='__main__':unittest.main()
