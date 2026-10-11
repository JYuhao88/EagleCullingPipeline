#!/usr/bin/env python3
"""One-GPU sequential multilingual ASR Ray entrypoint. Never modifies raw inputs.

REF_MANIFEST JSON; REF_OUT; REF_FORCE=1; REF_ASR_BACKEND=funasr|whisper.
Completed JSONL is atomically published only after timestamp validation.
"""
from __future__ import annotations
import sys as _private_sys
from pathlib import Path as _PrivatePath
if 'ml.common.private_env' not in _private_sys.modules:
    _private_sys.path.insert(0, str(_PrivatePath(__file__).resolve().parents[2]))
from ml.common.private_env import require_path
import json
import hashlib
import os
from pathlib import Path
import subprocess
import tempfile
import time

ROOT=Path(os.environ.get('REF_OUT',require_path('ECP_CEPH_ROOT') + '/references/yidao'))


def verify_source(source, video):
    """Course manifests require whole-file verification, including cached ASR."""
    if not video.get('sha256'):
        return None
    if source.suffix == '.part' or not source.is_file():
        raise ValueError('source not atomically published')
    if 'size' in video and source.stat().st_size != video['size']:
        raise ValueError('source size mismatch')
    digest = hashlib.sha256()
    with source.open('rb') as stream:
        for chunk in iter(lambda: stream.read(8*1024*1024), b''):
            digest.update(chunk)
    actual = digest.hexdigest()
    if actual != video['sha256']:
        raise ValueError('source SHA-256 mismatch')
    return actual


def atomic(path, value, lines=False):
    path.parent.mkdir(parents=True,exist_ok=True)
    tmp=path.with_suffix(path.suffix+'.part')
    tmp.write_text(''.join(json.dumps(x,ensure_ascii=False)+'\n' for x in value) if lines else json.dumps(value,ensure_ascii=False,indent=2),encoding='utf-8')
    tmp.replace(path)


def valid(rows, duration):
    return bool(rows) and all(isinstance(r.get('text'),str) and r['text'].strip() and 0<=r['start']<r['end']<=duration+2 for r in rows) and all(a['start']<=b['start'] for a,b in zip(rows,rows[1:]))


def decode(source, target):
    import imageio_ffmpeg
    subprocess.run([imageio_ffmpeg.get_ffmpeg_exe(),'-hide_banner','-loglevel','error','-threads','1','-i',str(source),'-vn','-ac','1','-ar','16000','-threads','1','-y',target],check=True)


def funasr_rows(result, duration):
    rows=[]
    for item in result:
        sentences=item.get('sentence_info',[])
        if not sentences:
            raise RuntimeError('Paraformer returned no sentence_info; refusing untimed transcription')
        for s in sentences:
            start=max(0,float(s['start'])/1000); end=min(duration,float(s['end'])/1000)
            text=s.get('text','').strip()
            if end>start and text:
                row={'start':round(start,3),'end':round(end,3),'text':text}
                if s.get('timestamp'): row['token_timestamps']=[[round(float(a)/1000,3),round(float(b)/1000,3)] for a,b in s['timestamp']]
                rows.append(row)
    return sorted(rows,key=lambda r:r['start'])


def cache_matches(stats, backend, language, model_name):
    return (stats.get('backend') == backend
            and stats.get('language', 'zh') == language
            and (backend != 'whisper' or stats.get('model') == model_name))


def main():
    import ray
    import torch
    ray.init(address='auto')
    torch.set_num_threads(2)
    backend=os.environ.get('REF_ASR_BACKEND','funasr')
    language=os.environ.get('REF_ASR_LANGUAGE','zh')
    model_name=os.environ.get('REF_ASR_MODEL','large-v3')
    if backend=='funasr' and language!='zh':raise ValueError('default FunASR model only supports zh')
    boot=time.monotonic()
    if backend=='funasr':
        from funasr import AutoModel
        model=AutoModel(model='paraformer-zh',vad_model='fsmn-vad',punc_model='ct-punc',device='cuda:0',ncpu=2,disable_update=True)
    elif backend=='whisper':
        from faster_whisper import WhisperModel
        model=WhisperModel(model_name,device='cuda',compute_type='float16',cpu_threads=2,num_workers=1)
    else: raise ValueError(backend)
    load_seconds=time.monotonic()-boot
    print('MODEL_READY',backend,round(load_seconds,2),flush=True)
    manifest=json.loads(os.environ['REF_MANIFEST']); results=[]
    for video in manifest['videos']:
        bvid=video['bvid']; path=ROOT/'asr'/f'{bvid}.jsonl'; statpath=ROOT/'asr'/f'{bvid}.stats.json'; began=time.monotonic()
        try:
            source=Path(video['source_path']) if video.get('source_path') else ROOT/'raw'/bvid/'audio.m4s'
            deadline=time.monotonic()+float(os.environ.get('REF_WAIT_INPUT_SECONDS','0'))
            while not source.is_file() and time.monotonic()<deadline: time.sleep(5)
            source_sha256=verify_source(source,video)
            if path.exists() and statpath.exists() and os.environ.get('REF_FORCE')!='1':
                rows=[json.loads(l) for l in path.read_text().splitlines() if l.strip()]
                stats=json.loads(statpath.read_text())
                if cache_matches(stats,backend,language,model_name) and valid(rows,stats['duration']) and (not source_sha256 or stats.get('source_sha256')==source_sha256):
                    (ROOT/'asr'/f'{bvid}.error.json').unlink(missing_ok=True)
                    print('SKIP',bvid,len(rows),flush=True); results.append(stats); continue
            import soundfile as sf
            with tempfile.TemporaryDirectory(prefix='refs-asr-') as temp:
                wav=temp+'/audio.wav'; decode(source,wav)
                info=sf.info(wav); duration=info.duration
                if backend=='funasr':
                    audio, _ = sf.read(wav, dtype='float32')
                    result=model.generate(input=audio,batch_size_s=int(os.environ.get('REF_ASR_BATCH_SECONDS','1200')),sentence_timestamp=True,return_raw_text=True)
                    rows=funasr_rows(result,duration)
                else:
                    sentences,_=model.transcribe(wav,language=language,vad_filter=True,word_timestamps=True,beam_size=5)
                    rows=[{'start':round(s.start,3),'end':round(min(s.end,duration),3),'text':s.text.strip(),'words':[{'start':w.start,'end':w.end,'text':w.word} for w in s.words or []]} for s in sentences if s.text.strip()]
            if not valid(rows,duration): raise RuntimeError('invalid/empty ASR timestamps')
            stats={'bvid':bvid,'backend':backend,'model':'paraformer-zh+fsmn-vad+ct-punc' if backend=='funasr' else model_name,'language':language,'duration':duration,'code_sha256':os.environ.get('REF_CODE_SHA256'),'batch_seconds':int(os.environ.get('REF_ASR_BATCH_SECONDS','1200')),'sentences':len(rows),'seconds':round(time.monotonic()-began,3),'model_load_seconds':load_seconds,'gpu':1,'cpus':2,'device':torch.cuda.get_device_name(0),'peak_gpu_memory_gb':round(torch.cuda.max_memory_allocated(0)/1e9,3),'error':None}
            stats['source_sha256']=source_sha256
            atomic(path,rows,True); atomic(statpath,stats)
            (ROOT/'asr'/f'{bvid}.error.json').unlink(missing_ok=True)
            print('DONE',json.dumps(stats,ensure_ascii=False),flush=True)
            if os.environ.get('REF_LOG_TEXT','1') == '1': print('SAMPLE',bvid,json.dumps(rows[:12],ensure_ascii=False),flush=True)
            terms=['直闪','套头','色温','逆光','35','85']
            examples={t:[r for r in rows if t in r['text']][:2] for t in terms}
            if os.environ.get('REF_LOG_TEXT','1') == '1': print('TERMS',bvid,json.dumps(examples,ensure_ascii=False),flush=True)
            results.append(stats)
        except Exception as e:
            import traceback
            traceback.print_exc()
            stats={'bvid':bvid,'error':str(e),'seconds':round(time.monotonic()-began,3)}
            atomic(ROOT/'asr'/f'{bvid}.error.json',stats); results.append(stats)
            print('ERROR',json.dumps(stats,ensure_ascii=False),flush=True)
    report={'videos':len(results),'failed':[r for r in results if r.get('error')],'seconds':round(time.monotonic()-boot,3),'model_load_seconds':load_seconds,'resource':{'num_cpus':2,'num_gpus':1},'results':results}
    atomic(ROOT/'asr'/'run-report.json',report)
    print('SUMMARY',json.dumps({k:v for k,v in report.items() if k!='results'},ensure_ascii=False),flush=True)
    if any(r.get('error') for r in results): raise SystemExit(1)

if __name__=='__main__': main()
