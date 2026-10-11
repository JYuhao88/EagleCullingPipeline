import sys as _test_sys
from pathlib import Path as _TestPath
_test_sys.path.insert(0, str(_TestPath(__file__).resolve().parents[3]))

from ml.common.private_env_test_fixture import configured_private_environment as _configured_private_environment
_import_private_environment = _configured_private_environment()
_import_private_environment.__enter__()

import json
import hashlib
import io
from contextlib import redirect_stdout
from pathlib import Path
import tempfile
import unittest
from unittest.mock import patch
import photo_books_ray as runner


class RayRunnerTests(unittest.TestCase):
    def manifest_files(self):
        files = [{'source': 'photo-books', 'remote_rel': 'photography-books/摄影/'+name+'.pdf',
                  'size': 123, 'sha256': 'a'*64} for name in runner.NAMES]
        files.append({'source': 'photo-books-extra',
                      'remote_rel': 'photography-books/摄影/摄影必修课（套装4册）.pdf',
                      'size': 456, 'sha256': 'b'*64})
        return files

    def test_extra_manifest_preserves_source_and_integrity(self):
        files = self.manifest_files()
        with tempfile.TemporaryDirectory() as tmp:
            manifest = Path(tmp)/'manifest.json'
            manifest.write_text(json.dumps({'files': files}))
            selected = runner.selection(manifest)
            self.assertEqual(len(selected), 8)
            self.assertEqual([f['slug'] for f in selected[:7]], runner.SLUGS)
            self.assertTrue(all(f['source'] == 'photo-books' for f in selected[:7]))
            self.assertEqual(selected[-1], files[-1] | {'slug': 'photography-required-course'})
            for bad_path in ['../摄影必修课.pdf', '/摄影必修课.pdf', '摄影必修课.pdf.part']:
                files[-1]['remote_rel'] = bad_path
                manifest.write_text(json.dumps({'files': files}))
                with self.assertRaises(ValueError): runner.selection(manifest)

    def test_check_source_uses_source_raw_paths_and_checks_digest(self):
        with tempfile.TemporaryDirectory() as tmp, patch.object(runner, 'CEPH', tmp):
            files = self.manifest_files()
            for entry in files:
                data = entry['remote_rel'].encode()
                entry.update(size=len(data), sha256=hashlib.sha256(data).hexdigest(), slug=entry['source'])
                path = Path(tmp)/entry['source']/'raw'/entry['remote_rel']
                path.parent.mkdir(parents=True, exist_ok=True)
                path.write_bytes(data)
            # Same length with different contents must fail the hash check.
            corrupt = Path(tmp)/files[0]['source']/'raw'/files[0]['remote_rel']
            corrupt.write_bytes(b'x'*files[0]['size'])
            # A partial upload must never count as the final input.
            absent = Path(tmp)/files[1]['source']/'raw'/files[1]['remote_rel']
            absent.rename(str(absent)+'.part')
            output = io.StringIO()
            with redirect_stdout(output): exec(runner.check_source(files), {})
            results = [json.loads(line.removeprefix('PBOOK_READY ')) for line in
                       output.getvalue().splitlines() if line.startswith('PBOOK_READY ')]
            self.assertEqual(len(results), 8)
            self.assertFalse(results[0]['ready'])
            self.assertFalse(results[1]['exists'])
            self.assertTrue(all(r['ready'] for r in results[2:]))

    def test_ocr_submission_verifies_and_reads_each_source_raw_path(self):
        with tempfile.TemporaryDirectory() as tmp, patch.object(runner, 'LOCAL', Path(tmp)), \
             patch.object(runner, 'CEPH', tmp):
            for source_name, slug in [('photo-books', 'posing'),
                                      ('photo-books-extra', 'photography-required-course')]:
                data = b'synthetic PDF input'
                entry = {'source': source_name, 'remote_rel': 'photography-books/摄影/合成.pdf',
                         'size': len(data), 'sha256': hashlib.sha256(data).hexdigest(), 'slug': slug}
                path = Path(tmp)/source_name/'raw'/entry['remote_rel']
                path.parent.mkdir(parents=True, exist_ok=True)
                path.write_bytes(data)
                with patch.object(runner, 'selection', return_value=[entry]), \
                     patch.object(runner, 'submit') as submit, \
                     patch('sys.argv', ['runner', 'ocr', '--manifest', 'ignored', '--slug', slug, '--pages', '1-2']):
                    runner.main()
                    code, stage, deps = submit.call_args.args
                    self.assertEqual(stage, 'ocr')
                    self.assertIn('pypdf==6.1.1', deps)
                    compile(code, '<ocr-submission>', 'exec')
                    prefix = code.split('\nexec(compile(', 1)[0]
                    exec(prefix, {})
                    import sys
                    self.assertEqual(sys.argv[1], str(path))
                    self.assertEqual(sys.argv[sys.argv.index('--output-dir')+1], tmp+'/photo-books/text')
                    self.assertEqual(sys.argv[-2:], ['--pages', '1-2'])
                    path.write_bytes(b'x'*len(data))
                    with self.assertRaisesRegex(ValueError, 'SHA mismatch'): exec(prefix, {})

    def test_manifest_selection_preserves_hashes_and_rejects_traversal(self):
        files = [{'source':'photo-books','remote_rel':'photography-books/摄影/'+n+'.pdf',
                  'size':123,'sha256':'a'*64} for n in runner.NAMES]
        with tempfile.TemporaryDirectory() as tmp:
            p = Path(tmp)/'manifest.json'
            p.write_text(json.dumps({'files':files}))
            result = runner.selection(p)
            self.assertEqual([f['slug'] for f in result], runner.SLUGS)
            self.assertEqual(result[0]['sha256'], 'a'*64)
            files[0]['remote_rel']='../拍照姿势.pdf'
            p.write_text(json.dumps({'files':files}))
            with self.assertRaises(ValueError): runner.selection(p)

    def test_only_selected_text_files_exported(self):
        source = runner.export_source('posing', [2,5])
        self.assertIn('chapters/02.txt', source)
        self.assertIn('chapters/05.txt', source)
        self.assertNotIn('chapters/01.txt', source)
        self.assertNotIn('.pdf', source)
        self.assertIn('chunk_sha256', source)
        compile(source, '<export>', 'exec')
        compile(runner.check_source([]), '<check>', 'exec')
        with self.assertRaises(ValueError): runner.export_source('../escape', [])

    def test_submit_concurrency_guard_and_cpu_budget(self):
        with tempfile.TemporaryDirectory() as tmp, patch.object(runner, 'LOCAL', Path(tmp)):
            (Path(tmp)/'ray-jobs.json').write_text(json.dumps(['one','two']))
            with patch.object(runner,'request',return_value={'status':'RUNNING'}) as req:
                with self.assertRaises(ValueError): runner.submit('print(1)','test')
                self.assertEqual(req.call_count,2)
            def response(path='',body=None):
                return {'status':'SUCCEEDED'} if body is None else {'job_id':body['submission_id']}
            with patch.object(runner,'request',side_effect=response) as req:
                runner.submit('print(1)','test')
                body=req.call_args.kwargs['body']
                self.assertEqual(body['entrypoint_num_gpus'],0)
                self.assertEqual(body['entrypoint_num_cpus'],2)

    def test_poll_throttle(self):
        with tempfile.TemporaryDirectory() as tmp, patch.object(runner,'LOCAL',Path(tmp)), \
             patch.object(runner,'selection',return_value=[]),patch.object(runner,'submit') as submit:
            (Path(tmp)/'last-check.json').write_text(json.dumps({'time':1000}))
            with patch.object(runner.time,'time',return_value=1299), \
                 patch('sys.argv',['runner','check','--manifest','ignored']):
                with self.assertRaises(ValueError):runner.main()
            submit.assert_not_called()



_import_private_environment.__exit__(None, None, None)


def setUpModule():
    global _running_private_environment
    _running_private_environment = _configured_private_environment()
    _running_private_environment.__enter__()


def tearDownModule():
    _running_private_environment.__exit__(None, None, None)

if __name__ == '__main__':unittest.main()
