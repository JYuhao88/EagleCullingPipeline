// Bound transport bytes, not the number of photos the user may select.
export function planChunks(items, maxBytes = 512 * 1024) {
  const encoder = new TextEncoder();
  const chunks = [];
  let chunk = [], bytes = 64, offset = 0;
  for (const item of items) {
    const size = encoder.encode(JSON.stringify(item)).length + 1;
    if (size + 64 > maxBytes) throw new Error("单项任务计划过大，无法安全上传");
    if (bytes + size > maxBytes && chunk.length) {
      chunks.push({ offset, items: chunk }); offset += chunk.length; chunk = []; bytes = 64;
    }
    chunk.push(item); bytes += size;
  }
  if (chunk.length) chunks.push({ offset, items: chunk });
  return chunks;
}

export async function uploadTaskPlan(request, input, { onProgress = () => {}, resumeTaskId = null } = {}) {
  const chunks = planChunks(input.items);
  const post = (url, value) => request(url, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(value) });
  if (chunks.length <= 1 && !resumeTaskId) return post("/tasks", input);
  const { items, ...metadata } = input;
  let draft;
  if (resumeTaskId) {
    try { draft = await request(`/tasks/${resumeTaskId}`); }
    catch (error) { if (error.statusCode !== 404) throw error; }
  }
  draft ||= await post("/tasks", { ...metadata, ...(resumeTaskId ? {taskId:resumeTaskId} : {}), status: "uploading", items: [], upload: { expectedTotal: items.length } });
  if ((draft.status !== "uploading" && !draft.upload?.sealed) || draft.status === "cancelled" || draft.taskType !== input.taskType || draft.libraryPath !== input.libraryPath || draft.upload?.expectedTotal !== items.length) throw new Error("任务计划与续传记录不一致，未继续上传");
  // Retrying an acknowledged-or-lost response is safe: the service verifies the
  // persisted chunk's exact hash and offset instead of adding it twice.
  for (const chunk of chunks) {
    let error;
    for (let attempt = 0; attempt < 3; attempt++) {
      try { await post(`/tasks/${draft.taskId}/plan`, chunk); error = null; break; }
      catch (failure) { error = failure; }
    }
    if (error) throw new Error(`任务计划上传中断（${draft.taskId}，已保留断点）：${error.message}`);
    onProgress(chunk.offset + chunk.items.length, items.length);
  }
  await post(`/tasks/${draft.taskId}/seal`, {});
  return request(`/tasks/${draft.taskId}`);
}
