# Eagle Culling Pipeline

面向 Eagle 摄影资源库的本地 AI 自动筛选工具。目标是在 Windows 上对约 1 万张、约 410GB 的照片执行：重复检测、相似聚类、清晰度/闭眼/曝光/主体质量评分，并将结果以可审阅方式回写 Eagle。

## 统一插件运行（当前实现）

只加载固定目录 `D:/Photography/PhotographyOperations/EagleCullingPipeline/src/plugin`；旧 `thumbnail-bridge` 不再作为推荐入口。运行 `npm run start-service` 后，在插件“任务”页创建分析或角标任务。

- 队列支持暂停、取消、断点续跑和失败重试。任务总张数不限，默认并发 8、间隔 0ms，可自定义 16/32 等正整数并发；每 25 项批量保存。已有任务暂停后继续会应用新设置。
- 写回前重新读取项目，`modifiedAt` 变化或切换资源库时不沿用旧快照写回。
- 日常角标仅在插件内显示；“审阅”复选框和“设置 → 显示/隐藏角标”同步、即时生效，不创建任务，不改 Eagle 缩略图。
- Eagle 网格里的历史角标需单独恢复：选中照片后使用“任务 → 移除所选旧网格角标（重建预览）”，确认后执行。兼容缩略图写入/备份恢复工具默认折叠，需明确确认，不再是日常显示模式。备份恢复仍是自定义缩略图，不等同于原生高清预览。详见 [历史角标恢复](docs/thumbnail-fast-restore.md)。
- 旧生成清单仅展示迁移提示，不证明角标已写入，不自动恢复；历史角标的归属确认迁移仍待实现。
- 自动测试不等于真实 Eagle 全库压测；20 / 500 / 全库真实验收仍需完成。不会自动删除照片。

详细流程和限制见 [统一插件使用说明](docs/plugin-review.md)。

可用性优化仍在进行，已测量的改进和未达标项见 [稳定化工作单](docs/stabilization-plan.md)。目前已加入增量断点日志、模型进程复用、8,000 项分页审阅，并关闭默认调试面板；真实 Eagle 验收尚未完成。

## 研究结论（背景）

- 推荐采用 **Eagle Plugin + 本地 Python/ONNX worker** 的混合架构。
- Eagle Plugin API 负责读取 `filePath`、展示审阅界面，并通过 `save()`、`moveToTrash()` 安全写回。
- Web API V2 适合外部元数据查询和批量更新，但公开 Item 属性未列出本地 `filePath`，不建议单独用于读取原图。
- 默认只写入 `ai/*` 标签、备注和审阅文件夹；人工确认后才修改评分或移入回收桶。

## 文档

- [研究报告](docs/research.md)
- [SOTA 模型评估与本地部署](docs/model-research.md)
- [预处理与照片留存决策方案](docs/preprocessing-and-retention.md)
- [Eagle 中文审阅插件](docs/plugin-review.md)
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
- `src/plugin` 是可直接在 Eagle 开发者模式加载的中文审阅插件：自动读取当前选择、展示中文质量与配对原因、按相似组排序，并允许逐张写入 `AI精选`、`AI候选`、`待复核`。插件仍兼容旧的 `ai:selected`、`ai:candidate`、`ai:rejected` 标签，用户下一次操作该照片时会自动转换为中文标签。每次写入前都会重新读取该项目，只替换审阅状态标签，不修改人工标签、配对标签、星级、文件夹或原片，也不提供自动删除动作。插件还可按当前选择生成可撤销的原生网格缩略图角标，或恢复 Eagle 原缩略图；角标只写入 Eagle 的 custom thumbnail，不烧录原图。详见 [Eagle 中文审阅插件](docs/plugin-review.md)。

- `npm run pairs -- --apply --confirm APPLY_PAIRS` 写入配对关系；`node src/cli.js sync-paired-tags --apply --confirm APPLY_PAIR_REVIEW` 将 JPG 的审阅与质量标签同步到同名、确定的一对一 RAW，保留 RAW 的 `AI原片` / `AI已配对` 标签以及人工标签、星级和文件夹。相同场景的近重复照片按 pHash 相似组排序，组内首选写入 `AI精选`，其余只进入 `待复核`，不会自动删除。

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

`npm run pairs` 根据当前 Eagle 清单生成 RAW/JPG/HEIC capture unit 的 dry-run；只有添加 `--apply --confirm APPLY_PAIRS` 才会写 `AI已配对`、`AI原片`、`AI配对待确认` 和 `AI未配对原片`。首次配对回写已验证 6,880 个确定配对文件、3,440 个配对 RAW 母片、464 个歧义项目和 3 个孤立 RAW。当前 Eagle API 可见的 7,354 个照片项目已全部获得至少一个 AI 标签；8 个 MP4/SRT 未标记，未修改星级、文件夹或文件。

若要同时加入审阅文件夹，可提供一个只包含 Eagle 文件夹 ID 的映射，例如 `{"selected":"FOLDER_ID"}`，再加 `--folder-map data/folder-map.json`；系统会合并既有文件夹，不替换用户已有归档。

当前已完成 JPG 子集 2,655/2,655 张分析：1,916 个 pHash 组，423 张检测到人脸，55 张出现闭眼候选，0 个 worker 错误。按项目名统计，库内有 2,036 个 `JPG+ARW`、547 个 `JPG+DNG` 和 998 个 `3FR+HEIC` 配对；Eagle 中另有 ARW、3FR、HEIC、DNG 等 4,723 个照片项目，尚需按 [预处理与照片留存决策方案](docs/preprocessing-and-retention.md) 生成代理图并建立 capture unit 后纳入全库流程。Eagle 必须正在运行，且当前打开的库应为 `D:\Photography\EagleLibraries\Culling.library` 才能执行 `doctor`、`inventory` 或实际回写；文件分析本身可离线运行。全量回写前仍应先使用资源库副本和 500–1000 张标注基准集进行人工验证。
