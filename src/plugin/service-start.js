export function defaultRepository(location = globalThis.location) {
  if (location?.protocol !== "file:") return "";
  const match = decodeURIComponent(location.pathname).match(/^(.*)\/src\/plugin\/[^/]*$/);
  return match ? match[1] : "";
}

export function serviceCommand(repository, base = "http://127.0.0.1:43125") {
  const options = serviceOptions(repository, base);
  const quote = value => `'${value.replaceAll("'", "'\\''")}'`;
  return `cd ${quote(options.cwd)} && nice -n 15 node src/cli.js serve --concurrency 1 --port ${options.port}`;
}

export function serviceOptions(repository, base) {
  const cwd = repository.trim();
  if (!cwd.startsWith("/") || /[\r\n\0]/.test(cwd)) throw new Error("请填写仓库的绝对路径");
  const url = new URL(base);
  if (url.protocol !== "http:" || !["127.0.0.1", "localhost"].includes(url.hostname)) {
    throw new Error("直接启动仅支持本机 HTTP 服务地址");
  }
  return { cwd, port: Number(url.port || 80) };
}

export function progressEstimate(run, now = Date.now()) {
  const progress = run.progress || {};
  const elapsed = Math.max(0, now - Date.parse(run.startedAt || ""));
  if (progress.stage !== "metrics" || !progress.completed || !Number.isFinite(elapsed)) return null;
  if (progress.completed >= progress.total) return null;
  return Math.ceil(elapsed / progress.completed * (progress.total - progress.completed) / 1000);
}
