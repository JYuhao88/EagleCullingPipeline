import test from "node:test";
import assert from "node:assert/strict";
import { EagleApi } from "../src/core/eagle-api.js";
import { CLEARABLE_TAGS } from "../src/core/writeback.js";

test("item listing drops the fields filter when Eagle rejects it with HTTP 500", async () => {
  const urls = [];
  const fetchImpl = async url => {
    urls.push(String(url));
    if (url.pathname.endsWith("/library/info"))
      return Response.json({ status: "success", data: { library: { path: "L" } } });
    if (url.searchParams.has("fields")) return new Response("boom", { status: 500 });
    const offset = Number(url.searchParams.get("offset"));
    const data = offset === 0 ? [{ id: "a", tags: [] }, { id: "b", tags: [] }] : [];
    return Response.json({ status: "success", data: { data, total: 2 } });
  };
  const api = new EagleApi({ fetchImpl, expectedLibraryPath: "" });
  const items = [];
  for await (const item of api.items({ fields: ["id", "tags"], limit: 2 })) items.push(item.id);
  assert.deepEqual(items, ["a", "b"]);
  assert.equal(urls.filter(url => url.includes("fields=")).length, 1, "the filter is not retried");
});

test("library cleanup also removes tag names written by older plugin builds", () => {
  for (const tag of ["AI精选", "AI淘汰", "AI原片", "AI已配对", "AI配对待确认", "AI可能模糊", "待复核"])
    assert.ok(CLEARABLE_TAGS.has(tag), tag);
  assert.ok(!CLEARABLE_TAGS.has("AI自定义"), "unknown AI-prefixed tags belong to the user");
});

test("item endpoints fall back independently on JSON 404 and remember their capability", async () => {
  const calls = [];
  const api = new EagleApi({ expectedLibraryPath: "L", fetchImpl: async (url, options) => {
    const body = options.body ? JSON.parse(options.body) : undefined;
    calls.push({ path: url.pathname, body });
    if (url.pathname.endsWith("/library/info"))
      return Response.json({ status: "success", data: { library: { path: "L" } } });
    if (url.pathname.startsWith("/api/v2/"))
      return Response.json({ status: "error", code: 404, message: "method not allowed" });
    return Response.json({ status: "success", data: { id: "a", tags: ["旅行"], star: 3 } });
  } });
  await api.itemInfo("a");
  await api.itemInfo("a");
  const update = { id: "a", tags: ["旅行"], star: 0 };
  await api.updateItem(update);
  await api.updateItem({ id: "b", tags: [] });
  assert.equal(api.apiVersion, 2);
  for (const endpoint of ["item/info", "item/update"]) {
    assert.equal(calls.filter(call => call.path === `/api/v2/${endpoint}`).length, 1);
    assert.equal(calls.filter(call => call.path === `/api/${endpoint}`).length, 2);
  }
  assert.equal(calls.find(call => call.path === "/api/item/update").body.star, "0");
  assert.equal(update.star, 0, "caller data stays numeric");
  assert.ok(calls.filter(call => call.path.endsWith("/library/info")).every(call => call.path.startsWith("/api/v2/")));
});

test("HTTP 404 permits one update fallback, while other failures never retry writes", async () => {
  for (const failure of [404, 500, "application", "network", "json"]) {
    const paths = [];
    const api = new EagleApi({ apiVersion: 2, expectedLibraryPath: "", fetchImpl: async url => {
      paths.push(url.pathname);
      if (url.pathname === "/api/item/update") return Response.json({ status: "success", data: true });
      if (failure === "network") throw new Error("timeout");
      if (failure === "json") return new Response("invalid json");
      if (failure === "application") return Response.json({ status: "error", message: "rejected" });
      return new Response("failure", { status: failure });
    } });
    if (failure === 404) {
      assert.equal(await api.updateItem({ id: "a" }), true);
      assert.deepEqual(paths, ["/api/v2/item/update", "/api/item/update"]);
    } else {
      await assert.rejects(api.updateItem({ id: "a" }));
      assert.deepEqual(paths, ["/api/v2/item/update"]);
    }
  }
});

test("v1 converts only explicit zero ratings and preserves tag-only writes", async () => {
  const bodies = [];
  const api = new EagleApi({ apiVersion: 1, expectedLibraryPath: "", fetchImpl: async (url, options) => {
    bodies.push(JSON.parse(options.body));
    return Response.json({ status: "success", data: true });
  } });
  await api.updateItem({ id: "a", star: 0 });
  await api.updateItem({ id: "a", star: 4 });
  await api.updateItem({ id: "a", tags: ["旅行"] });
  assert.deepEqual(bodies, [{ id: "a", star: "0" }, { id: "a", star: 4 }, { id: "a", tags: ["旅行"] }]);
});
