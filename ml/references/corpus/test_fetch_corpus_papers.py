import sys as _test_sys
from pathlib import Path as _TestPath
_test_sys.path.insert(0, str(_TestPath(__file__).resolve().parents[3]))

from ml.common.private_env_test_fixture import configured_private_environment as _configured_private_environment
_import_private_environment = _configured_private_environment()
_import_private_environment.__enter__()

import hashlib
import json
from pathlib import Path
import tempfile
import unittest
from unittest.mock import patch
from fetch_corpus_papers import submit
from fetch_corpus_papers import classify_title, encoded_lines, receive, DONE, CONFIG, verify_row, select_rows, normalized_title


class PapersTest(unittest.TestCase):
    def setUp(self):
        self.config = json.loads(CONFIG.read_text())
        Path('/tmp/corpus/papers').mkdir(parents=True, exist_ok=True)
        self.directory = tempfile.TemporaryDirectory(dir='/tmp/corpus/papers')
        self.addCleanup(self.directory.cleanup)

    def test_practice_and_noise(self):
        for title in ['人像摄影的用光技巧', '纪实摄影的瞬间把握', '摄影构图实践', '风光摄影曝光']:
            self.assertTrue(classify_title(title, self.config), title)
        for title in ['无人机倾斜摄影测量', '摄影构图在广告设计中的应用', '风光互补发电', '利用光纤传感器', '山水画摄影构图', '胸片医学摄影', None]:
            self.assertFalse(classify_title(title, self.config), title)
        self.assertEqual(classify_title('逆光人像摄影构图', self.config), ['portrait', 'composition', 'light_exposure'])

    def logs(self, name='text/a.txt', raw=None):
        return '\n'.join([*encoded_lines(name, raw if raw is not None else ('中文正文\n'*9000).encode()), DONE])

    def test_unicode_multichunk_roundtrip(self):
        raw = ('中文正文\n'*9000).encode()
        self.assertEqual(receive(self.logs(raw=raw), self.directory.name), 1)
        self.assertEqual((Path(self.directory.name)/'text/a.txt').read_bytes(), raw)
        self.assertFalse(list(Path(self.directory.name).rglob('*.part')))

    def test_empty_roundtrip(self):
        receive(self.logs(raw=b''), self.directory.name)
        self.assertEqual((Path(self.directory.name)/'text/a.txt').read_bytes(), b'')

    def test_incomplete_duplicate_corrupt(self):
        lines = self.logs().splitlines()
        for invalid in ['\n'.join(lines[:-1]), '\n'.join([lines[0], *lines]), '\n'.join([*lines[1:]])]:
            with self.assertRaises(ValueError): receive(invalid, self.directory.name)
        item = json.loads(lines[0][len('PAPER_CHUNK '):]); item['chunk_sha256'] = '0'*64
        with self.assertRaises(ValueError): receive('\n'.join(['PAPER_CHUNK '+json.dumps(item), *lines[1:]]), self.directory.name)
        self.assertFalse(list(Path(self.directory.name).rglob('*.txt')))

    def test_path_and_destination(self):
        for name in ['../outside.txt', '/tmp/outside.txt']:
            with self.assertRaises(ValueError): receive(self.logs(name), self.directory.name)
        with self.assertRaises(ValueError): receive(self.logs(), '/tmp')

    def test_id_validation(self):
        class Table:
            num_rows = 1
            def slice(self, row, count): return self
            def to_pylist(self): return [{'id': 'real', 'text': '正文'}]
        self.assertEqual(verify_row(Table(), {'id': 'real', 'row': 0})['text'], '正文')
        for item in [{'id': 'wrong', 'row': 0}, {'id': 'real', 'row': -1}, {'id': 'real', 'row': 1}]:
            with self.assertRaises(ValueError): verify_row(Table(), item)

    def test_local_selection_keeps_locations_and_saved_review_order(self):
        rows = [
            {'id': 'a', 'title': '摄影构图实践', 'chars': 1000, 'file': 4, 'row_group': 2, 'row': 19},
            {'id': 'noise', 'title': '摄影测量构图', 'chars': 1000},
            {'id': 'b', 'title': '人像摄影用光', 'chars': 900},
            {'id': 'short', 'title': '风光摄影', 'chars': 50},
            {'id': 'theory', 'title': '纪实摄影文化研究', 'chars': 1000},
        ]
        config = {**self.config, 'selection': {'minChars': 800, 'maxChars': 20000,
            'orderByReviewIndex': True, 'reviewedAccept': [
                {'id': 'a', 'title': rows[0]['title'], 'reviewIndex': 7},
                {'id': 'b', 'title': rows[2]['title'], 'reviewIndex': 3}]}}
        chosen, stats = select_rows(rows, config)
        self.assertEqual([r['id'] for r in chosen], ['b', 'a'])
        self.assertEqual([r['candidateIndex'] for r in chosen], [0, 1])
        self.assertEqual(chosen[1]['screenIndex'], 0)
        self.assertEqual([chosen[1][k] for k in ('file', 'row_group', 'row')], [4, 2, 19])
        self.assertEqual(stats['categories'], {'portrait': 1, 'light_exposure': 1, 'composition': 1})
        self.assertEqual(stats['keywordRejected'], 1)
        self.assertEqual(stats['lengthRejected'], 1)
        self.assertEqual(stats['titleReviewRejected'], 1)
        self.assertNotIn('candidateIndex', rows[0])
        with self.assertRaisesRegex(ValueError, 'missing'):
            select_rows(rows[:1], config)
        changed = [{**rows[0], 'title': '摄影构图其他实践'}, *rows[1:]]
        with self.assertRaisesRegex(ValueError, 'title changed'):
            select_rows(changed, config)

    def test_selection_normalized_duplicate_titles(self):
        self.assertEqual(normalized_title('人像 摄影：用光'), normalized_title('人像摄影用光'))
        rows = [{'id': str(i), 'title': title, 'chars': 1000} for i, title in enumerate(
            ['人像 摄影：用光', '人像摄影用光', '新闻摄影瞬间'])]
        # Include a duplicate ID with a distinct title as well.
        rows.append({**rows[-1], 'title': '纪实摄影实践'})
        selected, stats = select_rows(rows, {**self.config, 'selection': {}})
        self.assertEqual(len(selected), 2)
        self.assertEqual(stats['duplicateRejected'], 2)

    def test_malformed_decoder_metadata_and_payload(self):
        item = json.loads(self.logs(raw=b'abc').splitlines()[0][len('PAPER_CHUNK '):])
        mutations = [{'data': '%%%invalid'}, {'data': 'eA=='}, {'index': -1},
            {'index': 1}, {'count': 0}, {'size': True}, {'path': {}}, {'path': '.'}]
        for mutation in mutations:
            with self.subTest(mutation=mutation), self.assertRaises(ValueError):
                receive('PAPER_CHUNK ' + json.dumps({**item, **mutation}) + '\n' + DONE, self.directory.name)
        for logs in [DONE, 'PAPER_CHUNK {}\n' + DONE, 'PAPER_CHUNK {\n' + DONE]:
            with self.assertRaises(ValueError): receive(logs, self.directory.name)
        self.assertFalse(list(Path(self.directory.name).rglob('*.txt')))

    def test_cpu_submission_limit_and_ownership(self):
        active = [{'submission_id': 'w3-papers-a', 'status': 'RUNNING'},
                  {'submission_id': 'w3-papers-b', 'status': 'PENDING'}]
        with patch('fetch_corpus_papers.request', return_value=active) as api:
            with self.assertRaisesRegex(ValueError, 'two own'):
                submit('fetch', 'w3-papers-c', [])
            self.assertEqual(api.call_count, 1)  # No submission at capacity.
        others = [{'submission_id': 'books-a', 'status': 'RUNNING'}]
        with patch('fetch_corpus_papers.request', side_effect=[others, {'submitted': True}]) as api:
            submit('scan', 'w3-papers-new', {})
            body = api.call_args.kwargs['body']
            self.assertEqual(body['entrypoint_num_gpus'], 0)
            self.assertEqual(body['entrypoint_num_cpus'], 8)
        with patch('fetch_corpus_papers.request') as api:
            with self.assertRaises(ValueError):
                submit('fetch', 'books-a', [])
            with self.assertRaises(ValueError):
                submit('arbitrary', 'w3-papers-a', [])
            api.assert_not_called()



_import_private_environment.__exit__(None, None, None)


def setUpModule():
    global _running_private_environment
    _running_private_environment = _configured_private_environment()
    _running_private_environment.__enter__()


def tearDownModule():
    _running_private_environment.__exit__(None, None, None)

if __name__ == '__main__': unittest.main()
