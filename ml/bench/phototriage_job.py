#!/usr/bin/env python3
"""CPU-only official Photo Triage provenance probe; no images without verified terms."""
import sys as _private_sys
from pathlib import Path as _PrivatePath
if 'ml.common.private_env' not in _private_sys.modules:
    _private_sys.path.insert(0, str(_PrivatePath(__file__).resolve().parents[2]))
from ml.common.private_env import require_path
import os
import base64
import gzip
import hashlib
import json
import urllib.request
from datetime import datetime, timezone
from pathlib import Path

ROOT = Path(require_path('ECP_CEPH_ROOT') + '/bench/phototriage')
URLS = [
    'https://phototriage.cs.princeton.edu/',
    'http://phototriage.cs.princeton.edu/',
    'http://phototriage.cs.princeton.edu/download.html',
    'https://phototriage.cs.princeton.edu/download.html',
    'https://gfx.cs.princeton.edu/pubs/Chang_2016_ATF/index.php',
    'https://pixl.cs.princeton.edu/pubs/Chang_2016_ATF/index.php',
]


def main():
    ROOT.mkdir(parents=True, exist_ok=True)
    records = []
    for url in URLS:
        item = {'url': url}
        try:
            with urllib.request.urlopen(url, timeout=25) as response:
                raw = response.read(2 * 1024 * 1024)
                item.update(status=response.status, finalUrl=response.url,
                            sha256=hashlib.sha256(raw).hexdigest(), text=raw.decode('utf-8', errors='replace'))
        except Exception as error:
            item['error'] = str(error)
        records.append(item)
        print('PROBE ' + json.dumps(item, ensure_ascii=False), flush=True)
    evidence = {'checkedAt': datetime.now(timezone.utc).isoformat(), 'records': records,
                'imageDownloadAttempted': False, 'reason': 'Inspect official terms and split availability before downloading images.'}
    (ROOT / 'provenance-probe.json').write_text(json.dumps(evidence, ensure_ascii=False, indent=2))
    raw = json.dumps(evidence, ensure_ascii=False, indent=2).encode()
    parts = [raw[i:i + 16384] for i in range(0, len(raw), 16384)] or [b'']
    for index, chunk in enumerate(parts):
        print('W2_CHUNK ' + json.dumps({'path': 'provenance-probe.json', 'index': index,
              'count': len(parts), 'size': len(raw), 'sha256': hashlib.sha256(raw).hexdigest(),
              'chunk_sha256': hashlib.sha256(chunk).hexdigest(),
              'data': base64.b64encode(gzip.compress(chunk)).decode()}), flush=True)
    print('W2_TRANSFER_DONE', flush=True)
    print('PROBE_DONE', flush=True)


if __name__ == '__main__':
    main()
