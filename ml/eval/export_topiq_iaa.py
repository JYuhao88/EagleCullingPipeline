#!/usr/bin/env python3
"""Fixed RGB /255 TOPIQ-IAA export, preserving its internal antialiased resize."""
from __future__ import annotations
import sys as _private_sys
from pathlib import Path as _PrivatePath
if 'ml.common.private_env' not in _private_sys.modules:
    _private_sys.path.insert(0, str(_PrivatePath(__file__).resolve().parents[2]))
from ml.common.private_env import require_path
ROOT = _PrivatePath(require_path('ECP_CEPH_ROOT'))
import os
import argparse,hashlib,inspect,json,time,io
from pathlib import Path
import numpy as np
import torch,pyiqa
from PIL import Image,ImageOps
from torchvision.transforms import functional as TF
from pyiqa.archs import topiq_arch

def sha256(path):
    h=hashlib.sha256()
    with path.open('rb') as f:
        for chunk in iter(lambda:f.read(1024*1024),b''):h.update(chunk)
    return h.hexdigest()

def array(path,preview=False):
    with Image.open(path) as source:
        im=ImageOps.exif_transpose(source).convert('RGB')
        if preview:im.thumbnail((768,768),Image.Resampling.BILINEAR)
        im=im.resize((512,512),Image.Resampling.BILINEAR)
        return np.asarray(im,dtype=np.float32).transpose(2,0,1)[None]/255

def main():
    p=argparse.ArgumentParser();p.add_argument('--root',type=Path,default=ROOT)
    p.add_argument('--samples',type=int,default=30);p.add_argument('--device',default='cuda')
    args=p.parse_args()
    if args.samples<20:raise ValueError('need >=20 parity samples')
    torch.set_num_threads(3)
    torch.backends.cuda.matmul.allow_tf32=False
    torch.set_float32_matmul_precision('highest')
    print('CREATE_METRIC',flush=True)
    # Ceph random seeks per tensor can take minutes; use one sequential read.
    original_load=torch.load
    def sequential_load(file,*a,**kw):
        if isinstance(file,(str,Path)) and str(file).startswith(str(ROOT)):
            print('SEQUENTIAL_LOAD',str(file),flush=True)
            file=io.BytesIO(Path(file).read_bytes())
        return original_load(file,*a,**kw)
    try:
        torch.load=sequential_load
        metric=pyiqa.create_metric('topiq_iaa',device=args.device).eval();net=metric.net
    finally:torch.load=original_load
    print('METRIC_READY',flush=True)
    out=args.root/'models/onnx';out.mkdir(parents=True,exist_ok=True)
    source=inspect.getsource(type(metric).forward)+'\n'+inspect.getsource(type(net).forward_cross_attention)
    (out/'topiq_iaa_pyiqa_source.txt').write_text(source)
    rows=json.loads((args.root/'datasets/ava-test-5000.json').read_text())[:args.samples]
    # Verify the actual tensor entering the original network from the pyiqa path API.
    captured=[]
    hook=net.register_forward_pre_hook(lambda module,inputs:captured.append(inputs[0].detach().cpu()))
    with torch.inference_mode():metric(rows[0]['path'])
    hook.remove()
    with Image.open(rows[0]['path']) as im:
        expected=torch.from_numpy(np.asarray(im.convert('RGB'),dtype=np.float32).transpose(2,0,1)[None]/255)
    input_diff=float((captured[0]-expected).abs().max())
    if input_diff>1e-6:raise RuntimeError(f'pyiqa path RGB /255 input mismatch {input_diff}')
    print('ACTUAL_INPUT',list(captured[0].shape),'max_diff',input_diff,flush=True)
    # Legacy ONNX cannot export aten::_upsample_bilinear2d_aa. For this fixed
    # input, derive its exact separable linear operator from torchvision itself.
    original_resize=TF.resize
    basis=torch.eye(512,device=args.device).reshape(512,1,1,512)
    weights=original_resize(basis,[1,384],antialias=True)[:,0,0,:].T.contiguous()
    class Wrapper(torch.nn.Module):
        def __init__(self):
            super().__init__();self.net=net;self.register_buffer('resize_weights',weights)
        def resize(self,x):
            return torch.matmul(torch.matmul(self.resize_weights,x),self.resize_weights.T)
        def forward(self,x):return self.net(x)
    wrapper=Wrapper().to(args.device).eval()
    sample=torch.rand(1,3,512,512,device=args.device)
    resize_diff=float((wrapper.resize(sample)-original_resize(sample,[384,384],antialias=True)).abs().max())
    if resize_diff>2e-6:raise RuntimeError(f'antialias operator mismatch {resize_diff}')
    def fixed_resize(x,size,*a,**kw):
        if list(x.shape[-2:])!=[512,512] or list(size)!=[384,384]:
            raise RuntimeError(f'unexpected resize {x.shape} -> {size}')
        return wrapper.resize(x)
    path=out/'topiq_iaa_512.onnx'
    try:
        topiq_arch.TF.resize=fixed_resize
        print('EXPORT_START',flush=True)
        torch.onnx.export(wrapper,sample,str(path),opset_version=17,dynamo=False,
                          input_names=['image'],output_names=['score'])
    finally:topiq_arch.TF.resize=original_resize
    print('EXPORT_DONE',path.stat().st_size,flush=True)
    import onnxruntime as ort
    opts=ort.SessionOptions();opts.intra_op_num_threads=3;opts.inter_op_num_threads=1
    session=ort.InferenceSession(str(path),opts,providers=['CPUExecutionProvider'])
    results=[]
    for row in rows:
        x=array(row['path']);preview=array(row['path'],True)
        with torch.inference_mode():
            ref=float(metric(torch.from_numpy(x).to(args.device)).item())
            preview_ref=float(metric(torch.from_numpy(preview).to(args.device)).item())
        onnx=float(session.run(None,{'image':x})[0].reshape(-1)[0])
        preview_onnx=float(session.run(None,{'image':preview})[0].reshape(-1)[0])
        results.append({'id':row['id'],'path':row['path'],'pyiqa_512_raw':ref,'onnx_512_raw':onnx,
                        'pyiqa_preview_raw':preview_ref,'onnx_preview_raw':preview_onnx})
        print('PARITY',len(results),ref,onnx,flush=True)
    raw_diff=float(np.mean([abs(r['pyiqa_512_raw']-r['onnx_512_raw']) for r in results]))
    preview_diff=float(np.mean([abs(r['pyiqa_preview_raw']-r['onnx_preview_raw']) for r in results]))
    files=[path]+sorted(out.glob(path.name+'.data*'))
    meta={'model':'topiq-iaa-onnx','version':'topiq-iaa-512-v1','pyiqa_version':pyiqa.__version__,
          'input_shape':[1,3,512,512],'preprocess':'EXIF transpose, RGB, bilinear stretch 512, /255; no external mean/std',
          'internal_preprocess':'torchvision antialias bilinear 512->384 then network ImageNet mean/std',
          'raw_range':[1,10],'unit_transform':{'scale':1/9,'offset':-1/9},
          'actual_input_max_abs_diff':input_diff,'resize_max_abs_diff':resize_diff,
          'n':len(results),'mean_abs_diff_raw':raw_diff,'preview_mean_abs_diff_raw':preview_diff,
          'mean_abs_diff_unit':raw_diff/9,'parity_pass':max(raw_diff,preview_diff)<0.02,
          'sha256':sha256(path),'files':{f.name:{'sha256':sha256(f),'size_bytes':f.stat().st_size} for f in files}}
    (out/'topiq_iaa_512.json').write_text(json.dumps(meta,indent=2)+'\n')
    (out/'topiq_iaa_parity.json').write_text(json.dumps({'metadata':meta,'rows':results},indent=2)+'\n')
    print('RESULT_JSON='+json.dumps(meta),flush=True)
if __name__=='__main__':main()
