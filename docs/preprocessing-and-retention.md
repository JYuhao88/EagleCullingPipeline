# 预处理与照片留存决策方案

## 结论

这套工作流不应直接对 410GB 原片逐张“看图后删除”，而应把每个 Eagle 项目拆成四层数据：原始文件、Eagle 缩略图、分析代理图、可审阅决策。原片和 Eagle 资源库只读，所有代理图与中间结果放在项目缓存目录；AI 只负责排序、分组和给出原因，最终留存由人工在 Eagle 中确认。

当前 `Culling.library` 有 7,386 个项目：2,655 JPG、2,180 ARW、998 3FR、998 HEIC、547 DNG，以及 4 个 MP4 和 4 个 SRT。现有分析结果的 2,655 张是 JPG 子集，不代表所有照片格式都已覆盖。因此 RAW/HEIC 代理化是进入全库分拣前的首要工作。

## 1. 预处理数据模型

每个 Eagle 项目生成一条不可变的 `asset_record`，分析过程不直接改 Eagle 的 `metadata.json`：

```text
asset_record
├─ eagle_id, name, ext, modified_at
├─ original_path, original_sha256, original_size
├─ eagle_thumbnail_path, thumbnail_sha256
├─ proxy_path, proxy_sha256, proxy_width, proxy_height
├─ raw_jpeg_pair_id, pair_confidence
├─ decode_status, decode_error
├─ metrics: exposure, sharpness, composition, subject
├─ face: face_count, eye_blink_scores, eyes_closed
├─ phash, embedding_model, embedding
└─ review: group_id, action, confidence, reasons
```

`original_sha256 + file_size + modified_at` 是增量分析键。代理图使用 `proxy_sha256` 命名，重复运行可复用缓存；模型名称、权重 SHA-256、阈值和代码版本同时写入结果，保证未来可以重算。

## 2. RAW/HEIC 的分层代理流程

### 2.1 读取优先级

1. **优先 Eagle 缩略图**：对已导入 Eagle 的项目，缩略图通常是最快且最稳定的预览来源，适合初筛。
2. **RAW 内嵌预览**：没有可用 Eagle 缩略图时，从 ARW、3FR、DNG 等文件提取相机内嵌 JPEG。`rawpy` 是 LibRaw 的 Python 封装，提供 `extract_thumb()`；LibRaw 的定位就是读取相机 RAW 并为后续转换提供数据。[rawpy API 文档](https://letmaik.github.io/rawpy/api/)、[LibRaw 文档](https://www.libraw.org/docs)
3. **受控解码**：内嵌预览缺失或损坏时，用 rawpy/LibRaw 生成 1600–2560px 长边的 sRGB JPEG。需要保留 `decoder`、相机型号和参数，避免把不同解码器的颜色差异误当作曝光问题。
4. **HEIC fallback**：先使用 Eagle 缩略图；如果不可用，再调用本机已验证的 HEIC 解码器生成代理。解码失败的项目进入 `needs-review/unsupported-format`，不能自动判为低质量。

预处理永远写到 `data/previews/<proxy_sha256>.jpg`，不覆盖、移动或替换原片。RAW 原片与同组 JPEG 不应互相判为重复：它们通常是同一次拍摄的不同载体，应先建立 `raw_jpeg_pair_id`，在组内只选择留存策略，不删除 RAW 母片。

### 2.2 代理图规范

- 统一 EXIF 方向、转 sRGB、最长边默认 1600px；人脸小或细节不足时再按需升级到 2560px。
- 质量分析使用 96px 代理，pHash 使用 32×32 灰度代理，DINO/人脸使用 224–1280px 的专用代理；不把 40–100MP 原片整体载入内存。
- 代理 JPEG 质量 85 左右，缓存可重建，不进入 Git，也不写回 Eagle。
- 预处理采用有界队列：默认 2 个解码线程、4 个 Node 分析并发、Python worker 单图顺序推理；队列长度超过 64 时暂停读取，避免 NVMe 读入速度压垮内存。

## 3. 分拣顺序：从便宜、确定到昂贵、主观

### Stage A：完整性与可读性

先检查文件存在、SHA-256、尺寸、EXIF 方向、代理可生成性和解码错误。任何失败都只产生 `needs-review/decode-error`，不进入“待删除”。

### Stage B：精确重复

对原始文件计算 SHA-256；同一 SHA 的项目标为 `exact-duplicate`。如果是 RAW+JPEG 配对，不直接合并为删除关系，而是标为 `raw-jpeg-pair`。精确重复组可以高置信度处理，但仍保留一份原始母片并在 Eagle 中人工确认。

### Stage C：连拍/近重复聚类

采用两层门槛减少误合并：

- pHash 汉明距离 ≤ 8 作为快速候选；
- 同组再用 DINOv2 余弦相似度（初始阈值 0.90）和拍摄时间/文件名相邻性复核。

只满足 pHash 的项目留在 `candidate/similar`，不能直接标为 rejected。DINOv2 官方实现强调其特征适合检索、分类等下游视觉任务；本项目使用量化的小模型只做相似性，不把它当作审美真值。[DINOv2 官方仓库](https://github.com/facebookresearch/dinov2)

### Stage D：人脸、闭眼和主体

在人像或检测到人脸的组中运行 MediaPipe Face Landmarker，记录每张脸的数量和 `eyeBlinkLeft/eyeBlinkRight` blendshape 分数。Google 文档说明该任务可输出面部关键点和 52 个表情 blendshape；闭眼只是“需要复核”的证据，不是绝对删除条件。[MediaPipe Face Landmarker](https://developers.google.com/mediapipe/solutions/vision/face_landmarker)

规则建议：

- 单人闭眼：质量分扣 25，加入 `eyes-closed`；
- 多人合影任一主要人脸闭眼：扣 15，并提升人工复核优先级；
- 人脸太小、侧脸、遮挡或检测置信度低：标记 `face-uncertain`，不扣分；
- 动物、风景和建筑不使用人脸分数，避免把“无脸”误判为低质量。

### Stage E：场景化质量评分

不要用一个全球分数决定所有照片的留存。先用轻量规则和 DINO 语义向量粗分场景，再套用不同权重：

| 场景 | 清晰度 | 曝光 | 构图 | 主体/表情 | 语义/审美 |
|---|---:|---:|---:|---:|---:|
| 人像/合影 | 25 | 15 | 15 | 35 | 10 |
| 风景/建筑 | 30 | 25 | 25 | 10 | 10 |
| 动物/运动 | 35 | 15 | 15 | 25 | 10 |
| 静物/街拍 | 30 | 20 | 20 | 15 | 15 |
| 未知 | 30 | 20 | 20 | 10 | 20 |

当前仓库的构图和主体项是可解释代理分数，不是经过标注训练的审美模型。TOPIQ、MUSIQ、LIQE、Q-Align 等无参考质量模型可作为第二阶段实验，但必须先在个人标注集上校准，否则更复杂的模型只会增加显存、依赖和不可解释性。

## 4. 留存决策与 Eagle 审阅视图

推荐把 AI 输出分为五种状态，而不是直接写“删除”：

| 状态 | 含义 | 默认动作 |
|---|---|---|
| `original` | RAW 母片或唯一可用原片 | 永不自动删除 |
| `selected` | 组内当前最高分、无硬伤 | 进入精选审阅 |
| `candidate` | 单张或相似度不足、尚无可靠比较 | 保留，等待人工 |
| `rejected` | 组内明显较差或精确重复 | 只加待审标签，不删除 |
| `needs-review` | 解码失败、闭眼不确定、模型冲突 | 优先人工检查 |

Eagle 内建议建立四个审阅文件夹：`AI / Original`、`AI / Candidates`、`AI / Selected`、`AI / Needs Review`。`rejected` 首轮只使用 `ai:rejected` 标签，不移动文件；人工确认后才进入 Eagle 回收桶。Eagle 官方明确建议通过 Item 的 `save()` 修改项目、通过 `moveToTrash()` 进入回收桶，避免直接编辑 `metadata.json`。[Eagle Plugin API Item](https://developer.eagle.cool/plugin-api/api/item)

插件审阅卡片应一次显示一个相似组：大图、缩略图条、质量分、闭眼/曝光/清晰度原因、原片格式和“保留/待定/回收桶”按钮。默认快捷键：`1` 保留、`2` 候选、`3` 待复核、`D` 标记回收桶但不立即删除、`Enter` 下一组。每次人工选择都保存为本地标注，作为后续阈值校准数据。

## 5. 人工校准与验收门槛

从现有库生成 500 张基准集，必须覆盖人像、合影、风景、夜景、动物、连拍、RAW+JPEG、过曝、欠曝、失焦和闭眼。人工标注：精确重复关系、近重复关系、组内首选、闭眼、明显失焦和是否可留存。

建议在进入批量回写前达到以下门槛（这是验收目标，不是当前已测结果）：

- 精确重复 Precision ≥ 99.5%，Recall ≥ 99%；
- 近重复组 Precision ≥ 95%；
- 组内首选命中率 ≥ 85%；
- 闭眼候选 Recall ≥ 95%，并单独记录误报率；
- `needs-review` 覆盖所有解码失败和低置信度项目；
- 人工确认前，任何自动动作都不得删除文件。

每次更换模型、阈值或 RAW 解码器都重新跑这 500 张基准集，并把结果写入 `data/benchmark.json` 的版本记录。

## 6. 当前机器的部署建议

本机为 i7-14700K、64GB RAM、RTX 4070 Ti SUPER 16GB、NVMe SSD，适合本地运行。已测到：基础 Node 分析约 27.7 张/秒；含人脸约 15.3 张/秒；DirectML DINOv2 在 1,000 张 Eagle 缩略图上 0 错误、约 89.4 张/秒、显存增量约 179MiB、峰值 54°C。DINO worker 进程树峰值工作集约 314MiB、私有提交约 1.17GiB。

运行策略：

1. 首轮先做清单和代理图，不并行运行多个大模型；
2. 先 CPU 运行完整性、SHA-256、pHash 和基础质量；
3. 只对相似组、人像组和 `needs-review` 运行人脸/DINO；
4. DirectML worker 单图顺序推理，Node 并发保持 4；Eagle 使用时降到 2；
5. 监控系统可用内存，低于 12GB 时暂停预处理；GPU 显存占用超过 12GB 时暂停 DINO 队列；
6. 首轮 RAW 哈希会受文件所在磁盘吞吐限制，预计比缩略图推理慢；后续以 `modified_at` 和 SHA 增量运行。

本机模型只占约 90MB（DINOv2 ONNX）和 3.8MB（MediaPipe task），10,000 张 384 维 float32 向量约 15MB；真正的容量压力来自 RAW 读取和代理缓存，而不是模型权重。DINOv3 或更大的审美模型应作为可插拔实验，不应阻塞基础分拣。

## 7. 分阶段实施路线

### P0：格式覆盖与安全基线

- 扩展 Eagle `.info` 发现器，允许 ARW/3FR/DNG/HEIC 记录；
- 建立 RAW+JPEG 配对和代理缓存；
- 对 20 个 ARW、10 个 3FR、10 个 DNG、10 个 HEIC 做解码验收；
- 所有错误进入 `needs-review`，不做自动回写。

### P1：全库预筛

- 跑完整性、精确重复、pHash、曝光、清晰度；
- 输出每组代表图和原因；
- 生成 500 张基准集并完成首次人工标注。

### P2：语义和人像增强

- 对候选组运行 DINOv2；
- 对含人脸代理运行 MediaPipe；
- 引入场景化权重和 `eyes-closed` 扣分；
- 比较 AI 排序与人工首选，校准阈值。

### P3：Eagle 审阅与受控回写

- 插件按相似组展示五状态；
- 首轮只写 `ai:*` 标签、星级和审阅文件夹；
- 重新读取 Eagle 当前项目后才写入，保留用户已有标签/文件夹；
- 只有用户明确确认的 `rejected` 才调用 `moveToTrash()`。

### P4：增量运行

- 以 SHA/修改时间/模型版本跳过未变化项目；
- 新导入照片只处理新增或变化组；
- 每月抽样复核模型漂移和误报。

## 8. 风险与不可自动化事项

- RAW 内嵌预览可能与最终显影结果不同，曝光和颜色指标必须标记“基于代理图”；
- pHash/DINO 相似不等于同一事件，不能跨时间、跨场景无条件合并；
- 闭眼 blendshape 会受侧脸、眼镜、遮挡和小人脸影响；
- 主体质量和构图代理分数不是摄影审美结论；
- 第三方模型的许可证、权重来源和运行时版本必须记录；
- 任何“待删除”都必须可逆、可审阅、可追溯，AI 不直接删除原片。

## Sources

1. LibRaw. [LibRaw documentation](https://www.libraw.org/docs).
2. rawpy. [API documentation](https://letmaik.github.io/rawpy/api/).
3. darktable. [darktable-cli manual](https://docs.darktable.org/usermanual/4.0/en/special-topics/program-invocation/darktable-cli/).
4. Oquab et al. [DINOv2 official repository](https://github.com/facebookresearch/dinov2).
5. Google AI Edge. [MediaPipe Face Landmarker](https://developers.google.com/mediapipe/solutions/vision/face_landmarker).
6. Eagle. [Plugin API — Item](https://developer.eagle.cool/plugin-api/api/item).
