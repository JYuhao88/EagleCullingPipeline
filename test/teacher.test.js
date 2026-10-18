import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { pathToFileURL } from 'node:url';

const valid = {
  ranking: ['I2', 'I1'],
  images: [{ id: 'I1', decision: 'reject', issues: ['模糊'], reason: '细节模糊' },
    { id: 'I2', decision: 'keep', issues: [], reason: '清晰自然' }],
};

test('teacher privacy, billing, resume, retry cap and fail-closed transport in isolated process', async () => {
  const directory = await mkdtemp(path.join(tmpdir(), 'teacher-test-'));
  try {
    for (const name of ['config', 'data/cache/bench/syn', 'data/cache/previews']) {
      await mkdir(path.join(directory, name), { recursive: true });
    }
    await writeFile(path.join(directory, 'config/local.json'), JSON.stringify({
      aihub: { usdToCny: 1, pricing: { synthetic: { input: 1, output: 1 }, plain: { input: 1, output: 1 } },
        responseFormat: { plain: false }, retryDelayMs: 1000 },
    }));
    const moduleUrl = pathToFileURL(path.resolve('scripts/teacher-label.mjs')).href;
    const sharpUrl = pathToFileURL(path.resolve('node_modules/sharp/lib/index.js')).href;
    const script = `
      import assert from 'node:assert/strict';
      import { readFile } from 'node:fs/promises';
      const { default: sharp } = await import(${JSON.stringify(sharpUrl)});
      const { withTeacher, thumbnail, CACHE } = await import(${JSON.stringify(moduleUrl)});
      await sharp({create:{width:1200,height:900,channels:3,background:'#123456'}})
        .withMetadata({exif:{IFD0:{Artist:'Synthetic'},IFD2:{GPSLatitudeRef:'N'}}})
        .jpeg().toFile('data/cache/bench/syn/a.jpg');
      const jpeg = await thumbnail('data/cache/bench/syn/a.jpg');
      const metadata = await sharp(jpeg).metadata();
      assert.equal(Math.max(metadata.width,metadata.height),768);
      for(const key of ['exif','xmp','iptc','icc']) assert.equal(metadata[key],undefined);
      await assert.rejects(thumbnail('config/local.json'));
      const group={task:'比较质量',images:[{path:'data/cache/bench/syn/a.jpg'},{path:'data/cache/bench/syn/a.jpg'}]};
      const options={model:'synthetic',budget:30,enabled:true};
      let calls=0;
      const good=${JSON.stringify(valid)};
      await assert.rejects(withTeacher({...options,budget:101},()=>{}));
      await assert.rejects(withTeacher({...options,enabled:false},()=>{}));
      globalThis.fetch=async (_url,request)=>{
        calls++;
        const body=JSON.parse(request.body);
        assert.equal(body.response_format.type,'json_schema');
        assert.equal(body.messages[0].content.filter(x=>x.type==='image_url').length,2);
        assert.ok(!JSON.stringify(body).includes('a.jpg'));
        return {ok:true,json:async()=>({usage:{prompt_tokens:100,completion_tokens:100},
          choices:[{message:{content:JSON.stringify(calls===1?{ranking:[]}:good)}}]})};
      };
      await withTeacher(options,async label=>{await label(group);await label(group)});
      assert.equal(calls,2);
      await withTeacher(options,async label=>assert.equal((await label(group)).cached,true));
      assert.equal(calls,2);
      await assert.rejects(withTeacher({...options,budget:0.00001},label=>label({...group,task:'另一任务'})));
      assert.equal(calls,2);
      globalThis.fetch=async()=>{calls++;return {ok:true,json:async()=>({usage:{prompt_tokens:100,completion_tokens:100},
        choices:[{message:{content:'{}'}}]})}};
      await assert.rejects(withTeacher(options,label=>label({...group,task:'非法输出'})));
      assert.equal(calls,5);
      await assert.rejects(withTeacher(options,label=>label({...group,task:'非法输出'})));
      assert.equal(calls,5);
      globalThis.fetch=async()=>{calls++;throw new Error('transport')};
      await assert.rejects(withTeacher(options,label=>label({...group,task:'中断任务'})));
      await assert.rejects(withTeacher(options,label=>label({...group,task:'中断任务'})));
      assert.equal(calls,6);
      globalThis.fetch=async (_url,request)=>{
        calls++;
        const body=JSON.parse(request.body);
        assert.equal(body.response_format,undefined);
        assert.ok(body.messages[0].content[0].text.includes('JSON结构'));
        return {ok:true,json:async()=>({usage:{prompt_tokens:100,completion_tokens:100},
          choices:[{message:{content:JSON.stringify(good)}}]})};
      };
      await withTeacher({...options,model:'plain'},label=>label(group));
      assert.equal(calls,7);
      globalThis.fetch=async()=>{
        calls++;const fence=String.fromCharCode(96).repeat(3);
        return {ok:true,json:async()=>({usage:{prompt_tokens:100,completion_tokens:100},
          choices:[{message:{content:fence+'json\\n'+JSON.stringify(good)+'\\n'+fence}}]})};
      };
      await withTeacher({...options,model:'plain'},async label=>{
        const response=await label({...group,task:'围栏输出'});
        assert.equal(response.valid,true);assert.equal(response.rawValid,false);
      });
      assert.equal(calls,8);
      let limited=0;
      globalThis.fetch=async()=>{
        calls++;limited++;
        if(limited===1)return {ok:false,status:429,text:async()=>'synthetic quota refusal'};
        return {ok:true,json:async()=>({usage:{prompt_tokens:100,completion_tokens:100},
          choices:[{message:{content:JSON.stringify(good)}}]})};
      };
      await withTeacher(options,label=>label({...group,task:'限流恢复'}));
      assert.equal(calls,10);
      const events=(await readFile(CACHE+'/ledger.jsonl','utf8')).trim().split('\\n').map(JSON.parse);
      assert.equal(events.filter(x=>x.type==='response').length,8);
      assert.equal(events.filter(x=>x.type==='reserve').length,10);
      assert.equal(events.filter(x=>x.type==='rejected').length,1);
    `;
    await promisify(execFile)(process.execPath, ['--max-old-space-size=512', '--input-type=module', '-e', script], {
      cwd: directory, env: { ...process.env, ECP_AIHUB_URL: 'https://example.invalid',
        ECP_AIHUB_KEY: 'synthetic', ECP_AIHUB_BUDGET_RMB: '500' }, timeout: 30000,
    });
    const ledger = await readFile(path.join(directory, 'data/cache/teacher/ledger.jsonl'), 'utf8');
    assert.ok(!ledger.includes('data:image')); assert.ok(!ledger.includes('Synthetic'));
  } finally { await rm(directory, { recursive: true, force: true }); }
});
