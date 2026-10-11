import { reviewPageQuery } from "./state.js";
import { rankedUnitIds } from './selection.js';

// Stable allocation prevents a rerender from changing the treatment mid-review.
export function presentation(group, enabled = false) {
  const clean = { ...group };
  delete clean.presentationOrder;
  delete clean.hideAI;
  const order = rankedUnitIds(clean);
  let hash = 2166136261;
  for (const char of String(group.id)) hash = Math.imul(hash ^ char.charCodeAt(0), 16777619) >>> 0;
  const control = enabled && order.length > 1 && hash % 20 === 0;
  return { order: control ? [...order.slice(1), order[0]] : order,
    aiVisible: !control, queryPolicy: control ? 'alternate-hidden-ai-5pct-v1' : 'ranked-v1',
    allocationProbability: control ? 0.05 : enabled ? 0.95 : 1 };
}


export function learningStatus(response) {
  const report = response.report;
  const pct = value => Number.isFinite(value) ? `${(value * 100).toFixed(1)}%` : '不足以判断';
  const interval = value => value?.n ? `${pct(value.estimate)} [${pct(value.lower)}, ${pct(value.upper)}]，${value.n} 组` : '数据不足';
  const lines = [`偏好方案：${response.profileId || 'default'}；个性化${response.config?.enabled ? '已启用' : '已关闭'}`,
    `效果验证：${report?.ready ? '稳定优于原排序，可以应用' : '选择记录不足或改善尚不稳定，继续使用原排序'}`];
  if (report) {
    lines.push(`原排序：${interval(report.before)}；个性化排序：${interval(report.after)}`,
      `提升（95% 区间）：${interval(report.improvement)}`);
    for (const point of report.learningCurve || []) lines.push(`${point.groups} 组学习曲线：${interval(point.after)}`);
  }
  if (response.drift?.detected) lines.push('最近选择一致率下降：偏好可能变化，建议复核后手动重训。');
  lines.push(`额外保存细节图：${response.config?.pixelTier === 1 ? '开启；仅对之后的淘汰选择生效' : '关闭'}`);
  return lines.join('\n');
}

export function createLearningPanel({ root, api, state, setState, render }) {
  let profileId = 'default';
  let config = {};
  let lastRun;
  const profileKey = () => `eagle-culling:learning-profile:${state().runId}`;
  const storedProfile = () => { try { return localStorage.getItem(profileKey()); } catch { return null; } };
  const q = id => root.querySelector(`#learning${id}`);
  const post = (action, body = {}) => api(`/runs/${state().runId}/learning/${action}`, {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ profileId, ...body })
  });
  function context(extra = {}) { return { profileId, ...extra }; }
  function decorate() {
    const current = state();
    if (!current.data) return;
    setState({ ...current, data: { ...current.data, groups: current.data.groups.map(group => {
      const display = presentation(group, config.debiasEnabled);
      return { ...group, presentationOrder: display.order, hideAI: !display.aiVisible };
    }) } });
  }
  function display(response) {
    config = response.config || {};
    q('Enabled').checked = Boolean(config.enabled);
    q('HalfLife').value = config.halfLifeDays ?? 90;
    q('Debias').checked = Boolean(config.debiasEnabled);
    q('Pixels').checked = config.pixelTier === 1;
    q('Snapshots').replaceChildren(...(response.snapshots || []).map(snapshot => {
      const option = document.createElement('option');
      option.value = typeof snapshot === 'string' ? snapshot : snapshot.version;
      option.textContent = option.value; return option;
    }));
    q('Status').textContent = learningStatus(response);
    decorate(); render();
  }
  async function load() {
    profileId = q('Profile').value.trim() || 'default';
    const response = await post('select');
    try { localStorage.setItem(profileKey(), profileId); } catch { /* Storage may be unavailable in an embedded plugin. */ }
    const query = reviewPageQuery(state());
    const data = await api(`/runs/${state().runId}/results${query}`);
    setState({ ...state(), data }); display(response);
  }
  function bind(id, fn) { q(id).addEventListener('click', () => fn().catch(error => {
    q('Status').textContent = `操作未完成：${error.message}。请检查服务连接后重试；可继续按原排序审阅。`;
  })); }
  bind('Load', load);
  bind('Save', async () => { const response = await post('config', { config: {
    enabled: q('Enabled').checked, halfLifeDays: Number(q('HalfLife').value),
    debiasEnabled: q('Debias').checked, pixelTier: q('Pixels').checked ? 1 : 0
  } });
    const query = reviewPageQuery(state());
    const data = await api(`/runs/${state().runId}/results${query}`);
    setState({ ...state(), data }); display(response);
  });
  bind('Train', async () => { display(await post('train')); });
  bind('Rollback', async () => { display(await post('rollback', { version: q('Snapshots').value })); });
  bind('Backfill', async () => {
    const result = await post('backfill');
    q('Status').textContent = `已导入 ${result.events} 条选择记录；过去的照片展示顺序未知。`;
  });
  bind('Scan', async () => {
    const result = await post('scan-deletions');
    q('Status').textContent = `检查完成：记录了 ${result.tombstones} 张已从 Eagle 删除的照片。`;
  });
  bind('Apply', async () => {
    const report = await post('apply');
    const query = reviewPageQuery(state());
    const data = await api(`/runs/${state().runId}/results${query}`);
    setState({ ...state(), data }); decorate(); render();
    q('Status').textContent = `已按验证快照更新 ${report.changedGroups} 个未审组。`;
  });
  async function refresh() {
    if (lastRun === state().runId) return;
    lastRun = state().runId;
    q('Profile').value = storedProfile() || 'default';
    try { await load(); } catch (error) { q('Status').textContent = `个性化不可用：${error.message}`; }
  }
  return { refresh, context, presentation: group => ({ ...presentation(group, config.debiasEnabled), profileId }) };
}
