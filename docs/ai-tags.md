# 本机 AI 内容标签

AI 内容标签只用于浏览与手动写回，不参与排序、规则、分组、候选集或偏好学习。
照片、预览和嵌入均留在本机，运行时不访问外部推理服务或 Ray，不修改任何照片文件。

## 标签来源与词表

所有内容标签使用 `AI·` 前缀。结果保存为 `result.aiTags = [{ tag, source, score? }]`。

| 来源 | 标签 | 条件 |
| --- | --- | --- |
| 已有分析（derived） | 无人、单人、双人、多人 | 优先姿态 persons 数量，退回 faces 或已有 faces 指标；未知不标 |
| 已有分析（derived） | 特写、半身、全身 | 主体优先，否则选最大人体框；依据已有 framingTier 与可见关键点，无法判断不标 |
| 已有尺寸（derived） | 竖构图、横构图、方构图 | 比较原图宽高，宽高相等才标方构图 |
| 已有 flags（derived） | 模糊、过曝、欠曝、闭眼 | 仅采用现有明确 flags，不把 possibly-blurry 升格，不新增技术阈值 |
| EXIF（derived） | 广角、标准、长焦 | 优先 35mm 等效焦距，退回实际焦距；小于 35mm、35–70mm、大于 70mm；缺失不标 |
| CLIP（scene） | 下列 32 项 | 本机视觉编码器与离线文本向量的余弦相似度 |

场景与主体词表：海边、沙滩、街道、老街、市集、建筑、寺庙、室内、餐厅、美食、夜景、灯光、
天空、日落、雨天、自然风光、山、树木花草、动物、猫、狗、车辆、自行车、儿童、老人、人群、
骑楼、招牌文字、水面、桥梁、人像、花。

关键点置信度与测量有效性复用 `signals.js`，避免把边缘压缩的腿脚误判为全身。
脚踝均可见可标全身；髋部可见或已有腰/大腿/膝部裁切景别可标半身；仅头肩可见可标特写。
人数是检测结果，不能保证所有人物均被检测到。焦段退回实际焦距时不推测传感器裁切系数。
新增扫描保存数值焦距并升级 EXIF 缓存版本；旧任务没有该信息时不额外读取原片。

## 模型、下载与校验

使用 OpenAI CLIP ViT-B/32 的 Xenova ONNX 转换，MIT 许可证，视觉权重为 int8，约 89.1 MB。
固定 revision：`d15189d7028b43f1d3e65039190477f6af591c2a`。
权重保存在被 Git 忽略的 `models/clip/vision_model_quantized.onnx`。

```sh
node scripts/download-clip.mjs
```

脚本下载公共权重并校验 SHA-256：
`583fd1110a514667812fee7d684952aaf82a99b959760c8d7dca7e0ab9839299`。
再次执行会先检查现有文件。运行时不自动下载，缺失、损坏或推理失败静默退回已有分析标签。
无需新增 npm 依赖。文本向量已存于 `src/core/scene-tags.json`，运行时无需 Python、文本编码器或分词器。
文本导出、固定依赖、公开样例与阈值依据见 [校准与复现](ai-tags-calibration.md)，
许可证原文见 [clip-license.txt](clip-license.txt)。用于导出的临时 Python venv 已删除。

运行时使用 sharp 自动旋转、中心裁切为 224×224 RGB，按 CLIP mean/std 归一化，
由 onnxruntime-node CPU 2 线程推理。每个标签合并两个英文 prompt 的归一化文本向量。
余弦阈值默认 0.28，猫为 0.27；按相似度选最多 3 个，允许 0 个。分数不是概率。

## 管线、旧任务与缓存

标签在排序及候选集计算结束后计算并写入分析结果，不改变已有决策。
A 类计算几乎无额外模型开销；B 类顺序运行，在既有收尾阶段执行，不新增进度权重。
旧任务的结果接口与 Inspector 缺少 aiTags 时现场补 A 类，不改写旧任务，也不自动补跑视觉模型。

场景标签缓存位于 `data/cache/ai-tags/`，纳入统一缓存预算与 LRU。
键包含模型版本、模型文件路径/大小/修改时间、图片指纹及文件身份、完整词表/阈值摘要。
模型或词表变化会失效；缓存失败不影响分析。取消信号保留正常中断语义。
模型缓存只含标签和分数，不包含图像或文本之外的个人信息。

## 写入和清除

在 Inspector 当前照片区显示内容标签。切图只局部更新标签节点，并纳入现有页面快照机制。
在“整个任务”中点击“写入 AI 标签到 Eagle”，确认文案显示去重后的 Eagle 照片数，
4 秒内再点一次才执行。RAW/JPEG 配对文件均包括在内。清除操作同样需要两次点击。
结果以内联中文状态显示，不弹窗，不在分析或浏览时自动写回。

- `POST /runs/:id/ai-tags/apply`：读取每张当前 tags，去掉所有旧 `AI·` 标签，再添加任务标签。
- `POST /runs/:id/ai-tags/clear`：只去掉 `AI·` 前缀标签，不依赖是否仍有模型。

两者共享既有 `serializeWriteback` 队列，写前校验任务资源库，仅读写 Eagle 的标签元数据。
发送字段只有 `id` 和 `tags`，不发送 star，保留用户其他标签与星级。
无法验证资源库或读取当前标签时停止写入；单张更新失败会统计失败数，已完成部分不会回滚。
重试会再次读取当前标签。清除会删除用户手工创建的同前缀标签，因此请将 `AI·` 保留给此功能。
其他旧版筛选标签没有该前缀，不在此清除范围内。

Eagle 混合版本兼容：`item/info`、`item/update` 仅在 v2 明确返回 HTTP 404 或 JSON code 404 时
逐端点回退并记住 v1；超时、500 和一般业务错误不重试写操作。library/info 可继续使用 v2。
v1 清星级统一发送字符串 `"0"`，避免数值 0 被忽略；内容标签写回不触碰星级。

## 真实任务只读验证

指定任务共 291 个单元，使用全部预览完成 A+B 标签验证；未调用真实 Eagle，未修改任务或照片。
Apple M3 Pro / arm64，CPU 2 线程、冷标签缓存，包含初始化：总耗时 6.73 秒，平均 23.12 ms/张，
去首张平均 22.62 ms，P95 25.74 ms；首张 164.76 ms。平均达到 150 ms/张目标，初始化单张超过目标。
这是一台机器、一个任务的测量，不代表其他 CPU 或大型预览的性能保证。

场景标签覆盖 58/291 张；夜景 24、水面 11、寺庙 7、骑楼 5、招牌文字 4、
老街/人像/餐厅各 3、日落/儿童各 2、动物/桥梁各 1（同张可有多个标签）。
A 类中：竖构图 183、横构图 108；无人 62、单人 117、双人 51、多人 61；
半身 148、全身 75；闭眼 6、欠曝 4、过曝 2。未出现的标签计数为 0。
完整分布、10 个等距文件名抽样及逐图数据输出在运行时指定的报告目录。

可复现只读验证（只在输出目录生成报告与标签缓存）：

```sh
node scripts/report-ai-tags.mjs <任务目录> <报告目录>
```

## 局限与验证边界

8 张公开或自造样例用于保守阈值检查，未构成独立精度评估。
咖啡、宇航员等正样例可能漏标；相近场景与主体会混淆，骑楼、老人、儿童等标签只供检索参考。
中心裁切可能丢失边缘主体；纯图像模型不负责 OCR，招牌文字标签不等于识别文本内容。
闭眼、模糊等标签继承已有分析的误差。旧任务只能现场补 A 类，B 类需后续重新分析。
真实 Eagle 的写回与界面验收未执行，写回行为由假 API 和 Inspector 模拟测试覆盖。

## 验证与改动文件

`npm test`：568 项，564 通过，0 失败，4 跳过。
跳过项为真实人脸测试素材/模型、真实分组素材/DINOv2、loopback 监听不可用，以及本地 pose Python/模型缺失。
专项测试覆盖派生标签、相似度阈值/top K、缓存失效、模型缺失、取消、旧任务读取、串行写回、
保留非 AI 标签/星级、只清除 AI·、Inspector 局部更新/二次确认、端点回退和 v1 字符串清星级。

新增文件：

- `src/core/ai-tags.js`、`src/core/scene-tags.json`
- `scripts/download-clip.mjs`、`scripts/prepare-scene-tags.py`、`scripts/check-scene-tags.mjs`、`scripts/report-ai-tags.mjs`
- `test/ai-tags.test.js`、`test/ai-tags-routes.test.js`
- `docs/ai-tags.md`、`docs/ai-tags-calibration.md`、`docs/clip-license.txt`

修改文件：

- `src/core/pipeline.js`、`src/core/cache-budget.js`、`src/core/capture-metadata.js`、`src/core/capture-metadata-cache.js`
- `src/core/eagle-api.js`
- `src/server/item-analysis.js`、`src/server/review-routes.js`、`src/server/runs-routes.js`
- `src/plugin/inspector/index.html`、`src/plugin/inspector/inspector.js`、`src/plugin/inspector/inspector.css`
- `src/inspector/index.html`
- `test/eagle-api.test.js`、`test/capture-metadata-cache.test.js`

模型文件通过共享的 `models` 链接写入 `models/clip/`，未纳入 Git；package.json 与 lockfile 未改变。
