"""Binary probe metrics, with confidence selection shared by both predicted labels."""
import math


def _validated(labels, probabilities):
    labels = list(labels)
    probabilities = [float(value) for value in probabilities]
    if not labels or len(labels) != len(probabilities):
        raise ValueError('labels and probabilities must have the same nonzero length')
    if any(value not in (0, 1) for value in labels):
        raise ValueError('labels must be binary')
    if any(not math.isfinite(value) or not 0 <= value <= 1 for value in probabilities):
        raise ValueError('probabilities must be finite and between zero and one')
    return [int(value) for value in labels], probabilities


def roc_auc(labels, probabilities):
    """Pair-ranking AUROC; tied scores receive half credit, one-class input returns None."""
    labels, probabilities = _validated(labels, probabilities)
    positives = sum(labels)
    negatives = len(labels) - positives
    if not positives or not negatives:
        return None
    ordered = sorted(zip(probabilities, labels))
    rank_sum = 0.0
    start = 0
    while start < len(ordered):
        end = start + 1
        while end < len(ordered) and ordered[end][0] == ordered[start][0]:
            end += 1
        mean_rank = (start + 1 + end) / 2
        rank_sum += mean_rank * sum(label for _, label in ordered[start:end])
        start = end
    return (rank_sum - positives * (positives + 1) / 2) / (positives * negatives)


def wilson_interval(correct, count, z=1.959963984540054):
    """Two-sided binomial Wilson interval, without treating an empty set as perfect."""
    if not isinstance(correct, int) or not isinstance(count, int) or not 0 <= correct <= count:
        raise ValueError('correct and count must be integers with 0 <= correct <= count')
    if not count:
        return None
    proportion = correct / count
    denominator = 1 + z * z / count
    center = (proportion + z * z / (2 * count)) / denominator
    radius = z * math.sqrt(proportion * (1 - proportion) / count + z * z / (4 * count * count)) / denominator
    return [max(0.0, center - radius), min(1.0, center + radius)]


def _selected_metrics(labels, probabilities, indices, threshold):
    count = len(indices)
    positive_count = sum(probabilities[index] >= 0.5 for index in indices)
    negative_count = count - positive_count
    true_positives = sum(labels[index] == 1 and probabilities[index] >= 0.5 for index in indices)
    true_negatives = sum(labels[index] == 0 and probabilities[index] < 0.5 for index in indices)
    correct = true_positives + true_negatives
    return {
        'confidence_threshold': threshold,
        'count': count,
        'coverage': count / len(labels),
        'correct': correct,
        'selective_accuracy': correct / count if count else None,
        'selective_accuracy_ci95': wilson_interval(correct, count),
        'predicted_positive': positive_count,
        'positive_precision': true_positives / positive_count if positive_count else None,
        'positive_precision_ci95': wilson_interval(true_positives, positive_count),
        'predicted_negative': negative_count,
        'negative_precision': true_negatives / negative_count if negative_count else None,
        'negative_precision_ci95': wilson_interval(true_negatives, negative_count),
    }


def binary_metrics(labels, probabilities, coverages=(0.5, 0.8, 1.0)):
    """Accuracy, AUROC and selective metrics at label-independent confidence quantiles.

    Confidence is max(p, 1-p). The threshold includes ties, so achieved coverage can
    exceed the request. Selective accuracy counts both spoken labels; positive
    precision (PPV) and negative precision are reported separately.
    """
    labels, probabilities = _validated(labels, probabilities)
    confidence = [max(value, 1 - value) for value in probabilities]
    descending = sorted(confidence, reverse=True)
    selections = []
    for coverage in coverages:
        if not math.isfinite(coverage) or not 0 < coverage <= 1:
            raise ValueError('requested coverage must be in (0, 1]')
        rank = max(1, math.ceil(coverage * len(labels)))
        threshold = descending[rank - 1]
        indices = [index for index, value in enumerate(confidence) if value >= threshold]
        selected = _selected_metrics(labels, probabilities, indices, threshold)
        selected['requested_coverage'] = coverage
        selections.append(selected)
    correct = sum(label == int(probability >= 0.5) for label, probability in zip(labels, probabilities))
    return {
        'count': len(labels),
        'positives': sum(labels),
        'accuracy': correct / len(labels),
        'auroc': roc_auc(labels, probabilities),
        'coverage_metrics': selections,
    }


def maximal_coverage(labels, probabilities, minimum_accuracy=0.9, minimum_count=1):
    """Describe the widest confidence-selected set meeting accuracy on this data.

    This is a descriptive held-out curve, not a deployable threshold calibration.
    Ties are indivisible, and labels never change the confidence ordering.
    """
    labels, probabilities = _validated(labels, probabilities)
    if not math.isfinite(minimum_accuracy) or not 0 <= minimum_accuracy <= 1:
        raise ValueError('minimum_accuracy must be between zero and one')
    if not isinstance(minimum_count, int) or minimum_count < 1:
        raise ValueError('minimum_count must be a positive integer')
    confidence = [max(value, 1 - value) for value in probabilities]
    ordered = sorted(range(len(labels)), key=lambda index: confidence[index], reverse=True)
    correct = 0
    best = None
    for offset, index in enumerate(ordered):
        correct += labels[index] == int(probabilities[index] >= 0.5)
        count = offset + 1
        if count < len(ordered) and confidence[ordered[count]] == confidence[index]:
            continue
        if count >= minimum_count and correct / count >= minimum_accuracy:
            best = (count, confidence[index])
    if best is None:
        return None
    count, threshold = best
    return _selected_metrics(labels, probabilities, ordered[:count], threshold)
