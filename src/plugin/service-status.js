import { serviceCompatibility } from "./runtime-contract.js";

// Read-only observations: no launch, task transition or process termination.
export async function inspectService(baseUrl, { fetchImpl = globalThis.fetch, timeoutMs = 1800 } = {}) {
  async function probe(path) {
    let httpStatus = null;
    try {
      const response = await fetchImpl(`${baseUrl}${path}`, { signal: AbortSignal.timeout(timeoutMs) });
      httpStatus = response.status;
      const body = await response.json();
      return { httpStatus: response.status, body, error: null };
    } catch (error) {
      return { httpStatus, body: null, error: error.message };
    }
  }
  const [health, version] = await Promise.all([probe("/health"), probe("/version")]);
  const observedAt = new Date().toISOString();
  const compatibility = serviceCompatibility(version.body || {});
  const versionText = version.body?.version || "未知";
  const snapshot = { observedAt, health, version, compatibility, versionText, ready: false };
  if (health.httpStatus === null && version.httpStatus === null) return { ...snapshot, state: "offline", title: "本地服务未连接", message: `未能读取健康状态和版本：${health.error}。服务可能未启动或连接超时；不要重复启动占用相同端口的进程。` };
  if (health.httpStatus !== 200 || health.body?.ok !== true || health.body?.service !== "eagle-culling") {
    return { ...snapshot, state: "unhealthy", title: "本地服务异常，暂不启动新任务", message: `端口有响应，但健康检查未通过：${health.body?.error || health.error || `HTTP ${health.httpStatus} / 服务身份或 ok 字段不符`}。先导出诊断，不会自动启动第二个服务。` };
  }
  if (version.httpStatus !== 200 || version.error) return { ...snapshot, state: "unhealthy", title: "服务版本无法确认", message: `健康检查有响应，但无法读取版本：${version.error || `HTTP ${version.httpStatus}`}。暂不启动新任务，不会自动重启。` };
  if (!compatibility.compatible) return { ...snapshot, state: "outdated", title: "服务版本不兼容，暂不启动新任务", message: compatibility.message };
  return { ...snapshot, ready: true, state: "ready", title: "本地分析服务已连接", message: "健康检查及版本一致。重载插件只更新窗口，不会升级正在运行的服务。" };
}
