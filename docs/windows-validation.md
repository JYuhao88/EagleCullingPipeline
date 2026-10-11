# Windows 实机检验

执行分支基于 `ab41663`。全部真实图片、预览、联系表、run 与逐图缓存留在 Windows。
本文与回传统计不包含库路径、照片文件名或用户名；库用 `<library>` 表示，工作根目录用 `<validation-root>`。
不使用 Ray、AIHub，不 push。Mac 只编辑、回归和同步；所有本机入口使用 `nice -n 15`，
沙箱提示无法调整 setpriority；Node heap 上限 2048 MiB。未在Mac冷跑bench或全库。一次收尾回归继承Python配置而进入姿态冷启动冒烟入口，已中止，
日志不计通过；最终回归显式EAGLE_PYTHON=python3，该模型冒烟跳过，实机模型验收在Windows。

## 1. 跨平台可运行

已有 bundle clone 和 npm ci 产物经过本轮盘点；npm 日志记录安装 26 包成功。
Windows Node v24.14.1；用户目录官方 Python 3.12.10，虚拟环境位于仓库 `python_worker/.venv`。
不改系统 PATH。`rtmlib` 会拉入 CPU 版 ONNX Runtime，与 DirectML 共用 Python 包名；
安装后卸载两个 ORT distribution，再安装 `onnxruntime-directml==1.24.4`，实测 provider
为 `DmlExecutionProvider, CPUExecutionProvider`。不能仅凭 pip 成功判定 GPU 可用。

跨平台修复包含 Windows venv 路径、原生解码避开 Unix nice、doctor 实际检查 Python 与 MediaPipe import、
Node URL 转文件路径、测试通过 EAGLE_PYTHON 选择 Python、LF checkout、CRLF 行长识别、
独占文件锁的 Windows 实现、传输清单使用 POSIX 相对路径，以及 Python 子进程避免 Unix nice。
POSIX worker 的权限断言只在支持该权限语义的平台测试；不改变 Linux 权限契约。
人脸 unittest 原预期仍针对旧 5 区域策略，已对齐当前 19 区域策略，没有改检测器。
HEIC 在 macOS 仍用 sips；Windows 走 sharp，RAW 优先配对/内嵌预览，失败可用 rawpy 或 Eagle 缩略图。
Windows 实片覆盖见第4节；配对单元成功不等于每种格式直接解码成功。

实际回归命令（Windows 在低优先级、CIM 脱离 SSH 的 PowerShell 任务内执行）：

```powershell
$env:PYTHONUTF8='1'
$env:EAGLE_PYTHON=(Resolve-Path python_worker/.venv/Scripts/python.exe).Path
node --max-old-space-size=2048 --test --test-concurrency=1 --test-skip-pattern='fixture face detection recall|fixture grouping reaches'
& $env:EAGLE_PYTHON -m unittest discover -s python_worker -p 'test*.py'
```

Windows 初轮359 pass /9 fail /2 skip；修复后最新完整Node **379/379通过**，25.163秒。
Mac收尾指定命令显式EAGLE_PYTHON=python3：**378通过/0失败/1跳过**，115.868秒；
跳过本地姿态模型冒烟，日志 `/tmp/w12-mac-final-regression-safe.log`。中断终态补充后的Windows收尾 **379/379通过**，24.575秒，
日志 `<validation-root>/logs/node-tests-status.log`。
Python人脸unittest3/3、共享锁1/1、上传18测试通过（Windows跳过1项POSIX权限断言）。
安装便携ExifTool后再跑 `node src/cli.js doctor`，设置 `EAGLE_API_PORT=43136` 走只读代理，
实际ok=true且所有checks=true，包含exiftool；sips=true在Windows表示该平台不要求sips。

## 2. GPU 与跨平台数值

Node 实际 `listSupportedBackends()` 为 cpu/dml/webgpu，使用 DirectML。
scorer 与 DINO 增加显式 provider 环境变量，明确指定不可用 provider 时保留失败证据；
scorer 不可用仍 quality=null。Python scorer 同样支持显式 provider，并核对 session providers。
388 张合成图从 Mac 既有 synthetic 目录同步，每张 SHA-256 对清单验证。
`scripts/windows-bench.mjs cpu|dml <baseline.json>` 原子保存逐图 metrics/faces/raw pose/signals/verdicts/timing，
续跑跳过同签名已完成项；provider 各自隔离。Mac 基线为同清单报告 `2026-10-11T07-32-57-080Z`。
CPU 与 DirectML 均已完成 388 张：逐图冷计算累计分别 506.44 秒、261.15 秒，
约 **0.766 / 1.486 张每秒，1.94 倍**。这些是合成逐图计算时间，不是实库完整流水线吞吐。
两者准确率 **354/368 = 0.9619565**，严重问题门槛 **101/112 = 0.9017857**，
源图误淘汰 **1/20 = 0.05**。相对 Mac 基线准确率低 **1/368**，其余两项相同；
变化为 horizon-tilt 对，与 w11 Linux 的汇总指标相同。没有为了消除差异调整门槛。
逐行数值和 Python scorer 已完成，详见下方匹配诊断补充。合成阶段采样峰值如下（全设备显存包含桌面及其他应用，
不是进程独占显存；约 1 秒采样可能漏瞬时峰值）：

| 模式 | 采样数 | 全设备显存峰值 MiB | Node working set 峰值 MiB | GPU 利用率峰值 |
| --- | ---: | ---: | ---: | ---: |
| CPU | 478 | 2777 | 752.09 | 8% |
| DirectML | 243 | 3493 | 1168.57 | 88% |
DirectML provider 成功创建不等于所有算子均在 GPU；报告将保留 CPU fallback 的限制。

## 3. Eagle 只读端到端与紧急修复

用户实际操作暴露两个问题：Windows rename 覆盖遇到临时占用时 EPERM；测试和用户共用
43125 的单分析槽。第一次全库分析失败，第二次在 127/3901 单元被取消。
此前测试重启共用服务属于隔离错误；已停止该做法。

共享 `replaceFile` 保留原子替换语义，Windows 仅对 EPERM/EBUSY/EACCES 最多尝试 10 次，
退避 50/100/200/400/800/1000/1000/1000/1000 ms；最终仍失败保留原始错误。
不删除旧目标、不用非原子复制替代。Mac/Linux 一次 rename，行为不变。
接入 results-v2、run.json、结果 manifest、决定、特征/学习 JSON、偏好配置/快照、
规则配置、预览及原生 crop 缓存共 9 处。事件/检查点的 OffsetJournal 为追加存储，没有 rename 替换。
模拟暂时占用后成功、持续失败、POSIX 与非暂时错误的测试通过。

新增 `GET /runs/status` 只读 run metadata，不读取大结果；409 返回当前 run 和进度。
主页连接/重开后找回进行中、失败或中断的 run；进行中先展示进度，完成才读审阅结果；失去活动进程的旧任务在列表与单任务GET均为中断，
手动打开也停止轮询，不读取缺失的大结果。
忙碌时提示已有分析并展示 X/Y；保存失败提示文件占用及稍后重试，不展示原片路径。
全库分析只取库路径，不读取 Eagle 选中项；选中项请求只执行一次，并设 10 秒超时。
没有改变主页布局，方便与 w13-ux 合并这些修复。
大库扫描也移到后台：POST 先返回 202 与 run ID，再扫描并报告进度；
扫描中可读取状态或取消，不再等库存读取完才登记任务。新增阻塞扫描测试验证这一点。

维护前写入 Windows PROGRESS，并两次确认没有 running 用户 run 后才更新服务。
**用户服务 127.0.0.1:43125，Node PID 32596，数据 `<validation-root>/repo/data/windows-user`**。
原失败/取消 run 与可复用缓存保留；未复制自动化学习决定到用户学习目录。
**测试期间服务 127.0.0.1:43135，数据 `<validation-root>/repo/data/windows-test`**，
代理 43136，插件测试页 43137。自动化不取消、不重启、不占用用户服务上的 run。

Windows Edge 恢复测试 6 个场景通过：用户服务 GET-only 连接、模拟 busy/409、
进行中重开、连续两次网络失败后恢复、EPERM 失败后重开、中断后提示。用户服务 POST **0**，浏览器运行时错误 **0**。
忙碌/失败响应在 Playwright 中拦截模拟；没有为复现故障在用户服务上创建分析。
证据留在 `<validation-root>/qa/recovery/acceptance.json` 与截图目录。早期一次主页截图捕获失败单独记录；最终复验截图错误0，
状态/交互断言通过，不声称该截图成功。连续网络失败继续重试，取消/切换停止旧轮询。

此前哈希脚本比较对象引用而误报失败；修正后399/399一致，原始失败日志保留。
自动化决定只证明审阅链路，不作为真实偏好标签。
独立测试端口完整 E2E **通过**：399 原片、203 单元、43 组；冷缓存分析墙钟 **299.826 秒**，
约 **1.33 原片/秒（0.677 单元/秒）**。TOPIQ 缺失 **0**，浏览器错误 **0**；
保留/淘汰+理由、学习请求、1:1（297×139）、JSON/CSV、399 原片哈希核对均通过。
测试代理 **8 GET /api/v2/library/info，library/switch 0，其他写请求 0，拒绝 0**；原库核实还原 true。
无图统计见 `testing-data/windows-e2e.json`；截图/报告留在 `<validation-root>/qa/plugin-e2e-isolated/`。
Eagle 原生宿主中的用户手动确认仍待用户实际反馈，不能用 Edge 代替该结论。

Eagle 请求经只读代理；授权例外仅为安全配置白名单的 `POST /api/library/switch`，
单独记录目标哈希与次数。其他写请求禁止，验证服务屏蔽 apply/revert。
新服务请求先追加审计 JSONL，审计写失败则拒绝转发；重启复用审计日志。
此前共用服务重启前后的计数分阶段记录，不能声称是一份不中断的历史日志。
当前测试使用原活动库，没有必要切库；测试结束仍核实原库。

用户现在可在 Eagle 重开已导入插件 → 连接 `http://127.0.0.1:43125` →
先选安全文件夹的几百张照片 → 分析所选 → 审阅并填理由 → 学习面板 → 1:1/眼部 → 导出报告。
不要使用写回。用户服务保持运行；用户自愿停止时只执行 `Stop-Process -Id 32596`。
测试过程中不会替用户执行该命令。

## 4. 大库耗时预期与真实照片规模

紧急修复后的独立样本实测为 399 原片/203 单元，完整冷分析 299.826 秒。
以下阶段时间是 1 秒轮询样本计数，**不是精确阶段墙钟**；轮询请求开销和过短阶段未完全归属，
各阶段合计 262 秒，比实际总墙钟少 37.826 秒。不能把 metrics 吞吐当作完整流水线吞吐。

| 阶段 | 样本采样秒数 | 按 8000/399 线性换算 |
| --- | ---: | ---: |
| 扫描 | 2 | 约 40 秒 |
| 指标/预览/TOPIQ | 109 | 约 36.4 分钟 |
| 向量 | 12 | 约 4.0 分钟 |
| 人脸 | 13 | 约 4.3 分钟 |
| 姿态 | 22 | 约 7.4 分钟 |
| 原生细节 | 104 | 约 34.8 分钟 |
| 未归属区间 | 37.826 | 约 12.6 分钟 |

**同分布、同 RAW/JPEG 配对比例下，8000 张首次分析线性预估约 1 小时 40 分钟**。
这是推算，尚未实跑全库；原生解码、人物密度、缓存状态和分组复杂度都会改变耗时，
大库分组无法由 43 个样本组线性保证。w13-ux 可提示「首次全库可能需要数小时，先选几百张」，
不能把单一数字作为完成承诺。用户的 7980 原片实际形成 3901 单元，配对比例略有不同。
代码新增 focus 进度阶段，避免原生细节全部结束前一直显示姿态阶段。

两库各1500原片完成，共 **3000原片 /1539单元 /563组**，原片SHA-256全部一致。
TOPIQ、人脸、姿态缺失均0；姿态实测DmlExecutionProvider。MediaPipe人脸仍是CPU。

| 子集 | 单元/组 | 分析秒 | 原片/秒 | 命中缓存单元 |
| --- | ---: | ---: | ---: | ---: |
| library-1 | 774/226 | 1070.990 | 1.401 | 148 |
| library-2 | 765/337 | 954.882 | 1.571 | 0 |

阶段采样毫秒见 `testing-data/windows-scale-library-{1,2}.json`：首库metrics318287、embedding40326、
faces33341、pose66676、focus611164；第二库metrics630270、embedding50040、faces30267、
pose84826、focus158456。计时不包含客户端库存、旧POST前扫描、前后原片SHA与报告/联系表收尾。
全机采样显存峰值10103MiB，客户端working set381.05MiB，服务/子进程树2797.03MiB，
见 `testing-data/windows-resources.json`；包含其他应用的全设备显存不能当本进程独占值。
哈希核对读取大量原片，本次客户端累计约185GiB；磁盘约100MB/s，不能把IO等待误判成模型卡死。
联系表留在Windows `<validation-root>/qa/library-1-1500/`、`qa/library-2-1500/`。

上述规模结果来自补齐ExifTool前的旧扫描入口：会话回退、RAW方向与对焦点来源有局限，
不能宣称与完整Mac扫描语义等价，也不能直接当新配置全库耗时承诺。
首库HEIC主单元146/141有focus、JPG616/438、ARW9/7、DNG3/2；无脸跳过focus。
这是配对单元覆盖，RAW可能提供内嵌JPEG，不证明直接HEIC或完整3FR解码通过。
focus后的source.kind未保留，来源追踪仍有局限。

系统原先没有可调用ExifTool，rawpy已存在。便携 `exiftool-vendored.exe@13.59.3` 实测版本13.59，
`scripts/windows-exiftool.ps1 -Root <validation-root>` 安装在验证目录，设置不入库的
`config/local.json` 中 `EAGLE_EXIFTOOL`，未修改系统PATH。
拍摄信息、原生取像、对焦点统一使用该设置；Mac默认仍调用exiftool。
Windows UTF-8文件列表、SourceFile路径归一化；安全scanner补齐所选范围EXIF，再分配拍摄会话。
Windows原生裁块/对焦缓存键包含工具配置，避免复用缺工具缓存；Mac键不变。
两库各8原片抽查均7张有拍摄时间/设备，分别2/1会话，前后哈希16张全部一致，
见 `testing-data/windows-exif-check.json`。

新配置500原片阶段采样秒：扫描10.735、指标209.596、向量21.757、人脸19.182、
姿态33.364、原生细节275.742。总墙钟570.376秒（约0.877原片/秒），包含服务后台扫描，
仍不包含客户端库存/前后SHA/报告与联系表。没有命中缓存。
按8000/500线性换算：扫描2.86分钟、指标55.89分钟、向量5.80分钟、人脸5.12分钟、
姿态8.90分钟、原生细节73.53分钟，**合计约2小时32分**。
本cohort人为覆盖评分，不是随机全库样本；配对比例、RAW/人物分布不同，分组也非线性。
w13-ux当前可使用“首次全库可能数小时，建议先选几百张”，不能显示2h32为完成承诺。
前面1h40为旧配置399样本的历史估算，当前预期应优先参考本段及其限制。

## 5. 真实偏好信号

早期库存见 `testing-data/windows-library-inventory.json`，最新快照见 `windows-exif-check.json`。
两次首库metadata8060→11092、删除58→3087、支持原片7980→7983（HEIC+3），
文件夹ID哈希集合相同；第二库8085/删除64/支持8006不变。
扫描器只读metadata与原片，输出仅写验证根；自身代理其他写请求0。
快照变化原因没有确认：**只能证明已验收原片哈希与自身请求只读，不能声称库metadata完全未变**。

首库80项三星、35项五星；第二库全部0星。无注释。
最新882个精选类标签全部是 `AI精选`，非AI精选类标签0；不能把算法标签当用户真值。
4个精选类文件夹仅是候选信号，语义未确认；删除标记不当淘汰标签，0星保持未标注。
专门cohort覆盖全部非零评分、配对格式及同文件夹邻居；配对评分冲突排除。
标签只含ID哈希、内容SHA-256、星级、组哈希，留Windows；用户未确认星级来源。
同组首选一致率、五星对三星顺序AUC只作为条件性评分一致性；保留/淘汰AUC仍应null。
专门cohort新配置完成：500原片/291单元/109组，570.376秒，0缓存；SHA500/500一致，
TOPIQ/人脸/姿态缺失0，269个focus可用，详见 `testing-data/windows-ratings.json`。
115个非零评分原片合并为71个带星级单元；五星28、三星43，无配对评分冲突。
仅1组有两种星级、只有1个五星/三星对：首选与成对一致均1/1，不能解读为总体100%准确。
跨组五星/三星原始排序score顺序AUC **0.5726744**，未控制安全门槛/题材/拍摄会话，
星级来源仍未确认；保留/淘汰AUC为null。合成准确率96.20%不能推出真实偏好准确率。
第二库无非零星级，不能构造相同评分评测。

## 6. 数值差异与质量验收

无图逐项诊断见 `testing-data/windows-parity.json`。人员框 IoU≥0.5 一对一匹配，
坐标仅比较双方置信度均≥0.7 的点；分类变化按规则 ID/判定比较，不把理由字符串当分类。
Windows CPU/DML 匹配1194人，未匹配0；关键点置信度最大差0.0068583、均值0.0000308064；
高置信坐标最大差0.0036141。TOPIQ最大差0.000173897；人脸框/闭眼无差，分类变化0张。
Mac/Windows CPU 匹配1189人，合计未匹配13，59次顺序变化；置信度最大差0.257272、
均值0.00439311，高置信坐标最大差0.015905；规则分类变化21张。
w11 Linux/Windows CPU 匹配1194人，未匹配0，规则分类变化0；置信度最大差0.00129214。
Mac/Windows TOPIQ最大差5.3644e-7；Linux/Windows为4.1723e-7。
低置信/中置信坐标仍有大跳变：CPU/DML双方≥0.3时最大0.20973，≥0.5时0.18152，
不能泛称所有坐标接近。建议以同平台基线验收，阈值边缘保留人工确认；
现有证据不足以调一套平台专用门槛，合成总指标相同也不代表姿态规则逐行一致。
Python TOPIQ CPU/DML最大差7.152557e-7、均值1.337264e-7；
同provider Node/Python最大差约0.12475、均值约0.0511，仍有PIL/sharp预处理差异，未解决。

## 7. 断连续跑、用户优先与未完成项

Mac `docs/windows-validation-progress.md` 与Windows `<validation-root>/PROGRESS.md` 双写。
`scripts/windows-task.ps1` 用CIM脱离SSH，BelowNormal，独立日志/exit与检查点；短SSH轮询。
首次日志锁冲突与真实失败记录保留，未伪造exit。代码修改已回Mac，照片/派生图不回传。
用户32596/43125保留；测试47928/43135已在空闲时停止，独立数据保留；空闲维护前写PROGRESS并检查active与pending连接。
用户优先观察器44448每2秒GET43125，仅取消有磁盘run证据的43135任务，或按启动记录与命令
核实停止自有release-bench进程树；不取消/重启用户run。尚未实际触发抢占，不声称已完成该场景。
验证队列48860已exit0，标准入口结束后再串行收尾回归。用户忙时等待，避免重复任务。

未完成：Eagle原生宿主人工反馈、星级来源确认、完整8000张全库实测、独立格式直接解码验收、
可选VLM老师（未开展）、Node/Python预处理差异解决。Edge上下文适配不能代替原生宿主验收。
标准实际命令：`node --max-old-space-size=2048 scripts/bench.mjs --compare <baseline.json>`，
DirectML环境、低优先级、CIM脱离SSH，exit0。指定基线2026-10-11T14:39:30.841Z，
来自 **w11-raybench**（不是较早Mac基线），相同manifest SHA验证通过。
标准结果354/368、101/112、1/20；三项delta均0，368对unchangedRows=true，无模型警告。
聚合见 `testing-data/windows-standard-bench.json`，完整逐行留在其artifact指定的Windows路径。
此前相对较早Mac基线355/368少1对仍保留，不能用最新Linux基线通过抹去跨平台差异。
Mac cache-only入口拒绝388张冷推理，不是Mac质量gate通过。
收尾公开扫描结果与diffcheck见下方；不提交、不push。

## 上一轮服务与交付状态（历史记录）

用户服务32596保持BelowNormal、43125健康，活动库与本次用户服务启动时一致；
最后快照用户代理10 GET、切库0、其他写0、拒绝0（此前阶段日志另存，不能当全部历史总数）。
空闲测试服务47928已停止；验证队列、观察器、回归全部结束，无本次仍在计算的bench/真实分析任务。
最后Edge恢复6场景通过、用户POST0、浏览器错误0、截图错误0；中断任务手动打开只GET一次后停止轮询。
61个两端改动代码文件SHA-256逐字节一致，最新Windowspatch回传 `/tmp/w12-final-code.patch`。
原始照片、派生图、联系表和逐图真实标签仍全部在Windows；既有工作区改动保留，未提交、未push。

最终执行 `node scripts/check-public-release.mjs`：440文件、0命中；`git diff --check`通过。

## w13 新主页合并（2026-10-12）

本工作区已由外部启动mac-ray-dev合并（包含5ce7617，当前主线c8a0f3e）；本轮解决7个冲突。
保留新主页状态卡、三步引导、上下文主按钮、最近分析、折叠高级设置及精简审阅页；
保留Windows原子重试、后台扫描202/进度、服务忙409与恢复、连续断网重试、只读scanner注入。
GET /runs与/runs/status并存；列表、单任务GET均把无活动进程的running显示为interrupted。
最近分析显示进行中X/Y与查看进度、失败的通俗原因、失败/取消/中断的重新分析及缓存复用。
新Windows启动参数保留BelowNormal；全库提交不读取选中项，Eagle SDK选择/计数请求有10秒边界。
Mac最终完整指定Node回归411pass/0fail/1skip，共412项，220.537秒；UNC路径定向8/8通过。
Windows已三次确认无active run，再记录维护并重启用户服务42488/43125，独立windows-user数据不变。
用户可以：Eagle里重新加载插件 → 左侧选一个几百张的安全文件夹 → 点“分析当前文件夹”主按钮；
选中照片时主按钮改为分析选中项。已有任务可从最近分析查看进度，失败后可重新分析。

Git暂存及merge --continue均被沙箱拒绝创建index.lock。工作文件没有冲突标记，
但Git索引仍为未解决，**合并提交未完成**；不能把代码整合/Windows部署说成Git合并已完成。
同步通过bundle加代码归档（无照片），Windows部署前保留了本地代码patch；未push。

新版Edge恢复6场景通过，用户服务真实POST0、浏览器错误0；独立复验截图错误0，
随后完整回归中的UI复验仍全通过，但real-user-home.png截图捕获失败1次，不能声称最新截图全部成功；
主按钮文件夹范围400个synthetic ID提交被拦截，仅验证请求与UI，不创建真实分析。
截图留Windows `<validation-root>/qa/recovery-ux/`，回传无图统计 `testing-data/windows-ux-recovery.json`。
初轮误把更新状态请求计为结果读取，修正fixture后复验通过，原始失败日志保留。
Windows首轮409pass/3fail：两处Unix路径测试假设、更新候选进程清理竞态；
修正后完整复验412pass/0fail，147.434秒，regression-ux-repaired退出码0。
所有90个两端改动代码文件SHA一致；代码patch `/tmp/w12-ux-windows-code.patch`，
Mac整合patch `/tmp/w12-ux-merged.patch`。主线.gitignore的机器专用绝对目录规则改为通用盘符目录规则。

当前用户服务为42488/43125（BelowNormal），此前32596等PID仅为历史记录。
用户如需自行停止本次服务，可在PowerShell执行 `Stop-Process -Id 42488`；执行前确认仍为该Node服务且无分析进行。
完整回归命令：`node --max-old-space-size=2048 --test --test-concurrency=1 --test-skip-pattern='fixture face detection recall|fixture grouping reaches'`。
Mac使用 `EAGLE_PYTHON=python3`，未启动本机冷模型推理；Mac nice设置被沙箱拒绝，回归串行运行。
Windows Edge验收命令：`node scripts/windows-ux-recovery-ui.mjs`。
Eagle原生宿主需要用户重新加载后亲手确认；Edge适配验收不能代替该项。

有Git写权限的终端可在本工作区执行以下命令收尾（仅列出本轮需暂存的文件，主线其他变更已暂存）：

```sh
git add .gitignore docs/contracts.md src/plugin/api.js src/plugin/service-start.js src/plugin/start-view.js src/plugin/start-model.js src/server.js src/server/run-store.js src/server/runs-routes.js test/start-ux.test.js test/report-format.test.js test/update-restart.test.js test/ux-workflow.test.js scripts/windows-ux-recovery-ui.mjs docs/windows-validation.md docs/windows-validation-progress.md docs/testing-data/windows-ux-recovery.json
GIT_EDITOR=true git merge --continue
```

本轮最终公开检查：`node scripts/check-public-release.mjs` 扫描473文件、0命中；`git diff --check`通过。

## w16 GitHub 克隆安装与更新演练（2026-10-12）

本节 `<validation-root>` 表示机器上既有的安装根目录；真实路径和恢复命令只写在
该机器不入库的 `PROGRESS.md`、本地脚本和日志中。旧 `repo` 保留，没有移动或删除。
Mac 本轮只追加本节，没有修改仓库源码、模型、依赖清单或 Git 提交，没有 push。

在新建的 `app` 执行公开仓库克隆、`git checkout --detach v1.2.0` 和
`npm.cmd ci --ignore-scripts`；HEAD 为 `4377170759f49af02c2c4e4a6bf72a90830f1eec`。
安装成功，sharp 实际生成 PNG、ONNX Node 模块加载成功；未放开安装脚本。
复制旧 `config/local.json`、`models/`、完整 `data/`；本地配置中的 `EAGLE_PYTHON`
改为指向保留的旧虚拟环境，避免迁移 Windows venv 启动器。旧 EXIF 工具设置保留。
这些内容由 `.gitignore` 忽略，`git status --porcelain --untracked-files=all` 为空。

旧服务的数据根是 `data/windows-user`，CLI 默认读取 `data/runs`、`data/cache`，
因此额外复制该用户目录的 runs/cache 到默认位置，原复制目录也保留。
SHA-256 逐文件比较：12 个模型（601299723 bytes）、1280 个用户数据文件
（94590071 bytes）、映射到默认 runs 的 10 个文件（53585135 bytes）均零差异。
`GET /runs` 能看到旧用户服务的全部两条历史 run。旧用户目录没有 L1 learning 目录，
不存在可迁移的 L1 记录；已有决定随 run 文件复制，不声称额外生成或完成学习。
其它验证数据仍保存在复制的原目录层级，没有混入用户任务列表。

切换前连续三次确认 `/runs/status.active=null`，每次关闭检查请求连接后确认
43125 无 Established 连接；复制刷新后、停止前再次复查。只停止核实过命令行的旧服务。
新服务从 `app` 根目录通过 CIM 脱离 SSH 启动，使用：

```powershell
node --max-old-space-size=2048 --import ./data/service-runtime.mjs src/cli.js serve --port 43125 --concurrency 1
```

启动脚本设置 BelowNormal、DirectML scorer/DINO/pose、sharp 并发 2、PYTHONUTF8。
忽略目录内的本地 `service-runtime.mjs` 将 FaceWorkerPool 的 worker 上限设为 1，
保留旧服务的 worker 设置；不修改受版本控制源码，更新重启保留该启动参数。
`/health` 成功，`/update/status` 为 currentVersion=v1.2.0、latestVersion=v1.2.0、
canUpdate=true、checkError=null。初次读取曾命中复制来的旧 origin 失败缓存，
仅删除新安装 `data/update-status.json` 后重新检查公开 origin，旧目录缓存未改。

没有配置开机任务；重启或重登后可运行根目录的 `w16-launch.ps1` 恢复脱离 SSH 的服务，
它在 43125 已有监听时拒绝重复启动。具体命令已写入该机器 `PROGRESS.md`。
用户还需要在 Eagle 移除旧插件，再「导入本地项目」选择
`<validation-root>/app/src/plugin`，之后使用插件内自动更新。没有在 Eagle 宿主中自动点击。

隔离演练在 `update-drill` 另建公开克隆并 checkout v1.2.0，随后仅将演练 origin
改为本地 bare 仓库，测试 tag v1.2.1 只推送到该 bare 仓库。
一次性入口采用 `test/updater.test.js` 已有的 `acceptOrigin` 注入方式，
配合真实 `restartService`/`candidateService` 和 HTTP 更新路由；不改克隆源码。
依赖未变化的测试 tag 只修改 package/插件版本及测试说明，保留原 lockfile，
这是更新机制 fixture，不是符合正式发布版本同步规则的新 Release。
43145 上检查→更新→重启→回退全部通过：两个 POST 均返回 202，
更新与回退最终 phase=completed，版本分别为 v1.2.1、v1.2.0，
健康检查的候选随机标识发生两次变化，验证真实进程接管而非模拟重启。
保留测试决定/学习标记文件，回退后 Git 工作区干净；演练服务已停、目录已删。

额外的 lockfile 变化演练两次失败：服务已加载 sharp 的 `libvips-42.dll`，
`npm.cmd ci --ignore-scripts` 在 unlink DLL 时返回 EPERM（errno -4048），
恢复旧依赖的 npm ci 同样失败。首次安装没有该问题；没有放开脚本或修改仓库代码来绕过。
**涉及 lockfile 改变的 Windows 自动更新与依赖恢复未通过**，不能将上述无依赖变化
演练当作全场景通过。生产 43125 没有参与演练，不受这次依赖失败影响。
未来此类更新需要维护者修复安装/进程顺序，或在服务空闲、停止后手动重装依赖；
本轮没有在生产安装制造新的 tag 或执行真实版本升级。
失败和成功证据保留在机器根目录 `logs/w16-drill-lock-change.json`、
`logs/w16-drill.json`、`logs/w16-drill-update-logs/`，复制与最终状态另有对应 JSON。
本轮未请求 Eagle 写接口、未切库、未修改 Eagle 数据或原片，未启动 Ray 作业。

收尾真实验证命令与结果：

```sh
EAGLE_PYTHON=python3 nice -n 15 node --max-old-space-size=2048 --test --test-concurrency=1 --test-skip-pattern='fixture face detection recall|fixture grouping reaches'
```

Mac Node 回归 411 pass、0 fail、1 skip，共 412 项，194.806 秒；
跳过的是本地 Python/姿态模型不可用的 JSONL 烟雾测试。
Mac cache-only bench 曾命中 0/388 uncached，但停在 MediaPipe 人脸 worker 初始化，
主动中止（exit 130），没有生成报告，**该次 Mac 质量比较未完成**。
没有绕过原函数、修改缓存签名或硬编码指标。
随后在 Windows 新克隆串行真实运行：

```powershell
$env:EAGLE_PYTHON=(Resolve-Path '../repo/python_worker/.venv/Scripts/python.exe').Path
$env:EAGLE_SCORER_PROVIDER='dml'
$env:EAGLE_DINO_PROVIDER='dml'
$env:EAGLE_POSE_PROVIDER='DmlExecutionProvider'
$env:EAGLE_BENCH_CACHE_ONLY='1'
node --max-old-space-size=2048 scripts/bench.mjs --compare <baseline.json>
```

`<baseline.json>` 是实际传入的最新清单一致报告
`2026-10-11T18-16-24-560Z/report.json` 的副本；复制的是比较输入，没有复制旧报告充当输出。
Windows 进程 BelowNormal、Node heap 2048 MiB，开始前确认用户无活动分析并持有本次 GPU 预约锁，
结束释放预约。实际 exit 0，0/388 uncached，没有整批本地冷推理。
新报告为 `app/data/cache/bench/reports/2026-10-11T18-27-52-486Z/report.json`，
manifest SHA-256 为 `64fae9780400401ccfac34051101cdac4b0514aa69c5da919f2f9d1246828c48`。
偏好准确率 354/368、严重 gate 101/112、源图误淘汰 1/20，三项 delta=0，
368 行 unchangedRows=true，warnings=[]；**本清单质量门槛通过**。
这证明固定清单缓存回放与 scorer 健康复查，不是全库模型推理验收。

Windows 使用配置指向的原环境执行
`python -B -m unittest discover -s python_worker -p test_face_regions.py`：3/3 通过。
MediaPipe/ONNX 导入通过，可用 providers 为 DmlExecutionProvider、CPUExecutionProvider。
旧环境没有可选 Torch；没有安装额外依赖或验证可选 Torch worker。
最终复查用户服务 PID 36916、BelowNormal、active=null、两条历史 run 可见，
currentVersion=v1.2.0、canUpdate=true、checkError=null，app Git 状态为空；
43145 无监听，演练目录不存在，旧 repo 保留。手工 Eagle 宿主重新导入及实际审阅尚未完成，
留给用户执行；没有在用户宿主自动点击或制造真实分析任务。
Mac 所有命令请求 nice 15，沙箱拒绝调整优先级；Windows 使用 BelowNormal。
最终 `nice -n 15 node scripts/check-public-release.mjs`：480 文件、0 命中；
`nice -n 15 git diff --check` 通过。Mac tracked 改动仅本文件，未提交、未 push。

## w17-depswap 针对性复验（Windows）

在独立临时演练目录和端口 `43145` 完成了 `v1.2.0`（真实 `node_modules`）→ `v1.2.1`（仅版本变化）→ `v1.2.2` → `v1.2.3` → `v1.2.4` 的连续更新；后三级每次只改变 lockfile 标记，服务运行期间已加载 sharp。每次更新后 `/health` 正常、`/update/status` 为 `completed`，根 `node_modules` 为 Junction，当前依赖目录存在，上一版依赖目录仍保留。依赖目录按 mtime 保留并保护当前及上一版目标；首次真实目录迁移留下的旧目录也未被删除。

从 `v1.2.4` 回退到 `v1.2.3` 成功，Junction 指回仍存在的上一版依赖目录，服务健康。演练服务通过 Windows Scheduled Task 脱离 SSH 启动，断开 SSH 后重新连接仍可访问 `/health`。演练服务、任务、临时目录和端口监听已清理；未触碰用户服务端口 `43125` 或固定应用目录。
