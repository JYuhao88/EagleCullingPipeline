// Manual decisions preempt read-only analysis, but never overlap Eagle writes
// or steal execution ownership from another window.
export async function runPriorityReview({ background, pause, drain, getTask, runReview, resume, stillAllowed = () => true }) {
  if (background && background.taskType !== "analyze-selection") throw new Error("当前正在修改缩略图或标签，请先等待任务结束");
  if (!stillAllowed()) throw new Error("资源库或任务控制已变化，未开始审阅");
  if (background) {
    await pause(background);
    await drain();
    if (!stillAllowed()) throw new Error("资源库或任务控制已变化，分析保持暂停");
    const current = await getTask(background.taskId);
    if (current.execution) throw new Error("分析执行权尚未释放，未开始审阅");
    if (!["paused","succeeded"].includes(current.status)) throw new Error(`分析状态为 ${current.status}，未开始审阅`);
  }
  if (!stillAllowed()) throw new Error("资源库或任务控制已变化，未开始审阅");
  await runReview();
  if (!background || !stillAllowed()) return;
  const current = await getTask(background.taskId);
  if (current.status !== "paused" || current.execution || !stillAllowed()) return;
  await resume(current);
}
