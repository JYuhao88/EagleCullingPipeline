import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, readFile, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import vm from 'node:vm';
import { createRulesRouter, applyRuleDecisions } from '../src/server/rules-routes.js';
const rule = (id, extra = {}) => ({
  id, title: id, statement: '可见判断', aspect: 'framing', severity: 'hint',
  check: { by: 'teacher' }, sources: [], exceptions: [], ...extra,
});
const paper = { slug: 'sample', title: '合成论文', year: 2020, channel: 'test', docType: 'article' };
const ev = (slug = 'sample', locator = '段落2') => ({ paperSlug: slug, locator, kind: 'source', paraphrase: '主体关系清楚' });
async function setup(t) {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'papers-review-'));
  const root = path.join(dir, 'src/rules');
  await mkdir(path.join(root, 'candidates'), { recursive: true });
  const put = (name, value) => writeFile(path.join(root, name), JSON.stringify(value));
  await put('portrait.json', { library: 'portrait', version: '0.1.0', rules: [rule('P-ONE')] });
  await put('candidates/portrait-v0.2-candidates.json', { rules: [rule('P-YD-ONE', { status: 'proposed' })] });
  await put('street.json', { library: 'street', rules: [rule('S-ONE')] });
  await put('candidates/xhs-candidates.json', { rules: [rule('X-ONE')] });
  await put('candidates/book-candidates.json', { books: [], rules: [
    rule('BOOK-S', { library: 'street', source: 'book:sample', status: 'proposed' }),
  ] });
  const papers = [paper, { ...paper, slug: 'second', title: '第二篇' }];
  await put('candidates/paper-candidates.json', { contractVersion: 1, papers, rules: [
    rule('P-PAPER', { library: 'portrait', source: 'paper', status: 'proposed', evidence: [ev(), ev('second')] }),
    rule('S-PAPER', { library: 'street', source: 'paper', status: 'proposed', evidence: [ev()] }),
  ] });
  await put('candidates/paper-evidence.json', { contractVersion: 1, papers, evidence:
    ['P-ONE', 'P-YD-ONE', 'S-ONE', 'X-ONE'].map(ruleId => ({ ...ev(), ruleId, supportCount: 2, supports: [ev(), ev('second', '段落4')] })) });
  const router = createRulesRouter({ projectRoot: dir });
  const call = async (route, body) => {
    let status, data;
    const req = body === undefined ? { method: 'GET', url: `/rules/${route}` } :
      { method: 'POST', url: `/rules/${route}`, async *[Symbol.asyncIterator]() { yield Buffer.from(JSON.stringify(body)); } };
    await router(req, { writeHead(code) { status = code; }, end(value) { data = JSON.parse(value); } });
    return { status, data };
  };
  t.after(() => rm(dir, { recursive: true, force: true }));
  return { call, dir };
}

test('paper API attaches metadata and all support locators to seed, YD and reference rules', async t => {
  const { call } = await setup(t);
  const { status, data } = await call('data');
  assert.equal(status, 200);
  assert.equal(data.paperCandidates.rules.length, 2);
  assert.equal(data.paperEvidence.evidence.length, 4);
  for (const id of ['P-ONE', 'P-YD-ONE', 'S-ONE', 'X-ONE']) {
    const r = [...data.rules, ...data.referenceRules].find(x => x.id === id);
    assert.equal(r.paperEvidence[0].paper.title, '合成论文');
    assert.equal(r.paperEvidence[0].supportCount, 2);
    assert.equal(r.paperEvidence[0].supports[1].paper.title, '第二篇');
  }
  assert.equal(data.rules.find(x => x.id === 'P-PAPER').paperEvidence.length, 2);
});

test('paper approval/export separates nonportrait drafts from book drafts and protects seed', async t => {
  const { call, dir } = await setup(t);
  const seedPath = path.join(dir, 'src/rules/portrait.json');
  const before = await readFile(seedPath, 'utf8');
  for (const ruleId of ['P-PAPER', 'S-PAPER', 'BOOK-S'])
    assert.equal((await call('decisions', { ruleId, action: 'approve' })).status, 200);
  assert.equal((await call('decisions', { ruleId: 'S-PAPER', action: 'merge', targetId: 'P-ONE' })).status, 400);
  const { data } = await call('export', {});
  assert.ok(data.draft.rules.some(x => x.id === 'P-PAPER'));
  assert.deepEqual(data.paperDrafts.street.rules.map(x => x.id), ['S-PAPER']);
  assert.deepEqual(data.bookDrafts.street.rules.map(x => x.id), ['BOOK-S']);
  assert.equal(await readFile(seedPath, 'utf8'), before);
});

test('paper merge deduplicates by paper identity and never counts paper evidence as video', () => {
  const item = rule('P-PAPER', { status: 'proposed', evidence: [ev(), ev('second')], paperEvidence: [ev(), ev('second')] });
  const rows = applyRuleDecisions(
    { rules: [rule('P-ONE', { evidence: [ev()], paperEvidence: [ev()] })] },
    { rules: [item] }, [{ ruleId: 'P-PAPER', action: 'merge', targetId: 'P-ONE' }],
  );
  assert.equal(rows[0].evidence.length, 2);
  assert.equal(rows[0].paperEvidence.length, 2);
  assert.equal(rows[0].frequency.videos, 0);
  assert.equal(rows[0].frequency.segments, 0);
});

test('merging aggregated paper claims unions locators but counts distinct papers', () => {
  const left = { ...ev(), supportCount: 2, supports: [ev(), ev('second', '段落4')] };
  const right = { ...ev(), supportCount: 2, supports: [ev('sample', '段落3'), ev('third', '段落8')] };
  const rows = applyRuleDecisions({ rules: [rule('P-ONE', { paperEvidence: [left] })] },
    { rules: [rule('P-PAPER', { paperEvidence: [right] })] },
    [{ ruleId: 'P-PAPER', action: 'merge', targetId: 'P-ONE' }]);
  assert.equal(rows[0].paperEvidence.length, 1);
  assert.equal(rows[0].paperEvidence[0].supportCount, 3);
  assert.deepEqual(rows[0].paperEvidence[0].supports.map(item => item.locator), ['段落2', '段落4', '段落3', '段落8']);
});

test('paper merge API retains metadata and distinct paragraph locators after reload', async t => {
  const { call } = await setup(t);
  assert.equal((await call('decisions', { ruleId: 'P-PAPER', action: 'merge', targetId: 'P-ONE' })).status, 200);
  const { data } = await call('data');
  const target = data.rules.find(r => r.id === 'P-ONE');
  assert.deepEqual(target.paperEvidence.map(item => item.paperSlug), ['sample', 'second']);
  assert.equal(target.paperEvidence[0].supportCount, 2);
  assert.equal(target.paperEvidence[0].supports[1].locator, '段落4');
  assert.ok(target.paperEvidence.every(item => item.paper.title));
  assert.equal(target.frequency.videos, 0);
  assert.equal(data.rules.find(r => r.id === 'P-PAPER').status, 'merged');
});

// Exercise the actual browser script with a minimal DOM, without a server or media access.
async function renderReview(data) {
  class Element {
    constructor(tag, text = '', value = '') { this.tag = tag; this.textContent = text; this.value = value; this.children = []; }
    append(node) { this.children.push(node); }
    replaceChildren(...nodes) { this.children = nodes; }
  }
  const nodes = new Map(['message', 'version', 'aspect', 'status', 'source', 'list', 'detail', 'export']
    .map(id => [id, new Element(id)]));
  const requests = [];
  const context = vm.createContext({
    document: { getElementById: id => nodes.get(id), createElement: tag => new Element(tag) },
    location: { protocol: 'http:' },
    Option: class extends Element { constructor(text, value) { super('option', text, value); } },
    fetch: async url => { requests.push(url); return { ok: true, json: async () => data }; },
    setTimeout,
  });
  vm.runInContext(await readFile(new URL('../src/plugin/rules-review.js', import.meta.url), 'utf8'), context);
  await new Promise(resolve => setImmediate(resolve));
  const descendants = node => [node, ...node.children.flatMap(descendants)];
  return { nodes, requests, detail: () => descendants(nodes.get('detail')) };
}

test('paper detail shows support counts and every title/year/channel/locator without requesting media', async () => {
  // Even stale video cache fields on a paper citation must not turn it into media evidence.
  const support = { ...ev(), paper, bvid: 'BVTEST', t: 12, frame: 'example.jpg' };
  const second = { ...ev('second', '小标题：决定性瞬间/段落4'), paper: { ...paper, slug: 'second', title: '第二篇' } };
  const aggregate = { ...support, supportCount: 2, supports: [support, second] };
  const fallback = { ...support, kind: 'exception', locator: '段落8', paraphrase: '叙事需要时可保留干扰' };
  const candidate = rule('S-PAPER', {
    library: 'street', source: 'paper', status: 'proposed',
    evidence: [aggregate, fallback], paperEvidence: [aggregate, fallback],
  });
  const { nodes, requests, detail } = await renderReview({ rules: [candidate], version: '0.1.0', existingIds: [] });
  const rendered = detail();
  assert.ok(rendered.some(node => node.textContent === '论文出处/例外'));
  assert.ok(rendered.some(node => node.textContent === '出处 · 支持 2 篇'));
  assert.ok(rendered.some(node => node.textContent === '例外 · 支持 1 篇'));
  assert.ok(rendered.some(node => node.textContent === '合成论文 · 2020 · test · 段落2'));
  assert.ok(rendered.some(node => node.textContent === '第二篇 · 2020 · test · 小标题：决定性瞬间/段落4'));
  assert.ok(rendered.some(node => node.textContent === '合成论文 · 2020 · test · 段落8'));
  assert.ok(rendered.some(node => node.textContent.includes('单独下载论文草案')));
  assert.equal(rendered.find(node => node.tag === 'button' && node.textContent === '合并').disabled, true);
  assert.ok(!rendered.some(node => node.tag === 'img' || node.tag === 'a'));
  assert.deepEqual(requests, ['/rules/data']);
  assert.equal(nodes.get('message').textContent, '');
});

test('paper filter includes supported YD and read-only references and combines with status/aspect', async () => {
  const located = { ...ev(), paper };
  const data = { version: '0.1.0', existingIds: ['P-ONE'], rules: [
    rule('P-ONE', { status: 'existing' }),
    rule('P-YD', { status: 'proposed', paperEvidence: [located] }),
    rule('P-PAPER', { status: 'proposed', source: 'paper', aspect: 'pose', paperEvidence: [located] }),
    rule('BOOK', { status: 'proposed', source: 'book:sample', bookEvidence: [{ bookSlug: 'sample' }] }),
  ], referenceRules: [
    rule('S-REF', { status: 'reference', library: 'street', paperEvidence: [located] }),
  ] };
  const { nodes, detail } = await renderReview(data);
  const listed = () => nodes.get('list').children.map(node => node.textContent);
  nodes.get('source').value = 'paper'; nodes.get('source').onchange();
  assert.deepEqual(listed(), ['P-YD', 'P-PAPER', 'S-REF']);
  nodes.get('status').value = 'proposed'; nodes.get('status').onchange();
  assert.deepEqual(listed(), ['P-YD', 'P-PAPER']);
  nodes.get('aspect').value = 'pose'; nodes.get('aspect').onchange();
  assert.deepEqual(listed(), ['P-PAPER']);
  nodes.get('aspect').value = ''; nodes.get('status').value = 'reference'; nodes.get('status').onchange();
  nodes.get('list').children[0].onclick();
  assert.ok(detail().filter(node => ['textarea', 'button'].includes(node.tag)).every(node => node.disabled));
  assert.equal(detail().filter(node => node.tag === 'select' && node.disabled).length, 2);
  assert.ok(detail().some(node => node.textContent.includes('正式规则只读')));
  nodes.get('status').value = ''; nodes.get('source').value = 'book'; nodes.get('source').onchange();
  assert.deepEqual(listed(), ['BOOK']);
  nodes.get('source').value = 'other'; nodes.get('source').onchange();
  assert.deepEqual(listed(), ['P-ONE']);
});
