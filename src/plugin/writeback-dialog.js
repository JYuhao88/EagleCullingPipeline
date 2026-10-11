import { formatApplySummary } from "./format.js";

export function createWritebackDialog({ root, api, runId = null, getRunId = () => runId, onComplete }) {
  const output = root.querySelector("#writeback");
  const trash = root.querySelector("#moveTrash");
  const confirm = root.querySelector("#trashConfirm");
  const dialog = root.querySelector("#writebackDialog");
  const summary = root.querySelector("#writebackSummary");
  const details = root.querySelector("#writebackDetails");
  const revertButton = root.querySelector("#revertWriteback");
  const confirmButton = root.querySelector("#confirmWriteback");
  let plan = null;
  let applying = false;

  async function dryRun() {
    const runId = getRunId();
    plan = await api(`/runs/${runId}/apply`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ apply: false })
    });
    const lines = [
      `将修改 ${plan.summary.changed} 个文件，无变化 ${plan.summary.unchanged} 个文件`,
      `新增 AI 标签 ${plan.summary.addedTags || 0} 个，移除 AI 标签 ${plan.summary.removedTags || 0} 个`,
      Object.entries(plan.summary.tags)
        .map(([tag, count]) => `${tag}：${count} 项`)
        .join("\n")
    ];
    if (plan.warning) lines.push(`提示：${plan.warning}`);
    summary.textContent = lines.join("\n");
    details.replaceChildren();
    const labels = { selected: "精选", candidate: "候选", rejected: "淘汰" };
    for (const [action, counts] of Object.entries(plan.summary.byAction || {})) {
      const section = document.createElement("details");
      const heading = document.createElement("summary");
      heading.textContent = `${labels[action] || action}：修改 ${counts.changed} 个文件，无变化 ${counts.unchanged} 个文件`
        + `；新增 ${counts.addedTags} / 移除 ${counts.removedTags} 个 AI 标签`;
      section.append(heading);
      const rows = (plan.results || []).filter(row => row.action === action && row.changed);
      const text = document.createElement("pre");
      text.textContent = rows.slice(0, 50).map(row => `${row.fileName || row.id}：`
        + `新增 ${(row.addedTags || []).join("、") || "无"}；移除 ${(row.removedTags || []).join("、") || "无"}`).join("\n");
      if (rows.length > 50) text.textContent += `\n仅显示前 50 条，共 ${rows.length} 条。`;
      section.append(text);
      details.append(section);
    }
    if (typeof dialog.showModal === "function") dialog.showModal();
    else dialog.hidden = false;
  }

  async function apply() {
    if (applying) return;
    const confirmation = confirm.querySelector("input")?.value || "";
    if (trash.checked && confirmation !== "MOVE_TO_TRASH") {
      output.textContent = "请输入 MOVE_TO_TRASH 才能移入回收站";
      return;
    }
    applying = true;
    confirmButton.disabled = true;
    try {
      const runId = getRunId();
      const result = await api(`/runs/${runId}/apply`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          apply: true,
          moveRejectedToTrash: trash.checked,
          confirm: confirmation
        })
      });
      const summary = formatApplySummary(result, {
        base: root.querySelector("#base")?.value || "", runId
      });
      output.innerHTML = `<div class="writeback-stats"><strong>${summary.changed}<small>已修改</small></strong>`
        + `<strong>${summary.unchanged}<small>未变化</small></strong>`
        + `<strong class="${summary.failed ? "has-error" : ""}">${summary.failed}<small>失败</small></strong></div>`
        + (summary.trash ? ` · 回收站 ${summary.trash} 项` : "")
        + (summary.warning ? `<p>${summary.warning}</p>` : "")
        + (summary.csvUrl ? ` <a class="report-button" target="_blank" href="${summary.csvUrl}">下载 CSV 报告</a>` : "")
        + (summary.jsonUrl ? ` <a class="report-button" target="_blank" href="${summary.jsonUrl}">下载 JSON 报告</a>` : "");
      if (typeof dialog.close === "function") dialog.close();
      else dialog.hidden = true;
      revertButton.hidden = false;
      onComplete?.(result);
    } finally {
      applying = false;
      confirmButton.disabled = false;
    }
  }

  revertButton.addEventListener("click", async () => {
    if (applying) return;
    applying = true;
    revertButton.disabled = true;
    try {
      const result = await api(`/runs/${getRunId()}/writeback/revert`, {
        method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ apply: true })
      });
      const failures = result.results.filter(item => item.ok === false).length;
      const restored = result.results.filter(item => item.ok && item.changed).length;
      output.textContent = `撤回完成：恢复 ${restored} 个文件，无变化 ${result.summary.unchanged} 个文件`
        + `，失败 ${failures} 个。仅恢复 AI 标签；回收站操作不会撤销。`;
    } catch (error) { output.textContent = `撤回失败：${error.message}`; }
    finally { applying = false; revertButton.disabled = false; }
  });
  root.querySelector("#dryRun").addEventListener("click", () => {
    return dryRun().catch(error => { output.textContent = error.message; });
  });
  root.querySelector("#cancelWriteback").addEventListener("click", () => {
    dialog.close();
  });
  dialog.addEventListener("cancel", event => {
    event.preventDefault();
    dialog.close();
  });
  confirmButton.addEventListener("click", () => {
    return apply().catch(error => { output.textContent = error.message; });
  });
  trash.addEventListener("change", () => { confirm.hidden = !trash.checked; });
  return { dryRun };
}
