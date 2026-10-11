import json, os, sys
from pathlib import Path
from PIL import Image
from pillow_heif import register_heif_opener
from PIL import ImageFile
ImageFile.LOAD_TRUNCATED_IMAGES = False

register_heif_opener()
root = Path(__file__).resolve().parents[1]
library = Path(os.environ['EAGLE_LIBRARY_PATH'])
report = Path(os.environ.get('HEIC_REPORT', str(root / 'data/clean-thumbnail-1791510830038.json')))
out = root / 'data' / 'heic-decoded'; out.mkdir(parents=True, exist_ok=True)
data = json.loads(report.read_text(encoding='utf-8'))
items = [x for x in data['results'] if x.get('status') == 'failed' and x.get('ext') == 'heic']
done = failed = 0
for item in items:
    info = library / 'images' / f"{item['id']}.info"
    srcs = list(info.glob('*.heic'))
    if not srcs:
        failed += 1; continue
    try:
        with Image.open(srcs[0]) as image:
            image.thumbnail((1600, 1600), Image.Resampling.LANCZOS)
            image.convert('RGB').save(out / f"{item['id']}.png", 'PNG', optimize=True)
        done += 1
    except Exception as exc:
        print(f"FAILED {item['id']}: {exc}", file=sys.stderr); failed += 1
print(json.dumps({'requested': len(items), 'decoded': done, 'failed': failed}))
