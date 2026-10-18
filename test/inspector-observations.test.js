import test from 'node:test';
import assert from 'node:assert/strict';
import { mountInspector, observationLines } from '../src/plugin/inspector/inspector.js';

const items = [
  { id: 'smile', text: '在笑', tone: 'good', source: 'model', confidence: .93, box: [.1, .2, .4, .6] },
  { id: 'eyes', text: '闭眼', tone: 'bad', source: 'rule' },
  { id: 'pose', text: '侧脸', tone: 'neutral', source: 'rule' },
  { id: 'mouth', text: '嘴张开', tone: 'neutral', source: 'model', confidence: .88 },
  { id: 'fifth', text: '背景有人', tone: 'neutral', source: 'rule' },
];

test('observation view follows contrast tones and gives model-only calibrated confidence', () => {
  const lines = observationLines(items);
  assert.deepEqual(lines.map(row => row.className), ['contrast better', 'contrast worse', 'contrast neutral', 'contrast neutral']);
  assert.equal(lines[3].title, '校准置信度 88%');
  assert.deepEqual(observationLines(), []);
});

test('inspector renders, hides, hovers thumbnail boxes, switches cached member observations without extra requests', async () => {
  const nodes = new Map(), created = [], requests = [];
  const element = tag => {
    const node = { tag, textContent: '', children: [], hidden: false, disabled: false, dataset: {}, style: {}, attrs: {}, events: {},
      complete: tag === 'img', naturalWidth: 200, naturalHeight: 100,
      classList: { add() {}, toggle() {} },
      setAttribute(key, value) { this.attrs[key] = value; },
      replaceChildren(...children) { this.children = []; this.append(...children); },
      append(...children) { for (const child of children) { child.parent = this; this.children.push(child); } },
      addEventListener(name, fn) { this.events[name] = fn; },
      remove() { if (this.parent) this.parent.children = this.parent.children.filter(child => child !== this); this.parent = null; }
    };
    created.push(node); return node;
  };
  const root = { hidden: false, querySelector: id => { if (!nodes.has(id)) nodes.set(id, element('div')); return nodes.get(id); },
    querySelectorAll: () => [], createElement: element, createElementNS: (_, tag) => element(tag) };
  const member = (unitId, rank) => ({ unitId, rank, itemIds: [unitId], suggested: 'candidate', flags: [],
    metrics: { score: .8 - rank * .1 }, observations: unitId === 'u' ? items : [] });
  const analysis = { runId: 'r', unitId: 'u', groupId: 'g', groupSize: 2, groupMembers: [member('u', 1), member('v', 2)],
    observations: items, focus: '清晰' };
  let hasItems = true;
  const fetchImpl = async url => {
    requests.push(url);
    const data = url.includes('/queue') ? { queue: [] } : url.endsWith('/personalize') ? { ready: false }
      : { ...analysis, observations: hasItems ? items : [] };
    return { ok: true, json: async () => data };
  };
  const eagle = { library: { path: '/fixture.library' }, item: { getSelected: async () => [{ id: 'u' }], select: async () => {} } };
  const view = mountInspector({ root, eagle, storage: { getItem: () => null }, session: null, fetchImpl });
  try {
    view.watcher.stop(); await view.refresh(true);
    await new Promise(resolve => setTimeout(resolve, 10));
    const section = root.querySelector('#observations'), list = root.querySelector('#observationList');
    assert.equal(section.hidden, false); assert.equal(list.children.length, 4);
    assert.equal(list.children[0].title, '校准置信度 93%'); assert.equal(list.children[1].title, '');
    const before = requests.length;
    list.children[0].events.mouseenter();
    const overlays = created.filter(node => node.attrs.class === 'marks observation-box' && node.parent);
    assert.equal(overlays.length, 2);
    assert.equal(overlays[0].attrs.viewBox, '0 0 200 100');
    assert.equal(overlays[0].children[0].attrs.x, '20');
    list.children[0].events.mouseleave();
    assert.equal(overlays.some(node => node.parent), false);
    assert.equal(requests.length, before);
    const other = created.filter(node => node.className === 'member' && node.title?.includes('第 2 名')).at(-1);
    other.events.click();
    assert.equal(section.hidden, true);
    await new Promise(resolve => setTimeout(resolve, 10));
    hasItems = false; await view.refresh(true);
    assert.equal(section.hidden, true); assert.equal(list.children.length, 0);
    assert.equal(requests.some(url => /observations|confidence|crop/.test(url)), false);
  } finally { view.dispose(); }
});
