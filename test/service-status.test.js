import assert from "node:assert/strict";
import test from "node:test";
import { inspectService } from "../src/plugin/service-status.js";
import { APP_VERSION, REQUIRED_CAPABILITIES } from "../src/plugin/runtime-contract.js";

const healthy = { ok: true, service: "eagle-culling" };
const current = { service: "eagle-culling", version: APP_VERSION, apiVersion: 1, capabilities: REQUIRED_CAPABILITIES };
function fetchFixture(health, version) {
  const calls = [];
  return { calls, fetchImpl: async (url, options) => {
    calls.push({ url, options });
    const fixture = url.endsWith("/health") ? health : version;
    if (fixture instanceof Error) throw fixture;
    return { status: fixture.status ?? 200, json: async () => fixture.body };
  } };
}

test("service observations distinguish offline, occupied unhealthy, old version and ready without writes", async () => {
  for (const [health, version, state, ready] of [
    [new Error("Failed to fetch"), new Error("timeout"), "offline", false],
    [{ status:503, body:{ok:false,service:"eagle-culling",error:"journal corrupt"} }, {body:current}, "unhealthy", false],
    [{body:healthy}, {body:{...current,version:"0.3.0",capabilities:[]}}, "outdated", false],
    [{body:healthy}, {body:current}, "ready", true],
    [{body:{...healthy,ok:false}}, {body:current}, "unhealthy", false],
    [{body:{...healthy,service:"foreign"}}, {body:current}, "unhealthy", false],
    [{body:healthy}, new Error("version timeout"), "unhealthy", false],
    [{body:healthy}, {body:{...current,capabilities:{includes:true}}}, "outdated", false],
  ]) {
    const fixture = fetchFixture(health, version);
    const observed = await inspectService("http://127.0.0.1:43125", fixture);
    assert.equal(observed.state,state); assert.equal(observed.ready,ready);
    assert.equal(fixture.calls.length,2);
    assert.ok(fixture.calls.every(call=>!call.options.method && call.options.signal instanceof AbortSignal));
    assert.ok(!Number.isNaN(Date.parse(observed.observedAt)));
    if (health?.body?.error) assert.ok(observed.message.includes(health.body.error));
  }
});

test("HTTP replies with invalid JSON still count as an occupied responsive port", async () => {
  const observed = await inspectService("http://127.0.0.1:43125", {
    fetchImpl: async () => ({status:503,json:async()=>{throw new Error("not JSON");}}),
  });
  assert.equal(observed.state,"unhealthy");
  assert.equal(observed.health.httpStatus,503);
  assert.equal(observed.version.httpStatus,503);
  assert.ok(observed.message.includes("not JSON"));
});
