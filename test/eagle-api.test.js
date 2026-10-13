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
