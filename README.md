# Eagle Culling Pipeline

面向 Eagle 摄影资源库的本地 AI 自动筛选工具。目标是在 Windows 上对约 1 万张、约 410GB 的照片执行：重复检测、相似聚类、清晰度/闭眼/曝光/主体质量评分，并将结果以可审阅方式回写 Eagle。

## 研究结论

- 推荐采用 **Eagle Plugin + 本地 Python/ONNX worker** 的混合架构。
- Eagle Plugin API 负责读取 `filePath`、展示审阅界面，并通过 `save()`、`moveToTrash()` 安全写回。
- Web API V2 适合外部元数据查询和批量更新，但公开 Item 属性未列出本地 `filePath`，不建议单独用于读取原图。
- 默认只写入 `ai/*` 标签、备注和审阅文件夹；人工确认后才修改评分或移入回收桶。

## 文档

- [研究报告](docs/research.md)
- [SOTA 模型评估与本地部署](docs/model-research.md)
- [预处理与照片留存决策方案](docs/preprocessing-and-retention.md)
- [测试集合与验收标准](docs/testing.md)
- [技术架构与数据流](docs/architecture.md)
- [可选 GPU 模型 worker](python_worker/README.md)

## 目录

```text
EagleCullingPipeline/
├─ docs/
├─ src/       # 后续插件与 worker 源码
├─ data/      # 本地结果数据库/缓存（默认不提交）
└─ README.md
```

## 当前状态

仓库已包含只读分析、可选本地模型和带显式确认的回写代码：

```powershell
npm test
npm run doctor
npm run inventory
npm run analyze -- --limit 100
npm run analyze -- --limit 100 --embeddings
npm run analyze -- --limit 100 --faces
npm run models
npm run recommend
npm run pairs
node src/cli.js apply --review data/review.json
```

- `doctor` 检查 Eagle Web API 和当前资源库。
- `inventory` 分页导出只读元数据到 `data/inventory.json`。
- `src/plugin` 是只读取当前所选项目、调用本地分析服务的 Eagle Window Plugin。

`analyze` 会读取 Eagle library 的 `.info` 目录，计算 SHA-256、pHash、清晰度/曝光/构图/主体代理指标和可解释质量分，并输出 `data/analysis.json`。它不会修改 Eagle。加入 `--faces` 时，会用本地 MediaPipe worker 检测人脸和闭眼；加入 `--embeddings` 时，会用本地量化 DINOv2 提取 384 维语义向量。

增加 `--embeddings` 会在本地加载 `Xenova/dinov2-small` 的 ONNX 权重（首次运行下载，之后使用本地缓存），生成 384 维归一化向量并以余弦相似度聚类；不加该参数不会触发模型下载。`src/face.js` 对 MediaPipe Face Landmarker 提供显式可用性检测：Eagle 插件/浏览器环境可使用它，纯 Node 环境遇到 DOM 限制时会安全回退并标记为未检测。

审阅完成后可创建如下格式的 `data/review.json`：

```json
{"decisions":[{"id":"ITEM_ID","action":"selected","star":5,"annotation":"人工确认"}]}
```

先运行 `node src/cli.js apply --review data/review.json` 查看 dry-run 计划；只有明确传入 `--apply --confirm APPLY_REVIEW` 才会通过 Eagle Web API 写入 `ai:*` 标签、星级和备注。

仅写 AI 标签、不修改人工星级时使用：

```powershell
npm run apply -- --review data/review.json --tags-only --apply --confirm APPLY_REVIEW
```

该模式会在写入前重新读取当前 Eagle 清单，只处理仍存在的项目，并合并用户标签。2026-09-15 的首次受控写入已验证：2,643 个 JPG 获得标签，非 JPG 项目 0 个，原有 111 个星级保持不变。

`npm run pairs` 根据当前 Eagle 清单生成 RAW/JPG/HEIC capture unit 的 dry-run；只有添加 `--apply --confirm APPLY_PAIRS` 才会写 `ai:paired`、`ai:original` 和 `ai:pair-uncertain`。首次配对回写已验证 6,880 个确定配对文件、3,440 个 RAW 母片和 464 个歧义项目，未修改星级、文件夹或文件。

若要同时加入审阅文件夹，可提供一个只包含 Eagle 文件夹 ID 的映射，例如 `{"selected":"FOLDER_ID"}`，再加 `--folder-map data/folder-map.json`；系统会合并既有文件夹，不替换用户已有归档。

当前已完成 JPG 子集 2,655/2,655 张分析：1,916 个 pHash 组，423 张检测到人脸，55 张出现闭眼候选，0 个 worker 错误。按项目名统计，库内有 2,036 个 `JPG+ARW`、547 个 `JPG+DNG` 和 998 个 `3FR+HEIC` 配对；Eagle 中另有 ARW、3FR、HEIC、DNG 等 4,723 个照片项目，尚需按 [预处理与照片留存决策方案](docs/preprocessing-and-retention.md) 生成代理图并建立 capture unit 后纳入全库流程。Eagle 必须正在运行，且当前打开的库应为 `D:\Photography\EagleLibraries\Culling.library` 才能执行 `doctor`、`inventory` 或实际回写；文件分析本身可离线运行。全量回写前仍应先使用资源库副本和 500–1000 张标注基准集进行人工验证。
