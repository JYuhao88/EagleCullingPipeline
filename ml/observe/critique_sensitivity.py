"""Posthoc descriptive judge sensitivity; never changes preregistered acceptance."""
import argparse
from collections import Counter
import hashlib
from itertools import combinations
import json
from pathlib import Path
import re

from ml.observe.critique import FAMILIES, aggregate_judges
from ml.observe import critique_report as reports


CHANNELS = {'correctness': ('正确', '错误', '无法判断'),
            'reasonableness': ('合理', '不合理', '无法判断')}
KINDS = ('strength', 'issue', 'edit', 'verdict')


def ratio(numerator, denominator):
    return numerator / denominator if denominator else None


def cohen_kappa(pairs, labels):
    """Nominal, unweighted kappa; absent pairs or chance agreement of one are undefined."""
    pairs = list(pairs)
    if any(len(pair) != 2 or any(value not in labels for value in pair) for pair in pairs):
        raise ValueError('kappa requires two valid categorical votes')
    left, right = (Counter(pair[index] for pair in pairs) for index in (0, 1))
    n = len(pairs)
    observed = ratio(sum(a == b for a, b in pairs), n)
    expected = sum(left[label] * right[label] for label in labels) / n ** 2 if n else None
    return {'n': n, 'observedAgreement': observed, 'chanceAgreement': expected,
            'kappa': (observed - expected) / (1 - expected) if n and expected < 1 else None,
            'labels': list(labels), 'leftCounts': {label: left[label] for label in labels},
            'rightCounts': {label: right[label] for label in labels},
            'matrix': [[sum(a == left_label and b == right_label for a, b in pairs)
                        for right_label in labels] for left_label in labels]}


def atomic_votes(rows, channel):
    labels = CHANNELS[channel]
    atoms = []
    for row in rows:
        if row.get('critique') is None or row.get('error'):
            continue
        statements, judgments = row.get('statements', []), row.get('judgments', {})
        aggregate = aggregate_judges(statements, judgments)
        by_family = {family: {vote['id']: vote for vote in votes} for family, votes in judgments.items()}
        for statement, decision in zip(statements, aggregate):
            if channel == 'reasonableness' and (statement['kind'] != 'edit' or statement.get('action') == 'none'):
                continue
            votes = [by_family.get(family, {}).get(statement['id'], {}).get(channel) for family in FAMILIES]
            atoms.append({'kind': statement['kind'], 'category': statement['category'],
                          'votes': votes, 'complete': all(vote in labels for vote in votes),
                          'preregisteredDecision': decision[channel]})
    return atoms


def summarize_votes(atoms, channel):
    labels = CHANNELS[channel]
    positive, negative, unknown = labels
    complete = [atom for atom in atoms if atom['complete']]
    n = len(complete)
    patterns = Counter(tuple(atom['votes']) for atom in complete)
    decisions = Counter(atom['preregisteredDecision'] for atom in atoms)

    def metric(predicate):
        count = sum(predicate(atom['votes']) for atom in complete)
        return {'positive': count, 'n': n, 'rate': ratio(count, n)}

    teachers = {}
    for index, family in enumerate(FAMILIES):
        counts = Counter(atom['votes'][index] for atom in atoms)
        valid = sum(counts[label] for label in labels)
        teachers[family] = {'expectedVotes': len(atoms), 'validVotes': valid,
                            'missingVotes': counts[None], 'invalidLabelVotes': len(atoms) - valid - counts[None],
                            'counts': {label: counts[label] for label in labels},
                            'cannotJudgeRate': ratio(counts[unknown], valid),
                            'cannotJudgeRateDenominator': 'available valid categorical votes, including cannot-judge',
                            'cannotJudgeOnCompleteThreeVotes': sum(atom['votes'][index] == unknown for atom in complete),
                            'cannotJudgeRateOnCompleteThreeVotes': ratio(
                                sum(atom['votes'][index] == unknown for atom in complete), n)}
    pairwise = {}
    for left, right in combinations(range(len(FAMILIES)), 2):
        pairs = [(atom['votes'][left], atom['votes'][right]) for atom in complete]
        decisive = [pair for pair in pairs if unknown not in pair]
        pairwise[FAMILIES[left] + ':' + FAMILIES[right]] = {
            'threeLabels': cohen_kappa(pairs, labels),
            'decisiveOnly': cohen_kappa(decisive, labels[:2]),
            'excludedWithoutCompleteThreeVotes': len(atoms) - n,
            'excludedWithCannotJudgeFromDecisiveOnly': n - len(decisive)}
    correct, wrong, disputed = (decisions[value] for value in ('correct', 'wrong', 'disputed'))
    majority_correct = sum(atom['votes'].count(positive) >= 2 for atom in complete)
    majority_wrong = sum(atom['votes'].count(negative) >= 2 for atom in complete)
    majority_judged = majority_correct + majority_wrong
    return {'emitted': len(atoms), 'completeThreeVotes': n, 'incompleteThreeVotes': len(atoms) - n,
            'completeThreeVoteCoverage': ratio(n, len(atoms)),
            'preregisteredReference': {'correct': correct, 'wrong': wrong, 'disputed': disputed,
                                        'precision': ratio(correct, correct + wrong),
                                        'disputedRate': ratio(disputed, len(atoms)),
                                        'disputedCompleteThreeVotes': sum(atom['preregisteredDecision'] == 'disputed' for atom in complete),
                                        'disputedRateOnCompleteThreeVotes': ratio(sum(
                                            atom['preregisteredDecision'] == 'disputed' for atom in complete), n)},
            'twoOfThreeReference': {'correct': majority_correct, 'wrong': majority_wrong,
                                     'disputed': n - majority_judged, 'judged': majority_judged,
                                     'precision': ratio(majority_correct, majority_judged)},
            'twoOfThreePositive': metric(lambda votes: votes.count(positive) >= 2),
            'nobodyNegative': metric(lambda votes: negative not in votes),
            'twoOfThreePositiveAndNobodyNegative': metric(lambda votes: votes.count(positive) >= 2 and negative not in votes),
            'allPositive': metric(lambda votes: votes.count(positive) == 3),
            'allCannotJudge': metric(lambda votes: votes.count(unknown) == 3),
            'voteDisagreement': metric(lambda votes: len(set(votes)) > 1),
            'positiveNegativeConflict': metric(lambda votes: positive in votes and negative in votes),
            'cannotJudgeWithoutPositiveNegativeConflict': metric(
                lambda votes: unknown in votes and not (positive in votes and negative in votes)),
            'teachers': teachers, 'pairwise': pairwise,
            'votePatterns': [{'votes': list(votes), 'n': count} for votes, count in sorted(patterns.items())]}


def analyze(rows):
    rows = list(rows)
    if any(row.get('ask') != 0 for row in rows) or len({row['id'] for row in rows}) != len(rows):
        raise ValueError('sensitivity requires unique primary-ask photo rows')
    channels = {}
    for channel in CHANNELS:
        atoms = atomic_votes(rows, channel)
        channels[channel] = {**summarize_votes(atoms, channel),
                             'byKind': {kind: summarize_votes([atom for atom in atoms if atom['kind'] == kind], channel)
                                        for kind in KINDS if channel == 'correctness' or kind == 'edit'},
                             'byCategory': {category: summarize_votes([atom for atom in atoms if atom['kind'] + ':' + atom['category'] == category], channel)
                                            for category in sorted({atom['kind'] + ':' + atom['category'] for atom in atoms})}}
    valid = [row for row in rows if row.get('critique') is not None and not row.get('error')]
    return {'coverage': {'expectedPrimaryPhotos': len(rows), 'validPrimaryPhotos': len(valid),
                          'missingOrInvalidPrimaryPhotos': len(rows) - len(valid),
                          'validPrimaryPhotosWithThreeFamilyReceipts': sum(len(row.get('judgments', {})) == 3 for row in valid)},
            'channels': channels}


def report(root=reports.CACHE_ROOT, models=None, source_phase='full'):
    root = reports.checked_root(root)
    if source_phase not in reports.SOURCE_PHASES:
        raise ValueError('source phase must be full, pilot or smoke')
    models = list(models or reports.DEFAULT_MODELS)
    if len(set(models)) != len(models) or any(not re.fullmatch(r'[a-z0-9][a-z0-9._-]{0,80}', model) for model in models):
        raise ValueError('model output prefixes must be unique safe names')
    diagnostics = []
    manifest_file = reports.within(root, root / 'prepared/manifest.jsonl')
    manifest = reports.read_rows(root, manifest_file, diagnostics)
    if (diagnostics or not manifest or any(item.get('set') not in ('photos', 'openimages')
            or not isinstance(item.get('id'), str) or not item['id']
            or not isinstance(item.get('specialist_facts', []), list) for item in manifest)
            or len({item['id'] for item in manifest}) != len(manifest)):
        raise ValueError('sensitivity requires the valid complete frozen manifest with unique ids')
    provenance = reports.frozen_provenance(root, manifest_file, manifest, source_phase)
    judges, judge_files = reports.judge_index(root, diagnostics)
    cells = []
    for slug in models:
        for base, merged in reports.model_cells(root, slug, manifest, judges, diagnostics, source_phase, provenance):
            primary = [row for row in merged if row['ask'] == 0]
            cells.append({'modelSlug': slug, 'model': base['model'], 'variant': base['variant'],
                          'sourcePhase': source_phase, 'sourceDirectory': base['sourceDirectory'],
                          'splits': {subset: analyze([row for row in primary if subset == 'all' or row['set'] == subset])
                                     for subset in ('all', 'photos', 'openimages')}})
    result = {'task': 'critique-judge-sensitivity', 'primaryAsk': 0, 'sourcePhase': source_phase,
              'analysisMeaning': '事后描述，不作为验收；不回溯修改 v1 的预注册规则或结论。',
              'denominators': {'alternativeRates': 'All statements with three valid categorical votes; cannot-judge remains in the denominator. Missing or invalid votes are excluded with explicit coverage.',
                               'twoOfThreeReference': 'Conditional descriptive precision: at least two positive votes divided by complete triples with at least two positive or at least two negative votes. Unknown-dominated triples remain disputed and are excluded from this precision; not an acceptance rule.',
                               'nobodyNegative': 'Absence of a negative vote, including all-cannot-judge; not a truth or correctness claim.',
                               'preregisteredDisputedRate': 'All emitted statements, including missing judge votes, exactly as in the original report.',
                               'pairwiseKappa': 'Unweighted nominal Cohen kappa on complete three-vote statements; threeLabels includes cannot-judge, decisiveOnly excludes a pair if either says cannot-judge.',
                               'reasonableness': 'Substantive edits only; action=none excluded, matching the original report.'},
              'causalCaveat': 'Cannot-judge labels do not identify their cause. Subjective taste versus insufficient 768-pixel detail cannot be causally separated without reasons or an independent visibility intervention.',
              'manifestSha256': hashlib.sha256(manifest_file.read_bytes()).hexdigest(),
              'frozenProvenance': provenance, 'judgeBatchFiles': judge_files,
              'cells': cells, 'diagnostics': diagnostics}
    suffix = '' if source_phase == 'full' else '-' + source_phase
    reports.save(root, root / ('sensitivity' + suffix + '.json'), result)
    return result


def main(argv=None):
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--root', type=Path, default=reports.CACHE_ROOT)
    parser.add_argument('--models', nargs='+')
    parser.add_argument('--source-phase', choices=reports.SOURCE_PHASES, default='full')
    args = parser.parse_args(argv)
    result = report(args.root, args.models, args.source_phase)
    print(json.dumps({'cells': len(result['cells']), 'sourcePhase': args.source_phase,
                      'meaning': result['analysisMeaning'], 'diagnostics': len(result['diagnostics'])}, ensure_ascii=False))


if __name__ == '__main__':
    main()
