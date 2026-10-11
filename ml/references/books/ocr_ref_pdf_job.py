#!/usr/bin/env python3
"""Reference-books variant of ocr_pdf_job.py (adds --force-ocr).

Extract text from Chinese PDF books, using the text layer or local OCR.

The module is intentionally self contained so it can be copied into a Ray
worker.  OCR is imported lazily (``rapidocr`` + PyMuPDF).
Outputs are restricted to ``/tmp/w4-refbooks`` or the configured Ceph reference
tree and contain only derived text, never the input PDF.
"""
import sys as _private_sys
from pathlib import Path as _PrivatePath
if 'ml.common.private_env' not in _private_sys.modules:
    _private_sys.path.insert(0, str(_PrivatePath(__file__).resolve().parents[3]))
from ml.common.private_env import require_path
import argparse
import hashlib
import importlib
import json
import multiprocessing
import os
import re
import sys
from pathlib import Path

CEPH_ROOT = Path(require_path('ECP_CEPH_ROOT') + '/references/reference-books/text')
LOCAL_ROOT = Path("/tmp/w4-refbooks")
POSE_LOCAL_ROOT = Path("/tmp/w4-posebooks")
POSE_CEPH_ROOT = CEPH_ROOT.parents[1] / "materials-books" / "text"


class OCRBookError(ValueError):
    pass


def _safe_slug(slug):
    if not slug or not re.fullmatch(r"[A-Za-z0-9_\-\u4e00-\u9fff]+", slug):
        raise OCRBookError("slug must contain only letters, numbers, CJK, _ or -")
    return slug


def _safe_output(path):
    for candidate in [path, *path.parents]:
        if candidate.is_symlink():
            # macOS /tmp is an OS alias, not an application output symlink.
            if str(candidate) != '/tmp':
                raise OCRBookError("output paths must not contain symlinks")
    return path


def _destination(output_dir, slug):
    root = Path(output_dir).expanduser().absolute()
    dest = _safe_output(root / _safe_slug(slug)).resolve()
    if not any(dest.is_relative_to(r.resolve()) for r in (LOCAL_ROOT, CEPH_ROOT, POSE_LOCAL_ROOT, POSE_CEPH_ROOT)):
        raise OCRBookError("output-dir is restricted to reference/pose book temporary roots or Ceph text roots")
    return dest


def _parse_pages(value, total=None):
    if value is None:
        return None
    out = set()
    for part in str(value).split(","):
        if "-" in part:
            a, b = part.split("-", 1)
            out.update(range(int(a), int(b) + 1))
        else:
            out.add(int(part))
    if not out:
        raise OCRBookError("page selection is empty")
    if any(p < 1 or (total and p > total) for p in out):
        raise OCRBookError("pages must be positive and within the PDF")
    return out


def _text_layer_pages(source):
    try:
        pypdf = importlib.import_module("pypdf")
    except ImportError:
        try:
            pdfplumber = importlib.import_module("pdfplumber")
        except ImportError as exc:
            raise OCRBookError("install pypdf or pdfplumber for PDF text extraction") from exc
        with pdfplumber.open(str(source)) as pdf:
            return [p.extract_text() or "" for p in pdf.pages], (pdf.metadata or {}), len(pdf.pages)
    reader = pypdf.PdfReader(str(source))
    if reader.is_encrypted and not reader.decrypt(""):
        raise OCRBookError("PDF is encrypted")
    return [p.extract_text() or "" for p in reader.pages], (reader.metadata or {}), len(reader.pages)


def _metadata_text(metadata, *keys):
    for key in keys:
        value = metadata.get(key)
        if isinstance(value, str): return value
        if isinstance(value, bytes):
            try: return value.decode('utf-16') if value.startswith((b'\xfe\xff',b'\xff\xfe')) else value.decode('utf-8')
            except UnicodeError: continue
    return ''


def _ocr_engine():
    try:
        fitz = importlib.import_module("fitz")
        rapid = importlib.import_module("rapidocr")
    except ImportError as exc:
        raise OCRBookError("OCR requires PyMuPDF, rapidocr==3.10.0 and onnxruntime") from exc
    use_cuda = os.environ.get('REFBOOK_USE_CUDA') == '1'
    if use_cuda:
        ort = importlib.import_module('onnxruntime')
        ort.preload_dlls(directory='')
    engine = rapid.RapidOCR(params={
        'EngineConfig.onnxruntime.use_cuda':use_cuda,
        'EngineConfig.onnxruntime.intra_op_num_threads': 2,
        'EngineConfig.onnxruntime.inter_op_num_threads': 1,
        'Det.limit_type': 'max', 'Det.limit_side_len': 1600, 'Global.max_side_len': 3000})
    def call(image):
        result = engine(image)
        if result.boxes is None:
            return [], None
        return list(zip(result.boxes, result.txts, result.scores)), None
    return fitz, call


def _digest(source):
    h = hashlib.sha256()
    with source.open('rb') as stream:
        for block in iter(lambda: stream.read(8 * 1024 * 1024), b''):
            h.update(block)
    return h.hexdigest()


def _usable_layer(text, sparse=False):
    # Sparse page numbers/captions must not hide an underlying scanned page.
    chars = [c for c in text if c.isalnum()]
    return (any(c.isalpha() for c in text) if sparse else len(chars) >= 40) and '\ufffd' not in text and '\x00' not in text


def _bookmarks(source):
    try:
        fitz = importlib.import_module('fitz')
    except ImportError:
        return {}, set()
    with fitz.open(str(source)) as pdf:
        result = {}; toc_pages = set()
        for level, title, page in pdf.get_toc():
            if 1 <= page <= len(pdf): result.setdefault(page, title)
        # Converted electronic books often have only one bookmark but a linked TOC.
        for i in range(min(30, len(pdf))):
            page = pdf[i]
            links = [link for link in page.get_links() if link.get('kind') == 1 and link.get('page', -1) > i]
            if len(links) < 5: continue
            toc_pages.add(i + 1)
            for link in links:
                title = re.sub(r'\s+', ' ', page.get_textbox(link['from'] + (-1,-1,1,1))).strip()
                if 1 < len(title) <= 100 and not title.isdigit():
                    result.setdefault(link['page'] + 1, title)
        return result, toc_pages


def _ordered_ocr(result, width):
    """Return OCR text and confidence; split obvious two-column pages first."""
    items = []
    for row in (result or []):
        try:
            box, text, conf = row[0], str(row[1]), float(row[2])
        except (IndexError, TypeError, ValueError):
            continue
        xs = [float(p[0]) for p in box]
        ys = [float(p[1]) for p in box]
        items.append((min(xs), min(ys), max(xs), max(ys), text, conf))
    if not items:
        return "", None, False
    centers = sorted((a + b) / 2 for a, _, b, _, _, _ in items)
    gap = max((b - a for a, b in zip(centers, centers[1:])), default=0)
    split = gap > width * 0.18 and len(items) >= 4
    if split:
        pivot = centers[next(i for i, (a, b) in enumerate(zip(centers, centers[1:])) if b - a == gap)]
        cols = [sorted((x for x in items if (x[0] + x[2]) / 2 <= pivot), key=lambda z: (z[1], z[0])),
                sorted((x for x in items if (x[0] + x[2]) / 2 > pivot), key=lambda z: (z[1], z[0]))]
        ordered = cols[0] + cols[1]
    else:
        ordered = sorted(items, key=lambda z: (z[1], z[0]))
    return "\n".join(x[4] for x in ordered), sum(x[5] for x in ordered) / len(ordered), split


def _heading(line):
    line = re.sub(r"\s+", " ", line).strip()
    return bool(re.match(r"^(第\s*[一二三四五六七八九十百\d]+\s*[章节篇讲].{0,40}|[一二三四五六七八九十\d]+[、.]\s*[^。]{2,30})$", line))


def _init_ocr_worker(source):
    # Never inherit or share a live PyMuPDF document / ONNX session.
    global _worker_source, _worker_pdf, _worker_fitz, _worker_engine
    _worker_source = source
    _worker_pdf = _worker_fitz = _worker_engine = None


def _worker_ocr_page(number):
    global _worker_pdf, _worker_fitz, _worker_engine
    if _worker_pdf is None:
        # Lazy creation propagates initialization failures through the task
        # result rather than causing Pool initializer restart loops.
        _worker_fitz, _worker_engine = _ocr_engine()
        _worker_pdf = _worker_fitz.open(_worker_source)
    pix = _worker_pdf[number - 1].get_pixmap(matrix=_worker_fitz.Matrix(2, 2), alpha=False)
    result, _ = _worker_engine(pix.tobytes('png'))
    return number, _ordered_ocr(result, pix.width)


def extract_pdf(source, slug, output_dir=LOCAL_ROOT, pages=None, resume=True, ocr=None, workers=1, force_ocr=False, text_layer_first=False):
    if isinstance(workers, bool) or not isinstance(workers, int) or not 1 <= workers <= 8:
        raise OCRBookError('workers must be an integer from 1 to 8')
    if os.environ.get('REFBOOK_USE_CUDA') == '1': workers = 1
    if workers > 1 and ocr is not None:
        raise OCRBookError('injected OCR requires workers=1')
    source = Path(source).expanduser().resolve()
    if not source.is_file() or source.suffix.lower() != '.pdf':
        raise OCRBookError('source must be an existing PDF')
    dest = _destination(output_dir, slug)
    dest.mkdir(parents=True, exist_ok=True)
    chapter_dir = _safe_output(dest / 'chapters')
    page_dir = _safe_output(dest / '.pages')
    chapter_dir.mkdir(exist_ok=True); page_dir.mkdir(exist_ok=True)
    layer, metadata, total = _text_layer_pages(source)
    selected = _parse_pages(pages, total)
    wanted = set(range(1, total + 1)) if selected is None else selected
    fingerprint = {'source_sha256': _digest(source), 'extractor': 'refbooks-v2', 'force_ocr': force_ocr,
                   'ocr': 'rapidocr-3.10.0', 'scale': 2, 'min_layer_chars': 40, 'det_limit_side_len':1600}
    if text_layer_first:
        fingerprint['text_layer_policy'] = 'sparse-valid-or-raster-v1'
        fitz = importlib.import_module('fitz')
        with fitz.open(str(source)) as scan:
            raster = {i + 1 for i, page in enumerate(scan) if page.get_images()}
    else:
        raster = set(range(1, total + 1))
    usable_pages = {n for n in wanted if not force_ocr and _usable_layer(layer[n - 1], sparse=text_layer_first)}
    ocr_pages = {n for n in wanted if force_ocr or (n not in usable_pages and n in raster)}
    bookmarks, toc_pages = _bookmarks(source)
    quality = []; page_text = {}; pdf = None; pool = None
    cached = {}; pending_ocr = []
    # Check caches before dispatch. Only missing scanned pages enter the pool;
    # all cache writes and output ordering remain in the parent process.
    for number in sorted(wanted):
        cache = _safe_output(page_dir / f'{number:04d}.json')
        if resume and cache.is_file():
            item = json.loads(cache.read_text(encoding='utf-8'))
            previous = item.get('fingerprint', {})
            # Reuse earlier audited pages only when the new OCR decision agrees.
            compatible = previous == fingerprint or (text_layer_first and
                previous == {k: v for k, v in fingerprint.items() if k != 'text_layer_policy'})
            if compatible and item['quality']['ocr_used'] == (number in ocr_pages):
                item['fingerprint'] = fingerprint
                cached[number] = item
                cache.write_text(json.dumps(item, ensure_ascii=False), encoding='utf-8')
        if number not in cached and number in ocr_pages:
            pending_ocr.append(number)
    try:
        if workers > 1 and pending_ocr:
            pool = multiprocessing.get_context('fork').Pool(
                processes=min(workers, len(pending_ocr)), initializer=_init_ocr_worker,
                initargs=(str(source),))
            parallel_results = iter(pool.imap(_worker_ocr_page, pending_ocr, chunksize=1))
        for number in sorted(wanted):
            cache = _safe_output(page_dir / f'{number:04d}.json')
            if number in cached:
                item = cached[number]
                page_text[number] = item['text']; quality.append(item['quality']); continue
            text = layer[number - 1]
            usable = number in usable_pages
            q = {'page': number, 'text_layer': bool(text.strip()), 'usable_text_layer': usable,
                 'ocr_used': False, 'confidence': None, 'empty': False, 'suspected_columns': False}
            if number in ocr_pages:
                if pool is not None:
                    result_number, (recognized, conf, columns) = next(parallel_results)
                    if result_number != number: raise OCRBookError('OCR worker page order mismatch')
                else:
                    if pdf is None:
                        if ocr is None: fitz, ocr = _ocr_engine()
                        else: fitz = importlib.import_module('fitz')
                        pdf = fitz.open(str(source))
                    pix = pdf[number - 1].get_pixmap(matrix=fitz.Matrix(2, 2), alpha=False)
                    result, _ = ocr(pix.tobytes('png'))
                    recognized, conf, columns = _ordered_ocr(result, pix.width)
                # Preserve sparse text when OCR sees no content; mark that fallback.
                text = recognized or text
                q.update(ocr_used=True, confidence=conf, suspected_columns=columns,
                         sparse_layer_fallback=not bool(recognized) and bool(text.strip()))
            text = text.strip(); q.update(empty=not bool(text), chars=len(text))
            value = f'[p.{number}]\n{text}' if text else f'[p.{number}]'
            page_text[number] = value; quality.append(q)
            if number % 10 == 0:
                print('REFBOOK_PROGRESS ' + json.dumps({'slug':slug, 'page':number, 'selected':len(wanted), 'ocr_used':q['ocr_used']}), flush=True)
            cache.write_text(json.dumps({'text': value, 'quality': q, 'fingerprint': fingerprint},
                                        ensure_ascii=False), encoding='utf-8')
    except BaseException:
        if pool is not None: pool.terminate()
        raise
    finally:
        if pool is not None:
            pool.close(); pool.join()
        if pdf is not None: pdf.close()
    groups = []; current = None
    for number in sorted(page_text):
        value = page_text[number]
        # Only the opening lines can be chapter titles, not prose mid-page.
        title = bookmarks.get(number) or (None if number in toc_pages else next((ln for ln in value.splitlines()[1:5] if _heading(ln)), None))
        if current and (title or number != current['pages'][-1] + 1):
            groups.append(current); current = None
        if current is None:
            current = {'title': title or f'Pages {number}', 'pages': []}
        current['pages'].append(number)
    if current: groups.append(current)
    toc_chapters = []
    for idx, group in enumerate(groups, 1):
        filename = f'{idx:02d}.txt'
        _safe_output(chapter_dir / filename).write_text(
            '\n\n'.join(page_text[p] for p in group['pages']) + '\n', encoding='utf-8')
        toc_chapters.append({'number': idx, 'title': group['title'], 'file': f'chapters/{filename}',
                             'page': group['pages'][0], 'pages': group['pages']})
    # Remove obsolete derived chapter files after a different pilot/full split.
    keep = {Path(c['file']).name for c in toc_chapters}
    for old in chapter_dir.glob('*.txt'):
        _safe_output(old)
        if old.name not in keep: old.unlink()
    toc = {'slug': slug, 'title': _metadata_text(metadata, '/Title', 'Title') or source.stem,
           'author': _metadata_text(metadata, '/Author', 'Author'), 'format': 'pdf-ocr',
           'chapters': toc_chapters, 'pages': total, 'selected_pages': sorted(wanted),
           'complete': len(page_text) == total, **fingerprint,
           'chapter_method': 'bookmarks-and-opening-headings' if bookmarks else 'opening-headings',
           'quality_warning': 'OCR confidence is not character accuracy; manually inspect columns and captions'}
    _safe_output(dest / 'toc.json').write_text(json.dumps(toc, ensure_ascii=False, indent=2) + '\n', encoding='utf-8')
    _safe_output(dest / 'quality.json').write_text(json.dumps({'complete': toc['complete'],
        'source_sha256': fingerprint['source_sha256'], 'pages': quality}, ensure_ascii=False, indent=2) + '\n', encoding='utf-8')
    return dest, toc, quality


def main(argv=None):
    ap = argparse.ArgumentParser(description=__doc__); ap.add_argument("source"); ap.add_argument("--slug", required=True); ap.add_argument("--output-dir", default=str(LOCAL_ROOT)); ap.add_argument("--pages"); ap.add_argument("--no-resume", action="store_true")
    ap.add_argument('--workers', type=int, default=1, help='CPU OCR processes, 1-8 (GPU always uses 1)')
    ap.add_argument('--force-ocr', action='store_true', help='Ignore a corrupt text layer and invalidate prior caches')
    args = ap.parse_args(argv)
    try:
        dest, toc, quality = extract_pdf(args.source, args.slug, args.output_dir, args.pages, not args.no_resume, workers=args.workers, force_ocr=args.force_ocr)
    except (OCRBookError, OSError, ValueError) as exc:
        print(f"OCR extraction failed: {exc}", file=sys.stderr); return 1
    print(json.dumps({"output": str(dest), "title": toc["title"], "chapters": len(toc["chapters"]), "pages": len(quality)}, ensure_ascii=False)); return 0


if __name__ == "__main__": sys.exit(main())
