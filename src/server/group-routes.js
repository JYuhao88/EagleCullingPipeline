export async function handleGroupRoute(req, res, ctx, data) {
  const url = new URL(req.url, "http://localhost");
  const match = url.pathname.match(/^\/runs\/([^/]+)\/groups\/(move|split|merge|undo)$/);
  if (req.method !== "POST" || !match) return false;
  const [, runId, type] = match;
  if (data.run.status !== "completed") {
    ctx.json(res, 409, { error: "分析完成后才能修正分组" });
    return true;
  }
  try {
    const body = await ctx.readBody(req);
    const result = await ctx.runStore.mutateGroups(runId, type, body);
    ctx.json(res, 200, result);
  } catch (error) {
    ctx.json(res, error.code ? 500 : 400, { error: error.message });
  }
  return true;
}
