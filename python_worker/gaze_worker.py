"""Local JSONL iris geometry worker; explicit assets only, with no download path."""
import contextlib
import hashlib
import json
from pathlib import Path
import re
import sys

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
from ml.observe.gaze_geometry import GeometryExtractor, geometry_terms_vector


def model_sha256(path):
    checksum = hashlib.sha256()
    with Path(path).open('rb') as source:
        for chunk in iter(lambda: source.read(1024 * 1024), b''):
            checksum.update(chunk)
    return checksum.hexdigest()


def crop_size(path):
    from PIL import Image
    with Image.open(path) as image:
        return image.size


class GazeWorker:
    def __init__(self, extractor_factory=GeometryExtractor, image_size=crop_size):
        self.extractor_factory, self.image_size = extractor_factory, image_size
        self.extractor, self.identity, self.sha256 = None, None, None

    def close(self):
        if self.extractor is not None:
            self.extractor.close()
        self.extractor, self.identity, self.sha256 = None, None, None

    def handle(self, record):
        if not isinstance(record.get('filePath'), str) or not isinstance(record.get('modelPath'), str):
            raise ValueError('Explicit input and model paths required')
        if self.image_size(record['filePath']) != (384, 384):
            raise ValueError('Expected the exact 384 square face crop')
        path = Path(record['modelPath']).resolve()
        expected = record.get('modelSha256')
        if expected is not None and (not isinstance(expected, str) or not re.fullmatch('[0-9a-f]{64}', expected)):
            raise ValueError('Invalid model checksum')
        stat = path.stat()
        identity = (str(path), stat.st_size, stat.st_mtime_ns, expected)
        if self.identity != identity:
            self.close()
            actual = model_sha256(path)
            if expected is not None and actual != expected:
                raise ValueError('Model checksum mismatch')
            self.extractor = self.extractor_factory(path)
            self.identity, self.sha256 = identity, actual
        raw = self.extractor.extract(record['filePath'])
        features = geometry_terms_vector(raw).tolist() if raw is not None else None
        return {'id': record.get('id'), 'available': True, 'modelSha256': self.sha256, 'features': features}


def main():
    from memory_guard import start_memory_guard
    start_memory_guard()
    for stream in (sys.stdin, sys.stdout):
        if hasattr(stream, 'reconfigure'):
            stream.reconfigure(encoding='utf-8', errors='strict')
    worker = GazeWorker()
    try:
        for line in sys.stdin:
            if not line.strip():
                continue
            record = {}
            try:
                record = json.loads(line)
                if not isinstance(record, dict):
                    raise ValueError('Expected a JSON object')
                with contextlib.redirect_stdout(sys.stderr):
                    result = worker.handle(record)
            except Exception:
                result = {'id': record.get('id') if isinstance(record, dict) else None,
                          'available': False, 'error': {'code': 'inference_error'}}
            print(json.dumps(result, ensure_ascii=False, allow_nan=False), flush=True)
    finally:
        worker.close()


if __name__ == '__main__':
    main()
