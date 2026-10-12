# 姿态线程与全速模式（W23）

普通模式默认关闭全速；仅将 CPU 姿态会话默认线程数从 1 提到 3。
模型、规则、阈值、分组、排序算法及 provider 选择均不改动。
线程数和性能模式不进入 `POSE_CACHE_KEY` 或分析指纹的配置部分，已有线程 1 的有效缓存继续复用。
缓存内线程诊断表示原计算时的实际配置，不改写成当前请求的线程数。

## 设置

`EAGLE_POSE_THREADS` 使用现有 `localSetting`，环境变量优先于 `config/local.json`；
配置文件值必须是字符串，接受 `"1"`–`"8"`，默认 `"3"`。
普通模式有效线程数为 `min(配置值, floor(6 / 姿态 workers))`，workers 最多 2，总预算不超过 6。
只改变创建时首个 provider 为 CPU 的 session 的 `intra_op_num_threads`；
加速 provider 会话的线程选项、sequential/memory-pattern 策略和既有运行时回退行为保持。
CPU 创建回退会使用 CPU 线程设置；从加速会话 `set_providers` 的运行时回退保留原会话选项。
结果增加 `pose.diagnostics.intraOpThreads.{detector,pose}`，不影响缓存命中。

全速模式可用 `EAGLE_PERFORMANCE_MODE=turbo`，或本地配置：

```json
{"EAGLE_POSE_THREADS":"3","EAGLE_PERFORMANCE_MODE":"turbo"}
```

环境设置为空或 `normal` 表示普通模式。插件高级设置增加默认未勾选的
“全速模式（夜间整批，会占满 CPU）”，说明“适合电脑空闲时使用”。
勾选状态存入 localStorage 的 `eagle-culling-turbo`；开始分析提交顶层 `performanceMode:"normal"|"turbo"`。
显式请求模式优先于环境/配置默认值；服务端拒绝其它值（含 boolean/null/空字符串），返回 400，
且在保存请求检查点之前校验。续跑使用原请求保存的模式，run 元数据记录有效模式。
切换勾选只影响下一次分析；每次 run 使用独立 pipeline 实例和 AsyncLocalStorage，不修改共享环境变量。
配置文件修改后需重启服务，沿用现有 localSetting 加载方式。

## 并发、优先级及内存

| 项目 | 普通模式 | 全速默认（36 GB） |
|---|---|---|
| pipeline 指标 workers | 原调用并发，最多 2（插件启动为 1） | 4 |
| 人脸 / 姿态 workers | 原设置，默认随 pipeline，最多 2 | 4 |
| 原图解码 / focus workers | 原设置，默认 1，最多 2 | 最多 2，另受像素预算限制 |
| exiftool stay-open workers | 原设置，默认 1，最多 2 | 4 |
| CPU 姿态线程 | 默认 3，受 6 线程总预算限制 | 4 workers 按 `[2,2,1,1]` 分配 |

显式 `EAGLE_FACE_WORKERS`、`EAGLE_POSE_WORKERS`、`EAGLE_NATIVE_CONCURRENCY`、`EAGLE_EXIFTOOL_WORKERS`
仍可减少并发；全速 worker 上限还受 `floor(系统 RAM / 4 GiB)` 限制，至少 1、最多 4。
全速独立计算，不沿用服务 `--concurrency 1` 的普通模式限速。
模型阶段依然分开释放，取消/异常仍关闭自身模型池；前后台原图队列保留独立的串行背景约束。

普通模式保留原有优先级。全速子进程不加 `nice -n 15`；Windows 使用 NORMAL，普通模式仍为 BELOW_NORMAL。
POSIX 不能自行提高已继承的 nice/QoS，因此后台服务启动时的优先级仍会继承；
本轮受后台 QoS 限制的数字只能做同环境相对比较，主代理需前台复测绝对数字。

全速使用以下 **100 ms 采样保护**（不是虚拟地址空间的硬限制）：

- Node RSS 超过 3 GiB：取消当前 run，清理自身模型池。
- 人脸/姿态进程：每 worker RSS 上限 `3 GiB / 本池 workers`，超限退出 75。
- 原图解码/exiftool：守护包装器为每个子进程分配 `3 GiB / 全速 worker 上限`，超限终止并回收自身子进程。
- Windows 包装器使用 KILL_ON_JOB_CLOSE job，避免取消/超时留下孙进程；普通模式不引入该包装器。
- 现有原图像素限制及 128 MiB 子进程输出限制保留；保护触发会记录失败/不可用，不虚构模型输出。

各阶段并不同时常驻所有模型；这些预算不能相加当作实测峰值。
实测采样峰值由 macOS `proc_pidinfo` 对本线 Node 及其全部后代求 RSS 之和；目标间隔 100 ms，
实际间隔还包含进程枚举/读数和后台调度开销（报告保存采样次数及有效平均周期），
不包含其它应用，也不是去除共享页后的物理内存使用量。

## CPU 矩阵：同批 10 张，两轮交替

全部新数据在 `data/cache/w23-threads/probes/`，已有预览只读；每组启动新 Python 进程。
线程顺序第一轮 1→2→3→4（单 worker 后双 worker），第二轮反向（双 worker 后单 worker）。
每个线程的单/双 worker 两组共用一次 `/tmp/w23-heavy.lock`，单次远低于 10 分钟。
命令请求 nice 15，沙箱拒绝 setpriority，实查继承 nice 20。未清 OS 文件缓存。
内存为 macOS ru_maxrss；双 worker 报两个进程峰值之和，不是同时刻 RSS。

| workers | threads | 第一轮秒 | 第二轮秒 | 第一轮 MiB | 第二轮 MiB |
|---:|---:|---:|---:|---:|---:|
| 1 | 1 | 80.764 | 69.961 | 581.328 | 619.125 |
| 1 | 2 | 42.402 | 40.667 | 611.531 | 615.750 |
| 1 | 3 | 33.624 | 29.816 | 623.188 | 616.922 |
| 1 | 4 | 26.942 | 27.061 | 612.391 | 620.359 |
| 2 | 1 | 50.872 | 42.781 | 1060.063 | 1110.406 |
| 2 | 2 | 31.533 | 28.906 | 1055.313 | 1082.109 |
| 2 | 3 | 26.770 | 29.048 | 1045.891 | 1087.109 |
| 2 | 4 | 30.384 | 28.449 | 1044.047 | 1092.969 |

推荐默认 3：默认双 worker 总线程 6，平均 27.909 秒，相对线程 1 的平均 46.827 秒减少约 40.4%。
线程 4 在双 worker 时超过办公预算且没有更快；内存没有随线程数明显增加。

## 一致性口径

按主代理修正的标准，完整派生 signals（只剔除 persons 的 box/score/keypoints 原始字段）
和规则 verdicts 必须完全相同；原始坐标差另报最大值和所有坐标分量的平均绝对差。
比较器重算代理测量，并核对输入 SHA-256。派生 signals/verdicts 不同退出 1，不通过舍入隐藏差异。
初轮原始坐标最大差约 0.0026；原始浮点不逐字节相同，不能声称模型预测逐点相同。
矩阵 16 组全部通过：10 张、21 人、2793 关键点；原始坐标最大绝对差 0.002562533593166272，
各组平均绝对差最大 4.655611242191994e-7。全部派生 signals 和 verdicts 严格相同。

## 复现

所有模型推理/整批比较/完整回归都需共享锁，单次持锁最多 10 分钟；下面为锁内命令参数。
每次测量使用唯一标签与独立目录，勿覆盖旧报告或清已有缓存。

```sh
nice -n 15 env EAGLE_POSE_PROBE_ROOT=data/cache/w23-threads/probes python_worker/.venv/bin/python scripts/bench-pose-provider.py --threads 3 --workers 2 --label unique-w2-t3
nice -n 15 env EAGLE_POSE_PROBE_ROOT=data/cache/w23-threads/probes node scripts/compare-pose-probes.mjs matrix-r1-w1-t1 matrix-r1-w2-t3
nice -n 15 python3 scripts/bench-performance.py --mode old --label unique-old
nice -n 15 python3 scripts/bench-performance.py --mode normal --label unique-normal
nice -n 15 python3 scripts/bench-performance.py --mode turbo --label unique-turbo
nice -n 15 node scripts/compare-performance.mjs unique-old unique-normal unique-turbo
```

真实对照从已有 run 的 items 重新配对得到 38 单元，原片只读。每次使用 `e2e/<label>` 新缓存根，
分析/preview/embedding/focus 全部冷算，OS 文件缓存与字体缓存不清空。
为了避免沙箱每次重建 matplotlib 字体缓存导致原有 60 秒 worker 启动时限失败，
各模式共用本线可写 `data/cache/w23-threads/mpl`；该设置只在探测 harness，不更改生产默认行为。
Node 计时由真实 `RunProgress.stageDurationsMs` 记录；输入及配对原片 SHA-256 随报告保存。
`bench-performance.py` 的自身 Node 进程组最多运行 560 秒，超时只结束自身进程组。

Ray 使用 `source ~/.config/eagle-culling/env.sh`，最新 SUCCEEDED w11 作业复用原资产，
本线使用 `w23-threads-raybench-` 前缀、独立 `ray-control`、独立收集目录 `w23-threads/bench/analysis`。
任务环境显式 `EAGLE_POSE_THREADS=3`，预检及 388 条缓存均检查实际 pose 线程诊断。
代码/模型/输入/缓存/传输哈希全部核验；源码变化后的旧提交不作验收证据。
只上传原有合成基准资产，不上传真实单元或派生图。作业资源为 2 CPU、0 GPU、8 GiB，
绑定两 CPU 的既有策略不变，线程设置仍为 3；同时活动 Ray 作业最多 2。

## 验证进度

配置/模式/缓存复用/无效值前置校验测试 8/8，插件首页测试 12/12，姿态非模型定向测试 9/9，
worker 调度 2/2，exiftool 12/12，原图 4/4，HTTP heartbeat 1/1；
Python provider/session 10/10，内存 guard 3/3，Ray/探测配置测试 9/9。
完整回归与最终公开检查将在全部实测后运行一次。Windows 尚无真机验证。


## 真实 38 单元、两轮冷算

源 run 的 76 个真实文件（3FR / DNG / JPG / HEIC）重新配成 38 单元。
执行顺序为旧默认→新默认→全速，再反向全速→新默认→旧默认，每次独立缓存根。
六次输入 SHA-256、units、23 个完整 groups（包含 ranking 和 candidateSet）全部完全一致，差异列表为空。
每次 pose / face / TOPIQ / DINO 有效覆盖均为 38/38；模型及原图警告均为 0。
测量含真实 preview、指标/评分、embedding、人脸、姿态、原图 focus、分组与排序；
不含服务启动、Eagle 全库扫描、预先输入哈希和学习入库。冷算指分析缓存冷，不是 OS 文件缓存冷。

| 模式 / 轮次 | 指标秒 | embedding秒 | 人脸秒 | 姿态秒 | 原图focus秒 | 分组秒 | 排序秒 | 总秒 | 采样RSS峰值MiB |
|---|---:|---:|---:|---:|---:|---:|---:|---:|---:|
| 旧默认 / 1 | 105.404 | 19.542 | 12.079 | 207.685 | 51.731 | 0.022 | 0.068 | 396.534 | 1180.578 |
| 旧默认 / 2 | 108.412 | 18.214 | 12.444 | 220.619 | 58.251 | 0.022 | 0.055 | 418.023 | 1088.469 |
| 新默认 / 1 | 121.297 | 27.145 | 30.480 | 166.033 | 48.949 | 0.023 | 0.052 | 393.994 | 1130.094 |
| 新默认 / 2 | 129.495 | 21.964 | 13.141 | 169.224 | 53.189 | 0.013 | 0.039 | 387.082 | 1127.453 |
| 全速 / 1 | 122.606 | 24.899 | 12.736 | 170.221 | 24.017 | 0.009 | 0.032 | 354.524 | 1911.312 |
| 全速 / 2 | 95.274 | 17.359 | 8.917 | 126.738 | 23.246 | 0.025 | 0.036 | 271.600 | 2010.484 |

两轮平均总耗时：旧默认 407.279 秒，新默认 390.538 秒，全速 313.062 秒。
新默认比旧默认减少 4.1%，全速比旧默认减少 23.1%，比新默认减少 19.8%。
后台办公环境波动明显：新默认第一轮总耗时基本持平，全速两轮也有较大差异，不能用单轮推断前台绝对速度。
全速采样峰值最高 2010.484 MiB（约 1.963 GiB），没有触发保护；有效平均采样周期约 204–301 ms。
原始时间、采样次数、模型覆盖、警告及逐字段一致性在私有 e2e/summary.json、comparison.json。

## 改动文件与原因

| 文件 | 原因 |
|---|---|
| `src/core/performance-mode.js` | 模式/线程解析、请求隔离、6 核预算、worker/RSS 预算与启动命令 |
| `src/core/pose.js`、`python_worker/pose_runtime.py`、`pose_worker.py` | CPU 线程配置、实际诊断、保持 provider 与姿态缓存键；在排队前拒绝无效线程配置 |
| `src/core/faces.js`、`python_worker/face_worker.py`、`memory_guard.py` | worker 环境、全速 Windows NORMAL、可选 RSS 守护及 Windows 子进程生命周期 |
| `src/core/exiftool-pool.js`、`native-image.js`、`focus.js` | 按模式提高并发、独立 exiftool 池、全速子进程预算及取消清理 |
| `src/core/pipeline.js` | 最多 4 的请求级并发、Node RSS 取消保护、保存姿态诊断，改动集中在初始化/池设置 |
| `src/server/runs-routes.js`、`src/plugin/index.html`、`start-view.js` | 服务校验/保存/转发模式，中文勾选与本地记忆 |
| `scripts/bench-pose-provider.py`、`compare-pose-probes.mjs` | 独立矩阵、CPU 专用实验线程、完整派生比较、原始最大/平均坐标差 |
| `scripts/bench-performance.py`、`bench-performance.mjs`、`compare-performance.mjs` | 本机真实冷算、进程树采样、逐字段结果与输入哈希比较 |
| `scripts/bench-ray.py`、`bench.mjs` | 本线独立提交/收集、线程传播与逐缓存诊断核对；策略源码进入 bench 签名 |
| `test/performance-mode.test.js`、`test/start-ux.test.js`、`test/native-image.test.js` | 解析、普通上限、请求隔离、线程 1 缓存复用、无效配置、UI 记忆/请求传递、RSS 取消恢复与大图内存预算 |
| `python_worker/test_pose_runtime.py`、`test_pose_worker.py`、`test_memory_guard.py` | 范围/CPU 生效/provider 保持及守护回收 |
| `scripts/test_bench_pose_provider.py`、`test_bench_ray.py` | 探测目录、CPU 覆盖、Ray 环境和缓存线程证明 |
| `docs/pose-provider.md`、`performance-mode.md` | 配置说明、真实矩阵/冷算数字、限制和验收证据 |

没有修改 `package.json`、`package-lock.json`、requirements、模型、规则或排序权重；
共享 docs/contracts.md / todo.md / testing.md 未改。没有 Git 提交、Eagle 写回或原片修改。
Windows 真机尚未验证；本线限 macOS 后台同环境的相对数据、配置测试和 Ray CPU 质量门槛。
前台 old/normal 数字由主代理提供，修复后 turbo 前台复测仍由主代理执行。

## 最终验收与前台反馈（2026-10-12）

本次修复前源码（增加无效线程配置的排队前校验后）的 Ray 作业
`w23-threads-raybench-e0caf1022bc6` SUCCEEDED，761.307 秒，实际线程请求为 3，
本地源码 SHA-256 与提交身份逐文件匹配。该作业已在本地 collect/cache-only 验收（见下文）。

此前源码的 `w23-threads-raybench-349115dfa09c` 已 collect 388 条真实冷算缓存，
逐条线程诊断为 3，cache-only 显示 0/388 uncached。
与指定 `2026-10-12T04-39-19-060Z/report.json` 比较：
偏好 354/368、严重 gate 101/112、源图误淘汰 1/20；三项 delta=0，unchangedRows=true。
报告在 `w23-threads/bench/reports/2026-10-12T06-14-43-001Z/report.json`。
这项证明属于排队前配置校验补丁之前的源码，不冒充最终源码验收。

最新已收集 `e0caf1022bc6` 作业的 388 条缓存；修改前在 `/tmp/w23-e0-source`
冻结该提交逐文件源码，collect 原有源码/模型/签名 SHA 校验全部通过。
随后在当前源码执行 cache-only，0/388 uncached，三项 delta=0、unchangedRows=true。
报告：`data/cache/w23-threads/bench/reports/2026-10-12T07-37-42-368Z/report.json`。
这项 Ray 冷算发生在本次 focus 调度修复之前；本次没有改变姿态/评分/规则逻辑；随后格式换行改变了按源码字节计算的 bench 签名，
不将它表述为修复后 focus 的远端验收。真实照片只在本机计算。

主代理提供的前台实测（38 单元、独立冷缓存，非本线后台测量）：

| 模式 | 总秒 | pose 秒 | focus 秒 | Node RSS MiB |
|---|---:|---:|---:|---:|
| old | 77 | 35.1 | 17.3 | 2341 |
| normal | 60 | 18.5 | 16.7 | 2183 |
| 修复前 turbo | 失败 | — | — | 超过 3072 保护阈值 |

失败栈是内存取消原因的创建位置；原基准脚本顶层 await 没有捕获分析拒绝，导致 Node 非正常退出。
生产路由已有 run 失败持久化 catch。现在 pipeline 的异步边界在 finally 清除守护 timer，
基准脚本捕获失败、写 `failure.json` 和中文原因，并按失败退出；不安装全局 rejection 吞错处理器。
新增独立子进程测试以 `--unhandled-rejections=strict` 模拟定时 RSS 超限，真实原图任务及排队全部收尾，
run 保存 failed/中文原因，同一服务可再完成新 run，unhandledRejection 为 0。

全速原图最多 2 路；按单元所有成员的最大像素数 ×16 bytes 估算临时工作集，
合计预留预算 1536 MiB。100 MP 或未知尺寸占满预算并串行，小图可 2 路。
该估算不是操作系统硬 RSS 限制；超 3 GiB 仍优雅取消本次分析。
普通模式的解码上限及调度不变；人脸/姿态/exiftool 和其它流水线阶段仍可 4 路。
38 单元有 4 组 100 MP HEIC/3FR（成员最大 105255168 像素），这是值得预留整路预算的实际输入。

普通模式 RSS 来源：`metrics.js` 将 Sharp/libvips 缓存设为 128 MiB、0 files、100 items；
该配置不能单独解释 2.2–2.3 GiB 的进程 RSS。
focus 当前先编码全分辨率 JPEG，再按每只眼睛/人脸解码裁切；全图解码、旋转和编码临时工作集、
原生分配器保留页与 JS JPEG buffer 都会计入 RSS。缓存上限不是进程内存上限。
本轮保留编码、裁切和像素算法，避免修改输出；没有声称仅凭 RSS 已分解各分配器占用。
基准新增每阶段 `process.memoryUsage()`（RSS/heap/external/arrayBuffers）和 `sharp.cache()` 诊断，
修复后的后台冷算数据见下方追加验收结果。
normal 后台诊断的 RSS 最高发生在 metrics（619.11 MiB），focus 阶段最高 315.72 MiB；
对应峰值的 heapUsed 40.24/11.72 MiB、external 173.10/5.98 MiB、Sharp memory current 0/27 MiB。
后台没有复现主代理前台的 2.2–2.3 GiB，因此无法用此次采样定量归因前台的高 RSS；
这里只确认代码存在完整原图中间编码/裁切工作集，并记录诊断的局限，不贸然改变默认像素路径。

定向验证：模式/线程/RSS/服务恢复 10/10，native（含大图预算及取消后复用）5/5。
最终锁内完整 Node 回归 483/483（203.733 秒）、Python 10/10 均通过。
日志 `data/cache/w23-threads/final-node-regression.log` 与 `final-python-regression.log`。
修复后后台冷算已完成；旧完整回归数据不作为当前源码验证。
修复后 normal 冷算 324.529 秒，进程树峰值 1102.359 MiB、Node 峰值 614.172 MiB，
pose 138.292 秒、focus 53.190 秒；与此前六次的 38 units / 23 完整 groups / 原片 SHA 逐字段相同。

按原锁协议执行以下命令，collect 与 cache-only 同一锁周期；完整回归单独一个锁周期。
各周期最多 10 分钟，超时只结束自身进程组。

```sh
# 从 w23-threads 工作区执行，保存位置以便返回：
W23_THREADS_WORKTREE="$PWD"
# 冻结的已提交源码（逐文件 SHA 必须匹配，不可在修复后源码强行 collect）：
nice -n 15 sh -c 'cd /tmp/w23-e0-source && . ~/.config/eagle-culling/env.sh && EAGLE_POSE_THREADS=3 python3 scripts/bench-ray.py collect --id w23-threads-raybench-e0caf1022bc6'
# cache-only 同样使用该冻结源码签名；此前报告生成时格式修复尚未发生。
cd /tmp/w23-e0-source
nice -n 15 env EAGLE_BENCH_ROOT=data/cache/w23-threads/bench EAGLE_PYTHON=python_worker/.venv/bin/python EAGLE_POSE_PROVIDER=CPUExecutionProvider EAGLE_POSE_THREADS=3 EAGLE_SHARP_CONCURRENCY=1 EAGLE_PERFORMANCE_MODE=normal EAGLE_BENCH_CACHE_ONLY=1 node --max-old-space-size=2048 scripts/bench.mjs --compare data/cache/bench/reports/2026-10-12T04-39-19-060Z/report.json
# 回到 w23-threads 工作区运行最终回归：
cd "$W23_THREADS_WORKTREE"
nice -n 15 node --max-old-space-size=2048 --test --test-concurrency=1 --test-skip-pattern='fixture face detection recall|fixture grouping reaches'
# python_worker 目录内：
nice -n 15 .venv/bin/python -m unittest test_pose_runtime test_pose_worker
```


### 修复后真实冷算（后台，独立缓存）

| 模式/label | 总秒 | pose 秒 | focus 秒 | Node 峰值 MiB | 同时进程树峰值 MiB |
|---|---:|---:|---:|---:|---:|
| normal / fix-r1-normal | 324.529 | 138.292 | 53.190 | 614.172 | 1102.359 |
| turbo / fix-r1-turbo | 315.193 | 143.982 | 40.378 | 781.688 | 1815.469 |
| turbo / fix-r2-turbo | 350.758 | 173.894 | 41.247 | 710.359 | 1884.438 |

第一组后台相对 normal：turbo 总耗时减少 2.9%，focus 减少 24.1%；姿态阶段没有加快。
这些数字受后台 QoS/办公负载影响，不能与主代理前台 77/60 秒混算。
旧 turbo 双轮进程树峰值为 1911.312 / 2010.484 MiB，修复后第一轮为 1815.469 MiB；
不同时间段的变化不能单独归因于本补丁。新的前台峰值需主代理复测。

新增 normal/turbo 与此前六次冷算的原片 SHA、38 units、23 完整 groups（含排名）逐字段一致。
normal 线程 3 的新旧 focus 全字段完全相同。
normal/turbo 额外 focus 对比有 7 个单元诊断/坐标不同：4 个仅子进程 nice 权限提示文本不同，
3 个仅归一化 eye ROI 坐标微差（最大绝对差 8.329348666347158e-8）；原生整数裁切像素、
清晰度数值、AF 状态、flags、verdicts 完全相同。逐项原始差异在私有
`data/cache/w23-threads/e2e/fix-focus-differences.json`，未修改或舍入它们来制造一致。
第二轮 turbo 同样未触发保护，无 run 警告。全部九次冷算 38 units / 23 完整 groups / 排名 / 输入 SHA 相同。
修复后两轮 turbo 总耗时波动 315.193–350.758 秒，相对新增 normal 324.529 秒并非稳定加快；
focus 两轮为 40.378 / 41.247 秒，相对 normal 的 53.190 秒分别减少 24.1% / 22.5%。
没有依据声称后台 turbo 总耗时必然更快；两轮都完成且 Node RSS 远低于 3 GiB，是此次内存修复的验收重点。
逐阶段与采样原始数据：`e2e/fix-summary.json`，最终九次逐字段比较：`e2e/comparison.json`。

复现（每行分别套用本机共享锁，单次 570 秒强制上限）：

```sh
nice -n 15 python3 /tmp/w23-locked.py python3 scripts/bench-performance.py --mode normal --label fix-r1-normal
nice -n 15 python3 /tmp/w23-locked.py python3 scripts/bench-performance.py --mode turbo --label fix-r1-turbo
nice -n 15 python3 /tmp/w23-locked.py python3 scripts/bench-performance.py --mode turbo --label fix-r2-turbo
nice -n 15 node scripts/compare-performance.mjs r1-old-font r2-old-font r1-normal-font r2-normal-font r1-turbo-font r2-turbo-font fix-r1-normal fix-r1-turbo fix-r2-turbo
```

上述 labels 已使用，重新复测必须换成新的 label；不可删除旧缓存来伪造冷算。
`/tmp/w23-locked.py` 是本机临时包装：原子 mkdir、owner token、570 秒限时、仅杀自身进程组、
finally 按 inode/owner 验证释放锁；也可以使用本任务约定的 mkdir/trap 协议。

## 修复后前台复测（主代理，2026-10-12）

38 单元、独立冷缓存，前台运行（非后台 QoS），`python3 scripts/bench-performance.py --mode <mode> --label <label>`：

| 模式 | 总耗时 | 进程树峰值 RSS | Node 峰值 RSS |
|---|---:|---:|---:|
| old（修改前，单线程姿态） | 77 s | — | 2.3 GiB |
| normal（新默认，姿态 3 线程） | 58.5 s | 2.18 GiB | 2.10 GiB |
| turbo（修复后） | 54.1 s | 3.15 GiB | 2.41 GiB |

`node scripts/compare-performance.mjs fg-old-152659 fg-normal-152818 fg-fix-normal fg-fix-turbo` 报告 `identical: true`：四次前台冷算的分组、排序和逐字段结果完全一致。
后台沙箱中的冷算（`fix-r1-*`）与前台在两组的质量分上不同，四次前台之间没有差异，属于沙箱环境差异，不是模式差异。
结论：新默认比旧版快约 24%；全速模式只再快约 8%，内存峰值高约 1 GiB，因此保持默认关闭，仅建议电脑空闲时整批使用。
