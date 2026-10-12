# 姿态模型算法/量化加速实验（w23-quant）

本实验全部默认关闭，未改变默认 CPU provider、模型路径、规则、signals 或排序。新增开关为
`EAGLE_POSE_COREML_OPTIONS`（JSON provider options）和 `EAGLE_POSE_DET_SIZE`（仅在模型静态输入尺寸匹配时接受）。
实验缓存只写 `data/cache/w23-quant/`；模型没有加入仓库。

## 结果

速度来自同一份 `data/cache/previews` 固定 10 张预览、单 worker、单线程请求；命令均使用
`nice -n 15` 并在 `/tmp/w23-heavy.lock` 内运行。绝对时间受后台 QoS 影响，以下数字只用于本机相对比较。

| 候选 | 实测结果 | 一致性/质量 | 结论 |
|---|---|---|---|
| CPU YOLOX-m 640 + RTMW-x-l 256×192 | 10 张 wall **73.682 s**，峰值 **607.3 MiB**；逐张总推理 4.360–14.560 s，平均 **7.099 s** | 基线；本轮未改变模型输出 | 保留为对照 |
| CoreML `MLProgram` + `ALL` + 静态 shape + 缓存目录 | 单张子进程实测：ready **6.875 s**，峰值 **693.4 MiB**，总 **7.156 s**；detector **2.381 s**、pose **3.278 s** | detector/pose 均实际回退 `CPUExecutionProvider`；CoreML 创建 MLModel 失败（error code **-6**），并出现 E5RT 缓存目录权限错误；无有效 CoreML 一致性/加速比 | 默认关闭，须人工确认算子支持、缓存目录权限和首张编译后才能启用 |
| YOLOX 输入 512 / 416 | 两次均在首张前失败：模型输入静态为 **640×640**，ORT 报 `Got 512/416 Expected 640`；无有效速度/质量数据 | 无输出可比较 | 当前模型不可行；需官方发布对应静态模型或重新导出后再测 |
| tiny 416 + l-m 256×192 | wall **31.907 s**，峰值 **341.3 MiB**，相对 640 基线约 **2.31×** | 10 张中 **7 张 signals/verdicts 不同**，主体一致性不通过；最大归一化坐标差 **0.8640** | 不推荐 |
| m 640 + l-m 256×192 | wall **75.469 s**，峰值 **409.0 MiB** | 10 张中 **7 张 signals/verdicts 不同**，主体标记一致但关键点最大差 **0.8633** | 不推荐 |
| tiny 416 + x-l 256×192 | wall **42.403 s**，峰值 **492.4 MiB**，约 **1.74×** | 与基线存在人数差异，signals/verdicts 差异未通过 | 不推荐 |
| tiny INT8 动态 + l-m | wall **26.592 s**，峰值 **348.4 MiB**；仅约 **1.20×** 于 tiny 浮点 | 尚未达到质量候选门槛 | 不进入 Ray |
| tiny INT8 静态 QDQ + l-m | wall **3.972 s**，峰值 **334.9 MiB**；速度约 **8.0×** 于 tiny 浮点 | 10 张均未产生可比较人物结果，signals/verdicts **7 张不同**；静态模型曾因 per-channel `axis` 不被 ORT 接受，改为 per-tensor 后可加载但质量不可用 | 不推荐 |
| 官方 tiny / l-m | tiny zip SHA-256 `36e09ca555916253fa1b5d51bec01e48e98e1f0af966c51ce3e844d8c8fc4cfc`；l-m zip SHA-256 `a6d08a575c9d8b8da7ce6c13e1c7341047fca35594a6d35de04b739eba51139c`。解包模型 SHA-256 见本机缓存清单 | tiny 输入确认为 416×416；l-m 为 wholebody 133、256×192 | 已完成来源核验和 CPU 实测 |

CoreML 失败的已知基线证据是 `docs/pose-provider.md`：YOLOX 首张出现静态输出与推断输出 rank 不匹配并回退 CPU；
本轮只增加正确的 ORT 1.31 provider options 传递和独立 `ModelCacheDirectory`，不把 provider 列表当作算子已在 ANE/GPU 执行的证据。
沙箱内的 CoreML 实测不作为结论；主代理应在前台运行下面的一致性命令。

### CoreML 前台实测（主代理，非沙箱）

`MLProgram` + `CPUAndGPU` + 静态 shape，检测与关键点均实际运行在 `CoreMLExecutionProvider`。

| 项 | CPU 单线程 | CoreML |
|---|---:|---:|
| 随机输入 YOLOX-m 640 | 817 ms | 22 ms |
| 随机输入 RTMW-x-l 256×192 | 219 ms | 53–57 ms |
| 10 张预览 wall / 峰值 | 12.6 s / 643 MiB | 5.6 s / 661 MiB |

无人照片约 30 ms（CPU 约 800 ms）；多人照片仍 0.6–2.0 s。CPU 3 线程 10 张为 5.0 s。

一致性：10 张探测集派生 signals 与 verdicts 全部相同（坐标最大差 0.0026）。
388 张合成图：主体一致，但 **32 张派生 signals 不同、4 张 verdicts 不同**，坐标最大差 0.463。
GPU 半精度改变了个别低置信关键点，**不能作为默认**；若作为可选项，需要先评估合成基准三项指标。

## 可复现实验

```sh
nice -n 15 sh -c 'until mkdir /tmp/w23-heavy.lock 2>/dev/null; do sleep 15; done; trap "rmdir /tmp/w23-heavy.lock" EXIT;
EAGLE_POSE_DET_SIZE=640 python_worker/.venv/bin/python scripts/bench-pose-provider.py --provider CPUExecutionProvider --label quant-cpu-640;
EAGLE_POSE_COREML_OPTIONS='{"ModelFormat":"MLProgram","MLComputeUnits":"ALL","RequireStaticInputShapes":true,"ModelCacheDirectory":"data/cache/w23-quant/coreml"}' python_worker/.venv/bin/python scripts/bench-pose-provider.py --provider CoreMLExecutionProvider --label quant-coreml-options'
```

QDQ 探测只使用固定种子的合成张量，不读取或上传用户照片：

```sh
python_worker/.venv/bin/python scripts/quantize-pose.py models/pose/yolox_m_8xb8-300e_humanart-c2c7a14a.onnx --output data/cache/w23-quant/models/yolox_m-int8.onnx
```

前台 CoreML/CPU 一致性（10 张固定探测图）和派生比较：

```sh
nice -n 15 python_worker/.venv/bin/python scripts/compare-pose-providers.py \
  --coreml-units CPUAndGPU \
  --output data/cache/w23-quant/provider-compare.json \
  $(cat data/cache/pose-provider/probe-inputs.json | tr -d '[]"' | tr ',' ' ')
```

脚本输出逐张 `maxCoordinateDelta`/`meanCoordinateDelta`、主体标记、实际 provider，
并调用 `src/core/signals.js` 与 `src/core/rules-engine.js`；派生比较会删除 signals 中的原始
`persons[].keypoints`、`box`、`score` 后再统计 signals/verdicts 差异。388 张合成图可用：

```sh
nice -n 15 python_worker/.venv/bin/python scripts/compare-pose-providers.py \
  --manifest test/fixtures/bench-syn-manifest.json --coreml-units CPUAndGPU
```

## 规则影响

当前规则使用 wholebody 133 点中的颈、肩、肘、腕、髋、膝、踝以及头顶/面部裁切相关点（见
`src/core/signals.js`、`src/core/candidate-measurements.js` 和 `src/rules/*.json`）。因此 17 点模型即使检测速度更快，
也不能默认替换；必须逐点比较 signals 和规则 verdicts，并人工复核手部、关节裁切、姿态和构图。

## 风险与后续

CoreML 需要真实成功的 detector 与 pose 两阶段推理、冷/热缓存、峰值内存和逐点差异证据后才可评审启用。
本轮 CPU 候选没有同时满足“加速至少 1.5×且派生差异少”，因此没有提交 Ray 作业；不能用不合格候选填充质量 delta。
量化使用 `/tmp/w23-quant-venv`，分别校准 YOLOX 与 RTMW；合成校准不能证明真实照片质量。任何实验模型路径都只通过
`EAGLE_POSE_MODEL`/`EAGLE_POSE_DETECTOR` 显式指定，默认路径保持不变。
