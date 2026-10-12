import { createCacheMaintenance } from './core/cache-budget.js';
import { createCacheRouter } from './server/cache-routes.js';
import { createItemAnalysisRouter } from "./server/item-analysis.js";
import http from "node:http";
import { Updater } from "./core/updater.js";
import { createUpdateRouter } from "./server/update-routes.js";
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
  scanItems,
  // Optional test clock; production preserves the existing Decision timestamp contract.
  clock,
  updater,
  restart,
} = {}) {
  const active = { run: null };
  updater ||= new Updater({ isBusy: () => Boolean(active.run &&
    (active.run.controller || ["queued", "running"].includes(active.run.status))), restart });
  const updates = createUpdateRouter(updater);
  // Only a pipeline that owns a cache directory gets budget maintenance; stubs never touch real caches.
  const cacheRoot = typeof pipeline?.cacheRoot === 'string' ? pipeline.cacheRoot : null;
  const cacheLock = { busy: false };
  const isBusy = () => Boolean(active.run && (active.run.controller || ['running', 'queued'].includes(active.run.status)));
  const maintenance = cacheRoot ? createCacheMaintenance({ cacheRoot, isBusy: () => isBusy() || cacheLock.busy,
    getProtect: () => runStore.cacheProtection?.() || {} })
    : { trigger: async () => {}, start() {}, cancel: async () => {}, dispose: async () => {} };
  const cache = cacheRoot ? createCacheRouter({ cacheRoot, isBusy, maintenance, lock: cacheLock }) : async () => false;
  const runs = createRunsRouter({ pipeline, store: runStore, active, scanItems,
    beforeRun: () => maintenance.cancel(), onFinished: () => maintenance.trigger(),
    isUpdating: () => updater.isUpdating() || cacheLock.busy });
  const ctx = { runStore, api, json, readBody: parseBody, clock };
  const rules = createRulesRouter();
  const itemAnalysis = createItemAnalysisRouter(runStore);
  const server = http.createServer(async (req, res) => {
    try {
      const url = new URL(req.url, `http://${host}:${port}`);
      if (await updates(req, res, url)) return;
      if (req.method === "OPTIONS") return json(res, 204, {});
      if (req.method === "GET" && url.pathname === "/health") {
        return json(res, 200, {
          ok: true,
          service: "eagle-culling",
          contractVersion: 1,
          activeRunId: active.run && active.run.purpose !== 'prefetch' ? active.run.id : null,
          prefetchRunId: active.run?.purpose === 'prefetch' ? active.run.id : null,
          updateToken: process.env.EAGLE_UPDATE_CANDIDATE || null,
        });
      }
      if (await cache(req, res, url)) return;
      if (await itemAnalysis(req, res, url)) return;
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
    updater,
    listen: () => new Promise((resolve, reject) => {
      const failed = error => { server.off('listening', ready); reject(error); };
      const ready = () => { server.off('error', failed); maintenance.start(); resolve(); };
      server.once('error', failed);
      server.once('listening', ready);
      server.listen(port, host);
    }),
    close: async () => {
      await maintenance.dispose();
      return new Promise((resolve) => {
        server.close(resolve);
        server.closeAllConnections();
      });
    },
  };
}
