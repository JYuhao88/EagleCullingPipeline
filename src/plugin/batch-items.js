// Coalesce concurrent reads, without keeping stale Item objects across retries.
export function createBatchItemReader(api, batchSize = 256) {
  let waiting = [];
  let scheduled = false;
  async function flush() {
    const requests = waiting;
    waiting = [];
    scheduled = false;
    for (let offset = 0; offset < requests.length; offset += batchSize) {
      const batch = requests.slice(offset, offset + batchSize);
      try {
        const ids = [...new Set(batch.map((entry) => entry.id))];
        const items = typeof api.getByIds === "function"
          ? await api.getByIds(ids)
          : await Promise.all(ids.map((id) => api.getById(id)));
        const byId = new Map(items.filter(Boolean).map((item) => [item.id, item]));
        for (const entry of batch) entry.resolve(byId.get(entry.id));
      } catch (error) {
        for (const entry of batch) entry.reject(error);
      }
    }
  }
  return (id) => new Promise((resolve, reject) => {
    waiting.push({ id, resolve, reject });
    if (!scheduled) {
      scheduled = true;
      setTimeout(flush, 0);
    }
  });
}

export function createProgressSummary(items) {
  const summary = { total: items.length, succeeded: 0, skipped: 0, failed: 0 };
  const statuses = new Map();
  for (const item of items) {
    statuses.set(item.id, item.status);
    if (item.status in summary && item.status !== "total") summary[item.status] += 1;
  }
  return {
    summary,
    update(id, status) {
      const previous = statuses.get(id);
      if (previous in summary && previous !== "total") summary[previous] -= 1;
      if (status in summary && status !== "total") summary[status] += 1;
      statuses.set(id, status);
    },
  };
}
