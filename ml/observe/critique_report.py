"""Merge local critique predictions and independent judge receipts; stdlib only."""
import argparse
from collections import Counter, defaultdict
import hashlib
import json
import math
import os
from pathlib import Path
import re
import tempfile

from ml.observe.critique import FAMILIES, GATES, critique_stability, parse_critique, split_statements, summarize


CACHE_ROOT = Path(__file__).resolve().parents[2] / 'data/cache/w36-vlm-critique'
DEFAULT_MODELS = ('minicpm-int4-4x', 'qwen36-bf16', 'qwen3-vl-8b')
SOURCE_PHASES = ('full', 'pilot', 'smoke')


def within(root, path):
    path = Path(path)
    if not path.resolve().is_relative_to(root.resolve()):
        raise ValueError('all critique report paths must remain in the W36 cache')
    return path


def checked_root(root):
    root = Path(root)
    within(CACHE_ROOT, root)
    return root.resolve()


def read_json(root, file, default=None, diagnostics=None):
    file = within(root, file)
    if not file.exists():
        return default
    try:
        value = json.loads(file.read_text())
        if not isinstance(value, dict):
            raise ValueError('expected object')
        return value
    except (ValueError, TypeError):
        if diagnostics is None:
            raise
        diagnostics.append({'file': str(file.relative_to(root)), 'error': 'invalid_json_object'})
        return default


def read_rows(root, file, diagnostics):
    file = within(root, file)
    if not file.exists():
        return []
    rows = []
    for number, line in enumerate(file.read_text().splitlines(), 1):
        if not line.strip():
            continue
        try:
            row = json.loads(line)
            if not isinstance(row, dict):
                raise ValueError('row is not an object')
            rows.append(row)
        except (ValueError, TypeError):
            diagnostics.append({'file': str(file.relative_to(root)), 'line': number, 'error': 'invalid_json_row'})
    return rows


def save(root, file, value, jsonl=False):
    file = within(root, file)
    file.parent.mkdir(parents=True, exist_ok=True)
    within(root, file.parent)
    raw = ''.join(json.dumps(row, ensure_ascii=False, separators=(',', ':')) + '\n' for row in value) if jsonl else (
        json.dumps(value, ensure_ascii=False, indent=2, allow_nan=False) + '\n')
    temporary = None
    try:
        with tempfile.NamedTemporaryFile(mode='w', encoding='utf-8', dir=file.parent, prefix='.critique-', delete=False) as handle:
            temporary = Path(handle.name)
            handle.write(raw)
            handle.flush()
            os.fsync(handle.fileno())
        within(root, file)
        temporary.replace(file)
    finally:
        if temporary and temporary.exists():
            temporary.unlink()


def identity(row):
    return row.get('image_id', row.get('item_id', row.get('id')))


def ask_number(row):
    value = row.get('ask', row.get('repeat'))
    return int(value) if type(value) is int and value in (0, 1) or value in ('0', '1') else None


def critique_id(row, parsed, statements):
    fields = ('id', 'kind', 'category', 'text', 'action', 'direction', 'amount', 'reason', 'region')
    canonical = [{key: statement[key] for key in fields if statement.get(key) is not None} for statement in statements]
    value = [row['model'], row['variant'], ask_number(row), identity(row), row.get('prompt_sha256'), parsed, canonical]
    return hashlib.sha256(json.dumps(value, ensure_ascii=False, separators=(',', ':')).encode()).hexdigest()


def finite(value, multiplier=1):
    return value * multiplier if type(value) in (int, float) and math.isfinite(value) and value >= 0 else None


def frozen_provenance(root, manifest_file, manifest, source_phase):
    preregistration = read_json(root, root / 'preregistration.json', {})
    metadata = preregistration.get('metadata')
    if metadata is None:
        return None
    if not isinstance(metadata, dict):
        raise ValueError('invalid preregistration metadata')
    digest = hashlib.sha256(manifest_file.read_bytes()).hexdigest()
    counts = Counter(item['set'] for item in manifest)
    if digest != metadata.get('datasetSha256') or any(type(metadata.get(key)) is not int
            or metadata[key] != counts[subset] for key, subset in (('photos', 'photos'), ('openImages', 'openimages'))):
        raise ValueError('prepared manifest differs from preregistered dataset hash or set counts')
    expected_gates = {key: value for key, value in GATES.items() if key not in ('statementN', 'editN')}
    expected_gates.update(minStatements=GATES['statementN'], minEdits=GATES['editN'])
    if preregistration.get('gates') != expected_gates:
        raise ValueError('statistical gates differ from preregistration')
    original = metadata.get('promptSha256')
    revisions = metadata.get('modelRevisions')
    if not isinstance(original, str) or not re.fullmatch(r'[a-f0-9]{64}', original) or not isinstance(revisions, dict):
        raise ValueError('missing frozen prompt or model revisions')
    accepted = {original}
    amendment = read_json(root, root / 'prompt-format-amendment.json')
    if amendment is not None:
        amended = amendment.get('promptSha256')
        if (any(amendment.get(key) is not True for key in ('beforeTeacherCalls', 'schemaUnchanged', 'gatesUnchanged'))
                or amendment.get('originalPromptSha256') != original or not isinstance(amended, str)
                or not re.fullmatch(r'[a-f0-9]{64}', amended)):
            raise ValueError('invalid pre-judge prompt format amendment')
        accepted = {amended} | ({original} if source_phase == 'smoke' else set())
    return {'datasetSha256': digest, 'acceptedPromptSha256': sorted(accepted), 'modelRevisions': revisions}


def check_model_provenance(slug, config, predictions, provenance):
    if provenance is None or not config and not predictions:
        return
    revision = provenance['modelRevisions'].get(slug)
    if not isinstance(revision, str) or not re.fullmatch(r'[a-f0-9]{40}', revision):
        raise ValueError('model has no preregistered pinned revision: ' + slug)
    if (not isinstance(config.get('model'), str) or not config['model']
            or config.get('revision') != revision or config.get('prompt_sha256') not in provenance['acceptedPromptSha256']):
        raise ValueError('model config differs from frozen revision or accepted prompt: ' + slug)
    for row in predictions:
        if (row.get('model_revision') != revision or row.get('prompt_sha256') != config['prompt_sha256']
                or row.get('model') != config.get('model')):
            raise ValueError('prediction differs from frozen model or prompt provenance: ' + slug)


def descriptive_hallucination(rows, summary):
    valid = [row for row in rows if row.get('critique') is not None and not row.get('error')]
    wrong = summary['hallucination']['wrongPhotos']
    return {'wrongValidPrimaryPhotos': wrong, 'validPrimaryPhotos': len(valid),
            'knownWrongRateAmongValidPrimaryPhotos': wrong / len(valid) if valid else None,
            'threeFamilyJudgedValidPrimaryPhotos': sum(len(row['judgments']) == 3 for row in valid),
            'unresolvedValidPrimaryPhotos': len(valid) - wrong - summary['hallucination']['fullyCorrectPhotos'],
            'denominator': 'valid first-ask critique outputs, including unresolved judge votes; excludes missing or invalid outputs',
            'meaning': 'Descriptive observed wrong-photo fraction, a lower bound when judge votes remain unresolved; not a gate.'}


def telemetry(performance, variant):
    memory = performance.get('memory_by_variant', {}).get(variant)
    process_memory = finite(performance.get('process_gpu_gib_after_inference'))
    replicas = performance.get('replicas')
    if isinstance(replicas, list):
        expected = performance.get('config', {}).get('replicas', performance.get('replica_count', len(replicas)))

        def measured(values, operation=max):
            return operation(values) if expected > 0 and len(values) == expected and all(value is not None for value in values) else None

        process_memory = measured([finite(row.get('process_gpu_gib_after_inference')) for row in replicas])
        memory = dict(memory or {})
        for key in ('peak_allocated_gib', 'peak_reserved_gib'):
            values = [finite(row.get('memory_by_variant', {}).get(variant, {}).get(key)) for row in replicas]
            memory[key] = measured(values)
            if key == 'peak_reserved_gib':
                memory['sum_replica_peak_reserved_gib'] = measured(values, sum)
    return {'wallLatencySeconds': performance.get('wall_latency_by_variant', {}).get(variant),
            'generationLatencySeconds': performance.get('generation_latency_by_variant', {}).get(variant),
            'allocatorMemoryGiB': memory,
            'wholeJobSampledMemory': performance.get('sampled_memory'),
            'wholeJobProcessGiBAfterInference': process_memory,
            'processGpuMemoryScope': performance.get('process_gpu_scope', 'single-process end sample, not a peak'),
            'replicaCount': performance.get('replica_count', 1),
            'memoryCaveat': performance.get('memory_caveat'),
            'gpu': performance.get('gpu'), 'loadSeconds': performance.get('load_s')}


def judge_index(root, diagnostics):
    index = defaultdict(list)
    files = sorted(root.rglob('judgments.jsonl'))
    for file in files:
        for row in read_rows(root, file, diagnostics):
            if ask_number(row) != 0:
                continue
            key = (identity(row), row.get('model'), row.get('variant'))
            if row.get('teacher') not in FAMILIES or not all(isinstance(value, str) and value for value in key):
                diagnostics.append({'file': str(file.relative_to(root)), 'error': 'invalid_judgment_identity'})
                continue
            index[key].append(row)
    return index, len(files)


def attach_judgments(primary, receipts, diagnostics, source):
    matched, conflicting = {}, set()
    if primary.get('critique') is None or primary.get('error'):
        return matched
    wanted = critique_id(primary, primary['critique'], primary['statements'])
    ids = {statement['id'] for statement in primary['statements']}
    for receipt in receipts:
        if receipt.get('prompt_sha256') != primary.get('prompt_sha256') or receipt.get('critique_id') != wanted:
            diagnostics.append({'model': source, 'id': primary['id'], 'variant': primary['variant'], 'error': 'stale_judgment'})
            continue
        if receipt.get('valid') is not True:
            continue
        votes = receipt.get('statements')
        if (not isinstance(votes, list) or len(votes) != len(ids)
                or any(not isinstance(vote, dict) or vote.get('id') not in ids for vote in votes)
                or len({vote['id'] for vote in votes}) != len(ids)):
            diagnostics.append({'model': source, 'id': primary['id'], 'error': 'invalid_judgment_statements'})
            continue
        votes = [{**vote, 'novelty': vote.get('novelty', vote.get('adds_information'))} for vote in votes]
        family = receipt['teacher']
        if family in matched and {row['id']: row for row in matched[family]} != {row['id']: row for row in votes}:
            conflicting.add(family)
        matched[family] = votes
    for family in conflicting:
        matched.pop(family, None)
        diagnostics.append({'model': source, 'id': primary['id'], 'variant': primary['variant'],
                            'teacher': family, 'error': 'conflicting_judgment'})
    return matched


def model_cells(root, slug, manifest, judges, diagnostics, source_phase='full', provenance=None):
    source = within(root, root / (slug + '-' + source_phase))
    performance = read_json(root, source / 'performance.json', {}, diagnostics)
    job = read_json(root, source / 'job.json', {}, diagnostics)
    config = performance.get('config') or job.get('config') or {}
    if not isinstance(config, dict):
        diagnostics.append({'model': slug, 'error': 'invalid_model_config'})
        config = {}
    predictions = read_rows(root, source / 'predictions.jsonl', diagnostics)
    check_model_provenance(slug, config, predictions, provenance)
    if provenance is not None:
        for saved in (performance.get('config'), job.get('config')):
            if saved is not None:
                if not isinstance(saved, dict):
                    raise ValueError('invalid saved model config: ' + slug)
                check_model_provenance(slug, saved, predictions, provenance)
    ids = {item['id'] for item in manifest}
    models = {row.get('model') for row in predictions if isinstance(row.get('model'), str)}
    model = config.get('model') or (next(iter(models)) if len(models) == 1 else slug)
    by_key, duplicates = {}, set()
    for row in predictions:
        key = (identity(row), row.get('variant'), ask_number(row))
        if key[0] not in ids or key[1] not in ('A', 'B') or key[2] is None or row.get('model', model) != model:
            diagnostics.append({'model': slug, 'error': 'unmatched_prediction'})
            continue
        if key in by_key:
            duplicates.add(key)
        by_key[key] = row
    cells = []
    for variant in ('A', 'B'):
        expected = [item for item in manifest if variant == 'A' or item['set'] == 'photos' or item.get('specialist_facts')]
        merged, counts = [], Counter()
        for item in expected:
            for ask in (0, 1):
                key = (item['id'], variant, ask)
                original = by_key.get(key)
                row = dict(original or {})
                row.update(id=item['id'], image_id=item['id'], model=model, variant=variant, ask=ask,
                           sourcePhase=source_phase,
                           set=item['set'], facts=item.get('specialist_facts', []),
                           specialist_facts=item.get('specialist_facts', []))
                if not original:
                    row.update(content='', critique=None, statements=[], error='missing_prediction')
                elif key in duplicates:
                    row.update(critique=None, statements=[], error='duplicate_prediction')
                    diagnostics.append({'model': slug, 'id': item['id'], 'variant': variant, 'ask': ask,
                                        'error': 'duplicate_prediction'})
                else:
                    parsed = None if row.get('error') else parse_critique(row.get('content', row.get('critique')))
                    canonical = split_statements(parsed) if parsed is not None else []
                    if parsed is not None and row.get('statements', canonical) != canonical:
                        parsed, canonical = None, []
                        row['error'] = 'statement_mismatch'
                    row.update(critique=parsed, statements=row.get('statements', canonical) if parsed is not None else [])
                    if parsed is None:
                        row['parse_error'] = 'invalid_critique_json'
                if row.get('error'):
                    row['parse_error'] = None
                row.setdefault('content', '')
                row.setdefault('prompt_sha256', config.get('prompt_sha256'))
                row['judgments'] = attach_judgments(row, judges.get((item['id'], model, variant), []), diagnostics, slug) if ask == 0 else {}
                row['latencyMs'] = finite(row.get('wall_s', row.get('elapsed_s')), 1000)
                row['peakVramMb'] = finite(row.get('peak_vram_mb'))
                if ask == 0:
                    counts['expected'] += 1
                    counts['present'] += original is not None
                    counts['valid'] += row.get('critique') is not None and not row.get('error')
                    counts['failed'] += bool(row.get('error')) and row.get('error') != 'missing_prediction'
                    counts['invalid'] += bool(row.get('parse_error'))
                    counts['judged'] += len(row['judgments']) == 3
                merged.append(row)
        primary = [row for row in merged if row['ask'] == 0]
        summaries = {}
        for subset in ('all', 'photos', 'openimages'):
            subset_rows = [row for row in primary if subset == 'all' or row['set'] == subset]
            summary = summarize(subset_rows)
            summary['descriptiveHallucination'] = descriptive_hallucination(subset_rows, summary)
            summaries[subset] = summary
        stability = critique_stability(merged)
        inference_complete = bool(expected) and all(row.get('critique') is not None and not row.get('error') for row in merged)
        judged_complete = bool(expected) and counts['judged'] == counts['expected']
        status = ('missing_model' if not predictions else 'incomplete_inference' if not inference_complete else
                  'awaiting_judges' if not judged_complete else 'judged')
        cell = {'model': model, 'modelSlug': slug, 'variant': variant, 'status': status, 'sourcePhase': source_phase,
                'fullyFormattedAndJudged': inference_complete and judged_complete,
                'preregisteredGatesPass': summaries['all']['gate']['passes'],
                'runtimeAcceptance': 'not_evaluated',
                'coverage': {'expectedPhotos': counts['expected'], 'presentAsk0': counts['present'],
                             'validAsk0': counts['valid'], 'missingAsk0': counts['expected'] - counts['present'],
                             'failedAsk0': counts['failed'], 'invalidAsk0': counts['invalid'],
                             'threeFamilyJudgedPhotos': counts['judged']},
                'promptSha256': sorted({row['prompt_sha256'] for row in merged if row.get('prompt_sha256')}),
                'splits': summaries, 'stability': stability, 'telemetry': telemetry(performance, variant),
                'failure': read_json(root, source / 'failure.json', diagnostics=diagnostics),
                'sourceDirectory': source.name}
        cells.append((cell, merged))
    return cells


def report(root=CACHE_ROOT, models=None, manifest_file=None, source_phase='full'):
    root = checked_root(root)
    if source_phase not in SOURCE_PHASES:
        raise ValueError('source phase must be full, pilot or smoke')
    diagnostics = []
    manifest_file = within(root, Path(manifest_file) if manifest_file else root / 'prepared/manifest.jsonl')
    if manifest_file.resolve() != (root / 'prepared/manifest.jsonl').resolve():
        raise ValueError('all reports require the complete frozen prepared manifest')
    if not manifest_file.exists():
        raise ValueError('the complete W36 prepared manifest is required for honest coverage')
    manifest = read_rows(root, manifest_file, diagnostics)
    if diagnostics or not manifest or any(item.get('set') not in ('photos', 'openimages') or not isinstance(item.get('id'), str)
            or not item['id'] or not isinstance(item.get('specialist_facts', []), list) for item in manifest):
        raise ValueError('invalid prepared manifest')
    if len({item['id'] for item in manifest}) != len(manifest):
        raise ValueError('duplicate manifest image id')
    provenance = frozen_provenance(root, manifest_file, manifest, source_phase)
    models = list(models or DEFAULT_MODELS)
    if len(set(models)) != len(models) or any(not re.fullmatch(r'[a-z0-9][a-z0-9._-]{0,80}', model) for model in models):
        raise ValueError('model output prefixes must be unique safe names')
    judges, judge_files = judge_index(root, diagnostics)
    cells = [cell for slug in models for cell in model_cells(root, slug, manifest, judges, diagnostics, source_phase, provenance)]
    suffix = '' if source_phase == 'full' else '-' + source_phase
    result_name, predictions_name = 'results' + suffix + '.json', 'predictions' + suffix + '.jsonl'
    destinations = [root / result_name] + [root / (cell['modelSlug'] + '-' + cell['variant']) / name
                                         for cell, _ in cells for name in (result_name, predictions_name)]
    for destination in destinations:
        within(root, destination)
    result = {'task': 'critique', 'primaryAsk': 0, 'sourcePhase': source_phase, 'gates': dict(GATES),
              'runtimeAcceptance': 'not_evaluated',
              'evaluationMeaning': {'preregisteredGatesPass': 'Only the frozen statistical gates; disputed votes excluded.',
                                    'fullyFormattedAndJudged': 'Coverage of both valid asks and all three judges, separate from the gates.'},
              'manifestSha256': hashlib.sha256(manifest_file.read_bytes()).hexdigest(),
              'manifestPhotos': dict(Counter(item['set'] for item in manifest)),
              'frozenProvenance': provenance,
              'judgeBatchFiles': judge_files, 'cells': [cell for cell, _ in cells], 'diagnostics': diagnostics,
              'referenceCaveat': '老师是参照而非真值，可能偏好自身文风；缺失与争议不作为正确陈述。'}
    for cell, merged in cells:
        directory = root / (cell['modelSlug'] + '-' + cell['variant'])
        save(root, directory / result_name, cell)
        save(root, directory / predictions_name, merged, jsonl=True)
    save(root, root / result_name, result)
    return result


def main(argv=None):
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--root', type=Path, default=CACHE_ROOT)
    parser.add_argument('--models', nargs='+')
    parser.add_argument('--manifest', type=Path)
    parser.add_argument('--source-phase', choices=SOURCE_PHASES, default='full')
    args = parser.parse_args(argv)
    result = report(args.root, args.models, args.manifest, args.source_phase)
    print(json.dumps({'cells': len(result['cells']), 'sourcePhase': args.source_phase,
                      'preregisteredGatesPass': sum(cell['preregisteredGatesPass'] for cell in result['cells']),
                      'fullyFormattedAndJudged': sum(cell['fullyFormattedAndJudged'] for cell in result['cells']),
                      'runtimeAcceptance': 'not_evaluated',
                      'statuses': dict(Counter(cell['status'] for cell in result['cells']))}, ensure_ascii=False))


if __name__ == '__main__':
    main()
