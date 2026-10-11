#!/usr/bin/env python3
"""Copy ONNX weights from ceph (or a supplied HF/local source) and verify SHA-256."""
from __future__ import annotations
import sys as _private_sys
from pathlib import Path as _PrivatePath
if 'ml.common.private_env' not in _private_sys.modules:
    _private_sys.path.insert(0, str(_PrivatePath(__file__).resolve().parents[2]))
from ml.common.private_env import require_path
import os
import argparse
import hashlib
import json
import re
import shutil
from pathlib import Path
ROOT = Path(__file__).resolve().parents[2] / 'models' / 'scorer'
CEPH = Path(require_path('ECP_CEPH_ROOT') + '/models/onnx')
EXPECTED = 'bc1f59ca097afadb7c9343fa370d0fe47b0cfe5e21b623957f597a6f2bea08eb'
EXPECTED_DATA = '0ab4e4c4da5eb6461357379178e96b06ebfc11105a02c0854598d56b910b2582'
IAA_MANIFEST = Path(__file__).with_name('topiq_iaa_512.manifest.json')

def sha256(path: Path) -> str:
    digest = hashlib.sha256()
    with path.open('rb') as stream:
        for block in iter(lambda: stream.read(1024 * 1024), b''):
            digest.update(block)
    return digest.hexdigest()

def ensure_file(source: Path, target: Path, expected: str, label: str) -> str:
    """Validate an existing destination before copying; never follow-copy through a symlink."""
    if target.exists():
        digest = sha256(target)
        if digest == expected:
            return digest
        if target.is_symlink():
            raise RuntimeError(f'{label} 目标符号链接已存在但 sha256 不匹配: {digest} != {expected}')
        raise RuntimeError(f'{label} 目标已存在但 sha256 不匹配: {digest} != {expected}')
    if target.is_symlink():
        raise RuntimeError(f'{label} 目标是悬空符号链接，不覆盖: {target}')
    source_digest = sha256(source)
    if source_digest != expected:
        raise RuntimeError(f'{label} source sha256 mismatch: {source_digest} != {expected}')
    shutil.copy2(source, target)
    digest = sha256(target)
    if digest != expected:
        raise RuntimeError(f'{label} sha256 mismatch: {digest} != {expected}')
    return digest

def expected_files(model: str) -> dict[str, str]:
    if model == 'topiq-nr-onnx':
        return {'topiq_nr_512.onnx': EXPECTED, 'topiq_nr_512.onnx.data': EXPECTED_DATA}
    # Only the checked-in manifest is trusted, never a manifest at --source.
    files = json.loads(IAA_MANIFEST.read_text())['files']
    if isinstance(files, list):
        entries = [(entry['name'], entry['sha256']) for entry in files]
    elif isinstance(files, dict):
        entries = [(name, value['sha256'] if isinstance(value, dict) else value)
                   for name, value in files.items()]
    else:
        raise ValueError('IAA manifest files 必须是列表或对象')
    expected = {}
    for name, digest in entries:
        if name not in {'topiq_iaa_512.onnx', 'topiq_iaa_512.onnx.data'}:
            raise ValueError(f'IAA manifest 包含未知文件: {name}')
        if name in expected or not isinstance(digest, str) or not re.fullmatch(r'[0-9a-f]{64}', digest):
            raise ValueError(f'IAA manifest 无效哈希或重复文件: {name}')
        expected[name] = digest
    if 'topiq_iaa_512.onnx' not in expected:
        raise ValueError('IAA manifest 缺少 topiq_iaa_512.onnx')
    return expected

def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument('--model', choices=['topiq-nr-onnx', 'topiq-iaa-onnx'], default='topiq-nr-onnx')
    parser.add_argument('--source', type=Path, default=CEPH)
    parser.add_argument('--target', type=Path, default=ROOT, help='Destination models/scorer directory')
    args = parser.parse_args()
    args.target.mkdir(parents=True, exist_ok=True)
    files = expected_files(args.model)
    results = {}
    for name, digest in files.items():
        target = args.target / name
        verified = ensure_file(args.source / name, target, digest, name)
        results[name] = {'sha256': verified, 'bytes': target.stat().st_size}
    model_name = 'topiq_nr_512.onnx' if args.model == 'topiq-nr-onnx' else 'topiq_iaa_512.onnx'
    report = {'path': str(args.target / model_name), **results[model_name], 'files': results}
    if model_name + '.data' in results:
        report['external_data_sha256'] = results[model_name + '.data']['sha256']
        report['external_data_bytes'] = results[model_name + '.data']['bytes']
    print(json.dumps(report))

if __name__ == '__main__':
    main()
