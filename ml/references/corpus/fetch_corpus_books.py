#!/usr/bin/env python3
"""Fetch internal corpus books into /tmp/corpus/cbooks or cbooks2 only.

Selection JSON is a list (or {"books": [...]}) of provenance records, each with
slug, id, lang, file, row_group, row, channel, title and year. Remote paths stay
inside the CPU job; raw text is never written to the repository. Example:
  python ml/references/corpus/fetch_corpus_books.py scan --pattern 'portrait|composition'
  python ml/references/corpus/fetch_corpus_books.py fetch --selection /tmp/selected.json
  python ml/references/corpus/fetch_corpus_books.py receive --id JOB_ID
No local dependencies beyond the Python standard library; jobs need pyarrow.
"""
import sys as _private_sys
from pathlib import Path as _PrivatePath
if 'ml.common.private_env' not in _private_sys.modules:
    _private_sys.path.insert(0, str(_PrivatePath(__file__).resolve().parents[3]))
from ml.common.private_env import worker_source, setting, require_path, jobs_url, merge_private_env
import argparse
import base64
import gzip
import hashlib
import json
import os
from pathlib import Path
import re
import sys
import urllib.request

CORPUS_ROOT = require_path('ECP_CORPUS_ROOT')
OUTPUT_ROOT = Path('/tmp/corpus/cbooks')
OUTPUT_ROOTS = (OUTPUT_ROOT, Path('/tmp/corpus/cbooks2'))
DEFAULT_EXCLUDE = r'(?i)photoshop|gimp|lightroom|magazine|camera manual|camera guide|history|historical|encyclopedia|catalogue|catalog'


def request(path='', body=None):
    if body and 'entrypoint' in body:
        merge_private_env(body)
    opener = urllib.request.build_opener(urllib.request.ProxyHandler({}))
    req = urllib.request.Request(jobs_url() + path, data=None if body is None else json.dumps(body).encode(), headers={'Content-Type': 'application/json'})
    with opener.open(req, timeout=60) as response:
        return json.load(response)


def normalize_selection(selection):
    books = selection.get('books', []) if isinstance(selection, dict) else selection
    if not isinstance(books, list) or not books:
        raise ValueError('Selection must contain a nonempty books list')
    seen = set()
    for book in books:
        if not isinstance(book, dict):
            raise ValueError('Each selection must be an object')
        for key in ('slug', 'id', 'lang', 'file', 'row_group', 'row', 'channel', 'title'):
            if key not in book:
                raise ValueError('Missing selection field: ' + key)
        slug = book['slug']
        if not isinstance(slug, str) or not re.fullmatch(r'[a-zA-Z0-9_-]+', slug) or slug in seen:
            raise ValueError('Invalid or duplicate slug')
        seen.add(slug)
        if book['lang'] not in ('en', 'zh') or book['channel'] not in ('annas_other', 'libgen'):
            raise ValueError('Unsupported language/channel')
        if any(not isinstance(book[k], int) or book[k] < 0 for k in ('file', 'row_group', 'row')):
            raise ValueError('Source coordinates must be nonnegative integers')
    return books


def heading_title(lines, index):
    line = lines[index].strip()
    markdown = re.fullmatch(r'#{1,6}\s+(.+?)(?:\s+#+)?', line)
    if markdown:
        return markdown.group(1).strip()
    if not line or len(line) > 100:
        return None
    before = index == 0 or not lines[index - 1].strip()
    after = index + 1 == len(lines) or not lines[index + 1].strip()
    if index + 1 < len(lines) and re.fullmatch(r'\s*(?:={3,}|-{3,})\s*', lines[index + 1]):
        return line
    if not (before and after) or re.search(r'[.!?;]$', line):
        return None
    if re.match(r'(?i)^(chapter|part|section)\s+(?:\d+|[ivxlcdm]+|one|two|three|four|five|six|seven|eight|nine|ten)\b', line):
        return line
    words = re.findall(r"[A-Za-z][A-Za-z'-]*", line)
    if not words or len(words) > 12:
        return None
    if line.isupper() and len(words) >= 2:
        return line
    small = {'a', 'an', 'and', 'as', 'at', 'by', 'for', 'from', 'in', 'of', 'on', 'or', 'the', 'to', 'with'}
    if len(words) >= 2 and all(w[0].isupper() or w.lower() in small for w in words):
        return line
    return None


def split_chapters(text):
    """Conservative heading split; original lines remain unchanged in each part.

    line_start/line_end are inclusive, 1-based original text coordinates.
    Paragraph numbers are local to each chapter and count nonempty blocks.
    When no headings survive, return one Full text chapter rather than inventing
    semantic section titles. OCR titles can be fragmented: review toc manually.
    """
    if not isinstance(text, str) or not text.strip():
        raise ValueError('Book text is empty')
    lines = text.splitlines(keepends=True)
    starts = [(i, heading_title(lines, i)) for i in range(len(lines))]
    starts = [(i, title) for i, title in starts if title]
    if not starts:
        starts = [(0, 'Full text')]
    elif starts[0][0] > 0:
        starts.insert(0, (0, 'Front matter'))
    result = []
    for n, (start, title) in enumerate(starts):
        stop = starts[n + 1][0] if n + 1 < len(starts) else len(lines)
        body = ''.join(lines[start:stop])
        if body.strip():
            paragraphs = []
            block_start = None
            for j in range(start, stop):
                if lines[j].strip():
                    if block_start is None:
                        block_start = j
                elif block_start is not None:
                    paragraphs.append({'number': len(paragraphs) + 1, 'line_start': block_start + 1, 'line_end': j})
                    block_start = None
            if block_start is not None:
                paragraphs.append({'number': len(paragraphs) + 1, 'line_start': block_start + 1, 'line_end': stop})
            result.append({'title': title, 'text': body, 'line_start': start + 1, 'line_end': stop, 'paragraphs': paragraphs})
    return result


def write_book(record, output_dir=OUTPUT_ROOT):
    normalize_selection([record])
    root = Path(output_dir).resolve()
    if not any(root.is_relative_to(allowed.resolve()) for allowed in OUTPUT_ROOTS):
        raise ValueError('Raw book output must stay under /tmp/corpus/cbooks or /tmp/corpus/cbooks2')
    target = root / record['slug']
    chapter_dir = target / 'chapters'
    if target.is_symlink() or chapter_dir.is_symlink():
        raise ValueError('Output paths must not be symlinks')
    chapters = split_chapters(record['text'])
    chapter_dir.mkdir(parents=True, exist_ok=True)
    toc = {'slug': record['slug'], 'title': record['title'], 'format': 'corpus',
           'author': record.get('author', ''),
           'corpusRef': {k: record.get(k) for k in ('id', 'lang', 'channel', 'title', 'year')},
           'chapters': []}
    outputs = {target / 'book.txt': record['text']}
    for number, chapter in enumerate(chapters, 1):
        filename = f'chapters/{number:02d}.txt'
        outputs[target / filename] = chapter['text']
        toc['chapters'].append({'number': number, 'file': filename, **{k: v for k, v in chapter.items() if k != 'text'}})
    outputs[target / 'toc.json'] = json.dumps(toc, ensure_ascii=False, indent=2) + '\n'
    for path, content in outputs.items():
        if path.is_symlink() or not path.resolve().is_relative_to(root):
            raise ValueError('Unsafe output path')
    for path, content in outputs.items():
        path.write_text(content, encoding='utf-8')
    return target, toc


EXPORT_SOURCE = '''
def export_payload(payload):
    import base64, gzip, hashlib, json
    raw = json.dumps(payload, ensure_ascii=False).encode('utf-8')
    packed = gzip.compress(raw)
    encoded = base64.b64encode(packed).decode('ascii')
    chunks = [encoded[i:i+60000] for i in range(0, len(encoded), 60000)]
    for i, chunk in enumerate(chunks):
        print('CBOOKS_CHUNK ' + json.dumps({'index': i, 'data': chunk}), flush=True)
    print('CBOOKS_END ' + json.dumps({'chunks': len(chunks), 'sha256': hashlib.sha256(packed).hexdigest(), 'bytes': len(packed)}), flush=True)
'''


def decode_exports(logs):
    chunks, end = {}, None
    for line in logs.splitlines():
        if 'CBOOKS_CHUNK ' in line:
            item = json.loads(line.split('CBOOKS_CHUNK ', 1)[1])
            index = item['index']
            if index in chunks or not isinstance(index, int) or index < 0:
                raise ValueError('Duplicate or invalid export chunk')
            chunks[index] = item['data']
        elif 'CBOOKS_END ' in line:
            if end is not None:
                raise ValueError('Duplicate export end marker')
            end = json.loads(line.split('CBOOKS_END ', 1)[1])
    if end is None or set(chunks) != set(range(end['chunks'])):
        raise ValueError('Incomplete export: missing end marker or chunks')
    packed = base64.b64decode(''.join(chunks[i] for i in range(end['chunks'])), validate=True)
    if len(packed) != end['bytes'] or hashlib.sha256(packed).hexdigest() != end['sha256']:
        raise ValueError('Export checksum/size mismatch')
    return json.loads(gzip.decompress(packed).decode('utf-8'))


def receive(logs, output_dir=OUTPUT_ROOT):
    payload = decode_exports(logs)
    books = normalize_selection(payload)
    # Validate all book text before writing anything.
    for book in books:
        split_chapters(book['text'])
    return [write_book(book, output_dir) for book in books]


def build_scan_source(pattern, exclude_pattern=DEFAULT_EXCLUDE, workers=8, lang='en', min_chars=100000):
    if lang not in ('en', 'zh') or not 1 <= workers <= 8:
        raise ValueError('Invalid language/workers')
    # RE2 (pyarrow) accepts (?i), but intentionally does not support lookarounds.
    return '\n'.join([
        'import glob, json',
        'from concurrent.futures import ProcessPoolExecutor',
        'import pyarrow as pa, pyarrow.compute as pc, pyarrow.parquet as pq',
        f'PATTERN={json.dumps(pattern)}', f'EXCLUDE={json.dumps(exclude_pattern)}', f'MIN_CHARS={int(min_chars)}',
        f'LANG={json.dumps(lang)}', 'ROOT=require_path("ECP_CORPUS_ROOT")',
        f'INDEX_PATTERN={json.dumps(setting("ECP_CORPUS_INDEX_TEMPLATE", "index/{lang}/*.parquet"))}',
        '''def scan_file(path):
    table = pq.read_table(path, columns=['lang','file','row_group','row','id','title','doc_type','venue','publisher','year','channel','data_name','chars'])
    titles = pc.fill_null(table['title'], '')
    mask = pc.and_(pc.is_in(table['channel'], value_set=pa.array(['annas_other','libgen'])), pc.match_substring_regex(titles, PATTERN))
    mask = pc.and_(mask, pc.greater_equal(table['chars'], MIN_CHARS))
    if EXCLUDE:
        mask = pc.and_(mask, pc.invert(pc.match_substring_regex(titles, EXCLUDE)))
    return table.filter(pc.fill_null(mask, False)).to_pylist()
files = sorted(glob.glob(ROOT + '/' + INDEX_PATTERN.format(lang=LANG)))
if not files:
    raise RuntimeError('No provenance parquet files found')''',
        f'with ProcessPoolExecutor({workers}) as pool:',
        '    for rows in pool.map(scan_file, files):',
        "        for row in rows: print('CBOOKS_MATCH ' + json.dumps(row, ensure_ascii=False), flush=True)",
        "print('CBOOKS_SCAN_END', flush=True)",
    ])


def build_fetch_source(selection):
    books = [{k: v for k, v in book.items() if k != 'text'} for book in normalize_selection(selection)]
    return '\n'.join([
        'import glob, json', 'import pyarrow.parquet as pq',
        f'TEXT_PATTERN={json.dumps(setting("ECP_CORPUS_TEXT_TEMPLATE", "papers/{lang}/**/*.parquet"))}',
        'ROOT=require_path("ECP_CORPUS_ROOT")', f'SELECTION=json.loads({json.dumps(json.dumps(books, ensure_ascii=False))})',
        EXPORT_SOURCE,
        '''files_by_lang = {}
records = []
for book in SELECTION:
    lang = book['lang']
    if lang not in files_by_lang:
        files_by_lang[lang] = sorted(glob.glob(ROOT + '/' + TEXT_PATTERN.format(lang=lang), recursive=True))
    files = files_by_lang[lang]
    if book['file'] >= len(files):
        raise RuntimeError('Source file index out of range for ' + book['slug'])
    parquet = pq.ParquetFile(files[book['file']])
    group = book['row_group']
    table = parquet.read_row_group(group, columns=['id','text'])
    offset = sum(parquet.metadata.row_group(i).num_rows for i in range(group))
    candidates = [book['row'], book['row'] - offset]
    matched = []
    for row in dict.fromkeys(candidates):
        if 0 <= row < table.num_rows and str(table['id'][row].as_py()) == str(book['id']):
            matched.append(row)
    if len(matched) != 1:
        raise RuntimeError('ID validation failed or ambiguous for ' + book['slug'])
    text = table['text'][matched[0]].as_py()
    if not isinstance(text, str) or not text.strip():
        raise RuntimeError('Empty source text for ' + book['slug'])
    records.append(dict(book, text=text))
export_payload({'books': records})''',
    ])


def submit_source(source, job_id=None, cpus=1):
    encoded = base64.b64encode(worker_source(source, required=('ECP_CORPUS_ROOT',)).encode()).decode()
    body = {'entrypoint': 'python -c "import base64;exec(compile(base64.b64decode(\'' + encoded + '\'),\'cbooks_job\',\'exec\'))"',
            'entrypoint_num_cpus': cpus, 'entrypoint_num_gpus': 0,
            'runtime_env': {'env_vars': {'OMP_NUM_THREADS': '1', 'OPENBLAS_NUM_THREADS': '1'}}}
    if job_id:
        body['submission_id'] = job_id
    return request(body=merge_private_env(body))


def main(argv=None):
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('stage', choices=['scan', 'fetch', 'status', 'logs', 'receive'])
    parser.add_argument('--id')
    parser.add_argument('--selection', type=Path)
    parser.add_argument('--pattern', default=r'(?i)portrait|\bposing\b|composition|lighting|photographer.s vision|freeman|capturing light|understanding exposure|street photography|picture edit|photo edit|contact sheet|the camera|the negative')
    parser.add_argument('--exclude', default=DEFAULT_EXCLUDE)
    parser.add_argument('--workers', type=int, default=8)
    parser.add_argument('--min-chars', type=int, default=100000)
    parser.add_argument('--output-dir', type=Path, default=OUTPUT_ROOT)
    args = parser.parse_args(argv)
    if args.stage == 'scan':
        result = submit_source(build_scan_source(args.pattern, args.exclude, args.workers, min_chars=args.min_chars), args.id, args.workers)
    elif args.stage == 'fetch':
        if not args.selection:
            parser.error('--selection required')
        result = submit_source(build_fetch_source(json.loads(args.selection.read_text())), args.id)
    else:
        if not args.id:
            parser.error('--id required')
        if args.stage == 'status':
            status = request(args.id)
            result = {key: status.get(key) for key in ('submission_id', 'status', 'message', 'start_time', 'end_time', 'driver_exit_code')}
        else:
            logs = request(args.id + '/logs')['logs']
            if args.stage == 'logs':
                print(logs)
                return 0
            result = [{'output': str(path), 'chapters': len(toc['chapters'])} for path, toc in receive(logs, args.output_dir)]
    print(json.dumps(result, ensure_ascii=False, indent=2))
    return 0


if __name__ == '__main__':
    sys.exit(main())
