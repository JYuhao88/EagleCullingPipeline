import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import test from "node:test";

const EDGE_PATHS = [
  "C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe",
  "C:/Program Files/Microsoft/Edge/Application/msedge.exe",
];

function listen(server) {
  return new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
}

function close(server) {
  return new Promise((resolve) => server.close(resolve));
}

async function waitFor(predicate, timeoutMs = 8000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const result = await predicate().catch(() => null);
    if (result) return result;
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new Error("Timed out waiting for the plugin preview");
}

test("rendered plugin demo supports Chinese review filtering without browser errors", async (t) => {
  const edgePath = EDGE_PATHS.find(existsSync);
  if (process.platform !== "win32" || !edgePath || typeof WebSocket === "undefined") {
    t.skip("Microsoft Edge with WebSocket support is required for this Windows UI smoke test");
    return;
  }

  const pluginRoot = path.resolve("src/plugin");
  const staticServer = http.createServer(async (request, response) => {
    const pathname = new URL(request.url, "http://localhost").pathname;
    const fileName = pathname === "/" ? "index.html" : pathname.slice(1);
    const filePath = path.join(pluginRoot, fileName);
    if (!filePath.startsWith(pluginRoot)) {
      response.writeHead(403).end();
      return;
    }
    try {
      const content = await readFile(filePath);
      const type = { ".html": "text/html", ".js": "text/javascript", ".css": "text/css" }[path.extname(filePath)] || "application/octet-stream";
      response.writeHead(200, { "content-type": `${type}; charset=utf-8` }).end(content);
    } catch {
      response.writeHead(404).end();
    }
  });
  await listen(staticServer);
  const webPort = staticServer.address().port;

  const debugServer = http.createServer();
  await listen(debugServer);
  const debugPort = debugServer.address().port;
  await close(debugServer);
  const userDataDir = await mkdtemp(path.join(os.tmpdir(), "eagle-plugin-edge-"));
  const browser = spawn(edgePath, [
    "--headless=new",
    "--disable-gpu",
    `--remote-debugging-port=${debugPort}`,
    `--user-data-dir=${userDataDir}`,
    "about:blank",
  ], { stdio: "ignore" });

  t.after(async () => {
    await new Promise((resolve) => {
      const killer = spawn("taskkill", ["/PID", String(browser.pid), "/T", "/F"], { stdio: "ignore" });
      killer.once("exit", resolve);
      killer.once("error", resolve);
    });
    await close(staticServer);
    await rm(userDataDir, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 });
  });

  const target = await waitFor(async () => {
    const targets = await (await fetch(`http://127.0.0.1:${debugPort}/json/list`)).json();
    return targets.find((entry) => entry.type === "page");
  });

  const socket = new WebSocket(target.webSocketDebuggerUrl);
  await new Promise((resolve, reject) => {
    socket.addEventListener("open", resolve, { once: true });
    socket.addEventListener("error", reject, { once: true });
  });
  t.after(() => socket.close());

  let nextId = 1;
  const pending = new Map();
  const exceptions = [];
  socket.addEventListener("message", (event) => {
    const message = JSON.parse(event.data);
    if (message.method === "Runtime.exceptionThrown") exceptions.push(message.params.exceptionDetails.text);
    if (message.id && pending.has(message.id)) {
      pending.get(message.id)(message);
      pending.delete(message.id);
    }
  });

  const command = (method, params = {}) => new Promise((resolve) => {
    const id = nextId++;
    pending.set(id, resolve);
    socket.send(JSON.stringify({ id, method, params }));
  });
  const evaluate = async (expression) => {
    const message = await command("Runtime.evaluate", { expression, awaitPromise: true, returnByValue: true });
    if (message.result?.exceptionDetails) throw new Error(message.result.exceptionDetails.text);
    return message.result.result.value;
  };

  await command("Runtime.enable");
  await command("Page.enable");
  await command("Page.navigate", { url: `http://127.0.0.1:${webPort}/index.html?demo=1` });
  await waitFor(async () => await evaluate("document.querySelectorAll('.item-row').length") === 4);
  assert.equal(await evaluate("document.querySelector('#service-state').textContent.trim()"), "界面演示数据");
  assert.equal(await evaluate("document.querySelector('.decision-button').disabled"), true);
  assert.equal(await evaluate("document.body.innerText.includes('RAW/原始格式已作为母片保护')"), true);

  await evaluate("document.querySelector('[data-filter=selected]').click()" );
  assert.equal(await evaluate("document.querySelectorAll('.item-row').length"), 1);
  await evaluate("document.querySelector('[data-filter=all]').click(); const input=document.querySelector('#search'); input.value='B0001731'; input.dispatchEvent(new Event('input',{bubbles:true}))");
  assert.equal(await evaluate("document.querySelectorAll('.item-row').length"), 2);

  await command("Page.addScriptToEvaluateOnNewDocument", { source: `
    globalThis.__savedItem = null;
    const selected = [{
      id: "real-1", name: "中文样片", ext: "JPG", filePath: "D:/photo.jpg",
      width: 6000, height: 4000, tags: ["人工标签", "ai:candidate", "ai:paired"],
      folders: ["user-folder"], star: 4, thumbnailURL: ""
    }];
    globalThis.eagle = {
      onPluginCreate(callback) { setTimeout(callback, 0); },
      item: {
        async getSelected() { return selected.map((item) => ({ ...item })); },
        async getById(id) {
          const item = { ...selected.find((entry) => entry.id === id) };
          item.save = async function save() { globalThis.__savedItem = { ...this, save: undefined }; return true; };
          return item;
        },
        async select(ids) { globalThis.__selectedIds = ids; return true; },
        async open(id) { globalThis.__openedId = id; return true; }
      }
    };
  ` });
  await command("Page.navigate", { url: `http://127.0.0.1:${webPort}/index.html` });
  await waitFor(async () => await evaluate("document.querySelectorAll('.item-row').length") === 1);
  await evaluate("document.querySelector('.decision-button[data-action=selected]').click()");
  const saved = await waitFor(async () => await evaluate("globalThis.__savedItem"));
  assert.deepEqual(saved.tags, ["人工标签", "ai:paired", "ai:selected"]);
  assert.deepEqual(saved.folders, ["user-folder"]);
  assert.equal(saved.star, 4);
  assert.deepEqual(exceptions, []);
});
