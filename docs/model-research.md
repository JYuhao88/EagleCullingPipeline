# 本地摄影筛选模型深度评估

## 结论摘要

### IQA 接入前的许可与环境检查（2026-10-09）

TOPIQ/LIQE 是候选方案，不是可以默认启用的现成功能。当前 [IQA-PyTorch 代码许可证](https://github.com/chaofengc/IQA-PyTorch/blob/main/LICENSE)为 PolyForm Noncommercial 1.0.0；个人研究、爱好等条款要求没有预期的商业应用。维护者的[权重库](https://huggingface.co/chaofengc/IQA-PyTorch-Weights)模型卡标注 `cc-by-nc-sa-4.0`；本次读取官方模型 API 的 revision 为 `0df2df423c65f6a64209309695f3845727431027`。代码、权重和训练数据的许可不能互相替代，也不能凭论文公开就推定可用于商业摄影或收费产品。

在用途和具体权重许可确认前，不安装/启用受限 IQA 模型，也不把其分数写回 Eagle。候选模型验证必须记录具体包版本、权重 URL、SHA-256、许可证、预处理、模型输入来源和标注集结果；个人用途确认也不等于通用商业授权。

已有 `.venv` 保持 MediaPipe/DirectML 环境不变。单独创建被 Git 忽略的 `.venv-iqa`，使用 `python_worker/requirements-iqa-runtime.txt` 固定 PyTorch 2.9.1 / torchvision 0.24.1 / CUDA 12.6，来源为 [PyTorch 官方 Windows 安装矩阵](https://pytorch.org/get-started/previous-versions/)。运行时安装不包含 IQA 权重；不自动改系统驱动、不替换正在运行的服务、不在启动插件时下载依赖。

验证入口：

```powershell
uv venv .venv-iqa --python .venv/Scripts/python.exe
uv pip install --python .venv-iqa/Scripts/python.exe -r python_worker/requirements-iqa-runtime.txt
.venv-iqa/Scripts/python.exe python_worker/probe_iqa_runtime.py
```

探针只执行 GPU 矩阵运算，不读取照片、不调用 Eagle、不加载 IQA 模型。CUDA 不可用时明确失败而非静默转 CPU；CPU 线程 2、interop 线程 1，PyTorch allocator 预算设为设备显存的 25%。这是 PyTorch 分配器约束，不是整个进程/驱动/其他程序的显存硬上限，也不会预先占满预算。其 JSON 的峰值不包含 CUDA context 和其他应用；通过探针不能证明模型速度、筛选准确率或插件集成已经达标。

本机实测安装与探针均退出 0：`torch=2.9.1+cu126`、`torchvision=0.24.1+cu126`、CUDA 12.6、设备 `NVIDIA GeForce RTX 4070 Ti SUPER`、16,376MiB。3 次预热后 10 次 1024×1024 float32 矩阵乘法耗时 0.95ms，结果有限且首元素为 1024；PyTorch allocator 观测 allocated/reserved 峰值 27.12/44MiB。这个小型算术样本绝不能外推为 IQA 模型显存或吞吐。下载准备约 6 分 48 秒、复制安装约 25 秒；C 盘下载缓存到 D 盘环境不能 hardlink，因此实际复制占用磁盘，不是每次分析成本。原 `.venv` 实测仍为 onnxruntime-directml 1.24.4 / mediapipe 1.0.1 / numpy 2.5.3；新环境 numpy 2.5.2，未相互覆盖。

后续顺序：确认用途和权重许可 → 单常驻模型、受控 batch 的独立推理验证 → 同场景人工首选/失焦/闭眼标注校准 → 接入版本化缓存和审阅解释 → 小批真实 Eagle 验收。IQA 仅作为技术质量参考，不代替审美、主体质量或个人留片意愿；未知指标保持“未评估”，不造出默认高分。

### 实际实现与本机验证边界（2026-10-09）

下面的分层方案是研究建议，不是全部已经接入插件。当前插件服务仍以 pHash、预览启发式质量分和 MediaPipe 为基础；TOPIQ/LIQE、DINOv3、Q-Align 尚未接入。质量分不代表经过标注集验证的审美或主体质量。

新增离线 `python_worker/embedding_worker.py`，读取已安装的 DINOv2-small ONNX，加载前验证清单 SHA-256；一个进程复用一个会话，输出 384 维归一化 CLS 向量，版本 `dinov2-small-cls-224-v1`。这个版本不能与旧 JS 通道的 mean-pooling 向量混用。新版源代码已接入 `/analyze`、插件实验性选项和 `/cluster` 语义分组，**运行中的旧服务尚未升级，真实库分组准确率仍未验收**。

预处理按[权重导出项目配置](https://huggingface.co/Xenova/dinov2-small/blob/main/preprocessor_config.json)：RGB、短边 256、bicubic、中心裁剪 224、1/255 缩放及指定 mean/std。只接受最多 1,600 万像素的预览；在缩放分配前拒绝长边会超过 4,096 的极端长条图，避免输入很小却因短边放大占用大量内存。这是单模型输入保护，不是选择照片总数限制，也不是系统 RSS 硬上限。

在本机已有 `onnxruntime-directml` 环境，对真实抽样报告中的 20 个预览分别复用 CPU/DirectML 会话；未安装新依赖、未写 Eagle 或原片。报告时间 `2026-10-08T18:35:15.110Z`（北京时间 10 月 9 日），输出 `C:/Users/Yuhao/AppData/Local/Temp/eagle-embedding-benchmark-f0haUm/benchmark.json`。

| 路径 | 20 张总耗时（含启动、profiling） | 模型加载 | 单张中位数 | 失败 |
| --- | ---: | ---: | ---: | ---: |
| CPU | 1,829ms | 140ms | 55ms | 0 |
| DirectML | 1,933ms | 1,297ms | 6ms | 0 |

ORT profile 显示 CPU 路径 7,800 个 CPU 执行事件，DirectML 路径 20 个融合图 GPU 执行事件，后者没有报告 CPU 节点事件；不是仅凭 provider 已安装就声称 GPU 工作。CPU/DirectML 同图向量最低 cosine 为 `0.9999999999860074`。冷启动 20 张整体并未因 GPU 更快；生产接入必须复用常驻会话，不能每张创建进程。[DirectML 官方约束](https://onnxruntime.ai/docs/execution-providers/DirectML-ExecutionProvider.html)要求关闭 memory pattern、顺序执行，且同一会话不能并发 `Run`，因此请求并发 128 不应变成 128 个 GPU 会话。

上述不是相似检测准确率、IQA、审美排序或全库吞吐验收。未测 Python RSS/显存峰值，未确认 DirectML 适配器身份；硬件盘点中的 RTX 4070 Ti SUPER 16GB 不能自动视为模型可独占的显存预算。正式启用还需安全升级、版本化缓存、资源峰值与标注样本检验。

### 模型服务接入验证

#### 独立高质量 JPEG 模型预览（实验性，默认关闭）

新增 `ModelPreviewCache`：为 JPEG 成片生成最长边 1,600、quality=90、不放大小图、校正方向的模型预览，放到工具 `data/cache/model-previews`；不修改原片/Eagle 缩略图/元数据。键包含生成版本、原文件绝对路径、文件大小和 mtime；并发同源复用生成 Promise，源发生变化后不提交该次缓存。单原文件最多 1GiB，解码像素最多 1.5 亿，处理进入图片资源调度。缓存键不是原片内容 SHA，不能检测保持 size/mtime 的外部篡改；无自动磁盘配额或清理器。

设置的“从 JPEG 原片缓存高质量模型预览”仅新任务生效，供人脸和 DINO 使用；基础技术粗排仍用既有分析输入，不悄悄改变评分算法。RAW/3FR/HEIC 不在本阶段强制原图解码；源不可读或格式不支持时保留原有预览，中文解释输入来源/回退原因。分析结果记录 modelPreview 来源和尺寸，不把 JPEG 代理称为 RAW 解码质量。

命令 `node scripts/audit-real-analysis.mjs --semantic --adjacent --high-quality`：真实 20 文件/10 拍摄单元中 5 个 JPEG 生成 1067×1600 预览，5 个 HEIC 保留现有预览；冷/暖整轮 3,866ms/319ms，场景分组 43ms，全部 DINO 向量有效且重复一致。Node 20ms RSS 采样峰值 277MiB、CPU 4,047ms（两轮和分组，不含 Python CPU/RSS），高于旧小预览样本的 Node RSS 184MiB；不是全库资源峰值验证。20 个原片 SHA 和 metadata 字节全部未变，报告 `C:/Users/Yuhao/AppData/Local/Temp/eagle-real-analysis-cVGjpq/report.json`，时间 `2026-10-08T19:10:25.689Z`。

**该人像样本仍未检出人脸。提高 JPEG 分析预览尺寸未证明闭眼/人脸准确率改善。** 后续须定位整图检测尺度、姿态与模型适配等原因，不能以预处理实现代替标注验证，也不能把 faceCount=0 当成无人物。设置默认关闭，实机启用后还需评估大图首次解码成本和缓存磁盘占用。

#### 后续定位：整图尺度与局部复查

`scripts/probe-face-scale.py` 对同一 DSC05978 的独立模型预览、同一权重 SHA `64184e229b263107bc2b804c6625db1341ff2bb731874b0bcc2fe6544e0bc9ff`、相同 0.5 detection/presence 阈值作只读对比：整图 0 张脸，右上重叠区域 1 张脸，eyeBlinkLeft/Right 约 0.076/0.093。这支持该实例的整图检测尺度是漏检原因之一，不排除其他姿态/模型因素。配置和 SRGB 图片调用按 [MediaPipe 官方 Python 指南](https://developers.google.com/edge/mediapipe/solutions/vision/face_landmarker/python)，局部复查是本项目实验策略，不是官方准确率承诺；blendshape 系数也不是经过本项目标注校准的闭眼概率。

当用户启用 JPEG 高质量模型预览，整图未检出且预览最长边至少 640 时，才顺序复查四个 60% 大小、相互重叠的区域。每图最多整图+4 区域，不新增模型进程；小缩略图、非 JPEG 回退预览、整图已检出时不启用。脸部 landmark 包围盒映射回整图归一化坐标，IoU>0.3 的观察启发式去重，不把多区域的同脸计为多人。记录 `detectionMethod: whole-plus-tiles-v1`、区域数、box；缺失眼部 blendshape 记 eyesAssessed=false，不能按正常眼睛处理。不同裁剪可能漏人、截断脸或误报，去重也可能误合并近邻人物；多人密集场景必须单独检验。

相同真实相邻样本运行 `--semantic --adjacent --high-quality`，现在 5 张 JPEG（DSC05974/5977/5978/5979/5980）各检出 1 张脸，其他 5 个 HEIC 未启用局部复查；其中 DSC05974 产生疑似闭眼信号，未作准确率标注，不直接认定废片。冷/暖整轮 4,923ms/381ms，场景分组 46ms，Node 采样 RSS 274MiB，20 个原片 SHA 与 metadata 全未变。报告 `C:/Users/Yuhao/AppData/Local/Temp/eagle-real-analysis-6LfrDD/report.json`，时间 `2026-10-08T19:14:10.076Z`。该 5 张的人脸可用性较此前确有改善，但不证明通用召回、闭眼精度或全库资源达标。

`src/semantic-worker-client.js` 复用一个 JSONL 进程和一个 ONNX 会话；Windows 默认请求 DirectML，其他系统 CPU，可用 `EAGLE_EMBEDDING_PROVIDER=cpu` 明确选择 CPU，不偷偷切换 provider。只接受 `analysisPath`/`thumbnailPath` 指定的预览，不把缺少预览的 RAW 作为隐式模型输入。返回向量必须是当前版本、384 维、有限且归一化，否则标为不可用。

`POST /analyze` 仅在 `includeEmbeddings: true` 时启用，结果保留 `semantic.available/error` 和成功时的向量/版本；模型失败不伪造结果，常规质量分析仍保留。取消会移除排队任务，已开始的模型调用可完成，但取消客户端不应用迟到结果；后续请求继续使用已加载模型。空闲 30 秒后释放进程。`GET /diagnostics` 新增 semantic 队列、模型进程数、启动次数与 ready 信息（provider、权重 SHA、加载时间）。

真实离线模型测试覆盖 CPU 单会话复用、128 项取消、缺少预览拒绝，隔离 HTTP 测试覆盖 DirectML 请求两次只启动一次、不请求语义时不加载、两次同图向量一致，以及语义分析不改变质量评分。所有输入为临时小预览，测试不连接 Eagle 写回。API 默认仍用 pHash 分组；不是已完成全库语义分组或准确率验收。

### 插件场景分组通道与计算基准

#### 真实混合照片只读链路核验

`node scripts/audit-real-analysis.mjs --semantic` 使用临时隔离服务（随机端口），从实际库分散选 JPG/ARW/HEIC/3FR 各 5 个文件。20 个分析单元冷启动整轮 3,674ms、模型复用整轮 530ms，场景分组 48ms；20/20 有有效向量，冷/暖两轮向量逐值一致，诊断中 DINO 仅启动 1 个进程，模型为 DirectML 请求、指定 SHA/版本。Node 20ms 采样 RSS 峰值 183MiB，不含 Python 模型进程/显存，不是系统峰值。

报告 `C:/Users/Yuhao/AppData/Local/Temp/eagle-real-analysis-yEGfvL/report.json`，时间 `2026-10-08T19:00:55.369Z`。校验覆盖 20 个选中文件及 9 个额外配对分析来源，共 29 个原片 SHA-256 与完整 Eagle metadata 字节，全部未变化。分散抽样的 20 个单元都是单图组，不能以此证明相似召回准确率。

`node scripts/audit-real-analysis.mjs --semantic --adjacent` 改为每种格式取项目最多的同文件夹内按名称排序的前 5 张，不用相同名称或相同组 ID 直接判定场景。实际 20 个文件配对为 10 个分析单元，冷启动 3,805ms、暖运行 231ms、分组 41ms；全部向量有效，20 个原片 SHA 与 metadata 字节未变，Node 采样 RSS 184MiB。报告 `C:/Users/Yuhao/AppData/Local/Temp/eagle-real-analysis-vuaf53/report.json`，时间 `2026-10-08T19:03:44.239Z`。

相邻样本产生 8 个组，其中 DSC05978/DSC05979/DSC05980 为一个 3 图场景组。只读查看实际预览，三张具有相同布景和主体，但表情、动作、画面边缘内容不同；这是一个可解释的场景分组实例，不是自动删除依据，也不是已标注精度数据集。当前小预览的人脸检测在该批均未检出人脸，不能理解为“所有眼睛正常”。

脚本只读真实库，仅在新临时目录写报告；有分析错误、有效向量缺失、重复运行不一致、原片/元数据变化时返回非零退出码。测试没有调用 Eagle 写回，没有完成 20 张原生缩略图恢复验收，也没有证明推荐首选质量、全库吞吐或显存预算达标。真实常驻服务仍为旧版，未被替换。

设置新增默认关闭的“启用 DINO 场景分组（本地模型，实验性）”，保留到现有队列设置；新任务保存选项，恢复任务沿用原任务选项。分析按配对拍摄单元提取一次向量，分组只接受当前模型版本且有效的归一化向量；缺失/失败单元退回 pHash，返回有效单元数量，不把失败伪装成语义成功。中文卡片注明场景相似不等于重复，首选仍为启发式粗排，需人工确认。

`SemanticClusterQueue` 在一个独立 Worker 线程中作组内所有成员的距离检查，不通过连接链合并不相似端点；同时最多一个分组任务，支持排队取消、运行取消、60 秒超时后终止线程。仅复制 ID、分数、向量，不复制原片内容或整份元数据。单位向量的部分平方距离超过完整阈值时提前拒绝，但不近似最终 cosine 判定。

`node scripts/benchmark-semantic-cluster.mjs` 本次结果：8,000 个固定种子的合成 384 维向量，阈值 0.94，形成 8,000 组，含线程启动/复制耗时 1,571ms；主线程定时器运行 89 次，最大采样间隔 41ms。只证明这类合成负载的计算开销与主线程可调度性，不代表真实库相似分布、分组准确率或内存/显存峰值。近似/同场景密集向量仍可能需要更多全成员比较，真实全库性能待验证；默认阈值未按个人标注集校准。

针对约 1 万张、约 410GB 的 Windows Eagle 资源库，最可靠的方案不是单一“全能视觉模型”，而是分层流水线：

1. 文件哈希和感知哈希负责高精度重复检测；
2. DINOv3-small/ConvNeXt 或 DINOv2-base 负责视觉相似性向量；
3. MediaPipe Face Landmarker 负责闭眼和面部关键点；
4. OpenCV 负责清晰度、曝光和基础构图特征；
5. TOPIQ/LIQE 负责技术质量参考分；
6. Q-Align/OneAlign 只对候选组进行审美排序和解释；
7. 最终阈值由人工审阅反馈校准，而不是直接自动删除。

“SOTA”指标通常来自公开 IQA、检索或检测数据集，不等价于对个人摄影偏好的最佳排序。因此必须保留候选组内排序、证据字段和人工回退机制。

## 1. 相似性、重复检测与聚类

### 1.1 精确和近重复

建议使用三层判定：

| 层级 | 方法 | 作用 | 处理速度 | 误判风险 |
|---|---|---|---|---|
| A | SHA-256/文件大小 | 完全相同文件 | 极快 | 极低 |
| B | pHash/dHash + 尺寸/EXIF | 缩放、压缩、轻微导出差异 | 极快 | 低到中 |
| C | 局部特征匹配（ORB/SIFT 或 SuperPoint 类方法） | 裁剪、旋转、局部编辑后的近重复确认 | 中等 | 低，但实现复杂 |

嵌入向量不应单独用于“重复删除”：CLIP/DINO 会把语义相近但内容不同的照片放得很近。推荐先用哈希召回，再用局部匹配确认；视觉向量主要用于“同一场景/连拍组”聚类。

### 1.2 视觉相似性模型

**DINOv3** 是 2025 年 Meta 发布的新一代自监督视觉骨干，官方称其在多种视觉任务上达到新的 state of the art，并提供较小的 ViT 和 ConvNeXt 变体以适应资源受限部署。[Meta DINOv3 发布说明](https://ai.meta.com/blog/dinov3-self-supervised-vision-model/)  DINOv3 的优势是对图像结构、局部区域和细粒度视觉内容敏感，不依赖文字描述；缺点是权重和推理成本明显高于 DINOv2，且具体模型许可需要逐个核对。

**DINOv2** 仍是更稳妥的第一版基线。官方代码提供预训练骨干，并强调其特征可直接用于多种下游任务，无需针对每个任务重新训练。[DINOv2 官方仓库](https://github.com/facebookresearch/dinov2)

**OpenCLIP** 适合补充语义相似性，例如“同一场景但不同角度”“同一人物/动物”等。官方实现支持多种模型和本地 checkpoint，也提供批量提取特征的方式。[OpenCLIP 官方仓库](https://github.com/mlfoundations/open_clip)

建议融合：

```text
near_duplicate = pHash + local_match
scene_similarity = 0.65 * cosine(DINO) + 0.35 * cosine(OpenCLIP)
cluster = HDBSCAN/层次聚类(scene_similarity)
```

对 1 万张照片，全部向量只有约 10k × 768/1024，存储压力很小；主要成本是首次图像编码。

### 1.3 向量索引

FAISS 是成熟的稠密向量相似检索和聚类库，官方支持 CPU 和 GPU 索引；其 GPU 文档报告相对 CPU 索引通常可获得约 5–10 倍加速，具体取决于索引类型和硬件。[FAISS 官方仓库](https://github.com/facebookresearch/faiss) [FAISS GPU 文档](https://github.com/facebookresearch/faiss/wiki/Faiss-on-the-GPU)

Windows 原生环境建议先使用 `faiss-cpu`；如果需要 NVIDIA GPU 加速，可使用 WSL2/Conda 环境中的 GPU 版本。1 万张照片规模并不需要复杂的向量数据库。

## 2. 技术质量评分

### 2.1 清晰度、噪声、曝光

这类指标不应完全交给大模型：

- 清晰度：Laplacian variance + Tenengrad，按主体区域和全图分别计算；
- 运动模糊：边缘方向性、频域能量和局部梯度；
- 噪声：平坦区域残差和 ISO/EXIF 辅助；
- 曝光：高光溢出比例、阴影压黑比例、亮度分位数和 RGB 通道剪裁；
- 白平衡：灰世界偏差和肤色区域偏移，仅作为提示而非硬阈值。

这些分数可解释、速度快，并且适合针对 RAW/JPEG 分别校准。建议保留原始指标，不直接合成为一个不可解释的“质量分”。

### 2.2 无参考图像质量（NR-IQA）

**MUSIQ** 使用多尺度 Transformer 处理不同尺寸和纵横比的原图，适合整体质量估计；论文和官方实现是公开的。[MUSIQ 论文](https://arxiv.org/abs/2108.05997)

**LIQE** 将图像质量、场景和失真类型作为联合视觉-语言任务，官方仓库报告其在多个 BIQA 数据集上的强表现，并提供可直接推理的实现。[LIQE 官方仓库](https://github.com/zwx8981/LIQE)

**TOPIQ** 采用从语义到失真的 top-down 结构，官方实现放在 IQA-PyTorch 中，并提供 `topiq_nr` 等模型。[TOPIQ 论文](https://arxiv.org/abs/2308.03060) [IQA-PyTorch 模型卡](https://github.com/chaofengc/IQA-PyTorch/blob/main/docs/ModelCard.md)

建议第一版采用 `TOPIQ/LIQE 二选一 + OpenCV 技术指标`。MUSIQ 可作为离线对照实验，不在首轮全库同时跑三个 NR-IQA 模型。

## 3. 闭眼、表情和主体质量

### 3.1 人脸关键点

MediaPipe Face Landmarker 可输出面部关键点和表情 blendshape，适合判断眼睛开合、头部姿态和面部可见度。[Google MediaPipe 官方文档](https://developers.google.com/mediapipe/solutions/vision/face_landmarker)

Windows Node 的官方 `@mediapipe/tasks-vision` 包依赖浏览器 `document`/图像对象；项目已提供显式 availability 回退，并将实际批量闭眼推理放在 Python/ONNX worker 方案中，避免插件崩溃或把“未检测”误记成“睁眼”。

建议计算：

- 每张脸的左右眼开合比（EAR/关键点距离）；
- blendshape 的 eyeBlinkLeft/eyeBlinkRight；
- 人脸框面积占比；
- 俯仰、偏航、滚转；
- 脸部区域清晰度，而不是只看整张照片清晰度。

### 3.2 InsightFace 的位置和许可风险

InsightFace 的 SCRFD、对齐和识别组件很强，Python 包支持 ONNX 推理，并提供 `buffalo_l` 等模型包。[InsightFace Python 包文档](https://github.com/deepinsight/insightface/blob/master/python-package/README.md)

但官方模型包说明主要面向非商业研究用途。个人摄影库可以作为可选增强模块，项目默认不把它作为硬依赖；如果未来用于商业产品，应替换为已明确获得商业许可的模型。

### 3.3 主体检测

主体检测只用于“主体是否被裁切、主体是否太小、主体是否位于画面边缘”等辅助特征，不直接判断照片是否值得保留。建议采用轻量 YOLO/RT-DETR ONNX 模型或 DINOv3 的轻量适配器，并允许用户关闭不需要的类别。

## 4. 审美和构图评分

### 4.1 为什么不使用单一审美模型

审美标签受题材、文化、器材、后期风格和个人偏好影响。公开数据集上的高相关系数不代表模型知道“你想留下哪一张”。因此审美分只能作为排序信号，不能成为自动删除条件。

### 4.2 Q-Align / OneAlign

Q-Align（ICML 2024）将视觉评分建模为离散文本定义等级，同时支持 IQA、审美评价和视频质量评价；官方仓库提供 OneAlign 推理接口和本地模型加载方式。[Q-Align 官方仓库](https://github.com/Q-Future/Q-Align) [Q-Align 论文](https://arxiv.org/abs/2312.17090)

它更适合：

- 对每个相似组的前 3–8 张照片做相对排序；
- 输出“主体清楚但背景杂乱”等可读理由；
- 在人工审阅阶段帮助解释边界案例。

它不适合：

- 第一遍扫描全部原图；
- 直接替代清晰度、闭眼和过曝检测；
- 在没有校准的情况下自动删除。

建议使用 0.8B/轻量变体做候选组复核；4B/9B 仅在显存充足且确实需要更详细解释时启用。模型许可、权重来源和运行时依赖应在下载时锁定并记录。

## 5. 推荐模型分层

| 层 | 模型/工具 | 是否首选 | 用途 |
|---|---|---|---|
| L0 | SHA-256、pHash、OpenCV | 是 | 快速、可解释、全库扫描 |
| L1 | MediaPipe Face Landmarker | 是 | 闭眼、面部关键点、姿态 |
| L1 | DINOv2-base 或 DINOv3-small | 是 | 相似性和场景聚类 |
| L1 | FAISS CPU | 是 | 近邻检索和聚类索引 |
| L2 | OpenCLIP ViT-B/32 | 是 | 语义相似性补充 |
| L2 | TOPIQ 或 LIQE | 二选一 | NR-IQA 技术质量参考 |
| L3 | Q-Align/OneAlign | 可选 | 候选组审美排序和解释 |
| L3 | InsightFace | 可选 | 更强人脸检测/质量，但需注意模型许可 |
| L3 | DINOv3 大模型 | 实验性 | 只在小样本 benchmark 或高价值照片上验证 |

## 6. 本地 Windows 部署建议

### GPU

- NVIDIA GPU：PyTorch CUDA + ONNX Runtime GPU；批量提取 DINO/CLIP 特征；
- AMD/Intel GPU：优先 ONNX Runtime DirectML，模型兼容性逐个验证；
- 无独立 GPU：DINOv2-small/ConvNeXt-tiny + CPU，降低 batch size 并启用缓存。

需要特别注意：ONNX Runtime 官方 Node.js 预编译矩阵在 Windows x64 提供 CPU/DirectML，但不提供 CUDA；Windows 上的 NVIDIA CUDA 路径应使用 Python `onnxruntime-gpu` 或自行构建 Node binding。[ONNX Runtime Node.js 支持矩阵](https://onnxruntime.ai/docs/get-started/with-javascript/node.html) [ONNX Runtime CUDA EP](https://onnxruntime.ai/docs/execution-providers/CUDA-ExecutionProvider.html)

项目的 Python ONNX worker 已在本机用 `onnxruntime-directml` 实际加载 DINOv2，并返回 `DmlExecutionProvider`；因此 Windows 部署默认优先 DirectML，CUDA 仅作为具备完整 CUDA/cuDNN 环境时的可选路径。

### 模型与数据管理

- 模型统一放在 `models/`，记录下载 URL、版本、SHA-256、许可证；
- 原图不复制、不覆盖；只读缩略图或最长边 1600–2048 像素；
- 向量、哈希、指标和模型版本写入 SQLite/Parquet；
- 任何模型升级都保留旧版本结果，避免评分漂移；
- 第一次运行支持离线模式，禁止隐式联网下载；
- 分析服务只监听 `127.0.0.1`，Eagle 插件通过本地端口访问。

### 计算顺序

```text
文件清单
  -> SHA-256/pHash
  -> OpenCV 清晰度/曝光
  -> MediaPipe（仅检测到人脸的照片）
  -> DINO 向量 + FAISS 聚类
  -> 每组选择代表图
  -> TOPIQ/LIQE
  -> Q-Align 只复核边界候选
  -> Eagle 插件审阅和确认
```

## 7. 必须做的本地 benchmark

在全库运行前，抽取 300–500 张覆盖人像、风景、街拍、动物、夜景、连拍和 RAW/JPEG 的样本，人工标注：

- 是否重复/近重复；
- 同一场景分组；
- 是否失焦/运动模糊；
- 是否闭眼；
- 曝光问题类型；
- 组内首选照片；
- 是否愿意放入精选。

比较模型时至少记录 Recall@K、Precision、组内首选命中率、闭眼误报率和每张照片耗时。只有在这个小样本 benchmark 达标后，才允许对全库生成“待删除”建议。

## 8. 最终建议

当前项目应采用以下默认配置：

```text
重复：SHA-256 + pHash + 局部匹配确认
相似聚类：DINOv2-base（保守稳定）
前沿实验：DINOv3-small/ConvNeXt 作为可替换 encoder
人脸：MediaPipe Face Landmarker
技术质量：OpenCV + TOPIQ 或 LIQE（二选一）
审美排序：Q-Align 轻量模型，仅处理候选组
索引：FAISS CPU，后续按 GPU 情况升级
```

DINOv3、Q-Align 和更大的审美模型保留为可插拔实验模块。这样既能使用本地计算资源，也不会因为某个大模型的显存、许可或版本变化阻塞整个 Eagle 整理流程。

当前 Node 实现已经提供 `--embeddings` 实验通道，使用 Transformers.js 的 `Xenova/dinov2-small` ONNX 权重，首次运行下载到本地模型缓存，随后离线复用；输出 384 维归一化向量。它是 DINOv2 的可运行本地基线，DINOv3、TOPIQ/LIQE 和 Q-Align 仍保持为后续可插拔模型，不会影响现有流水线。

模型下载完成后可设置 `EAGLE_OFFLINE=1`，阻止 Transformers.js 访问网络；如果本地缓存缺少权重，命令会明确失败，而不会隐式联网。
