# 组内照片选优研究（2026-10-09）

## 检索与证据边界

检索脚本是 [`ml/research/search_paper_corpus.py`](../ml/research/search_paper_corpus.py)。它只读论文库 parquet 的 row group，先扫描 `derived/` 两个文件的标题和全文（共 **218,154 行**），再按显式参数选择中文库或英文 d4 抽样。本轮扫描 derived，命中 643 行，按 `(source_id,title)` 去重为 **624 篇**；关键词命中结果（最多 200 条）写在 Ceph `research/culling_hits.jsonl` 和 `research/culling_hits_top.json`，仓库副本为 [`ml/research/culling_hits_top.json`](../ml/research/culling_hits_top.json)。本轮没有把 2,000 个英文 d4 parquet 当成“全量”：`--d4-sample 0`，覆盖率为 0；最终成功作业的中文扫描参数为 `--zh-files 0`，中文库覆盖率为 0，不能把未扫描中文论文当成未命中。脚本默认 `--zh-files 25`，可在后续专门中文检索中使用。

关键词包括 photo/series/burst/best-shot/culling/near-duplicate、aesthetic/IQA/NR-IQA、pairwise/ranking、blink/closed-eyes、CPC/GAIC、Q-Align/Q-Instruct/DeQA/Q-Insight/VisualQuality-R1/Compare2Score 及 AVA/FLICKR-AES/REAL-CUR/SPAQ/KonIQ/PaQ-2-PiQ/FLIVE。通用缩写（例如 `CPC`）会带来医学、物理等噪声；因此 Top 文件是候选证据，不是人工确认的相关论文清单。人工相关的 Top 线索包括 TOPIQ、相对排序 NR-IQA、EDQA-495K、Q-Bench+（图像对比较）、SLIQUE/TADAC、CPC/GAIC 等。

可下载性探测脚本 [`ml/research/probe_datasets.py`](../ml/research/probe_datasets.py) 在 Ray 节点经 `<HTTP_PROXY>` 执行，原始结果写入 Ceph `research/dataset_download_probes.json`。HTTP 200 只证明着陆页/API 可达，不等于图片包可下载；许可证和 Flickr/个人相册再分发权仍需单独核验。

## 可替代数据集

| 数据集 | 任务形式与规模 | 对组内选优的贴合度 | 许可证/实际下载性（Ray 实测） |
|---|---|---|---|
| Photo Triage / Chang et al. 2016 | 5,953 个系列、15,545 张图、98,780 个系列内偏好对；组内 pairwise | **最高**，直接对应连拍/系列 | 官方 HTTP 503、HTTPS 代理隧道 503；Wayback、GitHub、HF、Kaggle、Zenodo 未找到可验证包；论文/网页可引用但不能声称已下载。 |
| CPC / Good View Hunting (2018) | 超过 1M 个比较裁剪/视图对；同一原图的局部构图比较 | 中：能拟合构图权重，不能代表曝光、闭眼和瞬时表情 | Stony Brook 首页 `200`（`VPN_CVPR2018s.html`）；图片/标注下载入口需人工确认，未自动下载；按页面许可说明使用。 |
| GAIC/GAICD (Zeng et al. 2019) | 约 3,000 张图、每张多个专家候选 crop（常见版本约 100K crop 对） | 中：构图/裁剪子目标，可作为 composition 分量 | 常见 GitHub 链接在本次探测为 404；原作者页面/Google Drive 需人工核验，未下载。 |
| AADB (Kong et al. 2016) | 约 10,000 张图，MOS/属性（leading lines、rule of thirds 等） | 中低：全局审美和属性，非组内 | 原始 Flickr 图片按 Flickr/研究条款；本轮候选仓库 URL 404，未下载。 |
| FLICKR-AES | 约 40,000 张 Flickr 图、5 人 AMT 评分 | 低到中：全局 MOS，可校准审美分 | HF API 搜索 `200`（5 条以内）；原图重新分发权受 Flickr/CC 条款限制，未自动拉取。 |
| REAL-CUR | 14 个个人相册、相册主人评分（论文附录规模） | **高于普通 MOS**：有真实个人策展偏好，但样本很小 | HF API 搜索 `200`；相册图像/隐私和许可需按作者条款，未下载。 |
| SPAQ | 11,125 张智能手机照片，MOS 与场景/设备元数据 | 中低：手机真实质量，适合曝光/噪声/清晰度 | 论文/公开仓库链接本次给定 URL 为 404；需从作者页面重新确认，未下载。 |
| KonIQ-10k | 10,073 张自然图、MOS/分布 | 低到中：NR-IQA 基准，适合技术质量分 | Ceph 已有 `datasets/koniq10k.tgz` 与解压目录（此前 Ray 下载并校验）；公开发布条款需遵循原站。 |
| PaQ-2-PiQ | 约 40,000 张 patch/整图质量标注 | 中：局部清晰度/失真，适合作为细节质量分 | 候选 GitHub URL 本次 404；论文页可达性未形成可下载包，未下载。 |
| FLIVE | 约 40,000 张真实驾驶/移动场景图及质量标签 | 低：场景偏差大，适合作为跨域 NR-IQA 检查 | 论文/项目页需单独核验，本轮未下载。 |
| CEW / Closed Eyes in the Wild | 约 2.4 万张眼部裁剪（闭眼/睁眼二分类，常见版本） | **高（单一缺陷）**：可验证闭眼检测召回，不能评价整体首选 | HF “closed eyes” 搜索 API `200`；具体仓库的图片许可各异，未下载。 |
| CADB（补充） | 约 10,000 张构图图及 5 人等级/属性 | 中：构图属性和等级 | GitHub `bcmi/Image-Composition-Assessment-Dataset-CADB` `200`；README 指向约 2GB Dropbox/Baidu 包，未下载。 |
| Series-Photo-Selection 复现 | ICASSP 2020 代码；依赖用户另行取得 Automatic Triage | **高但不可复现**：方法线索而非新数据 | GitHub `200`，仓库无官方图片/标注，README 未给数据许可；未下载。 |

已有 Ceph 数据：`datasets/ava.tgz`（`du -sh` 约 **31G**，解压 `ava/` 约 1.6G、`ava_stream/` 约 549M，含图片与 AVA 评分）和 `datasets/koniq10k.tgz`（约 **6.0G**）。本轮研究任务没有重新复制大包，也没有把只有着陆页 200 的 CPC/CADB 误记为已下载。Photo Triage、CPC、GAIC、AADB、PIAA、SPAQ、PaQ-2-PiQ、FLIVE、CEW 均没有新增图片包落到 `datasets/<name>/`。

## 方法与可复用实现

| 方法 | 年份/核心思路 | 开源与权重 | Mac CPU/蒸馏判断 |
|---|---|---|---|
| Automatic Photo Triage（Chang et al.） | 系列内学习视觉质量、脸/眼和摄影偏好，直接预测系列偏好 | 论文有代码线索；官方数据不可得，权重许可证未形成可核验包 | 传统 CNN 可 CPU 跑；应重训/蒸馏为轻量 pairwise ranker。 |
| Series-Photo-Selection（ICASSP 2020 复现） | Siamese/排序式系列选择，复现 Automatic Triage 接口 | GitHub 代码 `200`，依赖外部数据；权重许可需逐项看仓库 | 推理可 CPU；数据缺失使结果只能作方法参考。 |
| NIMA | 2016，输出 1–10 审美分布，学习 AVA MOS | 多个实现；权重许可随实现 | 小 CNN 可 Mac CPU；适合蒸馏为审美分量，不能替代组内标签。 |
| MUSIQ / TOPIQ-NR | 2021/2024，多尺度 Transformer/语义到失真 top-down NR-IQA | 官方/社区实现和权重需按仓库许可；本仓库已有 TOPIQ-NR 评测 | Transformer 较慢/较大；可在 Ray 做教师、蒸馏到 MobileNet/MLP。 |
| LAION aesthetic v2 | CLIP 图像嵌入上的线性审美回归 | 权重与 LAION/CLIP 条款分别核验 | CPU 可跑但 CLIP 较重；适合离线教师。 |
| CPC/GAIC crop rankers | 成对裁剪或密集候选排序，学习构图偏好 | 多数代码开源，数据/图片许可分离 | CNN/ViT 推理可 CPU；只蒸馏 composition head。 |
| Q-Align、Q-Instruct、DeQA、Q-Insight、VisualQuality-R1、Compare2Score | VLM 用自然语言质量解释或直接比较单图/图对；Compare2Score/Q-Bench+强调 pairwise | 论文/部分代码公开；模型权重许可和商用边界逐个核验 | Mac CPU 不适合批量原生推理；放 Ray 作教师，缓存 pairwise 概率/理由后训练本地 ranker。 |

## 推荐评测和拟合方案

1. **可复现基线**：用现有 KonIQ/AVA 测技术质量与审美相关性（SRCC/PLCC），用 CEW 测闭眼召回；拆分按拍摄主体/来源，避免同图泄漏。它们不能证明组内选优，只能约束单项分量。
2. **组内 pairwise 主评测**：优先争取 Photo Triage 的授权归档；拿不到时，从公开可下载图片按时间/近重复特征构造相似组，人工标注每组首选和难例对（至少 500 组、双人独立、冲突仲裁）。指标用 pairwise accuracy、组内 top-1、NDCG@k、Kendall tau，并报告 bootstrap 置信区间。
3. **Ray VLM 教师**：在相似组内随机抽图对，要求 VLM 只回答“左/右/平局”并给可选理由；温度、提示词、裁剪尺寸固定，保存原始回答、模型版本、时间和成本。用人工 100–200 组校验教师一致性，低一致性类别不进入训练。VLM 标签只作弱监督，不能替代人工金标准。
4. **排序权重拟合**：特征分为技术质量（清晰度、曝光、噪声）、人像风险（闭眼/表情/遮挡）、构图/审美、组内代表性（相似度中心、重复惩罚）。在人工 pairwise 上用 Bradley–Terry/RankNet 拟合线性权重，按拍摄者/场景分组交叉验证；校准后固定阈值，保留“平局/需人工”出口。
5. **偏差控制**：AVA/FLICKR-AES 偏向公开摄影与 AMT 审美；CPC/GAIC 偏向裁剪构图；SPAQ/FLIVE 偏向手机或驾驶场景；CEW 只覆盖眼部；VLM 会继承提示词、文化和主体偏差；人工小样本会有摄影师个人风格偏差。最终验收必须回到 Eagle 的 38 个拍摄单元和真实连拍难例，并与人工决定比较。

## Ray 作业收尾核对

本轮检索作业：`raysubmit_tCd6MV2TdxGpGUFL` **SUCCEEDED**；探测作业：`raysubmit_yQfzSsr9vBTUNQcD` **SUCCEEDED**。早期超时/范围过大的中文扫描作业 `raysubmit_JgYqHzr8K6bjJGzW`、`raysubmit_GiRKdi2xFHRANAnU`、`raysubmit_nKd1xpefsanMVL4u` 均已显式 STOPPED。结束时再次查询 Ray Job API，未有 `RUNNING` 或 `PENDING`；没有需要 stop 的活动作业。

## 推荐落地方案

1. 先用至少 500 组真实连拍，双人标注首选/平局/难例，按拍摄者分组留出测试集。
2. 提取 sharpness、exposure、eyes、quality、aesthetic、组内代表性与重复惩罚特征。
3. 在训练组上拟合 Bradley–Terry/RankNet，交叉验证并校准平局阈值。
4. 只在冻结测试组报告 pairwise accuracy、组内 top-1、NDCG@k、Kendall tau 及 bootstrap 区间。
5. 将拟合权重导出为版本化配置，回放 Mac fixture 与真实难例后再替换 manual-v1。

## 后续调研

类别化选片与 Pareto 候选集的诊断和方案见 [research-genre-pareto.md](research-genre-pareto.md)。

- 测试方案：[test-plan.md](test-plan.md)；人像手、体态、裁切：[research-portrait-body.md](research-portrait-body.md)
