import { labeledGroupCount } from "./batch.js";

export function personalizationText(report) {
  const before = report?.before?.pairwise?.rate;
  const after = report?.after?.pairwise?.rate;
  const { labeledGroups, remainingGroups } = report || {};
  if (!report?.ready || ![before, after, labeledGroups, remainingGroups].every(Number.isFinite)
    || remainingGroups < 1) return "";
  return `已根据你的 ${labeledGroups} 组选择学习偏好：留出集一致率 ${(before * 100).toFixed(0)}%`
    + ` → ${(after * 100).toFixed(0)}%，按你的习惯重新排序剩余 ${remainingGroups} 组？`;
}

export function createPersonalization({ root, api, state, setState, render }) {
  const ignored = new Set();
  const banner = root.querySelector("#personalizeBanner");
  const button = root.querySelector("#personalizeApply");
  let version = 0;
  let busy = false;

  let timer;
  function scheduleRefresh() {
    clearTimeout(timer);
    version += 1;
    // Optional fitting runs after the photographer pauses, never after every key.
    timer = setTimeout(refresh, 5000);
  }
  async function refresh() {
    const requestVersion = ++version;
    const current = state();
    banner.hidden = true;
    if (busy || ignored.has(current.runId)
      || labeledGroupCount(current.data?.groups, current.decisions) < 2) return;
    try {
      const report = await api(`/runs/${current.runId}/personalize`);
      if (requestVersion !== version || state().runId !== current.runId || ignored.has(current.runId)) return;
      const text = personalizationText(report);
      root.querySelector("#personalizeText").textContent = text;
      banner.hidden = !text;
    } catch {
      // Preference learning is optional; review remains available.
    }
  }

  root.querySelector("#personalizeIgnore").addEventListener("click", () => {
    ignored.add(state().runId);
    version += 1;
    banner.hidden = true;
  });
  button.addEventListener("click", async () => {
    if (busy) return;
    const runId = state().runId;
    busy = true;
    button.disabled = true;
    version += 1;
    try {
      await api(`/runs/${runId}/personalize/apply`, { method: "POST" });
      const [data, response] = await Promise.all([
        api(`/runs/${runId}/results`), api(`/runs/${runId}/decisions`)
      ]);
      if (state().runId !== runId) return;
      setState({ ...state(), data, decisions: response.decisions });
      ignored.add(runId);
      banner.hidden = true;
      render();
    } catch (error) {
      root.querySelector("#writeback").textContent = `偏好应用失败：${error.message}`;
    } finally {
      busy = false;
      button.disabled = false;
    }
  });
  return { refresh, scheduleRefresh };
}
