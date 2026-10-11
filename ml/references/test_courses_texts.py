import sys as _test_sys
from pathlib import Path as _TestPath
_test_sys.path.insert(0, str(_TestPath(__file__).resolve().parents[2]))

from ml.common.private_env_test_fixture import configured_private_environment as _configured_private_environment
_import_private_environment = _configured_private_environment()
_import_private_environment.__enter__()

import hashlib
import importlib.util
import json
from pathlib import Path
import tempfile
import unittest
import sys
import types
from unittest.mock import patch

spec = importlib.util.spec_from_file_location('course_text_extract', Path(__file__).parent/'courses_texts/extract.py')
extract = importlib.util.module_from_spec(spec); spec.loader.exec_module(extract)


class CourseTextsTests(unittest.TestCase):
    def test_subtitle_fragments_preserve_intervals_and_cleanup(self):
        raw = ('1\r\n00:00:01,100 --> 00:00:02,300\r\n<i>hello</i>\r\n\r\n'
               '2\r\n00:00:02,400 --> 00:00:03,900\r\nworld.\r\n\r\n'
               '3\r\n00:00:08.000 --> 00:00:09.000\r\n中文。\r\n').encode('utf-8-sig')
        cues, sentences = extract.parse_srt(raw)
        self.assertEqual(len(cues), 3)
        self.assertEqual(sentences, [{'start':1.1,'end':3.9,'text':'hello world.'}, {'start':8.0,'end':9.0,'text':'中文。'}])

    def test_gap_and_duration_bound_chinese_merge(self):
        raw = ('1\n00:00:01,000 --> 00:00:02,000\n前半\n\n'
               '2\n00:00:02,000 --> 00:00:03,000\n后半\n\n'
               '3\n00:00:05,001 --> 00:00:06,000\n下一段\n\n'
               '4\n00:00:06,000 --> 00:00:38,000\n很长\n').encode()
        self.assertEqual([s['text'] for s in extract.parse_srt(raw)[1]], ['前半后半','下一段','很长'])

    def test_chinese_encodings_and_multiple_sentences_in_one_cue(self):
        text='1\n00:00:01,000 --> 00:00:02,000\n中文。下一句！ \n'
        for encoding in ('utf-16','gb18030','utf-8-sig'):
            rows=extract.parse_srt(text.encode(encoding))[1]
            self.assertEqual([r['text'] for r in rows],['中文。','下一句！'])
            self.assertTrue(all(r['start']==1 and r['end']==2 for r in rows))

    def test_zero_duration_source_marker_is_preserved_without_inventing_time(self):
        raw=b'1\n00:00:01,000 --> 00:00:01,000\nSynthetic point.\n'
        cues,sentences=extract.parse_srt(raw)
        self.assertEqual(cues,[{'start':1.0,'end':1.0,'text':'Synthetic point.'}])
        self.assertEqual(sentences,cues)

    def test_bad_timestamps_and_no_cues_rejected(self):
        for raw in (b'no timestamps', b'1\n00:00:02,000 --> 00:00:01,000\ntext', b'1\n00:60:02,000 --> 00:61:03,000\ntext'):
            with self.assertRaises(ValueError):extract.parse_srt(raw)

    def test_manifest_identity_is_path_stable_and_text_only(self):
        f={'source':extract.SOURCE,'remote_rel':'courses/04-大师课/Magnum-The Art of Street Photography/09 Editing.srt','size':3,'sha256':'a'*64}
        manifest={'files':[f, dict(f,source='materials-courses',remote_rel='ignored.mp4')]}
        selected=extract.select(manifest)
        self.assertEqual(len(selected),1);self.assertEqual(selected[0]['episode'],9)
        self.assertEqual(selected[0]['bvid'],extract.select(manifest)[0]['bvid'])
        for rel in ('../escape.srt','/absolute.srt', f['remote_rel']+'.part'):
            with self.assertRaises(ValueError):extract.select({'files':[dict(f,remote_rel=rel)]})
        with self.assertRaises(ValueError):extract.select({'files':[f,f]})

    def test_extract_audits_input_and_outputs_and_never_writes_raw(self):
        raw=b'1\n00:00:01,000 --> 00:00:02,000\nSynthetic test.\n'
        f={'source':extract.SOURCE,'remote_rel':'courses/04-大师课/Magnum-The Art of Street Photography/01 Synthetic.srt','size':len(raw),'sha256':hashlib.sha256(raw).hexdigest()}
        files=extract.select({'files':[f]})
        with tempfile.TemporaryDirectory() as d:
            p=Path(d)/extract.SOURCE/'raw'/f['remote_rel'];p.parent.mkdir(parents=True);p.write_bytes(raw)
            with patch('builtins.print'):
                m=extract.extract(d,files)
            v=m['videos'][0];output=Path(d)/extract.SOURCE/'text'/v['output']
            self.assertEqual(hashlib.sha256(output.read_bytes()).hexdigest(),v['output_sha256'])
            self.assertEqual(v['sentences'],1);self.assertEqual(p.read_bytes(),raw)
            p.write_bytes(b'x'*len(raw))
            with self.assertRaisesRegex(ValueError,'SHA256'):extract.audited(d,files[0])

    def test_pdf_page_numbers_empty_pages_and_source_digest(self):
        raw=b'synthetic PDF test bytes'
        f={'source':extract.SOURCE,'remote_rel':'courses/04-大师课/Annie Leibovitz-MasterClass/PDF/09 Synthetic.pdf','size':len(raw),'sha256':hashlib.sha256(raw).hexdigest()}
        reader=types.SimpleNamespace(pages=[types.SimpleNamespace(extract_text=lambda:'Synthetic text only.'),types.SimpleNamespace(extract_text=lambda:None)])
        with tempfile.TemporaryDirectory() as d:
            source=Path(d)/extract.SOURCE/'raw'/f['remote_rel'];source.parent.mkdir(parents=True);source.write_bytes(raw)
            with patch.dict(sys.modules,{'pypdf':types.SimpleNamespace(PdfReader=lambda stream:reader)}),patch('builtins.print'):
                manifest=extract.extract(d,extract.select({'files':[f]}))
            v=manifest['videos'][0];data=json.loads((Path(d)/extract.SOURCE/'text'/v['output']).read_text())
            self.assertEqual((v['pages'],v['emptyPages']),(2,1))
            self.assertEqual(data['pages'],[{'page':1,'text':'Synthetic text only.'},{'page':2,'text':''}])
            self.assertEqual(source.read_bytes(),raw)

    def test_same_content_copies_are_marked_and_canonical_filename_preferred(self):
        rel='courses/01-人像姿势/Michele Celentano-家庭与群体摆姿/02-Standing/17 Synthetic'
        files=extract.select({'files':[{'source':extract.SOURCE,'remote_rel':rel+suffix,'size':3,'sha256':'a'*64} for suffix in (' (1).srt','.srt')]})
        canonical=next(f for f in files if '(1)' not in f['title'])
        duplicate=next(f for f in files if '(1)' in f['title'])
        self.assertEqual(duplicate['duplicateOf'],canonical['bvid'])
        self.assertNotIn('duplicateOf',canonical)




_import_private_environment.__exit__(None, None, None)


def setUpModule():
    global _running_private_environment
    _running_private_environment = _configured_private_environment()
    _running_private_environment.__enter__()


def tearDownModule():
    _running_private_environment.__exit__(None, None, None)

if __name__ == '__main__':unittest.main()
