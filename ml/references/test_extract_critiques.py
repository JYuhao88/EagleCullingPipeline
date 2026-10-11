"""Source-specific extraction contracts; all model calls are mocked."""
import copy
import importlib.util
import json
import io
from pathlib import Path
import tempfile
import unittest
from unittest.mock import patch

spec = importlib.util.spec_from_file_location('extract_critiques', Path(__file__).with_name('extract_critiques.py'))
extract = importlib.util.module_from_spec(spec)
spec.loader.exec_module(extract)


class GenreExtractionTests(unittest.TestCase):
    def test_cli_defaults_and_rules_merge(self):
        defaults = extract.parse_args([])
        self.assertEqual(defaults.source, 'yidao')
        self.assertEqual(defaults.data, Path('/tmp/w2-rules-data'))
        self.assertEqual(defaults.rules, [extract.ROOT / 'src/rules/portrait.json'])
        args = extract.parse_args(['--source', 'wulin', '--data', '/tmp/w3-genres-data/wulin',
                                  '--rules', 'src/rules/landscape.json', 'src/rules/street.json'])
        merged = extract.load_rules(args.rules)
        self.assertEqual(len(merged['rules']), sum(len(json.loads(p.read_text())['rules']) for p in args.rules))
        self.assertEqual(merged['library'], 'landscape+street')
        self.assertEqual(extract.critique_directory(args.data, args.source), args.data / 'critiques')
        self.assertEqual(extract.critique_directory(defaults.data), defaults.data / 'critiques-v2')
        auto = extract.parse_args(['--source', 'wulin'])
        self.assertEqual([p.stem for p in auto.rules], ['landscape', 'street'])
        with patch('sys.stderr', new=io.StringIO()), self.assertRaises(SystemExit):
            extract.parse_args(['--source', 'unknown'])

    def test_keywords_schema_prompt_and_strict_source_validation(self):
        text = '构图地平线倾斜；雾中前景层次与主体关系，等待瞬间叙事，光线色彩很好'
        topics = extract.preprocess(text, 'wulin')['topics']
        self.assertTrue(set(('composition', 'horizon', 'weather-timing', 'layers', 'subject',
                             'moment', 'story', 'light', 'color')).issubset(topics))
        self.assertNotIn('horizon', extract.preprocess(text)['topics'])
        self.assertFalse(extract.preprocess('等待瞬间', 'wulin')['skipSuggested'])
        self.assertTrue(extract.preprocess('后期蒙版修图', 'wulin')['skipSuggested'])
        self.assertEqual(extract.extraction_schema()['properties']['results']['items']['properties']['topics']['items']['enum'],
                         json.loads(extract.SCHEMA.read_text())['properties']['results']['items']['properties']['topics']['items']['enum'])
        row = {'segment': {'index': 1, 'start': 0, 'end': 5}, 'transcript': text}
        units = extract.split_units(row, source='wulin')
        result = {'results': [{'segmentKey': '1:0', 'verdict': None, 'issues': [], 'praises': [], 'topics': topics}]}
        extract.validate_result(copy.deepcopy(result), units, set(), 'wulin')
        with self.assertRaises(ValueError):
            extract.validate_result(copy.deepcopy(result), units, set())
        self.assertIn('风光、街拍与人文摄影点评', extract.build_prompt(units, [], 'wulin'))
        self.assertIn('人像点评', extract.build_prompt(units, []))

    def test_batch_uses_wulin_schema_without_real_subprocess(self):
        row = {'segment': {'index': 1, 'start': 0, 'end': 5}, 'transcript': '地平线倾斜'}
        units = extract.split_units(row, source='wulin')
        def fake_run(command, **kwargs):
            schema = json.loads(Path(command[command.index('--output-schema') + 1]).read_text())
            self.assertIn('horizon', schema['properties']['results']['items']['properties']['topics']['items']['enum'])
            self.assertIn('风光、街拍', kwargs['input'])
            Path(command[command.index('-o') + 1]).write_text(json.dumps({'results': [
                {'segmentKey': '1:0', 'verdict': 'bad', 'issues': [], 'praises': [], 'topics': ['horizon']}]}))
            return type('Process', (), {'returncode': 0})()
        with tempfile.TemporaryDirectory() as tmp, patch.object(extract.subprocess, 'run', side_effect=fake_run) as run:
            usage = Path(tmp) / 'usage.jsonl'
            results = extract.call_batch(units, [], usage, 'BVTest', source='wulin')
            run.assert_called_once()
            self.assertEqual(results[0]['topics'], ['horizon'])
            self.assertEqual(json.loads(usage.read_text())['source'], 'wulin')

    def test_conflicting_rule_ids(self):
        with tempfile.TemporaryDirectory() as tmp:
            paths = [Path(tmp) / 'a.json', Path(tmp) / 'b.json']
            for i, path in enumerate(paths):
                path.write_text(json.dumps({'library': str(i), 'version': '1', 'rules': [{'id': 'X', 'statement': str(i)}]}))
            with self.assertRaisesRegex(ValueError, 'conflicting rule id'):
                extract.load_rules(paths)

    def test_wulin_preprocess_and_resume_with_timed_only_text(self):
        with tempfile.TemporaryDirectory() as tmp:
            data = Path(tmp)
            (data / 'critiques').mkdir()
            row = {'bvid': 'BVTest', 'segment': {'index': 1, 'start': 0, 'end': 10},
                   'transcript_segments': [{'start': 1, 'end': 4, 'text': '地平线倾斜，主体很好'}]}
            (data / 'critiques/BVTest.jsonl').write_text(json.dumps(row) + '\n')
            cli = ['--source', 'wulin', '--data', str(data)]
            with patch.object(extract, 'call_batch') as call:
                extract.main(cli + ['--preprocess-only'])
                call.assert_not_called()
                flags = json.loads((data / 'preprocessed/BVTest.jsonl').read_text())['preprocessing']
                self.assertIn('horizon', flags['topics'])
                self.assertFalse(flags['skipSuggested'])
                call.side_effect = lambda units, *args: [
                    {'segmentKey': u['segmentKey'], 'verdict': 'good', 'issues': [],
                     'praises': [{'ruleId': None, 'text': '主体明确', 't': 2}], 'topics': ['subject', 'horizon']}
                    for u in units]
                extract.main(cli)
                extract.main(cli)
                self.assertEqual(call.call_count, 1)
                self.assertEqual(call.call_args.args[-1], 'wulin')
                cached = json.loads(next((data / 'extracted/BVTest').glob('*.json')).read_text())
                self.assertEqual(cached['source'], 'wulin')
                self.assertNotIn('transcript_segments', cached)
                self.assertIn('horizon', cached['preprocessing']['topics'])


if __name__ == '__main__':
    unittest.main()
