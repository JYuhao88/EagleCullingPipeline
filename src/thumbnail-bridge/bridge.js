const SERVICE_URL = "http://127.0.0.1:43125";
const eagleApi = globalThis.eagle;
const applyButton = document.querySelector("#apply");
const restoreButton = document.querySelector("#restore");
const status = document.querySelector("#status");
const concurrencySelect = document.querySelector("#concurrency");
const CHECKPOINT_KEY = "eagle-culling-badge-checkpoint-v1";
const MAX_RETRIES = 3;
const REQUEST_DELAY_MS = 120;

function setBusy(value) { applyButton.disabled = value; restoreButton.disabled = value; concurrencySelect.disabled = value; }
function say(message, error = false) { status.textContent = message; status.style.color = error ? "#f0a3a3" : "#8fd3a9"; }
function sleep(milliseconds) { return new Promise((resolve) => setTimeout(resolve, milliseconds)); }

async function retry(task) {
  let lastError;
  for (let attempt = 0; attempt < MAX_RETRIES; attempt += 1) {
    try { return await task(); }
    catch (error) { lastError = error; await sleep(500 * (2 ** attempt)); }
  }
  throw lastError;
}

function readCheckpoint(generatedAt) {
  try {
    const value = JSON.parse(localStorage.getItem(CHECKPOINT_KEY) || "null");
    return value?.generatedAt === generatedAt ? new Set(value.completedIds || []) : new Set();
  } catch { return new Set(); }
}

function saveCheckpoint(generatedAt, completedIds) {
  localStorage.setItem(CHECKPOINT_KEY, JSON.stringify({ generatedAt, completedIds: [...completedIds] }));
}

async function applyBadges() {
  if (!eagleApi) return say("未检测到 Eagle 环境。", true);
  setBusy(true);
  try {
    const response = await fetch(SERVICE_URL + "/badge-manifest");
    const manifest = await response.json();
    if (!response.ok) throw new Error(manifest.error || ("HTTP " + response.status));
    const items = await eagleApi.item.getAll();
    const byId = new Map(items.map((item) => [item.id, item]));
    const completedIds = readCheckpoint(manifest.generatedAt);
    const pending = manifest.items.filter((entry) => entry.outputPath && !entry.skipped && byId.has(entry.id) && !completedIds.has(entry.id));
    const total = manifest.items.filter((entry) => entry.outputPath && !entry.skipped && byId.has(entry.id)).length;
    let done = 0;
    let failed = 0;
    let cursor = 0;
    const concurrency = Math.max(1, Math.min(4, Number(concurrencySelect.value) || 2));
    async function worker() {
      while (true) {
        const index = cursor++;
        if (index >= pending.length) return;
        const entry = pending[index];
        try {
          await retry(() => byId.get(entry.id).setCustomThumbnail(entry.outputPath));
          completedIds.add(entry.id);
          done += 1;
        } catch (error) {
          failed += 1;
          console.warn("thumbnail write failed", entry.id, error);
        }
        if ((done + failed) % 25 === 0 || done + failed === pending.length) {
          saveCheckpoint(manifest.generatedAt, completedIds);
          say("正在写入 Eagle：" + completedIds.size + "/" + total + "，本轮失败 " + failed + "…", failed ? true : false);
        }
        await sleep(REQUEST_DELAY_MS);
      }
    }
    await Promise.all(Array.from({ length: concurrency }, worker));
    saveCheckpoint(manifest.generatedAt, completedIds);
    say("本轮完成：新增 " + done + "，失败 " + failed + "，累计完成 " + completedIds.size + "/" + total + "。" + (failed ? "可再次点击继续重试。" : ""), failed > 0);
  } catch (error) { say("写入失败：" + error.message, true); }
  finally { setBusy(false); }
}

async function restoreAll() {
  if (!eagleApi) return say("未检测到 Eagle 环境。", true);
  setBusy(true);
  try {
    const items = await eagleApi.item.getAll();
    let done = 0;
    for (const item of items) {
      await item.refreshThumbnail();
      done += 1;
      if (done % 50 === 0 || done === items.length) say("正在恢复 Eagle 原缩略图：" + done + "/" + items.length + "…");
    }
    say("已恢复 " + done + " 个 Eagle 原缩略图。");
  } catch (error) { say("恢复失败：" + error.message, true); }
  finally { setBusy(false); }
}

applyButton.addEventListener("click", applyBadges);
restoreButton.addEventListener("click", restoreAll);
