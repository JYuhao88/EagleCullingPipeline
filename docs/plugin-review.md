# Eagle 摄影筛选助手（统一插件）

## 固定入口

用户只需要在 Eagle 开发者模式加载：

```text
D:/Photography/PhotographyOperations/EagleCullingPipeline/src/plugin
```

插件名称和 ID 固定为“摄影筛选助手 / EAGLECULLING001”。旧的 `src/thumbnail-bridge` 保留兼容周期，但不再需要单独加载。以后更新只替换 `src/plugin` 内容，在插件的“设置 / 诊断”点击“重载当前插件”即可，不需要重新创建窗口插件。

## 四个区域

- **概览**：当前选择、审阅统计、本地服务状态、旧角标清单迁移提示。
- **审阅**：精选、候选、待复核、问题标签、相似组、JPG/RAW/HEIC/3FR 配对和中文原因。
- **任务**：AI 分析、当前选择/全库角标、恢复登记过的原缩略图、暂停、继续、仅重试失败。
- **设置 / 诊断**：原生/角标双模式、并发 1/2/4、请求间隔、服务版本、诊断报告。

## 任务队列

插件不再由按钮直接启动不可恢复的全库循环，而是先把任务写入本地服务的 `data/tasks.json`。任务记录包含：

```text
taskId taskType createdAt updatedAt libraryPath manifestVersion
itemId modifiedAt status attempts outputPath error
```

状态为 `pending/running/succeeded/skipped/failed/paused/cancelled`。默认并发 2、请求间隔 120ms、单项最多重试 3 次，每完成 25 项持久化断点。Eagle 或插件重启后，已完成项目自动跳过，未完成项目继续；失败项可单独重试。

服务接口：

```text
GET  /health                 GET  /version
GET  /tasks                  POST /tasks
GET  /tasks/:id              POST /tasks/:id/pause|resume|cancel|retry
POST /tasks/:id/progress     POST /tasks/:id/checkpoint
POST /tasks/:id/complete|fail
POST /analyze                POST /badge-thumbnail
GET  /badge-manifest
```

固定启动入口：

```powershell
D:/Photography/PhotographyOperations/EagleCullingPipeline/scripts/start-service.ps1
```

脚本先探测 `127.0.0.1:43125`，服务已运行时不会重复启动；服务未运行时以隐藏后台进程启动 `npm run serve`。

## 两种预览模式

Eagle 官方 API 没有独立的网格角标层和原生大图预览层，因此统一插件明确提供两种模式：

1. **原生预览模式（默认）**：不写自定义缩略图，Eagle 使用原生缩略图，单张预览清晰度最高。AI 标签仍显示在插件审阅卡片和 Eagle 标签中。
2. **角标分拣模式**：任务服务生成左下角中文角标 PNG，插件通过 `Item.setCustomThumbnail()` 写回，适合网格快速分拣。完成后可恢复原生缩略图。

恢复时插件先读取本工具登记的 `data/thumbnail-badges.json`，只对登记过的 ID 调用 `Item.refreshThumbnail()`，不会清除未知的人工自定义缩略图。角标不会写入 JPG、RAW、HEIC 或 3FR 原片。

## 中文审阅与配对

审阅卡片将原因码转换为中文：清晰度偏低、闭眼、过曝、欠曝、相似组首选、RAW/原始格式母片保护、已配对、配对待确认和基于预览图。标签写回只替换 AI 审阅状态，保留人工标签、质量标签、配对标签、星级和文件夹。

JPG/HEIC 与同名 RAW/3FR 一对一匹配时，成片审阅状态可通过显式命令同步到 RAW；不确定的重复基名不会猜测配对。RAW 默认作为母片保护，不会因为 JPG 更好看而建议删除。

## 启动与使用

```powershell
cd D:/Photography/PhotographyOperations/EagleCullingPipeline
npm install
npm run start-service
```

在 Eagle 中选择照片后打开插件，先点“AI 分析所选照片”，再在“审阅”中人工确认。需要全库角标时进入“任务”创建任务，不要直接修改 Eagle 资源库内部文件。没有自动删除按钮；删除或回收由用户在 Eagle 中完成。

## 旧数据迁移

第一次连接服务时，插件检查旧版 `data/thumbnail-badges.json`：显示已有清单数量、导入登记信息并保留现状。迁移不会自动恢复、删除、覆盖人工标签或修改星级/文件夹。用户可以选择继续使用旧角标、切换新版左下角角标，或恢复已登记项目。

## 开发者模式与验收

Eagle：插件 → 开发者选项 → 创建 Window Plugin → 选择上述固定 `src/plugin` 目录。`manifest.json` 已固定 `devTools: true`，打开窗口后按 F12 查看 console、网络、内存和性能。

验收顺序：20 张混合 JPG/RAW/HEIC/3FR → 500 张混合项目 → 全库约 8,000 项。需要验证任务暂停/继续、Eagle 重启后断点、失败重试、`modifiedAt` 变化跳过、原片 SHA-256 不变、人工标签/星级/文件夹不变，以及原生模式清晰度和角标模式左下角位置。

自动测试覆盖：33 项 Node/Edge 测试，包括服务健康与版本、任务 API 生命周期、任务文件原子持久化、8,000 项队列、并发与瞬时失败重试、暂停后继续、中文审阅筛选和 Eagle `Item.save()` 非破坏性写回。

## 官方 API 依据

- [Eagle Item API](https://developer.eagle.cool/plugin-api/api/item)：`getSelected()`、`getAll()`、`getById()`、`setCustomThumbnail()`、`refreshThumbnail()`、`select()`、`open()`。
- [Eagle Modify Data](https://developer.eagle.cool/plugin-api/tutorial/modify-eagle-data)：通过 Item 实例修改并 `save()`，不编辑资源库内部 `metadata.json`。
- [Eagle Plugin Anatomy](https://developer.eagle.cool/plugin-api/get-started/anatomy-of-an-extension)：固定 manifest、logo 和 Window Plugin 结构。
