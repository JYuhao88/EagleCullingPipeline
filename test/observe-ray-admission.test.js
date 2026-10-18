import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';

function python(code) {
  const result = spawnSync('python3', ['-B', '-c', code], { encoding: 'utf8' });
  assert.equal(result.status, 0, result.stderr || result.stdout);
}

const fixture = `from ml.common.ray_admission import admission, job_kind
def job(name, kind='gpu', count='2'):
 return {'submission_id':name,'status':'RUNNING','metadata':{'ecp_job_kind':kind,'ecp_requested_gpus':count}}
w35=job('w35-vlm-moe-a')
w36=job('w36-vlm-critique-a')
teacher=job('w36-vlm-critique-b','teacher','0')
`;

test('project admission permits one W36 GPU inference and one CPU teacher beside W35', () => {
  python(fixture + `
assert admission([w35,w36], 'w36-vlm-critique', 'teacher')
assert admission([w35,teacher], 'w36-vlm-critique', 'gpu')
for existing,kind in [([w35,w36],'gpu'),([w35,teacher],'teacher')]:
 try: admission(existing,'w36-vlm-critique',kind)
 except RuntimeError: pass
 else: raise AssertionError('same-kind W36 overlap admitted')
assert not admission([w35,w36,teacher],'w34-vlm','gpu')
assert not admission([w35,w36,teacher],'w28-aihub','teacher')
`);
});

test('third project slot is reserved for a CPU-only teacher and unknown resources count as GPU', () => {
  python(fixture + `
unknown={'submission_id':'w39-unknown','status':'PENDING'}
assert job_kind(unknown)=='gpu'
assert job_kind(job('w2-a','teacher','1'))=='gpu'
assert job_kind({'entrypoint_num_gpus':1,'metadata':{'ecp_job_kind':'teacher','ecp_requested_gpus':'0'}})=='gpu'
for value in ('nan','inf','-1','invalid'):
 assert job_kind(job('w2-a','teacher',value))=='gpu'
assert job_kind({'entrypoint_num_gpus':0,'entrypoint_resources':{'GPU':1}})=='gpu'
assert job_kind({'entrypoint_num_gpus':None,'metadata':{'ecp_requested_gpus':'0'}})=='gpu'
assert job_kind({'submission_id':'w2-a','metadata':'malformed'})=='gpu'
assert job_kind({'entrypoint_num_gpus':0})=='cpu'
assert not admission([w35,unknown],'w34-vlm','gpu')
assert admission([w35,unknown],'w28-aihub','teacher')
ordinary_cpu=job('w2-embed','embed','0')
assert job_kind(ordinary_cpu)=='cpu'
assert not admission([w35,ordinary_cpu],'w34-vlm','gpu')
assert admission([w35,ordinary_cpu],'w28-aihub','teacher')
foreign=job('external-job')
assert admission([w35,foreign],'w34-vlm','gpu')
`);
});

test('both submitters keep admission and POST under the same lock while allowing opposite kinds', () => {
  python(fixture + `
import importlib.util,tempfile,json
from pathlib import Path
for file,kind,active in [('scripts/observe-vlm-ray.py','gpu',[w35,teacher]),('scripts/aihub-ray.py','teacher',[w35,w36])]:
 spec=importlib.util.spec_from_file_location('subject',file)
 m=importlib.util.module_from_spec(spec);spec.loader.exec_module(m)
 with tempfile.TemporaryDirectory() as tmp:
  m.LOCK=Path(tmp)/'lock';calls=[]
  def request(path,body=None):
   assert m.LOCK.exists()
   assert json.loads((m.LOCK/'owner.json').read_text())['line']=='w36-vlm-critique'
   calls.append(path)
   return active if body is None else {'accepted':True}
  m.request=request
  assert m.submit_locked({'submission_id':'w36-vlm-critique-c'},line='w36-vlm-critique')=={'accepted':True}
  assert len(calls)==2 and not m.LOCK.exists()
  invalid=0 if kind=='gpu' else 1
  try:m.submit_locked({'entrypoint_num_gpus':invalid},line='w36-vlm-critique')
  except ValueError:pass
  else:raise AssertionError('invalid resource request admitted')
`);
});

test('teacher submissions explicitly request zero GPUs and persist the dashboard resource tag', () => {
  python(`import importlib.util,tempfile,sys
from pathlib import Path
spec=importlib.util.spec_from_file_location('subject','scripts/aihub-ray.py')
m=importlib.util.module_from_spec(spec);spec.loader.exec_module(m)
with tempfile.TemporaryDirectory() as tmp:
 captured={}
 m.package=lambda work:b'synthetic package'
 m.job_environment=lambda config:{}
 m.request=lambda *a,**kw:{}
 m.submit_recorded=lambda work,body,*a,**kw:captured.update(body=body) or {}
 sys.argv=['aihub-ray.py','submit',tmp]
 m.main()
 body=captured['body']
 assert body['entrypoint_num_gpus']==0
 assert body['metadata']=={'ecp_job_kind':'teacher','ecp_requested_gpus':'0'}
`);
});
