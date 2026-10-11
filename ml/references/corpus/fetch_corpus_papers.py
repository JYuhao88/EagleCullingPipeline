#!/usr/bin/env python3
"""CPU-only Ray provenance scan and ID-verified, bounded full-text transfer.
Local text must stay under /tmp/corpus/papers; no model calls or corpus writes.
"""
import sys as _private_sys
from pathlib import Path as _PrivatePath
if 'ml.common.private_env' not in _private_sys.modules:
    _private_sys.path.insert(0, str(_PrivatePath(__file__).resolve().parents[3]))
from ml.common.private_env import worker_source, setting, require_path, jobs_url, merge_private_env
import argparse
import base64
from concurrent.futures import ProcessPoolExecutor
from collections import Counter
import gzip
import hashlib
import json
import os
from pathlib import Path
import re
import shlex
import urllib.request

ROOT = require_path('ECP_CORPUS_ROOT')
PREFIX = 'PAPER_CHUNK '
DONE = 'PAPER_TRANSFER_DONE'
MAX_LOG_BYTES = 30_000_000
CONFIG = Path(globals().get('__file__', 'fetch_corpus_papers.py')).with_name('paper-filter.json')


def request(path='', body=None):
    if body and 'entrypoint' in body:
        merge_private_env(body)
    opener = urllib.request.build_opener(urllib.request.ProxyHandler({}))
    req = urllib.request.Request(jobs_url() + path, data=None if body is None else json.dumps(body).encode(), headers={'Content-Type': 'application/json'})
    return json.load(opener.open(req, timeout=60))


def classify_title(title, config):
    title = str(title or '')
    if any(re.search(p, title, re.I) for p in config['exclude']):
        return []
    if not any(re.search(p, title, re.I) for p in config['positive']):
        return []
    return [name for name, words in config['categories'].items() if any(re.search(p, title, re.I) for p in words)] or ['other_practice']


def normalized_title(title):
    """Collapse spacing/punctuation for local duplicate review, retaining Chinese."""
    return re.sub(r'[\W_]+', '', str(title or '')).casefold()


def select_rows(rows, config):
    """Apply the saved human title review without changing source row locations.

    reviewedAccept is an ID/title manifest, not a broad automatic relevance claim.
    Its reviewIndex records the previous review packet's ordering. New scans need
    a new title review; missing approved IDs fail rather than silently shrinking it.
    """
    profile = config.get('selection', {})
    review = profile.get('reviewedAccept')
    approved = None if review is None else {str(item['id']): item for item in review}
    if review is not None and len(approved) != len(review):
        raise ValueError('duplicate ID in reviewedAccept')
    chosen, seen_ids, seen_titles, found = [], set(), set(), set()
    counts = Counter()
    for index, row in enumerate(rows):
        counts['input'] += 1
        categories = classify_title(row.get('title'), config)
        if not categories:
            counts['keywordRejected'] += 1
            continue
        chars = row.get('chars')
        if chars is None or not profile.get('minChars', 0) <= int(chars) <= profile.get('maxChars', 10**9):
            counts['lengthRejected'] += 1
            continue
        identity = str(row['id'])
        decision = None if approved is None else approved.get(identity)
        if approved is not None:
            if decision is None:
                counts['titleReviewRejected'] += 1
                continue
            if row['title'] != decision['title']:
                raise ValueError('reviewed title changed for ID ' + identity)
        title_key = normalized_title(row['title'])
        if identity in seen_ids or (profile.get('deduplicateTitles', True) and title_key in seen_titles):
            counts['duplicateRejected'] += 1
            continue
        seen_ids.add(identity)
        seen_titles.add(title_key)
        found.add(identity)
        item = {**row, 'categories': categories, 'screenIndex': index}
        if decision is not None and 'reviewIndex' in decision:
            item['reviewIndex'] = decision['reviewIndex']
        chosen.append(item)
    if approved is not None and profile.get('requireAllReviewed', True) and found != set(approved):
        raise ValueError('reviewed IDs missing or rejected by profile: ' + ', '.join(sorted(set(approved) - found)))
    if profile.get('orderByReviewIndex', False):
        chosen.sort(key=lambda item: item['reviewIndex'])
    for index, item in enumerate(chosen):
        item['candidateIndex'] = index
    counts['selected'] = len(chosen)
    stats = dict(counts)
    stats['categories'] = dict(Counter(category for item in chosen for category in item['categories']))
    stats['categoriesOverlap'] = True
    stats['docTypes'] = dict(Counter(item.get('doc_type') for item in chosen))
    stats['channels'] = dict(Counter(item.get('channel') for item in chosen))
    return chosen, stats


def encoded_lines(name, raw):
    chunks = [raw[i:i+16384] for i in range(0, len(raw), 16384)] or [b'']
    for i, chunk in enumerate(chunks):
        yield PREFIX + json.dumps({'path': name, 'index': i, 'count': len(chunks), 'size': len(raw),
            'sha256': hashlib.sha256(raw).hexdigest(), 'chunk_sha256': hashlib.sha256(chunk).hexdigest(),
            'data': base64.b64encode(gzip.compress(chunk, mtime=0)).decode()})


def receive(logs, destination):
    if len(logs.encode()) > MAX_LOG_BYTES:
        raise ValueError('log exceeds 30 MB')
    root = Path(destination).resolve()
    allowed = Path('/tmp/corpus/papers').resolve()
    if not root.is_relative_to(allowed):
        raise ValueError('corpus output must stay under /tmp/corpus/papers')
    files = {}
    if DONE not in logs.splitlines():
        raise ValueError('incomplete transfer')
    for line in logs.splitlines():
        if not line.startswith(PREFIX):
            continue
        try:
            item = json.loads(line[len(PREFIX):])
            name = item['path']
            if not isinstance(name, str):
                raise ValueError('invalid export path')
            for field in ('index', 'count', 'size'):
                if type(item[field]) is not int or item[field] < 0:
                    raise ValueError('invalid chunk metadata')
            for field in ('sha256', 'chunk_sha256'):
                if not isinstance(item[field], str) or not re.fullmatch(r'[0-9a-f]{64}', item[field]):
                    raise ValueError('invalid checksum metadata')
            if item['count'] < 1 or item['index'] >= item['count']:
                raise ValueError('invalid chunk range')
            chunk = gzip.decompress(base64.b64decode(item['data'], validate=True))
        except (KeyError, TypeError, OSError, EOFError, ValueError) as error:
            raise ValueError('malformed transfer chunk') from error
        if not name or Path(name).is_absolute() or (root / name).resolve() == root or not (root / name).resolve().is_relative_to(root):
            raise ValueError('export path traversal')
        if hashlib.sha256(chunk).hexdigest() != item['chunk_sha256']:
            raise ValueError('chunk checksum')
        signature = (item['sha256'], item['size'], item['count'])
        entry = files.setdefault(name, {'signature': signature, 'parts': {}})
        if entry['signature'] != signature or item['index'] in entry['parts']:
            raise ValueError('duplicate/inconsistent chunk')
        entry['parts'][item['index']] = chunk
    if not files:
        raise ValueError('transfer contains no files')
    # Validate the whole transfer before publishing any files.
    outputs = {}
    for name, entry in files.items():
        sha, size, count = entry['signature']
        if count < 1 or set(entry['parts']) != set(range(count)):
            raise ValueError('missing chunks')
        raw = b''.join(entry['parts'][i] for i in range(count))
        if len(raw) != size or hashlib.sha256(raw).hexdigest() != sha:
            raise ValueError('file checksum')
        outputs[name] = raw
    for name, raw in outputs.items():
        target = root / name
        target.parent.mkdir(parents=True, exist_ok=True)
        temporary = target.with_suffix(target.suffix + '.part')
        temporary.write_bytes(raw)
        temporary.replace(target)
    return len(outputs)


def scan_partition(args):
    import pyarrow.parquet as pq
    import pyarrow.compute as pc
    file, config = args
    table = pq.read_table(file)
    broad = pc.fill_null(pc.match_substring_regex(table['title'], '(?i)(摄影|人像|肖像|街拍|编辑照片|照片编辑)'), False)
    positive = pc.fill_null(pc.match_substring_regex(table['title'], '(?i)(' + '|'.join(config['positive']) + ')'), False)
    negative = pc.fill_null(pc.match_substring_regex(table['title'], '(?i)(' + '|'.join(config['exclude']) + ')'), False)
    rows = table.filter(pc.and_(positive, pc.invert(negative))).to_pylist()
    for row in rows:
        row['categories'] = classify_title(row.get('title'), config)
        row['indexPartition'] = Path(file).name
    return {'total': table.num_rows, 'broad': pc.sum(pc.cast(broad, 'int64')).as_py(), 'positive': pc.sum(pc.cast(positive, 'int64')).as_py(), 'rows': rows}


def remote_scan(config):
    files = sorted(Path(ROOT).glob(setting('ECP_CORPUS_INDEX_PATTERN', 'index/zh/*.parquet')))
    if not files:
        raise ValueError('missing provenance partitions')
    rows, stats = [], {'partitions': len(files), 'total': 0, 'broad': 0, 'positive': 0}
    with ProcessPoolExecutor(8) as pool:
        for result in pool.map(scan_partition, [(str(p), config) for p in files]):
            rows.extend(result['rows'])
            for key in ('total', 'broad', 'positive'):
                stats[key] += result[key]
    stats['filtered'] = len(rows)
    export([('screened.jsonl', ''.join(json.dumps(r, ensure_ascii=False, default=str)+'\n' for r in rows).encode()),
            ('scan-stats.json', json.dumps(stats).encode())])


def verify_row(table, item):
    row = int(item['row'])
    if row < 0 or row >= table.num_rows:
        raise ValueError('row out of range')
    value = table.slice(row, 1).to_pylist()[0]
    if str(value['id']) != str(item['id']):
        raise ValueError('ID mismatch; file order or row interpretation is wrong')
    return value


def remote_fetch(items):
    import pyarrow.parquet as pq
    files = sorted(Path(ROOT).glob(setting('ECP_CORPUS_TEXT_PATTERN', 'papers/zh/**/*.parquet')))
    cache, outputs, metadata = {}, [], []
    for item in items:
        key = (int(item['file']), int(item['row_group']))
        if not 0 <= key[0] < len(files):
            raise ValueError('file index out of range')
        if key not in cache:
            cache = {key: pq.ParquetFile(files[key[0]]).read_row_group(key[1], columns=['id', 'text'])}
        value = verify_row(cache[key], item)
        slug = 'paper-' + hashlib.sha256(str(item['id']).encode()).hexdigest()[:16]
        text = value['text']
        if not isinstance(text, str) or not text.strip():
            raise ValueError('empty or non-string text')
        raw = text.encode()
        outputs.append(('text/' + slug + '.txt', raw))
        metadata.append({**item, 'slug': slug, 'verifiedFile': str(files[key[0]].relative_to(Path(ROOT))), 'textChars': len(text), 'textSha256': hashlib.sha256(raw).hexdigest()})
    export(outputs + [('fetched/' + hashlib.sha256(json.dumps(items, sort_keys=True).encode()).hexdigest()[:12]+'.json', json.dumps(metadata, ensure_ascii=False).encode())])


def export(outputs):
    lines = [line for name, raw in outputs for line in encoded_lines(name, raw)]
    if sum(len(line.encode())+1 for line in lines) + len(DONE)+1 > MAX_LOG_BYTES - 100_000:
        raise ValueError('batch exceeds log budget; use smaller batches')
    for line in lines:
        print(line, flush=True)
    print(DONE, flush=True)


def submit(action, job_id, payload):
    if not job_id.startswith('w3-papers-'):
        raise ValueError('own job IDs must start w3-papers-')
    if action not in ('scan', 'fetch'):
        raise ValueError('unsupported remote action')
    # Submit sequentially from one coordinator; never inspect or stop other jobs.
    active = [job for job in request()
              if str(job.get('submission_id', '')).startswith('w3-papers-')
              and job.get('status') in ('RUNNING', 'PENDING')]
    if len(active) >= 2:
        raise ValueError('two own CPU jobs already active; wait before submitting')
    source = Path(__file__).read_text()
    code = base64.b64encode(worker_source(source, required=('ECP_CORPUS_ROOT',)).encode()).decode()
    entry = 'import base64;exec(compile(base64.b64decode('+repr(code)+'),"papers-job","exec"))'
    return request(body=merge_private_env({'submission_id': job_id, 'entrypoint': 'python -c '+shlex.quote(entry),
        'entrypoint_num_cpus': 8 if action == 'scan' else 1, 'entrypoint_num_gpus': 0,
        'runtime_env': {'env_vars': {**{k: v for k, v in os.environ.items() if k.startswith('ECP_CORPUS_')}, 'PAPER_ACTION': action, 'PAPER_PAYLOAD': json.dumps(payload, ensure_ascii=False),
            'OPENBLAS_NUM_THREADS': '1', 'OMP_NUM_THREADS': '1'}}}))


def main():
    remote = os.environ.get('PAPER_ACTION')
    if remote:
        payload = json.loads(os.environ['PAPER_PAYLOAD'])
        (remote_scan if remote == 'scan' else remote_fetch)(payload)
        return
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('action', choices=['scan', 'select', 'fetch', 'status', 'receive', 'stop'])
    parser.add_argument('--id')
    parser.add_argument('--config', type=Path, default=CONFIG)
    parser.add_argument('--candidates', type=Path, default=Path('/tmp/corpus/papers/candidates.jsonl'))
    parser.add_argument('--screened', type=Path, default=Path('/tmp/corpus/papers/screened.jsonl'))
    parser.add_argument('--stats', type=Path, default=Path('/tmp/corpus/papers/selection-stats.json'))
    parser.add_argument('--offset', type=int, default=0)
    parser.add_argument('--batch-size', type=int, default=25)
    parser.add_argument('--dest', type=Path, default=Path('/tmp/corpus/papers'))
    a = parser.parse_args()
    if a.action == 'select':
        allowed = Path('/tmp/corpus/papers').resolve()
        if any(not path.resolve().is_relative_to(allowed) for path in (a.candidates, a.stats)):
            parser.error('selection output must stay under /tmp/corpus/papers')
        rows = [json.loads(line) for line in a.screened.read_text().splitlines() if line.strip()]
        selected, result = select_rows(rows, json.loads(a.config.read_text()))
        a.candidates.parent.mkdir(parents=True, exist_ok=True)
        a.stats.parent.mkdir(parents=True, exist_ok=True)
        a.candidates.write_text(''.join(json.dumps(row, ensure_ascii=False) + '\n' for row in selected))
        a.stats.write_text(json.dumps(result, ensure_ascii=False, indent=2) + '\n')
        print(json.dumps(result, ensure_ascii=False))
        return
    if not a.id or not a.id.startswith('w3-papers-'):
        parser.error('only own w3-papers- job IDs are allowed')
    if a.action == 'scan':
        result = submit('scan', a.id, json.loads(a.config.read_text()))
    elif a.action == 'fetch':
        if not 1 <= a.batch_size <= 50 or a.offset < 0:
            parser.error('batch size must be 1..50 and offset nonnegative')
        items = [json.loads(line) for line in a.candidates.read_text().splitlines() if line.strip()][a.offset:a.offset+a.batch_size]
        if not items:
            parser.error('empty batch')
        result = submit('fetch', a.id, items)
    elif a.action == 'receive':
        logs = request(a.id+'/logs')['logs']
        result = {'files': receive(logs, a.dest), 'logBytes': len(logs.encode())}
    else:
        result = request(a.id + ('/stop' if a.action == 'stop' else ''), {} if a.action == 'stop' else None)
        result = {k: result.get(k) for k in ('submission_id', 'status', 'message', 'driver_exit_code')}
    print(json.dumps(result, ensure_ascii=False))


if __name__ == '__main__':
    main()
