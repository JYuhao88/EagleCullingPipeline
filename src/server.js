import http from "node:http";
import { AnalysisPipeline } from "./core/pipeline.js";
import { EagleApi } from "./core/eagle-api.js";
import { ResultsStore } from "./core/results-store.js";
import { RunStore } from "./server/run-store.js";
import { createRunsRouter } from "./server/runs-routes.js";
import { handleReviewRoute } from "./server/review-routes.js";
import { json, parseBody } from "./server/http.js";
import { createRulesRouter } from "./server/rules-routes.js";

export function createAnalysisServer({
  host = "127.0.0.1",
  port = 43125,
  pipeline = new AnalysisPipeline({ store: new ResultsStore() }),
  runStore = new RunStore(),
  api = new EagleApi(),
  // Optional test clock; production preserves the existing Decision timestamp contract.
  clock,
} = {}) {
  const active = { run: null };
  const runs = createRunsRouter({ pipeline, store: runStore, active });
  const ctx = { runStore, api, json, readBody: parseBody, clock };
  const rules = createRulesRouter();
  const server = http.createServer(async (req, res) => {
    try {
      const url = new URL(req.url, `http://${host}:${port}`);
      if (req.method === "OPTIONS") return json(res, 204, {});
      if (req.method === "GET" && url.pathname === "/health") {
        return json(res, 200, {
          ok: true,
          service: "eagle-culling",
          contractVersion: 1,
        });
      }
      if (await runs(req, res, url)) return;
      if (await rules(req, res)) return;
      if (await handleReviewRoute(req, res, ctx)) return;
      return json(res, 404, { error: "not found" });
    } catch (error) {
      return json(res, 400, { error: error.message });
    }
  });
  return {
    server,
    listen: () => new Promise((resolve) => server.listen(port, host, resolve)),
    close: () =>
      new Promise((resolve) => {
        server.close(resolve);
        server.closeAllConnections();
      }),
  };
}
