import sys as _test_sys
from pathlib import Path as _TestPath
_test_sys.path.insert(0, str(_TestPath(__file__).resolve().parents[3]))

from ml.common.private_env_test_fixture import configured_private_environment as _configured_private_environment
_import_private_environment = _configured_private_environment()
_import_private_environment.__enter__()

import hashlib
import importlib.util
import json
import multiprocessing
import os
from pathlib import Path
import tempfile
import unittest
from unittest.mock import patch

import ocr_ref_pdf_job as job


@unittest.skipUnless(importlib.util.find_spec('fitz') and importlib.util.find_spec('pypdf'), 'optional PDF dependencies unavailable')
class OCRJobTests(unittest.TestCase):
    def setUp(self):
        Path('/tmp/w4-refbooks').mkdir(parents=True, exist_ok=True)
        self.tmp = tempfile.TemporaryDirectory(dir='/tmp/w4-refbooks')
        self.addCleanup(self.tmp.cleanup)
        self.root = Path(self.tmp.name)

    def pdf(self, name='book.pdf', scanned=False, changed=False):
        import fitz
        path = self.root / name
        with fitz.open() as pdf:
            for i in range(2):
                p = pdf.new_page(width=500, height=400)
                if not scanned:
                    p.insert_text((30,60), ('Changed' if changed else 'Chapter') + ' text on this page with sufficient meaningful letters for a text layer.')
                else:
                    # A page number alone must trigger OCR even though a text layer exists.
                    p.insert_text((30,300),str(i+1))
            pdf.set_toc([[1,'Composition',1],[1,'Lighting',2]])
            pdf.save(path)
        return path

    def test_materials_sparse_text_blank_and_scanned_page_number(self):
        import fitz
        source = self.root/'hybrid.pdf'
        with fitz.open() as pdf:
            pdf.new_page().insert_text((20, 30), 'Sparse title')
            pdf.new_page()
            page = pdf.new_page()
            pix = fitz.Pixmap(fitz.csRGB, fitz.IRect(0, 0, 100, 100), False)
            pix.clear_with(255)
            page.insert_image(page.rect, pixmap=pix)
            page.insert_text((20, 30), '3')
            pdf.save(source)
        calls = []
        def ocr(image):
            calls.append(image)
            return [([[1,1],[90,1],[90,20],[1,20]], 'Scanned text', .95)], None
        dest, _, quality = job.extract_pdf(source,'materials',self.root,ocr=ocr,text_layer_first=True)
        self.assertEqual([q['ocr_used'] for q in quality], [False, False, True])
        self.assertEqual(len(calls), 1)
        self.assertTrue(quality[1]['empty'])
        self.assertIn('Sparse title', (dest/'.pages/0001.json').read_text())
        job.extract_pdf(source,'materials',self.root,ocr=ocr,text_layer_first=True)
        self.assertEqual(len(calls), 1)

    def test_forced_ocr_invalidates_usable_layer_cache(self):
        source = self.pdf()
        job.extract_pdf(source, 'forced', self.root)
        calls = []
        def ocr(image):
            calls.append(image)
            return [([[1,1],[90,1],[90,20],[1,20]], '重新识别的中文', .95)], None
        dest, toc, quality = job.extract_pdf(source, 'forced', self.root, ocr=ocr, force_ocr=True)
        self.assertEqual(len(calls), 2)
        self.assertTrue(toc['force_ocr'])
        self.assertTrue(all(q['ocr_used'] for q in quality))
        self.assertIn('重新识别的中文', (dest/'chapters/01.txt').read_text())

    def test_real_text_pdf_bookmarks_and_input_integrity(self):
        source = self.pdf(); before = hashlib.sha256(source.read_bytes()).hexdigest()
        with patch.object(job,'_ocr_engine',side_effect=AssertionError('must use text layer')):
            dest,toc,q = job.extract_pdf(source,'text',self.root)
        self.assertTrue(toc['complete'])
        self.assertEqual([c['title'] for c in toc['chapters']],['Composition','Lighting'])
        self.assertIn('[p.2]',(dest/'chapters/02.txt').read_text())
        self.assertTrue(all(not p['ocr_used'] for p in q))
        self.assertEqual(hashlib.sha256(source.read_bytes()).hexdigest(),before)

    def test_scanned_page_ocr_resume_and_changed_source_invalidation(self):
        source=self.pdf(scanned=True)
        calls=[]
        def ocr(image):
            calls.append(image)
            return [([[1,1],[90,1],[90,20],[1,20]],'合成测试中文',.9)],None
        dest,toc,q=job.extract_pdf(source,'scanned',self.root,pages='1',ocr=ocr)
        self.assertFalse(toc['complete']);self.assertTrue(q[0]['ocr_used'])
        self.assertIn('合成测试中文',(dest/'chapters/01.txt').read_text())
        job.extract_pdf(source,'scanned',self.root,pages='1',ocr=ocr)
        self.assertEqual(len(calls),1)
        job.extract_pdf(source,'scanned',self.root,ocr=ocr)
        self.assertEqual(len(calls),2)
        changed=self.pdf(name='changed.pdf',scanned=False,changed=True)
        _,toc,q=job.extract_pdf(changed,'scanned',self.root,ocr=ocr)
        self.assertTrue(toc['complete']);self.assertFalse(q[0]['ocr_used'])
        self.assertIn('Changed',(dest/'chapters/01.txt').read_text())

    def test_output_symlink_and_invalid_pages(self):
        source=self.pdf()
        outside=self.root/'outside';outside.mkdir()
        slug=self.root/'unsafe';slug.symlink_to(outside,target_is_directory=True)
        with self.assertRaises(job.OCRBookError):job.extract_pdf(source,'unsafe',self.root)
        dest=self.root/'unsafe-file';dest.mkdir()
        (dest/'toc.json').symlink_to(self.root/'other.json')
        with self.assertRaises(job.OCRBookError):job.extract_pdf(source,'unsafe-file',self.root)
        with self.assertRaises(job.OCRBookError):job._destination('/tmp','forbidden')
        for value in ['2-1','0','3']:
            with self.assertRaises(job.OCRBookError):job._parse_pages(value,2)

    def test_fork_workers_match_serial_output_and_reuse_cached_pages(self):
        import fitz
        source = self.pdf(scanned=True)
        calls = self.root/'worker-calls.txt'
        def ocr(image):
            with calls.open('a') as log: log.write(str(os.getpid())+'\n')
            rows = [([[x,y],[x+80,y],[x+80,y+20],[x,y+20]],text,.9)
                    for x,y,text in [(20,80,'左下'),(700,10,'右上'),
                                     (20,10,'左上'),(700,80,'右下')]]
            return rows, None
        serial, toc_serial, quality_serial = job.extract_pdf(source,'serial',self.root,ocr=ocr)
        calls.unlink()
        # Populate only page 1; the parallel pass must dispatch page 2 alone.
        dest, _, _ = job.extract_pdf(source,'parallel',self.root,pages='1',ocr=ocr)
        calls.unlink()
        active_before = {p.pid for p in multiprocessing.active_children()}
        with patch.object(job, '_ocr_engine', return_value=(fitz, ocr)), \
             patch.dict(os.environ, {'REFBOOK_USE_CUDA': '0'}):
            _, toc_parallel, quality_parallel = job.extract_pdf(source,'parallel',self.root,workers=4)
        pids = [int(line) for line in calls.read_text().splitlines()]
        self.assertEqual(len(pids), 1)
        self.assertNotEqual(pids[0], os.getpid())
        self.assertEqual({p.pid for p in multiprocessing.active_children()}, active_before)
        self.assertEqual(quality_parallel, quality_serial)
        self.assertEqual(toc_parallel['chapters'], toc_serial['chapters'])
        self.assertTrue(all(q['suspected_columns'] for q in quality_parallel))
        for chapter in toc_parallel['chapters']:
            self.assertEqual((dest/chapter['file']).read_text(), (serial/chapter['file']).read_text())
        calls.unlink()
        with patch.object(job, '_ocr_engine', return_value=(fitz, ocr)), \
             patch.dict(os.environ, {'REFBOOK_USE_CUDA': '0'}):
            full, _, quality_full = job.extract_pdf(source,'parallel-full',self.root,workers=4)
        self.assertEqual(quality_full, quality_serial)
        self.assertEqual(len(calls.read_text().splitlines()), 2)
        self.assertTrue(all(int(pid) != os.getpid() for pid in calls.read_text().splitlines()))
        for chapter in toc_parallel['chapters']:
            self.assertEqual((full/chapter['file']).read_text(), (serial/chapter['file']).read_text())
        with patch.object(job.multiprocessing, 'get_context', side_effect=AssertionError('cached pages need no pool')):
            job.extract_pdf(source,'parallel',self.root,workers=4)

    def test_worker_failure_propagates_and_cleans_pool(self):
        source = self.pdf(scanned=True)
        active_before = {p.pid for p in multiprocessing.active_children()}
        with patch.object(job, '_ocr_engine', side_effect=job.OCRBookError('synthetic failure')), \
             patch.dict(os.environ, {'REFBOOK_USE_CUDA': '0'}):
            with self.assertRaisesRegex(job.OCRBookError, 'synthetic failure'):
                job.extract_pdf(source,'failed-pool',self.root,workers=4)
        self.assertEqual({p.pid for p in multiprocessing.active_children()}, active_before)

    def test_gpu_forces_serial_and_text_layer_needs_no_workers(self):
        source = self.pdf(scanned=True)
        def ocr(image): return [([[1,1],[90,1],[90,20],[1,20]],'合成测试',.9)],None
        with patch.dict(os.environ, {'REFBOOK_USE_CUDA': '1'}), \
             patch.object(job.multiprocessing, 'get_context', side_effect=AssertionError('GPU must stay serial')):
            _, _, quality = job.extract_pdf(source,'gpu-serial',self.root,ocr=ocr,workers=4)
            self.assertTrue(all(q['ocr_used'] for q in quality))
        with patch.object(job.multiprocessing, 'get_context', side_effect=AssertionError('text needs no pool')):
            job.extract_pdf(self.pdf(name='text-only.pdf'),'text-workers',self.root,workers=4)
        for invalid in [0,9,1.5,True]:
            with self.assertRaises(job.OCRBookError):
                job.extract_pdf(source,'invalid-workers',self.root,workers=invalid)
        with patch.dict(os.environ, {'REFBOOK_USE_CUDA': '0'}):
            with self.assertRaisesRegex(job.OCRBookError, 'injected OCR'):
                job.extract_pdf(source,'injected-workers',self.root,ocr=ocr,workers=4)


class OCRLayoutTests(unittest.TestCase):
    def test_metadata_handles_pdfplumber_bytes_and_pypdf_strings(self):
        title = '合成构图教材'
        self.assertEqual(job._metadata_text({'/Title': title}, '/Title', 'Title'), title)
        for encoding in ['utf-8', 'utf-16']:
            self.assertEqual(job._metadata_text({'Title': title.encode(encoding)}, '/Title', 'Title'), title)
        self.assertEqual(job._metadata_text({'/Title': b'\xff', 'Title': title}, '/Title', 'Title'), title)
        self.assertEqual(job._metadata_text({'/Title': None}, '/Title', 'Title'), '')

    def test_pose_destinations_and_nearby_paths(self):
        for root in [job.POSE_LOCAL_ROOT, job.POSE_CEPH_ROOT]:
            self.assertEqual(job._destination(root,'adler-pitfalls'),(root/'adler-pitfalls').resolve())
        for root in ['/tmp/w4-posebooks-other', job.POSE_CEPH_ROOT.parent/'raw']:
            with self.assertRaises(job.OCRBookError):job._destination(root,'adler-pitfalls')

    def test_column_order_and_heading(self):
        rows=[]
        for x,y,text in [(10,80,'左下'),(210,10,'右上'),(10,10,'左上'),(210,80,'右下')]:
            rows.append(([[x,y],[x+80,y],[x+80,y+20],[x,y+20]],text,.9))
        text,confidence,columns=job._ordered_ocr(rows,300)
        self.assertTrue(columns);self.assertEqual(text.splitlines(),['左上','左下','右上','右下'])
        self.assertAlmostEqual(confidence,.9)
        self.assertTrue(job._heading('第三章 构图'))



_import_private_environment.__exit__(None, None, None)


def setUpModule():
    global _running_private_environment
    _running_private_environment = _configured_private_environment()
    _running_private_environment.__enter__()


def tearDownModule():
    _running_private_environment.__exit__(None, None, None)

if __name__ == '__main__':unittest.main()
