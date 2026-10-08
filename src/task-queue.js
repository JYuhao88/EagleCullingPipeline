export async function runBoundedQueue({
  items,
  process,
  concurrency = 2,
  delayMs = 120,
  maxAttempts = 3,
  shouldSkip = () => false,
  shouldPause = () => false,
  shouldCancel = () => false,
  onProgress = () => {},
} = {}) {
  const queue = [...items];
  const results = [];
  let cursor = 0;
  const limit = Math.max(1, Math.min(4, Number(concurrency) || 2));
  const sleep = (ms) => ms > 0 ? new Promise((resolve) => setTimeout(resolve, ms)) : Promise.resolve();
  const next = () => queue[cursor++];
  async function worker() {
    while (true) {
      if (shouldCancel()) return;
      if (shouldPause() || shouldCancel()) return;
      const item = next();
      if (!item) return;
      if (shouldSkip(item)) {
        const result = { item, status: "skipped", attempts: 0 };
        results.push(result);
        await onProgress(result);
        continue;
      }
      let lastError;
      for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
        if (shouldPause() || shouldCancel()) return;
        try {
          await process(item, attempt);
          const result = { item, status: "succeeded", attempts: attempt };
          results.push(result);
          await onProgress(result);
          lastError = null;
          break;
        } catch (error) {
          lastError = error;
          if (attempt < maxAttempts) await sleep(Math.max(delayMs, delayMs * attempt));
        }
      }
      if (lastError) {
        const result = { item, status: "failed", attempts: maxAttempts, error: lastError.message };
        results.push(result);
        await onProgress(result);
      }
      await sleep(delayMs);
    }
  }
  await Promise.all(Array.from({ length: limit }, worker));
  return { results, succeeded: results.filter((result) => result.status === "succeeded").length, skipped: results.filter((result) => result.status === "skipped").length, failed: results.filter((result) => result.status === "failed").length };
}
