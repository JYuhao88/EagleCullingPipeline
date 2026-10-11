import { defaultRepository, serviceCommand, serviceOptions, progressEstimate } from "./service-start.js";
import { eagleContext, isEagleEnvironment } from "./api.js";

export function createStartView({ root, api, getApi = () => api, onRun, autoCheck = true }) {
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
      health.textContent = `服务已连接 · ${getApi().base || ""}`;
      guide.hidden = true;
      return true;
    } catch {
      health.textContent = "服务未连接。请启动本地服务后重试；终端需安装 Node.js ≥ 20。";
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
      const options = serviceOptions(repository.value, getApi().base);
      const { spawn } = require("node:child_process");
      const child = spawn("nice", ["-n", "15", "node", "src/cli.js", "serve",
        "--concurrency", "1", "--port", String(options.port)], { cwd: options.cwd, detached: true, stdio: "ignore" });
      let startupFailed = false;
      child.on("error", error => {
        startupFailed = true;
        clearTimeout(serviceTimer);
        health.textContent = `启动失败：${error.message}。请使用复制命令。`;
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
          startButton.disabled = false;
          return;
        }
        health.textContent = "正在等待本地服务启动…";
        serviceTimer = setTimeout(poll, 1000);
      };
      await poll();
    } catch (error) {
      health.textContent = `无法直接启动：${error.message}。请使用复制命令。`;
      startButton.disabled = false;
    }
  });

  async function startAnalysis(itemIds) {
    stopPolling();
    const context = isEagleEnvironment()
      ? await eagleContext()
      : { libraryPath: libraryInput.value.trim(), itemIds: [] };
    const libraryPath = context.libraryPath;
    if (!libraryPath) throw new Error("请填写资源库路径");
    const body = { libraryPath };
    if (itemIds) body.itemIds = itemIds;
    const run = await getApi()("/runs", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body)
    });
    activeRun = run.id;
    progress.hidden = false;
    localStorage.setItem("eagle-culling-recent-runs", JSON.stringify([run.id, ...recentRuns().filter(id => id !== run.id)].slice(0, 10)));
    await pollRun(run.id, pollToken);
  }

  async function pollRun(runId, token = pollToken) {
    if (token !== pollToken || activeRun !== runId) return;
    const run = await getApi()(`/runs/${runId}`);
    if (token !== pollToken || activeRun !== runId) return;
    const value = run.progress || run;
    progressBar.max = value.total || 1;
    progressBar.value = value.completed || 0;
    const seconds = progressEstimate(run);
    const remaining = seconds === null ? "剩余时间估算中（含人脸检测及最终分组）" : `指标阶段预计剩余 ${seconds} 秒`;
    const stage = { scanning: "扫描", metrics: "指标分析", faces: "人脸检测", grouping: "最终分组", done: "完成" };
    progressText.textContent = `${stage[value.stage] || run.status || ""} ${value.completed || 0}/${value.total || 0}`
      + ` · 缓存命中 ${value.cached || 0} · ${remaining}`;
    progressText.textContent += "。全量分组完成后自动进入审阅，避免组变化影响决定。";
    if (["completed", "failed", "cancelled"].includes(run.status)) {
      progress.hidden = run.status === "completed";
      if (run.status === "completed" && token === pollToken && activeRun === runId) {
        activeRun = null;
        await onRun(runId);
      }
      if (run.status === "failed") progressText.textContent = `分析失败：${run.error || "未知错误"}`;
      return;
    }
    timer = setTimeout(() => pollRun(runId, token).catch(error => {
      progressText.textContent = error.message;
    }), 700);
  }

  function recentRuns() {
    try { return JSON.parse(localStorage.getItem("eagle-culling-recent-runs") || "[]"); } catch { return []; }
  }

  root.querySelector("#analyzeSelected").addEventListener("click", async () => {
    try {
      const context = await eagleContext();
      await startAnalysis(context.itemIds);
    } catch (error) {
      health.textContent = error.message;
    }
  });
  root.querySelector("#analyzeAll").addEventListener("click", () => startAnalysis().catch(error => {
    health.textContent = error.message;
  }));
  root.querySelector("#cancel").addEventListener("click", async () => {
    if (!activeRun) return;
    stopPolling();
    await getApi()(`/runs/${activeRun}/cancel`, { method: "POST" });
    progressText.textContent = "已取消";
  });
  root.querySelector("#openRun").addEventListener("click", () => {
    const runId = runInput.value.trim();
    if (runId) {
      stopPolling();
      activeRun = runId;
      onRun(runId).catch(error => {
      health.textContent = error.message;
      });
    }
  });
  runInput.addEventListener("keydown", event => {
    if (event.key !== "Enter") return;
    event.preventDefault();
    const runId = runInput.value.trim();
    if (runId) {
      stopPolling();
      activeRun = runId;
      onRun(runId).catch(error => { health.textContent = error.message; });
    }
  });
  if (autoCheck) checkHealth();
  return { checkHealth };
}
