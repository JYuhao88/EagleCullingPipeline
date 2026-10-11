# Ray 冷算 bench 与本机缓存回放

`scripts/bench-ray.py` 使用现有 `private_env` 与 Ray Jobs HTTP 接口。
基础设施来自环境变量或不入库的 `config/local.json`；不打包私有配置文件或旧分析缓存。
仅打包 bench 相关代码、固定合成清单和清单中校验通过的图像、五个实际使用的模型。
模型/图像以 64 MiB 分块包上传，worker 校验重组后的 tar SHA-256。

本机 `python_worker/.venv` 必须提供已配置的本地 Python 环境，可用符号链接；
两端统一 `EAGLE_PYTHON=python_worker/.venv/bin/python`、
`EAGLE_POSE_PROVIDER=CPUExecutionProvider`，其余签名环境变量清空。
脚本调用 bench 原有的 `analysisSignature()`，不覆盖或改写签名。

```sh
source ~/.config/eagle-culling/env.sh
nice -n 15 python3 scripts/bench-ray.py submit
nice -n 15 python3 scripts/bench-ray.py status --id <本线作业ID>
nice -n 15 python3 scripts/bench-ray.py collect --id <本线作业ID>
nice -n 15 python3 scripts/bench-ray.py audit
```

作业 ID 使用 `w11-raybench-`，同一时刻只允许一个自身作业，预留 2 CPU、0 GPU、8 GiB。
worker nice 15，CPU affinity 两核，Node heap 2048 MiB；模型与图像逐阶段串行分析。
外层 timeout 7200 秒。`stop --id` 仅接受本线 ID；不操作其它作业。
终态作业可用 `submit --reuse-assets <本线作业ID>` 复用资源包，必须重新核对整个 tar 的 SHA-256。

Node 和 npm 模型运行依赖版本取自本机。Python 固定 MediaPipe、NumPy、Pillow、ORT、rtmlib
和 OpenCV contrib 的本机版本；Ray 使用相同 OpenCV release 的 headless 构建。
MediaPipe 的 EGL/GLES 链接依赖从公开 conda-forge 取回，校验发布元数据中的 SHA-256，
仅解包到作业临时目录，通过 LD_LIBRARY_PATH 使用，不修改集群系统。
worker 先验证全部代码和模型 SHA-256、签名，再做单图人脸/姿态预检，然后运行原有 bench。

结果以 gzip/base64 分行回传，末尾核对完整传输 SHA-256；每条 JSON 另有 SHA-256。
collect 只接受 SUCCEEDED 作业，重新检查本机代码、模型和签名，并核对清单导出的完整缓存键集合。
缺少姿态 signals、人脸/TOPIQ 不可用或存在模型警告时拒绝导入。
通过后原子写入现有 `data/cache/bench/analysis/<key>.json`；不重命名键或修改模型结果。
本机提交记录、私有日志和校验凭据位于系统临时目录下的 `w11-raybench/`，不入库。

本机最终执行（不继承影响签名的额外环境配置）：

```sh
unset PYTHONPATH EAGLE_POSE_MODE EAGLE_POSE_MODEL EAGLE_POSE_DETECTOR
EAGLE_PYTHON=python_worker/.venv/bin/python EAGLE_POSE_PROVIDER=CPUExecutionProvider EAGLE_BENCH_CACHE_ONLY=1 nice -n 15 node --max-old-space-size=2048 scripts/bench.mjs --compare data/cache/bench/reports/2026-10-11T03-11-11-048Z/report.json
```

cache-only 仍按现有 bench 做一次 TOPIQ 文件验证与单图推理预检。
出现 cold images 时立即失败，不允许本机补算。跨平台浮点位级一致性未单独验证；
核对范围为相同分析代码、模型字节、缓存签名、依赖 release，以及真实 bench 的逐行对照。

## 同平台质量门槛与隔离基线

**质量门槛必须同平台比较**：用同一 Ray 运行环境、依赖与模型字节比较合并前后代码。
Ray 新结果与历史 Mac 基线的差异用于平台/环境敏感性分析，不能单独用于证明代码回归或不回归。
同平台也必须保存清单、代码提交/树、模型 SHA-256、依赖版本及真实报告，逐行核对判定与分数；
不得用旧模型输出填充新缓存，也不得为了追平指标改签名、阈值、排序或规则。

W11 同平台控制使用 `git archive 89701ae`，不编辑当前分支代码或归档中的源码。
隔离 runner 放在不入库的 `data/cache/bench/ray-baselines/89701ae/driver.py`；
它复用原成功作业的资源包和 runtime_env，将作业约束到同一未重启 Ray 节点，
按原日志实际安装版本锁定依赖，EGL/GLES 也按原 SHA-256 选择。
外部 Node runner 只负责调用原 main、观察姿态 dispatch 和正常退出。
独立缓存与原始 Ray 报告收集到该目录下的本线作业 ID 子目录，原缓存与 Mac 报告不覆盖。
签名取自原 bench 函数的原始文本执行，不修改源码或覆盖缓存键。

```sh
source ~/.config/eagle-culling/env.sh
nice -n 15 python3 data/cache/bench/ray-baselines/89701ae/driver.py submit
nice -n 15 python3 data/cache/bench/ray-baselines/89701ae/driver.py status --id <本线基线作业ID>
nice -n 15 python3 data/cache/bench/ray-baselines/89701ae/driver.py collect --id <本线基线作业ID>
nice -n 15 node data/cache/bench/ray-baselines/89701ae/compare.mjs <本线基线作业ID>
nice -n 15 python3 data/cache/bench/ray-baselines/89701ae/driver.py audit
```

compare 只读取已核验缓存和报告，不运行图像/模型分析。输出同平台三项 delta、unchangedRows、
完整报告行和缓存内容差异数量，并逐行量化 Mac/Ray 主体 133 个关键点置信度差值及门槛距离。
缓存中的坐标已裁到 [0,1]，不能把裁后边界值反推成原始越界坐标。


本次基线 `w11-raybench-baseline-078c4c0f6147` 已真实冷算并验证 388 张图。
与合并后 Ray 作业比较，三项 delta 均 0，unchangedRows=true；368 行完整报告和
388 条完整缓存内容全部一致。同平台质量门槛通过，结论仅限本清单与受控环境。
历史 Mac/Ray 差异仍存在，具体数值库原因未唯一证明。
最终结果、真实命令与六行关键点置信度/阈值分析见
[testing.md 的同平台控制节](testing.md#w11合并前后-ray-同平台控制2026-10-11)，
完整逐点数据见 [公开快照](testing-data/w11-ray-same-platform.json)。
