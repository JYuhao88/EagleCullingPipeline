import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, writeFile, rm, symlink } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import sharp from 'sharp';
import { TEACHERS, POLICIES, budgetCap, preregister, readPreregistration, selectPilot, judgePrompt, judgmentSchema,
  validateJudgment, prepareRequests, auditBudget, collectJudgments, blindedSheet, freezeResumePlan, readResumePlan, auditResumeBudget,
  validateResumeBatch } from '../scripts/observe-critique-judge.mjs';

const json = async file => JSON.parse(await readFile(file, 'utf8'));
const lines = async file => (await readFile(file, 'utf8')).trim().split('\n').filter(Boolean).map(JSON.parse);
const statement = { id: 'issue-1', kind: 'issue', category: 'composition/crop', text: '右侧留白较多' };
const critique = { summary: '人物突出', strengths: [], issues: [{ category: 'composition/crop', text: '右侧留白较多' }],
  edits: [], verdict: '保留' };
const vote = id => ({ id, correctness: '正确', reasonableness: '无法判断', contradiction: '不矛盾', adds_information: '新增' });

async function fixture(t, n = 2) {
  const root = await mkdtemp(path.join(os.tmpdir(), 'critique-judge-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const cache = path.join(root, 'cache'), prepared = path.join(root, 'prepared');
  await mkdir(path.join(prepared, 'images'), { recursive: true });
  await sharp({ create: { width: 16, height: 12, channels: 3, background: '#abc' } }).jpeg().toFile(path.join(prepared, 'images/view.jpg'));
  const manifest = Array.from({ length: n }, (_, index) => ({ id: `photo-${index}`, set: 'photos', storage: 'package',
    images: { full: 'images/view.jpg' }, specialist_facts: [{ id: 'gaze', text: '看镜头', source: 'model' }] }));
  const rows = manifest.map(item => ({ id: item.id, model: 'hidden-local-model', variant: 'B', ask: 0,
    prompt_sha256: 'a'.repeat(64), critique,
    statements: [statement, { id: 'verdict', kind: 'verdict', category: 'verdict', text: '保留' }] }));
  const ledgerFile = path.join(root, 'ledger.jsonl');
  await writeFile(ledgerFile, Object.values(TEACHERS).map(model => JSON.stringify({ model,
    pricing: { input: 1, output: 2, usdToCny: 7 } }) + '\n').join(''));
  await preregister(cache, { corpus: 'synthetic' });
  return { root, cache, prepared, manifest, rows, ledgerFile, cap: 1200 };
}

async function settle(output, usage = { prompt_tokens: 100, completion_tokens: 20 }, invalid = false) {
  const requests = await lines(path.join(output, 'requests.jsonl'));
  const metadata = await json(path.join(output, 'judge-batch.json'));
  await writeFile(path.join(output, 'job.json'), JSON.stringify({ job: 'w36-vlm-critique-' + '0'.repeat(12) }));
  await writeFile(path.join(output, 'results.jsonl'), requests.map(request => {
    const entry = metadata.entries.find(entry => entry.request_id === request.id);
    return JSON.stringify({ id: request.id, status: 200, usage, attempts: 1,
      transportAttempts: 1, transportPolicy: 'single-request-v1',
      content: invalid ? 'malformed' : JSON.stringify({ statements: entry.statements.map(statement => vote(statement.id)) }) }) + '\n';
  }).join(''));
  return requests;
}

test('W36 preregistration fixes gates and cannot change after writing', async t => {
  const data = await fixture(t);
  const before = await readPreregistration(data.cache);
  assert.equal(before.value.gates.minStatements, 140);
  assert.equal(before.value.gates.minEdits, 140);
  assert.equal(before.value.gates.statementPrecision, .9);
  assert.equal(before.sha256.length, 64);
  assert.deepEqual((await preregister(data.cache, { corpus: 'synthetic' })).value, before.value);
  await assert.rejects(preregister(data.cache, { corpus: 'changed' }), /immutable/);
  await writeFile(before.file, JSON.stringify({ ...before.value, gates: { ...POLICIES.gates, minStatements: 1 } }));
  await assert.rejects(readPreregistration(data.cache), /fixed W36/);
});

test('pilot selection is reproducible and bounded by unique photo IDs across cells', () => {
  const manifest = Array.from({ length: 40 }, (_, i) => ({ id: `p${i}`, set: 'photos' }));
  const rows = manifest.flatMap(item => ['A', 'B'].map(variant => ({ id: item.id, variant })));
  assert.deepEqual(selectPilot(rows, manifest), selectPilot([...rows].reverse(), [...manifest].reverse()).reverse());
  const pilot = selectPilot(rows, manifest);
  assert.equal(pilot.length, 40);
  assert.equal(new Set(pilot.map(row => row.id)).size, 20);
  assert.throws(() => selectPilot(rows, manifest, 21), /1..20/);
  assert.throws(() => selectPilot([], manifest), /no photo/);
});

test('judge prompts are model-blind and response IDs form a strict bijection', () => {
  const statements = [statement, { id: 'edit-1', kind: 'edit', category: 'crop/straighten', text: '裁去右侧空白' }];
  const prompt = judgePrompt(statements, [{ id: 'gaze', text: '看镜头' }]);
  assert.match(prompt, /768/);
  assert.match(prompt, /Lightroom/);
  assert.match(prompt, /看镜头/);
  assert.doesNotMatch(prompt, /hidden-local-model|variant|MiniCPM|Qwen/);
  const valid = { statements: statements.map(row => vote(row.id)) };
  assert.equal(validateJudgment(valid, statements), true);
  assert.equal(judgmentSchema(statements).properties.statements.minItems, 2);
  assert.equal(validateJudgment({ statements: [vote('issue-1'), vote('issue-1')] }, statements), false);
  assert.equal(validateJudgment({ statements: [vote('unknown'), vote('edit-1')] }, statements), false);
  assert.equal(validateJudgment({ statements: [vote('issue-1')] }, statements), false);
  assert.equal(validateJudgment({ statements: [{ ...vote('issue-1'), correctness: 'yes' }, vote('edit-1')] }, statements), false);
});

test('budget cap cannot exceed the user authorization or accept missing values', () => {
  for (const value of [0, -1, 1201, Infinity, NaN, '', undefined]) assert.throws(() => budgetCap(value));
  assert.equal(budgetCap('1200'), 1200);
  assert.equal(budgetCap('900'), 900);
});

test('request preparation judges primary asks, copies the same stripped derivative and hides model variant', async t => {
  const data = await fixture(t);
  const output = path.join(data.cache, 'pilot');
  const result = await prepareRequests({ ...data, output, rows: [...data.rows, { ...data.rows[0], ask: 1 }] });
  assert.deepEqual({ photos: result.photos, critiques: result.critiques, requests: result.requests },
    { photos: 2, critiques: 2, requests: 6 });
  const requests = await lines(path.join(output, 'requests.jsonl'));
  for (const request of requests) {
    assert.match(request.id, /^[0-9a-f]{64}$/);
    const content = JSON.stringify(request.body.messages);
    assert.doesNotMatch(content, /hidden-local-model|"variant"|prompt_sha256/);
    const image = request.body.messages[0].content[1].image_file;
    assert.deepEqual(await readFile(path.join(output, image)), await readFile(path.join(data.prepared, 'images/view.jpg')));
  }
  const config = await json(path.join(output, 'config.json'));
  assert.equal(config.strictBudget, true);
  assert.equal(config.inputTokenReserve, 16000);
  assert.equal(config.transportPolicy, 'single-request-v1');
  assert.equal(config.budgetCny, 1200);
  await assert.rejects(prepareRequests({ ...data, output }), /immutable/);
});

test('full judging requires the paid pilot and audits every known response including malformed output', async t => {
  const data = await fixture(t), pilot = path.join(data.cache, 'pilot');
  await assert.rejects(prepareRequests({ ...data, phase: 'full', output: path.join(data.cache, 'full') }), /pilot cost/);
  await prepareRequests({ ...data, output: pilot, plannedCritiques: 10 });
  await settle(pilot, { prompt_tokens: 100, completion_tokens: 20 }, true);
  const audit = await auditBudget(data.cache, { cap: 1200, plannedCritiques: 10 });
  assert.equal(audit.settledRequests, 6);
  assert.equal(audit.unresolvedRequests, 0);
  assert.equal(audit.spentCny, .00588);
  assert.equal(audit.pilot.costPerPhotoCny, .00294);
  assert.equal(audit.projectedTotalCny, .0294);
  assert.equal(audit.mayProceedFull, true);
  const collected = await collectJudgments(pilot);
  assert.equal(collected.valid, 0);
  assert.equal(collected.total, 6);
  const full = await prepareRequests({ ...data, phase: 'full', output: path.join(data.cache, 'full'), plannedCritiques: 10 });
  assert.equal(full.requests, 0, 'billed invalid responses are retained rather than silently retried');
});

test('invalid model outputs are recorded as excluded without buying judge requests or shrinking the plan', async t => {
  const data = await fixture(t), output = path.join(data.cache, 'pilot');
  const rows = [...data.rows,
    { ...data.rows[0], id: 'invalid-photo', critique: null, statements: [], parse_error: 'invalid_critique_json' },
    { ...data.rows[0], ask: 1, critique: null, statements: [] }];
  const result = await prepareRequests({ ...data, rows, output });
  assert.equal(result.requests, 6);
  assert.equal(result.excludedInvalidRows, 1);
  const metadata = await json(path.join(output, 'judge-batch.json'));
  assert.equal(metadata.primaryInputRows, 3);
  assert.equal(metadata.plannedCritiques, 3);
  assert.equal(metadata.excludedInvalidRows, 1);
});

test('paid judge cache identity binds the exact packaged derivative bytes', async t => {
  const data = await fixture(t), pilot = path.join(data.cache, 'pilot');
  await prepareRequests({ ...data, output: pilot });
  await settle(pilot);
  await sharp({ create: { width: 16, height: 12, channels: 3, background: '#def' } }).jpeg()
    .toFile(path.join(data.prepared, 'images/view.jpg'));
  const result = await prepareRequests({ ...data, phase: 'full', output: path.join(data.cache, 'new-image') });
  assert.equal(result.requests, 6);
});

test('missing failure usage remains reserved and prevents automatic full judging', async t => {
  const data = await fixture(t), output = path.join(data.cache, 'pilot');
  await prepareRequests({ ...data, output });
  await settle(output);
  const rows = await lines(path.join(output, 'results.jsonl'));
  rows[0] = { id: rows[0].id, status: 503, attempts: 1, transportAttempts: 1, transportPolicy: 'single-request-v1',
    reservedCny: .154, costStatus: 'reserved_unknown' };
  await writeFile(path.join(output, 'results.jsonl'), rows.map(row => JSON.stringify(row) + '\n').join(''));
  const audit = await auditBudget(data.cache, { cap: 1200 });
  assert.equal(audit.unresolvedRequests, 1);
  assert.equal(audit.outstandingCny, .154);
  assert.equal(audit.mayProceedFull, false);
  await assert.rejects(prepareRequests({ ...data, output: path.join(data.cache, 'full'), phase: 'full' }), /unresolved/);
});

test('projection over cap prevents full judging without lowering gates', async t => {
  const data = await fixture(t), output = path.join(data.cache, 'pilot');
  await prepareRequests({ ...data, output });
  await settle(output);
  const audit = await auditBudget(data.cache, { cap: .01, plannedCritiques: 100 });
  assert.equal(audit.mayProceedFull, false);
  assert.ok(audit.projectedTotalCny > audit.capCny);
  assert.equal((await readPreregistration(data.cache)).value.gates.statementPrecision, .9);
});

test('judge receipts normalize novelty for the core and reject duplicate IDs', async t => {
  const data = await fixture(t), output = path.join(data.cache, 'pilot');
  await prepareRequests({ ...data, output });
  await settle(output);
  const result = await collectJudgments(output);
  assert.equal(result.valid, 6);
  assert.equal(result.judgments[0].statements[0].novelty, '新增');
  const receipts = await readFile(path.join(output, 'results.jsonl'), 'utf8');
  await writeFile(path.join(output, 'results.jsonl'), receipts + receipts.split('\n')[0] + '\n');
  await assert.rejects(collectJudgments(output), /duplicate/);
  await assert.rejects(auditBudget(data.cache, { cap: 1200 }), /duplicate/);
});

test('image and output safety reject oversized, metadata-bearing, mixed-storage and escaping inputs', async t => {
  const data = await fixture(t), file = path.join(data.prepared, 'images/view.jpg');
  await sharp({ create: { width: 769, height: 20, channels: 3, background: '#abc' } }).jpeg().toFile(file);
  await assert.rejects(prepareRequests({ ...data, output: path.join(data.cache, 'oversize') }), /stripped/);
  await sharp({ create: { width: 16, height: 12, channels: 3, background: '#abc' } }).withMetadata().jpeg().toFile(file);
  await assert.rejects(prepareRequests({ ...data, output: path.join(data.cache, 'metadata') }), /stripped/);
  await sharp({ create: { width: 16, height: 12, channels: 3, background: '#abc' } }).jpeg().toFile(file);
  const mixed = [data.manifest[0], { ...data.manifest[1], storage: 'ceph', imageRoot: 'public/corpus' }];
  await assert.rejects(prepareRequests({ ...data, manifest: mixed, output: path.join(data.cache, 'mixed') }), /separate/);
  await assert.rejects(prepareRequests({ ...data, output: path.join(data.root, 'outside') }), /stay/);
  await symlink(data.root, path.join(data.cache, 'escape'));
  await assert.rejects(prepareRequests({ ...data, output: path.join(data.cache, 'escape', 'child') }), /escape/);
});

test('blinded sheet uses 30 distinct photos and hides model identity with a separate key', async t => {
  const data = await fixture(t, 32), output = path.join(data.cache, 'blind.html'), keyFile = path.join(data.cache, 'blind-key.json');
  const result = await blindedSheet({ ...data, output, keyFile });
  assert.equal(result.photos, 30);
  const html = await readFile(output, 'utf8'), key = await json(keyFile);
  assert.doesNotMatch(html, /hidden-local-model|"variant"|photo-\d/);
  assert.equal(new Set(key.map(row => row.item_id)).size, 30);
  assert.equal(key[0].model, 'hidden-local-model');
});

function python(code) {
  const result = spawnSync('python3', ['-c', code], { encoding: 'utf8', env: { ...process.env, PYTHONDONTWRITEBYTECODE: '1' } });
  assert.equal(result.status, 0, result.stderr || result.stdout);
}
const load = file => `import importlib.util, tempfile, json\nfrom pathlib import Path\n`
  + `spec=importlib.util.spec_from_file_location('subject', '${file}')\n`
  + `m=importlib.util.module_from_spec(spec); spec.loader.exec_module(m)\n`;

test('AIHub W36 admission uses the shared lock and refuses duplicate teachers or a fourth project job', () => {
  python(load('scripts/aihub-ray.py') + `
with tempfile.TemporaryDirectory() as tmp:
 m.LOCK=Path(tmp)/'lock'
 calls=[]
 def request(path, body=None):
  assert m.LOCK.exists()
  assert json.loads((m.LOCK/'owner.json').read_text())['line']=='w36-vlm-critique'
  calls.append(path)
  return [] if body is None else {'submitted':True}
 m.request=request
 assert m.submit_locked({},line='w36-vlm-critique')=={'submitted':True}
 assert not m.LOCK.exists() and len(calls)==2
 m.request=lambda *a,**kw:[{'submission_id':'w36-vlm-critique-'+'0'*12,'status':'PENDING',
  'metadata':{'ecp_job_kind':'teacher','ecp_requested_gpus':'0'}}]
 try:m.submit_locked({},line='w36-vlm-critique')
 except RuntimeError:pass
 else:raise AssertionError('own overlap admitted')
 assert not m.LOCK.exists()
 m.request=lambda *a,**kw:[{'submission_id':'w1-a','status':'RUNNING'},{'submission_id':'w39-b','status':'PENDING'},
  {'submission_id':'w28-aihub-c','status':'RUNNING','metadata':{'ecp_job_kind':'teacher','ecp_requested_gpus':'0'}}]
 try:m.submit_locked({},line='w36-vlm-critique',wait_seconds=0)
 except TimeoutError:pass
 else:raise AssertionError('project overlap admitted')
 assert not m.LOCK.exists()
 assert m.checked_job('w36-vlm-critique-'+'0'*12,'w36-vlm-critique')
 try:m.checked_job('w28-aihub-'+'0'*12,'w36-vlm-critique')
 except ValueError:pass
 else:raise AssertionError('foreign job accepted')
`);
});

test('strict AIHub budget retains unknown spend, makes one attempt and sanitizes failures', () => {
  python(load('scripts/aihub-ray-worker.py') + `
config={'strictBudget':True,'inputTokenReserve':16000,'budgetCny':.16,'pauseSeconds':0,
        'pricing':{'synthetic':{'input':1,'output':2,'usdToCny':7}}}
runner=m.Runner({'url':'unused','key':'unused'},config)
calls=[]
def attempt(body):
 calls.append(body)
 return None,{'status':503,'error':'HTTPError'}
runner.attempt=attempt
m.time.sleep=lambda *a:None
row={'id':'one','body':{'model':'synthetic','max_completion_tokens':3000,'messages':[]}}
result=runner.run(row)
assert result['attempts']==1 and result['costStatus']=='reserved_unknown'
assert len(calls)==1 and abs(runner.spent-.154)<1e-9
assert runner.run({'id':'two','body':row['body']})['status']=='budget'
assert len(calls)==1
runner=m.Runner({'url':'unused','key':'unused'},config)
runner.attempt=lambda body:({'usage':{'prompt_tokens':100,'completion_tokens':20},'choices':[{'message':{'content':'{}'}}]},None)
assert runner.run(row)['status']==200
assert abs(runner.spent-.00098)<1e-9
`);
});

test('W36 submit checks preregistration, cumulative authorization and pilot completion before packaging a key', () => {
  python(load('scripts/aihub-ray.py') + `
import hashlib, os, types
with tempfile.TemporaryDirectory() as tmp:
 m.ROOT=Path(tmp)
 cache=m.ROOT/'data/cache/w36-vlm-critique';cache.mkdir(parents=True)
 work=cache/'batch';work.mkdir()
 raw=b'{"fixed":true}'
 (cache/'preregistration.json').write_bytes(raw)
 metadata={'phase':'pilot','plannedCritiques':2346,'selectedPhotos':['one'],
           'preregistrationSha256':hashlib.sha256(raw).hexdigest()}
 (work/'judge-batch.json').write_text(json.dumps(metadata))
 audit={'spentCny':0,'outstandingCny':0,'pilot':{'photos':0},'mayProceedFull':False}
 m.subprocess.run=lambda *a,**kw:types.SimpleNamespace(returncode=0,stdout=json.dumps(audit))
 os.environ['ECP_AIHUB_BUDGET_RMB']='1200'
 config={'strictBudget':True,'inputTokenReserve':16000,'budgetCny':1200,'transportPolicy':'single-request-v1'}
 for policy in (None,'legacy-two-route'):
  invalid={**config};invalid['transportPolicy']=policy
  try:m.validate_w36_batch(work,invalid)
  except ValueError as error:assert 'single-request-v1' in str(error)
  else:raise AssertionError('unsupported transport policy admitted before packaging')
 m.validate_w36_batch(work,config)
 audit['spentCny']=1
 try:m.validate_w36_batch(work,config)
 except ValueError:pass
 else:raise AssertionError('cumulative overspend admitted')
 audit['spentCny']=0;metadata['phase']='full'
 (work/'judge-batch.json').write_text(json.dumps(metadata))
 try:m.validate_w36_batch(work,config)
 except ValueError:pass
 else:raise AssertionError('missing paid pilot admitted')
 audit['mayProceedFull']=True
 m.validate_w36_batch(work,config)
 (work/'job.json').write_text('{}')
 try:m.validate_w36_batch(work,config)
 except ValueError:pass
 else:raise AssertionError('same batch resubmitted')
`);
});

test('AIHub failures never include response bodies or exception URLs in result logs', () => {
  python(load('scripts/aihub-ray-worker.py') + `
import io
runner=m.Runner({'url':'unused','key':'unused'}, {})
def fail(*args):
 raise m.urllib.error.HTTPError('https://example.invalid/private',400,'private-detail',{},io.BytesIO(b'private-response-body'))
m.call=fail
response,failure=runner.attempt({})
assert response is None and failure=={'status':400,'error':'HTTPError'}
def fail_network(*args):raise OSError('private-network-detail')
m.call=fail_network
response,failure=runner.attempt({})
assert response is None and failure=={'status':0,'error':'OSError'}
`);
});

test('teacher submission persists the exact job before POST and leaves ambiguous submissions fail-closed', () => {
  python(load('scripts/aihub-ray.py') + `
with tempfile.TemporaryDirectory() as tmp:
 work=Path(tmp);job='w36-vlm-critique-'+'a'*12
 body={'submission_id':job,'entrypoint':'python worker.py'}
 def interrupted(body, line, before_submit):
  before_submit()
  record=json.loads((work/'job.json').read_text())
  assert record=={'job':job,'package':'synthetic.zip','phase':'submitting'}
  assert line=='w36-vlm-critique'
  raise OSError('response lost after accepted POST')
 m.submit_locked=interrupted
 try:m.submit_recorded(work,body,'synthetic.zip',line='w36-vlm-critique')
 except OSError:pass
 else:raise AssertionError('ambiguous submission ignored')
 assert json.loads((work/'job.json').read_text())['phase']=='submitting'
 calls=[]
 m.submit_locked=lambda *a,**kw:calls.append(a) or {'submitted':True}
 try:m.submit_recorded(work,body,'synthetic.zip',line='w36-vlm-critique')
 except FileExistsError:pass
 else:raise AssertionError('ambiguous batch resubmitted')
 assert not calls
with tempfile.TemporaryDirectory() as tmp:
 work=Path(tmp)
 def accepted(body,line,before_submit):
  before_submit()
  assert json.loads((work/'job.json').read_text())['phase']=='submitting'
  return {'submitted':True}
 m.submit_locked=accepted
 assert m.submit_recorded(work,body,'synthetic.zip',line='w36-vlm-critique')=={'submitted':True}
 assert json.loads((work/'job.json').read_text())=={
  'job':job,'package':'synthetic.zip','phase':'submitted','response':{'submitted':True}}
 assert sorted(p.name for p in work.iterdir())==['job.json']
`);
});

async function fullWithUnknown(t, { inputReserve = 16000, maxTokens = 3000 } = {}) {
  const data = await fixture(t), pilot = path.join(data.cache, 'pilot'), full = path.join(data.cache, 'full');
  await prepareRequests({ ...data, output: pilot, plannedCritiques: 10 });
  await settle(pilot);
  const rows = data.rows.map(row => ({ ...row, model: 'second-local-model' }));
  await prepareRequests({ ...data, rows, output: full, phase: 'full', plannedCritiques: 10 });
  const config = await json(path.join(full, 'config.json'));
  config.inputTokenReserve = inputReserve;
  await writeFile(path.join(full, 'config.json'), JSON.stringify(config));
  const requests = await lines(path.join(full, 'requests.jsonl'));
  for (const request of requests) request.body.max_completion_tokens = maxTokens;
  await writeFile(path.join(full, 'requests.jsonl'), requests.map(row => JSON.stringify(row) + '\n').join(''));
  await settle(full);
  const results = await lines(path.join(full, 'results.jsonl'));
  const reservedCny = (inputReserve + maxTokens * 2) / 1e6 * 7;
  results[0] = { id: results[0].id, status: 400, error: 'HTTPError', attempts: 1,
    transportAttempts: 1, transportPolicy: 'single-request-v1', reservedCny, costStatus: 'reserved_unknown' };
  await writeFile(path.join(full, 'results.jsonl'), results.map(row => JSON.stringify(row) + '\n').join(''));
  return { ...data, rows, full, results, reservedCny };
}

test('returned single-transport unknown full-phase costs carry their bound and reduce every later worker budget', async t => {
  const data = await fullWithUnknown(t), audit = await auditBudget(data.cache, { cap: 1200, plannedCritiques: 10 });
  assert.equal(audit.spentCny, .01078);
  assert.equal(audit.carriedUnknownRequests, 1);
  assert.equal(audit.carriedUnknownCny, .154);
  assert.equal(audit.outstandingCny, .154);
  assert.equal(audit.pendingRequests, 0);
  assert.equal(audit.unboundedRequests, 0);
  assert.equal(audit.mayProceedFull, true);
  assert.equal(audit.submittedPlannedCritiques, 4);
  assert.equal(audit.remainingPlannedCritiques, 6);
  assert.equal(audit.projectedWithReservationsCny, audit.committedMaximumCny + audit.projectedRemainingCny);
  const next = path.join(data.cache, 'next');
  await prepareRequests({ ...data, rows: data.rows.map(row => ({ ...row, model: 'third-local-model' })),
    output: next, phase: 'full', plannedCritiques: 10 });
  assert.equal((await json(path.join(next, 'config.json'))).budgetCny, 1200 - audit.spentCny - audit.outstandingCny);
  const same = await prepareRequests({ ...data, output: path.join(data.cache, 'same'), phase: 'full', plannedCritiques: 10 });
  assert.equal(same.requests, 0, 'the failed returned request is never repurchased');
  assert.equal((await readPreregistration(data.cache)).value.gates.statementPrecision, .9);
});

test('a pending full-phase call remains blocking while its reservation stays separate from returned uncertainty', async t => {
  const data = await fullWithUnknown(t);
  await writeFile(path.join(data.full, 'results.jsonl'), data.results.slice(0, -1).map(row => JSON.stringify(row) + '\n').join(''));
  const audit = await auditBudget(data.cache, { cap: 1200, plannedCritiques: 10 });
  assert.equal(audit.carriedUnknownRequests, 1);
  assert.equal(audit.pendingRequests, 1);
  assert.equal(audit.pendingCny, .154);
  assert.equal(audit.outstandingCny, .308);
  assert.equal(audit.mayProceedFull, false);
});

test('continuation requires both the committed upper bound and the forecast plus all reservations to fit', async t => {
  const data = await fullWithUnknown(t);
  const forecastOver = await auditBudget(data.cache, { cap: .17, plannedCritiques: 10 });
  assert.ok(forecastOver.committedMaximumCny < .17);
  assert.ok(forecastOver.projectedWithReservationsCny > .17);
  assert.equal(forecastOver.mayProceedFull, false);
  const committedOver = await auditBudget(data.cache, { cap: .163, plannedCritiques: 4 });
  assert.equal(committedOver.projectedRemainingCny, 0);
  assert.equal(committedOver.projectedWithReservationsCny, committedOver.committedMaximumCny);
  assert.ok(committedOver.committedMaximumCny > .163);
  assert.equal(committedOver.mayProceedFull, false);
});

test('unknown reservations use actual saved token bounds and fail closed on insufficient or untrusted bounds', async t => {
  const data = await fullWithUnknown(t, { inputReserve: 32000 });
  const before = await auditBudget(data.cache, { cap: 1200, plannedCritiques: 10 });
  assert.equal(before.carriedUnknownCny, .266);
  assert.equal(before.mayProceedFull, true);
  for (const patch of [{ reservedCny: .154 }, { attempts: 2 }, { costStatus: undefined }]) {
    const rows = data.results.map((row, index) => index ? row : { ...row, ...patch });
    await writeFile(path.join(data.full, 'results.jsonl'), rows.map(row => JSON.stringify(row) + '\n').join(''));
    const audit = await auditBudget(data.cache, { cap: 1200, plannedCritiques: 10 });
    assert.equal(audit.carriedUnknownRequests, 0);
    assert.equal(audit.unboundedRequests, 1);
    assert.equal(audit.mayProceedFull, false);
  }
});

test('observed usage over either saved token bound invalidates automatic continuation', async t => {
  const data = await fullWithUnknown(t);
  for (const usage of [{ prompt_tokens: 16001, completion_tokens: 20 }, { prompt_tokens: 100, completion_tokens: 3001 }]) {
    const rows = data.results.map((row, index) => index === 1 ? { ...row, usage } : row);
    await writeFile(path.join(data.full, 'results.jsonl'), rows.map(row => JSON.stringify(row) + '\n').join(''));
    const audit = await auditBudget(data.cache, { cap: 1200, plannedCritiques: 10 });
    assert.equal(audit.unboundedRequests, 1);
    assert.equal(audit.mayProceedFull, false);
  }
});

test('invalid pricing and an unsupported saved reservation never produce an approving audit', async t => {
  const data = await fullWithUnknown(t), file = path.join(data.full, 'config.json'), config = await json(file);
  await writeFile(file, JSON.stringify({ ...config, strictBudget: false }));
  const unsupported = await auditBudget(data.cache, { cap: 1200, plannedCritiques: 10 });
  assert.ok(unsupported.unboundedRequests > 0);
  assert.equal(unsupported.mayProceedFull, false);
  assert.equal(unsupported.committedMaximumCny, null);
  assert.equal(unsupported.projectedWithReservationsCny, null);
  assert.equal(unsupported.remainingBudgetCny, 0);
  config.pricing[Object.keys(config.pricing)[0]].input = -1;
  await writeFile(file, JSON.stringify(config));
  await assert.rejects(auditBudget(data.cache, { cap: 1200, plannedCritiques: 10 }), /valid saved pricing/);
});

test('strict worker sends one transport, retaining a lost-response charge and rotating only the next request', () => {
  python(load('scripts/aihub-ray-worker.py') + `
config={'strictBudget':True,'transportPolicy':'single-request-v1','inputTokenReserve':16000,
        'budgetCny':2,'pauseSeconds':0,'pricing':{'synthetic':{'input':1,'output':2,'usdToCny':7}}}
runner=m.Runner({'url':'unused','key':'unused'},config)
runner.routes=['direct','proxy'];calls=[]
def call(url,key,body,proxy):
 calls.append((body['tag'],proxy))
 if proxy=='direct':raise TimeoutError('first request may already have been billed')
 return {'usage':{'prompt_tokens':100,'completion_tokens':20},'choices':[{'message':{'content':'{}'}}]}
m.call=call
body={'model':'synthetic','max_completion_tokens':3000,'messages':[]}
first=runner.run({'id':'first','body':{**body,'tag':'first'}})
assert calls==[('first','direct')]
assert first['status']==0 and first['transportAttempts']==1 and first['attempts']==1
assert first['transportPolicy']=='single-request-v1' and first['reservedCny']==.154
assert abs(runner.spent-.154)<1e-9
second=runner.run({'id':'second','body':{**body,'tag':'second'}})
assert calls==[('first','direct'),('second','proxy')]
assert second['status']==200 and second['transportAttempts']==1 and second['attempts']==1
assert abs(runner.spent-(.154+.00098))<1e-9
`);
});

test('non-strict legacy transport still permits a known success after a lost first-route response', () => {
  python(load('scripts/aihub-ray-worker.py') + `
runner=m.Runner({'url':'unused','key':'unused'},{})
runner.routes=['direct','proxy'];calls=[]
def call(url,key,body,proxy):
 calls.append(proxy)
 if proxy=='direct':raise TimeoutError('possibly billed first route')
 return {'usage':{'prompt_tokens':100,'completion_tokens':20},'choices':[{'message':{'content':'{}'}}]}
m.call=call
response,failure=runner.attempt({'messages':[]})
assert calls==['direct','proxy'] and failure is None and response['usage']['prompt_tokens']==100
`);
});

async function legacyBatch(output) {
  const config = await json(path.join(output, 'config.json'));
  delete config.transportPolicy;
  await writeFile(path.join(output, 'config.json'), JSON.stringify(config));
  const receipts = await lines(path.join(output, 'results.jsonl'));
  for (const row of receipts) { delete row.transportPolicy; delete row.transportAttempts; }
  await writeFile(path.join(output, 'results.jsonl'), receipts.map(row => JSON.stringify(row) + '\n').join(''));
}

test('legacy known success adds one lost-route maximum while legacy unknown retains both routes', async t => {
  const data = await fullWithUnknown(t);
  await legacyBatch(data.full);
  const audit = await auditBudget(data.cache, { cap: 1200, plannedCritiques: 10 });
  assert.equal(audit.spentCny, .01078);
  assert.equal(audit.legacyRouteRequests, 5);
  assert.equal(audit.legacyRouteCny, .77);
  assert.equal(audit.carriedUnknownCny, .308);
  assert.equal(audit.outstandingCny, 1.078);
  assert.equal(audit.mayProceedFull, true);
  const next = path.join(data.cache, 'next');
  await prepareRequests({ ...data, output: next, rows: data.rows.map(row => ({ ...row, model: 'third-model' })), phase: 'full',
    plannedCritiques: 10 });
  assert.equal((await json(path.join(next, 'config.json'))).budgetCny, 1200 - audit.spentCny - 1.078);
});

test('legacy pilot routing uncertainty is separate from confirmed spend and can block future paid batches', async t => {
  const data = await fixture(t), pilot = path.join(data.cache, 'pilot');
  await prepareRequests({ ...data, output: pilot, plannedCritiques: 10 });
  await settle(pilot);
  await legacyBatch(pilot);
  const audit = await auditBudget(data.cache, { cap: .952, plannedCritiques: 10 });
  assert.equal(audit.spentCny, .00588);
  assert.equal(audit.pilot.unresolvedRequests, 0);
  assert.equal(audit.pilot.legacyRouteCny, .924);
  assert.equal(audit.pilot.maximumCny, .92988);
  assert.ok(audit.committedMaximumCny < .952);
  assert.ok(audit.projectedWithReservationsCny > .952);
  assert.equal(audit.mayProceedFull, false);
});

test('mixed continuation forecast counts submitted plan keys and their uncertainty only once', async t => {
  const data = await fullWithUnknown(t);
  await legacyBatch(data.full);
  const audit = await auditBudget(data.cache, { cap: 1200, plannedCritiques: 10 });
  assert.equal(audit.submittedPlannedCritiques, 4, 'three teacher entries share one model, variant and image plan key');
  assert.equal(audit.remainingPlannedCritiques, 6);
  const unit = audit.pilot.spentCny / audit.pilot.critiques;
  assert.equal(audit.projectedRemainingCny, unit * 6);
  assert.equal(audit.projectedWithReservationsCny, audit.committedMaximumCny + unit * 6);
  assert.notEqual(audit.projectedWithReservationsCny, audit.projectedTotalCny + audit.outstandingCny);
  const complete = await auditBudget(data.cache, { cap: 1200, plannedCritiques: 4 });
  assert.equal(complete.projectedRemainingCny, 0);
  assert.equal(complete.projectedWithReservationsCny, complete.committedMaximumCny);
});

const digest = value => createHash('sha256').update(value).digest('hex');
async function resumeFixture(t, cap = 8) {
  const data = await fixture(t, 200), pilot = path.join(data.cache, 'pilot');
  await prepareRequests({ ...data, rows: data.rows.slice(0, 2), output: pilot });
  await settle(pilot);
  const receipts = await lines(path.join(pilot, 'results.jsonl'));
  await writeFile(path.join(pilot, 'results.jsonl'), receipts.slice(0, -1).map(row => JSON.stringify(row) + '\n').join(''));
  await mkdir(path.join(data.cache, 'prepared'));
  const cohort = data.manifest.map(item => item.id);
  await writeFile(path.join(data.cache, 'resume-cohort.json'), JSON.stringify(cohort));
  await writeFile(path.join(data.cache, 'prepared/manifest.jsonl'), data.manifest.map(row => JSON.stringify(row) + '\n').join(''));
  const pricing = (await json(path.join(pilot, 'config.json'))).pricing;
  await writeFile(path.join(data.cache, 'resume-pricing.json'), JSON.stringify(pricing));
  const artifact = async file => ({ file, sha256: digest(await readFile(path.join(data.cache, file))) });
  const boundary = { dir: 'pilot' };
  for (const [name, key] of [['requests.jsonl', 'requestsSha256'], ['config.json', 'configSha256'], ['job.json', 'jobSha256'],
    ['results.jsonl', 'resultsSha256']]) {
    boundary[key] = digest(await readFile(path.join(pilot, name)));
  }
  const draft = { schemaVersion: 1, id: 'resume-200-v1', createdAt: '2026-10-18T00:00:00Z',
    preregistrationSha256: (await readPreregistration(data.cache)).sha256,
    promptSha256: digest(await readFile('ml/observe/prompts/critique-v1.md')), promptVersion: '1.0.1',
    manifest: await artifact('prepared/manifest.jsonl'), cohort: { ...await artifact('resume-cohort.json'), count: 200, set: 'photos' },
    pricing: await artifact('resume-pricing.json'), budget: { incrementalCny: cap, totalCny: 2000 },
    models: ['openbmb/MiniCPM-V-4.7-35B-A3B-int4', 'Qwen/Qwen3.6-35B-A3B'], legacyBatches: [boundary] };
  const input = path.join(data.cache, 'resume-plan-draft.json'), resumePlan = path.join(data.cache, 'resume-plan.json');
  await writeFile(input, JSON.stringify(draft, null, 2) + '\n');
  await freezeResumePlan(data.cache, input, resumePlan);
  const rows = data.rows.flatMap(row => ['A', 'B'].map(variant =>
    ({ ...row, model: draft.models[0], variant, prompt_sha256: draft.promptSha256 })));
  return { ...data, rows, pilot, input, resumePlan, draft, authorizationCny: 2000 };
}

test('immutable resume plan binds cohort, prices, legacy paid boundary, prompt and original preregistration', async t => {
  const data = await resumeFixture(t);
  const plan = await readResumePlan(data.cache, data.resumePlan);
  assert.equal(plan.cohort.length, 200);
  await assert.rejects(freezeResumePlan(data.cache, data.input, data.resumePlan), /EEXIST/);
  await writeFile(path.join(data.cache, 'resume-cohort.json'), JSON.stringify(plan.cohort.slice(1)));
  await assert.rejects(readResumePlan(data.cache, data.resumePlan), /checksum/);
});

test('campaign ignores old unresolved costs, buys identical A/B cohort prefixes and auto-splits to its hard budget', async t => {
  const data = await resumeFixture(t), output = path.join(data.cache, 'resume-mini-1');
  assert.equal((await auditBudget(data.cache, { cap: 1200 })).mayProceedFull, false);
  const initial = await auditResumeBudget(data.cache, data.resumePlan, data);
  assert.equal(initial.spentCny, 0);
  assert.equal(initial.outstandingCny, 0);
  assert.equal(initial.remainingBudgetCny, 8);
  assert.equal(initial.maySubmit, true);
  const result = await prepareRequests({ ...data, output });
  assert.equal(result.photos, 8);
  assert.equal(result.requests, 48);
  assert.equal(result.critiques, 16, 'budget-trimmed batch reports purchased critiques rather than the 400 input critiques');
  assert.ok(result.reservedMaximumCny < 8);
  assert.ok(result.estimatedCostCny < result.reservedMaximumCny);
  const metadata = await json(path.join(output, 'judge-batch.json'));
  assert.equal(metadata.resumePlanSha256, initial.resumePlanSha256);
  assert.equal(metadata.estimateHeadroom, 1.25);
  assert.deepEqual([...new Set(metadata.entries.filter(row => row.variant === 'A').map(row => row.item_id))],
    [...new Set(metadata.entries.filter(row => row.variant === 'B').map(row => row.item_id))]);
  const validated = await validateResumeBatch(data.cache, data.resumePlan, output, data);
  assert.equal(validated.candidateRequests, 48);
  await settle(output);
  const paid = await auditResumeBudget(data.cache, data.resumePlan, data);
  assert.equal(paid.knownRequests, 48);
  assert.ok(paid.spentCny > 0 && paid.spentCny < 1);
  assert.equal(paid.outstandingCny, 0);
  const second = path.join(data.cache, 'resume-mini-2');
  await prepareRequests({ ...data, output: second });
  const next = await json(path.join(second, 'judge-batch.json'));
  assert.ok(next.entries.every(row => !metadata.selectedPhotos.includes(row.item_id)));
  assert.equal((await json(path.join(second, 'config.json'))).budgetCny, 8 - paid.spentCny);
});

test('campaign reserves every new unknown and pending call and rejects replay, drift and Qwen-first submission', async t => {
  const data = await resumeFixture(t), output = path.join(data.cache, 'resume-mini');
  await assert.rejects(prepareRequests({ ...data, rows: data.rows.map(row => ({ ...row, model: data.draft.models[1] })), output }),
    /MiniCPM before Qwen/);
  await prepareRequests({ ...data, output, resumePhotos: 1 });
  await settle(output);
  const rows = await lines(path.join(output, 'results.jsonl'));
  rows[0] = { id: rows[0].id, status: 400, attempts: 1, transportPolicy: 'single-request-v1', transportAttempts: 1,
    costStatus: 'reserved_unknown', reservedCny: .154 };
  await writeFile(path.join(output, 'results.jsonl'), rows.slice(0, -1).map(row => JSON.stringify(row) + '\n').join(''));
  const audit = await auditResumeBudget(data.cache, data.resumePlan, data);
  assert.equal(audit.outstandingCny, .308);
  assert.equal(audit.pendingRequests, 1);
  assert.equal(audit.remainingBudgetCny, 8 - audit.spentCny - .308);
  await assert.rejects(validateResumeBatch(data.cache, data.resumePlan, output, data), /submitted/);
  const requests = await lines(path.join(output, 'requests.jsonl'));
  requests[0].body.max_completion_tokens = 4000;
  await writeFile(path.join(output, 'requests.jsonl'), requests.map(row => JSON.stringify(row) + '\n').join(''));
  await assert.rejects(auditResumeBudget(data.cache, data.resumePlan, data), /checksum/);
});

test('resume submission validator calls campaign audit before packaging and keeps the default 1200 cap unchanged', () => {
  python(load('scripts/aihub-ray.py') + `
import hashlib,os,types
with tempfile.TemporaryDirectory() as tmp:
 m.ROOT=Path(tmp);cache=m.ROOT/'data/cache/w36-vlm-critique';cache.mkdir(parents=True)
 work=cache/'resume-mini';work.mkdir()
 raw=b'{}';(cache/'preregistration.json').write_bytes(raw)
 (work/'judge-batch.json').write_text(json.dumps({'preregistrationSha256':hashlib.sha256(raw).hexdigest(),
  'resumePlanFile':'resume-plan.json'}))
 os.environ['ECP_AIHUB_BUDGET_RMB']='2000'
 config={'strictBudget':True,'inputTokenReserve':16000,'budgetCny':400,'transportPolicy':'single-request-v1'}
 calls=[]
 def audit(argv,**kw):
  calls.append(argv)
  return types.SimpleNamespace(returncode=0,stdout=json.dumps({'maySubmit':True,'candidateMaximumCny':300,'remainingBudgetCny':400}))
 m.subprocess.run=audit
 m.validate_w36_batch(work,config)
 assert 'audit-resume' in calls[0] and '--batch' in calls[0]
 m.subprocess.run=lambda *a,**kw:types.SimpleNamespace(returncode=1,stdout='')
 try:m.validate_w36_batch(work,config)
 except ValueError:pass
 else:raise AssertionError('failed campaign audit admitted')
 (work/'judge-batch.json').write_text(json.dumps({'preregistrationSha256':hashlib.sha256(raw).hexdigest()}))
 try:m.validate_w36_batch(work,config)
 except ValueError:pass
 else:raise AssertionError('legacy cap silently raised')
`);
});

test('campaign admission revalidates budget while holding the Ray lock before recording or sending the job', () => {
  python(load('scripts/aihub-ray.py') + `
with tempfile.TemporaryDirectory() as tmp:
 m.LOCK=Path(tmp)/'lock';work=Path(tmp)/'work';work.mkdir()
 calls=[]
 def request(path,body=None):
  assert m.LOCK.exists()
  if body is None:return []
  assert json.loads((work/'job.json').read_text())['phase']=='submitting'
  calls.append('POST');return {'submitted':True}
 m.request=request
 def validate():
  assert m.LOCK.exists() and not (work/'job.json').exists()
  calls.append('validate')
 body={'submission_id':'w36-vlm-critique-'+'a'*12}
 m.submit_recorded(work,body,'synthetic.zip',line='w36-vlm-critique',validate=validate)
 assert calls==['validate','POST'] and not m.LOCK.exists()
with tempfile.TemporaryDirectory() as tmp:
 m.LOCK=Path(tmp)/'lock';work=Path(tmp)/'work';work.mkdir();calls=[]
 def validate():
  assert m.LOCK.exists()
  raise ValueError('new receipt consumed the available campaign balance')
 try:m.submit_recorded(work,body,'synthetic.zip',line='w36-vlm-critique',validate=validate)
 except ValueError:pass
 else:raise AssertionError('stale candidate budget admitted')
 assert not (work/'job.json').exists() and not m.LOCK.exists() and not calls
`);
});

test('resume caps, authorization and candidate worker allocation fail closed independently of legacy costs', async t => {
  const data = await resumeFixture(t), output = path.join(data.cache, 'resume-mini');
  await assert.rejects(auditResumeBudget(data.cache, data.resumePlan, { authorizationCny: 1200 }), /explicit/);
  await prepareRequests({ ...data, output, resumePhotos: 1 });
  const configFile = path.join(output, 'config.json'), metadataFile = path.join(output, 'judge-batch.json');
  const config = await json(configFile), metadata = await json(metadataFile);
  config.budgetCny = 8.01;
  await writeFile(configFile, JSON.stringify(config));
  metadata.configSha256 = digest(await readFile(configFile));
  await writeFile(metadataFile, JSON.stringify(metadata));
  await assert.rejects(validateResumeBatch(data.cache, data.resumePlan, output, data), /incremental authorization/);
  const draft = { ...data.draft, budget: { ...data.draft.budget, incrementalCny: 401 } };
  await writeFile(data.input, JSON.stringify(draft));
  await assert.rejects(readResumePlan(data.cache, data.input), /invalid immutable/);
});

test('a changed legacy paid boundary or a request outside the fixed cohort cannot enter the campaign', async t => {
  const data = await resumeFixture(t), output = path.join(data.cache, 'resume-mini');
  const invalid = data.rows.filter(row => !(row.id === 'photo-0' && row.variant === 'B'));
  await assert.rejects(prepareRequests({ ...data, rows: invalid, output }), /both variants/);
  const legacyResults = path.join(data.pilot, 'results.jsonl');
  await writeFile(legacyResults, await readFile(legacyResults, 'utf8') + '\n');
  await assert.rejects(auditResumeBudget(data.cache, data.resumePlan, data), /legacy boundary checksum/);
});

async function fullCampaignFixture(t, totalCny = 2000) {
  const data = await resumeFixture(t), manifest = [...data.manifest,
    ...Array.from({ length: 91 }, (_, i) => ({ ...data.manifest[0], id: `photo-${i + 200}` })),
    ...Array.from({ length: 200 }, (_, i) => ({ id: `openimages-${i}`, set: 'openimages', storage: 'ceph',
      imageRoot: 'public/openimages', images: { full: `views/image-${i}.jpg` }, specialist_facts: [] }))];
  const cohort = manifest.map(item => item.id);
  await writeFile(path.join(data.cache, 'full-cohort.json'), JSON.stringify(cohort));
  await writeFile(path.join(data.cache, 'full-manifest.jsonl'), manifest.map(row => JSON.stringify(row) + '\n').join(''));
  const draft = { ...data.draft, schemaVersion: 2, id: 'full-900-v1',
    manifest: { file: 'full-manifest.jsonl', sha256: digest(await readFile(path.join(data.cache, 'full-manifest.jsonl'))) },
    cohort: { file: 'full-cohort.json', sha256: digest(await readFile(path.join(data.cache, 'full-cohort.json'))), count: 491,
      set: 'manifest', bySet: { photos: 291, openimages: 200 }, variants: { photos: ['A', 'B'], openimages: ['A'] } },
    budget: { incrementalCny: 900, totalCny }, concurrency: { flash: 8, gpt: 4, claude: 4 },
    authorization: { type: 'full-900', allowConservativeBoundExceedance: true,
      reason: 'Explicit full manifest evaluation authorization' } };
  const input = path.join(data.cache, 'full-900-draft.json'), resumePlan = path.join(data.cache, 'full-900-plan.json');
  await writeFile(input, JSON.stringify(draft));
  await freezeResumePlan(data.cache, input, resumePlan);
  const rows = manifest.flatMap(item => (item.set === 'photos' ? ['A', 'B'] : ['A']).map(variant =>
    ({ ...data.rows[0], id: item.id, variant, model: draft.models[0], prompt_sha256: draft.promptSha256 })));
  return { ...data, oldPlan: data.resumePlan, manifest, rows, draft, input, resumePlan };
}

async function settleFull(output) {
  await settle(output);
  const rows = await lines(path.join(output, 'results.jsonl'));
  for (const row of rows) {
    Object.assign(row, { rateLimitPolicy: 'unprocessed-429-v1', httpAttempts: 1, rejected429Attempts: 0, paidAttempts: 1 });
  }
  await writeFile(path.join(output, 'results.jsonl'), rows.map(row => JSON.stringify(row) + '\n').join(''));
  return rows;
}

test('full-900 plan freezes all 491 images and grants its own hard allowance without changing the old plan', async t => {
  const data = await fullCampaignFixture(t, 900), oldHash = digest(await readFile(data.oldPlan));
  const plan = await readResumePlan(data.cache, data.resumePlan), audit = await auditResumeBudget(data.cache, data.resumePlan, data);
  assert.equal(plan.cohort.length, 491);
  assert.equal(plan.full, true);
  assert.equal(audit.capCny, 900);
  assert.equal(audit.plannedCritiques, 1564);
  assert.equal(audit.initialForecastCny, audit.estimatedPerCritiqueCny * 1564);
  assert.ok(audit.initialForecastCny < 900);
  assert.equal(audit.conservativeAllowanceExceedsTotal, true);
  assert.equal(audit.maySubmit, true, 'explicit authorization permits the displayed legacy upper bound to exceed the nominal total');
  assert.equal(digest(await readFile(data.oldPlan)), oldHash);
  await writeFile(data.input, JSON.stringify({ ...data.draft, budget: { ...data.draft.budget, incrementalCny: 901 } }));
  await assert.rejects(readResumePlan(data.cache, data.input), /invalid immutable/);
});

test('full campaign prepares 291 photos in A/B and 200 Open Images in A as separate storage batches', async t => {
  const data = await fullCampaignFixture(t), photos = path.join(data.cache, 'full-mini-photos'), oi = path.join(data.cache, 'full-mini-oi');
  const photoResult = await prepareRequests({ ...data, output: photos, resumeSet: 'photos' });
  assert.equal(photoResult.photos, 291);
  assert.equal(photoResult.critiques, 582);
  assert.equal(photoResult.requests, 1746);
  const config = await json(path.join(photos, 'config.json'));
  assert.deepEqual(config.concurrency, { [TEACHERS.flash]: 8, [TEACHERS.gpt]: 4, [TEACHERS.claude]: 4 });
  assert.equal(config.rateLimitPolicy, 'unprocessed-429-v1');
  assert.equal(config.rateLimitRetries, 4);
  assert.equal((await json(path.join(photos, 'judge-batch.json'))).plannedCritiques, 1564);
  await validateResumeBatch(data.cache, data.resumePlan, photos, data);
  const oiResult = await prepareRequests({ ...data, output: oi, resumeSet: 'openimages' });
  assert.equal(oiResult.photos, 200);
  assert.equal(oiResult.critiques, 200);
  assert.equal(oiResult.requests, 600);
  assert.equal((await json(path.join(oi, 'config.json'))).imageRoot, 'public/openimages');
  const metadataFile = path.join(oi, 'judge-batch.json'), metadata = await json(metadataFile);
  assert.ok(metadata.entries.every(entry => entry.variant === 'A'));
  metadata.set = 'photos';
  await writeFile(metadataFile, JSON.stringify(metadata));
  await assert.rejects(validateResumeBatch(data.cache, data.resumePlan, oi, data), /declared dataset/);
});

test('429 evidence counts one possible paid transport, frees confirmed unprocessed rejections and rejects malformed counters', async t => {
  const data = await fullCampaignFixture(t), output = path.join(data.cache, 'full-mini-small');
  await prepareRequests({ ...data, output, resumePhotos: 1 });
  const rows = await settleFull(output);
  Object.assign(rows[0], { attempts: 3, httpAttempts: 3, transportAttempts: 3, rejected429Attempts: 2 });
  rows[1] = { id: rows[1].id, status: 429, attempts: 5, httpAttempts: 5, transportAttempts: 5, rejected429Attempts: 5,
    paidAttempts: 0, transportPolicy: 'single-request-v1', rateLimitPolicy: 'unprocessed-429-v1', costStatus: 'unprocessed_429',
    reservedCny: 0 };
  rows[2] = { id: rows[2].id, status: 0, attempts: 2, httpAttempts: 2, transportAttempts: 2, rejected429Attempts: 1,
    paidAttempts: 1, transportPolicy: 'single-request-v1', rateLimitPolicy: 'unprocessed-429-v1', costStatus: 'reserved_unknown',
    reservedCny: .154 };
  const file = path.join(output, 'results.jsonl');
  await writeFile(file, rows.slice(0, -1).map(row => JSON.stringify(row) + '\n').join(''));
  const audit = await auditResumeBudget(data.cache, data.resumePlan, data);
  assert.equal(audit.unboundedRequests, 0);
  assert.equal(audit.unprocessed429Requests, 1);
  assert.equal(audit.knownRequests, 3);
  assert.equal(audit.outstandingCny, .308);
  assert.equal(audit.pendingRequests, 1);
  rows[0].rejected429Attempts = 1;
  await writeFile(file, rows.map(row => JSON.stringify(row) + '\n').join(''));
  const invalid = await auditResumeBudget(data.cache, data.resumePlan, data);
  assert.ok(invalid.unboundedRequests > 0);
  assert.equal(invalid.remainingBudgetCny, 0);
  assert.equal(invalid.maySubmit, false);
});
