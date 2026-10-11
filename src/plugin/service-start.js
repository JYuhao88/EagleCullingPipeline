export function defaultRepository(location = globalThis.location) {
  if (location?.protocol !== "file:") return "";
  const match = decodeURIComponent(location.pathname).match(/^(.*)\/src\/plugin\/[^/]*$/);
  if (!match) return "";
  const directory = match[1].replace(/^\/([a-z]:\/)/i, "$1");
  return location.hostname ? `//${location.hostname}${directory}` : directory;
}

export function runtimePlatform() {
  return globalThis.process?.platform || (/Win/i.test(globalThis.navigator?.platform || "") ? "win32" : "darwin");
}

export function serviceLaunch(repository, base, platform = windowsRepository(repository) ? "win32" : runtimePlatform()) {
  const options = serviceOptions(repository, base, platform);
  const args = ["src/cli.js", "serve", "--concurrency", "1", "--port", String(options.port)];
  return { ...options, command: platform === "win32" ? "node" : "nice",
    args: platform === "win32" ? args : ["-n", "15", "node", ...args] };
}

export function serviceCommand(repository, base = "http://127.0.0.1:43125",
  platform = windowsRepository(repository) ? "win32" : runtimePlatform()) {
  const options = serviceOptions(repository, base, platform);
  if (platform === "win32") {
    const quote = value => `'${value.replaceAll("'", "''")}'`;
    return `Set-Location -LiteralPath ${quote(options.cwd)}; (Get-Process -Id $PID).PriorityClass='BelowNormal'; ` +
      `node src/cli.js serve --concurrency 1 --port ${options.port}`;
  }
  const quote = value => `'${value.replaceAll("'", "'\\''")}'`;
  return `cd ${quote(options.cwd)} && nice -n 15 node src/cli.js serve --concurrency 1 --port ${options.port}`;
}

export function serviceOptions(repository, base, platform = windowsRepository(repository) ? "win32" : runtimePlatform()) {
  const cwd = repository.trim();
  const absolute = platform === "win32" ? windowsRepository(cwd) : cwd.startsWith("/");
  if (!absolute || /[\r\n\0]/.test(cwd)) throw new Error("请填写仓库的绝对路径");
  const url = new URL(base);
  if (url.protocol !== "http:" || !["127.0.0.1", "localhost"].includes(url.hostname)) {
    throw new Error("直接启动仅支持本机 HTTP 服务地址");
  }
  return { cwd, port: Number(url.port || 80) };
}

export function windowsRepository(value) {
  return /^[a-z]:[\\/]/i.test(value) || /^(?:\\\\|\/\/)[^\\/]+[\\/][^\\/]+/.test(value);
}

export function progressEstimate(run, now = Date.now()) {
  const progress = run.progress || {};
  const elapsed = Math.max(0, now - Date.parse(run.startedAt || ""));
  if (progress.stage !== "metrics" || !progress.completed || !Number.isFinite(elapsed)) return null;
  if (progress.completed >= progress.total) return null;
  return Math.ceil(elapsed / progress.completed * (progress.total - progress.completed) / 1000);
}
