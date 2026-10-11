"""Synthetic-only tests: no corpus, network, or Ray submission required."""
import sys as _test_sys
from pathlib import Path as _TestPath
_test_sys.path.insert(0, str(_TestPath(__file__).resolve().parents[3]))

from ml.common.private_env_test_fixture import configured_private_environment as _configured_private_environment
_import_private_environment = _configured_private_environment()
_import_private_environment.__enter__()

import base64
import contextlib
import gzip
import hashlib
import importlib.util
import io
import json
from pathlib import Path
import tempfile
import unittest

SPEC = importlib.util.spec_from_file_location('fetch_corpus_books', Path(__file__).with_name('fetch_corpus_books.py'))
fetch = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(fetch)


def synthetic_book(text='# Composition\n\nKeep the main subject readable.\n'):
    return {'slug': 'synthetic-book', 'id': 'synthetic-id', 'lang': 'en', 'file': 3,
            'row_group': 1, 'row': 20, 'channel': 'libgen', 'title': 'Synthetic Book',
            'year': 2020, 'text': text}


def export_logs(payload):
    namespace = {}
    exec(fetch.EXPORT_SOURCE, namespace)
    output = io.StringIO()
    with contextlib.redirect_stdout(output):
        namespace['export_payload'](payload)
    return output.getvalue()


class ChapterTests(unittest.TestCase):
    def test_markdown_split_preserves_text_and_original_line_locators(self):
        text = 'Preface\n\n# Composition\n\nSubject first.\n\nSecond paragraph.\n\n## Light\n\nShadow detail.\n'
        chapters = fetch.split_chapters(text)
        self.assertEqual([x['title'] for x in chapters], ['Front matter', 'Composition', 'Light'])
        self.assertEqual(''.join(x['text'] for x in chapters), text)
        self.assertEqual(chapters[1]['line_start'], 3)
        self.assertEqual(chapters[1]['line_end'], 8)
        self.assertEqual(chapters[1]['paragraphs'][2], {'number': 3, 'line_start': 7, 'line_end': 7})

    def test_standalone_heading_and_setext(self):
        text = 'CHAPTER ONE\n\nFirst paragraph.\n\nUsing Light\n\nSecond paragraph.\n\nExposure\n========\nThird paragraph.\n'
        chapters = fetch.split_chapters(text)
        self.assertEqual([x['title'] for x in chapters], ['CHAPTER ONE', 'Using Light', 'Exposure'])
        self.assertEqual(''.join(x['text'] for x in chapters), text)

    def test_prose_fallback_and_empty_error(self):
        text = 'This is a prose paragraph.\n\nA long observation about composition follows here.\n'
        chapters = fetch.split_chapters(text)
        self.assertEqual(len(chapters), 1)
        self.assertEqual(chapters[0]['title'], 'Full text')
        self.assertEqual(chapters[0]['text'], text)
        with self.assertRaises(ValueError):
            fetch.split_chapters(' \n')

    def test_write_compatible_toc_and_confined_output(self):
        fetch.OUTPUT_ROOT.mkdir(parents=True, exist_ok=True)
        with tempfile.TemporaryDirectory(dir=fetch.OUTPUT_ROOT) as tmp:
            book = synthetic_book()
            target, toc = fetch.write_book(book, tmp)
            self.assertEqual(toc['format'], 'corpus')
            self.assertEqual(toc['corpusRef']['id'], 'synthetic-id')
            self.assertNotIn('file', toc['corpusRef'])
            self.assertEqual((target / toc['chapters'][0]['file']).read_text(), book['text'])
            self.assertEqual(json.loads((target / 'toc.json').read_text()), toc)
            self.assertEqual((target / 'book.txt').read_text(), book['text'])
        with self.assertRaises(ValueError):
            fetch.write_book(synthetic_book(), '/tmp/disallowed-book-output')

    def test_symlink_rejected(self):
        fetch.OUTPUT_ROOT.mkdir(parents=True, exist_ok=True)
        with tempfile.TemporaryDirectory(dir=fetch.OUTPUT_ROOT) as tmp:
            target = Path(tmp) / 'synthetic-book'
            target.symlink_to('/tmp', target_is_directory=True)
            with self.assertRaises(ValueError):
                fetch.write_book(synthetic_book(), tmp)

    def test_second_batch_output_is_confined(self):
        root = Path('/tmp/corpus/cbooks2')
        root.mkdir(parents=True, exist_ok=True)
        with tempfile.TemporaryDirectory(dir=root) as tmp:
            target, _ = fetch.write_book(synthetic_book(), tmp)
            self.assertEqual((target / 'book.txt').read_text(), synthetic_book()['text'])
        for output in ('/tmp/corpus/cbooks20', '/tmp/corpus/cbooks2/../outside'):
            with self.assertRaises(ValueError):
                fetch.write_book(synthetic_book(), output)


class ExportTests(unittest.TestCase):
    def test_roundtrip_base64_gzip_nonascii_multichunk(self):
        # Random deterministic byte hashes prevent an unrealistically tiny gzip.
        text = ''.join(hashlib.sha256(str(i).encode()).hexdigest() for i in range(4000)) + '光影'
        payload = {'books': [synthetic_book(text)]}
        logs = export_logs(payload)
        self.assertGreater(logs.count('CBOOKS_CHUNK '), 1)
        prefixed = '\n'.join('(Ray worker) ' + line for line in logs.splitlines())
        self.assertEqual(fetch.decode_exports(prefixed), payload)

    def test_missing_end_and_missing_chunk(self):
        logs = export_logs({'books': [synthetic_book()]})
        lines = logs.splitlines()
        for broken in ('\n'.join(lines[:-1]), '\n'.join(lines[1:])):
            with self.assertRaises(ValueError):
                fetch.decode_exports(broken)

    def test_duplicate_chunk_and_checksum(self):
        logs = export_logs({'books': [synthetic_book()]})
        with self.assertRaises(ValueError):
            fetch.decode_exports(logs.splitlines()[0] + '\n' + logs)
        lines = logs.splitlines()
        end = json.loads(lines[-1].split('CBOOKS_END ')[1])
        end['sha256'] = '0' * 64
        lines[-1] = 'CBOOKS_END ' + json.dumps(end)
        with self.assertRaises(ValueError):
            fetch.decode_exports('\n'.join(lines))

    def test_receive_requires_book_payload(self):
        with self.assertRaises(ValueError):
            fetch.receive(export_logs({'books': []}))


class RemoteSourceTests(unittest.TestCase):
    def test_sources_compile_without_local_pyarrow(self):
        scan = fetch.build_scan_source(r'(?i)portrait|\bposing\b')
        source = fetch.build_fetch_source([synthetic_book()])
        compile(scan, '<scan>', 'exec')
        compile(source, '<fetch>', 'exec')
        self.assertIn('ProcessPoolExecutor(8)', scan)
        self.assertIn("table['id'][row]", source)
        self.assertIn("book['row'] - offset", source)
        self.assertNotIn('Keep the main subject readable.', source)

    def test_selection_rejects_duplicate_slug_and_bad_channel(self):
        book = synthetic_book()
        with self.assertRaises(ValueError):
            fetch.build_fetch_source([book, book])
        for field, value in [('slug', '../unsafe'), ('channel', 'cnki'), ('file', -1)]:
            with self.assertRaises(ValueError):
                fetch.build_fetch_source([dict(book, **{field: value})])



_import_private_environment.__exit__(None, None, None)


def setUpModule():
    global _running_private_environment
    _running_private_environment = _configured_private_environment()
    _running_private_environment.__enter__()


def tearDownModule():
    _running_private_environment.__exit__(None, None, None)

if __name__ == '__main__':
    unittest.main()
