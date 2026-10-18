"""Photo-paired descriptive critique comparisons, independent of the frozen quality gates."""
import argparse
from collections import Counter
import hashlib
import json
from pathlib import Path
import statistics

from ml.observe.critique import GATES, aggregate_judges, critique_stability, stability, summarize
from ml.observe import critique_report as reports
from ml.observe.vlm_eval_ray import latency_summary


CANDIDATES = ('minicpm-int4-4x', 'qwen36-bf16')


METRICS = ('statementPrecision', 'editReasonableness', 'wrongStatementRate', 'wrongPhoto',
           'observedWrongPhoto', 'contradiction', 'novelty', 'primaryWallSeconds', 'primaryGenerationSeconds',
           'issuesRepeatStability', 'editsRepeatStability')


def ratio(numerator, denominator):
    return numerator / denominator if denominator else None


def valid(row):
    return bool(row and row.get('critique') is not None and not row.get('error'))


def photo_metrics(primary, repeat):
    if not valid(primary):
        return {'validPrimary': False, 'threeFamilyJudged': False, 'values': dict.fromkeys(METRICS), 'counts': {}}
    statements = aggregate_judges(primary.get('statements', []), primary.get('judgments', {}))
    summary = summarize([primary])
    wrong = any(statement['correctness'] == 'wrong' for statement in statements)
    clear = bool(statements) and all(statement['correctness'] == 'correct' for statement in statements)
    precision = summary['statements']['precision']
    repeated = stability(primary['critique'], repeat['critique']) if valid(repeat) else {'issues': None, 'edits': None}
    return {'validPrimary': True, 'threeFamilyJudged': len(primary.get('judgments', {})) == 3,
            'values': {'statementPrecision': precision, 'editReasonableness': summary['edits']['precision'],
                       'wrongStatementRate': 1 - precision if precision is not None else None,
                       'wrongPhoto': int(wrong) if wrong or clear else None,
                       'observedWrongPhoto': int(wrong), 'contradiction': summary['contradiction']['rate'],
                       'novelty': summary['novelty']['rate'], 'primaryWallSeconds': reports.finite(primary.get('wall_s')),
                       'primaryGenerationSeconds': reports.finite(primary.get('elapsed_s')),
                       'issuesRepeatStability': repeated['issues'], 'editsRepeatStability': repeated['edits']},
            'counts': {'statements': summary['statements'], 'edits': summary['edits'],
                       'contradiction': summary['contradiction'], 'novelty': summary['novelty']},
            'judgmentState': 'wrong' if wrong else 'clear' if clear else 'unresolved'}


def pooled(photos, metric, variant):
    count_key, numerator = {'statementPrecision': ('statements', 'correct'),
                            'wrongStatementRate': ('statements', 'wrong'),
                            'editReasonableness': ('edits', 'correct'),
                            'contradiction': ('contradiction', 'positive'),
                            'novelty': ('novelty', 'positive')}.get(metric, (None, None))
    if count_key is None:
        return None
    return ratio(sum(photo[variant]['counts'][count_key][numerator] for photo in photos),
                 sum(photo[variant]['counts'][count_key]['judged'] for photo in photos))


def compare(primary_and_repeats, photo_ids):
    """Input A/B -> two-ask merged rows; cohort ids are never reduced to valid outputs.

    Metric differences pair photos with a judged value on both sides. Statements
    emitted by different critiques have no natural one-to-one correspondence.
    """
    if len(photo_ids) != len(set(photo_ids)):
        raise ValueError('duplicate paired cohort image id')
    by_variant = {}
    for variant in ('A', 'B'):
        by_key = {}
        for row in primary_and_repeats.get(variant, []):
            key = (row['id'], row['ask'])
            if key in by_key:
                raise ValueError('duplicate paired critique ask')
            by_key[key] = row
        by_variant[variant] = by_key
    photos, coverage = [], Counter()
    for image_id in photo_ids:
        photo = {'id': image_id}
        for variant in ('A', 'B'):
            photo[variant] = photo_metrics(by_variant[variant].get((image_id, 0)), by_variant[variant].get((image_id, 1)))
        a, b = (photo[variant]['validPrimary'] for variant in ('A', 'B'))
        coverage['bothValid' if a and b else 'onlyAValid' if a else 'onlyBValid' if b else 'neitherValid'] += 1
        coverage['bothThreeFamilyJudgedValid'] += a and b and all(photo[v]['threeFamilyJudged'] for v in ('A', 'B'))
        photo['categoryJaccard'] = stability(by_variant['A'][(image_id, 0)]['critique'],
                                             by_variant['B'][(image_id, 0)]['critique']) if a and b else {'issues': None, 'edits': None}
        photo['differencesBminusA'] = {
            metric: photo['B']['values'][metric] - photo['A']['values'][metric]
            if photo['A']['values'][metric] is not None and photo['B']['values'][metric] is not None else None
            for metric in METRICS}
        photos.append(photo)
    metrics = {}
    for metric in METRICS:
        paired = [photo for photo in photos if photo['differencesBminusA'][metric] is not None]
        values = [photo['differencesBminusA'][metric] for photo in paired]
        a = statistics.mean(photo['A']['values'][metric] for photo in paired) if paired else None
        b = statistics.mean(photo['B']['values'][metric] for photo in paired) if paired else None
        pooled_a, pooled_b = (pooled(paired, metric, variant) for variant in ('A', 'B'))
        metrics[metric] = {'pairedPhotos': len(paired), 'plannedPhotos': len(photo_ids),
                           'excludedPhotos': len(photo_ids) - len(paired), 'pairedCoverage': ratio(len(paired), len(photo_ids)),
                           'photoMeanA': a, 'photoMeanB': b,
                           'meanDifferenceBminusA': statistics.mean(values) if values else None,
                           'medianDifferenceBminusA': statistics.median(values) if values else None,
                           'pooledRateAOnSamePhotos': pooled_a, 'pooledRateBOnSamePhotos': pooled_b,
                           'pooledDifferenceBminusA': pooled_b - pooled_a if pooled_a is not None and pooled_b is not None else None}
    categories = {}
    for category in ('issues', 'edits'):
        values = [photo['categoryJaccard'][category] for photo in photos if photo['categoryJaccard'][category] is not None]
        categories[category] = {'pairedPhotos': len(values), 'plannedPhotos': len(photo_ids),
                                'missingOrInvalidPhotos': len(photo_ids) - len(values),
                                'meanJaccard': statistics.mean(values) if values else None}
    return {'unit': 'photo', 'differenceDirection': 'B minus A', 'plannedPhotos': len(photo_ids),
            'validPrimaryPairs': coverage['bothValid'], 'judgedPrimaryPairs': coverage['bothThreeFamilyJudgedValid'],
            'primaryFormatCoverage': {**{key: coverage[key] for key in
                                        ('bothValid', 'onlyAValid', 'onlyBValid', 'neitherValid', 'bothThreeFamilyJudgedValid')},
                                      'bothValidFractionOfCohort': ratio(coverage['bothValid'], len(photo_ids))},
            'metrics': metrics, 'crossVariantPrimaryCategoryJaccard': categories,
            'judgmentStates': {variant: dict(Counter(photo[variant].get('judgmentState', 'missing_or_invalid') for photo in photos))
                               for variant in ('A', 'B')},
            'meaning': 'Descriptive same-photo comparisons only; different critiques do not have paired atomic statements. '
                       'Each metric uses only photos with values on both sides and reports exclusions against the entire frozen cohort. '
                       'observedWrongPhoto includes unresolved outputs without a known error as zero and is a lower bound; '
                       'the difference between two observed lower bounds is not a bound on the true difference. '
                       'wrongPhoto requires either a known wrong statement or all statements correct. No paired statistic is a gate.',
            'photos': photos}


def frozen_cohort(root, file, manifest_file, manifest):
    cohort = reports.read_json(root, file)
    digest = hashlib.sha256(manifest_file.read_bytes()).hexdigest()
    photos = [item for item in manifest if item.get('set') == 'photos']
    if (not cohort or cohort.get('id') != 'w36-candidates-v1' or cohort.get('version') != 1
            or type(cohort.get('seed')) is not int or cohort.get('size') != 200 or len(photos) != 291
            or cohort.get('manifestSha256') != digest
            or cohort.get('selection') != 'sha256(w36-candidates-v1|seed|id), ascending, first 200 photos'):
        raise ValueError('invalid frozen 200-of-291 candidate cohort or source manifest')
    expected = sorted((item['id'] for item in photos), key=lambda image_id: hashlib.sha256(
        f"w36-candidates-v1|{cohort['seed']}|{image_id}".encode()).hexdigest())[:200]
    if cohort.get('ids') != expected:
        raise ValueError('cohort identities differ from the frozen seeded selection')
    return {**cohort, 'sha256': hashlib.sha256(file.read_bytes()).hexdigest()}


def full_photo_cohort(manifest_file, manifest):
    photos = [item for item in manifest if item.get('set') == 'photos']
    if len(photos) != 291 or Counter(item.get('set') for item in manifest) != {'photos': 291, 'openimages': 200}:
        raise ValueError('full photo comparison requires the frozen 291-photo and 200-Open-Images manifest')
    cohort = {'id': 'w36-full-photos-v1', 'version': 1, 'size': 291,
              'selection': 'all photos in frozen manifest order; no sampling or output-dependent exclusion',
              'manifestSha256': hashlib.sha256(manifest_file.read_bytes()).hexdigest(),
              'ids': [item['id'] for item in photos]}
    return {**cohort, 'sha256': hashlib.sha256(json.dumps(cohort, ensure_ascii=False, separators=(',', ':')).encode()).hexdigest()}


def photo_cell(base, rows, cohort, full_photos=False):
    selected = set(cohort['ids'])
    rows = [row for row in rows if row['id'] in selected]
    primary = [row for row in rows if row['ask'] == 0]
    if len(primary) != cohort['size'] or len(rows) != cohort['size'] * 2:
        raise ValueError('photo rows must preserve both asks for the entire frozen cohort')
    summary = summarize(primary)
    summary['descriptiveHallucination'] = reports.descriptive_hallucination(primary, summary)
    summaries = {'all': summary, 'photos': summary, 'openimages': summarize([])}
    present = sum(row.get('error') != 'missing_prediction' for row in primary)
    valid_primary = sum(valid(row) for row in primary)
    judged = sum(valid(row) and len(row.get('judgments', {})) == 3 for row in primary)
    formatted = all(valid(row) for row in rows)
    complete = formatted and judged == cohort['size']
    status = ('missing_model' if present == 0 else 'incomplete_inference' if not formatted else
              'awaiting_judges' if judged != cohort['size'] else 'judged')
    telemetry = {**base['telemetry'], 'latencyScope': 'all recorded successful inference calls in the frozen cohort, including invalid JSON',
                 'memoryScope': 'source job measurements; not per-photo peaks or a new cohort-specific memory run'}
    good = [row for row in rows if not row.get('error')]
    telemetry['wallLatencySeconds'] = latency_summary([value for row in good if (value := reports.finite(row.get('wall_s'))) is not None])
    telemetry['generationLatencySeconds'] = latency_summary([value for row in good if (value := reports.finite(row.get('elapsed_s'))) is not None])
    coverage_by_ask = {}
    for ask in (0, 1):
        values = [row for row in rows if row['ask'] == ask]
        coverage_by_ask[str(ask)] = {'planned': cohort['size'], 'valid': sum(valid(row) for row in values),
                                     'missing': sum(row.get('error') == 'missing_prediction' for row in values),
                                     'inferenceFailed': sum(bool(row.get('error')) and row.get('error') != 'missing_prediction' for row in values),
                                     'invalidFormat': sum(bool(row.get('parse_error')) and not row.get('error') for row in values)}
    return {**base, 'reportScope': 'frozen_full_photos' if full_photos else 'frozen_reduced_cohort',
            'cohortId': cohort['id'], 'status': status,
            'fullyFormattedAndJudged': complete, 'preregisteredGatesPass': summary['gate']['passes'],
            'runtimeAcceptance': 'not_evaluated',
            'coverage': {'expectedPhotos': cohort['size'], 'presentAsk0': present, 'validAsk0': valid_primary,
                         'missingAsk0': cohort['size'] - present,
                         'failedAsk0': sum(bool(row.get('error')) and row.get('error') != 'missing_prediction' for row in primary),
                         'invalidAsk0': sum(bool(row.get('parse_error')) for row in primary),
                         'threeFamilyJudgedPhotos': judged, 'validPrimaryWithoutThreeFamilyJudgments': valid_primary - judged},
            'coverageByAsk': coverage_by_ask,
            'splits': summaries, 'stability': critique_stability(rows), 'telemetry': telemetry}, rows


def report(root=None, cohort_file=None, source_phase='full', write=False, include_baseline=True, full_photos=False):
    root = reports.checked_root(root or reports.CACHE_ROOT)
    if source_phase not in ('full', 'reduced'):
        raise ValueError('candidate source phase must be full or reduced')
    if full_photos and (cohort_file is not None or source_phase != 'full'):
        raise ValueError('full photo comparison uses the complete frozen manifest and full inference source')
    manifest_file = reports.within(root, root / 'prepared/manifest.jsonl')
    diagnostics = []
    manifest = reports.read_rows(root, manifest_file, diagnostics)
    if diagnostics or len({item.get('id') for item in manifest}) != len(manifest):
        raise ValueError('invalid complete prepared manifest')
    provenance = reports.frozen_provenance(root, manifest_file, manifest, 'full')
    if provenance is None:
        raise ValueError('photo comparison requires the original frozen preregistration')
    if full_photos:
        cohort = full_photo_cohort(manifest_file, manifest)
    else:
        cohort_file = reports.within(root, cohort_file or root / 'candidate-cohort.json')
        cohort = frozen_cohort(root, cohort_file, manifest_file, manifest)
    judges, judge_files = reports.judge_index(root, diagnostics)
    cells, pairs, outputs, full_cells = [], [], [], []
    cell_suffix = 'full-photos' if full_photos else 'reduced'
    paired_suffix = 'full' if full_photos else 'reduced'
    for slug in CANDIDATES:
        by_variant = {}
        for base, merged in reports.model_cells(root, slug, manifest, judges, diagnostics, source_phase, provenance):
            cell, rows = photo_cell(base, merged, cohort, full_photos)
            cells.append(cell)
            if full_photos:
                full_cells.append(base)
            by_variant[cell['variant']] = rows
            directory = root / (slug + '-' + cell['variant'])
            outputs.extend([(directory / ('results-' + cell_suffix + '.json'), cell, False),
                            (directory / ('predictions-' + cell_suffix + '.jsonl'), rows, True)])
        paired = compare(by_variant, cohort['ids'])
        photo_rows = paired.pop('photos')
        paired.update(modelSlug=slug, sourcePhase=source_phase, cohortId=cohort['id'])
        pairs.append(paired)
        directory = root / (slug + '-paired')
        outputs.extend([(directory / ('results-' + paired_suffix + '.json'), paired, False),
                        (directory / ('photos-' + paired_suffix + '.jsonl'), photo_rows, True)])
    baseline = None
    if include_baseline:
        baseline = {'modelSlug': 'qwen3-vl-8b', 'reportScope': 'original_full_manifest_partial_judging',
                    'noAdditionalJudgingPlanned': True, 'disposition': 'not_carried_forward',
                    'cells': [cell for cell, _ in reports.model_cells(root, 'qwen3-vl-8b', manifest, judges, diagnostics, 'full', provenance)]}
    result = {'task': 'critique', 'reportScope': 'frozen_full_photos' if full_photos else 'frozen_reduced_cohort', 'sourcePhase': source_phase,
              'cohort': cohort, 'plannedPhotosPerVariant': cohort['size'], 'gates': dict(GATES),
              'runtimeAcceptance': 'not_evaluated', 'cells': cells, 'paired': pairs, 'baselineReference': baseline,
              'judgeBatchFiles': judge_files, 'diagnostics': diagnostics,
              'referenceCaveat': '老师是参照而非真值，可能偏好自身文风；固定抽样分母不随格式有效性或判票结果改变。'}
    if full_photos:
        result['fullManifestReference'] = {'reportScope': 'original_full_manifest',
                                           'manifestPhotos': dict(Counter(item['set'] for item in manifest)),
                                           'cells': full_cells,
                                           'meaning': 'Separate all/photos/Open Images summaries from the same frozen full inference and judge rows; photo-paired cells above use only the 291 photos.'}
    outputs.append((root / ('results-full-paired.json' if full_photos else 'results-reduced.json'), result, False))
    for file, _, _ in outputs:
        reports.within(root, file)
    if write:
        for file, value, jsonl in outputs:
            reports.save(root, file, value, jsonl)
    return result


def main(argv=None):
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--root', type=Path, default=reports.CACHE_ROOT)
    parser.add_argument('--cohort', type=Path)
    parser.add_argument('--full-photos', action='store_true')
    parser.add_argument('--source-phase', choices=('full', 'reduced'), default='full')
    parser.add_argument('--write', action='store_true')
    args = parser.parse_args(argv)
    result = report(args.root, args.cohort, args.source_phase, args.write, full_photos=args.full_photos)
    print(json.dumps({'plannedPhotosPerVariant': result['plannedPhotosPerVariant'], 'cells': len(result['cells']),
                      'reportScope': result['reportScope'],
                      'validPrimaryPairs': {pair['modelSlug']: pair['primaryFormatCoverage']['bothValid'] for pair in result['paired']},
                      'judgedPrimaryPairs': {pair['modelSlug']: pair['judgedPrimaryPairs'] for pair in result['paired']},
                      'written': args.write}, ensure_ascii=False))


if __name__ == '__main__':
    main()
