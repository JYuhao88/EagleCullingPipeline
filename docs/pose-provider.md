# Mac 姿态模型启动（W22）

Mac 未设置 `EAGLE_POSE_PROVIDER` 时使用 `CPUExecutionProvider`。显式覆盖仍有效；
Windows/Linux 的原 provider 顺序、DirectML session 选项和 CPU 回退路径保持。
没有修改模型、预处理、signals、规则、阈值、分组或排序。

## 决策和缓存

本机 ORT CoreML 在 YOLOX 首张推理出现输出维度不匹配（静态输出与推断输出的 rank 不同），
不能完成有效的 CoreML 推理，随后只能回退 CPU。因此没有启用 CoreML 编译缓存，
没有向模型目录写编译文件。`ModelCacheDirectory` 的冷/热启动效果未验证。

CPU 模型创建已低于一秒，没有在人脸阶段预热姿态；两类模型继续分阶段释放，
取消/异常仍由 pipeline 的 `finally` 关闭池。10 张预览上两个 CPU worker 明显快于一个，
且进程峰值之和低于 3 GiB，保留默认随 pipeline 并发、最多 2；
`EAGLE_POSE_WORKERS=1` 可减少常驻模型内存。

Mac 默认 `POSE_CACHE_KEY` 从 `auto` 改为明确的 `CPUExecutionProvider`，旧 auto 分析指纹不命中。
已有显式 CPU 键保持；模型模式和模型路径仍在键中。
pipeline 读取缓存/检查点时，显式 provider（包括 Mac 默认 CPU）必须与实际 detector、pose
两者的首个 provider 一致；缺失 provider 列表、发生回退或 provider 不匹配会删除旧姿态/signals，
重新测量。检查点即使已到 pose/focus，也会退回姿态之前；失败不保留旧 signals。
Windows/Linux 的 auto 配置键保持，实际 provider 列表继续作为诊断持久化。
provider 列表本身不证明所有算子都在该加速器执行。

bench 与 Windows bench 签名新增 `pose_runtime.py`，Ray 打包和源码哈希核对也包含该文件。
`EAGLE_BENCH_ROOT` 可隔离 bench 缓存与报告；本轮新增数据全部位于
`data/cache/pose-provider/`，已有预览、原片和旧 bench 缓存不改写。

## 本机实测

`scripts/bench-pose-provider.py` 固定使用已有 10 张预览、同一份私有 SHA-256 清单。
每次启动新 Python 进程，不清系统文件缓存；“重启”不表示清空 OS 缓存。
内存来自 macOS `getrusage(RUSAGE_SELF).ru_maxrss`；两个 worker 报峰值之和，
不是同时刻 RSS。进程有 3 GiB 总预算保护和 180 秒单 worker 时限。
所有重负载持有 `/tmp/w22-heavy.lock`；命令请求 nice 15，沙箱拒绝调整时继承 nice 20。

| 路径 | detector / pose 创建（秒） | 进程 ready（秒） | 首张推理（秒） | 后续 9 张平均（秒） | 10 张总耗时（秒） | 进程峰值（MiB） |
|---|---:|---:|---:|---:|---:|---:|
| CPU，1 worker | 0.173 / 0.361 | 1.303 | 5.724 | 7.341 | 73.545 | 620.563 |
| CPU，1 worker 重启 | 0.383 / 0.460 | 2.136 | 5.540 | 7.367 | 74.436 | 605.672 |
| CPU，2 worker | 0.155 / 0.329；0.155 / 0.326 | 1.496；1.500 | 5.553；4.615 | 分 worker 为 5.730；9.077 | 42.957 | 1201.734（和） |
| 请求 CoreML，失败后 CPU | 4.178 / 6.164 | 11.454 | 13.386（含失败及回退） | 7.472（CPU） | 92.577 | 1841.406 |

CoreML 首张失败调用 6.928 秒，CPU 会话重建 0.640 秒，再进行 CPU 推理。
从进程开始到首张完成：该 CoreML 请求约 24.840 秒，直接 CPU 约 7.027 秒。
成功采集的一轮没有复现完整一分钟加载；此前一次 CoreML 探测达到内存保护条件退出 75，
没有完整会话计时，不将其算作有效推理结果。不能据此断言所有等待都是 CoreML 编译。
样本共有 21 个人体，单张人数不同，后续均值不能当作同一张图的稳态速度。

人脸参考：首次模型创建 0.459 秒，探测总耗时 52.989 秒（该轮含关闭），峰值 160.750 MiB。
复测显式分离 import/ready/close：import 58.540 秒，模型创建 0.570 秒，ready 59.110 秒，
含关闭总耗时 60.042 秒，峰值 156.672 MiB。

人脸导入复核：`mediapipe.tasks.python.vision` 经 `drawing_utils` 导入 `matplotlib.pyplot`。
matplotlib 配置目录不可写时，每次启动都重建字体缓存，上面的 58 秒来自该测量环境。
本机复测：空的 `MPLCONFIGDIR` 首次导入 13.73 秒（打印 building the font cache），
同目录第二次 0.48 秒；使用已有用户字体缓存时 0.77 秒。
用户机器只在首次安装或 matplotlib 升级后付出一次，不是每次分析的等待。

CPU 单 worker、双 worker、重启后，以及 CoreML 失败回退 CPU 后，四组输出逐张比较：
10 张、21 个人体、2793 个关键点，坐标和置信度最大绝对差均为 0；
完整 persons、包含重新计算代理测量的 signals、规则 verdicts 均完全一致。
这不是有效 CoreML 与 CPU 的对照，因为 CoreML 没有完成检测。
比较统计在独立缓存中的 `compare-*.json`，原始预测仅本机私有保存。

另用生产 Node 池取消 provider 覆盖，连续推理同一张预览三次：实际 detector/pose 均为 CPU，
单张模型推理分别 5.511、5.234、5.591 秒，后两次平均 5.413 秒；三次总耗时
18.765 秒（包括启动和代理后处理）。persons 均与独立 CPU 探测逐点完全一致。
该对照比不同人数的 10 张均值更适合观察单张稳态；原始统计在私有 `default-steady.json`。

## 验证

完整 Node 回归 454 pass / 0 fail / 1 skip，455 项，153.889 秒。
该次使用系统 Python，本地模型 smoke 因依赖/解释器检查 skip；另用项目 Python 做真实 smoke，
1/1 通过、0 skip，10.895 秒；实际空白图未虚构人体。默认 provider 的真实预览对照也通过。
Python provider/session unittest 8/8；探测目录与 Ray 打包/结果收集 unittest 5/5。
Node 定向 provider/缓存/worker 配置 9/9，bench 目录配置 1/1。
公开检查 503 文件、0 命中，`git diff --check` 通过。
完整 Node 后仅补 Windows bench 的策略文件签名输入，另跑 `node --check` 通过；
没有重复完整回归，也没有在 Windows 执行该脚本。

Ray 作业 `w22-pose-raybench-1663ffceb26e` SUCCEEDED，737.112 秒，预留 2 CPU、0 GPU、8 GiB。
388 张合成图全部真实冷算；源码、五个模型、传输完整性及逐条缓存 SHA-256 核对通过，
仅收集无模型警告、有效人脸和 signals 的完整 388 条结果。本线作业终态，自身活动作业 0。
签名由当前代码生成：`11dd9bbd875061fb0ad6818b33d75709eef8d66f8c2bd3fe4f33d344a5586125`。

本机随后真实运行 cache-only compare（0/388 uncached，仍执行 TOPIQ 推理预检），
新报告位于 `data/cache/pose-provider/bench/reports/2026-10-12T03-57-37-037Z/report.json`。
基线为任务前最新同清单报告 `data/cache/bench/reports/2026-10-12T02-17-07-342Z/report.json`。
两者清单相同、368 行 `unchangedRows=true`，没有复制旧模型结果或修改签名追平：

| 指标 | 实测 | delta |
|---|---:|---:|
| 偏好准确率 | 354/368 = 96.195652% | 0 |
| 严重 gate | 101/112 = 90.178571% | 0 |
| 源图误淘汰 | 1/20 = 5% | 0 |

Ray 提交/收集的私有 driver 在原 `bench-ray.py` 上仅隔离本线作业前缀、控制文件和收集目录，
提交前串行回归并等待作业终态才释放锁。上传的分析代码均来自当前 worktree 原文件，
收集重新核对源码和模型，没有改 artifact 或旧缓存。
旧报告/预览均只读，新增缓存和报告仅在 `pose-provider/`。
验收限本合成清单和本机 10 张预览；T-triage 不可用、完整 Eagle UI 阶段前后计时未验证。

```sh
nice -n 15 env EAGLE_PYTHON=python3 node --max-old-space-size=2048 --test --test-concurrency=1 --test-skip-pattern='fixture face detection recall|fixture grouping reaches'
nice -n 15 python_worker/.venv/bin/python -m unittest discover -s python_worker -p 'test_pose*.py' -v
nice -n 15 python3 -m unittest scripts/test_bench_pose_provider.py scripts/test_bench_ray.py -v
nice -n 15 env EAGLE_BENCH_ROOT=data/cache/pose-provider/bench EAGLE_PYTHON=python_worker/.venv/bin/python EAGLE_POSE_PROVIDER=CPUExecutionProvider EAGLE_BENCH_CACHE_ONLY=1 node --max-old-space-size=2048 scripts/bench.mjs --compare data/cache/bench/reports/2026-10-12T02-17-07-342Z/report.json
nice -n 15 env EAGLE_PYTHON=python_worker/.venv/bin/python node --test --test-concurrency=1 --test-name-pattern='local pose worker JSONL smoke' test/pose.test.js
nice -n 15 node --check scripts/windows-bench.mjs
nice -n 15 node scripts/check-public-release.mjs
nice -n 15 git diff --check
```

完整 Node 命令由持锁的私有 Ray driver 在提交前展开执行，输出保存在私有
`node-regression.log`；上述为同一参数和环境的独立执行形式。

## 改动文件

| 文件 | 原因 |
|---|---|
| `python_worker/pose_worker.py`、`pose_runtime.py` | Mac 默认 CPU，保持其它平台顺序及 session 选项 |
| `src/core/pose.js`、`pipeline.js` | provider 缓存键、实际 provider 校验、worker 配置；检查点失效处理 |
| `scripts/bench.mjs`、`bench-ray.py`、`windows-bench.mjs` | 隔离缓存根目录；策略文件进入签名、打包和哈希校验；Windows bench 仅补签名输入 |
| `scripts/bench-pose-provider.py`、`compare-pose-probes.mjs` | 有界实测、私有输出、逐点和下游测量比较 |
| `test/pose.test.js`、`bench-config.test.js` | provider、缓存和 worker 配置覆盖 |
| `python_worker/test_pose_runtime.py`、`test_pose_worker.py`、`scripts/test_bench_pose_provider.py` | Python 策略、session 选项、无新增编译目录及探测目录覆盖 |
| `docs/contracts.md`、`testing.md`、`pose-provider.md` | 合同和真实验证证据 |

## 复现命令

重负载统一包在以下锁中；不启动 HTTP 服务、不访问 Eagle、不写回库。

```sh
nice -n 15 sh -c 'until mkdir /tmp/w22-heavy.lock 2>/dev/null; do sleep 15; done;
trap "rmdir /tmp/w22-heavy.lock" EXIT;
python_worker/.venv/bin/python scripts/bench-pose-provider.py --provider CPUExecutionProvider --label cpu-one;
python_worker/.venv/bin/python scripts/bench-pose-provider.py --provider CPUExecutionProvider --workers 2 --label cpu-two;
python_worker/.venv/bin/python scripts/bench-pose-provider.py --provider CoreMLExecutionProvider --label coreml-bounded;
python_worker/.venv/bin/python scripts/bench-pose-provider.py --face --label face-start'
```

原始预测、错误日志、输入路径和图片哈希仅在不入库的 `pose-provider/` 中。
CPU 与 CoreML 回退后的结果可以比较；有效 CoreML 与 CPU 的数值一致性未完成，
因为 CoreML 检测失败。**未在 Windows 验证**；仅有配置策略的单元测试。
