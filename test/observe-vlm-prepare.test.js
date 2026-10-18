import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, mkdir, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createHash } from 'node:crypto';
import sharp from 'sharp';
import { buildGroups, buildPrepared, normalizeTeacherResult } from '../scripts/observe-vlm-prepare.mjs';

const jsonl = rows => rows.map(row => JSON.stringify(row) + '\n').join('');
const digest = value => createHash('sha256').update(value).digest('hex');

test('preparation refuses output paths that overlap the read-only source caches', async () => {
  const root = path.join(os.tmpdir(), 'observe-vlm-overlap');
  for (const outputDir of [path.join(root, 'p0'), root, path.join(root, 'p0', 'nested')]) {
    await assert.rejects(buildPrepared({ outputDir, p0Dir: path.join(root, 'p0'),
      p1PanelDir: path.join(root, 'panel'), p1TrainDir: path.join(root, 'train'),
      runDir: path.join(root, 'run') }), /overlaps source/);
  }
});

test('normalizes teacher ids and binary answers while keeping raw content', () => {
  const row = normalizeTeacherResult({ id: 'photo-a|gemini-3.8-flash|2', status: 200,
    content: '{"smile":"微笑","mouth":"看不清"}' });
  assert.deepEqual(row, { item_id: 'photo-a', teacher: 'flash', ask: 2, content: '{"smile":"微笑","mouth":"看不清"}',
    status: 200, answers: { smile: 'slight', mouth: 'unsure' }, votes: { smile: 1, mouth: null } });
  assert.deepEqual(normalizeTeacherResult({ id: 'x|gpt-6-sol|0', status: 500, content: null }),
    { item_id: 'x', teacher: 'gpt', ask: 0, content: '', status: 500, answers: {}, votes: {} });
});

test('group pairs are deterministic, use unequal human actions, and expose weak preference only', () => {
  const unitA = 'unit:A', unitB = 'unit:B', unitC = 'unit:C';
  const p0 = [unitA, unitB, unitC].map(unitId =>
    ({ id: `photo-${digest(unitId).slice(0, 12)}`, images: { full: `p0/images/${unitId}.jpg` } }));
  const review = [{ id: 'group:one', unitIds: [unitA, unitB, unitC] }, { id: 'group:single', unitIds: [unitA] }];
  const decisions = [{ unitId: unitA, action: 'selected', reason: '接受 AI 建议' },
    { unitId: unitB, action: 'candidate' }, { unitId: unitC, action: 'candidate' }];
  const first = buildGroups(review, decisions, p0, 24), second = buildGroups(review, decisions, p0, 24);
  assert.deepEqual(first, second);
  assert.equal(first.length, 1);
  assert.equal(first[0].truth, first[0].preferred);
  assert.equal(first[0].acceptedAi, true);
  assert.deepEqual(new Set(Object.values(first[0].actions)), new Set(['selected', 'candidate']));
});

async function image(file, width, height, color) {
  await mkdir(path.dirname(file), { recursive: true });
  await sharp({ create: { width, height, channels: 3, background: color } }).jpeg({ quality: 90 }).toFile(file);
}

test('buildPrepared copies exact p0 bytes and merges p1 initial and panel votes', async t => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'observe-vlm-prepare-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const p0 = path.join(root, 'p0'), panel = path.join(root, 'panel'), train = path.join(root, 'train');
  const run = path.join(root, 'run'), out = path.join(root, 'out');
  await Promise.all([mkdir(path.join(p0, 'images'), { recursive: true }), mkdir(panel, { recursive: true }),
    mkdir(train, { recursive: true }), mkdir(run, { recursive: true })]);
  await image(path.join(p0, 'images', 'face.jpg'), 384, 384, { r: 100, g: 100, b: 100 });
  await image(path.join(p0, 'images', 'full.jpg'), 512, 768, { r: 120, g: 90, b: 80 });
  const unitA = 'unit:GROUPA', unitB = 'unit:GROUPB';
  const photoA = `photo-${digest(unitA).slice(0, 12)}`, photoB = `photo-${digest(unitB).slice(0, 12)}`;
  await writeFile(path.join(p0, 'items.jsonl'), jsonl([
    { id: 'celeba-1', set: 'celeba', images: { face: 'images/face.jpg' }, truth: { smile: true, mouth: false } },
    { id: photoA, set: 'photos', images: { full: 'images/full.jpg' }, stratum: { face: 'none' } },
    { id: photoB, set: 'photos', images: { full: 'images/full.jpg' }, stratum: { face: 'none' } },
  ]));
  await writeFile(path.join(p0, 'results.jsonl'), jsonl([
    { id: 'celeba-1|gemini-3.8-flash|0', status: 200, content: '{"smile":"明显笑（露齿或嘴角明显上扬）","mouth":"闭合"}' },
  ]));
  const remote = { id: 'openimages-x', set: 'openimages', imageRoot: 'remote/root',
    images: { full: 'full/x.jpg', face: 'face/x.jpg' }, stratum: { face: 'mid' } };
  await writeFile(path.join(panel, 'items.jsonl'), JSON.stringify(remote) + '\n');
  await writeFile(path.join(panel, 'results.jsonl'), jsonl([
    { id: 'openimages-x|gemini-3.8-flash|1', status: 200, content: '{"smile":"微笑","mouth":"闭合","eyes":"睁开","gaze":"看镜头"}' },
    { id: 'openimages-x|claude-opus-5-5|0', status: 200, content: '{"smile":"没有笑","mouth":"闭合","eyes":"睁开","gaze":"看镜头"}' },
  ]));
  await writeFile(path.join(train, 'results.jsonl'), jsonl([
    { id: 'openimages-x|gemini-3.8-flash|0', status: 200, content: '{"smile":"明显笑（露齿或嘴角明显上扬）","mouth":"闭合","eyes":"睁开","gaze":"看镜头"}' },
    { id: 'openimages-x|gpt-6-sol|0', status: 200, content: '{"smile":"明显笑（露齿或嘴角明显上扬）","mouth":"闭合","eyes":"睁开","gaze":"看镜头"}' },
  ]));
  await writeFile(path.join(run, 'review-summary.json'), JSON.stringify([{ id: 'group:g', unitIds: [unitA, unitB] }]));
  await writeFile(path.join(run, 'decisions.json'), JSON.stringify([
    { unitId: unitA, action: 'selected', reason: '人工' }, { unitId: unitB, action: 'rejected', reason: '人工' },
  ]));
  const result = await buildPrepared({ outputDir: out, p0Dir: p0, p1PanelDir: panel, p1TrainDir: train, runDir: run });
  assert.equal(result.items.length, 5);
  assert.equal(result.labels.length, 5);
  assert.equal(result.groups.length, 1);
  const manifest = (await readFile(path.join(out, 'manifest.jsonl'), 'utf8')).trim().split('\n').map(JSON.parse);
  const celeba = manifest.find(row => row.id === 'celeba-1');
  assert.deepEqual(celeba.questions, ['smile', 'mouth', 'eyes', 'natural', 'gaze']);
  assert.deepEqual(celeba.truth, { smile: true, mouth: false });
  const remoteRow = manifest.find(row => row.set === 'openimages');
  assert.deepEqual(remoteRow.questions, ['smile', 'mouth', 'eyes', 'gaze']);
  assert.equal(remoteRow.storage, 'ceph');
  assert.deepEqual(remoteRow.votes.smile, { flash: [1, 1], claude: [0], gpt: [1] });
  const group = manifest.find(row => row.kind === 'group');
  assert.equal(group.decisionSource, 'human weak preference');
  assert.deepEqual(await readFile(path.join(p0, 'images', 'full.jpg')), await readFile(path.join(out, 'p0/images/full.jpg')));
  const summary = JSON.parse(await readFile(path.join(out, 'summary.json')));
  assert.equal(summary.integrity.metadataStripped, true);
  assert.equal(summary.counts.p1Panel, 1);
});
