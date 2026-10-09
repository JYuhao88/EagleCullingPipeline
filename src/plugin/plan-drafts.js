import { planChunks, uploadTaskPlan } from "./task-plan-upload.js";

// IndexedDB structured cloning stores the full plan without localStorage's
// small string quota. A failed commit must stop before any service request.
export class PlanDraftStore {
  constructor(databaseName = "eagle-culling-plan-drafts-v1") { this.databaseName = databaseName; }
  async operation(mode, action) {
    const db = await new Promise((resolve, reject) => {
      const request = indexedDB.open(this.databaseName, 1);
      request.onupgradeneeded = () => request.result.createObjectStore("plans", {keyPath:"taskId"});
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error);
    });
    try {
      return await new Promise((resolve, reject) => {
        const transaction = db.transaction("plans", mode);
        let result;
        const request = action(transaction.objectStore("plans"));
        request.onsuccess = () => { result = request.result; };
        transaction.oncomplete = () => resolve(result);
        transaction.onerror = transaction.onabort = () => reject(transaction.error || new Error("本地任务计划保存失败"));
      });
    } finally { db.close(); }
  }
  put(draft) { return this.operation("readwrite", store => store.put(draft)); }
  get(id) { return this.operation("readonly", store => store.get(id)); }
  list() { return this.operation("readonly", store => store.getAll()); }
  remove(id) { return this.operation("readwrite", store => store.delete(id)); }
}

export async function submitDurablePlan(request, input, { store, resumeTaskId, onProgress } = {}) {
  if (!resumeTaskId && planChunks(input.items).length <= 1) return uploadTaskPlan(request, input, {onProgress});
  let draft;
  if (resumeTaskId) {
    draft = await store.get(resumeTaskId);
    if (!draft || draft.input.libraryPath !== input.libraryPath) throw new Error("找不到当前资源库的完整续传计划");
  } else {
    const taskId = `task-upload-${crypto.randomUUID()}`;
    draft = {taskId, createdAt:new Date().toISOString(), input:{...input, taskId}};
    await store.put(draft);
  }
  const task = await uploadTaskPlan(request, draft.input, {resumeTaskId:draft.taskId, onProgress});
  await store.remove(draft.taskId);
  return task;
}
