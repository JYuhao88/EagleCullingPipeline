import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { binary, kappa, parseAnswer, prompt, QUESTIONS, remote, report, requests, votes, wilsonLow } from '../scripts/observe-teacher.mjs';

test('answers parse from fenced or plain JSON and map labels back to option ids', () => {
  assert.deepEqual(parseAnswer('```json\n{"smile":"微笑","mouth":"闭合","eyes":"不存在"}\n```'), { smile: 'slight', mouth: 'closed' });
  assert.deepEqual(parseAnswer('答案：{"gaze":"看别处"}'), { gaze: 'away' });
  assert.equal(parseAnswer('no json here'), null);
});

test('看不清 abstains instead of counting as no', () => {
  assert.equal(binary('smile', 'unsure'), null);
  assert.equal(binary('smile', 'big'), 1);
  assert.equal(binary('smile', 'none'), 0);
  assert.equal(binary('mouth', 'slight'), 1);
});

test('the strict smile reading counts only big smiles and reads the asked question', () => {
  assert.equal(binary('smile', 'slight'), 1);
  assert.equal(binary('smileBig', 'slight'), 0);
  assert.equal(binary('smileBig', 'big'), 1);
  const answers = new Map([['a|flash|0', { smile: 'big' }], ['a|flash|1', { smile: 'big' }], ['a|flash|2', { smile: 'slight' }]]);
  const row = votes('smileBig', { id: 'a', truth: { smile: true } }, answers, 'flash', []);
  assert.deepEqual([row.majority, row.flipped, row.truth], [1, true, 1]);
});

test('the launch bound is the lower end of the Wilson interval', () => {
  assert.ok(Math.abs(wilsonLow(90, 100) - 0.826) < 0.001);
  assert.ok(wilsonLow(135, 140) > 0.9);
});

test('requests can ask a subset of questions', async t => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'observe-subset-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const ledgerFile = path.join(dir, 'ledger.jsonl');
  await writeFile(ledgerFile, JSON.stringify({ model: 'gemini-test-flash', pricing: { input: 1, output: 1, usdToCny: 7 } }) + '\n');
  const item = { id: 'p', set: 'photos', images: { full: 'images/a.jpg', face: 'images/b.jpg' } };
  await writeFile(path.join(dir, 'items.jsonl'), JSON.stringify(item) + '\n');
  await requests('unused', 2, 'gemini-test-flash:1', 'smile,gaze', { dir, ledgerFile });
  const [row] = (await readFile(path.join(dir, 'requests.jsonl'), 'utf8')).trim().split('\n').map(line => JSON.parse(line));
  assert.deepEqual(row.body.response_format.json_schema.schema.required, ['smile', 'gaze']);
  await assert.rejects(requests('unused', 2, 'gemini-test-flash:1', 'smile,nope', { dir, ledgerFile }), /Unknown question/);
});

test('kappa needs ten paired answers and corrects for chance', () => {
  assert.equal(kappa([[1, 1]]), null);
  const perfect = Array.from({ length: 20 }, (_, i) => [i % 2, i % 2]);
  assert.equal(kappa(perfect).kappa, 1);
  const constant = Array.from({ length: 20 }, () => [1, 1]);
  assert.equal(kappa(constant).kappa, null);
});

test('the panel speaks only when the cheap majority and every strong teacher agree', () => {
  const item = { id: 'a', truth: { smile: true } };
  const answers = new Map([['a|cheap|0', { smile: 'big' }], ['a|cheap|1', { smile: 'slight' }], ['a|cheap|2', { smile: 'none' }],
    ['a|s1|0', { smile: 'big' }], ['a|s2|0', { smile: 'slight' }]]);
  const row = votes('smile', item, answers, 'cheap', ['s1', 's2']);
  assert.equal(row.majority, 1);
  assert.equal(row.unanimous, null);
  assert.equal(row.flipped, true);
  assert.equal(row.panel, 1);
  answers.set('a|s2|0', { smile: 'unsure' });
  assert.equal(votes('smile', item, answers, 'cheap', ['s1', 's2']).panel, null);
});

test('the prompt lists options in the given order and describes the images sent', () => {
  const text = prompt(['gaze'], { set: 'photos', images: { full: 'x', face: 'y' } }, { gaze: ['看别处', '看不清', '看镜头'] });
  assert.match(text, /图 2 是从同一张照片裁出的主体人物脸部/);
  assert.match(text, /gaze：主体的视线。选项：看别处 \/ 看不清 \/ 看镜头/);
});

const jsonl = rows => rows.map(row => JSON.stringify(row) + '\n').join('');
const manifestRow = (id = 'abc', face = 'small') => ({ id, license: 'https://creativecommons.org/licenses/by/2.0/',
  author: 'Example author', originalUrl: 'https://example.org/photo', full: `full/${id}.jpg`, face: `face/${id}.jpg`,
  faceBox: [0.4, 0.4, 0.5, 0.46], faces: [[0.4, 0.4, 0.5, 0.46]], persons: [[0.3, 0.3, 0.6, 0.9]], stratum: face });

async function fixture(t) {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'observe-remote-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  t.mock.method(console, 'log', () => {});
  const ledgerFile = path.join(dir, 'ledger.jsonl'), manifest = path.join(dir, 'manifest.jsonl');
  await writeFile(ledgerFile, jsonl(['gemini-test-flash', 'strong'].map(model => ({ model,
    pricing: { input: 1, output: 2, usdToCny: 7 } }))));
  return { dir, ledgerFile, manifest };
}

async function readLines(file) {
  return (await readFile(file, 'utf8')).trim().split('\n').filter(Boolean).map(line => JSON.parse(line));
}

test('remote import preserves provenance without images and produces the same full questionnaire as photos', async t => {
  const { dir, ledgerFile, manifest } = await fixture(t), source = manifestRow();
  await writeFile(manifest, jsonl([source]));
  await remote('unused', manifest, undefined, { dir });
  await remote('unused', manifest, undefined, { dir });
  const [item] = await readLines(path.join(dir, 'items.jsonl'));
  assert.equal(item.set, 'openimages');
  assert.equal((await readLines(path.join(dir, 'items.jsonl'))).length, 1);
  assert.equal((await readdir(dir)).includes('images'), false);
  for (const key of ['license', 'author', 'originalUrl', 'faceBox', 'faces', 'persons']) assert.deepEqual(item[key], source[key]);
  assert.deepEqual(item.stratum, { face: 'small' });
  await requests('unused', 2, 'gemini-test-flash:3,strong:1', undefined, { dir, ledgerFile });
  const rows = await readLines(path.join(dir, 'requests.jsonl'));
  const config = JSON.parse(await readFile(path.join(dir, 'config.json'), 'utf8'));
  assert.equal(config.imageRoot, 'photography/eagle-culling/observe/openimages-v1');
  assert.equal(rows.length, 4);
  const originalPrompts = new Map(rows.map(row => [row.id, row.body.messages[0].content[0].text]));
  for (const row of rows) {
    assert.deepEqual(row.body.response_format.json_schema.schema.required, Object.keys(QUESTIONS));
    assert.deepEqual(row.body.messages[0].content.slice(1).map(image => image.image_file), [source.full, source.face]);
  }
  await writeFile(path.join(dir, 'items.jsonl'), jsonl([{ ...item, set: 'photos' }]));
  await requests('unused', 2, 'gemini-test-flash:3,strong:1', undefined, { dir, ledgerFile });
  assert.equal('imageRoot' in JSON.parse(await readFile(path.join(dir, 'config.json'), 'utf8')), false);
  for (const row of await readLines(path.join(dir, 'requests.jsonl'))) {
    assert.equal(row.body.messages[0].content[0].text, originalPrompts.get(row.id));
  }
  await writeFile(path.join(dir, 'items.jsonl'), jsonl([{ ...item, set: 'celeba', images: { face: source.face } }]));
  await requests('unused', 2, 'gemini-test-flash:1', undefined, { dir, ledgerFile });
  const [celeba] = await readLines(path.join(dir, 'requests.jsonl'));
  assert.deepEqual(celeba.body.response_format.json_schema.schema.required, ['smile', 'mouth', 'eyes', 'natural', 'gaze']);
});

test('remote import rejects unsafe paths and requests reject incompatible image roots', async t => {
  const { dir, ledgerFile, manifest } = await fixture(t);
  for (const full of ['../secret.jpg', '/full/a.jpg', 'full/../a.jpg', 'full/a.png', 'full\\a.jpg', 'C:/full/a.jpg']) {
    await writeFile(manifest, jsonl([{ ...manifestRow(), full }]));
    await assert.rejects(remote('unused', manifest, 'images', { dir }), /Invalid relative JPEG path/);
  }
  await writeFile(manifest, jsonl([manifestRow()]));
  await assert.rejects(remote('unused', manifest, '../images', { dir }), /Invalid relative imageRoot/);
  await remote('unused', manifest, 'custom/images', { dir });
  await requests('unused', 2, 'gemini-test-flash:1', undefined, { dir, ledgerFile });
  assert.equal(JSON.parse(await readFile(path.join(dir, 'config.json'), 'utf8')).imageRoot, 'custom/images');
  const [item] = await readLines(path.join(dir, 'items.jsonl'));
  await writeFile(path.join(dir, 'items.jsonl'), jsonl([item, { ...item, id: 'photo', set: 'photos' }]));
  await assert.rejects(requests('unused', 2, 'gemini-test-flash:1', undefined, { dir, ledgerFile }), /separate observation names/);
  await writeFile(path.join(dir, 'items.jsonl'), jsonl([item, { ...item, id: 'other', imageRoot: 'other/images' }]));
  await assert.rejects(requests('unused', 2, 'gemini-test-flash:1', undefined, { dir, ledgerFile }), /same imageRoot/);
});

test('Open Images report measures stability and inter-teacher agreement by face stratum without truth', async t => {
  const { dir, ledgerFile, manifest } = await fixture(t), results = [];
  await writeFile(manifest, jsonl(Array.from({ length: 30 }, (_, i) => manifestRow(String(i),
    { face: ['small', 'mid', 'large'][Math.floor(i / 10)] }))));
  await remote('unused', manifest, undefined, { dir });
  await requests('unused', 2, 'gemini-test-flash:3,strong:1', undefined, { dir, ledgerFile });
  for (let i = 0; i < 30; i++) {
    for (const [model, asks] of [['gemini-test-flash', 3], ['strong', 1]]) {
      for (let ask = 0; ask < asks; ask++) results.push({ id: `openimages-${i}|${model}|${ask}`, status: 200,
        content: JSON.stringify({ smile: i % 2 ? 'big' : 'none', clutter: i % 2 ? 'cluttered' : 'clean' }) });
    }
  }
  await writeFile(path.join(dir, 'results.jsonl'), jsonl(results));
  await report('unused', { dir });
  const output = JSON.parse(await readFile(path.join(dir, 'report.json'), 'utf8'));
  assert.deepEqual(Object.keys(output.sets), ['openimages']);
  for (const key of ['smile', 'clutter']) {
    for (const group of ['all', 'small', 'mid', 'large']) {
      const stats = output.sets.openimages[key][group];
      assert.equal(stats.n, group === 'all' ? 30 : 10);
      assert.equal(stats.flipRate, 0);
      assert.equal(stats.kappa['gemini-test-flash~strong'].kappa, 1);
      assert.equal('truth' in stats, false);
      assert.equal('localRule' in stats, false);
    }
  }
});
