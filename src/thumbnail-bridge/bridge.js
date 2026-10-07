const SERVICE_URL = "http://127.0.0.1:43125";
const eagleApi = globalThis.eagle;
const applyButton = document.querySelector("#apply");
const restoreButton = document.querySelector("#restore");
const status = document.querySelector("#status");

function setBusy(value) { applyButton.disabled = value; restoreButton.disabled = value; }
function say(message, error = false) { status.textContent = message; status.style.color = error ? "#f0a3a3" : "#8fd3a9"; }

async function applyBadges() {
  if (!eagleApi) return say("未检测到 Eagle 环境。", true);
  setBusy(true);
  try {
    const response = await fetch(SERVICE_URL + "/badge-manifest");
    const manifest = await response.json();
    if (!response.ok) throw new Error(manifest.error || ("HTTP " + response.status));
    const items = await eagleApi.item.getAll();
    const byId = new Map(items.map((item) => [item.id, item]));
    const pending = manifest.items.filter((entry) => entry.outputPath && !entry.skipped && byId.has(entry.id));
    let done = 0;
    let cursor = 0;
    async function worker() {
      while (true) {
        const index = cursor++;
        if (index >= pending.length) return;
        await byId.get(pending[index].id).setCustomThumbnail(pending[index].outputPath);
        done += 1;
        if (done % 50 === 0 || done === pending.length) say("正在写入 Eagle：" + done + "/" + pending.length + "…");
      }
    }
    await Promise.all(Array.from({ length: 4 }, worker));
    say("已写入 " + done + " 个 Eagle 缩略图角标。");
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
