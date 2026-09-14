import assert from "node:assert/strict";
import test from "node:test";
import { EagleApi, EagleApiError } from "../src/eagle-api.js";

function response(payload, { ok = true, status = 200 } = {}) {
  return { ok, status, json: async () => payload };
}

test("paginates Eagle items without write requests", async () => {
  const calls = [];
  const api = new EagleApi({
    fetchImpl: async (url, options) => {
      calls.push({ url: new URL(url), options });
      const offset = Number(new URL(url).searchParams.get("offset"));
      return response({
        status: "success",
        data: offset === 0
          ? { data: [{ id: "a" }, { id: "b" }], total: 3 }
          : { data: [{ id: "c" }], total: 3 },
      });
    },
  });

  const items = [];
  for await (const item of api.items({ limit: 2 })) items.push(item.id);

  assert.deepEqual(items, ["a", "b", "c"]);
  assert.equal(calls.length, 2);
  assert.ok(calls.every(({ options }) => options.method === undefined));
});

test("surfaces Eagle application errors", async () => {
  const api = new EagleApi({
    fetchImpl: async () => response({ status: "error", message: "not ready" }),
  });
  await assert.rejects(() => api.libraryInfo(), EagleApiError);
});
