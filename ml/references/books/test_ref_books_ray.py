"""Tests adapted from w4-pbooks/test_photo_books_ray.py; no Ray submissions."""
import sys as _test_sys
from pathlib import Path as _TestPath
_test_sys.path.insert(0, str(_TestPath(__file__).resolve().parents[3]))

from ml.common.private_env_test_fixture import configured_private_environment as _configured_private_environment
_import_private_environment = _configured_private_environment()
_import_private_environment.__enter__()

import hashlib
import io
import json
from contextlib import redirect_stdout
from pathlib import Path
import tempfile
import unittest
from unittest.mock import patch
import ref_books_ray as runner
from transfer_rules import receive


class RefBookRunnerTests(unittest.TestCase):
    def entries(self):
        return [{'source':runner.BOOK_SOURCES.get(slug,'ref-books'),'remote_rel':'reference-books/'+name,'size':4,'sha256':hashlib.sha256(b'book').hexdigest(),'slug':slug} for slug,name in runner.BOOKS.items()]

    def test_exact_manifest_selection_includes_excerpt_and_hashes(self):
        with tempfile.TemporaryDirectory() as tmp:
            manifest=Path(tmp)/'manifest.json';files=self.entries()
            manifest.write_text(json.dumps({'files':files}))
            self.assertEqual(runner.selection(manifest),files)
            self.assertTrue(next(f for f in files if f['slug']=='photographers-eye-excerpt')['remote_rel'].endswith('.txt'))
            eye=next(f for f in files if f['slug']=='photographers-eye-zh')
            self.assertEqual(eye['source'],'ref-books-extra')
            eye['source']='ref-books';manifest.write_text(json.dumps({'files':files}))
            with self.assertRaises(ValueError):runner.selection(manifest)
            eye['source']='ref-books-extra'
            for bad in ['../'+runner.BOOKS[files[0]['slug']], '/reference-books/'+runner.BOOKS[files[0]['slug']]]:
                files[0]['remote_rel']=bad;manifest.write_text(json.dumps({'files':files}))
                with self.assertRaises(ValueError):runner.selection(manifest)
            files=self.entries();files[0]['sha256']='bad';manifest.write_text(json.dumps({'files':files}))
            with self.assertRaises(ValueError):runner.selection(manifest)

    def test_arrival_size_and_digest_and_partial(self):
        with tempfile.TemporaryDirectory() as tmp,patch.object(runner,'CEPH',tmp):
            files=self.entries()
            for f in files:
                p=Path(tmp)/f['source']/'raw'/f['remote_rel'];p.parent.mkdir(parents=True,exist_ok=True);p.write_bytes(b'book')
            p=Path(tmp)/files[0]['source']/'raw'/files[0]['remote_rel'];p.write_bytes(b'xxxx')
            p=Path(tmp)/files[1]['source']/'raw'/files[1]['remote_rel'];p.rename(str(p)+'.part')
            logs=io.StringIO()
            with redirect_stdout(logs):exec(runner.check_source(files),{})
            rows=[json.loads(line.split(' ',1)[1]) for line in logs.getvalue().splitlines()]
            self.assertFalse(rows[0]['ready']);self.assertFalse(rows[1]['exists'])
            self.assertTrue(all(r['ready'] for r in rows[2:]))

    def test_explicit_page_export_and_verified_transfer(self):
        with tempfile.TemporaryDirectory() as tmp,patch.object(runner,'CEPH',tmp):
            dest=Path(tmp)/'reference-books'/'text'/'magnum-streetwise';(dest/'.pages').mkdir(parents=True)
            (dest/'toc.json').write_text(json.dumps({'pages':3,'chapters':[]}));(dest/'quality.json').write_text('{}')
            for number in (1,2,3):(dest/'.pages'/f'{number:04d}.json').write_text(json.dumps({'text':f'[p.{number}]\nselected text {number}'}))
            output=io.StringIO()
            with redirect_stdout(output):exec(runner.export_source('magnum-streetwise',[2]),{})
            received=Path(tmp)/'receive';self.assertEqual(receive(output.getvalue(),received),3)
            self.assertEqual(sorted(p.name for p in (received/'pages').iterdir()),['0002.txt'])
            self.assertIn('[p.2]',(received/'pages'/'0002.txt').read_text())
        with self.assertRaises(ValueError):runner.export_source('magnum-streetwise',[])
        with self.assertRaises(ValueError):runner.export_source('../escape',[1])
        with self.assertRaises(ValueError):runner.export_source('hurn-jay',[True])

    def test_direct_page_and_txt_extract_do_not_transfer_full_text(self):
        source=runner.batch_source(self.entries(),['hurn-jay','photographers-eye-excerpt'])
        compile(source,'<batch>','exec')
        self.assertIn('extractor.extract_book',source)
        self.assertNotIn('W2_CHUNK',source)
        parallel=runner.batch_source(self.entries(),['magnum-streetwise'],workers=6)
        self.assertIn('workers=6',parallel)
        self.assertIn('workers=workers',parallel)
        with self.assertRaises(ValueError):runner.batch_source(self.entries(),['magnum-streetwise'],workers=9)
        with self.assertRaises(ValueError):runner.batch_source(self.entries(),[])
        with self.assertRaises(ValueError):runner.batch_source(self.entries(),['hurn-jay','hurn-jay'])
        with tempfile.TemporaryDirectory() as tmp,patch.object(runner,'CEPH',tmp):
            f=next(f for f in self.entries() if f['slug']=='photographers-eye-excerpt')
            p=Path(tmp)/f['source']/'raw'/f['remote_rel'];p.parent.mkdir(parents=True);p.write_bytes(b'book')
            with redirect_stdout(io.StringIO()):exec(runner.batch_source([f],[f['slug']]),{})
            dest=Path(tmp)/'reference-books'/'text'/f['slug']
            self.assertEqual((dest/'chapters'/'01.txt').read_text(),'book')
            p.write_bytes(b'xxxx')
            with self.assertRaisesRegex(ValueError,'SHA mismatch'):exec(runner.batch_source([f],[f['slug']]),{})

    def test_selected_image_job_has_input_audit(self):
        source=runner.image_source(self.entries(),'magnum-streetwise',[7])
        compile(source,'<images>','exec');self.assertIn('audited(files[0])',source)
        self.assertIn('pages=[7]',source)
        with self.assertRaises(ValueError):runner.image_source(self.entries(),'photographers-eye-excerpt',[1])

    def test_chinese_eye_uses_ocr_and_ceph_text_destination(self):
        source=runner.batch_source(self.entries(),['photographers-eye-zh'])
        compile(source,'<eye-batch>','exec')
        self.assertIn('photographers-eye-zh',runner.OCR_SLUGS)
        self.assertIn("'source': 'ref-books-extra'",source)
        self.assertIn("else 'reference-books')/'text'",source)
        self.assertNotIn('W2_CHUNK',source)

    def test_materials_selection_exact_paths_and_full_arrival_audit(self):
        manifest = Path(__file__).resolve().parents[1] / 'portrait_courses_manifest.json'
        selected = runner.selection(manifest, collection='materials-books')
        self.assertEqual([f['slug'] for f in selected], list(runner.MATERIALS_BOOKS))
        self.assertTrue(all(f['source']=='materials-books' for f in selected))
        audited = runner.selection(manifest, collection='materials-books', audit=True)
        self.assertEqual(len(audited), 15)
        self.assertEqual(sum(f['remote_rel'].endswith('.epub') for f in audited), 1)
        self.assertEqual(sum('.no_watermark.zh.mono.pdf' in f['remote_rel'] for f in audited), 4)
        self.assertEqual(runner.selection(manifest, slugs=['adler-pitfalls']), [selected[1]])
        with tempfile.TemporaryDirectory() as tmp:
            path=Path(tmp)/'manifest.json'
            selected[1]['remote_rel']='books/wrong/'+Path(selected[1]['remote_rel']).name
            path.write_text(json.dumps({'files':selected}))
            with self.assertRaises(ValueError):runner.selection(path, slugs=['adler-pitfalls'])
        with self.assertRaises(ValueError):runner.selection(manifest, slugs=['adler-pitfalls','adler-pitfalls'])

    def test_materials_extract_and_export_use_same_ceph_tree(self):
        manifest = Path(__file__).resolve().parents[1] / 'portrait_courses_manifest.json'
        files = runner.selection(manifest, collection='materials-books')
        self.assertTrue(set(runner.MATERIALS_BOOKS).issubset(runner.OCR_SLUGS))
        code = runner.batch_source(files, list(runner.MATERIALS_BOOKS), workers=2)
        compile(code, '<materials-batch>', 'exec')
        self.assertIn("'materials-books' if f['source']=='materials-books'", code)
        self.assertIn('ocr.extract_pdf', code)
        self.assertNotIn('W2_CHUNK',code)
        with tempfile.TemporaryDirectory() as tmp, patch.object(runner,'CEPH',tmp):
            dest=Path(tmp)/'materials-books'/'text'/'adler-pitfalls'
            (dest/'.pages').mkdir(parents=True)
            (dest/'toc.json').write_text(json.dumps({'pages':2,'chapters':[]}))
            (dest/'quality.json').write_text('{}')
            (dest/'.pages'/'0001.json').write_text(json.dumps({'text':'synthetic page'}))
            output=io.StringIO()
            with redirect_stdout(output):exec(runner.export_source('adler-pitfalls',[1]),{})
            received=Path(tmp)/'receive'
            self.assertEqual(receive(output.getvalue(),received),3)
            self.assertEqual((received/'pages'/'0001.txt').read_text(),'synthetic page')

    def test_pose_local_dir_sets_job_prefix_and_own_ledger(self):
        with tempfile.TemporaryDirectory() as tmp, patch.object(runner,'LOCAL',Path(tmp)/'w4-posebooks'), \
             patch.object(runner,'request',return_value={'status':'SUCCEEDED'}) as req, redirect_stdout(io.StringIO()):
            job=runner.submit('print(1)','test')
            self.assertTrue(job.startswith('w4-posebooks-test-'))
            self.assertEqual(json.loads((runner.LOCAL/'ray-jobs.json').read_text()), [job])
            self.assertEqual(req.call_args.kwargs['body']['entrypoint_num_gpus'],0)

    def test_local_dir_isolates_own_ledger_and_receive(self):
        with tempfile.TemporaryDirectory() as tmp,patch.object(runner,'LOCAL',Path(tmp)/'default'):
            isolated=Path(tmp)/'w4-eye';isolated.mkdir()
            (isolated/'ray-jobs.json').write_text(json.dumps(['eye-export']))
            with patch.object(runner,'request',side_effect=[{'status':'SUCCEEDED'},{'logs':'selected'}]) as req, \
                 patch.object(runner,'receive',return_value=3) as recv,redirect_stdout(io.StringIO()), \
                 patch('sys.argv',['runner','receive','--local-dir',str(isolated),'--slug','photographers-eye-zh','--id','eye-export']):
                runner.main()
                self.assertEqual([c.args[0] for c in req.call_args_list],['eye-export','eye-export/logs'])
                recv.assert_called_once_with('selected',isolated.resolve()/'photographers-eye-zh')
            self.assertFalse((Path(tmp)/'default').exists())

    def test_concurrency_and_gpu_ledger(self):
        with tempfile.TemporaryDirectory() as tmp,patch.object(runner,'LOCAL',Path(tmp)):
            path=Path(tmp)/'ray-jobs.json';path.write_text(json.dumps(['own-one','own-two']))
            with patch.object(runner,'request',return_value={'status':'RUNNING'}) as req:
                with self.assertRaises(ValueError):runner.submit('print(1)','test')
                self.assertEqual([c.args[0] for c in req.call_args_list],['own-one','own-two'])
            path.write_text(json.dumps(['own-one']));(Path(tmp)/'gpu-jobs.json').write_text(json.dumps(['own-one']))
            with patch.object(runner,'request',return_value={'status':'PENDING'}):
                with self.assertRaises(ValueError):runner.submit('print(1)','test',gpus=1)
            def response(path='',body=None):return {'status':'SUCCEEDED'} if body is None else {'job_id':body['submission_id']}
            with patch.object(runner,'request',side_effect=response) as req,redirect_stdout(io.StringIO()):
                job=runner.submit('print(1)','test',gpus=1)
                body=req.call_args.kwargs['body'];self.assertEqual(body['entrypoint_num_gpus'],1)
                self.assertEqual(body['entrypoint_num_cpus'],2)
                self.assertIn(job,json.loads(path.read_text()))
                self.assertIn(job,json.loads((Path(tmp)/'gpu-jobs.json').read_text()))

    def test_receive_rejects_running_job_before_reading_partial_logs(self):
        with tempfile.TemporaryDirectory() as tmp, patch.object(runner, 'LOCAL', Path(tmp)):
            (Path(tmp)/'ray-jobs.json').write_text(json.dumps(['own']))
            with patch.object(runner, 'request', return_value={'status':'RUNNING'}) as req, \
                 patch('sys.argv', ['runner','receive','--id','own']):
                with self.assertRaisesRegex(ValueError, 'completed job'):
                    runner.main()
                req.assert_called_once_with('own')

    def test_poll_throttle_and_unowned_receive_rejected(self):
        with tempfile.TemporaryDirectory() as tmp,patch.object(runner,'LOCAL',Path(tmp)),patch.object(runner,'selection',return_value=[]),patch.object(runner,'submit') as submit:
            (Path(tmp)/'last-check.json').write_text(json.dumps({'time':1000}))
            with patch.object(runner.time,'time',return_value=1299),patch('sys.argv',['runner','check','--manifest','ignored']):
                with self.assertRaises(ValueError):runner.main()
            submit.assert_not_called()
            with patch('sys.argv',['runner','receive','--id','foreign']),redirect_stdout(io.StringIO()),patch('sys.stderr',io.StringIO()):
                with self.assertRaises(SystemExit):runner.main()



_import_private_environment.__exit__(None, None, None)


def setUpModule():
    global _running_private_environment
    _running_private_environment = _configured_private_environment()
    _running_private_environment.__enter__()


def tearDownModule():
    _running_private_environment.__exit__(None, None, None)

if __name__=='__main__':unittest.main()
