const statusElement = document.querySelector("#status");
const resultElement = document.querySelector("#result");
const inspectButton = document.querySelector("#inspect");
const analyzeButton = document.querySelector("#analyze");

eagle.onPluginCreate(() => {
  statusElement.textContent = "插件已连接 Eagle";
});

inspectButton.addEventListener("click", async () => {
  inspectButton.disabled = true;
  statusElement.textContent = "正在读取所选项目…";
  try {
    const items = await eagle.item.getSelected();
    const snapshot = items.map((item) => ({
      id: item.id,
      name: item.name,
      ext: item.ext,
      filePath: item.filePath,
      thumbnailPath: item.thumbnailPath,
      tags: item.tags,
      folders: item.folders,
      star: item.star,
      modifiedAt: item.modifiedAt,
    }));
    resultElement.textContent = JSON.stringify(snapshot, null, 2);
    statusElement.textContent = `已读取 ${snapshot.length} 个项目；未执行任何写入。`;
  } catch (error) {
    statusElement.textContent = `读取失败：${error.message}`;
  } finally {
    inspectButton.disabled = false;
  }
});

analyzeButton.addEventListener("click", async () => {
  analyzeButton.disabled = true;
  statusElement.textContent = "正在请求本地分析服务…";
  try {
    const selected = await eagle.item.getSelected();
    const items = selected.map((item) => ({
      id: item.id, name: item.name, ext: item.ext, filePath: item.filePath, thumbnailPath: item.thumbnailPath,
      width: item.width, height: item.height, tags: item.tags, folders: item.folders, star: item.star,
    })).filter((item) => item.filePath);
    const response = await fetch("http://127.0.0.1:43125/analyze", {
      method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ items, includeFaces: true }),
    });
    const payload = await response.json();
    if (!response.ok) throw new Error(payload.error || `HTTP ${response.status}`);
    resultElement.textContent = JSON.stringify(payload, null, 2);
    statusElement.textContent = `已分析 ${payload.items.length} 个项目，生成 ${payload.groups.length} 个相似组；未执行任何写入。`;
  } catch (error) {
    statusElement.textContent = `分析失败：${error.message}。请先运行 npm run serve。`;
  } finally {
    analyzeButton.disabled = false;
  }
});
