# 技术架构与实现边界

## 数据流

```text
Eagle Window Plugin（src/plugin）
  ├─ 概览 / 审阅 / 任务 / 设置四区
  ├─ 读取 Eagle Item 元数据和预览图路径
  ├─ 创建任务、显示进度、暂停/继续/重试
  ├─ 通过官方 Item API 写回标签或登记过的自定义缩略图
  └─ 不直接写资源库内部文件、不自动删除

本地服务（127.0.0.1:43125）
  ├─ pHash / 相似聚类 / 清晰度 / 曝光 / 构图代理评分
  ├─ 本地人脸与闭眼 worker
  ├─ PNG 角标生成（左下角）
  ├─ data/tasks.json 任务队列（原子替换）
  ├─ data/thumbnail-badges.json 清单
  └─ 结果和模型缓存
```

插件只负责 Eagle API 和审阅交互；所有长任务由任务服务登记、持久化和恢复。这样 Eagle 重启、插件关闭或单项失败都不会丢失整个全库进度。

## 任务记录

```text
taskId, taskType, createdAt, updatedAt,
libraryPath, manifestVersion, status, attempts, outputPath, error,
items[]: { id, modifiedAt, status, attempts, outputPath, error }
```

结果的增量键为 `item.id + modifiedAt + manifestVersion`。写回前应重新获取当前 Item；若 `modifiedAt` 已变化，任务实现应标记为 `skipped` 并留在失败/跳过清单中供人工复核。

## 目录约定

- `src/plugin/`：唯一推荐加载的 Eagle Window Plugin，包含审阅、任务、角标和诊断。
- `src/thumbnail-bridge/`：旧版兼容目录，保留一段迁移周期，不再作为新入口。
- `src/server.js`：本地 HTTP 服务和任务 API。
- `src/task-store.js`：JSON 任务存储，临时文件 + rename 原子写入。
- `src/task-queue.js`：Node 端可测试的有界并发、限速、重试队列。
- `src/plugin/task-queue.js`：插件浏览器端同构队列。
- `src/image-analyzer.js`：Node 基线分析器和 pHash 聚类。
- `data/results.sqlite`、`data/cache/`：结果、代理图和模型缓存，不提交 Git。
- `scripts/start-service.ps1`：固定服务启动入口。

任务进度通过 `/tasks/:id/checkpoint` 每 25 项批量写入，失败项立即写入；避免 8,000 项任务产生 8,000 次磁盘重写。

## 资源策略

默认并发 2，可选 1/2/4；请求间隔 120ms；单项最多重试 3 次；每 25 项保存断点。Eagle 预览图优先于 RAW 原片，避免在 410GB、约 8,000 项资源库上同时解码多个 40–100MP 原片。GPU 模型通过独立 worker 执行，主服务不保存整库像素数据。

## 写回安全

1. 只使用 Eagle 官方 Item API，不编辑 `metadata.json`、缩略图库或其他私有文件。
2. 标签写回只替换 AI 状态标签，保留人工标签、配对标签、星级和文件夹。
3. 原生预览模式不调用 `setCustomThumbnail()`；角标模式只写任务生成且清单登记的 PNG。
4. 恢复只对本工具清单登记的项目调用 `refreshThumbnail()`，不覆盖未知人工缩略图。
5. 本版本没有自动删除能力；“待复核”必须由用户在 Eagle 中最终决定。

## 可验证目标

- 8,000 项队列：并发 1/2/4、失败重试、暂停后继续、重复执行自动跳过。
- Eagle 重启后任务不丢，失败项可以单独重试。
- JPG/RAW/HEIC/3FR 配对结果可审阅，人工元数据不变。
- 原生模式清晰度恢复，角标模式显示左下角中文角标。
- 原片 SHA-256 不变，任务清单和诊断报告可导出。
