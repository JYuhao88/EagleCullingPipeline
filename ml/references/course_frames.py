#!/usr/bin/env python3
"""Subtitle contrast windows and audited CPU frame extraction.

Raw text and images must stay in Ceph or /tmp/w4-frames-qa. Heuristic scenes
are review candidates; only explicit subtitle-and-visual decisions become pairs.
Codex decisions still require user visual QA before downstream acceptance.
"""
import sys as _private_sys
from pathlib import Path as _PrivatePath
if 'ml.common.private_env' not in _private_sys.modules:
    _private_sys.path.insert(0, str(_PrivatePath(__file__).resolve().parents[2]))
from ml.common.private_env import require_path
import os
import hashlib
import json
import math
from pathlib import Path, PurePosixPath
import re
import subprocess

CEPH = require_path('ECP_CEPH_ROOT') + '/references'
COURSES = {'Lindsay Adler-The Posing Series': 'lindsay-adler',
           'Michele Celentano-家庭与群体摆姿': 'michele-celentano'}
CONTRAST = re.compile(r"\b(?:don['’]t|avoid|instead|better|difference|before\s+and\s+after|before[- /]after|wrong|fix)\b|不要|避免|而是|更好|前后|对比|区别|调整|不好", re.I)
STRONG = re.compile(r'before.{0,15}after|difference between|see.{0,20}difference|problem pose|fix.{0,20}(?:pose|shoulder|hand)|前后对比|两.{0,5}(?:区别|对比)|纠正|解决.{0,8}问题', re.I)
POSE = re.compile(r'hand|finger|wrist|elbow|arm|shoulder|chin|neck|head|pose|posing|posture|body|feet|foot|knee|eye|face|group|triangle|level|overlap|手|肘|肩|下巴|脖|头|姿势|身体|脚|膝|眼|脸|群体|三角|层次|遮挡', re.I)


def safe_path(root, relative):
    p = PurePosixPath(relative)
    if p.is_absolute() or '..' in p.parts or '\\' in relative or p.name.endswith('.part'):
        raise ValueError('unsafe path')
    target = (Path(root)/relative).resolve()
    if not target.is_relative_to(Path(root).resolve()):
        raise ValueError('path outside root')
    return target


def select_videos(manifest):
    rows = []
    for f in sorted(manifest['files'], key=lambda x: x['remote_rel']):
        if f['source'] != 'materials-courses':
            continue
        parts = PurePosixPath(f['remote_rel']).parts
        names = [n for n in COURSES if n in parts]
        if not names:
            continue
        safe_path('/tmp/w4-frames-qa', f['remote_rel'])
        if len(names) != 1 or PurePosixPath(f['remote_rel']).suffix.lower() not in ('.mp4', '.mov', '.mkv'):
            raise ValueError('invalid video')
        if type(f['size']) is not int or f['size'] <= 0 or not re.fullmatch('[0-9a-f]{64}', f['sha256']):
            raise ValueError('invalid integrity metadata')
        rows.append({k:f[k] for k in ('source','remote_rel','size','sha256')} | {'slug':COURSES[names[0]]})
    if len({f['remote_rel'] for f in rows}) != len(rows):
        raise ValueError('duplicate video')
    return rows


def audit(root, video):
    p = safe_path(Path(root)/'materials-courses/raw', video['remote_rel'])
    if not p.is_file() or p.stat().st_size != video['size']:
        raise ValueError('missing or size mismatch')
    before = p.stat()
    digest = hashlib.sha256()
    with p.open('rb') as handle:
        for chunk in iter(lambda:handle.read(8*1024*1024), b''):
            digest.update(chunk)
    after = p.stat()
    if (before.st_size, before.st_mtime_ns) != (after.st_size, after.st_mtime_ns) or digest.hexdigest() != video['sha256']:
        raise ValueError('SHA256 mismatch or changing input')
    return p


def windows(sentences, padding=18, max_span=90):
    """Merge nearby contrast hits; no positivity or rule inference from keywords."""
    if padding < 0 or max_span <= 0:
        raise ValueError('invalid window limits')
    found = []
    for i, row in enumerate(sentences):
        if not 0 <= row['start'] <= row['end'] or not all(math.isfinite(row[k]) for k in ('start','end')):
            raise ValueError('invalid timestamp')
        text = row['text']
        if not CONTRAST.search(text) or not POSE.search(text):
            continue
        start, end = max(0, row['start']-padding), row['end']+padding
        end = min(end, start+max_span)
        score = 3*bool(STRONG.search(text)) + bool(re.search('instead|better|更好', text, re.I))
        if found and start <= found[-1]['end'] and end-found[-1]['start'] <= max_span:
            found[-1]['end'] = end
            found[-1]['sentence_indices'].append(i)
            found[-1]['score'] = max(score, found[-1]['score'])
        else:
            found.append({'start':round(start,3),'end':round(end,3),'sentence_indices':[i],'score':score})
    return found


def phash(rgb):
    import cv2
    import numpy as np
    gray = cv2.cvtColor(rgb, cv2.COLOR_RGB2GRAY)
    coeff = cv2.dct(cv2.resize(gray,(32,32)).astype(np.float32))[:8,:8]
    bits = coeff > np.median(coeff.ravel()[1:])
    return int(''.join('1' if b else '0' for b in bits.ravel()),2)


def decode_window(video_path, window, destination, fps=1):
    """Decode only selected windows at 1–2 FPS, single ffmpeg thread.

    Save scene-change anchors and five-second fallback anchors. This is not a
    semantic photo/host classifier; visual and subtitle QA is mandatory.
    """
    if not 1 <= fps <= 2 or not 0 <= window['start'] < window['end']:
        raise ValueError('invalid decode window/fps')
    import imageio_ffmpeg
    import numpy as np
    from PIL import Image, ImageDraw
    dest = Path(destination); dest.mkdir(parents=True,exist_ok=True)
    cmd = [imageio_ffmpeg.get_ffmpeg_exe(),'-v','error','-threads','1','-ss',str(window['start']),
           '-i',str(video_path),'-t',str(window['end']-window['start']),'-an',
           '-vf',f'fps={fps},scale=640:360:force_original_aspect_ratio=decrease,pad=640:360:(ow-iw)/2:(oh-ih)/2',
           '-threads','1','-f','rawvideo','-pix_fmt','rgb24','pipe:1']
    import tempfile
    frames=[]; last_hash=None;last_t=-10
    with tempfile.TemporaryFile() as error:
        proc = subprocess.Popen(cmd,stdout=subprocess.PIPE,stderr=error)
        try:
            index=0
            while True:
                raw=proc.stdout.read(640*360*3)
                if not raw:break
                if len(raw)!=640*360*3:raise ValueError('truncated frame')
                rgb=np.frombuffer(raw,dtype=np.uint8).reshape(360,640,3)
                t=round(window['start']+index/fps,3); index+=1; h=phash(rgb)
                if last_hash is None or (h^last_hash).bit_count()>=10 or t-last_t>=5:
                    name=f'{index-1:04d}.jpg'; p=dest/name
                    Image.fromarray(rgb).save(p,quality=88)
                    frames.append({'time':t,'path':name,'phash':f'{h:016x}',
                                   'sha256':hashlib.sha256(p.read_bytes()).hexdigest()})
                    last_hash=h;last_t=t
            if proc.wait()!=0:
                error.seek(0);raise RuntimeError(error.read().decode()[-1000:])
        finally:
            if proc.poll() is None:proc.kill();proc.wait()
            proc.stdout.close()
    if not frames:raise ValueError('no frames')
    cols=5; w,h=256,160
    sheet=Image.new('RGB',(cols*w,math.ceil(len(frames)/cols)*h),'#202020');d=ImageDraw.Draw(sheet)
    for i,f in enumerate(frames):
        im=Image.open(dest/f['path']);im.thumbnail((256,144));x=(i%cols)*w;y=(i//cols)*h
        sheet.paste(im,(x,y));d.text((x+3,y+144),f"{i}: {f['time']:.2f}s",fill='white')
    sheet.save(dest/'contact.jpg',quality=85)
    (dest/'frames.json').write_text(json.dumps(frames,indent=2))
    return frames


def validate_pair(pair, rule_ids):
    if pair['rule_id'] not in rule_ids or not 0 < len(pair['paraphrase']) <= 40:
        raise ValueError('rule or paraphrase')
    if not all(math.isfinite(pair[k]) for k in ('start','end')) or not 0 <= pair['start'] < pair['end']:
        raise ValueError('pair bounds')
    if pair['positive'] not in ('a','b') or pair.get('review') != 'subtitle-and-visual':
        raise ValueError('unreviewed/ambiguous direction')
    for label in ('a','b'):
        frame=pair['frames'][label]
        safe_path(Path(CEPH)/'materials-courses/frames',frame['path'])
        if not math.isfinite(frame['time']) or not pair['start'] <= frame['time'] <= pair['end'] or not re.fullmatch('[0-9a-f]{64}',frame['sha256']):
            raise ValueError('frame location/digest')
    if pair['frames']['a']['sha256']==pair['frames']['b']['sha256']:
        raise ValueError('identical pair')
    if any(k in pair for k in ('text','quote','subtitle','sentences','cues')):
        raise ValueError('raw text forbidden')
    return pair


def validate_decision(decision, window, rule_ids):
    if decision.get('review') != 'subtitle-and-visual' or decision.get('positive') not in ('a','b'):
        raise ValueError('explicit reviewed direction required')
    if decision['rule_id'] not in rule_ids or not 0 < len(decision['paraphrase']) <= 40:
        raise ValueError('rule or paraphrase')
    for label in ('a','b'):
        index=decision[label]
        if type(index) is not int or not 0 <= index < len(window['frames']):
            raise ValueError('frame index')
        crop=decision['crop_'+label]
        if len(crop)!=4 or not all(isinstance(v,(int,float)) and math.isfinite(v) for v in crop):
            raise ValueError('crop coordinates')
        if not 0 <= crop[0] < crop[2] <= 1 or not 0 <= crop[1] < crop[3] <= 1:
            raise ValueError('crop bounds')
    if decision['a']==decision['b'] and decision['crop_a']==decision['crop_b']:
        raise ValueError('identical comparison')
    return decision


def export_reviewed(root, decisions, decoded, videos, rule_ids):
    """Re-audit originals, extract reviewed times at 1280x720, crop photo viewports.

    Cropped frames and full screenshot provenance are retained only on Ceph.
    Log export includes SHA-checked images and metadata for private local QA.
    """
    import base64
    import gzip
    import io
    import imageio_ffmpeg
    from PIL import Image
    root=Path(root);out=root/'materials-courses/frames';lookup={v['remote_rel']:v for v in videos}
    by_id={w['id']:w for w in decoded};verified={};pairs=[];seen=set()
    for decision in decisions:
        w=by_id[decision['window_id']];validate_decision(decision,w,rule_ids)
        v=lookup[w['video_remote_rel']]
        if v['remote_rel'] not in verified:verified[v['remote_rel']]=audit(root,v)
        identity=w['id']+'-pair'
        dest=safe_path(out,w['slug']+'/w4-frames-20261011/accepted/'+identity);dest.mkdir(parents=True,exist_ok=True)
        pair={'id':identity,'course':w['slug'],'episode':w['episode'],'video_remote_rel':v['remote_rel'],
              'video_size':v['size'],'video_sha256':v['sha256'],'start':w['start'],'end':w['end'],
              'subtitle_output':w['text_output'],'subtitle_sentence_indices':w['sentence_indices'],
              'rule_id':decision['rule_id'],'paraphrase':decision['paraphrase'],'positive':decision['positive'],
              'review':'subtitle-and-visual','reviewed_by':'codex','user_visual_qa':'pending',
              'comparison_mode':'same-screen-panels' if decision['a']==decision['b'] else 'different-times',
              'frames':{}}
        if decision.get('limitation'):pair['limitation']=decision['limitation']
        native_failed=False
        for label in ('a','b'):
            t=w['frames'][decision[label]]['time']
            # fps rounding can place a preview up to one frame after the nominal
            # second. Match the reviewed photo viewport instead of assuming a
            # fresh single-frame seek returns the same source image.
            from PIL import ImageChops, ImageStat
            sample_start=max(w['start'],t-3)
            cmd=[imageio_ffmpeg.get_ffmpeg_exe(),'-v','info','-threads','1','-ss',str(sample_start),'-copyts','-start_at_zero',
                 '-i',str(verified[v['remote_rel']]),'-frames:v','20','-an','-threads','1',
                 '-vf','fps=2,scale=1280:720:force_original_aspect_ratio=decrease,pad=1280:720:(ow-iw)/2:(oh-ih)/2,showinfo','-fps_mode','passthrough',
                 '-f','rawvideo','-pix_fmt','rgb24','pipe:1']
            proc=subprocess.run(cmd,capture_output=True,timeout=180)
            if proc.returncode:raise RuntimeError(proc.stderr.decode()[-1000:])
            frame_bytes=1280*720*3
            if len(proc.stdout)%frame_bytes:raise ValueError('truncated native sample')
            baseline=safe_path(out,w['output']+'/'+w['frames'][decision[label]]['path'])
            baseline_bytes=baseline.read_bytes()
            if hashlib.sha256(baseline_bytes).hexdigest()!=w['frames'][decision[label]]['sha256']:
                raise ValueError('reviewed preview checksum')
            target=Image.open(io.BytesIO(baseline_bytes)).convert('RGB')
            box=decision['crop_'+label]
            def photo(im):
                rect=(round(box[0]*im.width),round(box[1]*im.height),round(box[2]*im.width),round(box[3]*im.height))
                return im.crop(rect).resize((320,240))
            target_photo=photo(target);choices=[]
            pts=[float(v) for v in re.findall(r'n:\s*\d+.*?pts_time:([0-9.e+\-]+)',proc.stderr.decode())]
            if len(pts)!=len(proc.stdout)//frame_bytes:raise ValueError('native timestamp count mismatch')
            for k in range(len(proc.stdout)//frame_bytes):
                if not w['start']<=pts[k]<=w['end']:continue
                im=Image.frombytes('RGB',(1280,720),proc.stdout[k*frame_bytes:(k+1)*frame_bytes])
                delta=sum(ImageStat.Stat(ImageChops.difference(target_photo,photo(im))).mean)/3
                choices.append((delta,k,im))
            if not choices:raise ValueError('no native samples in window')
            delta,k,raw=min(choices,key=lambda v:v[0])
            if delta>8:
                print('PAIR_REJECTED '+json.dumps({'id':identity,'reason':'native-preview-mismatch','label':label,'mae':round(delta,3)}),flush=True)
                native_failed=True;break
            sampled_time=round(pts[k],3)
            full=dest/(label+'_source.jpg');raw.save(full,quality=94)
            box=decision['crop_'+label];pixel_box=[round(box[0]*raw.width),round(box[1]*raw.height),round(box[2]*raw.width),round(box[3]*raw.height)]
            cropped=raw.crop(tuple(pixel_box));p=dest/(label+'.jpg');cropped.save(p,quality=94)
            encoded=p.read_bytes()
            pair['frames'][label]={'path':str(p.relative_to(out)),'time':sampled_time,'preview_time':t,'time_tolerance_seconds':.25,
                                   'preview_path':str(baseline.relative_to(out)),'preview_sha256':w['frames'][decision[label]]['sha256'],
                                   'viewport_match_mae':round(delta,3),'sha256':hashlib.sha256(encoded).hexdigest(),
                                   'size':len(encoded),'width':cropped.width,'height':cropped.height,
                                   'source_frame':str(full.relative_to(out)),
                                   'source_frame_sha256':hashlib.sha256(full.read_bytes()).hexdigest(),
                                   'viewport':[1280,720],'crop_normalized':box,'crop_pixels':pixel_box}
        if native_failed:continue
        validate_pair(pair,rule_ids)
        key=tuple(sorted(f['sha256'] for f in pair['frames'].values()))
        if key in seen:
            print('PAIR_DUPLICATE '+identity,flush=True);continue
        seen.add(key);pairs.append(pair)
        for label,f in pair['frames'].items():
            encoded=(out/f['path']).read_bytes()
            print('PAIR_IMAGE '+json.dumps({'path':'pairs/'+identity+'/'+label+'.jpg','sha256':f['sha256'],
                                           'data':base64.b64encode(encoded).decode()}),flush=True)
        print('PAIR '+json.dumps(pair,ensure_ascii=False),flush=True)
    encoded=json.dumps({'pairs':pairs},ensure_ascii=False,indent=2)
    p=out/'w4-frames-20261011-accepted.json';part=p.with_suffix('.json.part');part.write_text(encoded);part.replace(p)
    print('PAIRS_DONE '+str(len(pairs)),flush=True)
    return pairs
