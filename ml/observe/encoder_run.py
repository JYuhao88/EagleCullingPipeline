"""Run extraction and frozen observation gates inside the same one-GPU Ray job."""
import contextlib
import hashlib
import json
from pathlib import Path
import re
import tempfile
from types import SimpleNamespace

from ml.observe.encoder_ray import encoder_artifact, encoder_report, relative_path, run
from ml.observe.train_heads import run as train_heads


def train_precision(model, precision, features):
    features = Path(features)
    root = features.parent
    metadata = json.loads((features / 'oi.json').read_text())
    report = root / ('training-' + precision + '.json')
    head = root / ('head-' + precision + '.json')
    args = SimpleNamespace(encoder_id=model['id'], encoder_dimensions=model['dimensions'],
                           model_sha256=metadata['modelSha256'], oi_labels='oi/labels.jsonl',
                           oi_features=str(features / 'oi.npz'), holdout_items='panel/items.jsonl',
                           panel_labels='panel/labels.jsonl', p0_labels='p0/labels.jsonl',
                           p0_features=str(features / 'p0.npz'), holdout_features=str(features / 'panel.npz'),
                           p0_node=None, holdout_node=None, report=str(report), head=str(head),
                           version=model['id'] + '-face-' + precision + '-v1')
    train_heads(args)
    encoder_artifact(report, model['id'] + '/' + report.name)
    if head.exists():
        encoder_artifact(head, model['id'] + '/' + head.name)
    encoder_report({'stage': 'training-complete', 'encoder': model['id'], 'precision': precision,
                    'attributes': {key: {'passed': value['passed'], 'gates': value['gates']}
                                   for key, value in json.loads(report.read_text())['attributes'].items()}})


def train_candidates(config):
    output = Path(config.get('output', 'output'))
    for model in config['models']:
        for precision in ('fp32', 'fp16'):
            train_precision(model, precision, output / model['id'] / precision)


def materialize_inputs(config, source, destination):
    hashes = config.get('inputSha256')
    if not isinstance(hashes, dict) or not hashes:
        raise ValueError('inputSha256 must be a nonempty file hash map')
    files = []
    for name, expected in hashes.items():
        relative = relative_path(name, 'inputSha256 path')
        if not isinstance(expected, str) or not re.fullmatch(r'[0-9a-f]{64}', expected):
            raise ValueError('inputSha256 values must be lowercase SHA-256')
        files.append((name, relative, expected))
    source, destination = Path(source), Path(destination)
    for name, relative, expected in files:
        target = destination / relative
        target.parent.mkdir(parents=True, exist_ok=True)
        checksum = hashlib.sha256()
        # Ray may link packaged files to a content store.  Accept their bytes
        # only after checking the packager's hash, then use ordinary local files.
        try:
            with (source / relative).open('rb') as incoming, target.open('xb') as outgoing:
                for chunk in iter(lambda: incoming.read(1024 * 1024), b''):
                    checksum.update(chunk)
                    outgoing.write(chunk)
            if checksum.hexdigest() != expected:
                raise ValueError('input checksum mismatch: ' + name)
        except BaseException:
            target.unlink(missing_ok=True)
            raise


def main():
    source = Path.cwd()
    config = json.loads((source / 'encoder-config.json').read_text())
    with tempfile.TemporaryDirectory(prefix='observe-encoder-inputs-') as folder:
        materialize_inputs(config, source, folder)
        encoder_report({'stage': 'materialized', 'files': len(config['inputSha256']), 'hashesVerified': True,
                        'externalManifests': [item['name'] for item in config.get('sources', [])
                            if source.resolve() not in (source / item['manifest']).resolve().parents]})
        with contextlib.chdir(folder):
            run(config, on_precision_complete=train_precision if config.get('train', False) else None)


if __name__ == '__main__':
    main()
