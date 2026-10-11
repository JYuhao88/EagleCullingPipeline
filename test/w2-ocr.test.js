import test from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { tmpdir } from "node:os";
test("CPU OCR tier votes and checksummed transfer are conservative", () => {
  const result = spawnSync(
    (process.env.EAGLE_PYTHON || "python3"),
    [
      "-c",
      `
import sys,base64,gzip,hashlib,json,tempfile
sys.path.insert(0,'ml/references')
from tier_ocr_job import recognize,majority
from transfer_rules import receive
box=[[700,20],[790,20],[790,60],[700,60]]
assert recognize([[box,'顶级',.9]],1000,500)==('顶尖','ocr-label')
assert recognize([[box,'夯',.9],[box,'拉',.9]],1000,500)==(None,None)
assert recognize([[box,'拉',.5]],1000,500)==(None,None)
assert recognize([[box,'路人投稿 人上人',.9]],1000,500)==('人上人','ocr-titlecard')
rows=[{'photo_id':'same','segment':{'index':i},'tier':t,'tierSource':'ocr-label'} for i,t in enumerate(['夯','夯','拉'])]
majority(rows);assert all(r['tier']=='夯' for r in rows)
rows=[{'photo_id':None,'segment':{'index':i},'tier':t,'tierSource':'ocr-label'} for i,t in enumerate(['夯',None])]
majority(rows);assert rows[1]['tier'] is None
raw=b'test';sha=hashlib.sha256(raw).hexdigest()
item={'path':'critiques-v2/test.jsonl','index':0,'count':1,'size':4,'sha256':sha,
 'chunk_sha256':sha,'data':base64.b64encode(gzip.compress(raw)).decode()}
logs='W2_CHUNK '+json.dumps(item)+'\\nW2_TRANSFER_DONE'
with tempfile.TemporaryDirectory() as d:
 assert receive(logs,d)==1
 try:receive(logs.replace(sha,'0'*64),d)
 except ValueError:pass
 else:raise AssertionError('checksum accepted')
 try:receive(logs.replace('critiques-v2/test.jsonl','../escape'),d)
 except ValueError:pass
 else:raise AssertionError('path escape accepted')
`,
    ],
    { encoding: "utf8", env: { ...process.env, ECP_CEPH_ROOT: tmpdir() } },
  );
  assert.equal(result.status, 0, result.stderr);
});
