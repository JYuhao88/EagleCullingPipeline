# DINOv2 轻量美学参考头

本功能只提供 Inspector「画质」后的中性「美感」列；0–1 映射为显示分值，不参与照片排序、规则、
分组、Pareto 候选集或个人偏好学习。`ranking-weights.json` 的 aesthetic 权重仍为 0。
TOPIQ-IAA 在 Mac 上原有 442–481 ms/张的评测超过 400 ms 门槛，因此不在正常分析中执行老师模型。

## 嵌入规格与一致性

两个现有入口的嵌入不等价，不能混用：

| 入口 | 预处理 | 池化 |
|---|---|---|
| 主分析 `src/core/embeddings.js` | sharp 默认 JPEG 缩小加载、嵌入 ICC 转 sRGB、Lanczos3 cover 256、居中提取 224 | 不含 CLS 的 patch token 均值、L2 |
| `python_worker/embedding_worker.py` | EXIF 转正、Pillow RGB、短边 256 的 BICUBIC、居中 224 | CLS、L2 |

两者都是 384 维。最终头匹配主分析的 `dinov2-small-mean-patch-224-v1`；已缓存、没有版本字段的旧结果按此入口解释。
显式标注 `dinov2-small-cls-224-v1` 的结果返回未知，不能直接用本头。

DINO ONNX 来自 `Xenova/dinov2-small`，SHA-256：
`83141175ec78b4ff9a2bb58a4c7c264ba0054d1c2e122e5a8114b79a8d4179ea`。
Ray 使用同一个 ONNX 权重，通过 pyvips 复现 sharp 的 JPEG 缩小、ICC 转换、Lanczos3 和裁切。
居中 cover 在奇数残差上向上取整；patch 均值模拟 JS Float32Array 的逐次舍入，再用双精度计算 L2。

20 张公开 AVA 图在 Ray ONNX 与本机实际 `embedImage` 路径间：最小余弦 **0.9999999999949145**，
平均 **0.9999999999985348**，224×224 RGB 像素差全部为 0。检查经过两次有界修正：
第一次最小余弦 0.988416，第二次 0.995618；裁切舍入和 Adobe RGB 转换补齐后才通过。
本轮用 CPU ONNX 完成门槛，没有 HF 模型替代或 GPU 浮点等价性的额外声明。

## 公开数据与拟合

只在 Ray 处理 AVA。Ceph 原有 `ava-test-5000.json`，每行含 id、公开图像路径及 MOS；
训练优先读取 `generic_train.jpgl`；本次该文件缺失，实际用 `train_splits/ILGnet_train.txt` 的 235,529 个 ID，
用 seed=26 抽取 20,000 张，并排除 generic_test、
ILGnet 验证集和 official_test_challenges 中的 ID；测试使用现有 5,000 张 manifest。
本次合计排除 38,465 个测试/验证 ID；1 张训练图（公开 ID 729377）无法解码并剔除，最终 **19,999 train + 5,000 generic_test**。
MOS 从 AVA.txt 的 1–10 星票数加权计算，训练与测试按 ID 检查互斥。
本 worktree 没有背景中提到的 `ml/eval/build_ava_manifest.py`，脚本直接读取公开原始划分及现有测试 manifest。

原始完整 AVA 的 33.25 GB 压缩包已在 Ceph，但训练图片尚未展开；脚本顺序扫描公开压缩包，
只提取抽中的训练图到 `<CEPH_ROOT>/research/w26-aes/ava-train/`，不展开整个数据集。
顺序提取的 JSONL 在 `<CEPH_ROOT>/research/w26-aes/samples.jsonl`；并行预取版在 `research/w26-aes-stream/samples.jsonl`。
每行只记录公开图片 ID、划分、分数和嵌入，不记录机器路径。
嵌入矩阵和摘要传回 `<LOCAL_ARTIFACTS>`，不提交大文件。

老师为已评测的 `topiq_iaa_512.onnx`，SHA-256：
`1507e13834b375822b426adcf9984c1d2293d91270c887ff524bde7e32aed1ad`。
输入是 EXIF 转正、RGB、Pillow bilinear 拉伸到 512、除以 255；网络内置 384 antialias 与 ImageNet 标准化。
老师原始 MOS 1–10，导出头最终以 `(prediction-1)/9` 截到 0–1。

岭回归用训练集 5 折交叉验证，alpha 网格 0.1、1、10、100、1000、10000；
标准化在每个折内拟合，按负 MSE 选择。对照是 8 隐层节点的 ReLU MLP，训练内部 early stopping。
架构只用训练集另做 3 折 SRCC 比较；MLP 平均 SRCC 比岭回归高超过 0.02 才选 MLP。
测试集只用于最后报告，不选架构或 alpha。

岭回归标准化折叠到系数；MLP 标准化折叠到第一层，按隐层节点缩放，优先量化为 int8；若损失超过门槛，则用 gzip 编码的 int16 保留精度。
量化损失超过老师 SRCC 0.002 时拒绝导出，不以精度不足的模型填补交付。
小 JSON 包含权重、偏置、归一化、嵌入规格、公开数据来源、ID 摘要和一致性证据。

## 指标与延迟

真实结果及复现摘要在 [summary.json](../ml/aesthetic/results/summary.json)。岭回归 alpha=100，最终导出 7,260 字节。
MLP 的训练集 3 折平均老师 SRCC 为 0.5023，岭回归为 0.5616；未满足超过 0.02 的采用门槛。
MLP 完整训练 early stopping 为 136 个 epoch，3 个 CV 折均触及 150 epoch 上限；这只是有界小 MLP 对照，不代表所有 MLP 架构。

| 模型 / generic_test 5,000 张 | 对老师 SRCC | 对老师 PLCC | 对 AVA MOS SRCC | 对 AVA MOS PLCC |
|---|---:|---:|---:|---:|
| 岭回归（最终头） | 0.5790 | 0.5972 | 0.5050 | 0.5185 |
| 8 节点 MLP | 0.5724 | 0.5845 | 0.4974 | 0.5034 |
| TOPIQ-IAA 老师 | 1 | 1 | 0.7503 | 0.7565 |

本机只读 291 条缓存嵌入，全部兼容。23 条 human 决定产生 59 对不同等级比较，来自 **1 个组**；
同等级对排除，模型相等记 0.5。本次没有模型分数相等的对。

| 本机指标 | 结果 |
|---|---:|
| 头与人工等级的组内成对一致率 | 15.25%（9/59） |
| 现存界面总分的一致率，groups[].ranking[].score | 100%（59/59） |
| results[].score 初始分析分的一致率 | 15.25%（9/59） |
| 最多 60 张预览，头与本机老师 SRCC / PLCC | 0.5191 / 0.4373 |
| 291 条嵌入上 JS 与 Python 的最大绝对分差 | 1.6653e-15 |
| JS 纯头推理，10,000 次平均 / P95 | 0.00846 / 0.01038 ms |
| 本机老师，60 张、2 线程平均 / P95 | 643.62 / 706.50 ms |

同权重与预处理的一致性已证明；用户照片上为中等正相关，不能说明忠实替代完整老师，
更不能支持人工选片排序。当前界面总分与头的差异也表明，必须区分已存排名分和初始分析分。
这组照片对共享同一个组，没有独立组层面的泛化证据；保持参考显示和所有决策入口隔离。

## 接入和缓存

`aestheticFromEmbedding` 对 384 维有限数组进行校验；缺少头、错误维数或不匹配的版本返回 `null`。
读取旧 run 时在 item-analysis 现场计算，不修改结果文件。其他来源已有的 aesthetic 保留，包括 0 分。
本头写入 `aestheticSource: dinov2-head` 与 `aestheticHeadVersion`；自身来源每次按当前模型重算，
过期缓存进入分析时先移除，全部决策完成后才补入结果和缓存。更换 JSON 后重启服务加载新头，不需要重跑照片分析。
候选集与学习特征读取时另按来源排除参考值，防止历史结果经过手动重分组或学习后间接参与决策。

这是普通 JS 点积或 8 节点矩阵运算，不另读照片、不启动 Python、也不调用 DINO。
美感列标记 neutral，不高亮胜者，不添加选片解释。

## 复现

连接配置只从私有环境或忽略的本机配置读取。文中的占位符须替换；不要把实际连接信息写入代码、提交或日志。
本机命令须继承至少 nice=10 的父进程；本轮已经继承 nice=10，沙箱内不再调用 nice。
数值计算设置 OMP/MKL/OPENBLAS 至多 2 线程，Python 依赖仅通过 Ray runtime_env 安装。

```bash
source '<PRIVATE_ENV_SCRIPT>'
export OMP_NUM_THREADS=2 MKL_NUM_THREADS=2 OPENBLAS_NUM_THREADS=2
python ml/aesthetic/submit.py parity --cpu --id '<PARITY_JOB>'
python ml/aesthetic/submit.py status --id '<PARITY_JOB>'
python ml/aesthetic/fetch_stream.py --id '<PARITY_JOB>' --output '<LOCAL_ARTIFACTS>'
```

解压与矩阵对应由 prepare_parity.py 自动完成；然后运行实际本机路径并校验 RGB 像素：

```bash
python ml/aesthetic/prepare_parity.py --artifacts '<LOCAL_ARTIFACTS>' --fixtures '<PARITY_FIXTURES>'
EAGLE_DINO_THREADS=2 node ml/aesthetic/check_local_parity.mjs '<PARITY_FIXTURES>'
python ml/aesthetic/prepare_parity.py --artifacts '<LOCAL_ARTIFACTS>' \
  --fixtures '<PARITY_FIXTURES>' --verify-pixels
python ml/aesthetic/submit.py approve --cpu --id '<APPROVE_JOB>' \
  --parity-report '<PARITY_FIXTURES>/local-parity.json'
python ml/aesthetic/submit.py extract --cpu --id '<EXTRACT_JOB>'
python ml/aesthetic/submit.py status --id '<EXTRACT_JOB>'
python ml/aesthetic/fetch_stream.py --id '<EXTRACT_JOB>' --output '<LOCAL_ARTIFACTS>'
python ml/aesthetic/fit.py --matrix '<LOCAL_ARTIFACTS>/matrix.npz' \
  --parity-report '<PARITY_FIXTURES>/local-parity.json' \
  --output src/core/aesthetic-head.json --report '<LOCAL_ARTIFACTS>/fit.json'
```

解包与公开图片推理可各用一个作业；预取版用 `submit.py stream --cpu`，只消费写完的 JPEG，矩阵按固定抽样顺序排列。
两者输出目录分开。本次解包作业的旧版推理因路径类型错误失败，但 20,000 张目标图片已经写完；
修正版复用已有 24,541 条记录，只补算 459 条并剔除 1 张不可解码训练图，最终数据在 `research/w26-aes-resume/`。
6 张训练 JPEG 的非标准尾部使早先尾标记等待停滞，5 张可解码；复现优先采用解码校验与原子写入，不依赖尾标记。本轮启动时所有 GPU 已被其他工作预留；CPU 提取使用一个 64 CPU 作业、32 个二线程 worker。
正常 GPU 版本去掉 `--cpu`，只预留 1 GPU。最多两个本任务作业在运行；不停止其他项目任务，
作业终止后核对状态；同类失败最多重试两次。大产物用 WebSocket 日志尾流传输，并校验分块顺序和整文件 SHA-256。

本机照片只读，不上传原片、预览、嵌入或人工决定：

```bash
'<LOCAL_PYTHON_WITH_ORT>' ml/aesthetic/local_teacher.py \
  --results '<LOCAL_RUN>/results.json' --model '<LOCAL_TEACHER_ONNX>' \
  --output '<LOCAL_ARTIFACTS>/local-teacher.json' --limit 60
node ml/aesthetic/benchmark.mjs '<LOCAL_RUN>/results.json' '<LOCAL_ARTIFACTS>/latency.json'
python ml/aesthetic/evaluate_local.py --results '<LOCAL_RUN>/results.json' \
  --decisions '<LOCAL_RUN>/decisions.json' --head src/core/aesthetic-head.json \
  --teacher '<LOCAL_ARTIFACTS>/local-teacher.json' --js-scores '<LOCAL_ARTIFACTS>/latency.json' \
  --output '<LOCAL_ARTIFACTS>/local-eval.json'
EAGLE_LIBRARY_PATH=/unconfigured/expected.library npm test
```

只取 source=human；精选 > 候选 > 淘汰。同组、不同人工等级且两种分都可用的所有成对比较，
模型相等算 0.5，人工相等排除。界面总分取 groups[].ranking[].score（缺失才取 results[].score）；另列 results[].score 初始分。两者用同一批照片对。
老师最多 60 张，按 unitId 排序后等距抽样，不挑选表现好的预览；会报告 SRCC、PLCC 及实际覆盖数。
23 个已有人工作决定的单元不能代表完整用户偏好，组内照片对也不是独立样本。

## 局限与为何不进排序

这是蒸馏 AVA 老师的参考头，不是用户审美或摄影好坏的客观标准。压缩到 DINO 表征和小头可能丢失老师信息，
中心裁切可能漏掉手、姿势、关节边界和完整身体；AVA 与用户照片的题材、拍摄流程及预览分布也不同。
较高的老师相关性不能证明人工选片更好，组内人工样本量较少时尤其如此。
正常分析只读取已有嵌入，因此不会用参考分重新评判表情、姿态、全身构图或已有规则证据。
模型缺失时展示未知，权重为 0，并同时阻断 Pareto 和学习入口；启用排序需要另行实证与授权。

## Ray 作业与资源释放

本次开始时 GPU 32/32 已预留，GPU 一致性作业未启动便取消；其终态为 FAILED，driver_exit_code 为空。
全部实际计算在 CPU 完成。最多两个本任务作业同时运行，公开数据的解包与推理输出分开；没有停止其他项目作业。
最终核对本任务 RUNNING/PENDING 数为 **0**，预留资源均已随作业终止释放；不据此声称整个共享集群空闲。

| 作业 ID | 最终状态 |
|---|---|
| w26-aes-archive-inspect | SUCCEEDED |
| w26-aes-decode-inspect | SUCCEEDED |
| w26-aes-extract-cpu-1 | STOPPED |
| w26-aes-extract-cpu-2 | FAILED |
| w26-aes-extract-cpu-3 | STOPPED |
| w26-aes-extract-cpu-4 | FAILED |
| w26-aes-extract-stream-1 | FAILED |
| w26-aes-extract-stream-2 | STOPPED |
| w26-aes-extract-stream-3 | STOPPED |
| w26-aes-parity-1 | FAILED |
| w26-aes-parity-approved | SUCCEEDED |
| w26-aes-parity-cpu-1 | SUCCEEDED |
| w26-aes-parity-cpu-2 | SUCCEEDED |
| w26-aes-parity-cpu-3 | SUCCEEDED |
| w26-aes-probe-1 | SUCCEEDED |
| w26-aes-probe-2 | SUCCEEDED |
| w26-aes-progress-inspect | SUCCEEDED |
| w26-aes-remaining-inspect | SUCCEEDED |
| w26-aes-resume-1 | SUCCEEDED |
| w26-aes-split-inspect | SUCCEEDED |
| w26-aes-teacher-transfer-1 | STOPPED |
| w26-aes-teacher-transfer-2 | SUCCEEDED |
| w26-aes-train-remaining-inspect | SUCCEEDED |

parity-cpu-1/2 的 Ray 执行成功不代表一致性通过；两次局部检查失败后，parity-cpu-3 达标。
extract-cpu-2 因已展开训练图不足失败；旧版 extract-stream-1 与 extract-cpu-4 推理存在路径类型错误。
相应问题修正后，没有无限重试；STOPPED 包括资源等待取消、性能优化与尾标记就绪等待的主动终止。
resume-1 复用 24,541 条有效记录，只补缺失 459 条；剔除 1 张不可解码训练图后，完整产物通过 SHA 校验。

## 验证边界

真实头全套 node:test：549 项，546 通过、0 失败、3 跳过。
两项跳过缺少真实库/模型夹具，一项因沙箱不允许回环监听；不宣称真实 Eagle UI 端到端验收。
不调用 Eagle API。本机老师推理进程及拟合进程均已退出；所有命令继承 nice=10，数值计算最多 2 线程。
本机 results.json、decisions.json 前后 SHA-256 未变。原片、预览、用户嵌入和人工决定均未上传 Ray。
