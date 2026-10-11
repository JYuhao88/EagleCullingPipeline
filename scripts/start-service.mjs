import { spawn } from "node:child_process";
import process from "node:process";
const port = Number(process.env.CULLING_PORT || 43125);
const url = `http://127.0.0.1:${port}/health`;
try {
  const r = await fetch(url);
  if (r.ok) {
    console.log(`Eagle Culling service already running on ${url}`);
    process.exit(0);
  }
} catch {}
const child = spawn(
  process.execPath,
  ["src/cli.js", "serve", "--port", String(port)],
  { stdio: "inherit", detached: true },
);
child.unref();
for (let i = 0; i < 32; i++) {
  await new Promise((r) => setTimeout(r, 250));
  try {
    const r = await fetch(url);
    if (r.ok) {
      console.log(`Eagle Culling service started on ${url}`);
      process.exit(0);
    }
  } catch {}
}
console.error("Service did not become healthy within 8 seconds");
process.exit(1);
