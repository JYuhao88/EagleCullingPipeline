import { initEagleTheme } from "./theme.js";
import { mountPanelSettings } from "./panel-settings.js";
import { mountCacheSettings } from "./cache-settings.js";
import { createIdlePrefetcher } from "./idle-prefetch.js";
import { shouldAutoStart, launchLocalService, createRunNotifier, mountBackgroundLifecycle } from "./background.js";
import { defaultRepository, serviceCommand } from "./service-start.js";
import { analysisStages, stageIndex, readRecentRuns, analysisProgress } from "./start-model.js";
import { homeCard, taskView, sortTasks, friendlyFailure, measuredRate, selectionCount } from "./task-model.js";
import { eagleContext, isEagleEnvironment } from "./api.js";
import { placeStatus, librarySummary } from "./library-model.js";
import { mountLibraryView } from "./library-view.js";

export function createStartView({ root, api, getApi = () => api, onRun, autoCheck = true, autoRefresh = true,
  onOpen, loadedHidden = false }) {
  void initEagleTheme();
  const q = id => root.querySelector(`#${id}`);
  const storage = globalThis.localStorage;
  const notify = createRunNotifier({ storage, base: () => getApi().base });
  const health = q("health");
  q("repositoryPath").value = storage.getItem("eagle-culling-repository") || defaultRepository();
  const view = { connected: false, launching: false, active: null, submitting: false, context: {}, match: null,
    location: null, queueLength: 0, tasks: [], nextCursor: null, notice: "" };
  let visible = !globalThis.eagle && !root.hidden;
  let disposed = false, pollTimer = null, pollToken = 0, serviceTimer = null, contextTimer = null, healthTimer = null, nextTimer = null;
  let contextVersion = 0, contextKey = "", matchVersion = 0, tasksVersion = 0, serviceBase = getApi().base;

  const setText = (id, value) => { const node = q(id); if (node) node.textContent = value ?? ""; };
  const setNotice = text => { view.notice = text || ""; setText("homeNotice", view.notice); };

  function setHealth(state, text, title = text) {
    health.textContent = text; health.title = title;
    if (health.dataset) health.dataset.state = state;
  }

  function button(label, onClick, className = "") {
    const node = root.createElement("button");
    node.textContent = label;
    if (className) node.className = className;
    node.addEventListener("click", event => { event.stopPropagation?.(); void onClick(); });
    return node;
  }

  function renderCard() {
    const start = q("start");
    if (start?.dataset) start.dataset.submitting = String(view.submitting);
    const card = homeCard({ ...view, secondsPerPhoto: measuredRate(view.tasks) });
    const startsCulling = card.action?.action === "review" || card.secondary?.some(item => item.action === "openMatch");
    const node = q("primaryCard");
    if (node?.dataset) node.dataset.kind = card.kind;
    setText("primaryEyebrow", card.eyebrow);
    setText("primaryTitle", card.title);
    setText("primaryDetail", card.detail);
    setText("primaryNote", [card.note, startsCulling ? "在 Eagle 里选中照片，右栏会显示它所在的分组和 AI 建议；直接按 5/3/2/1 打星。" : ""]
      .filter(Boolean).join(" "));
    const chip = q("primaryChip");
    if (chip) { chip.hidden = !card.chip; chip.textContent = card.chip || ""; }
    const action = q("primaryAction");
    action.hidden = !card.action;
    if (card.action) { action.textContent = card.action.label; action.disabled = Boolean(card.action.disabled); }
    action.onclick = () => card.action && perform(card.action.action, card.task);
    const secondary = q("secondaryActions");
    secondary?.replaceChildren(...(card.secondary || []).filter(item => item.action !== "cancel")
      .map(item => button(item.label, () => perform(item.action, card.task))));
    const more = q("moreActions");
    if (more) {
      more.hidden = !card.more?.length;
      q("moreList")?.replaceChildren(...(card.more || []).map(item => button(item.label, () => {
        more.open = false; return perform(item.action, card.task);
      })));
    }
    q("cancel").hidden = card.kind !== "progress";
    q("progress").hidden = card.kind !== "progress";
    q("serviceGuide").hidden = view.connected;
    q("startService").hidden = true;
    const openLibrary = q("openLibrary");
    openLibrary.hidden = !view.connected || !view.context.libraryPath;
    const summary = librarySummary(library.state.overview);
    openLibrary.textContent = summary ? `${summary} ›` : "资源库进度 ›";
    setText("libraryName", view.context.libraryName || "浏览器预览");
  }

  function renderProgress(run) {
    const model = analysisProgress(run);
    const bar = q("bar");
    if (model.overallPercent === null) bar.removeAttribute?.("value"); else bar.value = model.overallPercent;
    const index = stageIndex(run.progress?.stage);
    const stages = q("progressStages");
    if (stages) stages.innerHTML = analysisStages.map((label, step) => `<li class="${step === index ? "current"
      : step < index ? "complete" : ""}"${step === index ? ' aria-current="step"' : ""}>${label}</li>`).join("");
    setText("progressText", model.text);
  }

  function taskRow(run) {
    const model = taskView(run);
    const row = root.createElement("article");
    row.className = "task-row";
    if (row.dataset) { row.dataset.state = model.state; row.dataset.runId = run.id; }
    const body = root.createElement("div");
    body.className = "task-body";
    const head = root.createElement("div");
    head.className = "task-head";
    const title = root.createElement("strong");
    title.textContent = model.title;
    const chip = root.createElement("span");
    chip.className = "chip";
    chip.textContent = model.chip;
    head.append(title, chip);
    const meta = root.createElement("p");
    meta.className = "task-meta";
    meta.textContent = model.meta;
    const detail = root.createElement("p");
    detail.className = "task-detail";
    detail.textContent = model.detail;
    body.append(head, meta, detail);
    if (model.progress !== null) {
      const bar = root.createElement("progress");
      bar.max = 100; bar.value = model.progress;
      body.append(bar);
    }
    const action = button(model.primary.label, () => perform(model.primary.action, run));
    const actions = root.createElement("div");
    actions.className = "task-actions"; actions.append(action);
    for (const item of model.secondary) actions.append(button(item.label, () => perform(item.action, run), "secondary"));
    row.append(body, actions);
    row.addEventListener("click", event => { if (!event.target.closest?.("button")) void perform(model.primary.action, run); });
    return row;
  }

  // Earlier analyses live in 设置 › 分析记录; the home page only shows the one thing to do now.
  function renderTasks() {
    const ordered = sortTasks(view.tasks.filter(run => run.id !== view.active?.id || run.status !== "running"));
    q("historyRuns")?.replaceChildren(...ordered.map(taskRow));
    q("moreRuns").hidden = view.nextCursor === null;
    setText("historyStatus", view.tasks.length ? "" : view.connected ? "还没有分析记录。" : "");
  }

  function render() { renderCard(); renderTasks(); }

  async function refreshTasks(append = false) {
    if (!view.connected) return;
    const token = ++tasksVersion;
    const cursor = append ? view.nextCursor : 0;
    const library = view.context.libraryPath ? `&libraryPath=${encodeURIComponent(view.context.libraryPath)}` : "";
    const superseded = q("showSuperseded")?.checked ? "&includeSuperseded=1" : "";
    try {
      const response = await getApi()(`/runs?limit=20&cursor=${cursor}${library}${superseded}`);
      if (token !== tasksVersion) return;
      view.tasks = append ? [...view.tasks, ...(response.runs || [])] : response.runs || [];
      view.nextCursor = response.page?.nextCursor ?? null;
    } catch (error) {
      if (token !== tasksVersion) return;
      const runs = [];
      for (const id of readRecentRuns(storage)) {
        try { runs.push(await getApi()(`/runs/${id}`)); } catch { /* Old records may be gone. */ }
      }
      view.tasks = runs.filter(run => !view.context.libraryPath || run.libraryPath === view.context.libraryPath);
      view.nextCursor = null;
      if (!runs.length) setText("historyStatus", `暂时无法读取分析记录：${error.message}`);
    }
    if (view.match) view.match = { ...view.match, run: view.tasks.find(run => run.id === view.match.runId) || view.match.run };
    render();
  }

  function scopeRequest(context) {
    const selected = (context.itemIds || []).length > 0;
    if (selected) return { itemIds: context.itemIds, scope: { type: "selection", label: `选中的 ${context.itemIds.length} 张` } };
    if (context.folders?.length) {
      return { itemIds: context.folderItemIds || [], scope: { type: "folder",
        label: context.folders.map(folder => folder.name || "未命名").join("、"),
        ...(context.folders.length === 1 && context.folders[0].id ? { folderId: context.folders[0].id } : {}) } };
    }
    return null;
  }

  async function fullContext() {
    return isEagleEnvironment() ? eagleContext({ selected: true, includeFolderItems: true })
      : { ...view.context, itemIds: [], folders: [] };
  }

  // Which task the current Eagle selection belongs to, and which folders it sits in. Only re-asked when the selection
  // changes; looking never starts an analysis.
  async function refreshMatch() {
    const version = ++matchVersion;
    if (!view.connected || !selectionCount(view.context) || !view.context.libraryPath) {
      view.match = null; view.location = null; renderCard(); return;
    }
    try {
      const context = await fullContext();
      const request = scopeRequest(context);
      if (version !== matchVersion || !request?.itemIds.length) return;
      const post = (path, body) => getApi()(path, { method: "POST", headers: { "content-type": "application/json" },
        body: JSON.stringify({ libraryPath: context.libraryPath, ...body }) });
      const [response, location] = await Promise.all([
        post("/runs/match", { itemIds: request.itemIds, scope: request.scope }),
        post("/library/selection", context.itemIds.length ? { itemIds: context.itemIds }
          : { folderIds: (context.folders || []).map(folder => folder.id) }).catch(() => null)]);
      if (version !== matchVersion) return;
      view.location = location;
      if (location) view.queueLength = location.queueLength || 0;
      const match = response.match;
      view.match = match ? { ...match, run: view.tasks.find(run => run.id === match.runId) ||
        await getApi()(`/runs/${match.runId}`).catch(() => null) } : null;
      if (view.match && !view.match.run) view.match = null;
    } catch { view.match = null; }
    if (version === matchVersion) renderCard();
  }

  async function refreshContext() {
    if (!isEagleEnvironment()) {
      view.context = { libraryPath: q("libraryPath").value.trim(), libraryName: "浏览器预览", itemIds: [], folders: [] };
      renderCard();
      return;
    }
    const version = ++contextVersion;
    const next = await eagleContext({ lightweight: true });
    if (version !== contextVersion || disposed) return;
    const key = JSON.stringify([next.libraryPath, next.selectionCount, next.folders.map(folder => folder.id), next.folderCount]);
    view.context = next;
    if (key !== contextKey) { contextKey = key; void refreshMatch(); }
    renderCard();
  }

  const performanceMode = () => storage.getItem("eagle-culling-turbo") === "1" ? "turbo" : "normal";
  const rememberRun = run => storage.setItem("eagle-culling-recent-runs",
    JSON.stringify([run.id, ...readRecentRuns(storage).filter(id => id !== run.id)].slice(0, 10)));

  async function submit(body) {
    if (view.submitting) return;
    view.submitting = true; setNotice(""); renderCard();
    try {
      const run = await getApi()("/runs", { method: "POST", headers: { "content-type": "application/json" },
        body: JSON.stringify({ ...body, performanceMode: performanceMode() }) });
      rememberRun(run);
      await watchRun(run);
    } catch (error) {
      if (error.status === 409 && error.body?.run) { setNotice("已有分析在进行。"); await watchRun(error.body.run); }
      else setNotice(error.status === 409 ? error.message : friendlyFailure(error.message));
    } finally { view.submitting = false; render(); void refreshTasks(); }
  }

  // Every analysis started from the home page goes through the queue: it starts now if nothing else runs.
  async function enqueue(scopes) {
    if (view.submitting || !scopes.length) return;
    view.submitting = true; setNotice(""); renderCard();
    try {
      const response = await getApi()("/queue", { method: "POST", headers: { "content-type": "application/json" },
        body: JSON.stringify({ libraryPath: view.context.libraryPath, scopes, performanceMode: performanceMode() }) });
      view.queueLength = response.queue?.length || 0;
      if (response.started) { rememberRun(response.started); await watchRun(response.started); }
      else setNotice(response.added ? `已排队，队列里现在有 ${view.queueLength} 个，轮到时自动开始。` : "已经在排队了。");
    } catch (error) { setNotice(`排队失败：${error.message}`); }
    finally { view.submitting = false; render(); void refreshMatch(); }
  }

  async function queueSelection() {
    const context = await fullContext();
    if (!context.itemIds?.length) throw new Error("没有选中照片");
    await enqueue([{ type: "selection", itemIds: context.itemIds }]);
  }

  function showLibrary() { settings.show("libraryView"); }

  async function perform(action, run) {
    try {
      if (action === "queueScopes") {
        return await enqueue((view.location?.scopes || []).filter(scope => ["none", "partial"].includes(placeStatus(scope).state))
          .map(scope => scope.type === "folder" ? { type: "folder", folderId: scope.folderId } : { type: "unfiled" }));
      }
      if (action === "queueSelection") return await queueSelection();
      if (action === "openLibrary") return showLibrary();
      if (action === "startService") return await startService();
      if (action === "cancel") return await cancel();
      if (action === "watch") return await watchRun(run);
      if (action === "resume") return await submit({ resumeRunId: run.id });
      if (action === "rerun") return await submit({ rerunOf: run.id });
      if (action === "reselect") {
        return setNotice(`在 Eagle 里重新选中「${run.scope?.label || "这批照片"}」所在的文件夹，再点「排队」。已做的决定会自动带上。`);
      }
      if (action === "review") return await onRun(run.id);
      if (action === "finish") return await onRun(run.id, { finish: true });
      if (action === "openMatch") return await onRun(view.match.run.id);
    } catch (error) {
      setNotice(/resumable|Run missing|run not found/i.test(error.message)
        ? "这条记录无法继续。请在 Eagle 重新选择照片后分析，已做的决定会自动带上。" : `操作失败：${error.message}`);
    }
  }

  const stopPolling = () => { clearTimeout(pollTimer); pollTimer = null; pollToken++; };

  async function watchRun(run) {
    stopPolling();
    view.active = run; renderProgress(run); render();
    storage.setItem(`eagle-culling-active:${getApi().base}`, run.id);
    await poll(run.id, pollToken);
  }

  async function finishWatching(run) {
    view.active = null;
    storage.removeItem?.(`eagle-culling-active:${getApi().base}`);
    await notify(run);
    if (run.status === "completed") setNotice(`「${run.scope?.label || "分析"}」已完成，可以开始挑选。`);
    else if (run.status === "failed") setNotice(friendlyFailure(run.error));
    else setNotice("分析已暂停，已完成的部分会保留，之后可以继续。");
    await refreshTasks();
    void refreshMatch();
    // The service starts the next queued folder by itself; follow it.
    if (view.queueLength) { clearTimeout(nextTimer); nextTimer = setTimeout(() => { if (!view.active) void recover(); }, 1500); }
  }

  async function poll(id, token) {
    if (token !== pollToken) return;
    let run;
    try { run = await getApi()(`/runs/${id}`); }
    catch (error) {
      if (token === pollToken) { setNotice(friendlyFailure(error.message)); pollTimer = setTimeout(() => poll(id, token), 5000); }
      return;
    }
    if (token !== pollToken) return;
    if (["completed", "failed", "cancelled", "interrupted"].includes(run.status)) { await finishWatching(run); return; }
    view.active = run; renderProgress(run); renderCard();
    pollTimer = setTimeout(() => poll(id, token), visible ? 2000 : 10000);
  }

  async function cancel() {
    if (!view.active) return;
    const id = view.active.id;
    stopPolling();
    await getApi()(`/runs/${id}/cancel`, { method: "POST" });
    await finishWatching({ ...view.active, status: "cancelled" });
  }

  async function recover() {
    try {
      const status = await getApi()("/runs/status");
      if (status.active) { await watchRun(status.active); return; }
      const pendingId = storage.getItem(`eagle-culling-active:${getApi().base}`);
      if (pendingId) {
        const pending = await getApi()(`/runs/${pendingId}`).catch(() => null);
        storage.removeItem?.(`eagle-culling-active:${getApi().base}`);
        if (pending) await notify(pending);
      }
    } catch { /* Older services lack /runs/status; tasks still show state. */ }
  }

  function updateCommand() {
    try { setText("serviceCommand", serviceCommand(q("repositoryPath").value, getApi().base)); }
    catch (error) { setText("serviceCommand", error.message); }
  }

  async function checkHealth() {
    if (serviceBase !== getApi().base) { serviceBase = getApi().base; stopPolling(); view.active = null; view.tasks = []; }
    try {
      const response = await getApi()("/health");
      if (response.service !== "eagle-culling") throw new Error("服务类型不匹配");
      view.connected = true;
      setHealth("connected", "已连接", "本机分析服务已连接");
      if (!view.active) await recover(); else await watchRun(view.active);
      await refreshTasks();
      void refreshMatch();
      void library.refresh().then(renderCard).catch(() => {});
      return true;
    } catch {
      view.connected = false;
      setHealth(view.launching ? "starting" : "offline", view.launching ? "启动中" : "未运行",
        "分析服务未运行；在设置 › 高级中查看诊断");
      updateCommand();
      render();
      return false;
    }
  }

  async function startService(automatic = false) {
    if (view.launching || disposed) return;
    if (automatic && !shouldAutoStart({ connected: view.connected, enabled: storage.getItem("eagle-culling-autostart") !== "0",
      repository: q("repositoryPath").value, base: getApi().base })) return;
    if (typeof globalThis.require !== "function") {
      setNotice("浏览器预览无法启动服务。请在终端运行设置 › 高级中的启动命令。");
      return;
    }
    view.launching = true; render();
    try {
      if (await checkHealth()) return;
      await launchLocalService({ repository: q("repositoryPath").value, base: getApi().base,
        allowed: () => !automatic || storage.getItem("eagle-culling-autostart") !== "0" });
      for (let attempt = 0; attempt < 30 && !disposed; attempt++) {
        if (await checkHealth()) return;
        await new Promise(resolve => { serviceTimer = setTimeout(resolve, 1000); });
      }
      throw new Error("启动后仍未连接，请检查 Node 和仓库路径");
    } catch (error) {
      setText("serviceDiagnostics", error.message);
      setNotice(`启动失败：${error.message}。可在设置 › 高级复制启动命令手动运行。`);
    } finally {
      view.launching = false;
      if (!disposed && !view.connected) { setHealth("offline", "未运行", "分析服务未运行；在设置 › 高级中查看诊断"); render(); }
    }
  }

  q("cancel").addEventListener("click", () => perform("cancel"));
  q("retryService").addEventListener("click", checkHealth);
  q("startService").addEventListener("click", () => startService());
  q("openLibrary").addEventListener("click", showLibrary);
  q("closeLibrary")?.addEventListener("click", () => settings.show("panelHome"));
  q("moreRuns").addEventListener("click", () => refreshTasks(true));
  q("showSuperseded")?.addEventListener("change", () => refreshTasks());
  q("repositoryPath").addEventListener("change", () => {
    storage.setItem("eagle-culling-repository", q("repositoryPath").value.trim()); updateCommand();
  });
  q("copyServiceCommand").addEventListener("click", async () => {
    try { await navigator.clipboard.writeText(serviceCommand(q("repositoryPath").value, getApi().base));
      setNotice("启动命令已复制，在终端粘贴运行后点「重试连接」。"); }
    catch (error) { setNotice(`复制失败，请手动复制：${error.message}`); }
  });
  const openById = () => {
    const id = q("runId").value.trim();
    if (id) onRun(id, { finish: true }).catch(error => setNotice(`无法打开：${error.message}`));
  };
  q("openRun").addEventListener("click", openById);
  q("runId").addEventListener("keydown", event => { if (event.key === "Enter") { event.preventDefault(); openById(); } });

  const library = mountLibraryView({ root, getApi, getLibraryPath: () => view.context.libraryPath || "", performanceMode,
    onChange: response => {
      if (response?.queue) view.queueLength = response.queue.length;
      if (response?.started) { rememberRun(response.started); void watchRun(response.started); }
      void refreshMatch();
    } });
  const settings = mountPanelSettings({ root, storage, onShow: name => {
    library.setVisible(name === "libraryView");
    if (name === "panelHome") renderCard();
  } });
  const cacheSettings = mountCacheSettings({ root, getApi, storage });
  const prefetcher = createIdlePrefetcher({ storage, getApi, isVisible: () => visible, isConnected: () => view.connected,
    isBusy: () => Boolean(view.active) || view.submitting });

  function setVisible(value) {
    visible = value; contextVersion++; clearTimeout(contextTimer);
    if (visible && autoRefresh) void prefetcher.tick({ force: true });
    if (visible && autoRefresh) void refreshContext().then(() => refreshTasks()).catch(() => {}).then(refreshVisible);
  }
  async function refreshVisible() {
    if (!visible || disposed || root.hidden) return;
    if (!q("start")?.hidden) { try { await refreshContext(); } catch (error) { setNotice(error.message); } }
    if (visible && !disposed) { clearTimeout(contextTimer); contextTimer = setTimeout(refreshVisible, 1500); }
  }
  const lifecycle = mountBackgroundLifecycle({ onVisible: setVisible, onOpen, loadedHidden,
    onCreate: async () => { await checkHealth(); await startService(true); } });
  globalThis.eagle?.onLibraryChanged?.(libraryPath => {
    contextVersion++; contextKey = ""; matchVersion++;
    view.context = { libraryPath, libraryName: libraryPath?.split(/[\\/]/).pop(), itemIds: [], folders: [] };
    view.match = null; view.location = null; view.queueLength = 0; view.tasks = []; tasksVersion++;
    library.reset();
    render();
    void refreshTasks();
    if (visible) void refreshContext().then(() => refreshTasks()).catch(() => {});
  });
  root.addEventListener?.("visibilitychange", () => setVisible(!root.hidden));
  if (autoRefresh) {
    prefetcher.start();
    setVisible(visible);
    healthTimer = setInterval(async () => {
      try {
        const response = await getApi()("/health");
        if (response.service !== "eagle-culling") throw new Error("服务类型不匹配");
        if (!view.connected || (response.activeRunId && !view.active)) await checkHealth();
      } catch { if (view.connected) { view.connected = false; setHealth("offline", "未运行"); render(); } }
    }, 60000);
  }
  render();
  if (autoCheck) void checkHealth().then(() => startService(true));
  return { setNotice, reloadPage: () => lifecycle.reload(), checkHealth, refreshContext, refreshRecent: refreshTasks,
    refreshTasks, setVisible, startService, settings, cacheSettings, prefetcher, view, dispose() {
      disposed = true; stopPolling(); prefetcher.stop(); clearTimeout(serviceTimer); clearTimeout(contextTimer);
      clearTimeout(nextTimer); library.dispose();
      clearInterval(healthTimer); tasksVersion++; contextVersion++; matchVersion++;
    } };
}
