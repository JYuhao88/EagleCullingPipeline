"""Offline sensitivity tests for voting denominators, agreement and receipt identity."""
import copy
import json
from pathlib import Path
import tempfile
import unittest
from unittest.mock import patch

from ml.observe import critique_report as reports
from ml.observe import critique_sensitivity as sensitivity
from ml.observe.critique import FAMILIES, split_statements


def write_rows(file, rows):
    file.parent.mkdir(parents=True, exist_ok=True)
    file.write_text(''.join(json.dumps(row, ensure_ascii=False) + '\n' for row in rows))


def voted_rows(patterns, channel='correctness', kind='issue', action=None):
    rows = []
    for index, pattern in enumerate(patterns):
        statement = {'id': 'statement', 'kind': kind, 'category': action or 'exposure'}
        if action:
            statement['action'] = action
        rows.append({'id': str(index), 'ask': 0, 'critique': {}, 'statements': [statement],
                     'judgments': {family: [{'id': 'statement', channel: value}]
                                   for family, value in zip(FAMILIES, pattern) if value is not None}})
    return rows


def fixture(root):
    write_rows(root / 'prepared/manifest.jsonl', [{'id': 'p1', 'set': 'photos'}, {'id': 'o1', 'set': 'openimages'}])
    critique = {'summary': '人物突出', 'strengths': [{'text': '人物突出'}],
                'issues': [{'category': 'exposure', 'text': '面部偏暗', 'region': '面部'}],
                'edits': [{'action': 'exposure', 'direction': '略微提亮', 'reason': '面部偏暗'}], 'verdict': '可修后保留'}
    row = {'id': 'p1', 'image_id': 'p1', 'model': 'example/model', 'variant': 'A', 'ask': 0,
           'prompt_sha256': 'a' * 64, 'content': json.dumps(critique, ensure_ascii=False),
           'critique': critique, 'statements': split_statements(critique)}
    write_rows(root / 'minicpm-int4-4x-full/predictions.jsonl', [row])
    receipts = [{'item_id': 'p1', 'model': row['model'], 'variant': 'A', 'ask': 0,
                 'prompt_sha256': row['prompt_sha256'], 'critique_id': reports.critique_id(row, critique, row['statements']),
                 'teacher': family, 'valid': True,
                 'statements': [{'id': statement['id'], 'correctness': '正确', 'reasonableness': '合理',
                                 'contradiction': '不矛盾', 'novelty': '新增'} for statement in row['statements']]}
                for family in FAMILIES]
    write_rows(root / 'judge-full/judgments.jsonl', receipts)
    return row, receipts


class CritiqueSensitivityTests(unittest.TestCase):
    def test_alternative_rates_keep_unknown_and_exclude_missing_votes_explicitly(self):
        rows = voted_rows([('正确', '正确', '正确'), ('正确', '正确', '错误'),
                           ('正确', '正确', '无法判断'), ('正确', '无法判断', '无法判断'),
                           ('无法判断', '无法判断', '无法判断'), ('错误', '错误', '正确'),
                           ('正确', '正确', None), ('错误', '错误', None), ('正确', '正确', 'invalid')])
        channel = sensitivity.analyze(rows)['channels']['correctness']
        self.assertEqual((channel['emitted'], channel['completeThreeVotes'], channel['incompleteThreeVotes']), (9, 6, 3))
        self.assertEqual(channel['twoOfThreePositive'], {'positive': 3, 'n': 6, 'rate': .5})
        self.assertEqual(channel['twoOfThreeReference'],
                         {'correct': 3, 'wrong': 1, 'disputed': 2, 'judged': 4, 'precision': .75})
        self.assertEqual(channel['nobodyNegative'], {'positive': 4, 'n': 6, 'rate': 4 / 6})
        self.assertEqual(channel['twoOfThreePositiveAndNobodyNegative']['positive'], 2)
        self.assertEqual(channel['allPositive']['positive'], 1)
        self.assertEqual(channel['allCannotJudge']['positive'], 1)
        self.assertEqual(channel['positiveNegativeConflict']['positive'], 2)
        original = channel['preregisteredReference']
        self.assertEqual((original['correct'], original['wrong'], original['disputed']), (1, 2, 6))
        self.assertEqual(original['precision'], 1 / 3)
        self.assertEqual(original['disputedRate'], 6 / 9)
        self.assertEqual(original['disputedRateOnCompleteThreeVotes'], 4 / 6)
        claude = channel['teachers']['claude']
        self.assertEqual((claude['validVotes'], claude['missingVotes'], claude['invalidLabelVotes']), (6, 2, 1))
        self.assertEqual(claude['cannotJudgeRate'], 3 / 6)

    def test_majority_precision_stays_undefined_without_a_decisive_complete_triple(self):
        for patterns, disputed in (([], 0), ([('正确', '正确', None)], 0),
                                    ([('无法判断', '无法判断', '无法判断')], 1)):
            with self.subTest(patterns=patterns):
                channel = sensitivity.analyze(voted_rows(patterns))['channels']['correctness']
                self.assertEqual(channel['twoOfThreeReference'],
                                 {'correct': 0, 'wrong': 0, 'disputed': disputed, 'judged': 0, 'precision': None})

    def test_reasonableness_is_separate_and_excludes_none_edits(self):
        edit = voted_rows([('合理', '合理', '无法判断')], channel='reasonableness', kind='edit', action='exposure')
        noop = voted_rows([('合理', '合理', '合理')], channel='reasonableness', kind='edit', action='none')[0]
        noop['id'] = 'noop'
        issue = voted_rows([('合理', '合理', '合理')], channel='reasonableness')[0]
        issue['id'] = 'issue'
        result = sensitivity.analyze(edit + [noop, issue])['channels']
        self.assertEqual(result['correctness']['emitted'], 3)
        reason = result['reasonableness']
        self.assertEqual(reason['emitted'], 1)
        self.assertEqual(reason['twoOfThreePositive']['rate'], 1)
        self.assertEqual(reason['preregisteredReference']['disputedRate'], 1)
        self.assertEqual(set(reason['byCategory']), {'edit:exposure'})
        self.assertEqual(set(reason['byKind']), {'edit'})

    def test_kappa_known_values_missing_and_constant_marginals(self):
        pairs = [('yes', 'yes')] * 20 + [('yes', 'no')] * 5 + [('no', 'yes')] * 10 + [('no', 'no')] * 15
        result = sensitivity.cohen_kappa(pairs, ('yes', 'no'))
        self.assertAlmostEqual(result['kappa'], .4)
        self.assertEqual(result['n'], 50)
        self.assertEqual(result['matrix'], [[20, 5], [10, 15]])
        self.assertEqual(sensitivity.cohen_kappa([('yes', 'no'), ('no', 'yes')], ('yes', 'no'))['kappa'], -1)
        for pairs in ([], [('yes', 'yes')]):
            self.assertIsNone(sensitivity.cohen_kappa(pairs, ('yes', 'no'))['kappa'])
        with self.assertRaises(ValueError):
            sensitivity.cohen_kappa([('yes', None)], ('yes', 'no'))

    def test_ternary_kappa_and_decisive_kappa_have_separate_denominators(self):
        rows = voted_rows([('正确', '正确', '正确'), ('错误', '错误', '错误'),
                           ('无法判断', '正确', '正确'), ('正确', '正确', None)])
        result = sensitivity.analyze(rows)['channels']['correctness']['pairwise']['flash:gpt']
        self.assertEqual(result['threeLabels']['n'], 3)
        self.assertEqual(result['decisiveOnly']['n'], 2)
        self.assertEqual(result['decisiveOnly']['kappa'], 1)
        self.assertEqual(result['excludedWithoutCompleteThreeVotes'], 1)
        self.assertEqual(result['excludedWithCannotJudgeFromDecisiveOnly'], 1)

    def test_invalid_primary_rows_are_not_silently_included_and_duplicate_ids_fail(self):
        rows = voted_rows([('正确', '正确', '正确')])
        invalid = {'id': 'invalid', 'ask': 0, 'critique': None, 'statements': [], 'judgments': {}}
        result = sensitivity.analyze(rows + [invalid])
        self.assertEqual(result['coverage']['expectedPrimaryPhotos'], 2)
        self.assertEqual(result['coverage']['missingOrInvalidPrimaryPhotos'], 1)
        self.assertEqual(result['channels']['correctness']['emitted'], 1)
        for invalid_rows in ([rows[0], rows[0]], [{**rows[0], 'ask': 1}]):
            with self.assertRaises(ValueError):
                sensitivity.analyze(invalid_rows)

    def test_report_reuses_receipt_identity_and_does_not_overwrite_gate_results(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory) / 'data/cache/w36-vlm-critique'
            row, receipts = fixture(root)
            (root / 'results.json').write_text('original acceptance results\n')
            stale = copy.deepcopy(receipts[1]); stale['critique_id'] = 'b' * 64
            write_rows(root / 'judge-stale/judgments.jsonl', [stale])
            with patch.object(reports, 'CACHE_ROOT', root):
                result = sensitivity.report(root, ['minicpm-int4-4x'])
                a = result['cells'][0]['splits']['photos']
                self.assertEqual(a['channels']['correctness']['completeThreeVotes'], 4)
                self.assertTrue(any(item['error'] == 'stale_judgment' for item in result['diagnostics']))
                self.assertEqual(result['cells'][0]['splits']['all']['coverage']['expectedPrimaryPhotos'], 2)
                first = (root / 'sensitivity.json').read_bytes()
                sensitivity.main(['--root', str(root), '--models', 'minicpm-int4-4x'])
                self.assertEqual((root / 'sensitivity.json').read_bytes(), first)
                self.assertEqual((root / 'results.json').read_text(), 'original acceptance results\n')
                conflict = copy.deepcopy(receipts[0]); conflict['statements'][0]['correctness'] = '错误'
                write_rows(root / 'judge-conflict/judgments.jsonl', [conflict])
                result = sensitivity.report(root, ['minicpm-int4-4x'])
                a = result['cells'][0]['splits']['photos']['channels']['correctness']
                self.assertEqual(a['completeThreeVotes'], 0)
                self.assertEqual(a['twoOfThreePositive']['rate'], None)
                self.assertEqual(a['teachers']['flash']['missingVotes'], 4)
                self.assertTrue(any(item['error'] == 'conflicting_judgment' for item in result['diagnostics']))

    def test_safety_duplicate_predictions_manifest_and_frozen_provenance(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory) / 'data/cache/w36-vlm-critique'
            row, _ = fixture(root)
            with patch.object(reports, 'CACHE_ROOT', root):
                with self.assertRaises(ValueError):
                    sensitivity.report(root, ['../outside'])
                write_rows(root / 'minicpm-int4-4x-full/predictions.jsonl', [row, row])
                result = sensitivity.report(root, ['minicpm-int4-4x'])
                self.assertEqual(result['cells'][0]['splits']['photos']['coverage']['validPrimaryPhotos'], 0)
                self.assertTrue(any(item['error'] == 'duplicate_prediction' for item in result['diagnostics']))
                (root / 'preregistration.json').write_text(json.dumps({'metadata': {}}))
                with self.assertRaises(ValueError):
                    sensitivity.report(root, ['minicpm-int4-4x'])
                (root / 'preregistration.json').unlink()
                write_rows(root / 'prepared/manifest.jsonl', [{'id': 'p1', 'set': 'photos'}, {'id': 'p1', 'set': 'photos'}])
                with self.assertRaises(ValueError):
                    sensitivity.report(root, ['minicpm-int4-4x'])

    def test_output_symlinks_cannot_escape_cache_and_phase_preserves_full(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory) / 'data/cache/w36-vlm-critique'
            row, _ = fixture(root)
            with patch.object(reports, 'CACHE_ROOT', root):
                sensitivity.report(root, ['minicpm-int4-4x'])
                full = (root / 'sensitivity.json').read_bytes()
                write_rows(root / 'minicpm-int4-4x-pilot/predictions.jsonl', [row])
                result = sensitivity.report(root, ['minicpm-int4-4x'], source_phase='pilot')
                self.assertEqual(result['sourcePhase'], 'pilot')
                self.assertEqual((root / 'sensitivity.json').read_bytes(), full)
                outside = Path(directory) / 'outside.json'
                (root / 'sensitivity.json').unlink()
                (root / 'sensitivity.json').symlink_to(outside)
                with self.assertRaises(ValueError):
                    sensitivity.report(root, ['minicpm-int4-4x'])
                self.assertFalse(outside.exists())


if __name__ == '__main__':
    unittest.main()
