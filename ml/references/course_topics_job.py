#!/usr/bin/env python3
"""Self-contained CPU Ray job: ordered lecture topics, Ceph frames and QA.

Submit with submit.py segment --script course_topics_job.py (FFmpeg/Pillow).
REF_MANIFEST videos; REF_SOURCE course slug; REF_OUT Ceph course root.
Internal transcription and imagery must never be committed to the repository.
"""
from __future__ import annotations
import sys as _private_sys
from pathlib import Path as _PrivatePath
if 'ml.common.private_env' not in _private_sys.modules:
    _private_sys.path.insert(0, str(_PrivatePath(__file__).resolve().parents[2]))
from ml.common.private_env import require_path
import base64
import hashlib
import html
import io
import json
import math
import os
from pathlib import Path
import re
import subprocess
import time

CEPH = Path(require_path('ECP_CEPH_ROOT') + '/references')
TOPICS = {
    '姿势部位': ('姿势', '摆姿', '肢体', '肩膀', '肩线', '脖子', '颈部', '下巴', '腿', '脚', '胳膊', '身体角度', '转身', '侧身', '腰', '胸', '胯', '脊椎', '姿态', '重心'),
    '手位': ('手', '握拳', '指尖', '手指', '手掌'),
    '坐靠': ('坐', '靠', '蹲', '支撑', '重心'),
    '表情': ('表情', '笑', '嘴角', '嘴巴', '情绪', '自然度', '眨眼'),
    '视线': ('视线', '眼神', '看镜头', '目光', '看向', '眼睛'),
    '用光方向': ('光位', '侧光', '逆光', '顺光', '顶光', '底光', '主光', '辅光', '轮廓光', '灯位', '灯的位置', '光线方向', '阴影', '布光'),
    '光质': ('柔光', '硬光', '柔和', '光比', '清冷', '通透', '色温', '柔光箱', '反光板', '散射', '曝光', '光质'),
    '背景': ('背景', '环境', '前景'),
    '构图': ('构图', '画面', '留白', '比例', '景别', '焦段', '机位', '取景', '裁切'),
    '服装造型': ('衣服', '服装', '穿搭', '裙', '衣领', '西装', '外套', '礼服', '发型', '妆容', '风格'),
    '后期': ('后期', '修图', '调色', '磨皮', '液化', 'Photoshop', 'Lightroom', '蒙版'),
    '营销': ('营销', '客户', '收费', '价格', '接单', '获客', '销售', '推广', '商业模式'),
    '闲聊': ('大家好', '欢迎', '下节课', '谢谢', '点赞', '关注'),
    '观看评判': (),
    '画面边缘': (),
    '多重事件': (),
    '色彩': (),
    '瞬间': (),
    '选片编辑': (),
}

# English lecture retrieval hints, not evidence claims. Keep Chinese substring
# matching unchanged; English needs word boundaries ("light" != "delight").
ENGLISH_TOPICS = {
    '观看评判': ('looking at pictures', 'looking at photographs', 'read a photograph', 'reading photographs', 'visual relationships', 'observation', 'observing', 'seeing', 'perception'),
    '画面边缘': ('edge', 'edges', 'border', 'borders', 'corner', 'corners', 'outside the frame'),
    '多重事件': ('simultaneous', 'multiple events', 'multiple layers', 'layers', 'juxtaposition', 'juxtaposed', 'relationships', 'interplay'),
    '色彩': ('color', 'colors', 'colour', 'colours', 'red', 'blue', 'yellow', 'green', 'hue', 'hues', 'saturation'),
    '瞬间': ('moment', 'moments', 'timing', 'decisive moment', 'gesture', 'gestures', 'shutter', 'anticipate', 'anticipation'),
    '选片编辑': ('editing', 'edit', 'select', 'selection', 'selecting', 'choosing', 'choose', 'contact sheet', 'contact sheets', 'sequence', 'sequencing', 'outtakes', 'best frame'),
    '构图': ('composition', 'composing', 'frame', 'framing', 'crop', 'cropping', 'balance', 'geometry', 'diagonal', 'tilt'),
    '背景': ('background', 'foreground', 'environment'),
    '用光方向': ('light', 'lighting', 'shadow', 'shadows', 'backlight', 'backlighting', 'sunlight'),
    '光质': ('soft light', 'hard light', 'contrast', 'exposure'),
}
ENGLISH_PATTERNS = {
    tag: [re.compile(r'(?<![a-z0-9_])' + r'\s+'.join(re.escape(part) for part in word.split()) + r'(?![a-z0-9_])') for word in words]
    for tag, words in ENGLISH_TOPICS.items()
}


def sha256(path):
    digest = hashlib.sha256()
    with Path(path).open('rb') as stream:
        for chunk in iter(lambda: stream.read(8 * 1024 * 1024), b''):
            digest.update(chunk)
    return digest.hexdigest()


def atomic_bytes(path, data):
    path = Path(path)
    path.parent.mkdir(parents=True, exist_ok=True)
    temp = path.with_suffix(path.suffix + '.part')
    temp.write_bytes(data)
    temp.replace(path)


def atomic(path, value, lines=False):
    text = ''.join(json.dumps(row, ensure_ascii=False) + '\n' for row in value) if lines else json.dumps(value, ensure_ascii=False, indent=2) + '\n'
    atomic_bytes(path, text.encode('utf-8'))


def classify(text):
    scores = {tag: sum(text.count(word) for word in words) for tag, words in TOPICS.items()}
    normalized = text.casefold()
    for tag, patterns in ENGLISH_PATTERNS.items():
        scores[tag] += sum(len(pattern.findall(normalized)) for pattern in patterns)
    tags = [tag for tag, score in scores.items() if score]
    # Specific instruction takes priority over the generic body category.
    priority = ['选片编辑', '画面边缘', '多重事件', '观看评判', '瞬间', '色彩', '后期', '营销', '手位', '坐靠', '用光方向', '光质', '表情', '视线', '服装造型', '构图', '背景', '姿势部位', '闲聊']
    primary = max(priority, key=lambda tag: (scores[tag], -priority.index(tag))) if tags else None
    return primary, tags


def extract_topics(rows, max_gap=20, max_seconds=180):
    """Cover every sentence exactly once; unknown speech inherits local context.

    Topic changes split at sentence boundaries. Overlapping ASR utterances remain
    together, avoiding overlapping segments. A single long utterance is preserved.
    Labels are heuristic, not evidence claims, and require manual QA.
    """
    if max_gap < 0 or max_seconds <= 0:
        raise ValueError('invalid segmentation parameters')
    groups = []
    for index, row in enumerate(rows):
        if (not isinstance(row.get('text'), str) or not row['text'].strip()
                or not all(isinstance(row.get(key), (float, int)) and math.isfinite(row[key]) for key in ('start', 'end'))
                or not 0 <= row['start'] < row['end']):
            raise ValueError(f'invalid ASR sentence {index}')
        if index and row['start'] < rows[index-1]['start']:
            raise ValueError('ASR sentences must be ordered')
        primary, tags = classify(row['text'])
        current = groups[-1] if groups else None
        disjoint = current is not None and row['start'] >= current['end']
        split = current is None or (disjoint and (
            row['start'] - current['end'] > max_gap
            or row['end'] - current['start'] > max_seconds
            or (primary and primary != current['topic'])))
        if split:
            current = {'start': row['start'], 'end': row['end'], 'topic': primary or '闲聊', 'tags': [], 'sentences': []}
            groups.append(current)
        current['end'] = max(current['end'], row['end'])
        current['sentences'].append(dict(row, index=index))
        current['tags'] = [tag for tag in TOPICS if tag in set(current['tags'] + tags)] or [current['topic']]
    for index, group in enumerate(groups):
        group.update(segment=index+1, sentence_start=group['sentences'][0]['index'], sentence_end=group['sentences'][-1]['index'], sentence_range_convention='zero-based inclusive')
    return groups


def frame_times(start, end):
    return [round(start + (end-start)*f, 3) for f in ([0.5] if end-start < 20 else [0.15, 0.5, 0.85])]


def capture_frame(source, timestamp, target):
    import imageio_ffmpeg
    from PIL import Image
    command = [imageio_ffmpeg.get_ffmpeg_exe(), '-hide_banner', '-loglevel', 'error', '-threads', '1', '-ss', str(timestamp), '-i', str(source), '-frames:v', '1', '-vf', 'scale=w=640:h=640:force_original_aspect_ratio=decrease', '-threads', '1', '-f', 'image2pipe', '-vcodec', 'mjpeg', 'pipe:1']
    raw = subprocess.run(command, check=True, capture_output=True, timeout=120).stdout
    with Image.open(io.BytesIO(raw)) as image:
        image = image.convert('RGB')
        image.thumbnail((640, 640))
        output = io.BytesIO()
        image.save(output, format='JPEG', quality=70)
    atomic_bytes(target, output.getvalue())
    return {'path': str(target), 'time': timestamp, 'sha256': hashlib.sha256(output.getvalue()).hexdigest()}


def make_qa(root, video, segments):
    from PIL import Image, ImageDraw
    bvid = video['bvid']
    blocks = []
    cards = []
    for segment in segments:
        thumbs = []
        for frame in segment['frames']:
            data = Path(frame['path']).read_bytes()
            thumbs.append(f'<figure><img width="320" src="data:image/jpeg;base64,{base64.b64encode(data).decode()}"><figcaption>{frame["time"]:.3f}s</figcaption></figure>')
            with Image.open(io.BytesIO(data)) as image:
                card = Image.new('RGB', (320, 210), 'white')
                image.thumbnail((320, 180))
                card.paste(image, ((320-image.width)//2, 0))
                ImageDraw.Draw(card).text((4, 185), f'segment {segment["segment"]} | {frame["time"]:.3f}s', fill='black')
                cards.append(card)
        text = ' '.join(sentence['text'] for sentence in segment['sentences'])
        blocks.append(f'<section><h2>{segment["segment"]}: {segment["start"]:.3f}–{segment["end"]:.3f}s {html.escape(" / ".join(segment["tags"]))}</h2><div class="frames">{"".join(thumbs)}</div><p>{html.escape(text)}</p></section>')
    page = '<!doctype html><meta charset="utf-8"><title>课程主题 QA</title><style>body{font:16px sans-serif;margin:24px}section{border-top:1px solid #ccc}.frames{display:flex;flex-wrap:wrap}figure{margin:8px}p{line-height:1.8;max-width:1000px}</style>' + f'<h1>{html.escape(video["title"])}</h1><p>关键词启发式主题；截图按段内15/50/85%取样，短段取中点。必须人工核对姿势和光位。</p>' + ''.join(blocks)
    page_path = root/'qa'/f'{bvid}.html'
    atomic_bytes(page_path, page.encode('utf-8'))
    outputs = [{'path': str(page_path), 'sha256': sha256(page_path)}]
    for offset in range(0, len(cards), 18):
        batch = cards[offset:offset+18]
        sheet = Image.new('RGB', (960, 210*math.ceil(len(batch)/3)), 'white')
        for index, card in enumerate(batch):
            sheet.paste(card, ((index % 3)*320, (index//3)*210))
        buf = io.BytesIO()
        sheet.save(buf, 'JPEG', quality=72)
        path = root/'qa'/f'{bvid}-sheet-{offset//18+1:03d}.jpg'
        atomic_bytes(path, buf.getvalue())
        outputs.append({'path': str(path), 'sha256': sha256(path)})
    return outputs


def valid_cache(root, bvid, input_hash, code_hash, video_hash, parameters):
    try:
        stats = json.loads((root/'topics'/f'{bvid}.stats.json').read_text())
        if (stats.get('asr_input_sha256'), stats.get('code_sha256'), stats.get('video_sha256'), stats.get('parameters')) != (input_hash, code_hash, video_hash, parameters):
            return None
        topics = root/'topics'/f'{bvid}.jsonl'
        if stats['topics_sha256'] != sha256(topics):
            return None
        rows = [json.loads(line) for line in topics.read_text().splitlines() if line.strip()]
        artifacts = [frame for row in rows for frame in row['frames']] + stats['qa_artifacts']
        if not artifacts or any(not Path(item['path']).is_file() or sha256(item['path']) != item['sha256'] for item in artifacts):
            return None
        return stats
    except (OSError, ValueError, KeyError, TypeError):
        return None


def process_video(root, video, source, code_hash, parameters):
    bvid = video['bvid']
    if not bvid or Path(bvid).name != bvid or bvid in ('.', '..'):
        raise ValueError('unsafe episode identifier')
    path = Path(video['source_path'])
    if not path.resolve().is_relative_to(CEPH) or path.suffix == '.part':
        raise ValueError('video must be completed Ceph reference input')
    if path.stat().st_size != video['size']:
        raise ValueError('video size does not match upload manifest')
    video_hash = sha256(path)
    if video_hash != video['sha256']:
        raise ValueError('video SHA-256 does not match upload manifest')
    asr_path = root/'asr'/f'{bvid}.jsonl'
    input_hash = sha256(asr_path)
    cached = valid_cache(root, bvid, input_hash, code_hash, video_hash, parameters)
    if cached and os.environ.get('REF_FORCE') != '1':
        (root/'topics'/f'{bvid}.error.json').unlink(missing_ok=True)
        return dict(cached, cached=True)
    rows = [json.loads(line) for line in asr_path.read_text().splitlines() if line.strip()]
    if not rows:
        raise ValueError('empty ASR')
    if video.get('duration_seconds'):
        duration = float(video['duration_seconds'])
    else:
        asr_stats = json.loads((root/'asr'/f'{bvid}.stats.json').read_text())
        if asr_stats.get('source_sha256') != video_hash:
            raise ValueError('ASR duration source checksum mismatch')
        duration = float(asr_stats['duration'])
    if any(row['start'] >= duration or row['end'] > duration+2 for row in rows):
        raise ValueError('ASR timestamp exceeds manifest duration')
    segments = extract_topics(rows, **parameters)
    for segment in segments:
        segment.update(source=source, episode_id=bvid, episode=video['episode'], course=video.get('course'), title=video['title'])
        segment['frames'] = [capture_frame(path, timestamp, root/'frames'/bvid/f'{segment["segment"]:04d}-{index+1}.jpg') for index, timestamp in enumerate(frame_times(segment['start'], min(duration, segment['end'])))]
    qa = make_qa(root, video, segments)
    topics = root/'topics'/f'{bvid}.jsonl'
    atomic(topics, segments, lines=True)
    stats = {'episode_id': bvid, 'source': source, 'episode': video['episode'], 'duration': duration, 'sentences': len(rows), 'covered_sentences': len(rows), 'sentence_coverage': 1.0, 'topic_segments': len(segments), 'topic_seconds': sum(row['end']-row['start'] for row in segments), 'topics': {tag: sum(row['topic']==tag for row in segments) for tag in TOPICS}, 'tags': {tag: sum(tag in row['tags'] for row in segments) for tag in TOPICS}, 'frames': sum(len(row['frames']) for row in segments), 'asr_input_sha256': input_hash, 'video_sha256': video_hash, 'code_sha256': code_hash, 'topics_sha256': sha256(topics), 'qa_artifacts': qa, 'parameters': parameters, 'error': None}
    atomic(root/'topics'/f'{bvid}.stats.json', stats)
    (root/'topics'/f'{bvid}.error.json').unlink(missing_ok=True)
    return stats


def main():
    root = Path(os.environ['REF_OUT'])
    if not root.resolve().is_relative_to(CEPH):
        raise ValueError('REF_OUT must remain in Ceph references')
    source = os.environ['REF_SOURCE']
    manifest = json.loads(os.environ['REF_MANIFEST'])
    code_hash = os.environ.get('REF_CODE_SHA256')
    if not code_hash:
        raise ValueError('REF_CODE_SHA256 required for verified caching')
    parameters = {'max_gap': float(os.environ.get('REF_MAX_GAP', '20')), 'max_seconds': float(os.environ.get('REF_MAX_SECONDS', '180'))}
    results = []
    boot = time.monotonic()
    for video in manifest['videos']:
        started = time.monotonic()
        bvid = video['bvid']
        try:
            stats = process_video(root, video, source, code_hash, parameters)
        except Exception as error:
            stats = {'episode_id': bvid, 'error': str(error)}
            if Path(bvid).name == bvid and bvid not in ('.', '..'):
                atomic(root/'topics'/f'{bvid}.error.json', stats)
        stats['seconds'] = round(time.monotonic()-started, 3)
        results.append(stats)
        print('COURSE_TOPICS', json.dumps(stats, ensure_ascii=False), flush=True)
    report = {'videos': len(results), 'results': results, 'failed': [row for row in results if row.get('error')], 'seconds': round(time.monotonic()-boot, 3), 'resource': {'num_gpus': 0, 'num_cpus': 1}, 'method': 'ordered nonoverlapping keyword topics; every sentence once; representative frame sampling requires human QA', 'parameters': parameters}
    atomic(root/'topics'/'run-report.json', report)
    print('SUMMARY', json.dumps({key: value for key, value in report.items() if key != 'results'}, ensure_ascii=False), flush=True)
    if report['failed']:
        raise SystemExit(1)


if __name__ == '__main__':
    main()
