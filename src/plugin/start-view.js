import { defaultRepository, serviceCommand, serviceLaunch, progressEstimate } from "./service-start.js";
import { primaryAnalysis, analysisStages, stageIndex, readRecentRuns } from "./start-model.js";
import { eagleContext, isEagleEnvironment } from "./api.js";

export function createStartView({ root, api, getApi = () => api, onRun, autoCheck = true, autoRefresh = true }) {
  const health = root.querySelector("#health");
  const libraryInput = root.querySelector("#libraryPath");
  const runInput = root.querySelector("#runId");
  const progress = root.querySelector("#progress");
  const progressBar = root.querySelector("#bar");
  const progressText = root.querySelector("#progressText");
  const guide = root.querySelector("#serviceGuide");
  const repository = root.querySelector("#repositoryPath");
  const command = root.querySelector("#serviceCommand");
  const startButton = root.querySelector("#startService");
  repository.value = localStorage.getItem("eagle-culling-repository") || defaultRepository();
  let serviceTimer = null;
  let timer = null;
  let activeRun = null;
  let pollToken = 0;
  let connected = false;
  let submitting = false;
  let context = {};
  let contextKey = "";
  let contextTimer = null;
  let recentCursor = null;
  let recentToken = 0;
  const optional = id => root.querySelector(`#${id}`);
  const showText = (id, value) => { const element = optional(id); if (element) element.textContent = value; };
  const storage = globalThis.localStorage;
  function renderContext() {
    const model = primaryAnalysis(context, connected, Boolean(activeRun) || submitting);
    const button = root.querySelector("#analyzeSelected");
    button.textContent = model.label;
    button.disabled = model.disabled;
    root.querySelector("#analyzeAll").disabled = !connected || Boolean(activeRun) || submitting;
    showText("selectionHint", model.hint);
    showText("libraryName", context.libraryName || "浏览器预览");
    showText("folderName", context.folders?.map(folder => folder.name).join("、") || "未选择");
    showText("selectionCount", `${context.itemIds?.length || 0} 张`);
    const count = context.libraryCount;
    root.querySelector("#analyzeAll").textContent = `分析整个资源库${count == null ? "（张数待扫描）" : `（${count} 张）`}`;
    showText("allHint", `${count == null ? "扫描后确认总张数；" : `共 ${count} 张；`}全库分析可能较久，建议先试一个文件夹。`);
  }
  async function refreshContext() {
    if (!isEagleEnvironment()) {
      context = { libraryPath: libraryInput.value.trim(), libraryName: "浏览器预览", itemIds: [], folders: [] };
      renderContext();
      return;
    }
    const next = await eagleContext();
    const key = JSON.stringify([next.libraryPath, next.folders.map(folder => folder.id)]);
    if (key !== contextKey) {
      const full = next;
      contextKey = key;
      context = full;
    } else context = { ...next, folderItemIds: context.folderItemIds };
    renderContext();
  }
  const welcome = optional("welcome");
  if (welcome) welcome.hidden = storage.getItem("eagle-culling-welcome-dismissed") === "1";
  optional("closeWelcome")?.addEventListener("click", () => {
    welcome.hidden = true;
    storage.setItem("eagle-culling-welcome-dismissed", "1");
  });
  optional("startHelp")?.addEventListener("click", () => {
    welcome.hidden = false;
    storage.removeItem("eagle-culling-welcome-dismissed");
  });

  async function refreshRecent(append = false) {
    const container = optional("recentRuns");
    if (!container) return;
    const token = ++recentToken;
    if (!append) container.replaceChildren();
    showText("recentStatus", "正在读取最近的分析…");
    try {
      let response;
      try { response = await getApi()(`/runs?limit=6&cursor=${append ? recentCursor : 0}`); }
      catch {
        const runs = [];
        for (const id of readRecentRuns(storage)) {
          try { runs.push(await getApi()(`/runs/${id}`)); } catch { /* Missing old runs can be ignored. */ }
        }
        response = { runs, page: { nextCursor: null }, localOnly: true };
      }
      if (token !== recentToken) return;
      recentCursor = response.page?.nextCursor ?? null;
      for (const run of response.runs || []) {
        const card = root.createElement("article");
        card.className = "recent-run";
        const title = root.createElement("strong");
        title.textContent = run.scope?.label || "历史分析";
        const detail = root.createElement("p");
        const status = { completed: "可审阅", failed: "分析失败", cancelled: "已取消", running: "分析中", queued: "等待分析", interrupted: "已中断" };
        const date = run.startedAt ? new Date(run.startedAt).toLocaleString("zh-CN") : "时间未记录";
        const reviewed = run.reviewedGroupCount == null ? "审阅进度暂不可用" : `已审 ${run.reviewedGroupCount} / ${run.groupCount} 组`;
        detail.textContent = `${date} · ${run.itemCount || 0} 张 · ${run.groupCount || 0} 组 · ${reviewed} · ${status[run.status] || "状态未知"}`;
        if (run.status === "running") {
          detail.textContent += ` · ${run.progress?.completed || 0}/${run.progress?.total || 0}`;
        }
        const button = root.createElement("button");
        button.textContent = ["failed", "cancelled", "interrupted"].includes(run.status) ? "重新分析"
          : run.status === "completed" ? "继续审阅" : "查看进度";
        button.addEventListener("click", async () => {
          button.disabled = true;
          try {
            if (run.status === "completed") await onRun(run.id);
            else if (["failed", "cancelled", "interrupted"].includes(run.status)) await submitAnalysis({ resumeRunId: run.id });
            else await watchRun(run.id);
          } catch (error) {
            showText("recentStatus", /resumable|Run missing|run not found/i.test(error.message)
              ? "这条记录无法继续。请在 Eagle 重新选择照片，再点开始分析。"
              : `无法打开：${error.message}。请重试或检查服务连接。`);
          }
          finally { button.disabled = false; }
        });
        card.append(title, detail);
        if (["failed", "cancelled", "interrupted"].includes(run.status)) {
          const reason = root.createElement("p");
          reason.textContent = run.status === "cancelled" ? "上次已取消，可重新分析并复用已完成的阶段。"
            : run.status === "interrupted" ? "上次分析中断，可重新分析并复用缓存。" : friendlyFailure(run.error);
          card.append(reason);
        }
        card.append(button);
        container.append(card);
      }
      showText("recentStatus", response.runs?.length ? response.localOnly ? "当前服务不支持列表，显示本机最近记录。" : ""
        : "还没有分析记录。选几张照片，开始第一次分析吧。");
      optional("moreRuns").hidden = recentCursor === null;
    } catch (error) { showText("recentStatus", `暂时无法读取记录：${error.message}。连接服务后重试。`); }
  }
  optional("moreRuns")?.addEventListener("click", () => refreshRecent(true));
  const stopPolling = () => {
    if (timer) clearTimeout(timer);
    timer = null;
    pollToken += 1;
  };

  function updateCommand() {
    try { command.textContent = serviceCommand(repository.value, getApi().base); }
    catch (error) { command.textContent = error.message; }
  }

  async function checkHealth() {
    try {
      const response = await getApi()("/health");
      if (response.service !== "eagle-culling") throw new Error("服务类型不匹配");
      connected = true;
      health.textContent = "✓ 已连接";
      renderContext();
      await refreshRecent();
      guide.hidden = true;
      await recoverRun();
      return true;
    } catch {
      connected = false;
      health.textContent = "未连接 · 启动服务后即可分析照片";
      renderContext();
      guide.hidden = false;
      updateCommand();
      startButton.hidden = typeof require !== "function";
      return false;
    }
  }

  repository.addEventListener("change", () => {
    localStorage.setItem("eagle-culling-repository", repository.value.trim());
    updateCommand();
  });
  root.querySelector("#retryService").addEventListener("click", checkHealth);
  root.querySelector("#copyServiceCommand").addEventListener("click", async () => {
    try {
      await navigator.clipboard.writeText(serviceCommand(repository.value, getApi().base));
      health.textContent = "启动命令已复制，请在终端粘贴执行后重试连接";
    } catch (error) { health.textContent = `复制失败，请手动选择命令复制：${error.message}`; }
  });
  startButton.addEventListener("click", async () => {
    startButton.disabled = true;
    try {
      if (await checkHealth()) { startButton.disabled = false; return; }
      const options = serviceLaunch(repository.value, getApi().base);
      const { spawn } = require("node:child_process");
      const child = spawn(options.command, options.args,
        { cwd: options.cwd, detached: true, stdio: "ignore", windowsHide: true });
      if (options.command === "node" && child.pid) {
        try { require("node:os").setPriority(child.pid, require("node:os").constants.priority.PRIORITY_BELOW_NORMAL); }
        catch (error) { health.textContent = `无法降低服务优先级：${error.message}`; }
      }
      let startupFailed = false;
      child.on("error", error => {
        startupFailed = true;
        clearTimeout(serviceTimer);
        health.textContent = `启动失败：${error.message}。请使用复制命令。`;
        if (optional("advancedSettings")) optional("advancedSettings").open = true;
        startButton.disabled = false;
      });
      child.unref();
      let attempts = 0;
      const poll = async () => {
        if (startupFailed) return;
        if (await checkHealth()) { startButton.disabled = false; return; }
        if (startupFailed) return;
        if (++attempts >= 30) {
          health.textContent = "启动后仍未连接，请检查仓库路径和终端 node 命令，再重试连接";
          if (optional("advancedSettings")) optional("advancedSettings").open = true;
          startButton.disabled = false;
          return;
        }
        health.textContent = "正在等待本地服务启动…";
        serviceTimer = setTimeout(poll, 1000);
      };
      await poll();
    } catch (error) {
      health.textContent = `无法直接启动：${error.message}。请使用复制命令。`;
      if (optional("advancedSettings")) optional("advancedSettings").open = true;
      startButton.disabled = false;
    }
  });

  async function startAnalysis(itemIds) {
    if (submitting || activeRun) return;
    stopPolling();
    const context = isEagleEnvironment()
      ? await eagleContext({ selected: Boolean(itemIds), includeFolderItems: Boolean(itemIds) })
      : { libraryPath: libraryInput.value.trim(), itemIds: [] };
    const libraryPath = context.libraryPath;
    if (!libraryPath) throw new Error("请在 Eagle 打开一个资源库；浏览器预览请展开高级设置填写资源库路径");
    const selected = context.itemIds.length > 0;
    const scope = itemIds ? { type: selected ? "selection" : "folder",
      label: selected ? "选中的照片" : context.folders?.map(folder => folder.name).join("、") || "选中的照片" }
      : { type: "library", label: "整个资源库" };
    const body = { libraryPath, scope };
    if (itemIds) {
      body.itemIds = selected ? context.itemIds : context.folderItemIds;
      if (!body.itemIds?.length) throw new Error("未找到可分析的照片，请重新选择。");
    }
    await submitAnalysis(body);
  }

  async function submitAnalysis(body) {
    if (submitting) return;
    submitting = true; renderContext();
    health.textContent = '正在提交分析；首次全库可能需要数小时，建议先试几百张。';
    try {
      const run = await getApi()("/runs", {
        method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body)
      });
      const recent = [run.id, ...readRecentRuns(storage).filter(id => id !== run.id)].slice(0, 10);
      storage.setItem("eagle-culling-recent-runs", JSON.stringify(recent));
      await refreshRecent(); await watchRun(run.id);
    } catch (error) {
      if (error.status === 409 && error.body?.run) {
        health.textContent = '已有分析在进行，可查看进度或取消。';
        await refreshRecent(); await watchRun(error.body.run.id);
      } else { health.textContent = friendlyFailure(error.message); await refreshRecent(); }
    } finally { submitting = false; renderContext(); }
  }

  function friendlyFailure(message = '') {
    if (/EPERM|EBUSY|EACCES|rename/i.test(message)) {
      return '分析暂时无法保存文件，可能被其他程序占用。请稍后重试；缓存会复用，不需删除照片。';
    }
    if (/fetch|network|timeout|Failed to fetch/i.test(message)) return '连接暂时中断。请重试连接查看已有任务，避免重复启动。';
    return '分析未完成。请重试连接查看任务状态，再选择少量照片重新分析；详细原因见本地服务日志。';
  }

  async function watchRun(id) {
    stopPolling(); activeRun = id; runInput.value = id; progress.hidden = false; renderContext();
    await pollRun(id, pollToken);
  }

  async function recoverRun() {
    try {
      const status = await getApi()('/runs/status');
      if (status.active) {
        health.textContent = '已有分析在进行，可查看下方进度或取消。';
        await watchRun(status.active.id);
      } else {
        const latest = status.recent?.[0];
        if (!latest) return;
        runInput.value = latest.id;
        if (['failed', 'cancelled', 'interrupted'].includes(latest.status)) {
          progress.hidden = false;
          progressText.textContent = latest.status === 'failed' ? friendlyFailure(latest.error)
            : '上次分析已取消或中断。缓存仍可复用，可重新开始分析。';
        } else health.textContent += ' · 已找到最近结果，点击打开继续审阅。';
      }
    } catch (error) { if (error.status !== 404) health.textContent = friendlyFailure(error.message); }
  }

  async function pollRun(runId, token = pollToken) {
    if (token !== pollToken || activeRun !== runId) return;
    const run = await getApi()(`/runs/${runId}`);
    if (token !== pollToken || activeRun !== runId) return;
    const value = run.progress || run;
    progressBar.max = value.total || 1;
    progressBar.value = value.completed || 0;
    const seconds = progressEstimate(run);
    const remaining = seconds === null ? "剩余时间估算中…" : `画质分析预计还需 ${seconds} 秒，后续人脸和分组另计`;
    const index = stageIndex(value.stage);
    progressText.textContent = `${analysisStages[index]} · 已处理 ${value.completed || 0} / ${value.total || 0} · ${remaining}`;
    const stages = optional("progressStages");
    if (stages) stages.innerHTML = analysisStages.map((label, step) =>
      `<li class="${step === index ? "current" : step < index ? "complete" : ""}"`
      + `${step === index ? ' aria-current="step"' : ''}>${step + 1} ${label}</li>`).join("");
    if (["completed", "failed", "cancelled", "interrupted"].includes(run.status)) {
      progress.hidden = run.status === "completed";
      if (run.status === "completed" && token === pollToken && activeRun === runId) {
        activeRun = null;
        await onRun(runId);
      }
      if (run.status !== "completed") {
        activeRun = null;
        progressText.textContent = run.status === "failed" ? friendlyFailure(run.error)
          : "分析已取消或中断。可在最近的分析中重新分析并复用缓存。";
      }
      renderContext();
      await refreshRecent();
      return;
    }
    queuePoll(runId, token);
  }

  function queuePoll(runId, token, delay = 700) {
    timer = setTimeout(() => pollRun(runId, token).catch(error => {
      if (token !== pollToken || activeRun !== runId) return;
      progressText.textContent = friendlyFailure(error.message);
      queuePoll(runId, token, 2000);
    }), delay);
  }

  root.querySelector("#analyzeSelected").addEventListener("click", async () => {
    try {
      await refreshContext();
      const model = primaryAnalysis(context, connected, Boolean(activeRun));
      if (model.disabled) return;
      await startAnalysis(model.itemIds);
    } catch (error) { health.textContent = `无法开始：${error.message}。请检查 Eagle 选择和服务连接。`; }
  });
  root.querySelector("#analyzeAll").addEventListener("click", () => startAnalysis().catch(error => {
    health.textContent = error.message;
  }));
  root.querySelector("#cancel").addEventListener("click", async () => {
    if (!activeRun) return;
    stopPolling();
    await getApi()(`/runs/${activeRun}/cancel`, { method: "POST" });
    activeRun = null;
    progressText.textContent = "已取消。可在最近的分析中重新分析。";
    renderContext();
    await refreshRecent();
  });
  root.querySelector("#openRun").addEventListener("click", () => {
    const runId = runInput.value.trim();
    if (runId) {
      stopPolling();
      watchRun(runId).catch(error => { health.textContent = friendlyFailure(error.message); });
    }
  });
  runInput.addEventListener("keydown", event => {
    if (event.key !== "Enter") return;
    event.preventDefault();
    const runId = runInput.value.trim();
    if (runId) {
      stopPolling();
      watchRun(runId).catch(error => { health.textContent = friendlyFailure(error.message); });
    }
  });
  if (autoRefresh && optional("libraryName")) {
    let checks = 0;
    const refresh = async () => {
      if (!optional("start")?.hidden) {
        try { await refreshContext(); } catch (error) { showText("selectionHint", `无法读取 Eagle 选择：${error.message}。请重试。`); }
        if (++checks % 4 === 0) {
          try {
            const response = await getApi()("/health");
            if (response.service !== "eagle-culling") throw new Error("服务类型不匹配");
            if (!connected) await checkHealth();
          } catch { if (connected) await checkHealth(); }
        }
      }
      contextTimer = setTimeout(refresh, 2500);
    };
    void refresh();
  }
  if (autoCheck) void checkHealth();
  return { checkHealth, refreshContext, refreshRecent, dispose() {
    stopPolling(); clearTimeout(serviceTimer); clearTimeout(contextTimer); recentToken += 1;
  } };
}
