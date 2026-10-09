import test from "node:test";
import { execFile } from "node:child_process";
import { promisify } from "node:util";

test("face region geometry, bounded fallback and unknown eyes pass Python tests",async()=>{
  await promisify(execFile)(process.platform === "win32" ? ".venv/Scripts/python.exe" : ".venv/bin/python",["python_worker/test_face_regions.py"],{windowsHide:true,timeout:30000});
});
