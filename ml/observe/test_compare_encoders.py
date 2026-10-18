from copy import deepcopy
import json
from pathlib import Path
import tempfile
import unittest

import numpy as np

from ml.observe.compare_encoders import (compare_report, coverage_win, descriptive_frontier, frozen_metrics,
                                         reference_hash, runtime_eligibility, validate_gate_flags,
                                         validate_model_sidecars, validate_reference_scores)
from ml.observe.train_heads import ATTRIBUTES, MIN_STATEMENTS, positive_scores


def scored_entry(refs, probabilities, threshold=0.8, key='smile'):
    p, y = np.array(probabilities), np.array([row[1] for row in refs])
    launch = positive_scores(p, y, threshold)
    gates = {'ece': True, 'launch': bool(launch['statements'] >= MIN_STATEMENTS
                                       and launch['precision'] >= ATTRIBUTES[key]['launch'] and launch['precisionLow'] >= 0.85)}
    if key != 'gaze':
        gates['celebaWithin5'] = True
    return {'trainRows': 10, 'calibrationRows': 3, 'showThreshold': threshold, 'passed': all(gates.values()),
            'gates': gates, 'holdoutTeacher': {'ece': 0.01},
            'celeba': {'student': {'precision': 0.9}, 'teacherPrecision': 0.91},
            'launch': {'all': launch},
            'launchReferenceScores': {'ids': [row[0] for row in refs], 'labels': y.tolist(),
                                      'sources': [row[2] for row in refs], 'probabilities': p.tolist(),
                                      'referenceHash': reference_hash(refs),
                                      **{k: v for k, v in frozen_metrics(p, y, threshold).items()
                                         if k in ('hits', 'statements', 'rows', 'positives')}}}


class CompareEncodersTest(unittest.TestCase):
    def test_frontier_keeps_entire_ties_and_drops_probabilities_below_half(self):
        p, y = np.array([0.9, 0.8, 0.8, 0.4]), np.array([1, 1, 0, 1])
        result = descriptive_frontier(p, y, {'hits': 1, 'statements': 1})
        self.assertEqual((result['statements'], result['threshold']), (1, 0.9))
        result = descriptive_frontier(p, y, {'hits': 2, 'statements': 3})
        self.assertEqual((result['statements'], result['hits'], result['threshold']), (3, 2, 0.8))
        self.assertIsNone(descriptive_frontier(np.array([0.6, 0.4]), np.array([0, 1]),
                                              {'hits': 1, 'statements': 1}))

    def test_no_lower_precision_requires_exact_counts_even_when_rounded_values_match(self):
        baseline = {'hits': 9, 'statements': 10, 'rows': 1000}
        candidate = {'hits': 899, 'statements': 999, 'rows': 1000}
        self.assertEqual(round(candidate['hits'] / candidate['statements'], 3), 0.9)
        self.assertFalse(coverage_win(candidate, baseline))
        self.assertTrue(coverage_win({**candidate, 'hits': 900}, baseline))

    def test_reference_validation_accepts_reordering_but_rejects_hash_population_and_count_changes(self):
        refs = [('a', 1, 'photos'), ('b', 0, 'openimages'), ('c', 1, 'openimages')]
        entry = scored_entry(list(reversed(refs)), [0.9, 0.2, 0.8])
        p, y, frozen = validate_reference_scores(entry, refs)
        self.assertEqual((frozen['hits'], frozen['statements']), (2, 2))
        changes = [lambda scores: scores.update(referenceHash='0' * 64),
                   lambda scores: scores['ids'].__setitem__(0, 'other'),
                   lambda scores: scores['labels'].__setitem__(0, 0),
                   lambda scores: scores['sources'].__setitem__(0, 'photos'),
                   lambda scores: scores.update(hits=1),
                   lambda scores: scores['probabilities'].__setitem__(0, float('nan'))]
        for change in changes:
            altered = deepcopy(entry)
            change(altered['launchReferenceScores'])
            with self.subTest(altered=altered), self.assertRaises(ValueError):
                validate_reference_scores(altered, refs)

    def test_extra_attribute_cannot_hide_a_failed_retained_gate(self):
        attributes = {key: {'passesOriginalGates': True, 'coverageWinAtNoLowerPrecision': False}
                      for key in ('smile', 'mouth', 'gaze')}
        self.assertTrue(runtime_eligibility(attributes)['eligibleForRuntimeCheck'])
        attributes['mouth']['passesOriginalGates'] = False
        self.assertFalse(runtime_eligibility(attributes)['eligibleForRuntimeCheck'])
        attributes['mouth']['passesOriginalGates'] = True
        attributes['gaze']['passesOriginalGates'] = False
        self.assertFalse(runtime_eligibility(attributes)['eligibleForRuntimeCheck'])
        attributes['smile']['coverageWinAtNoLowerPrecision'] = True
        self.assertTrue(runtime_eligibility(attributes)['eligibleForRuntimeCheck'])

    def test_descriptive_frontier_cannot_make_a_frozen_point_eligible(self):
        refs = [(str(index), int(index < 300), 'openimages') for index in range(400)]
        probabilities = [0.9] * 180 + [0.75] * 120 + [0.85] * 10 + [0.1] * 90
        pools = {key: refs for key in ('smile', 'mouth', 'gaze')}
        historical = {'attributes': {key: {'trainRows': 10, 'calibrationRows': 3} for key in pools}}
        baseline = {'attributes': {key: {'frozen': {'hits': 190, 'statements': 200, 'rows': 400,
                                                   'precision': 0.95}} for key in pools}}
        report = {'encoder': {'id': 'candidate'},
                  'attributes': {key: scored_entry(refs, probabilities, key=key) for key in pools}}
        result = compare_report(report, baseline, historical, pools)
        self.assertIsNotNone(result['attributes']['smile']['descriptiveEqualPrecision'])
        self.assertFalse(result['attributes']['smile']['coverageWinAtNoLowerPrecision'])
        self.assertFalse(result['eligibleForRuntimeCheck'])
        report['attributes']['smile']['trainRows'] += 1
        with self.assertRaisesRegex(ValueError, 'population changed'):
            compare_report(report, baseline, historical, pools)

    def test_gate_flags_follow_existing_rounded_metrics_and_reject_contradictions(self):
        entry = {'showThreshold': 0.8, 'passed': True, 'gates': {'ece': True, 'launch': True, 'celebaWithin5': True},
                 'holdoutTeacher': {'ece': 0.05},
                 'celeba': {'student': {'precision': 0.86}, 'teacherPrecision': 0.9},
                 'launch': {'all': {'statements': 140, 'precision': 0.9, 'precisionLow': 0.85}}}
        validate_gate_flags(entry, 'smile')
        changes = [lambda item: item['holdoutTeacher'].update(ece=0.0501),
                   lambda item: item['celeba']['student'].update(precision=0.8),
                   lambda item: item['launch']['all'].update(statements=139),
                   lambda item: item['launch']['all'].update(precision=0.899),
                   lambda item: item['launch']['all'].update(precisionLow=0.849),
                   lambda item: item.update(passed=False)]
        for change in changes:
            altered = deepcopy(entry)
            change(altered)
            with self.subTest(altered=altered), self.assertRaisesRegex(ValueError, 'gate flags contradict'):
                validate_gate_flags(altered, 'smile')
        validate_gate_flags({'showThreshold': None, 'passed': False, 'gates': {},
                             'holdoutTeacher': {'ece': 0.5}}, 'gaze')

    def test_feature_sidecars_bind_report_to_its_encoder_precision_dimensions_and_model(self):
        with tempfile.TemporaryDirectory() as directory:
            path = Path(directory) / 'candidate' / 'training-fp32.json'
            encoder = {'id': 'candidate', 'dimensions': 768, 'modelSha256': 'a' * 64}
            metadata = {'encoder': 'candidate', 'precision': 'fp32', 'dimensions': 768, 'modelSha256': 'a' * 64}
            for source in ('oi', 'panel', 'p0'):
                sidecar = path.parent / 'fp32' / (source + '.json')
                sidecar.parent.mkdir(parents=True, exist_ok=True)
                sidecar.write_text(json.dumps(metadata))
            validate_model_sidecars(path, encoder, 'fp32')
            for field, value in (('encoder', 'other'), ('precision', 'fp16'), ('dimensions', 512),
                                 ('modelSha256', 'b' * 64)):
                (path.parent / 'fp32/panel.json').write_text(json.dumps({**metadata, field: value}))
                with self.subTest(field=field), self.assertRaisesRegex(ValueError, 'feature identity differs'):
                    validate_model_sidecars(path, encoder, 'fp32')
            (path.parent / 'fp32/panel.json').write_text(json.dumps(metadata))
            (path.parent / 'fp32/p0.json').unlink()
            with self.assertRaisesRegex(ValueError, 'missing or invalid'):
                validate_model_sidecars(path, encoder, 'fp32')


if __name__ == '__main__':
    unittest.main()
