// Shared service/plugin release contract; the Eagle plugin ID stays fixed.
export const APP_VERSION = "0.4.0";
export const REQUIRED_CAPABILITIES = ["task-execution-v1", "thumbnail-backup-v1", "resource-gate-v1", "phash-pairwise-v2", "task-plan-upload-v1", "semantic-analysis-v1", "task-plan-staging-v1"];
export function serviceCompatibility(version = {}) {
  const capabilities = Array.isArray(version.capabilities) ? version.capabilities : [];
  const missing = REQUIRED_CAPABILITIES.filter(capability=>!capabilities.includes(capability));
  const compatible = version.service === "eagle-culling" && version.apiVersion === 1 && version.version === APP_VERSION && missing.length === 0;
  return {compatible,missing,message:compatible ? "服务版本与插件一致" : `插件 ${APP_VERSION} / 服务 ${version.version || "未知"} 不兼容${missing.length ? `；缺少：${missing.join("、")}` : ""}。请先安全结束旧任务，再更新服务；不会自动重启或接管。`};
}
