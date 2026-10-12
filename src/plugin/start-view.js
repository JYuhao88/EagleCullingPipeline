import { initEagleTheme } from "./theme.js";
import { mountPanelSettings } from "./panel-settings.js";
import { shouldAutoStart, launchLocalService, createRunNotifier, mountBackgroundLifecycle } from "./background.js";
import { defaultRepository, serviceCommand } from "./service-start.js";
import { primaryAnalysis, analysisStages, stageIndex, readRecentRuns, analysisProgress, scopeLabel, completionText } from
  "./start-model.js";
import { eagleContext, isEagleEnvironment } from "./api.js";

export function createStartView({ root, api, getApi = () => api, onRun, autoCheck = true, autoRefresh = true }) {
  void initEagleTheme();
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
  let serviceBase = getApi().base;
  let submitting = false;
  let context = {};
  let contextKey = "";
  let contextTimer = null;
  let healthTimer = null;
  let visible = !globalThis.eagle && !root.hidden;
  let launching = false;
  let contextVersion = 0;
  let disposed = false;
  let recentCursor = null;
  let recentToken = 0;
  const recentDetails = new Map();
  const optional = id => root.querySelector(`#${id}`);
  const showText = (id, value) => { const element = optional(id); if (element) element.textContent = value; };
  const storage = globalThis.localStorage;
  const notify = createRunNotifier({ storage, base: () => getApi().base });
  function renderContext() {
    const model = primaryAnalysis(context, connected, Boolean(activeRun) || submitting);
    const button = root.querySelector("#analyzeSelected");
    button.hidden = Boolean(activeRun);
    button.textContent = model.label;
    button.disabled = model.disabled;
    root.querySelector("#analyzeAll").disabled = !connected || Boolean(activeRun) || submitting;
    showText("scopeLabel", scopeLabel(context));
    showText("selectionHint", model.hint);
    showText("libraryName", context.libraryName || "浏览器预览");
    showText("folderName", context.folders?.map(folder => folder.name).join("、") || "未选择");
    showText("selectionCount", `${context.selectionCount ?? context.itemIds?.length ?? 0} 张`);
    const count = context.libraryCount;
    root.querySelector("#analyzeAll").textContent = `分析整个资源库${count == null ? "（张数待扫描）" : `（${count} 张）`}`;
    showText("allHint", `${count == null ? "扫描后确认总张数；" : `共 ${count} 张；`}全库分析可能较久，建议先试一个文件夹。`);
    syncPrimary();
  }
  // Only one primary action: a finished, unopened result outranks starting a new analysis.
  function syncPrimary() {
    const reviewReady = optional("resumeArea") && !optional("resumeArea").hidden;
    root.querySelector("#analyzeSelected")?.classList?.toggle("primary", !reviewReady);
  }
  async function refreshContext() {
    if (!isEagleEnvironment()) {
      context = { libraryPath: libraryInput.value.trim(), libraryName: "浏览器预览", itemIds: [], folders: [] };
      renderContext();
      return;
    }
    const version = ++contextVersion;
    const next = await eagleContext({ lightweight: true });
    if (version !== contextVersion || disposed) return;
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
    if (!append) { container.replaceChildren(); optional("historyRuns")?.replaceChildren(); recentDetails.clear(); }
    showText("recentStatus", "正在读取最近的分析…");
    try {
      let response;
      try { response = await
        getApi()(`/runs?limit=20&cursor=${append ? recentCursor : 0}`
          + (context.libraryPath ? `&libraryPath=${encodeURIComponent(context.libraryPath)}` : "")); }
      catch {
        const runs = [];
        for (const id of readRecentRuns(storage)) {
          try { const run = await getApi()(`/runs/${id}`);
            if (!context.libraryPath || run.libraryPath === context.libraryPath) runs.push(run); } catch { /* Missing old runs can
              be ignored. */ }
        }
        response = { runs, page: { nextCursor: null }, localOnly: true };
      }
      if (token !== recentToken) return;
      recentCursor = response.page?.nextCursor ?? null;
      if (!append) {
        const latest = (response.runs || []).find(run => run.status === "completed");
        if ((latest || completedResult) && !activeRun) showResume(completedResult && (!latest ||
          !(Date.parse(latest.startedAt) > Date.parse(completedResult.startedAt))) ? completedResult : latest);
        else if (optional("resumeArea")) optional("resumeArea").hidden = true;
      }
      let recentCount = 0;
      for (const run of response.runs || []) {
        const card = root.createElement("article");
        card.className = "recent-run";
        const title = root.createElement("strong");
        title.textContent = run.scope?.label || "历史分析";
        const detail = root.createElement("p");
        const status = { completed: "可审阅", failed: "分析失败", cancelled: "已取消", running: "分析中", queued: "等待分析", interrupted: "已中断" };
        const date = run.startedAt ? new Date(run.startedAt).toLocaleString("zh-CN") : "时间未记录";
        const reviewed = run.reviewedGroupCount == null ? "" : ` · 已审 ${run.reviewedGroupCount} / ${run.groupCount} 组`;
        detail.textContent = `${date} · ${run.itemCount || 0} 张 · ${run.groupCount || 0} 组${reviewed} · ${status[run.status] || "状态未知"}`;
        const baseDetail = detail.textContent;
        if (["running", "queued"].includes(run.status)) detail.textContent += ` · ${analysisProgress(run).text}`;
        recentDetails.set(run.id, { element: detail, baseDetail });
        if (run.status === "running") {
          detail.textContent += ` · ${run.progress?.completed || 0}/${run.progress?.total || 0}`;
        }
        const button = root.createElement("button");
        button.textContent = ["failed", "cancelled", "interrupted"].includes(run.status) ? "重新分析"
          : run.status === "completed" ? "继续审阅" : "查看进度";
        const activate = async () => {
          if (button.disabled) return;
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
        };
        button.addEventListener("click", activate);
        card.addEventListener("click", event => {
          if (!event.target.closest?.("button")) void activate();
        });
        card.append(title, detail);
        if (["failed", "cancelled", "interrupted"].includes(run.status)) {
          const reason = root.createElement("p");
          reason.textContent = run.status === "cancelled" ? "上次已取消，可重新分析并复用已完成的阶段。"
            : run.status === "interrupted" ? "上次分析中断，可重新分析并复用缓存。" : friendlyFailure(run.error);
          card.append(reason);
        }
        card.append(button);
        if (!append && recentCount++ < 3) container.append(card);
        const history = optional("historyRuns");
        if (history && card.cloneNode) {
          const copy = card.cloneNode(true);
          copy.querySelector("button")?.addEventListener("click", activate);
          copy.addEventListener("click", event => { if (!event.target.closest?.("button")) void activate(); });
          history.append(copy);
        } else history?.append(card);
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
    if (serviceBase !== getApi().base) {
      serviceBase = getApi().base; stopPolling(); activeRun = null;
      resumeId = null; completedResult = null; progress.hidden = true;
      if (optional("resumeArea")) optional("resumeArea").hidden = true;
    }
    try {
      const response = await getApi()("/health");
      if (response.service !== "eagle-culling") throw new Error("服务类型不匹配");
      connected = true;
      health.textContent = "已连接";
      health.title = "本机分析服务已连接";
      if (health.dataset) health.dataset.state = "connected";
      renderContext();
      await refreshRecent();
      guide.hidden = true;
      if (!activeRun) await recoverRun();
      return true;
    } catch {
      connected = false;
      health.textContent = launching ? "启动中" : "未运行";
      health.title = "分析服务未运行；点击重试启动或在设置中查看诊断";
      if (health.dataset) health.dataset.state = launching ? "starting" : "offline";
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
  async function startService(automatic = false) {
    if (launching || disposed) return;
    if (automatic && !shouldAutoStart({ connected, enabled: storage.getItem('eagle-culling-autostart') !== '0',
      repository: repository.value, base: getApi().base })) return;
    if (typeof globalThis.require !== 'function') return;
    launching = true; startButton.disabled = true;
    try {
      if (await checkHealth()) return;
      if (automatic && storage.getItem('eagle-culling-autostart') === '0') return;
      await launchLocalService({ repository: repository.value, base: getApi().base,
        allowed: () => !automatic || storage.getItem("eagle-culling-autostart") !== "0" });
      for (let attempt = 0; attempt < 30 && !disposed; attempt++) {
        if (await checkHealth()) return;
        showText('serviceHint', '启动中…');
        await new Promise(resolve => { serviceTimer = setTimeout(resolve, 1000); });
      }
      throw new Error('启动后仍未连接，请检查 Node 和仓库路径');
    } catch (error) {
      showText('serviceHint', '启动失败');
      showText('serviceDiagnostics', error.message);
      health.textContent = '未运行'; health.title = error.message;
      guide.hidden = false; startButton.hidden = false;
    } finally { launching = false; startButton.disabled = false; }
  }
  startButton.addEventListener('click', () => startService());

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
        method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ ...body, performanceMode:
          storage.getItem("eagle-culling-turbo") === "1" ? "turbo" : "normal" })
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
    if (optional("resumeArea")) optional("resumeArea").hidden = true;
    storage.setItem(`eagle-culling-active:${getApi().base}`, id);
    await pollRun(id, pollToken);
  }

  async function recoverRun() {
    try {
      const status = await getApi()('/runs/status');
      if (status.active) {
        health.textContent = '已有分析在进行，可查看下方进度或取消。';
        await watchRun(status.active.id);
      } else {
        const pendingId = storage.getItem(`eagle-culling-active:${getApi().base}`);
        if (pendingId) {
          const pending = await getApi()(`/runs/${pendingId}`);
          await notify(pending); storage.removeItem?.(`eagle-culling-active:${getApi().base}`);
          if (pending.status === "completed") showResume(pending);
        }
        const latest = status.recent?.[0];
        if (!latest) return;
        runInput.value = latest.id;
        if (['failed', 'cancelled', 'interrupted'].includes(latest.status)) {
          progress.hidden = false;
          progressText.textContent = latest.status === 'failed' ? friendlyFailure(latest.error)
            : '上次分析已取消或中断。缓存仍可复用，可重新开始分析。';
        }
      }
    } catch (error) { if (error.status !== 404) health.textContent = friendlyFailure(error.message); }
  }

  let resumeId = null;
  let completedResult = null;
  function showResume(run) {
    const area = optional("resumeArea");
    if (!area) return;
    if (context.libraryPath && run.libraryPath && context.libraryPath !== run.libraryPath) { area.hidden = true; return; }
    resumeId = run.id; completedResult = run;
    showText("resumeDetail", `${run.scope?.label || "最近结果"} · ${completionText(run)}`);
    area.hidden = false;
    syncPrimary();
  }
  optional("resumeLatest")?.addEventListener("click", async () => {
    if (!resumeId) return;
    const button = optional("resumeLatest");
    button.disabled = true;
    try { await onRun(resumeId); }
    catch (error) { health.textContent = `无法打开：${error.message}。请重试或检查服务连接。`; }
    finally { button.disabled = false; }
  });

  async function pollRun(runId, token = pollToken) {
    if (token !== pollToken || activeRun !== runId) return;
    const run = await getApi()(`/runs/${runId}`);
    if (token !== pollToken || activeRun !== runId) return;
    const value = run.progress || run;
    const model = analysisProgress(run);
    progressBar.max = 100;
    if (model.overallPercent === null) progressBar.removeAttribute?.("value");
    else progressBar.value = model.overallPercent;
    const index = stageIndex(value.stage);
    const step = value.stage === "scanning" ? "读取资源库拍摄时间" : "当前步骤";
    progressText.textContent = `${model.text} · ${step} ${value.completed || 0}/${value.total || 0}`;
    const recent = recentDetails.get(runId);
    if (recent) recent.element.textContent = `${recent.baseDetail} · ${model.text} · ${value.completed || 0}/${value.total || 0}`;
    const stages = optional("progressStages");
    if (stages) stages.innerHTML = analysisStages.map((label, step) =>
      `<li class="${step === index ? "current" : step < index ? "complete" : ""}"`
      + `${step === index ? ' aria-current="step"' : ''}>${step + 1} ${label}</li>`).join("");
    if (["completed", "failed", "cancelled", "interrupted"].includes(run.status)) {
      progress.hidden = run.status === "completed";
      if (run.status === "completed" && token === pollToken && activeRun === runId) {
        activeRun = null;
        showResume(run);
      }
      if (run.status !== "completed") {
        activeRun = null;
        progressText.textContent = run.status === "failed" ? friendlyFailure(run.error)
          : "分析已取消或中断。可在最近的分析中重新分析并复用缓存。";
      }
      await notify(run);
      storage.removeItem?.(`eagle-culling-active:${getApi().base}`);
      renderContext();
      await refreshRecent();
      return;
    }
    queuePoll(runId, token);
  }

  function queuePoll(runId, token, delay = 5000) {
    timer = setTimeout(() => pollRun(runId, token).catch(error => {
      if (token !== pollToken || activeRun !== runId) return;
      progressText.textContent = friendlyFailure(error.message);
      queuePoll(runId, token, 5000);
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
      onRun(runId).catch(error => { health.textContent = friendlyFailure(error.message); });
    }
  });
  runInput.addEventListener("keydown", event => {
    if (event.key !== "Enter") return;
    event.preventDefault();
    const runId = runInput.value.trim();
    if (runId) {
      onRun(runId).catch(error => { health.textContent = friendlyFailure(error.message); });
    }
  });
  const settings = mountPanelSettings({ root, storage, onPersonalization: async () => {
    if (!resumeId) { showText('serviceDiagnostics', '先完成一次分析，再打开个性化设置。'); return; }
    await onRun(resumeId); root.querySelector('#reviewSettings')?.showModal?.();
  } });
  function setVisible(value) {
    visible = value; contextVersion++; clearTimeout(contextTimer);
    if (visible && autoRefresh) void refreshContext()
      .then(() => { if (visible && !disposed) return refreshRecent(); })
      .catch(() => {}).then(refreshVisible);
  }
  async function refreshVisible() {
    if (!visible || disposed || root.hidden) return;
    if (!optional('start')?.hidden) {
      try { await refreshContext(); } catch (error) { showText('selectionHint', error.message); }
    }
    if (visible && !disposed) { clearTimeout(contextTimer); contextTimer = setTimeout(refreshVisible, 1500); }
  }
  mountBackgroundLifecycle({ onVisible: setVisible, onCreate: async () => {
    await checkHealth(); await startService(true);
  } });
  globalThis.eagle?.onLibraryChanged?.(libraryPath => {
    contextVersion++; contextKey = ''; context = { libraryPath, libraryName: libraryPath?.split(/[\\/]/).pop(), itemIds: [],
      folders: [] }; resumeId = null; completedResult = null;
    recentToken++; optional('recentRuns')?.replaceChildren(); optional('historyRuns')?.replaceChildren();
    if (optional('resumeArea')) optional('resumeArea').hidden = true;
    renderContext();
    void refreshRecent();
    if (visible) void refreshContext().then(() => { if (visible) return refreshRecent(); }).catch(() => {});
  });
  root.addEventListener?.('visibilitychange', () => setVisible(!root.hidden));
  if (autoRefresh) {
    setVisible(visible);
    // Idle discovery uses health only; the server reports whether a run exists.
    healthTimer = setInterval(async () => {
      try {
        const response = await getApi()('/health');
        if (response.service !== 'eagle-culling') throw new Error('服务类型不匹配');
        if (!connected || response.activeRunId && !activeRun) await checkHealth();
      } catch { connected = false; health.textContent = "未运行"; health.title = "分析服务未运行";
        if (health.dataset) health.dataset.state = "offline"; guide.hidden = false; renderContext(); }
    }, 60000);
  }
  if (autoCheck) void checkHealth().then(() => startService(true));
  return { checkHealth, refreshContext, refreshRecent, setVisible, startService, settings, dispose() {
    disposed = true; stopPolling(); clearTimeout(serviceTimer); clearTimeout(contextTimer); clearInterval(healthTimer);
      recentToken += 1; contextVersion++;
  } };
}
