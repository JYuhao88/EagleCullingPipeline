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

test("native thumbnail restore uses the official V2 body without metadata writes", async () => {
  const calls=[];
  const api=new EagleApi({fetchImpl:async(url,options)=>{
    calls.push({url:String(url),options});return response({status:"success"});
  }});
  assert.equal(await api.refreshThumbnail("PHOTO_ID"),undefined,"an empty success acknowledgement is not preview verification");
  assert.equal(calls.length,1);
  assert.ok(calls[0].url.endsWith("/api/v2/item/refreshThumbnail"));
  assert.deepEqual(JSON.parse(calls[0].options.body),{itemId:"PHOTO_ID"});
  assert.equal(calls[0].options.method,"POST");
  await assert.rejects(api.refreshThumbnail(" "),/non-empty/);
  assert.equal(calls.length,1,"invalid IDs never reach Eagle");
});

test("a lost thumbnail acknowledgement is uncertain and never automatically retried", async () => {
  let calls=0;
  const api=new EagleApi({fetchImpl:async()=>{calls++;throw new Error("connection lost");}});
  await assert.rejects(api.refreshThumbnail("PHOTO_ID"),error=>error.refreshOutcome==="unknown" && error.fatal && error.message.includes("connection lost"));
  assert.equal(calls,1);
  const notAcknowledged=new EagleApi({fetchImpl:async()=>response({status:"success",data:false})});
  await assert.rejects(notAcknowledged.refreshThumbnail("PHOTO_ID"),error=>error.refreshOutcome==="unknown");
});
