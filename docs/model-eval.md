# 模型评测（2026-10-09）

本轮使用 Ray `<RAY_DASHBOARD>`，外网代理 `<HTTP_PROXY>`，Ceph 根目录 `<CEPH_ROOT>/`。本机没有批量跑评测。

## AVA 清单与合理性检查

保留脚本 [`ml/eval/build_ava_manifest.py`](../ml/eval/build_ava_manifest.py)。它从 Ceph 已解压元数据读取，缺失时以 `r|gz` 流式读取 `datasets/ava.tgz`，只读取 `AVA.txt`、`aesthetics_image_lists/generic_test.jpgl` 和所需图片成员。AVA 行格式是 `row_number image_id count_1..count_10 ...`，MOS 使用 `image_id`（第二列）计算：`sum(i * count_i) / sum(count_i)`。上一轮错误使用第一列行号，导致图像和分数错配；同时错误使用了 `style_image_lists/test.jpgl`。

本轮输出 `datasets/ava-test-5000.json`，seed `20261009`，5000 张，且图片均存在于 `datasets/ava_stream/AVA_dataset/images/`。检查输出：

```text
SANITY mos_mean=5.3039 mos_std=0.7811 n=5000
CHECK id=99165 mos=5.347973 raw=119172 99165 5 5 24 51 91 60 23 24 6 7 14 25 249
CHECK id=97622 mos=5.166090 raw=155266 97622 3 13 43 60 52 47 40 13 11 7 15 38 246
CHECK id=121649 mos=6.153094 raw=26480 121649 1 4 10 22 74 89 39 38 19 11 21 38 278
CHECK id=166051 mos=4.976898 raw=2498 166051 4 6 25 74 101 57 22 7 6 1 20 0 328
CHECK id=192166 mos=5.591928 raw=68417 192166 0 5 10 32 63 61 31 11 7 3 5 20 350
```

均值约 5.4、标准差约 0.7，且随机样本的原始行与计算值已人工核对。

## AVA 评测

每次评测均写出 `eval/ava/<model>_predictions.jsonl`，每行含 `id, mos, pred`，指标是未校准预测的 SRCC/PLCC。200 张冒烟门槛先通过：TOPIQ-IAA `0.7118/0.7071`、NIMA `0.6200/0.6124`、LAION `0.6674/0.6443`。

|模型|训练分布|N|SRCC|PLCC|吞吐 img/s|
|---|---|---:|---:|---:|---:|
|technical-aesthetic-lite|启发式|5000|-0.018384|-0.013015|34.98|
|TOPIQ-NR|KonIQ|5000|0.274360|0.299694|68.94|
|MUSIQ|KonIQ|5000|0.228480|0.262270|34.85|
|TOPIQ-IAA|AVA train（与测试同分布，指标偏乐观）|5000|0.725363|0.732951|34.85|
|NIMA|AVA train（与测试同分布，指标偏乐观）|5000|0.658767|0.666715|34.93|
|LAION aesthetic v2|LAION aesthetic|5000|0.610674|0.619364|34.81|

之前的 AVA 数字全部作废；上表是修正 image_id 和 generic_test 后重跑的结果。TOPIQ-IAA、NIMA、LAION 的结果必须标注为训练/测试同分布，不能当作跨分布泛化结论。

## TOPIQ-NR ONNX 验证与部署

真实权重位于主仓库 `models/scorer/`；本 worktree 的同名文件是符号链接。Ceph 归档目录为 `<CEPH_ROOT>/models/onnx/`。SHA-256 固定为：

```text
topiq_nr_512.onnx      bc1f59ca097afadb7c9343fa370d0fe47b0cfe5e21b623957f597a6f2bea08eb
topiq_nr_512.onnx.data 0ab4e4c4da5eb6461357379178e96b06ebfc11105a02c0854598d56b910b2582
```

Ray 上 KonIQ 测试集 30 张：EXIF 校正后直接双线性拉伸到 512×512，转 RGB、除以 255，不做 mean/std。ONNX 与 pyiqa 原版 SRCC 分别为 **0.905 / 0.901**（网络 512 输入为 0.908），平均分差小于 0.001。此前 Mac 上 `.data` 曾损坏（前 80 MB 与 Ceph 不同，分数约为 0）；已按 1 MB 分块比对并补传修复。`fetch_weights.py` 现在同时校验两个 SHA-256，目标已存在且通过校验时跳过复制。

主仓库 Node scorer 使用 `onnxruntime-node`、`intraOpNumThreads=3`，Mac M3 Pro 单张约 **307 ms**；2 线程约 435 ms。768 长边预览输入约 312 ms。CoreML EP 因外部权重初始化失败，未采用。
本地对照时，Node（sharp 双线性）与 Python（Pillow 双线性）绝对分可差约 0.06；同一张图把 Node 解码数组喂给 Python ONNX 分数一致。Ray 评测与 pyiqa 对齐使用 Pillow 预处理。生产路径以主仓库 Node scorer 为准。


## TOPIQ-IAA 固定 512 ONNX（本轮）

沿用上表已修正的 AVA 5000 张结果，首选 TOPIQ-IAA。新脚本 [`ml/eval/export_topiq_iaa.py`](../ml/eval/export_topiq_iaa.py) 使用 pyiqa `0.1.16` 的 `topiq_iaa`（Swin Base）原版权重，固定 ONNX 输入 `float32 [1,3,512,512]`，opset 17。路径 API 实际进入网络的张量已用 forward pre-hook 捕获，与 RGB `/255` 数组最大差为 **0**；外部预处理为 EXIF 校正、RGB、Pillow bilinear 拉伸到 512、除以 255，无外部 ImageNet mean/std。

网络自身在推理时用 torchvision antialias bilinear 缩放到 384，然后做 ImageNet mean/std。为绕过 legacy ONNX 对 `_upsample_bilinear2d_aa` 的不支持，脚本从同设备 torchvision 的基向量响应生成固定可分离线性算子，保留内部归一化；GPU resize 最大像素差为 **1.192e-7**。不能删除内部归一化，也不能在外部再做一次。原始输出是 AVA MOS **1–10**；JSONL 的可选 aesthetic 转为 `(raw-1)/9`，与 quality 分开记录 model/version。

Ray 同一批 AVA generic test manifest 前 **30 张**，分别测直接 512 与 768 长边预览再进 512；原版 pyiqa GPU 与 ONNX CPU 的原始 MOS 平均绝对差均为 **0.00000694593**（unit 分差 `0.00000077177`），通过 `<0.02` 门槛。比较前已恢复 pyiqa 的原始 resize 函数，未用导出替代操作生成参考分数。逐张记录归档为 Ceph `models/onnx/topiq_iaa_parity.json`，输入路径 API/网络源码为 `topiq_iaa_pyiqa_source.txt`。

Ceph 已归档 `topiq_iaa_512.onnx`（**516,702,434 bytes**，单文件、无需 `.data`）与 `topiq_iaa_512.json`。固定 SHA-256：

```text
topiq_iaa_512.onnx 1507e13834b375822b426adcf9984c1d2293d91270c887ff524bde7e32aed1ad
```

仓库固定清单 [`ml/scorer/topiq_iaa_512.manifest.json`](../ml/scorer/topiq_iaa_512.manifest.json) 与 Ray 结果 [`ml/eval/results/topiq_iaa_512_ray.json`](../ml/eval/results/topiq_iaa_512_ray.json) 记录哈希与验证证据。`fetch_weights.py --model topiq-iaa-onnx` 使用仓库清单而非信任来源目录的 JSON，复制前后都校验 SHA，已有目标正确时跳过，拒绝覆盖错误或悬空符号链接。可用 `--target` 显式选择目标仓库目录。

Mac 同步后全文件 SHA 通过，使用同一批 **30 张 AVA JPG**，3 次预热后逐张测量。CPU intra-op=3、inter-op=1，实际 niceness=10。Python ONNX Runtime `1.31.0`；主仓库已安装 Node runtime 上报 `1.24.3`。本机 macOS `26.5.1 arm64`。

|Mac 路径|平均推理 ms|平均含预处理 ms|中位数总 ms|P95 总 ms|最大总 ms|对 Ray pyiqa 原始 MOS MAE|结论|
|---|---:|---:|---:|---:|---:|---:|---|
|Python / Pillow|476.19|481.15|459.96|576.95|942.25|0.00000710487|精度通过；延迟不通过|
|主仓库 Node / sharp|442.27|448.40|422.51|637.03|648.55|0.110028|原始精度和延迟均不通过|

Python 的 unit MAE 为 `0.00000078943`，Node 的 unit MAE 为 `0.0122253`；门槛按原版 **1–10 原始 MOS** 比较，未用单位归一化缩小差异。Node bilinear 与 Pillow 的像素处理差异不能视为导出网络误差；同一 Pillow 数组的网络数值已由 Python 路径验证。两种实现的平均和中位数耗时都超过 400 ms，因此结论不依赖极端单张耗时。统计另保留最大单张门槛判断。

完整逐张本机记录：[`topiq_iaa_512_mac.json`](../ml/eval/results/topiq_iaa_512_mac.json)、[`topiq_iaa_512_mac_node.json`](../ml/eval/results/topiq_iaa_512_mac_node.json)；可复用基准脚本为 [`benchmark_aesthetic.py`](../ml/eval/benchmark_aesthetic.py) 与 [`benchmark_aesthetic.mjs`](../ml/eval/benchmark_aesthetic.mjs)。Python 路径从 RGB 图像产生 768 长边预览，再 bilinear 512；Node 路径用 sharp 完成同样尺寸约定。`infer.py` 接受现成预览时预处理一致，传原图则直接 512，所以不能用此基准代表原图 CLI 的解码耗时。

**决策：不启用 TOPIQ-IAA。** 固定输入和 Python 数值门槛通过，Mac CPU 400 ms 门槛不通过；主仓库 `src/core/scorer.js` 未改，继续输出 aesthetic null，`ranking-weights.json` aesthetic 仍为 0，不增加 source 或默认启用模型。`infer.py --aesthetic-onnx` 仅提供显式评估入口，默认仍不加载 IAA；可选模型缺失/非有限输出会返回 aesthetic null 与 warning，保留 quality，模型/版本分开记录。

权重已同步到本 worktree 的 `models/scorer/`。主仓库权重写入被当前沙箱拒绝（`PermissionError: Operation not permitted`），因此 **主仓库 `models/scorer/` 同步尚未完成**；未通过链接绕过权限限制。这不改变本轮未达标、保持禁用的决策。

## 默认模型决策

质量分数默认仍为 `topiq-nr-onnx`。审美默认**不启用**，`ml/scorer/infer.py` 输出 `aesthetic: null`；不会回退到 technical-aesthetic-lite。TOPIQ-IAA 在 AVA 上 SRCC **0.725**，NIMA **0.659**，LAION **0.611**；TOPIQ-IAA 已导出并通过 Ray 数值对照，NIMA/LAION 本轮未导出；Mac Python/Node 平均含预处理耗时分别为 **481/448 ms**，均超过 400 ms，故保持 `aesthetic: null`、aesthetic 权重为 0。

## 排序权重与人工抽查

当前仍使用手定 `manual-v1`：sharpness 0.3、exposure 0.2、eyes 0.15、quality 0.2、aesthetic 0。待取得组内首选/难例标注后，按拍摄者或场景分组交叉验证，使用 Bradley–Terry/RankNet 拟合并保留“平局/需人工”出口。

## 本地人工抽查一致率（待补）

占位：待在 Mac fixture 与真实连拍样本上记录抽查样本数、人工首选、模型首选及一致率。

## Photo Triage（Chang et al. 2016）

尝试过：官方 `http://phototriage.cs.princeton.edu/` 和 HTTPS（代理均 503）；官方新页面 `https://pixl.cs.princeton.edu/pubs/Chang_2016_ATF/`；Wayback 快照及 `download.html`；GitHub API 和两个相关仓库；Hugging Face、Kaggle API、Zenodo API；未发现可验证的数据包直链，因此没有写入 Ceph `datasets/phototriage/`。

- `zhenshen-mla/Series-Photo-Selection`：ICASSP 2020 复现代码，README 只要求用户另行下载 Automatic Triage 数据；仓库未含官方图片/标注，未见明确数据许可证。
- `snehabhattacharya/adobe_best_photo`：课程项目 Siamese 排序代码，README 链接回 Princeton 下载页；仓库未含官方图片/标注，未见明确数据许可证。

官方论文页面记录数据规模为 15,545 张图片、5,953 个 series，并有 98,780 个系列内偏好；但本轮没有拿到归档文件，无法报告本地结构、pairwise 标注文件或 train/val/test 划分，也没有声称已下载。

## 本轮 Ray 作业

|作业|用途|最终状态|
|---|---|---|
|`raysubmit_ESt5yJDbn77AfTyE`|首次 manifest 流式抽取（因先选中缺失图片，手动停止）|STOPPED|
|`raysubmit_sAZujqRyJMsQyUmQ`|修正版 AVA manifest|SUCCEEDED|
|`raysubmit_1Rj672uegLNAyvCz`|200 technical smoke|SUCCEEDED|
|`raysubmit_Qzd6SGSWQne47wfw`|200 TOPIQ-IAA smoke|SUCCEEDED|
|`raysubmit_PtTbf9R4ztDmMSC4`|200 NIMA smoke|SUCCEEDED|
|`raysubmit_6vR9E5Q7xH14uFcZ`|200 LAION smoke|SUCCEEDED|
|`raysubmit_WBKCqF1dV7kcVLML`|200 NIMA（缺 pyiqa 的初始环境）|FAILED|
|`raysubmit_TWRypqqp6G7HXBsX`|200 TOPIQ-IAA（缺 pyiqa 的初始环境）|FAILED|
|`raysubmit_KqH25JDJgtvZKVKy`|200 LAION（缺 pyiqa 的初始环境）|FAILED|
|`raysubmit_MwEYRHvvCVUQ9ARC`|5000 technical|SUCCEEDED|
|`raysubmit_N16RvFeJRC1pgdBx`|5000 TOPIQ-NR|SUCCEEDED|
|`raysubmit_mH8vkXJ1h4uzRU51`|5000 MUSIQ|SUCCEEDED|
|`raysubmit_T7qiLsLeq2trMCL6`|5000 TOPIQ-IAA|SUCCEEDED|
|`raysubmit_nr1GMkmAFbx4EXkJ`|5000 NIMA|SUCCEEDED|
|`raysubmit_jmMWiRMNfyL3ArkC`|5000 LAION|SUCCEEDED|
|`raysubmit_VmBnacgrvnZysxc4`|5000 TOPIQ-NR 初次别名错误|FAILED|
|`raysubmit_AVa7CK7KmhaMSb3W`|验证 runtime env 的 pyiqa 安装|SUCCEEDED|
|`raysubmit_sdrdtKezM2cVN1W1`|TOPIQ-IAA 参数量核对|SUCCEEDED|

结束前查询 `ray job list`/Dashboard：以上提交均为终态，`ACTIVE=[]`，没有 `RUNNING` 或 `PENDING`，无需 stop。


## TOPIQ-IAA 门槛验证 Ray 作业

|作业|用途|最终状态|
|---|---|---|
|`raysubmit_63F24ffkdPHqkmv3`|首次实际输入探测，Ceph 随机加载过慢|STOPPED|
|`raysubmit_tTJxFRYv6ED6jMiS`|原版网络源码与缓存核对|SUCCEEDED|
|`raysubmit_T9BTJs2mahkPyv6P`|Swin 内部 resize、配置与输出尺度核对|SUCCEEDED|
|`raysubmit_j7ampXH6WxX5b8su`|首次导出，Ceph 随机加载过慢|STOPPED|
|`raysubmit_5z8MceYQgZtBZGwU`|临时只读 HTTP 传输服务，端口返回 502 后停止|STOPPED|
|`raysubmit_iWx849expmXYVtnw`|CPU 加载探测，确认同样卡在读取权重|STOPPED|
|`raysubmit_6LCscucVa6HmRqcR`|Ceph 权重读取诊断|STOPPED|
|`raysubmit_ZPPALmHr2XZdatJB`|顺序加载后导出；CPU/GPU resize 基算子设备不一致|FAILED|
|`raysubmit_mBsa8nEqJL6g5Fzq`|关闭 TF32 复核，定位为基算子设备舍入差|FAILED|
|`raysubmit_k9sXGMj5TSejbZZW`|同设备固定 resize 导出、30 张原版 pyiqa 对照、Ceph 哈希归档|SUCCEEDED|
|`raysubmit_kSwRM86e7BeA51Hn`|模型/JSON/源码及同批 30 张 AVA JPG 分块传输|SUCCEEDED|

以上作业均已逐个查询为终态，`ACTIVE=[]`；没有本轮提交的 RUNNING/PENDING。


## 本轮修改与验证

- 新增 `ml/eval/export_topiq_iaa.py`、`ml/eval/benchmark_aesthetic.py`、`ml/eval/benchmark_aesthetic.mjs`。
- 修改 `ml/scorer/infer.py`、`ml/scorer/fetch_weights.py`；新增 `ml/scorer/topiq_iaa_512.manifest.json`。
- 新增 `ml/eval/results/topiq_iaa_512_ray.json`、`ml/eval/results/topiq_iaa_512_mac.json`、`ml/eval/results/topiq_iaa_512_mac_node.json`。
- 更新本文件和 `docs/mac-ray-ceph.md`。ONNX 位于 ignored 的 `models/scorer/`，Ceph 为持久归档。
- 主仓库 `nice -n 10 npm test`：**50 passed, 0 failed, 0 skipped**。Python 语法编译、Node 语法检查、真实模型默认/可选/缺失美学入口和已有权重跳过校验另作检查。未 commit/push，未读写「未删减」或example.library 原片。
