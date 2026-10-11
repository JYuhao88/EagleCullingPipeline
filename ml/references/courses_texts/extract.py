#!/usr/bin/env python3
"""Text-only course extraction. Full text belongs on Ceph or private /tmp only."""
import sys as _private_sys
from pathlib import Path as _PrivatePath
if 'ml.common.private_env' not in _private_sys.modules:
    _private_sys.path.insert(0, str(_PrivatePath(__file__).resolve().parents[3]))
from ml.common.private_env import require_path
import os
import hashlib
import html
import json
from pathlib import Path, PurePosixPath
import re

SOURCE = 'materials-course-texts'
CEPH = require_path('ECP_CEPH_ROOT') + '/references'
COURSES = {
    'Magnum-The Art of Street Photography': 'magnum-street',
    'Annie Leibovitz-MasterClass': 'annie-leibovitz',
    'Lindsay Adler-The Posing Series': 'lindsay-adler',
    'Michele Celentano-家庭与群体摆姿': 'michele-celentano',
}
TIME = re.compile(r'(\d{1,3}):(\d{2}):(\d{2})[,.](\d{3})\s*-->\s*(\d{1,3}):(\d{2}):(\d{2})[,.](\d{3})')


def select(manifest):
    result = []
    counter = {}
    for f in sorted(manifest['files'], key=lambda f: f['remote_rel']):
        if f['source'] != SOURCE:
            continue
        p = PurePosixPath(f['remote_rel'])
        if p.is_absolute() or '..' in p.parts or '\\' in str(p) or p.suffix.lower() not in ('.srt', '.pdf'):
            raise ValueError('unsafe text path')
        names = [name for name in COURSES if name in p.parts]
        if len(names) != 1:
            raise ValueError('unknown course')
        slug = COURSES[names[0]]
        if type(f['size']) is not int or f['size'] <= 0 or not re.fullmatch('[0-9a-f]{64}', f['sha256']):
            raise ValueError('invalid input digest/size')
        original = re.match(r'^(\d+)', p.name)
        episode = int(original[1]) if original else 0
        if slug == 'michele-celentano':
            counter[slug] = counter.get(slug, 0) + 1
            episode = counter[slug]
        identity = slug + '-' + hashlib.sha256(str(p).encode()).hexdigest()[:12]
        result.append({k: f[k] for k in ('source', 'remote_rel', 'size', 'sha256')} | {
            'slug': slug, 'course': slug, 'episode': episode, 'bvid': identity,
            'originalEpisode': int(original[1]) if original else 0,
            'title': p.stem, 'format': p.suffix.lower()[1:],
            'topic': p.parent.name if slug == 'michele-celentano' else None,
        })
    if len({f['remote_rel'] for f in result}) != len(result):
        raise ValueError('duplicate destination')
    groups = {}
    for f in result:
        groups.setdefault((f['slug'], f['format'], f['sha256']), []).append(f)
    for group in groups.values():
        canonical = min(group, key=lambda f: ('(1)' in f['title'], f['remote_rel']))
        for f in group:
            if f is not canonical:
                f['duplicateOf'] = canonical['bvid']
    return result


def decode(raw):
    encodings = ('utf-16',) if raw.startswith((b'\xff\xfe', b'\xfe\xff')) else ('utf-8-sig', 'gb18030')
    for encoding in encodings:
        try:
            return raw.decode(encoding)
        except UnicodeError:
            pass
    raise ValueError('unknown subtitle encoding')


def parse_srt(raw):
    text = decode(raw).replace('\r\n', '\n').replace('\r', '\n')
    matches = list(TIME.finditer(text))
    if not matches:
        raise ValueError('subtitle has no timestamps')
    cues = []
    for i, match in enumerate(matches):
        nums = [int(v) for v in match.groups()]
        start = nums[0]*3600 + nums[1]*60 + nums[2] + nums[3]/1000
        end = nums[4]*3600 + nums[5]*60 + nums[6] + nums[7]/1000
        if any(v >= 60 for v in (nums[1], nums[2], nums[5], nums[6])) or not 0 <= start <= end:
            raise ValueError('invalid subtitle timestamp')
        body = text[match.end():matches[i+1].start() if i+1 < len(matches) else len(text)]
        body = re.sub(r'\n\s*\d+\s*$', '', body).strip()
        body = html.unescape(re.sub(r'<[^>]*>|\{\\[^}]*\}', '', body))
        body = re.sub(r'\s+', ' ', body).strip()
        if body:
            cues.append({'start': round(start, 3), 'end': round(end, 3), 'text': body})
    # Merge fragments up to punctuation, a 2s gap, or a 30s bound. No invented timings.
    fragments = []
    for cue in cues:
        # A cue may contain multiple sentences; each inherits its cue bounds.
        for fragment in re.findall(r'.+?(?:[。！？!?]+|\.(?=\s|$)|$)', cue['text']):
            if fragment.strip():
                fragments.append(dict(cue, text=fragment.strip()))
    sentences = []
    pending = None
    for cue in fragments:
        if pending and (cue['start'] - pending['end'] > 2 or cue['end'] - pending['start'] > 30):
            sentences.append(pending); pending = None
        if pending:
            sep = '' if re.search(r'[\u3400-\u9fff]$', pending['text']) and re.match(r'[\u3400-\u9fff]', cue['text']) else ' '
            pending = {'start': pending['start'], 'end': max(pending['end'], cue['end']), 'text': pending['text'] + sep + cue['text']}
        else:
            pending = dict(cue)
        if re.search(r'[.!?。！？][\"”’\']?$', pending['text']):
            sentences.append(pending); pending = None
    if pending:
        sentences.append(pending)
    return cues, sentences


def audited(root, f):
    raw_root = (Path(root) / SOURCE / 'raw').resolve()
    path = (raw_root / f['remote_rel']).resolve()
    if not path.is_relative_to(raw_root) or path.name.endswith('.part'):
        raise ValueError('unsafe input path')
    if not path.is_file() or path.stat().st_size != f['size']:
        raise ValueError('input missing/size mismatch: ' + f['bvid'])
    raw = path.read_bytes()
    if hashlib.sha256(raw).hexdigest() != f['sha256']:
        raise ValueError('input SHA256 mismatch: ' + f['bvid'])
    return raw


def extract(root, files):
    metadata = []
    for f in files:
        raw = audited(root, f)
        text_root = (Path(root) / SOURCE / 'text').resolve()
        dest = (text_root / f['slug']).resolve()
        if not dest.is_relative_to(text_root):
            raise ValueError('unsafe output path')
        dest.mkdir(parents=True, exist_ok=True)
        entry = dict(f, count_only=bool(f.get('duplicateOf')))
        if f['format'] == 'srt':
            cues, sentences = parse_srt(raw)
            data = {'cues': cues, 'sentences': sentences}
            entry.update(cues=len(cues), sentences=len(sentences), duration_seconds=max(c['end'] for c in cues),
                         zeroDurationCues=sum(c['start']==c['end'] for c in cues),
                         zeroDurationSentences=sum(c['start']==c['end'] for c in sentences))
        else:
            import io
            from pypdf import PdfReader
            reader = PdfReader(io.BytesIO(raw))
            pages = [{'page': i+1, 'text': page.extract_text() or ''} for i, page in enumerate(reader.pages)]
            data = {'pages': pages}
            entry.update(pages=len(pages), emptyPages=sum(not p['text'].strip() for p in pages), duration_seconds=0)
        output = dest / (f['bvid'] + '.json')
        encoded = json.dumps(data, ensure_ascii=False).encode()
        part = output.with_suffix('.json.part'); part.write_bytes(encoded); part.replace(output)
        entry.update(output=str(output.relative_to(text_root)), output_sha256=hashlib.sha256(encoded).hexdigest(), output_size=len(encoded))
        metadata.append(entry)
        print('TEXT_EXTRACTED ' + json.dumps({k: entry[k] for k in ('bvid', 'format', 'episode', 'slug')}, ensure_ascii=False), flush=True)
    manifest = {'source': SOURCE, 'videos': metadata, 'complete': True, 'parserVersion': 1}
    output = Path(root) / SOURCE / 'text' / (SOURCE + '-manifest.json')
    part = output.with_suffix('.json.part'); part.write_text(json.dumps(manifest, ensure_ascii=False, indent=2)); part.replace(output)
    return manifest
