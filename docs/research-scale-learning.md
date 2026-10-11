# 万张规模、偏好学习与模型演进调研（2026-10-10）

> 状态：调研与方案设计，**尚未实现**。承接 [research-genre-pareto.md](research-genre-pareto.md)。
> 依据：源码与 Mac 小样本实测（Codex，2026-10-10）、本地测试库数据、论文库多角度检索（`ml/research/search_corpus_facets.py`），以及领域常识。凡标「待验证」的数字都需实测确认。
> 任务清单见 [todo.md](todo.md)。

## 0. 目标用户与规模（修订于 2026-10-10）

工具面向**摄影爱好者和职业摄影师**，不是普通手机用户。这会改变下文的多个判断：

- **量级**：一次拍摄（婚礼、活动、旅行、商业拍摄）常有 2 千–8 千张，一年几万张；全库累计可达数十万张。连拍和相似组多，人工粗选本身就很耗时。
- **判断数据充足**：一个职业摄影师一年做出的组内选择就有数万次。数据并不稀缺，真正的难点是**标签质量**：批量一键接受建议只是弱信号，只有明确的选择和对 AI 建议的改动才是强信号。
- **对焦是硬标准**：职业用户首先看主体（尤其是眼睛）是否在 100% 像素下合焦。1024 甚至 2048 px 的缩放图根本判断不了，见 §2.5。
- **风格差异大**：同一个人在不同客户、不同题材下标准不同，需要多套偏好（§4.3）。
- **参考产品**：市面上已有面向职业用户的 AI 选片工具（如 Aftershoot、Narrative Select、FilterPixel、Excire），普遍提供对焦/闭眼检测、按用户历史训练个人模型等功能。具体能力以官方资料为准，本文未逐一核实。

## 1. 分类体系：开放、多标签、可多选

上一版只分街拍、人像、风光、其他四类，太窄。改为**多个正交维度 + 多标签概率**：默认只展示少数几类，允许用户多选，也允许自定义。

| 维度 | 默认展示 | 「更多」里的候选（可扩展） |
|---|---|---|
| 题材 | 人像、街拍/人文、风光、其他 | 合影、儿童、情侣/婚礼、建筑、城市夜景、星空/天文、野生动物/鸟类、宠物、美食、静物/产品、运动、舞台/演出、活动/聚会、旅行纪念、微距、截图/文档 |
| 风格/意图 | （不默认） | 高调、低调、黑白、慢门/运动模糊、浅景深、剪影、极简、胶片颗粒 |
| 用途 | （不默认） | 作品级、记录/纪念、素材、客户交付 |

设计要点：

- **多标签**：每张照片对每个标签输出一个概率。夜景人像同时属于「人像」和「低调」，标签之间不互斥。
- **标签决定评分方案（profile）**：每个标签绑定一组目标、门槛和「不扣分项」。多个标签同时成立时：
  - 目标取并集，按各标签概率加权；
  - 硬门槛只在对应标签高置信度时才生效；
  - 「不扣分项」取并集。例如带「慢门」标签的照片，运动模糊不扣分。
- **用户多选**：在开始分析或审阅时选择本批关心的标签，作为评分方案和筛选条件。默认按识别结果自动套用。
- **自定义标签**：用户给 10–30 张样例，用 DINOv2 嵌入做原型（DINOv2 已缓存）；或者写一句文字描述，用 CLIP/SigLIP 做文本零样本（需新增模型）。
- **截图/文档**这类非摄影图应单独识别并排除，避免污染排序。
- **用户纠正**：用户改了标签就记为一次反馈（见第 3 节），用于更新原型和分类头。

## 2. 万张规模的耗时与预处理

**结论：可以预处理，而且必须预处理。**下表按「一批 1 万个文件、RAW+JPG 配对后约 5000 个单元」估算。按 §0 的规模，一次拍摄 2 千–8 千张是常态，全年几万张，所以后台增量索引不是可选优化，而是基本形态。全库数十万张时，存储和分组索引还要按比例放大。

### 2.1 Mac 实测外推（M3 Pro，16 单元样本，并发与线程受限）

| 阶段 | 单张耗时 | 5000 单元 |
|---|---|---|
| 扫描/配对 | — | 数秒 |
| 1024 代理图 | JPG 87–120 ms、HEIC 171–215 ms、RAW 缩略图约 33 ms | 约 10 分钟 |
| 指标 + pHash | 约 8 ms | 约 40 秒 |
| DINOv2 384 维 | 稳态约 78 ms | 约 6.5 分钟 |
| TOPIQ-NR | 典型约 0.3–0.5 s，偶见 1.3–1.7 s 慢样本 | **约 26–53 分钟（瓶颈）** |
| 人脸（常驻进程） | 约 73 ms | 约 6 分钟 + 启动 |
| 分组 | O(n²d) | 随机向量外推约 7 秒；真实情况待测 |

- 首次全量预算约 **30–60 分钟**（1 万单元约 1–2 小时）。
- 瓶颈排序：TOPIQ > 代理图 > DINOv2 ≈ 人脸 > 指标。
- 当前热启动并不是零成本：缓存命中后仍会逐张做 `sharp.stats`，5000 张约 110 秒。

### 2.2 规模隐患（必须先修）

- **分组 O(n²)**：`grouping.js` 遍历所有已有组；3 秒时间窗口只加分，不做剪枝。改为按真实拍摄时间和设备会话分桶，只比较时间邻居，复杂度降到 O(n log n + nwd)；跨日重复用 pHash 或 ANN 召回。前提是先补上 EXIF 拍摄时间和文件 stat。
- **服务端写放大**：每处理一个单元就重写整库的 items/units，整体是 O(n²) 写入。
- **O(n²) 查找**：`results.find` 应改为 Map。
- **缓存不是内容寻址**：缓存键包含路径；DINOv2 和人脸没有独立版本号，模型升级时无法只重算对应阶段。
- **不可中断**：只在单元开始时检查取消；人脸和分组阶段不响应取消，也没有阶段检查点。

### 2.3 预处理与增量方案（按 5000 单元估算，待验证）

| 方案 | 效果 |
|---|---|
| **后台常驻增量索引** | 监听 Eagle 新增和变更，等文件稳定后处理，辅以周期性核对；在空闲、接电时以低优先级运行。首次仍需 30–60 分钟；之后每新增 100 单元约 1–2 分钟。 |
| **内容寻址、分阶段缓存** | 键为源文件哈希 → 代理图哈希 → 模型 SHA + 预处理/schema 版本；模型升级只重算对应阶段。有索引后打开一批的目标是 5–15 秒。 |
| **分层计算** | 代理图和便宜指标全量算；DINOv2 也全量算（分组需要）；TOPIQ 和人脸只算组内前 k 和难例。若候选占 20–30%，全量约 15–30 分钟。缺失的分数必须标为「未计算」，不能当作低分。 |
| **按需懒计算** | 先算当前 20–50 个单元，首屏约 15–45 秒；适合只看少数组的场景。 |
| **Ray/GPU 离线批处理** | 只上传 1024 代理图和匿名 manifest，回传特征。TOPIQ 在 GPU 上约 69 张/秒；连同上传约 10–25 分钟，但慢网会抵消收益。代理图仍含可识别人像，需要控制远端访问和保留期。注意 Node 与 Python 的 DINOv2 特征提取方式不同（mean-patch 对 CLS），两边特征不能混用。 |

**真正的边分析边审**：按封闭的时间窗口发布分组，跨窗口的组延迟到窗口封闭后再发；已发布的组冻结 groupId、成员和排序版本，之后新增的照片另行提示。首屏目标 15–45 秒，后台继续处理下一个窗口。

**不卡本机**：

- 进程优先级 nice 10–15，计算并发 ≤2；sharp、ONNX 和人脸进程统一调度，避免各自的线程池叠加。
- 总内存软上限 3 GiB，内存压力升高时暂停。
- 用户活跃、低电量或高温时降速。

### 2.4 存储（5000 / 1 万单元）

| 内容 | 占用 |
|---|---|
| 1024 代理图（实测均值 178 KB） | 0.9 / 1.8 GB |
| DINOv2 嵌入、指标、人脸框 | 0.1–0.3 GB（JSON 膨胀明显，应改用二进制或压缩） |
| 人脸裁剪（按需生成） | 0.1–0.6 GB |
| 2048 细节图（按需生成） | 2–10 GB，**必须加 LRU/TTL 清理** |

### 2.5 对焦判断必须用原生分辨率（修订于 2026-10-10）

**现状的问题**：

- 清晰度是在缩到 96 px 的整图上算的。
- 人脸检测和 TOPIQ 用的是 1024 px 代理图。
- 审阅页细节图最大 2048 px，人脸裁剪也是从 2048 细节图里切的。

一张 4500 万像素（约 8256 px 宽）的照片缩到 1024 px，相当于缩小 8 倍。眼睛差几厘米的跑焦在这个尺度下看不出来，所以**现在的指标和界面都无法判断对焦**。

**方案：先在代理图上定位，再回原片取 100% 局部**

1. **定位**：在 1024 代理图上检测人脸、眼睛和显著主体，坐标按比例映射回原片。代理图生成时要保留与原片的尺寸关系，并统一处理 EXIF 方向。
2. **取原生像素**：
   - JPEG、HEIC：解码原片后只裁需要的区域。
   - RAW：优先提取机内嵌入的全尺寸 JPEG 预览（多数 Sony、Nikon、Canon、Fuji 机身都有）；没有全尺寸预览的（例如部分中画幅格式，需逐个机型确认），用 libraw 或 rawpy 解码。解码一张 4500 万像素 RAW 约 0.5–2 秒，必须分层、只对候选做。
   - 现有代码对 RAW 只用 Eagle 缩略图（`previews.js`），这是对焦判断的硬伤。
3. **对焦指标**：在 100% 原生像素的眼部、脸部、主体局部块上（例如 2–4 块 512×512），计算多尺度拉普拉斯和梯度能量，再用三种参照归一化：
   - **同一张图里的背景**：区分背景虚化和主体失焦；
   - **同组连拍里的其他帧**：同一场景下谁更清楚，最可靠；
   - **相机记录的对焦点**：从 EXIF makernote 读取（exiftool 支持多数品牌），用来判断对焦点是否落在眼睛或主体上，即「焦点打偏」。
4. **成本**：只对人像和主体明确、处于组内候选的照片做。按每张 0.2–0.5 秒（JPEG/嵌入预览）估算，5000 单元里有一半需要做时约 10–20 分钟，可以并入后台索引。RAW 完整解码要另算。
5. **界面**：审阅页需要 **1:1 放大镜**，并排对比同组各帧的眼部 100% 局部；人脸对比视图也改成从原生像素裁剪，不再用 2048 细节图。

## 3. 用户反馈：怎么存，删图后留下什么

### 3.1 信号的价值排序

1. **改了 AI 建议**（AI 说保留，用户淘汰；或反过来）：信息量最大，说明模型错了。
2. **组内选择**：同一组里选 A 不选 B，得到一对干净的 pairwise 比较，相似场景下的偏好最纯。
3. **整组拒绝、并列**：用来校准门槛和 ε。
4. **标签纠正、分组修正**：用来更新分类器和分组阈值。
5. **弱信号**：事后在 Eagle 里改星级、导出、分享、删除。噪声大，只作辅助。

### 3.2 存储设计：特征库 + 事件日志，与图片生命周期解耦

- **特征库（按内容哈希 sha256 寻址）**：存嵌入（DINOv2，以及将来可能加的 CLIP/SigLIP）、全部指标（含 §2.5 的原生分辨率对焦指标）、人脸框与表情分、EXIF 与对焦点、所属组和组内上下文。每张约 5–10 KB，一年 5 万张约 0.25–0.5 GB。
- **事件日志（只追加不修改）**：每条记录包含时间、run、组 ID、组内其他候选的哈希、AI 建议、用户动作、理由标签、是否写回、操作耗时、模型和权重版本，以及这是一次明确选择还是批量接受。
- **删除时打墓碑**：原片删了也保留特征和事件，并记为强负例「rejected-deleted」。

**删图后保留哪些像素（修订于 2026-10-10）**

只保留低分辨率缩略图是不够的：384–512 px 连对焦都看不出来，用它训练模型，等于教模型忽略对焦。被保留的照片原片仍在库里，随时可以重新取像素；**真正需要额外保存的只有被删除的照片**。按信息价值分档，让用户选：

| 档位 | 保留内容 | 每张约 | 一年删 3–4 万张约 | 能支持什么 |
|---|---|---|---|---|
| 0 仅特征 | 特征库 + 事件日志 | 5–10 KB | 0.2–0.4 GB | 偏好头 L1/L2 重训；换骨干模型后无法重新抽特征 |
| 1 关键局部（需用户在设置开启，默认档 0） | 档 0 + 100% 原生像素的眼部/脸部/主体局部块（2–4 块 512×512，JPEG q92）+ 2048 px 整图 | 0.6–1.2 MB | 20–45 GB | 对焦和表情相关的重训与 LoRA；换骨干后能重新抽特征；可复核当初为什么删 |
| 2 全尺寸 JPEG 存档 | 档 0 + 原生尺寸 JPEG（q85） | 8–20 MB | 0.3–0.8 TB | 几乎所有将来的模型；适合外置盘或 NAS 冷存 |
| 3 原片冷存 | 被删的 RAW 不真正删除，移到冷存储 | 25–80 MB | 1–3 TB | 完全可逆；很多职业用户本来就会把废片留一段时间 |

- 档 1 的空间和价值最平衡：保留的正是做判断时看的那几块 100% 区域。
- 档 2、档 3 可以设保留期（例如 6–12 个月）后自动降到档 1。
- **隐私**：数据只存本地；上传 Ray 训练需要用户显式开启，且只传局部块或特征。人像局部块属于敏感数据，要单独授权。

### 3.3 本轮存储实现边界（2026-10-11）

`feature-store.js`、`event-log.js`、`learning-data.js` 已实现本地 schema v1 与独立 run 内容索引。
新/旧 run 可流式计算一次原片 SHA；仅有旧代理时以 proxy 身份保留，不把分析 fingerprint 冒充原片内容。
完整受保护库存的墓碑累积强负例；历史决定可回填但曝光未知，不能推测用户看过哪张。
启用档 1 后，后续淘汰操作在原片尚在时串行保留原生局部/总览；默认档 0。
RAW/HEIC 专用解码与保留期清理不在本轮，外部已经删除后不能补取像素。

## 4. 用户偏好怎么学：偏好头先行，LoRA 在数月内可行

商业产品、PIAA/Photo Triage、反馈去偏、时间切分评估与本需求逐条取舍见 [research-personalization.md](research-personalization.md)。不设固定起步对数；用本地 10/25/50/100/200 组学习曲线和整组 bootstrap 判断留出集是否稳定优于 L0。

### 4.1 LoRA 的可行性（修订于 2026-10-10）

上一版说「一年只有几百到几千对比较，LoRA 容易过拟合」，这是按普通用户估计的，**对目标用户不成立**。

- **数据量**：一个职业摄影师一年粗选几万张，组内明确选择和对 AI 建议的改动可达数千到数万对，量级接近 Photo Triage（约 10 万对）。**积累几个月后，对个人做 LoRA 是可行的。**
- **标签质量才是瓶颈**：批量一键接受只算弱信号；要区分明确选择、改动 AI 建议、时间压力下的快速通过，并按客户或题材分开（风格不同的数据混在一起会互相抵消）。
- **对焦不需要 LoRA**：对焦是客观标准，靠 §2.5 的原生分辨率局部指标和规则就能做好。LoRA 应该用来学**主观偏好**：表情、瞬间、构图、风格。
- **仍然依赖像素**：LoRA 要回到像素重训，被删照片至少要按档 1 保留关键局部（§3.2）。
- **需要 GPU**：在 Ray 上训，训完蒸馏回 Mac 端的小模型推理；用户纠正后的即时生效靠 L1 偏好头。

### 4.2 推荐的分层方案

| 层级 | 做法 | 数据门槛 | 运行位置 |
|---|---|---|---|
| L0 规则与门槛 | 类别 profile 加硬门槛（闭眼、原生分辨率下主体失焦、焦点打偏），可解释 | 无 | Mac |
| L1 偏好头 | 冻结嵌入 + 指标特征 + 缺失掩码，在组内 pairwise 上训练 Bradley–Terry；默认关闭 | 不设固定对数；时间切分留出集的提升区间稳定高于零才允许影响排序 | Mac，小头重训 |
| L2 组感知排序 | 把整组嵌入和对焦局部特征一起输入 listwise 模型（如 set transformer），直接输出组内选择概率 | 约 1–2 千组，职业用户几周可达 | Mac 推理、Ray 训练 |
| L3 LoRA 微调 | 对视觉骨干（CLIP/SigLIP/DINOv2）或质量 VLM 做 LoRA，输入整图加关键局部；训完蒸馏回 L1/L2 头，供 Mac 推理 | 单个 profile 约 1 万对以上强信号，且被删照片按档 1 及以上保留 | Ray GPU |

L1 的偏好头只有几 KB，删图后照样能用存下来的特征重训，适合做即时反馈层；现有 `spot-eval.js` 和 `personalize.js` 已经是它的雏形（线性、四项指标），需要扩展到嵌入特征、缺失掩码和类别交互。职业用户的数据量允许较早进入 L2/L3，节奏取决于强信号的积累速度。

### 4.3 偏好会变：多 profile，而不是一开始就多个 LoRA

- **时间衰减**：近期的决定权重更高，例如半衰期 3–6 个月；旧事件保留但降权。
- **漂移检测**：持续监测最近 N 组的 top-1 一致率。明显下降时提示用户：「你的偏好可能变了，要按最近的选择重训吗？」
- **多 profile**：按场景维护多个偏好头，例如「个人创作」「客户交付」「家庭记录」，或者按题材区分。切换方式有两种：用户手动选，或按类别概率做混合（mixture of experts）。偏好头很小，维护几十个也没有负担。
- **版本与回滚**：每次重训保存快照，记录训练数据范围和评估结果；效果变差可以一键回滚。
- **多个 LoRA**：职业用户按客户或题材（婚礼、商业、个人创作）的风格差异很大，各自数据也可能足够，多 profile 加多 LoRA 是合理的。可选做法：每个 profile 一个 LoRA，在 Ray 上热切换；或者用 HyperPALoRA 这类方法，一个超网络按偏好向量生成 LoRA，避免 LoRA 数量膨胀。Mac 端仍用每个 profile 蒸馏后的小模型。

### 4.4 L1 缓存模拟验收（2026-10-11）

`scripts/eval-personalization.mjs` 不调用模型、不读取原片，仅使用 T-syn 的已有退化对/系列分析缓存和汕头旧 run 特征。
每个语料模拟先后各 200 次选择，隐藏偏好为偏暗、紧裁、闭眼惩罚更重，随后切换到偏亮、松裁；
批量接受模拟 AI 首选，只赋予弱信号权重。T-syn 按源图切为 14 个训练源/6 个未来留出源；
汕头按旧连拍组切为 29/13 组，测试完整组不参与训练。反复抽取训练组子集模拟几百次动作，
不能把这些动作数理解为独立新会话/新照片数。两套语料单独训练、单独评估，未混用源图与汕头对应原图。

模拟用户和 L1 评估都保留 L0 严重门槛/睁眼优先层级，L0 使用实际排名而非裸分。
10/25/50/100/200 次动作时，T-syn 留出 top-1 为 66.67%/66.67%/83.33%/83.33%/100%，L0 为 0%；
仅 6 个留出源，200 次时 bootstrap 区间退化为 [100%,100%]，不能视为总体无误差。
汕头 L0 为 38.46%，L1 为 69.23%/69.23%/69.23%/69.23%/76.92%；200 次时 L1 95% CI
[53.85%,100%]、相对 L0 提升 CI [15.38%,69.23%]。但只有最后一个检查点显著胜出，曲线尚无后续稳定证据；
生产时间切分两窗口均报告 no-stable-heldout-improvement，不应据模拟器启用真实排序。模拟选择不是摄影师标注。

偏好切换后冻结旧头：T-syn 一致率从 100% 降到 16.67%，漂移提示触发；汕头从 76.92% 降到
46.15%，区间重叠，提示不触发。T-syn 新偏好 top-1：不衰减 66.67%，20 天半衰期 83.33%，区间重叠；
汕头两种设置均为 61.54%，不能宣称衰减在真实数据上显著改善。
实现使用 signed BT、固定 12 维 DINO 投影与指标缺失掩码，支持有来源的类别概率交互；
没有类别数据时弃权。按组归一并衰减，批量接受不作为留出胜过 L0 的证据。
两时间窗口均需配对组 bootstrap 提升下界大于零；保存数据范围/摘要与快照，手动启用/应用。
重排保留 L0 硬门槛层级与原始排名基线，漂移只提示，profile 关闭/切换恢复未审组 L0。
本轮只实现 L1 与本地基础设施；L2/L3 保留研究方向，不训练、不部署、不加入主动学习自动队列。

复现：`nice -n 10 node scripts/eval-personalization.mjs --out /tmp/w7-personalization-qa`。
机器可读 [report.json](artifacts/w7-learning/report.json) 与独立 [learning-curve.svg](artifacts/w7-learning/learning-curve.svg)
已保存到文档产物目录；测试及基线对照见 [testing.md](testing.md)。

## 5. 要不要做成端到端

| 方案 | 优点 | 缺点 |
|---|---|---|
| 现状：模块化指标 + 手工权重 | 可解释、便宜 | 指标测的不是真正关心的东西，权重补偿 |
| **半端到端（推荐）**：冻结骨干嵌入 + 可解释指标，组感知排序器端到端学习 | 学到真实偏好，又保留门槛和理由；Mac 可跑；删图后能重训 | 需要标注积累 |
| 像素级端到端（整组图片进，选择出） | 理论上限高 | 数据饥渴、不可解释、难以纠错、贵；没有 Photo Triage 级别的数据难以训好 |
| VLM 直接判断（Q-Align、VisualQuality-R1、Compare2Score 一类） | 能给自然语言理由，零样本 | Mac 跑不动批量推理；有文化和提示词偏差；个性化弱 |

**建议**：

- 产品形态走「半端到端」：门槛和理由保持可解释，排序交给学习。
- VLM 放在 Ray 上当**离线老师**：对组内图对给出偏好和理由，作为弱标签蒸馏进 L1/L2 头，同时可以生成「各有所长」的解释文案。
- 像素级端到端只作为远期研究。职业用户的数据量让它比原先估计的更现实，但需要两个前提：整图与原生分辨率局部块双路输入（只看缩放图会学不到对焦）；被删照片按档 1 以上保留。在此之前，「半端到端 + 原生分辨率对焦模块」是更稳妥的路线。

## 6. 论文库检索：上次为什么没帮上忙

上一轮的检索脚本只扫了 `derived/` 顶层的 2 个 parquet 文件（约 22 万行），而 `derived/` 实际递归包含 **24,035 个文件、108.5 GB**。另外两部分是英文全文 3.66 TB（2000 个文件）和中文全文 0.92 TB（2000 个文件）。**覆盖率不到万分之一**，所以不能得出「论文库没有相关论文」的结论。

改进后的做法（`ml/research/search_corpus_facets.py`）：

- 用 Ray 并行任务全量扫描 `derived/` 的标题和摘要头部（集群有 1500 个 CPU 可用）。
- 按 12 个角度分别建中英文关键词表：系列选择、主题审美、审美属性、个性化审美、人像与人脸质量、模糊与景深、多目标选择、相册策展、IQA/审美模型、轻量化与蒸馏、反馈与持续学习、LoRA/VLM 排序。
- 每个角度都要求同时命中照片、图像或审美类的上下文词，抑制通用词噪声。

结果见第 7 节。后续计划：

- **语义检索**：在 Ray GPU（≤2 卡）上用 bge-m3 一类的多语种嵌入模型给标题和摘要建向量索引，用自然语言问题检索，弥补关键词漏召。
- **引用扩展**：从核心论文出发，在全文里查找引用它们的论文（例如引用了 "Photo Triage"、"TAD66K"、"NIMA" 的论文），再沿引用链做一到两跳。

## 7. 论文库多角度检索结果

**覆盖范围**：英文 d4 全库的标题与摘要头部索引（`derived/d4_en_index_20261001/head_index`，2000 个文件）加 `derived/` 顶层的 2 个文件，共 **1.24 亿行**。在 Ray 上开 401 个并行任务，约 12 分钟扫完（扫描作业 `raysubmit_bKiYa7BQqDWM9z7L`，合并作业 `raysubmit_wDVjBXi7Bcq7sk3b`）。

注意：`derived/` 的其他子目录是别的项目的专题子集（金融、机器人、运筹、程序验证等），这次不扫；中文全文没有标题和摘要索引，这次也没扫（见下文后续计划）。

**结果文件**：

- Ceph `research/facets/<角度>.jsonl`：每个任务、每个角度保留前 200 条，所以命中数有上限。
- `research/facets/curated.json`：精选版。标题里必须出现照片、图像、审美类词，并排除 photometry、photonic、医学影像、遥感等词。仓库副本为 [`ml/research/facets_curated.json`](../ml/research/facets_curated.json)。

| 角度 | 原始命中 | 精选后 |
|---|---|---|
| 系列选片 series_selection | 4,316 | 621 |
| 主题审美 theme_aesthetics | 5,173 | 839（"genre" 一词带来大量文学/音乐噪声） |
| 审美属性 aesthetic_attributes | 1,415 | 140 |
| 个性化审美 personalized_aesthetics | 1,349 | 376 |
| 人像与人脸质量 portrait_face_quality | 33,326 | 2,590 |
| 模糊与景深 blur_defocus | 12,989 | 4,325 |
| 相册策展 album_curation | 1,152 | 622 |
| 轻量化与蒸馏 efficient_distillation | 12,845 | 2,826 |
| 反馈与持续学习 feedback_continual | 21,155 | 1,836 |
| 多目标与多样性、IQA 模型、LoRA/VLM | 5–8 万 | 噪声大，需靠语义检索 |

**按方向精选的相关论文**（来自检索结果，标题已核对；年份、出处和细节待逐篇确认）：

- **系列/连拍选片**：
  - Automatic Triage for a Photo Series
  - Real-time Burst Photo Selection Using a Light-Head Adversarial Network
  - To Keep or not to Keep: An Expectation-oriented Photo Selection Method for Personal Photo Collections
  - Learning Personalized Expectation-Oriented Photo Selection Models for Personal Photo Collections
  - Automatic Selection of Representative Photo and Smart Thumbnailing Using Near-Duplicate Detection
  - Photo Summary: Automated Selection of Representative Photos from a Digital Collection
  - Collaborative Image Triage with Humans and Computer Vision
  - Towards Aesthetics: a Photo Quality Assessment and Photo Selection System
- **人像选片**：
  - Perceptual Deep Portrait Image Selection: Subjective and Objective Approaches
  - All Smiles: Automatic Photo Enhancement by Facial Expression Analysis
  - 人脸图像质量：SER-FIQ、RankCORE、Face Image Quality Assessment Based on Learning to Rank、Efficient Face Image Quality Assessment via Self-training and Knowledge Distillation
- **主题感知审美**（支持第 1 节的类别条件化）：
  - Theme Aware Aesthetic Distribution Prediction with Full Resolution Photos
  - Theme-Aware Semi-Supervised Image Aesthetic Quality Assessment
  - A Mobile Image Aesthetics Processing System with Intelligent Scene Perception
- **审美属性与构图**（对应「各有所长」的维度）：
  - Aesthetic Attribute Assessment of Images Numerically on Mixed Multi-attribute Datasets
  - Aesthetic Attributes Assessment of Images (AMANv2 / DPC-CaptionsV2)
  - Predicting Scores of Various Aesthetic Attribute Sets by Learning from Overall Score Labels
  - Image Composition Assessment with Saliency-augmented Multi-pattern Pooling
- **个性化审美**（对应第 4 节的偏好头与多 profile）：
  - Personalized Image Aesthetics Assessment with Rich Attributes
  - LAPIS: A novel dataset for personalized image aesthetic assessment
  - Learning Personalized Image Aesthetics from Subjective and Objective Attributes
  - Personalized Image Aesthetics Assessment via Meta-Learning With Bilevel Gradient Optimization
  - Transductive Aesthetic Preference Propagation for Personalized Image Aesthetics Assessment
  - User-Guided Personalized Image Aesthetic Assessment based on Deep Reinforcement Learning
  - USAR: an interactive user-specific aesthetic ranking framework for images
  - Personality-Assisted Multi-Task Learning for Generic and Personalized Image Aesthetics Assessment
  - Personalized Image Aesthetics Assessment via Multi-Attribute Interactive Reasoning
  - AesBiasBench: Evaluating Bias and Alignment in Multimodal Language Models for Personalized Image Aesthetic Assessment
- **偏好漂移与交互学习**（对应第 4.3 节）：
  - Handling concept drift in preference learning for interactive decision making
  - Dynamic Detection of Relevant Objectives and Adaptation to Preference Drifts in Interactive Evolutionary Multi-objective Optimization
  - Revisiting Relevance Feedback for CLIP-based Interactive Image Retrieval
- **多偏好 LoRA**：HyperPALoRA: Parameter-Efficient Pareto Hypernetworks via Preference-Based Diverse Low-Rank Adaptations。它用一个超网络按偏好向量生成 LoRA，可以替代「维护多个 LoRA」的思路，值得精读。
- **模糊归因**：
  - Defocus Blur Detection via Depth Distillation
  - Spatially variant defocus blur map estimation and deblurring from a single image
  - Simultaneous Estimation of Defocus and Motion Blurs from Single Image using Equivalent Gaussian Representation
  - Identifying Image Composites by Detecting Discrepancies in Defocus and Motion Blur
- **相册摘要与多样性**（对应 Pareto 前沿的截断展示）：
  - Travel Photo Album Summarization based on Aesthetic quality, Interestingness, and Memorableness
  - Audience Dependent Photo Collection Summarization
  - A multi-criteria context-sensitive approach for social image collection summarization
  - Stimulating Photo Curation on Smartphones
  - Generating Visual Story Graphs with Application to Photo Album Summarization
  - A Survey on Learning Crowdsourced User Preferences for Visual Summarization of Image Collections
- **轻量化 IQA/审美**（对应第 6 节的 Mac 端审美头）：
  - MobileIQA
  - LAR-IQA
  - GreenBIQA
  - Intelligent Photographing Interface with On-Device Aesthetic Quality Assessment
  - Semi-Supervised Blind Image Quality Assessment through Knowledge Distillation and Incremental Learning

**这一轮的局限与后续**：

- 关键词检索对通用词（genre、pareto、mobile、interactive）的精度很低，多目标、IQA 模型、LoRA/VLM 这几个角度基本被噪声淹没。下一步用多语种嵌入模型（如 bge-m3，Ray ≤2 GPU）给 1.24 亿条标题和摘要建向量索引，用自然语言问题做语义检索。
- 中文：英文全文 3.66 TB、中文全文 0.92 TB 都没有扫。中文没有标题索引，需要先从全文的前若干字符抽一份中文 head 索引，再按同样的角度检索。
- 引用扩展：在英文全文里找出引用上述核心论文的工作，按被引次数和年份排序，补全 2023–2026 年的最新进展。
