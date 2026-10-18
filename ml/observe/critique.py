"""Versioned single-photo critique parsing and three-family evaluation; stdlib only."""
from collections import Counter, defaultdict
import hashlib
import json
import math
from pathlib import Path
import re

from ml.observe.vlm_eval import _json_object, wilson_low


PROMPT_PATH = Path(__file__).parent / 'prompts' / 'critique-v1.md'
FAMILIES = ('flash', 'gpt', 'claude')
GATES = {'statementPrecision': .90, 'statementWilsonLow': .85, 'statementN': 140,
         'editReasonableness': .85, 'editWilsonLow': .80, 'editN': 140}


def load_prompt(path=None):
    path = Path(path) if path else PROMPT_PATH
    data = path.read_bytes()
    match = re.fullmatch(r'---\r?\n(.*?)\r?\n---\r?\n\s*## 系统提示词\s*\n(.*?)\n## 用户提示词\s*\n(.*)',
                         data.decode('utf-8'), re.S)
    if not match:
        raise ValueError('prompt requires JSON front matter and two Chinese prompt sections')
    meta = _json_object(match[1])
    if not meta or set(meta) != {'id', 'version', 'generation', 'output_schema'}:
        raise ValueError('invalid prompt metadata')
    if any(not isinstance(meta[key], str) or not meta[key].strip() for key in ('id', 'version')):
        raise ValueError('invalid prompt identity')
    generation = meta['generation']
    if (not isinstance(generation, dict) or set(generation) != {'temperature', 'asks', 'seeds', 'max_new_tokens'}
            or type(generation['temperature']) not in (int, float) or generation['temperature'] != 0
            or generation['asks'] != 2 or not isinstance(generation['seeds'], list)
            or len(generation['seeds']) != 2 or any(type(seed) is not int for seed in generation['seeds'])
            or len(set(generation['seeds'])) != 2 or type(generation['max_new_tokens']) is not int
            or not 1 <= generation['max_new_tokens'] <= 4096):
        raise ValueError('critique requires two fixed distinct seeds and temperature zero')
    schema = meta['output_schema']
    if (not isinstance(schema, dict) or schema.get('type') != 'object'
            or set(schema.get('required', [])) != {'summary', 'strengths', 'issues', 'edits', 'verdict'}
            or not isinstance(schema.get('properties'), dict)):
        raise ValueError('invalid critique schema')
    return {**meta, 'sha256': hashlib.sha256(data).hexdigest(),
            'system': match[2].strip(), 'user': match[3].strip()}


def build_prompt(artifact, facts=None, variant='A'):
    if variant not in ('A', 'B'):
        raise ValueError('unknown critique prompt variant')
    facts = [] if facts is None else facts
    if not isinstance(facts, list) or any(not isinstance(fact, (str, dict)) for fact in facts):
        raise ValueError('facts must be a list of stored specialist observations')
    user = artifact['user']
    if variant == 'B':
        user += '\n\n已知事实（已通过门槛的专用观察，可靠且不得矛盾；未列出的项目为未知）：\n'
        user += json.dumps(facts, ensure_ascii=False, sort_keys=True) if facts else '无已知事实；不要猜测。'
    return {'system': artifact['system'] + '\n\n输出 JSON Schema：\n'
            + json.dumps(artifact['output_schema'], ensure_ascii=False, separators=(',', ':')),
            'user': user, 'prompt_hash': artifact['sha256']}


def _validate(value, schema, path, errors):
    kind = schema.get('type')
    matches = {'object': isinstance(value, dict), 'array': isinstance(value, list),
               'string': isinstance(value, str)}
    if kind not in matches or not matches[kind]:
        errors.append(path + ': invalid type')
        return
    if 'enum' in schema and value not in schema['enum']:
        errors.append(path + ': invalid enum')
    if kind == 'object':
        properties = schema.get('properties', {})
        if schema.get('additionalProperties') is False and set(value) - set(properties):
            errors.append(path + ': unexpected fields')
        if set(schema.get('required', [])) - set(value):
            errors.append(path + ': missing fields')
        for key in set(value) & set(properties):
            _validate(value[key], properties[key], path + '.' + key, errors)
    elif kind == 'array':
        if len(value) > schema.get('maxItems', math.inf):
            errors.append(path + ': too many items')
        for index, item in enumerate(value):
            _validate(item, schema['items'], f'{path}[{index}]', errors)
    else:
        if not schema.get('minLength', 0) <= len(value) <= schema.get('maxLength', math.inf):
            errors.append(path + ': invalid length')
        if not value.strip():
            errors.append(path + ': blank text')
        if 'enum' not in schema and path.rsplit('.', 1)[-1] != 'amount' and not re.search('[\u3400-\u9fff]', value):
            errors.append(path + ': Chinese text required')


def validate_critique(raw, artifact=None):
    errors = []
    _validate(raw, (artifact or load_prompt())['output_schema'], '$', errors)
    return errors


def parse_critique(raw, artifact=None):
    parsed = _json_object(raw) if isinstance(raw, str) else raw
    return parsed if isinstance(parsed, dict) and not validate_critique(parsed, artifact) else None


def split_statements(critique):
    if validate_critique(critique):
        raise ValueError('cannot split an invalid critique')
    statements = []
    for kind, field in (('strength', 'strengths'), ('issue', 'issues'), ('edit', 'edits')):
        for index, item in enumerate(critique[field]):
            category = item.get('category', item.get('action', 'strength'))
            text = item.get('text') if kind != 'edit' else '；'.join(
                item[key] for key in ('direction', 'amount', 'reason') if key in item)
            statements.append({**item, 'id': f'{kind}-{index + 1}', 'kind': kind,
                               'category': category, 'text': text})
    return statements + [{'id': 'verdict', 'kind': 'verdict', 'category': 'verdict', 'text': critique['verdict']}]


def _decision(values, positive, negative):
    if len(values) == 3 and all(value == positive for value in values):
        return 'correct'
    return 'wrong' if values.count(negative) >= 2 else 'disputed'


def aggregate_judges(statements, judgments):
    """Canonical family -> rows. Missing/invalid labels remain disputed, never negative."""
    ids = [statement['id'] for statement in statements]
    if len(ids) != len(set(ids)):
        raise ValueError('duplicate statement id')
    if not isinstance(judgments, dict) or set(judgments) - set(FAMILIES):
        raise ValueError('judgments require canonical independent families')
    by_family = {}
    for family, rows in judgments.items():
        if not isinstance(rows, list) or any(not isinstance(row, dict) or row.get('id') not in ids for row in rows):
            raise ValueError('unknown statement id in judge response')
        by_family[family] = {row['id']: row for row in rows}
        if len(by_family[family]) != len(rows):
            raise ValueError('duplicate statement id in judge response')
    result = []
    for statement in statements:
        votes = [by_family.get(family, {}).get(statement['id'], {}) for family in FAMILIES]
        correctness = _decision([vote.get('correctness') for vote in votes], '正确', '错误')
        reasonable = _decision([vote.get('reasonableness') for vote in votes], '合理', '不合理')
        contradiction = _decision([vote.get('contradiction') for vote in votes], '不矛盾', '矛盾')
        novelty = _decision([vote.get('novelty') for vote in votes], '新增', '重复')
        result.append({**statement, 'correctness': correctness,
                       'reasonableness': reasonable if statement['kind'] == 'edit' else None,
                       'contradiction': {'correct': False, 'wrong': True, 'disputed': None}[contradiction],
                       'novelty': {'correct': True, 'wrong': False, 'disputed': None}[novelty]})
    return result


def _ratio(numerator, denominator):
    return numerator / denominator if denominator else None


def _score(values):
    counts = Counter(values)
    correct, wrong, disputed = (counts[key] for key in ('correct', 'wrong', 'disputed'))
    return {'correct': correct, 'wrong': wrong, 'disputed': disputed, 'judged': correct + wrong,
            'precision': _ratio(correct, correct + wrong), 'wilsonLow': wilson_low(correct, correct + wrong),
            'disputedRate': _ratio(disputed, correct + wrong + disputed)}


def _binary_score(values):
    known = [value for value in values if value is not None]
    return {'positive': sum(value is True for value in known), 'judged': len(known),
            'disputed': len(values) - len(known), 'rate': _ratio(sum(value is True for value in known), len(known)),
            'coverage': _ratio(len(known), len(values))}


def _percentile(values, quantile):
    values = sorted(value for value in values if type(value) in (int, float) and math.isfinite(value) and value >= 0)
    if not values:
        return None
    position = quantile * (len(values) - 1)
    low, high = math.floor(position), math.ceil(position)
    return values[low] + (values[high] - values[low]) * (position - low)


def stability(first, second):
    first, second = parse_critique(first), parse_critique(second)
    if first is None or second is None:
        return {'issues': None, 'edits': None}
    out = {}
    for field, category in (('issues', 'category'), ('edits', 'action')):
        a, b = ({row[category] for row in critique[field]} for critique in (first, second))
        out[field] = len(a & b) / len(a | b) if a | b else 1.0
    return out


def critique_stability(predictions):
    by_id = defaultdict(dict)
    for prediction in predictions:
        if prediction.get('ask') not in (0, 1):
            raise ValueError('critique asks must be 0 or 1')
        asks = by_id[prediction['id']]
        if prediction['ask'] in asks:
            raise ValueError('duplicate critique ask')
        asks[prediction['ask']] = None if prediction.get('error') else prediction.get('content')
    pairs = [stability(asks.get(0), asks.get(1)) for asks in by_id.values()]
    return {field: {'n': sum(pair[field] is not None for pair in pairs),
                    'missingOrInvalid': sum(pair[field] is None for pair in pairs),
                    'jaccard': _ratio(sum(pair[field] for pair in pairs if pair[field] is not None),
                                      sum(pair[field] is not None for pair in pairs))}
            for field in ('issues', 'edits')}


def summarize(rows):
    """Per model/variant first-ask rows: id, statements, judgments, facts, optional telemetry.

    Missing first asks must be included with statements=[] so photo coverage stays honest.
    Judge contradiction and novelty are explicit labels, never keyword heuristics.
    """
    rows = list(rows)
    if len({row['id'] for row in rows}) != len(rows):
        raise ValueError('duplicate photo id')
    judged = [(row, aggregate_judges(row.get('statements', []), row.get('judgments', {}))) for row in rows]
    all_statements = [statement for _, statements in judged for statement in statements]
    statement_score = _score([statement['correctness'] for statement in all_statements])
    edits = [statement for statement in all_statements if statement['kind'] == 'edit' and statement.get('action') != 'none']
    edit_score = _score([statement['reasonableness'] for statement in edits])
    checks = {'statementPrecision': (statement_score['precision'] or 0) >= GATES['statementPrecision'],
              'statementWilsonLow': (statement_score['wilsonLow'] or 0) >= GATES['statementWilsonLow'],
              'statementN': statement_score['judged'] >= GATES['statementN'],
              'editReasonableness': (edit_score['precision'] or 0) >= GATES['editReasonableness'],
              'editWilsonLow': (edit_score['wilsonLow'] or 0) >= GATES['editWilsonLow'],
              'editN': edit_score['judged'] >= GATES['editN']}
    photos = Counter('wrong' if any(s['correctness'] == 'wrong' for s in statements) else
                     'clear' if statements and all(s['correctness'] == 'correct' for s in statements) else 'unresolved'
                     for _, statements in judged)
    categories = defaultdict(list)
    for statement in all_statements:
        categories[statement['kind'] + ':' + statement['category']].append(statement['correctness'])
    with_facts = [statement for row, statements in judged if row.get('facts') for statement in statements]
    return {'photos': len(rows), 'statements': statement_score, 'edits': edit_score,
            'noOpEdits': sum(s['kind'] == 'edit' and s.get('action') == 'none' for s in all_statements),
            'gate': {'passes': all(checks.values()), 'checks': checks, 'thresholds': dict(GATES)},
            'categories': {key: _score(values) for key, values in sorted(categories.items())},
            'hallucination': {'wrongPhotos': photos['wrong'], 'fullyCorrectPhotos': photos['clear'],
                              'unresolvedPhotos': photos['unresolved'],
                              'rate': _ratio(photos['wrong'], photos['wrong'] + photos['clear']),
                              'observedWrongRate': _ratio(photos['wrong'], len(rows)),
                              'coverage': _ratio(photos['wrong'] + photos['clear'], len(rows))},
            'contradiction': _binary_score([s['contradiction'] for s in with_facts]),
            'novelty': _binary_score([s['novelty'] for s in all_statements]),
            'latencyMs': {key: _percentile([row.get('latencyMs') for row in rows], q) for key, q in (('p50', .5), ('p95', .95))},
            'peakVramMb': {key: _percentile([row.get('peakVramMb') for row in rows], q) for key, q in (('p50', .5), ('p95', .95))}}
