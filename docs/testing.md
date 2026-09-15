# 测试集合与验收标准

## 自动化测试

运行 `npm test`，当前覆盖：

- Eagle Web API 分页与错误处理；
- Eagle `.info` 目录发现和图片元数据解析；
- SHA-256、pHash 和汉明距离；
- 清晰度、曝光指标和 0–100 质量分边界；
- 精确重复图片聚类；
- 单组代表图与 singleton 候选建议；
- dry-run 回写计划与显式写入门；
- `--tags-only` 保留人工星级并清理过期质量标签；
- JPG/ARW、JPG/DNG、3FR/HEIC 一对一配对；
- 同名多项不确定配对和孤立 RAW 保护；
- 本地分析服务 `/health` 和 `/analyze`。
- 中文审阅原因、状态筛选、相似组推荐和 AI 标签合并；
- Microsoft Edge 中的插件实际渲染、中文搜索/筛选和模拟 `Item.save()` 写入；
- RAW/3FR/HEIC 使用 Eagle 代理图分析时保留原始尺寸和路径。

测试图片在临时目录中生成，不修改 Eagle 资源库。

Windows UI smoke test 会临时启动无界面的 Microsoft Edge，加载 `src/plugin/index.html?demo=1`，验证 4 张演示照片的渲染、状态筛选和中文搜索；随后注入一个模拟 Eagle API，确认把“候选”改为“精选保留”时，人工标签、`ai:paired`、星级和文件夹保持不变。测试结束会关闭整个 Edge 进程树并清理临时 profile。

## Eagle 实际样本测试

使用当前库的真实图片运行：

```powershell
npm run analyze -- --library D:\Photography\EagleLibraries\Culling.library --limit 20 --output data\analysis-sample.json
```

验收条件：

- 20/20 图片成功分析；
- 每项包含 SHA-256、pHash、清晰度、曝光和质量分；
- 至少检查一个真实重复组；
- Eagle 中没有标签、评分、文件夹或文件删除变化。

已完成的一次 JPG 样本运行结果：20/20 成功，19 个相似组，其中 1 个组包含 2 个精确重复项目。该结果不代表 ARW/3FR/HEIC/DNG 已覆盖；这些格式需先经过代理图预处理验收。

本地 DINOv2 ONNX smoke test：

```powershell
npm run analyze -- --library D:\Photography\EagleLibraries\Culling.library --limit 5 --embeddings --output data/analysis-embedding-sample.json
```

结果为 5/5 成功，向量维度 384，L2 范数为 1.0；随后设置 `EAGLE_OFFLINE=1` 重复调用仍成功，证明模型已在本地缓存。

## 基准集

全库自动整理前，建议从 Eagle 中抽取 300–500 张，覆盖人像、风景、街拍、动物、夜景、连拍、RAW/JPEG 和不同曝光情况。人工记录重复关系、组内首选、闭眼、失焦和曝光问题，计算 Precision、Recall、组内首选命中率与每张耗时。

项目已提供可重复的基准清单生成器：

```powershell
node src/cli.js benchmark --analysis data/analysis.json --size 300 --output data/benchmark.json
```

它优先纳入多图相似组，再以固定哈希补足 singleton 样本；`labels` 字段留给人工标注，文件不会写回 Eagle。

模型权重完整性检查：

```powershell
npm run models
```

当前已验证 DINOv2 ONNX 和 MediaPipe task 文件的 SHA-256 与清单一致。

Python ONNX worker smoke test 已使用 Eagle 实际缩略图完成，返回 384 维 embedding，报告 `DmlExecutionProvider`；当 DirectML 不可用时会按顺序回退到 CUDA/CPU。

## 资源使用护栏

- Node 图像分析默认并发为 4（`--concurrency` 可设为 1–16），libvips 默认只使用 2 个线程（`EAGLE_SHARP_CONCURRENCY` 可设为 1–8）；每张图只保留 32×32 pHash 和最长边 96 的质量代理，不把原图整体读入 Node 内存。
- DINOv2 Transformers.js 使用 q8、384 维向量并逐张提取；Python ONNX worker 逐张推理，优先 DirectML，避免同时占满显存。
- MediaPipe 闭眼 worker 将输入缩放到最长边 1280 后顺序处理，避免 40–100MP 原片解码造成峰值内存；Python 管道强制 UTF‑8，支持中文文件名。
- 本地 HTTP 服务限制单批最多 500 项、请求体最多 2 MiB，绑定 `127.0.0.1`；超限请求直接拒绝。

## 回写验收

回写永远分为两步：

1. `node src/cli.js apply --review data/review.json` 只打印计划；
2. 复核计划后才允许 `--apply --confirm APPLY_REVIEW`。

首轮只允许写入 `ai:*` 标签、星级和备注，不允许自动调用删除或移入回收桶接口。

### 首次真实标签回写结果

2026-09-15 使用 `--tags-only --apply --confirm APPLY_REVIEW` 对当前仍存在的 JPG 项目执行了受控回写。写入前 Eagle API 清单包含 7,362 个项目，分析结果中有 2,643 个 ID 仍存在，12 个过期 ID 被自动跳过。

- `ai:selected`：325；
- `ai:candidate`：1,585；
- `ai:rejected`：733；
- `ai:eyes-closed`：55；
- `ai:overexposed`：436；
- `ai:underexposed`：100；
- `ai:possibly-blurry`：329；
- 非 JPG 获得 AI 标签：0；
- 回写前后已有星级项目均为 111，证明 `--tags-only` 未覆盖人工星级。

这些标签是 AI 审阅提示，不是删除指令；`ai:rejected` 项目仍留在 Eagle 中。RAW/3FR/HEIC/DNG 当前只写配对角色标签，质量与留存状态要等代理图分析完成后再标记。

### 首次配对标签回写结果

同日运行 `npm run pairs -- --apply --confirm APPLY_PAIRS`，重新读取 Eagle 后验证：

- 确定配对文件 `ai:paired`：6,880；
- RAW 母片 `ai:original`：3,440；
- 同名多份、不能安全一对一匹配的 `ai:pair-uncertain`：464；
- 没有配对对象的 `ai:unpaired-original`：3；
- JPG 的 `selected/candidate/rejected` 标签保持不变；
- 已有星级项目仍为 111；
- MP4/SRT 未写入任何 AI 标签。

最终重新导出验证：Eagle API 可见 7,362 个项目，其中 7,354 个为照片格式，7,354/7,354 均至少有一个 AI 标签；剩余 8 个 MP4/SRT 没有 AI 标签。

配对标签回写只合并标签，不修改星级、文件夹和文件。重复运行会先移除旧的配对标签再按当前清单重建，因此结果是幂等的。
