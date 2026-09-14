# 本地摄影筛选模型深度评估

## 结论摘要

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
