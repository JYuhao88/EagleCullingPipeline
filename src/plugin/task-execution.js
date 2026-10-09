// A missing heartbeat is evidence of uncertainty, not permission to take over.
// Ownership survives service restart; explicit recovery requires closing the old window.
export async function claimTaskExecution({ request, task, ownerId = crypto.randomUUID(), onControl = () => {}, intervalMs = 3000, staleMs = 10000, clock = Date.now }) {
  const body = action => JSON.stringify({ ownerId, libraryPath: task.libraryPath, ...(action === "claim" && task.activationPending ? {activate:true} : {}) });
  const call = (action) => request(`/tasks/${task.taskId}/${action}`, { method: "POST", headers: { "content-type": "application/json" }, body: body(action), signal: AbortSignal.timeout(5000) });
  await call("claim");
  let lastSuccess = clock();
  let error = null;
  let control = "running";
  let busy = false;
  let closed = false;
  const heartbeat = async () => {
    if (busy || closed || error) return;
    busy = true;
    try {
      const response = await call("heartbeat");
      if (closed) return;
      lastSuccess = clock();
      control = response.status;
      onControl(control);
    } catch (failure) { error = failure; }
    finally { busy = false; }
  };
  const timer = setInterval(heartbeat, intervalMs);
  return {
    ownerId,
    heartbeat,
    guard() {
      if (closed || error || clock() - lastSuccess > staleMs) throw Object.assign(new Error(`执行权校验失败，停止新写入：${error?.message || "服务失联"}`), { fatal: true });
      if (control !== "running") throw Object.assign(new Error(`任务已${control}，不再启动写入`), { interrupted: true });
    },
    async close() {
      if (closed) return;
      closed = true;
      clearInterval(timer);
      await call("release");
    },
  };
}
