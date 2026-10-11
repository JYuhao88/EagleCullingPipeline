# 关节裁切老师（离线、只读）

依赖：Python 3 + Pillow、本机 `codex` CLI 和已登录的 codex-lb（127.0.0.1:2456）。
默认模型 `gpt-6.1-sol` 与本机配置一致；可用 `--model` 显式调整，模型变化会使回答缓存失效。
源文件只读，不调用 Eagle，不要求用户标标签。

在沙箱外运行：

```sh
cd <LOCAL_PATH>
nice -n 10 python3 ml/teacher/joint_crop_teacher.py \
  --input /tmp/w1-pose-qa \
  --out /tmp/w2-measure/teacher \
  --max-calls 150 --timeout 420
```

脚本内部也通过 `nice -n 10 codex exec` 调用，每次只有一个老师进程，并使用指定的
`model_provider="codex-lb"`、provider 配置、`--sandbox read-only`、`--output-schema`、`-i`、`-o`。
当前受限沙箱会打印 `nice: setpriority: Operation not permitted`，并在内嵌 app-server 初始化时 EPERM。
这不是老师的 uncertain 回答。首次探针计入预算，不能删 calls.json 来重置预算。

可先生成图而不调用老师：

```sh
nice -n 10 python3 ml/teacher/joint_crop_teacher.py --prepare-only
```

每张图片使用 SHA-256(unitId) 前 20 位作为目录名，目录内包括：

- `annotation.jpg`：干净代理图与同图的主体框/关键点叠图；画面四边橙线。
- `sample.json`：unitId、名称、图路径、主人数及缓存键；不包含 selected 标签。
- `prompt-0.txt` / `prompt-1.txt`：固定问题，仅交换状态选项顺序。
- `raw-0.json` / `raw-1.json`：CLI 的原始结构化回答。
- `answer-0.json` / `answer-1.json`：校验后的缓存（含键）。
- `exec-0.log` / `exec-1.log`：运行输出与失败原因。

输出根目录：`schema.json`、`calls.json`（每次启动尝试、耗时、成功/失败）、
`labels.json`（两次回答合并）、`summary.json`（总调用数/耗时/分布/是否完整）。
`--prepare-only` 写 `prepared.json` 和 `prepare-summary.json`，不会覆盖实际标注报告。
重复执行同一命令自动续跑；键包含图片内容、关键点、提示版本、schema、provider、模型。
锁防止并行进程突破预算；默认串行，最多累计 150 次尝试，包括失败和中断。
失败立即退出，无自动重试；在外部问题解决后手动续跑仍计入同一预算。
正常完成 50 张需要 100 次成功调用，加已记录的沙箱失败一次预计累计 101 次。

六类关节各回答 `crop|safe|uncertain`、裁切边、置信度和视觉证据。
两次状态或裁切边不一致、任一次 uncertain、任一次置信度 <0.7 时，该关节归 uncertain。
样本级 overall 保留旧汇总诊断，任一关节 uncertain 会使它为 uncertain。
评估用 measure_qa.mjs 按关节过滤：某关节 uncertain 只排除该关节，不能排除该样本其他确定关节。
模型 na 不计 safe 或正确，另外报告覆盖率。
safe 必须能定位并排除关节裁切；画外不可定位不自动等于 safe。
不询问照片好坏、保留/删除；汕头是直出样本，沿用 W1 50 个 unitId 仅用于保持分层样本一致。

旧 `raw-poses.json` 是从序列化信号重建的，画外坐标已截断。辅助点不作为真值。
真实视觉标注只能提供弱监督，需与合成已知裁切真值及独立评估区分。
另外，现有 P-CROP-WRIST 包含 fingers、P-CROP-ANKLE-FOOT 包含 foot；
这份老师只回答用户指定的六类关节，不可将合并规则的手指/脚命中直接当腕/踝预测比较。

完成后检查 `summary.json` 的 `complete=true`、`outputSamples=50`、`completedCalls=100`，
保留整个目录以供逐次审计与误报/漏报复核。


## 已有老师结果后的离线校准与 QA

已有结果的离线校准不再运行老师。以下命令均不调用老师、不写回 Eagle：

```sh
nice -n 10 node ml/teacher/measure_calibration.mjs --out /tmp/w2-measure/calibration
nice -n 10 node ml/teacher/joint_crop_evaluate.mjs --input /tmp/w2-measure/synthetic
nice -n 10 node ml/teacher/measure_qa.mjs --out /tmp/w2-measure-qa
```

`joint_crop_evaluate.mjs` 只读取已经实际推理的 crop 关键点，按同一几何真值比较 HEAD 基线与当前信号。
所有 na 单列，不当 safe；`confirmedOverAll` 把 na 留在分母，条件一致率另报。
参数敏感性和按源图隔离结果均属探索性验证，不能宣称盲测。
`measure_qa.mjs` 用原 253 个缓存代理图与 W1 关键点重算，不重复全量模型推理。
它保存各规则分布、逐关节老师比较、十例联系表、待补标名单及代理图 SHA-256；
老师 calls.json 在执行前后哈希必须一致。默认展示全部题材分支，不推断用户的题材标签。

合成样本首次生成/推理命令（当前数据已经存在，不必重复）：

```sh
EAGLE_PYTHON=<LOCAL_PATH> \
EAGLE_POSE_PROVIDER=CPUExecutionProvider nice -n 10 node ml/teacher/joint_crop_synthetic.mjs
```

它要求源图单人及源点置信度 ≥0.6，并保存实际像素裁切和 source transform provenance。
原点坐标变换只说明切点，不能替代重新推理预测；这次 48 张已真正推理。
`--reuse` 只用于同一不变 manifest 的断点续跑；如果改了切点/图片内容须重新推理，不能按同名 id 复用。
踝在靴内、颈插值和相关源图限制见 synthetic/manifest.json 与研究文档 §8。
