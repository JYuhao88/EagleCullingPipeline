"""Fixed-questionnaire VLM parsing and evaluation; stdlib only, never runs inference."""
import argparse
import json
import math
from pathlib import Path
import re


QUESTIONS = {
    'smile': {'scope': 'face', 'text': '主体是否在笑', 'options': {
        'big': '明显笑（露齿或嘴角明显上扬）', 'slight': '微笑', 'none': '没有笑', 'unsure': '看不清'}},
    'mouth': {'scope': 'face', 'text': '主体的嘴', 'options': {
        'open': '张开', 'slight': '微张', 'closed': '闭合', 'unsure': '看不清'}},
    'eyes': {'scope': 'face', 'text': '主体的眼睛', 'options': {
        'open': '睁开', 'half': '半闭', 'closed': '闭上', 'unsure': '看不清'}},
    'natural': {'scope': 'face', 'text': '主体的表情', 'options': {
        'relaxed': '自然放松', 'stiff': '僵硬或刻意', 'unsure': '看不清'}},
    'gaze': {'scope': 'face', 'text': '主体的视线', 'options': {
        'camera': '看镜头', 'away': '看别处', 'unsure': '看不清'}},
    'others': {'scope': 'scene', 'text': '画面中主体以外的人', 'options': {
        'none': '没有其他人', 'quiet': '有其他人但不分散注意力',
        'distracting': '有其他人且分散注意力', 'unsure': '看不清'}},
    'clutter': {'scope': 'scene', 'text': '背景', 'options': {
        'clean': '干净', 'busy': '略杂', 'cluttered': '杂乱抢眼', 'unsure': '看不清'}},
    'merger': {'scope': 'scene', 'text': '是否有物体从主体头部或身体后方“长出来”（如杆子、树枝）',
               'options': {'no': '没有', 'yes': '有', 'unsure': '看不清'}},
    'separation': {'scope': 'scene', 'text': '主体和背景', 'options': {
        'clear': '分离清楚', 'merged': '粘连（颜色或明暗接近）', 'unsure': '看不清'}},
}
POSITIVE = {'smile': ['big', 'slight'], 'mouth': ['open', 'slight'], 'eyes': ['half', 'closed'],
            'natural': ['stiff'], 'gaze': ['camera'], 'others': ['distracting'],
            'clutter': ['cluttered'], 'merger': ['yes'], 'separation': ['merged']}
GROUP_OPTIONS = {'left': '左图', 'right': '右图', 'tie': '相当', 'unsure': '看不清'}


def _unique_object(pairs):
    out = {}
    for key, value in pairs:
        if key in out:
            raise ValueError('duplicate JSON key')
        out[key] = value
    return out


def _json_object(text):
    if not isinstance(text, str):
        return None
    text = text.strip()
    match = re.fullmatch(r'```(?:json)?\s*\n?(.*?)\n?```', text, re.S)
    if match:
        text = match[1].strip()
    try:
        raw = json.loads(text, object_pairs_hook=_unique_object,
                         parse_constant=lambda _: (_ for _ in ()).throw(ValueError('nonfinite JSON')))
    except (ValueError, TypeError):
        return None
    return raw if isinstance(raw, dict) else None


def parse_answers(text, questions=None):
    """Canonical options; missing/invalid answers stay None, never negative labels.

    Extra or duplicate keys and surrounding prose reject the entire response. A
    single fenced JSON object is allowed. Explicit unsure remains distinguishable
    from a missing option, but both become abstentions in binary scoring.
    """
    keys = list(QUESTIONS if questions is None else questions)
    if any(key not in QUESTIONS for key in keys) or len(keys) != len(set(keys)):
        raise ValueError('unknown or duplicate question')
    out = dict.fromkeys(keys)
    raw = _json_object(text)
    if raw is None or set(raw) - set(keys):
        return out
    for key in keys:
        value = raw.get(key)
        if not isinstance(value, str):
            continue
        out[key] = next((option for option, label in QUESTIONS[key]['options'].items()
                         if value in (option, label)), None)
    return out


def parse_group(text):
    raw = _json_object(text)
    if raw is None or set(raw) != {'choice'} or not isinstance(raw['choice'], str):
        return None
    return next((key for key, label in GROUP_OPTIONS.items() if raw['choice'] in (key, label)), None)


def binary(key, option):
    return None if option is None or option == 'unsure' else int(option in POSITIVE[key])


def _known(value):
    return int(value) if type(value) in (int, bool) and value in (0, 1) else None


def _majority(values):
    return next((value for value in set(values) - {None} if values.count(value) >= 2), None)


def _stable(values):
    return values[0] if len(values) == 3 and None not in values and len(set(values)) == 1 else None


def _ratio(numerator, denominator):
    return numerator / denominator if denominator else None


def wilson_low(correct, count, z=1.959963984540054):
    if type(correct) is not int or type(count) is not int or not 0 <= correct <= count:
        raise ValueError('invalid binomial counts')
    if not count:
        return None
    p, z2 = correct / count, z * z
    return (p + z2 / (2 * count) - z * math.sqrt(p * (1 - p) / count + z2 / (4 * count * count))) / (1 + z2 / count)


def kappa(pairs):
    both = [(a, b) for a, b in pairs if a is not None and b is not None]
    n = len(both)
    agreement = _ratio(sum(a == b for a, b in both), n)
    if not n:
        return {'n': 0, 'agreement': None, 'kappa': None, 'reason': 'no paired answers'}
    pa, pb = sum(a == 1 for a, _ in both) / n, sum(b == 1 for _, b in both) / n
    chance = pa * pb + (1 - pa) * (1 - pb)
    return {'n': n, 'agreement': agreement, 'kappa': (agreement - chance) / (1 - chance) if chance < 1 else None,
            'reason': 'constant identical marginals' if chance == 1 else None}


def score(pairs):
    pairs = list(pairs)
    both = [(guess, truth) for guess, truth in pairs if guess is not None and truth is not None]
    tp = sum(guess == truth == 1 for guess, truth in both)
    fp = sum(guess == 1 and truth == 0 for guess, truth in both)
    fn = sum(guess == 0 and truth == 1 for guess, truth in both)
    statements = sum(guess == 1 for guess, _ in pairs)
    return {'n': len(both), 'referenceN': sum(truth is not None for _, truth in pairs),
            'coverage': _ratio(len(both), len(pairs)),
            'accuracy': _ratio(sum(guess == truth for guess, truth in both), len(both)),
            'positiveStatements': statements, 'scoredPositiveStatements': tp + fp,
            'unreferencedPositiveStatements': statements - tp - fp,
            'truePositives': tp, 'falsePositives': fp, 'falseNegatives': fn,
            'precision': _ratio(tp, tp + fp), 'precisionLow': wilson_low(tp, tp + fp),
            'recall': _ratio(tp, tp + fn)}


def _family(name):
    return 'flash' if 'flash' in name else 'gpt' if name.startswith('gpt') else 'claude' if 'claude' in name else None


def teacher_votes(item, key):
    families = {}
    for teacher, values in item.get('votes', {}).get(key, {}).items():
        family = _family(teacher)
        if family is None or not isinstance(values, list):
            continue
        normalized = [_known(value) for value in values]
        if family in families:
            raise ValueError('duplicate teacher family in manifest')
        families[family] = normalized
    flash = _majority(families.get('flash', []))
    teachers = {'flash': flash, **{family: (families.get(family) or [None])[0] for family in ('gpt', 'claude')}}
    values = list(teachers.values())
    panel = values[0] if None not in values and len(set(values)) == 1 else None
    return teachers, panel


def _gate(rows, key, policy, label=1):
    eligible = [row for row in rows if row['item'].get('set') in ('photos', 'openimages')
                and not (QUESTIONS[key]['scope'] == 'face' and row['item'].get('set') == 'photos' and row['item'].get('faceHeight') is not None
                         and row['item']['faceHeight'] < .05)]
    invert = lambda value: None if value is None else 1 - value
    measured = score((row[policy], row['panel']) if label == 1 else (invert(row[policy]), invert(row['panel']))
                     for row in eligible)
    precision = .95 if key == 'gaze' else .90
    checks = {'statements': measured['scoredPositiveStatements'] >= 140,
              'precision': measured['precision'] is not None and measured['precision'] >= precision,
              'wilson95Low': measured['precisionLow'] is not None and measured['precisionLow'] >= .85}
    result = {**measured, 'minimum': {'statements': 140, 'precision': precision, 'wilson95Low': .85},
            'checks': checks, 'passes': all(checks.values()),
            'reference': 'three-family consensus on Open Images and photos; CelebA excluded',
            'smallPhotoFacesExcluded': sum(QUESTIONS[key]['scope'] == 'face' and row['item'].get('set') == 'photos'
                and row['item'].get('faceHeight') is not None and row['item']['faceHeight'] < .05 for row in rows),
            'photoFaceHeightMissing': sum(row['item'].get('set') == 'photos'
                and row['item'].get('faceHeight') is None for row in rows)}
    if label == 0:
        refs = [row['panel'] for row in eligible if row['panel'] is not None]
        result.update(label=0, choices=[option for option in QUESTIONS[key]['options']
                                      if option not in POSITIVE[key] and option != 'unsure'],
                      constantBaselinePrecision=_ratio(sum(value == 0 for value in refs), len(refs)),
                      statementCoverage=_ratio(measured['positiveStatements'], len(eligible)),
                      referenceStatementCoverage=_ratio(measured['scoredPositiveStatements'], len(eligible)))
        if key == 'gaze':
            result['candidateText'] = '看向别处'
    return result


def _attribute(rows, key, statements=False):
    n = len(rows)
    complete = [row for row in rows if None not in row['values']]
    parsed = [row for row in rows if None not in row['options']]
    policies = {}
    for policy in ('single', 'rawMajority', 'stable'):
        policies[policy] = {'abstentionN': sum(row[policy] is None for row in rows),
                            'abstentionRate': _ratio(sum(row[policy] is None for row in rows), n),
                            'consensus': score((row[policy], row['panel']) for row in rows),
                            'kappa': {teacher: kappa((row[policy], row['teachers'][teacher]) for row in rows)
                                      for teacher in ('flash', 'gpt', 'claude')},
                            'gate': _gate(rows, key, policy)}
        truth_rows = [row for row in rows if row['item'].get('set') == 'celeba' and key in ('smile', 'mouth')]
        if truth_rows:
            policies[policy]['celebaTruth'] = score((row[policy], _known(row['item'].get('truth', {}).get(key)))
                                                   for row in truth_rows)
        if statements:
            policies[policy]['negativeGate'] = _gate(rows, key, policy, label=0)
    present = sum(row['present'] for row in rows)
    valid = sum(value is not None for row in rows for value in row['values'])
    unsure = sum(option == 'unsure' for row in rows for option in row['options'])
    return {'n': n, 'consensusN': sum(row['panel'] is not None for row in rows),
            'consensusCoverage': _ratio(sum(row['panel'] is not None for row in rows), n),
            'calls': {'expected': n * 3, 'present': present, 'missing': n * 3 - present,
                      'binaryAnswered': valid, 'abstentionN': n * 3 - valid,
                      'explicitUnsureN': unsure, 'missingInvalidOrErrorN': n * 3 - valid - unsure,
                      'abstentionRate': _ratio(n * 3 - valid, n * 3)},
            'ask3': {'completeBinaryN': len(complete),
                     'binaryFlipN': sum(len(set(row['values'])) > 1 for row in parsed),
                     'completeParsedN': len(parsed),
                     'flipRate': _ratio(sum(len(set(row['values'])) > 1 for row in parsed), len(parsed)),
                     'nonAbstainingFlipRate': _ratio(sum(len(set(row['values'])) > 1 for row in complete), len(complete)),
                     'completeCategoricalN': len(parsed),
                     'categoricalFlipRate': _ratio(sum(len(set(row['options'])) > 1 for row in parsed), len(parsed)),
                     'incompleteOrAbstainingN': n - len(complete)}, **policies}


def _group_report(items, index):
    rows = []
    for item in items:
        options = [parse_group(index[(item['id'], ask)].get('content'))
                   if (item['id'], ask) in index and not index[(item['id'], ask)].get('error') else None for ask in range(3)]
        values = [None if option == 'unsure' else option for option in options]
        rows.append({'item': item, 'options': options, 'values': values, 'single': values[0], 'rawMajority': _majority(values),
                     'stable': _stable(values)})
    complete = [row for row in rows if None not in row['values']]
    parsed = [row for row in rows if None not in row['options']]
    out = {'n': len(rows), 'interpretation': 'weak user preference only; not expression or eye ground truth',
           'ask3': {'completeN': len(complete), 'completeParsedN': len(parsed),
                    'flipRate': _ratio(sum(len(set(row['values'])) > 1 for row in parsed), len(parsed)),
                    'nonAbstainingFlipRate': _ratio(sum(len(set(row['values'])) > 1 for row in complete), len(complete))}}
    for policy in ('single', 'rawMajority', 'stable'):
        subsets = {'all': rows, 'independentUser': [row for row in rows if not row['item'].get('acceptedAi')],
                   'acceptedAi': [row for row in rows if row['item'].get('acceptedAi')]}
        result = {}
        for name, subset in subsets.items():
            compared = [(row[policy], row['item'].get('preferred', row['item'].get('truth'))) for row in subset]
            valid = [(guess, truth) for guess, truth in compared if guess in ('left', 'right') and truth in ('left', 'right')]
            result[name] = {'n': len(subset), 'preferenceN': sum(truth in ('left', 'right') for _, truth in compared),
                            'comparedN': len(valid), 'agreement': _ratio(sum(guess == truth for guess, truth in valid), len(valid)),
                            'ties': sum(row[policy] == 'tie' for row in subset),
                            'abstentionN': sum(row[policy] is None for row in subset),
                            'abstentionRate': _ratio(sum(row[policy] is None for row in subset), len(subset))}
        out[policy] = result
    return out


def evaluate(manifest, predictions, *, statements=False):
    """Score one model, three asks per item; no absent/error answer becomes a no."""
    items = list(manifest)
    if len({item['id'] for item in items}) != len(items):
        raise ValueError('duplicate manifest id')
    item_ids = {item['id'] for item in items}
    index, duplicates, ignored = {}, set(), 0
    for prediction in predictions:
        identity = (prediction.get('id'), prediction.get('ask'))
        if identity[0] not in item_ids or type(identity[1]) is not int or identity[1] not in range(3):
            ignored += 1
            continue
        if identity in index:
            duplicates.add(identity)
        index[identity] = prediction
    # Duplicate attempts are ambiguous; do not choose the successful response after observing failures.
    for identity in duplicates:
        index[identity] = {'error': 'duplicate prediction identity'}
    rows = []
    for item in items:
        if item.get('kind') == 'group':
            continue
        keys = item.get('questions', list(item.get('votes', {})))
        keys = [key for key in keys if key in QUESTIONS]
        answers = [parse_answers(index[(item['id'], ask)].get('content'), keys)
                   if (item['id'], ask) in index and not index[(item['id'], ask)].get('error') else dict.fromkeys(keys)
                   for ask in range(3)]
        for key in keys:
            options = [answer[key] for answer in answers]
            values = [binary(key, option) for option in options]
            teachers, panel = teacher_votes(item, key)
            rows.append({'item': item, 'key': key, 'values': values, 'options': options,
                         'single': values[0], 'rawMajority': _majority(values), 'stable': _stable(values),
                         'teachers': teachers, 'panel': panel,
                         'present': sum((item['id'], ask) in index for ask in range(3))})
    sets = {}
    for name in ['all', *sorted({item.get('set', 'unknown') for item in items if item.get('kind') != 'group'})]:
        subset = [row for row in rows if name == 'all' or row['item'].get('set') == name]
        members = [item for item in items if item.get('kind') != 'group' and (name == 'all' or item.get('set') == name)]
        sets[name] = {'n': len(members), 'attributes': {key: _attribute([row for row in subset if row['key'] == key], key, statements)
                                                    for key in QUESTIONS if any(row['key'] == key for row in subset)}}
    result = {'schemaVersion': 2 if statements else 1, 'counts': {'items': len(items), 'predictionIdentities': len(index),
                                         'duplicateIdentities': len(duplicates), 'ignoredPredictions': ignored},
            'policy': {'single': 'ask 0', 'rawMajority': 'at least two equal non-abstaining binary answers',
                       'stable': 'all three non-abstaining binary answers equal',
                       'consensus': 'flash ask-3 majority equals gpt and claude, all non-abstaining',
                       'flipDenominator': 'three parsed fixed-option answers, including unsure transitions; non-abstaining rate also reported'},
            'sets': sets, 'groups': _group_report([item for item in items if item.get('kind') == 'group'], index)}
    if statements:
        result['policy']['negativeStatements'] = 'Invert both known binary predictions and references; abstentions unchanged; same gates.'
    return result


def _read_rows(file):
    text = Path(file).read_text()
    if text.lstrip().startswith('['):
        rows = json.loads(text)
    else:
        rows = [json.loads(line) for line in text.splitlines() if line.strip()]
    if not isinstance(rows, list) or any(not isinstance(row, dict) for row in rows):
        raise ValueError('expected JSON array or JSONL objects')
    return rows


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    for name in ('manifest', 'predictions', 'output'):
        parser.add_argument('--' + name, required=True)
    parser.add_argument('--statements', action='store_true', help='Also score the opposite fixed questionnaire state with identical gates')
    args = parser.parse_args()
    report = evaluate(_read_rows(args.manifest), _read_rows(args.predictions), statements=args.statements)
    Path(args.output).write_text(json.dumps(report, ensure_ascii=False, indent=2, allow_nan=False) + '\n')


if __name__ == '__main__':
    main()
