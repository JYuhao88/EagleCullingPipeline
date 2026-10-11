#!/usr/bin/env python3
"""CPU ONNX benchmark on EXIF-corrected 768px previews; no source writes."""
import argparse,json,time,statistics,os,platform
from pathlib import Path
import numpy as np
import onnxruntime as ort
from PIL import Image,ImageOps

def main():
    p=argparse.ArgumentParser()
    p.add_argument('--model',type=Path,required=True)
    p.add_argument('--images',type=Path,required=True)
    p.add_argument('--threads',type=int,choices=[1,2,3],default=3)
    p.add_argument('--limit',type=int,default=30)
    p.add_argument('--output',type=Path,required=True)
    p.add_argument('--reference',type=Path,help='Ray topiq_iaa_parity.json for the same AVA files')
    args=p.parse_args()
    paths=sorted(x for x in args.images.rglob('*') if x.suffix.lower() in {'.jpg','.jpeg'})[:args.limit]
    if len(paths)<20:raise RuntimeError('need >=20 JPG images')
    opt=ort.SessionOptions();opt.intra_op_num_threads=args.threads;opt.inter_op_num_threads=1
    started=time.perf_counter()
    sess=ort.InferenceSession(str(args.model),opt,providers=['CPUExecutionProvider'])
    init_ms=(time.perf_counter()-started)*1000
    if sess.get_inputs()[0].shape != [1,3,512,512]:raise RuntimeError('expected fixed 512 input')
    def array(path):
        with Image.open(path) as source:
            im=ImageOps.exif_transpose(source).convert('RGB')
            im.thumbnail((768,768),Image.Resampling.BILINEAR)
            im=im.resize((512,512),Image.Resampling.BILINEAR)
            return np.asarray(im,dtype=np.float32).transpose(2,0,1)[None]/255
    for _ in range(3):sess.run(None,{'image':array(paths[0])})
    rows=[]
    for path in paths:
        start=time.perf_counter();x=array(path);prepared=time.perf_counter()
        raw=float(np.asarray(sess.run(None,{'image':x})[0]).reshape(-1)[0]);end=time.perf_counter()
        rows.append({'path':str(path),'raw':raw,'preprocess_ms':(prepared-start)*1000,'inference_ms':(end-prepared)*1000,'total_ms':(end-start)*1000})
    result={'platform':platform.platform(),'machine':platform.machine(),'niceness':os.getpriority(os.PRIO_PROCESS,0),'model':str(args.model),'threads':args.threads,'n':len(rows),'init_ms':init_ms,'warmup':3,'onnxruntime':ort.__version__,'preprocess':'EXIF RGB bilinear 768 long edge -> stretch 512 /255; no external mean/std','rows':rows}
    for field in ['inference_ms','total_ms']:
        vals=[r[field] for r in rows];result[field]={'mean':statistics.mean(vals),'median':statistics.median(vals),'p95':float(np.percentile(vals,95)),'max':max(vals)}
    result['latency_pass']=result['total_ms']['max']<=400
    if args.reference:
        reference=json.loads(args.reference.read_text())
        by_id={str(r['id']):r for r in reference['rows']}
        diffs=[]
        for r in rows:
            image_id=Path(r['path']).stem.removeprefix('topiq_iaa_fixture_')
            ref=by_id[image_id]['pyiqa_preview_raw']
            r['ray_pyiqa_preview_raw']=ref;r['raw_abs_diff']=abs(r['raw']-ref)
            diffs.append(r['raw_abs_diff'])
        result['ray_pyiqa_mean_abs_diff_raw']=statistics.mean(diffs)
        result['ray_pyiqa_mean_abs_diff_unit']=statistics.mean(diffs)/9
        result['parity_pass']=statistics.mean(diffs)<0.02
    args.output.parent.mkdir(parents=True,exist_ok=True);args.output.write_text(json.dumps(result,indent=2)+'\n')
    print(json.dumps({k:v for k,v in result.items() if k!='rows'}))
if __name__=='__main__':main()
