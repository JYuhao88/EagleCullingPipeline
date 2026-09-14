# Eagle Photo Culling Pipeline — 研究与实施方案

## 1. 推荐结论

对于 Windows、本地约 1 万张照片、约 410GB 的 Eagle 资源库，最稳妥的路线是：Eagle 插件负责读取路径、展示审阅界面和安全写回；本地 Python/ONNX worker 负责图像分析；所有结果先以非破坏性标签和备注形式回写，删除必须人工确认。

Eagle Web API V2 要求 Eagle 4.0 Build 21+，默认地址为 `http://localhost:41595/api/v2/`。[Web API Introduction](https://developer.eagle.cool/web-api)

## 2. Eagle API 能力与安全边界

| 需求 | Plugin API | Web API V2 | 结论 |
|---|---|---|---|
| 读取元数据 | `eagle.item.get()` | `/api/v2/item/get` | 支持 |
| 读取原图路径 | `item.filePath`、`fileURL`、`thumbnailPath` | 公开 Item 属性未列出 `filePath` | 用 Plugin API |
| 添加图片 | `addFromPath()`、`addFromBase64()` | `/api/v2/item/add` 支持 `path`、`base64`、`url` | 支持 |
| 替换原图 | `item.replaceFile()` | 未列出对应 V2 接口 | 用 Plugin API |
| 设置缩略图 | `setCustomThumbnail()` | `/api/v2/item/setCustomThumbnail` | 支持 |
| 写标签/文件夹 | `item.tags`、`item.folders` + `save()` | `/api/v2/item/update` | 支持，需合并既有值 |
| 写评分 | `item.star`，0–5 | `star` 字段 | 支持，默认不覆盖人工评分 |
| 创建/移动文件夹 | `folder.create()`、`parent` + `save()` | `/api/v2/folder/create`、`update` | 支持 |
| 标签管理 | `tag.get()`、`save()`、`merge()` | `/api/v2/tag/get`、`update`、`merge` | 支持 |
| 删除候选 | `moveToTrash()` | `isDeleted: true` | 仅人工确认后执行 |

官方明确建议使用 API 的 `save()`，不要直接修改 Eagle 资源库中的 `metadata.json` 或其他内部文件。[Modify Data](https://developer.eagle.cool/plugin-api/tutorial/modify-eagle-data)

Plugin API 的 `Item` 提供 `filePath`、`fileURL`、`thumbnailPath`，`star` 为 0–5；还提供 `replaceFile()`、`setCustomThumbnail()` 和 `moveToTrash()`。[Plugin Item API](https://developer.eagle.cool/plugin-api/api/item)

Web API V2 的 Item 更新接口支持标签、文件夹、备注、评分和 `isDeleted`。[Web API Item](https://developer.eagle.cool/web-api/api/item)

### 安全要求

- 仅绑定 localhost，不开放 41595 到公网。
- 局域网 token 可读写整个库，必须保密。[Web API Authentication](https://developer.eagle.cool/web-api)
- Web API 没有速率限制，但大型库操作仍受设备性能影响；应用层自行限制批次和并发。[Web API Rate Limits](https://developer.eagle.cool/web-api)
- Eagle AI Search 要求插件已安装和 ready；官方 API 文档没有承诺推理一定完全离线，敏感库应通过防火墙/网络监视验证。[AI Search API](https://developer.eagle.cool/web-api/api/ai-search)

## 3. 分析管线

### 3.1 重复和相似

1. SHA-256：识别内容完全相同的文件。
2. pHash/dHash/wHash：识别缩放、压缩、轻微调色和部分裁剪后的近重复。[ImageHash](https://github.com/JohannesBuchner/imagehash)
3. CLIP/OpenCLIP 嵌入：识别同一场景、主体和视觉语义相似性。
4. FAISS Top-K 近邻 + 相似度图：对 1 万张照片足够，无需分布式向量数据库。[FAISS](https://github.com/facebookresearch/faiss)
5. 对同一拍摄序列使用连通分量或层次聚类；不建议在全库直接构造完整两两距离矩阵。

同簇保留者排序建议：用户已有评分、非回收桶、分辨率/色深、脸部清晰度、曝光和综合分数。AI 只推荐保留项，不自动删除。

### 3.2 清晰度

同时使用全图 Laplacian variance、Tenengrad/Sobel 梯度、主体 ROI 和人脸 ROI 清晰度。OpenCV 资料列出了这些常用 focus measures。[OpenCV Autofocus Study](https://opencv.org/autofocus-using-opencv-a-comparative-study-of-focus-measures-for-sharpness-assessment/)

Laplacian 不是绝对清晰度：噪声、纹理和过度锐化会抬高分数。应按相机、镜头、分辨率归一化，并将低置信度结果标为待审。

### 3.3 闭眼

MediaPipe Face Landmarker 支持静态图片，输出 3D 面部关键点和 52 个 blendshape，其中包含 `eyeBlinkLeft`/`eyeBlinkRight`。[Google MediaPipe](https://developers.google.cn/edge/mediapipe/solutions/vision/face_landmarker)

小脸、侧脸、遮挡、墨镜或低置信度人脸应返回 `unknown`，不要硬判为闭眼。

### 3.4 曝光、构图和主体质量

- 曝光：亮度直方图、高光剪裁、阴影堵塞、脸部局部曝光、RGB 饱和度。
- 构图：三分法、主体位置、边缘截断、地平线、留白；仅作为辅助分数。
- 主体：脸部面积/数量/清晰度、CLIP 零样本提示、可选对象检测、审美模型。
- pyiqa 提供多种全参考和无参考质量指标，并支持 GPU。[IQA-PyTorch](https://iqa-pytorch.readthedocs.io/en/latest/)
- LAION-Aesthetic Predictor 是基于 CLIP 嵌入的线性审美预测器，项目为 MIT 许可证。[LAION Aesthetic Predictor](https://github.com/LAION-AI/aesthetic-predictor)

初始综合分数可设为：技术质量 35%、人脸/主体 25%、曝光 15%、构图 15%、审美 10%。必须使用个人已选照片校准，而不是把它视为普适艺术标准。

## 4. 本地工具比较

| 方案 | 隐私 | 成本 | 特点 | Eagle 集成 |
|---|---|---:|---|---|
| 自建 Python/ONNX | 最好，可完全离线 | 软件通常 0；有开发成本 | 可解释、可校准、覆盖面最全 | 最佳 |
| Eagle AI Search | 需验证网络行为 | 取决于当前许可 | 语义搜索和相似图方便，质量评分有限 | 原生 |
| digiKam | 本地 | 免费 | 重复、相似、脸部、质量扫描，可作基准 | 无原生写回 |
| Excire Foto 2027 | 官方宣称本地处理 | 2026 公告：介绍价 $219，常规 $249 | 面向摄影筛选，闭源但省开发 | 需桥接 |
| Immich | 可自托管 | 软件免费，需服务维护 | CLIP、脸部识别、独立 ML 服务 | 无原生写回 |

digiKam 官方文档包含重复检测和相似度搜索。[digiKam Find Duplicates](https://docs.digikam.org/en/maintenance_tools/maintenance_duplicates.html)

Excire 官方宣称本地处理、无云依赖；2026 年公告给出 $219 限时价和 $249 常规价。[Excire Foto](https://excire.com/en/excire-foto/)、[2027 发布公告](https://excire.com/en/excire-foto-2027-is-here/)

Immich 支持独立机器学习服务、CLIP 智能搜索和脸部识别。[Immich Machine Learning Settings](https://docs.immich.app/administration/system-settings/)

### 许可证风险

- ImageHash：BSD-2-Clause。
- FAISS：MIT。
- LAION Aesthetic Predictor：MIT。
- InsightFace 代码为 MIT，但预训练模型限非商业研究。[InsightFace](https://github.com/deepinsight/insightface/blob/master/python-package/README.md)
- Ultralytics YOLO 默认 AGPL-3.0，闭源商业/内部专有使用通常需要 Enterprise License。[Ultralytics License](https://www.ultralytics.com/license)

## 5. Eagle 审阅工作流

建议创建：

```text
AI Review/
├─ 原片
├─ 候选
├─ 精选
└─ 待删除
```

保留现有原始文件夹，通过附加文件夹和 `ai/*` 标签表达状态，不直接移动原文件。

推荐标签：`ai/review`、`ai/duplicate`、`ai/duplicate-keeper`、`ai/blur`、`ai/eyes-closed`、`ai/overexposed`、`ai/underexposed`、`ai/candidate`、`ai/selected`、`ai/delete-candidate`、`ai/model-v1`。

默认写入 Eagle：标签 + 可读 annotation；完整分数、阈值、模型版本写入本地 SQLite。默认不覆盖已有人工 `star`。

删除流程：AI 标记 → 并排审阅同簇 → 用户确认 → 调用 Eagle 回收桶 API；永远不直接删除 Windows 文件。

## 6. 分阶段实施

### 阶段 0：备份与基准集

- 复制 Eagle 库并导出当前标签/评分。
- 选 500–1000 张代表性照片做人工标注。
- 目标：可重复、可回滚、无写回副作用。

### 阶段 1：只读扫描

- 计算哈希、传统质量指标、人脸/闭眼、CLIP 向量和初步聚类。
- 生成报告，不修改 Eagle。

### 阶段 2：Eagle 审阅插件

- 支持当前选择、当前文件夹和断点续跑。
- 显示同簇对比、评分、原因码和置信度。
- 一键打开原图、批量选择、批量标记。

### 阶段 3：非破坏性写回

- 写入 `ai/*` 标签、annotation 和审阅文件夹。
- 不覆盖用户标签，不覆盖人工评分。

### 阶段 4：反馈校准

- 记录接受推荐、取消删除、保留多张和误判。
- 为人像、风景、街拍、连拍、夜景建立不同配置。

### 阶段 5：增量运行

- 仅处理新导入、`modifiedAt` 变化或模型版本变化的项目。
- 在 Eagle 空闲或夜间执行，单批 100–500 张。

## 7. Windows 部署建议

ONNX Runtime 支持 Windows 10 1809+ 和 Windows 11；Windows 11 24H2+ 推荐使用 WinML 自动处理执行提供程序和硬件优化。[ONNX Runtime Windows](https://onnxruntime.ai/docs/get-started/with-windows.html)

- NVIDIA：优先测试 CUDA Execution Provider。
- Intel/AMD/NVIDIA 混合硬件：测试 WinML。
- 无 GPU：使用 CPU，先跑 500 张基准集测吞吐。
- 只读取 Eagle 缩略图或 1024–1600px 代理图，不要全量解码 410GB 原片。
- 预留约 10–30GB SSD 缓存和至少 50GB 可用空间。
- 采用 3-2-1 备份；回收桶不能替代独立备份。

## 8. 成本、验收和风险

### 成本

- 开源栈软件许可成本通常为 0。
- 只读 PoC 约 1–2 周工程时间；含审阅插件约 3–6 周，均为计划估算。
- Excire Foto 2027 为一次性商业软件，价格以当前商店为准。
- 如已有合适 GPU/SSD，可不增加硬件成本；否则按实际主机配置单独预算。

### 验收指标

- 完全重复召回率接近 100%。
- 近重复以高精度为优先，宁可漏检，不要误合并。
- 闭眼、模糊、曝光低置信度结果必须显示“未知/待审”。
- 所有删除候选都能在 Eagle 中并排审阅并恢复。
- 用户人工选择接受率作为后续权重校准指标。

### 主要风险

误把艺术性照片判低质、Laplacian 被噪声影响、闭眼误判、覆盖人工标签、API token 泄露、模型许可证不适用，以及直接改库文件导致损坏。控制方式是置信度、只读试运行、版本化结果、API 写回、localhost 限制、人工确认和独立备份。

## 参考资料

1. [Eagle Web API Introduction](https://developer.eagle.cool/web-api)
2. [Eagle Web API Item](https://developer.eagle.cool/web-api/api/item)
3. [Eagle Web API Folder](https://developer.eagle.cool/web-api/api/folder)
4. [Eagle Web API Tag](https://developer.eagle.cool/web-api/api/tag)
5. [Eagle Plugin API Item](https://developer.eagle.cool/plugin-api/api/item)
6. [Eagle Plugin API Modify Data](https://developer.eagle.cool/plugin-api/tutorial/modify-eagle-data)
7. [Eagle Plugin API Changelog](https://developer.eagle.cool/plugin-api/changelog)
8. [Eagle AI Search API](https://developer.eagle.cool/web-api/api/ai-search)
9. [MediaPipe Face Landmarker](https://developers.google.cn/edge/mediapipe/solutions/vision/face_landmarker)
10. [ImageHash](https://github.com/JohannesBuchner/imagehash)
11. [FAISS](https://github.com/facebookresearch/faiss)
12. [IQA-PyTorch](https://iqa-pytorch.readthedocs.io/en/latest/)
13. [LAION Aesthetic Predictor](https://github.com/LAION-AI/aesthetic-predictor)
14. [InsightFace License](https://github.com/deepinsight/insightface/blob/master/python-package/README.md)
15. [ONNX Runtime Windows](https://onnxruntime.ai/docs/get-started/with-windows.html)
16. [digiKam Find Duplicates](https://docs.digikam.org/en/maintenance_tools/maintenance_duplicates.html)
17. [Excire Foto](https://excire.com/en/excire-foto/)
18. [Immich Machine Learning Settings](https://docs.immich.app/administration/system-settings/)
