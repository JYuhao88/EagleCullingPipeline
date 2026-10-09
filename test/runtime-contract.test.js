import assert from "node:assert/strict";
import test from "node:test";
import { readFile } from "node:fs/promises";
import { APP_VERSION, REQUIRED_CAPABILITIES, serviceCompatibility } from "../src/plugin/runtime-contract.js";

test("package, lockfile, manifest and runtime version use one release identity", async()=>{
  const packageJson=JSON.parse(await readFile("package.json","utf8"));
  const lock=JSON.parse(await readFile("package-lock.json","utf8"));
  const manifest=JSON.parse(await readFile("src/plugin/manifest.json","utf8"));
  for(const version of [packageJson.version,lock.version,lock.packages[""].version,manifest.version]) assert.equal(version,APP_VERSION);
  assert.equal(manifest.id,"EAGLECULLING001");
});

test("connected old or incomplete services cannot be mistaken for a usable new release", ()=>{
  const version={service:"eagle-culling",version:APP_VERSION,apiVersion:1,capabilities:REQUIRED_CAPABILITIES};
  assert.equal(serviceCompatibility(version).compatible,true);
  assert.equal(serviceCompatibility({...version,capabilities:REQUIRED_CAPABILITIES.filter(capability=>capability!=="task-plan-staging-v1")}).compatible,false,"staged plans must not be sent to an older seal-to-pending service");
  for(const mismatch of [{version:"0.3.0"},{apiVersion:2},{service:"other"},{capabilities:["task-execution-v1"]}]) {
    const result=serviceCompatibility({...version,...mismatch});
    assert.equal(result.compatible,false);assert.ok(result.message.includes("不会自动重启"));
  }
});
