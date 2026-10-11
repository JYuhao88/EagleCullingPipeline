#!/usr/bin/env python3
"""Ray CPU scene/photo segmentation, with read-only DASH input and atomic checkpoints.

REF_MANIFEST is manifest JSON. REF_OUT points at yidao. REF_CONCURRENCY defaults
16, max 30 (leaves room for a concurrent ASR driver within 64 CPUs). REF_SAMPLE_FPS defaults 1.
REF_FORCE=1 invalidates completion checkpoints. REF_EXPORT=1 logs pilot JPGs.
No ASR or GPU dependencies; pip: imageio-ffmpeg pillow numpy opencv-python-headless.
Photo/compare/other labels are visual heuristics, not semantic recognition.
"""
from __future__ import annotations

import sys as _private_sys
from pathlib import Path as _PrivatePath
if 'ml.common.private_env' not in _private_sys.modules:
    _private_sys.path.insert(0, str(_PrivatePath(__file__).resolve().parents[2]))
from ml.common.private_env import require_path
import base64
import json
import os
import re
import statistics
import time
from pathlib import Path

VERSION = 'scene-phash-sift@5'
DEFAULT_OUT = require_path('ECP_CEPH_ROOT') + '/references/yidao'


def atomic_json(path, data):
    path = Path(path)
    temp = path.with_name(path.name + '.part')
    temp.write_text(json.dumps(data, ensure_ascii=False, indent=1), encoding='utf-8')
    os.replace(temp, path)


def use_host_negatives(layout, intro_motion):
    """Wulin keeps a fixed sidebar over changing photos; it is not a host scene."""
    return layout != "wulin" and bool(intro_motion) and statistics.median(intro_motion) > 3


def phash(gray):
    import cv2
    import numpy as np
    dct = cv2.dct(cv2.resize(gray, (32, 32)).astype(np.float32))[:8, :8]
    bits = dct > np.median(dct.ravel()[1:])
    return int(''.join('1' if bit else '0' for bit in bits.ravel()), 2)


def editor_tab(rgb):
    """Fingerprint the selected dark-editor document tab, excluding zoom text.

    A stable selected-document title is useful when a 480P face becomes an
    extreme eye crop with too few corresponding image keypoints.
    """
    import cv2
    import numpy as np
    h, w = rgb.shape[:2]
    logo = rgb[:max(4, int(h*.021)), :max(5, int(w*.016))].astype(float)
    if int(((logo[:,:,2]-logo[:,:,0] > 20) & (logo[:,:,1]-logo[:,:,0] > 5)).sum()) < 3: return None
    gray = cv2.cvtColor(rgb, cv2.COLOR_RGB2GRAY)
    x0 = int(w*.01)
    band = gray[int(h*.037):int(h*.05), x0:int(w*.84)]
    if band.size == 0: return None
    profile = np.quantile(band, .2, axis=0).astype(np.float32)
    profile = cv2.blur(profile[None, :], (5, 1))[0]
    base = float(np.median(profile))
    if not 30 < base < 100 or float((np.abs(profile-base) < 3).mean()) < .65: return None
    mask = (profile > base+8).astype(np.uint8)[None, :]
    _, _, stats, _ = cv2.connectedComponentsWithStats(mask, 8)
    runs = [(int(x), int(width)) for x, _, width, _, _ in stats[1:] if w*.029 < width < w*.23]
    if not runs: return None
    x, width = max(runs, key=lambda r:r[1])
    # Quantization prevents compression noise from shifting the title by a pixel.
    anchor = round(x/8)*8+x0+1
    prefix = gray[int(h*.037):int(h*.05), anchor:anchor+max(12, int(w*.024))]
    if prefix.std() < 8: return None
    return {'anchor': anchor/w, 'prefix': cv2.resize(prefix, (80, 24)).astype(np.float32)}


def same_editor_tab(a, b):
    import numpy as np
    ta, tb = a.get('editor_tab'), b.get('editor_tab')
    if ta is None or tb is None or abs(ta['anchor']-tb['anchor']) > .006: return False
    aa, bb = ta['prefix'], tb['prefix']
    return float(np.abs(aa-bb).mean()) < 4.5 and float(np.corrcoef(aa.ravel(), bb.ravel())[0,1]) > .975



def layout_config():
    layout = os.environ.get('REF_LAYOUT', 'yidao')
    if layout not in ('yidao', 'wulin'): raise ValueError('unknown REF_LAYOUT')
    width = int(os.environ.get('REF_DECODE_WIDTH', '854' if layout == 'wulin' else '0'))
    if width < 0 or (width and width < 320): raise ValueError('decode width must be zero or >=320')
    return {'layout': layout, 'identity_version': 'wulin-central-sift@1' if layout == 'wulin' else 'yidao-v5', 'crop': (.02, .98, .03, .97) if layout == 'wulin' else (.04, .84, .05, .78),
            'decode_width': width, 'video_name': os.environ.get('REF_VIDEO_NAME', 'video.m4s')}


def features(rgb):
    import cv2
    import numpy as np
    # Pilot layouts put captions/host at the bottom and a fixed sidebar at right.
    h, w = rgb.shape[:2]
    x0, x1, y0, y1 = layout_config()['crop']
    crop = rgb[int(h*y0):int(h*y1), int(w*x0):int(w*x1)]
    small = cv2.resize(crop, (320, 180))
    gray = cv2.cvtColor(small, cv2.COLOR_RGB2GRAY)
    hist = cv2.calcHist([small], [0, 1, 2], None, [8, 8, 8], [0, 256]*3)
    cv2.normalize(hist, hist)
    sharp = float(cv2.Laplacian(gray, cv2.CV_32F).var())
    edges = float((cv2.Canny(gray, 70, 150) > 0).mean())
    detail_gray = cv2.cvtColor(cv2.resize(crop, (640, 360)), cv2.COLOR_RGB2GRAY)
    return {'gray': gray, 'detail_gray': detail_gray, 'hash': phash(gray), 'hist': hist, 'sharp': sharp,
            'edges': edges, 'std': float(gray.std()), 'editor_tab': editor_tab(rgb),
            'canvas_fraction': float(((small.max(axis=2).astype(float)-small.min(axis=2)) < 5).mean())}


def visual_distance(a, b):
    import cv2
    import numpy as np
    difference = cv2.absdiff(a['gray'], b['gray'])
    # Average tile changes tolerate cursor movement and a small speaker overlay.
    tiles = difference.reshape(6, 30, 8, 40).mean(axis=(1, 3))
    return ((a['hash'] ^ b['hash']).bit_count(), float(np.quantile(tiles, .75)),
            float(cv2.compareHist(a['hist'], b['hist'], cv2.HISTCMP_BHATTACHARYYA)))


def same_photo(a, b, negative=False, geometry=None):
    """Require tight global similarity or geometrically consistent local matches."""
    import cv2
    import numpy as np
    if not negative and same_editor_tab(a, b):
        if geometry is not None: geometry['editor'] = True
        return True
    hd, diff, hist = visual_distance(a, b)
    if hd <= 6 and hist <= .16 and diff <= 10:
        return True
    # Feature homography allows zooms/crops; stringent inlier and spatial spread
    # protect against merging unrelated photographs of the same face/background.
    sift = cv2.SIFT_create(nfeatures=600)
    kp_key = 'negative_keypoints' if negative else 'keypoints'
    ds_key = 'negative_descriptors' if negative else 'descriptors'
    for f in (a, b):
        if ds_key not in f:
            # Central image area: avoid matching the same sidebar/menu across
            # different photos, which otherwise yields a false homography.
            mask = np.zeros(f['detail_gray'].shape, dtype=np.uint8)
            mask[44:340, 150:495] = 255
            f[kp_key], f[ds_key] = sift.detectAndCompute(f['detail_gray'], None if negative else mask)
    if a[ds_key] is None or b[ds_key] is None:
        return False
    matches = cv2.BFMatcher().knnMatch(a[ds_key], b[ds_key], k=2)
    good = [pair[0] for pair in matches if len(pair) == 2 and pair[0].distance < .65*pair[1].distance]
    if len(good) < (12 if negative else 10):
        return False
    x = np.float32([a[kp_key][m.queryIdx].pt for m in good])
    y = np.float32([b[kp_key][m.trainIdx].pt for m in good])
    matrix, mask = cv2.findHomography(x, y, cv2.RANSAC, 5.)
    if matrix is None or mask is None or float(mask.mean()) < (.65 if negative else .78):
        return False
    mask = mask.ravel().astype(bool)
    if mask.sum() < (10 if negative else 8):
        return False
    spread = [float(cv2.contourArea(cv2.convexHull(p[mask]))) / (640*360) for p in (x, y)]
    matched = min(spread) > (.015 if negative else .004) and max(spread) > (.04 if negative else .055)
    if matched and geometry is not None:
        geometry['scale'] = float(np.sqrt(abs(np.linalg.det(matrix[:2, :2]))))
    return matched


def classify(scene, fps):
    import numpy as np
    f = scene['feature']
    motion = float(np.median(scene['motion'])) if scene['motion'] else 0.
    duration = scene['end'] - scene['start']
    # Reject dense motion and low-detail cards. A static speaker/title image
    # can still be misclassified and therefore requires contact-sheet QA.
    if duration < 3/fps or motion > 3 or f['std'] < 16 or f['edges'] < .012:
        return 'other'
    center_content = f['gray'][22:170, 75:275]
    if float((center_content < 20).mean()) > .82:
        return 'other'
    # Bright file-list/browser panes (pilot end-of-stream desktop), not photos.
    if float((center_content > 220).mean()) > .55 and center_content.mean() > 190:
        return 'other'
    # Compare heuristics: a low-detail separator between detailed panels.
    gray = f['gray']
    center = gray[:, 154:166]
    left, right = gray[:, 35:145], gray[:, 175:285]
    if center.std() < 9 and left.std() > 24 and right.std() > 24:
        return 'compare'
    return 'photo'


def segment_one(video, out, fps=1., force=False, export=False):
    import cv2
    import imageio_ffmpeg
    import numpy as np
    from PIL import Image
    cv2.setNumThreads(1)
    started = time.time()
    bvid = video['bvid']
    if not re.fullmatch(r'BV[0-9A-Za-z]+', bvid):
        raise ValueError('invalid bvid')
    config = layout_config()
    out = Path(out)
    segment_path = out/'segments'/f'{bvid}.json'
    stats_path = out/'segments'/f'{bvid}.stats.json'
    frame_dir = out/'frames'/bvid
    frame_dir.mkdir(parents=True, exist_ok=True)
    segment_path.parent.mkdir(parents=True, exist_ok=True)
    if not force and segment_path.exists() and stats_path.exists():
        stats = json.loads(stats_path.read_text())
        rows = json.loads(segment_path.read_text())
        if (stats.get('version') == VERSION and stats.get('sample_fps') == fps and
                stats.get('layout', 'yidao') == config['layout'] and
                stats.get('identity_version', 'yidao-v5') == config['identity_version'] and
                stats.get('video_name', 'video.m4s') == config['video_name'] and
                stats.get('decode_width', 0) == config['decode_width'] and
                stats.get('status') == 'complete' and rows and
                (config['layout'] != 'wulin' or stats.get('host_negative_templates', 0) == 0) and
                all((out/r['frame']).is_file() for r in rows)):
            return dict(stats, skipped=True)
    raw = out/'raw'/bvid/config['video_name']
    deadline = time.monotonic() + float(os.environ.get('REF_WAIT_INPUT_SECONDS', '0'))
    while not raw.is_file() and time.monotonic() < deadline:
        time.sleep(5)
    filters = f"scale={config['decode_width']}:-2,fps={fps}" if config['decode_width'] else f'fps={fps}'
    decoder = imageio_ffmpeg.read_frames(str(raw), pix_fmt='rgb24',
        input_params=['-threads', '1'], output_params=['-vf', filters, '-threads', '1'])
    metadata = next(decoder)
    w, h = metadata['size']
    scenes, current, previous = [], None, None
    intro_motion = []
    samples = 0
    try:
        for payload in decoder:
            rgb = np.frombuffer(payload, dtype=np.uint8).reshape(h, w, 3)
            f = features(rgb)
            t = samples/fps
            distance = visual_distance(previous, f) if previous is not None else (0, 0, 0)
            # A substantial global change is a cut. Dense motion frames become
            # short scenes and are excluded after adjacent duplicate consolidation.
            if 0 < t < 6:
                intro_motion.append(distance[1])
            cut = previous is not None and ((distance[0] > 9 and distance[1] > 6) or
                                            (distance[2] > .30 and distance[1] > 18))
            if cut and current is not None:
                current['end'] = t
                scenes.append(current)
                current = None
            if current is None:
                current = {'start': t, 'end': t+1/fps, 'feature': f, 'rgb': rgb.copy(),
                           'motion': [], 'frame_time': t, 'samples': 0}
            current['samples'] += 1
            current['motion'].append(distance[1] if not cut else 0.)
            # Prefer sharp representatives; don't let one cursor/video transition
            # dominate selection (bounded sharpness gain).
            if f['sharp'] > current['feature']['sharp']*1.15 and distance[1] < 10:
                current.update(feature=f, rgb=rgb.copy(), frame_time=t)
            current['end'] = t + 1/fps
            previous = f
            samples += 1
        if current is not None:
            scenes.append(current)
    finally:
        decoder.close()
    if not samples:
        raise RuntimeError('no decoded video frames')
    duration = float(metadata.get('duration') or video.get('duration') or samples/fps)
    duration = min(duration, samples/fps)
    scenes[-1]['end'] = duration
    # Merge consecutive zoom/pan/crop views only if features establish identity.
    merged = []
    for scene in scenes:
        geometry = {}
        if merged and same_photo(merged[-1]['feature'], scene['feature'], geometry=geometry):
            previous_scene = merged[-1]
            previous_scene['end'] = scene['end']
            previous_scene['motion'] += scene['motion']
            previous_scene['samples'] += scene['samples']
            # Local match quantity usually favors the wider, more complete view.
            old = previous_scene['feature']
            old_detail = len(old.get('keypoints', [])) or old['edges']*400
            new = scene['feature']
            new_detail = len(new.get('keypoints', [])) or new['edges']*400
            scale = geometry.get('scale', 1.)
            prefer_new = ((scale < .85 and new['sharp'] > old['sharp']*.35) or (.85 <= scale <= 1.15 and new['sharp'] > old['sharp']*1.15))
            if geometry.get('editor'):
                prefer_new = new['canvas_fraction'] > old['canvas_fraction']+.05 or (abs(new['canvas_fraction']-old['canvas_fraction']) < .05 and new['edges'] > old['edges']*1.15)
            if prefer_new:
                previous_scene.update(feature=new, rgb=scene['rgb'], frame_time=scene['frame_time'])
        else:
            merged.append(scene)
    # Brief dialog/cursor/loading flashes do not create a new photo interval.
    # Keep the actual visible-photo intervals alongside the continuous span.
    bridged = []
    for scene in merged:
        if (len(bridged) >= 2 and bridged[-1]['end']-bridged[-1]['start'] <= 6/fps
                and classify(bridged[-1], fps) == 'other'
                and classify(bridged[-2], fps) != 'other'
                and same_photo(bridged[-2]['feature'], scene['feature'])):
            bridged.pop()
            anchor = bridged[-1]
            anchor['intervals'] = anchor.get('intervals', [{'start':anchor['start'],'end':anchor['end']}]) + scene.get('intervals', [{'start':scene['start'],'end':scene['end']}])
            anchor['end'] = scene['end']
            anchor['motion'] += scene['motion']
            anchor['samples'] += scene['samples']
        else:
            bridged.append(scene)
    merged = bridged
    # A moving opening shot supplies negative exemplars of the host's room.
    # Videos opening on static submitted photos do not create negatives.
    negatives = [s['feature'] for s in scenes if s['start'] < 30] if use_host_negatives(config['layout'], intro_motion) else []
    # Join same-photo returns through multiple short non-photo UI scenes.
    # Actual intervening photo/compare scenes always retain independent times.
    for scene in merged:
        scene['kind'] = classify(scene, fps)
        if scene['kind'] != 'other' and any(same_photo(anchor, scene['feature'], negative=True) for anchor in negatives):
            scene['kind'] = 'other'
    compact = []
    for scene in merged:
        if scene['kind'] != 'other':
            anchor_index = len(compact)-1
            while anchor_index >= 0 and compact[anchor_index]['kind'] == 'other':
                anchor_index -= 1
            geometry = {}
            if (anchor_index >= 0 and scene['start']-compact[anchor_index]['end'] <= 6/fps
                    and same_photo(compact[anchor_index]['feature'], scene['feature'], geometry=geometry)):
                anchor = compact[anchor_index]
                anchor['intervals'] = anchor.get('intervals', [{'start':anchor['start'],'end':anchor['end']}]) + scene.get('intervals', [{'start':scene['start'],'end':scene['end']}])
                anchor['end'] = scene['end']
                if geometry.get('scale',1) < .85:
                    anchor.update(feature=scene['feature'], rgb=scene['rgb'], frame_time=scene['frame_time'])
                compact = compact[:anchor_index+1]
                continue
        compact.append(scene)
    merged = compact
    rows, identities = [], []
    for index, scene in enumerate(merged):
        kind = scene['kind']
        identity = None
        if kind != 'other':
            # Repeated photos remain separate time intervals, linked by photo_id.
            for k, candidate in reversed(list(enumerate(identities))[-12:]):
                if same_photo(candidate, scene['feature']):
                    identity = k
                    break
            if identity is None:
                identity = len(identities)
                identities.append(scene['feature'])
        relative = f'frames/{bvid}/{index:04d}.jpg'
        dest = out/relative
        temp = dest.with_name(dest.name+'.part')
        Image.fromarray(scene['rgb']).save(temp, format='JPEG', quality=94)
        os.replace(temp, dest)
        rows.append({'index': index, 'start': round(scene['start'], 3),
                     'end': round(scene['end'], 3), 'frame': relative,
                     'phash': f"{scene['feature']['hash']:016x}", 'kind': kind,
                     'photo_id': f'{bvid}:photo:{identity:04d}' if identity is not None else None,
                     'frame_time': round(scene['frame_time'], 3),
                     'motion_score': round(float(np.median(scene['motion'])), 3),
                     **({'intervals': scene['intervals']} if 'intervals' in scene else {})})
    photo_rows = [r for r in rows if r['kind'] != 'other']
    stats = {'bvid': bvid, 'status': 'complete', 'code_sha256': os.environ.get('REF_CODE_SHA256'), 'version': VERSION, 'sample_fps': fps, **config,
             'duration': duration, 'decoded_samples': samples, 'raw_scene_count': len(scenes),
             'segment_count': len(rows), 'photo_segments': len(photo_rows),
             'unique_photo_ids': len(identities), 'host_negative_templates': len(negatives), 'compare_segments': sum(r['kind']=='compare' for r in rows),
             'other_segments': len(rows)-len(photo_rows),
             'coverage': sum(sum(i['end']-i['start'] for i in r.get('intervals', [r])) for r in photo_rows)/duration,
             'aligned_span_coverage': sum(r['end']-r['start'] for r in photo_rows)/duration,
             'seconds': round(time.time()-started, 2),
             'resource': {'num_cpus': 2, 'num_gpus': 0, 'ffmpeg_threads': 1},
             'known_limits': ['Heuristic labels require manual contact-sheet review.',
                              'One-second sampling misses subsecond cuts.',
                              'Repeated-photo linkage checks the last 12 distinct photos.',
                              'Frame completeness uses feature detail, not semantic crop detection.',
                              'Bright-window heuristic can reject extremely high-key photos.',
                              'Editor tab fingerprint can confuse titles with an identical visible prefix.',
                              'Host exclusion is disabled for Wulin fixed-sidebar layouts; Yidao needs a moving opening shot.']}
    atomic_json(segment_path, rows)
    atomic_json(stats_path, stats)
    if export:
        stats = dict(stats, export_paths=[r['frame'] for r in rows[::max(1, len(rows)//12)][:12]])
    return stats


def main():
    import ray
    from datetime import datetime, timezone
    run_start = time.time()
    started_at = datetime.now(timezone.utc).isoformat()
    os.environ.setdefault('OMP_NUM_THREADS', '1')
    out = os.environ.get('REF_OUT', DEFAULT_OUT)
    manifest = json.loads(os.environ['REF_MANIFEST'])
    concurrency = max(1, min(30, int(os.environ.get('REF_CONCURRENCY', '16'))))
    fps = float(os.environ.get('REF_SAMPLE_FPS', '1'))
    if not .2 <= fps <= 4:
        raise ValueError('REF_SAMPLE_FPS must be between .2 and 4')
    ray.init(address='auto')
    worker = ray.remote(num_cpus=2, max_retries=0)(segment_one)
    pending, results = {}, []
    videos = iter(manifest['videos'])
    def replenish():
        while len(pending) < concurrency:
            video = next(videos, None)
            if video is None:
                return
            ref = worker.remote(video, out, fps, os.environ.get('REF_FORCE')=='1', os.environ.get('REF_EXPORT')=='1')
            pending[ref] = video['bvid']
    replenish()
    while pending:
        ready, _ = ray.wait(list(pending), num_returns=1)
        for ref in ready:
            bvid = pending.pop(ref)
            try:
                result = ray.get(ref)
                for relative in result.pop('export_paths', []):
                    print('EXPORT '+json.dumps({'path': relative, 'data': base64.b64encode((Path(out)/relative).read_bytes()).decode()}), flush=True)
            except Exception as error:
                result = {'bvid': bvid, 'status': 'failed', 'error': str(error)[-2000:]}
            results.append(result)
            print('DONE '+json.dumps(result, ensure_ascii=False), flush=True)
        replenish()
    atomic_json(Path(out)/'segments'/'run-report.json', {'version': VERSION, 'started_at': started_at,
        'ended_at': datetime.now(timezone.utc).isoformat(), 'seconds': round(time.time()-run_start,2),
        'concurrency': concurrency, 'worker_cpus': 2, 'worker_gpus': 0, 'driver_cpus': 1,
        'cpu_cap': concurrency*2+1, 'videos': results})
    failures = [r for r in results if r['status']=='failed']
    print('SUMMARY '+json.dumps({'total': len(results), 'failed': len(failures), 'failures': failures}), flush=True)
    if failures:
        raise RuntimeError(f'{len(failures)} segmentation failures')


if __name__ == '__main__':
    main()
