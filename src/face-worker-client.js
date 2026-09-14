import { spawn } from "node:child_process";
export function runFaceWorker(items, { python = process.env.EAGLE_PYTHON || ".venv/Scripts/python.exe", script = "python_worker/face_worker.py", cwd = process.cwd() } = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(python, [script], {
      cwd,
      stdio: ["pipe", "pipe", "pipe"],
      env: { ...process.env, PYTHONUTF8: "1" },
    });
    const results = [];
    let stderr = "";
    child.stdout.setEncoding("utf8");
    child.stdout.on("data", (chunk) => {
      for (const line of chunk.split(/\r?\n/).filter(Boolean)) {
        try { results.push(JSON.parse(line)); } catch { /* diagnostics stay in stderr */ }
      }
    });
    child.stderr.setEncoding("utf8");
    child.stderr.on("data", (chunk) => { stderr += chunk; });
    child.on("error", (error) => reject(new Error(`Unable to start face worker: ${error.message}`)));
    child.on("close", (code) => {
      if (code !== 0 && results.length === 0) reject(new Error(`Face worker exited with code ${code}: ${stderr.trim()}`));
      else resolve(results);
    });
    child.stdin.end(items.map((item) => JSON.stringify(item)).join("\n") + "\n");
  });
}
