"""Offline metric tests with known ranks, ties and abstention behavior."""
import math
import unittest

from ml.observe.metrics import binary_metrics, maximal_coverage, roc_auc, wilson_interval


class ProbeMetricsTests(unittest.TestCase):
    def test_auc_perfect_reversed_and_tied(self):
        self.assertEqual(roc_auc([0, 0, 1, 1], [0.1, 0.2, 0.8, 0.9]), 1.0)
        self.assertEqual(roc_auc([0, 0, 1, 1], [0.9, 0.8, 0.2, 0.1]), 0.0)
        self.assertEqual(roc_auc([0, 1, 0, 1], [0.5, 0.5, 0.5, 0.5]), 0.5)
        self.assertEqual(roc_auc([0, 1, 0, 1], [0.1, 0.4, 0.4, 0.9]), 0.875)

    def test_auc_one_class_is_undefined(self):
        self.assertIsNone(roc_auc([1, 1], [0.1, 0.9]))
        self.assertIsNone(roc_auc([0, 0], [0.1, 0.9]))

    def test_confidence_selection_counts_both_labels(self):
        labels = [1, 0, 0, 1, 1, 0, 1, 0, 1, 0]
        probabilities = [0.99, 0.02, 0.03, 0.96, 0.95, 0.15, 0.8, 0.25, 0.4, 0.6]
        result = binary_metrics(labels, probabilities)
        self.assertEqual(result['accuracy'], 0.8)
        self.assertEqual(result['count'], 10)
        half, eighty, all_rows = result['coverage_metrics']
        self.assertEqual((half['count'], half['coverage'], half['selective_accuracy']), (5, 0.5, 1.0))
        self.assertEqual((half['positive_precision'], half['negative_precision']), (1.0, 1.0))
        self.assertEqual((eighty['count'], eighty['coverage'], eighty['selective_accuracy']), (8, 0.8, 1.0))
        self.assertEqual(all_rows['count'], 10)
        self.assertEqual(all_rows['positive_precision'], 0.8)
        self.assertEqual(all_rows['negative_precision'], 0.8)

    def test_confidence_ties_are_not_broken_with_ground_truth(self):
        result = binary_metrics([1, 0, 1, 0], [0.9, 0.1, 0.6, 0.6], coverages=(0.25, 0.75))
        first, second = result['coverage_metrics']
        self.assertEqual(first['requested_coverage'], 0.25)
        self.assertEqual(first['coverage'], 0.5)
        self.assertEqual(second['requested_coverage'], 0.75)
        self.assertEqual(second['coverage'], 1.0)
        self.assertEqual(second['selective_accuracy'], 0.75)

    def test_empty_class_precision_is_not_perfect(self):
        result = binary_metrics([1, 0], [0.9, 0.8])['coverage_metrics'][0]
        self.assertIsNone(result['negative_precision'])
        self.assertIsNone(result['negative_precision_ci95'])

    def test_probability_half_is_positive(self):
        self.assertEqual(binary_metrics([1, 0], [0.5, 0.5])['accuracy'], 0.5)

    def test_maximal_coverage_uses_entire_tie_groups(self):
        self.assertIsNone(maximal_coverage([1, 0], [0.6, 0.6], minimum_accuracy=0.9))
        result = maximal_coverage([1, 0, 0, 1], [0.99, 0.02, 0.9, 0.7])
        self.assertEqual(result['coverage'], 0.5)
        self.assertEqual(result['selective_accuracy'], 1.0)
        self.assertIsNone(maximal_coverage([1, 0, 0, 1], [0.99, 0.02, 0.9, 0.7], minimum_count=3))

    def test_maximal_coverage_searches_past_temporary_failure(self):
        result = maximal_coverage([1, 1, 0, 1], [0.99, 0.02, 0.1, 0.8], minimum_accuracy=0.75)
        self.assertEqual(result['coverage'], 1.0)

    def test_wilson_interval_known_values(self):
        lower, upper = wilson_interval(90, 100)
        self.assertAlmostEqual(lower, 0.8256343385)
        self.assertAlmostEqual(upper, 0.9447708629)
        self.assertIsNone(wilson_interval(0, 0))
        self.assertEqual(wilson_interval(0, 10)[0], 0.0)

    def test_rejects_bad_input(self):
        for labels, probabilities in [([], []), ([0], []), ([2], [0.5]), ([0], [math.nan]), ([1], [1.1])]:
            with self.subTest(labels=labels, probabilities=probabilities), self.assertRaises(ValueError):
                binary_metrics(labels, probabilities)
        for coverage in (0, -0.2, 1.1, math.nan):
            with self.subTest(coverage=coverage), self.assertRaises(ValueError):
                binary_metrics([0], [0.1], coverages=(coverage,))
        with self.assertRaises(ValueError):
            wilson_interval(11, 10)
        with self.assertRaises(ValueError):
            maximal_coverage([0], [0.1], minimum_count=0)


if __name__ == '__main__':
    unittest.main()
