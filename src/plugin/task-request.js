// These control responses are discarded or displayed as status only.
// Resume/retry still need the complete persisted item list for execution.
const SUMMARY_COMMANDS = new Set(["pause", "cancel", "configure", "complete", "fail"]);

export function taskRequestPath(pathname, options = {}) {
  if (options.method !== "POST") return pathname;
  const url = new URL(pathname, "http://127.0.0.1");
  const parts = url.pathname.split("/").filter(Boolean);
  if (parts.length !== 3 || parts[0] !== "tasks" || !SUMMARY_COMMANDS.has(parts[2]) || url.searchParams.has("includeItems")) return pathname;
  url.searchParams.set("includeItems", "false");
  return `${url.pathname}${url.search}`;
}
