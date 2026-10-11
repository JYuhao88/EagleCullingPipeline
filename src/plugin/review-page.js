export function startReview(runId) {
  if (typeof window.loadRun === "function") return window.loadRun(runId);
  return Promise.reject(new Error("插件尚未初始化"));
}
