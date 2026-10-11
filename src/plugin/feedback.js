export function defaultRejectReasons(result, catalog) {
  const rules = new Map((catalog.rules || []).map(rule => [rule.id, rule]));
  const ids = new Set((result?.verdicts || []).filter(verdict => verdict.verdict === 'violate'
    || (verdict.verdict === 'warn' && rules.get(verdict.ruleId)?.severity === 'gate'))
    .map(verdict => verdict.ruleId));
  const flagReasons = { blurry: 'R-G-BLUR', 'eyes-closed': 'R-P-EYES', overexposed: 'R-L-HIGHLIGHT', underexposed: 'R-L-SHADOW' };
  const flags = new Set(result?.flags || []);
  const presets = new Set([...flags].map(flag => flagReasons[flag]).filter(Boolean));
  return (catalog.reasons || []).filter(reason => {
    const matched = reason.ruleIds.filter(id => ids.has(id));
    // Generic exposure verdicts describe both ends; use directional evidence or flags.
    if (reason.id === 'R-L-HIGHLIGHT' && matched.length && matched.every(id => ['P-EXPOSURE-INTENT', 'S-EXPOSURE-CONTENT'].includes(id)))
      return presets.has(reason.id) || (result.verdicts || []).some(row =>
        matched.includes(row.ruleId) && /过曝|过度|高光/.test(row.evidence || ''));
    if (reason.id === 'R-L-SHADOW' && matched.length && matched.every(id => ['P-EXPOSURE-INTENT', 'S-EXPOSURE-CONTENT'].includes(id)))
      return presets.has(reason.id) || (result.verdicts || []).some(row =>
        matched.includes(row.ruleId) && /欠曝|不足|暗部|死黑/.test(row.evidence || ''));
    return presets.has(reason.id) || matched.length;
  }).map(reason => reason.id);
}

export function winnerChanges(before, decisions) {
  const after = new Map(before.decisions.map(item => [item.unitId, item]));
  for (const decision of decisions) after.set(decision.unitId, decision);
  return (before.data?.groups || []).flatMap(group => {
    const human = group.unitIds.filter(id => before.decisions.some(item => item.unitId === id
      && item.source === 'human' && item.action === 'selected'));
    const previous = human.length === 1 ? human[0] : human.length ? null
      : group.unitIds.find(id => group.suggested?.[id] === 'selected');
    const selected = group.unitIds.filter(id => after.get(id)?.source === 'human' && after.get(id)?.action === 'selected');
    return previous && selected.length === 1 && previous !== selected[0]
      ? [{ unitId: selected[0], action: 'winner-change', reasons: [], prevWinner: previous, newWinner: selected[0] }] : [];
  });
}

// This queue is independent of decision persistence and Eagle writeback.
export function createFeedbackRecorder({ api, onError = () => {} }) {
  let tail = Promise.resolve();
  function enqueue(task) {
    const result = tail.then(task).catch(error => { onError(error); return null; });
    tail = result;
    return result;
  }
  const post = (runId, body) => api(`/runs/${encodeURIComponent(runId)}/feedback`, {
    method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body)
  });
  function record(runId, body) {
    const handle = { runId, body, latest: null, ids: [] };
    enqueue(async () => {
      const response = await post(runId, body); handle.latest = response.event || response;
      if (handle.latest?.id) handle.ids.push(handle.latest.id);
    });
    return handle;
  }
  function revise(handle, reasons) {
    enqueue(async () => {
      const body = { ...handle.body, reasons, ...(handle.latest?.id ? { replaces: handle.latest.id } : {}) };
      const response = await post(handle.runId, body);
      handle.body = body; handle.latest = response.event || response; if (handle.latest?.id) handle.ids.push(handle.latest.id);
    });
  }
  function undo(handles) {
    for (const handle of handles || []) enqueue(async () => {
      if (!handle.latest?.id) return;
      for (const id of [...handle.ids].reverse()) await post(handle.runId, {
        unitId: handle.body.unitId, action: 'undo', reasons: [], undoOf: id
      });
    });
  }
  return { record, revise, undo, flush: () => tail };
}

export function escapeHtml(value) {
  return String(value ?? '').replace(/[&<>"']/g, char => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[char]));
}

export function renderRuleReasons(result, catalog) {
  const rules = new Map((catalog.rules || []).map(rule => [rule.id, rule]));
  const rows = (result?.verdicts || []).filter(row => ['violate', 'warn'].includes(row.verdict));
  const render = row => {
    const rule = rules.get(row.ruleId);
    const label = escapeHtml(rule?.title || rule?.label || row.ruleId);
    const evidence = escapeHtml(String(row.evidence || '').slice(0, 140));
    return `<p class="rule-verdict">${row.verdict === 'violate' ? '✖' : '⚠'} ${label} `
      + `<small>${escapeHtml(row.ruleId)}</small>：${evidence}</p>`;
  };
  const isHint = row => rules.get(row.ruleId)?.severity === 'hint' || (row.experiment === true && row.severity === 'hint');
  const hints = rows.filter(isHint);
  return rows.filter(row => !isHint(row)).map(render).join('')
    + (hints.length ? `<details class="rule-hints"><summary>规则提示（${hints.length}）</summary>${hints.map(render).join('')}</details>` : '');
}
