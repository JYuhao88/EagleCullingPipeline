# 测试与验收

## 自动化测试

```bash
npm test
```

脚本是 `node --test --test-concurrency=1`。测试文件覆盖：

- `analysis-capture.test.js`：JPG/RAW 配对、删除项跳过、哈希和时间阈值分组。
- `analysis-fixture-faces.test.js`：`test/fixtures/fixture-faces.json` 的人脸召回/误报；缺少 `models/mediapipe/face_landmarker.task` 或 `python_worker/.venv` 时跳过真实检测。
- `analysis-fixture-groups.test.js`：`test/fixtures/fixture-groups.json` 标注组的分组 F1 目标；缺少 `models/dinov2-small/model.onnx` 时跳过模型路径测试。
- `analysis-quality.test.js`：EXIF 方向、均匀代理拒绝、排序理由和建议决定。
- `core.test.js`：合同、指纹缓存续跑、取消、服务审阅流、缩略图恢复和 library mismatch 拒绝。
- `plugin-logic.test.js`：插件状态过滤、快捷键、撤销、组内焦点和 select-best。
- `review-worker-b.test.js`：决定持久化、RAW 跟随、人工标签保留、CSV 中文列。
- `style.test.js`：源码单行不超过 140 字符。

## fixture 与完整性

`fixture-faces.json` 是人脸/非人脸清单；`fixture-groups.json` 是人工相似组和 uncertain 对；`fixtures/review/results.json` 是插件审阅固定 run。`scripts/verify-fixture-integrity.mjs [EAGLE_LIBRARY]` 读取 `exports/mac-fixture-v2/manifest.json`，按名称和扩展名匹配 Eagle `images/*.info`，逐文件 SHA-256 校验并输出 `matched/mismatched/total`，不写回 Eagle。

## 端到端验收

1. 准备测试库，确认 76 个文件、38 个拍摄单元。
2. 运行 `node src/cli.js doctor --library "/path/to/test.library"`，确认 Eagle、library 和模型状态。
3. 启动 `node src/cli.js serve`，在 Eagle 开发者模式导入 `src/plugin`，创建分析并等待完成。
4. 在插件逐组审阅；先 dry-run，再写回；默认不移动回收站。
5. 运行 `node scripts/verify-fixture-integrity.mjs "/path/to/test.library"`。验收前后 `mismatched` 应为 0，`matched` 应等于 manifest `total`。
6. 抽查人工标签、星级、文件夹、RAW 成员和报告；重复写回应保持 `unchanged`，证明幂等。

SHA-256 校验针对原文件字节，不以预览或 Eagle 缩略图代替。人脸测试缺少 `python_worker/.venv` 时是跳过，不是通过。

## W6 规模与性能（2026-10-11）

实现：扫描串行分批读取 EXIF（亚秒、偏移、设备）和原文件 stat；按设备、本地拍摄日及
30 分钟间隔分会话，RAW/JPG 仅在同会话同主干内配对，多候选剩余文件不再遗失。
分组使用会话过滤及 60 秒时间桶候选索引，完整链接、平均相似度、时间跨度和组大小门槛不变；
异步接口按批次让出事件循环并检查取消。无拍摄时间继续旧候选逻辑。
跨日 pHash 半径4召回使用5个不重叠 hash band，候选上限100/单元，单独返回重复证据，
不自动合并跨日连拍组、排序或淘汰。pipeline/ranking/HTTP confidence 通过 Map 查找结果。
进度每250ms或阶段变化写轻量 run.json；完整 items/units/results/groups 仅在终态写一次，
文件原子替换，完整结果就绪后才发布终态。GET run 不读取完整结果，终态写入期间状态仍保持轻量。
契约保持 v1，旧缓存和旧 run 可读；新增字段见 [contracts.md](contracts.md#w6-规模兼容扩展2026-10-11)。

### Ray 环境与可复现入口

主作业 `w6-scale-stress-c142206d3f9c` **SUCCEEDED**，总墙钟时间210.73秒，四档串行。
资源预留2 CPU、0 GPU、8 GiB；CPU affinity `[0,1]`，Sharp并发1、文件生成并发2。
节点 `AMD EPYC 9K84 96-Core Processor`，系统384逻辑核；本作业只用其中2核。
官方临时 Node `22.14.0`，SHA-256校验；Sharp `0.33.5`、exiftool-vendored.pl `13.59.3`。
依赖安装到作业临时代码树，避开 Ray working_dir 链接与 Node ESM realpath 的解析差异；未安装系统包。
runtime_env 工作包只含 src/core、src/server、src/rules 的 JS/JSON及压测脚本，不含 data、models、node_modules、原片或密钥。
作业内生成、清理合成数据，仅报告保存在：
`<CEPH_ROOT>/stress/w6-scale-stress-c142206d3f9c/{200,5000,10000,25000}.json`。

[完整测量快照](testing-data/w6-scale.json)同时保存 Mac 对照、质量回归及汕头配对差异。
实现及提交入口：[stress.mjs](../scripts/stress.mjs)、[stress-ray.py](../scripts/stress-ray.py)、
[stress-ray-worker.py](../scripts/stress-ray-worker.py)。提交参数没有密钥/cookie，dashboard 请求绕过代理；
公共下载代理仅供 Node/npm 获取依赖，无模型推理或外部模型 API。

```sh
# Mac 只允许小档；脚本默认200单元，拒绝本机>250单元或>1000索引单元。
nice -n 10 node scripts/stress.mjs --units 200 --index-units 200 --output /tmp/w6-mac-smoke.json
# 提交前检查本线活动作业；已有一个压测或已有两个摄影线作业时拒绝新增。
nice -n 10 python3 scripts/stress-ray.py submit
nice -n 10 python3 scripts/stress-ray.py status --id <返回的本线job-id>
nice -n 10 python3 scripts/stress-ray.py collect --id <返回的本线job-id>
nice -n 10 python3 scripts/stress-ray.py audit
# 仅能停止显式指定的 w6-scale-stress-* 本线作业；不碰别人作业。
nice -n 10 python3 scripts/stress-ray.py stop --id <本线job-id>
```

作业总超时3600秒，单档1200秒；采样监测 Node 与 EXIF 子进程组 RSS，超过8 GiB停止；
Node heap上限2 GiB、阶段 RSS 软上限3 GiB。采样间隔0.2秒可能遗漏瞬时峰值，Node另记录自身maxRSS。
最终本线作业审计：主作业SUCCEEDED，早期探测 `b27d91e9e70c` STOPPED、`e5881542327d` FAILED；
**无 RUNNING/PENDING 残留**。前者发现合成 EXIF IFD 写错后主动停止，后者暴露 Ray 链接下的依赖路径问题；
均未开始万文件测量。修复后400文件冒烟通过，主作业完成全部档位。
中断前已有本机万文件探索日志；追加约束后的正式万文件结果全部来自 Ray，没有再次本机大档压测。

### 合成吞吐与首屏

每单元2文件，真实执行扫描、配对、分组、排序、RunStore及HTTP路由；模型结果为确定性桩。
文件是含时间/亚秒/偏移/设备的16×16 JPEG，mock ARW 也使用 JPEG 字节，不进行 RAW 解码。
扫描 EXIF 时间统一为固定值；分组桩另生成有时间序列的四帧 burst、每500帧一会话及确定性64-bit hash；
不包含 embedding、faces、pose、verdict 等完整模型数据。测量各阶段而非真实拍摄流的端到端模型耗时。
HTTP为本节点localhost完整结果传输加JSON解析；不是浏览器渲染或远程网络首屏，未分页。
所有单元恰好配对，扫描 EXIF/stat 完整；各主档分组为单元数/4。

| Ray文件/单元 | 扫描秒（文件/秒） | 配对ms | 分组ms（单元/秒） | 排序ms | 存储ms | HTTP首屏ms | Node峰值MiB | 进程组采样峰值MiB |
|---|---:|---:|---:|---:|---:|---:|---:|---:|
| 400/200 | 0.795（503） | 1.25 | 11.13（17,971） | 2.97 | 4.32 | 12.04 | 101.07 | 106.50 |
| 10,000/5,000 | 18.902（529） | 22.87 | 187.78（26,627） | 32.11 | 95.82 | 246.36 | 439.95 | 475.12 |
| 20,000/10,000 | 37.681（531） | 38.72 | 344.41（29,035） | 66.84 | 180.35 | 493.51 | 726.74 | 723.91 |
| 50,000/25,000 | 93.985（532） | 112.41 | 830.22（30,112） | 143.71 | 483.35 | 1,286.58 | 1,178.71 | 1,191.16 |

吞吐分母明确：扫描/配对以文件计，其余以单元计；配对三大档约43.5万/51.7万/44.5万文件/秒，
排序约15.6万/15.0万/17.4万单元/秒，存储约5.22万/5.55万/5.17万单元/秒。
setup分别0.923/1.759/4.492秒，模型桩35.43/61.88/138.53ms，未混入扫描时间。
HTTP结果体分别11.30/22.67/56.76MB；响应头到达162.40/328.27/717.20ms（完整明细以JSON快照为准）。
每档峰值包括后续10万轻量索引及同hash退化召回阶段，不能解读为扫描阶段单独内存。

5,000单元 results.json 16.02MB，仅写一次；20次模拟进度持久化只写轻量状态。
旧每单元重写同样最终结果大小的上界估算80.08GB；这不是实测旧版本I/O，旧中间payload可能较小。
路由测试实际触发5000次连续回调，完整payload仅终态1次，初态+两个阶段轻量状态共3次。

### Mac/Ray同档对照及10万外推

Mac `Apple M3 Pro`、12核、Node22.9.0、exiftool13.55，仅跑400文件/200单元。
沙箱打印setpriority拒绝，但实测进程继承nice=10；Sharp并发1，未执行本机大档或全库冷模型推理。

| 同档阶段 | Mac ms | Ray ms | Mac/Ray耗时比 |
|---|---:|---:|---:|
| 扫描 | 2,071.64 | 795.27 | 2.60 |
| 配对 | 1.02 | 1.25 | 0.82 |
| 分组 | 8.08 | 11.13 | 0.73 |
| 排序 | 2.32 | 2.97 | 0.78 |
| 存储 | 3.48 | 4.32 | 0.81 |
| HTTP完整结果+解析 | 9.24 | 12.04 | 0.77 |

该单次对照只能作量级换算：文件系统、Perl启动、Node/Exiftool版本、频率和CPU架构不同，
小档固定开销占比高；不能把扫描2.60倍直接用于全部阶段或真实 RAW。

三大档分别另建100,000单元轻量特征索引并分组：

| 测量 | 5,000主档后 ms | 10,000主档后 ms | 25,000主档后 ms |
|---|---:|---:|---:|
| unitId Map | 17.83 | 17.82 | 22.37 |
| 跨日pHash召回 | 1,924.59 | 1,949.64 | 1,993.19 |
| 时间/会话分组 | 3,119.00 | 3,122.71 | 3,139.48 |
| 同hash跨日退化召回 | 4,588.45 | 4,618.66 | 4,579.32 |

轻量100k分区为25,000组；均匀随机hash跨日半径4没有命中，另有单测验证半径内真命中。
同hash退化召回99,500个单元各最多100条，没有跨日合并；统计输出和索引空间随单元数增长。
均匀band索引每单元5份引用；非均匀hash碰撞可能使候选扫描退化，不承诺任意分布的严格线性复杂度。
时间桶吞吐在这三档近线性；无EXIF的旧分组仍可能O(n²)，保留质量优先的回退。
200,000 mock文件按该Ray扫描吞吐粗估约376秒；100k桩式完整run落盘约320MB。

**完整真实结果不适合照搬该外推**：汕头253单元缓存紧凑JSON合计9,074,650字节，
平均35,868字节/单元，仅100k UnitResult就约3,420.66MiB（3.34GiB），尚未包含items/groups、
解析对象、重复缓存行及embedding内存。现有ResultsStore整文件读取/RunStore完整results HTTP
仍无法保证100k真实单元满足3GiB软上限。下一步需要持久化轻量分组索引、缓存流式加载/压实和HTTP分页；
本轮不做缓存内容寻址重构，不声明全库完整结果可在3GiB内运行。

### 质量回归与汕头前后

fixture 使用共享Python、CPU provider，单独串行分析38单元；强化测试为F1≥0.88、FP=0、TP≥22、FN≤6。
最终115.74秒，1 pass/0 skip：**23组、最大组4、TP22/FP0/FN6、F1=0.88**，基线持平。

`nice -n 10 node scripts/bench.mjs --compare data/cache/bench/reports/2026-10-10T05-56-30-237Z/report.json`
按eval-baseline的共享Python、PYTHONPATH和CPU环境运行；这是最新同manifest常规基线，
更晚W5扩展报告使用不同manifest，常规bench拒绝跨manifest对照。
结果 `data/cache/bench/reports/2026-10-11T00-38-44-385Z/report.json`：368对、偏好96.47%、
严重gate101/112=90.18%、源图误淘汰代理1/20=5%；三项delta=0，逐行unchangedRows=true，warnings=[]。
扫描/ranking源码签名变化导致388张合成评测图缓存未命中，串行重算；没有全库冷模型推理。
没有可用独立真实偏好标签，代理结果不等价于摄影师偏好。

汕头只读回放旧模型输出，不重跑模型。旧算法引用 `7bc228a324f2919ac888e38612b11c8cd1e33722`，
[scripts/grouping-replay.mjs](../scripts/grouping-replay.mjs)支持重新只读提取EXIF：

```sh
nice -n 10 node scripts/grouping-replay.mjs /tmp/w2-gate2-qa/final-analyze.json /tmp/w6-grouping-replay.json
nice -n 10 node scripts/grouping-replay.mjs /tmp/w2-gate2-qa/final-analyze.json \
  /tmp/w6-grouping-fresh-exif.json 7bc228a324f2919ac888e38612b11c8cd1e33722 --fresh-exif
```

| 253单元对照 | 组数前/后 | 最大组前/后 | 新增同组配对 | 移除同组配对 |
|---|---:|---:|---:|---:|
| 沿用旧captureTime | 83/83 | 19/19 | 0 | 0 |
| 重提亚秒/offset后与旧缓存比较 | 83/83 | 19/19 | 14 | 18 |
| 旧/新算法使用同一份重提EXIF输入 | 83/83 | 19/19 | 0 | 0 |

归属变化集中在DSC07036、DSC07048、DSC07093，源于新时间精度改变时间排序，
没有放宽visual/diameter门槛；逐对差异保存在测量快照。汕头未有人工成对标签，
此对照不能证明新EXIF归属更好；fixture基线和同输入分区一致性均通过。
开始/恢复时GET Eagle library/info都确认活动库为example.library；只读原片EXIF，未访问「未删减」、未写回Eagle、未修改或删除原片。

最终指定Node全套：309 tests、308 pass、0 fail、1 skip；skip为默认Python worker冒烟。
Python工作包白名单测试1/1通过，提交/worker脚本编译通过；git diff --check通过。
日志 `/tmp/w6-full-tests.log`、`/tmp/w6-fixture-final.log`、`/tmp/w6-bench.log`，Ray报告与作业日志在`/tmp/w6-ray/`。
未完成：全阶段检查点/取消、统一生产资源调度、真实模型大批性能、真实偏好盲标、HTTP分页/浏览器渲染时间。

## W6 候选集评估

`nice -n 10 node scripts/eval-candidates.mjs` 只读取 T-syn 分析缓存、旧汕头 run 和共享结果缓存，不访问 Eagle 写接口、不调用模型。它输出旧加权、严格 Pareto、ε-Pareto 的 top-1、pairwise、前沿召回、前沿大小、源图排除代理和严重退化排除率，并按 T-syn 退化类别给出 1000 次 bootstrap 区间。

汕头联系表为 `/tmp/w6-pareto-qa/shantou-contact.html` 及 `images/*.jpg`；它只用于目测，没有摄影师精选真值。当前评估建议审阅页默认保持旧排序，候选集通过页面开关按需查看。

## W7 L1 模拟用户与缓存基线（2026-10-11）

入口：`nice -n 10 node scripts/eval-personalization.mjs --out /tmp/w7-personalization-qa`。
仅复用 388 张 T-syn 输入的已有分析缓存、汕头 `run-1791589678002` 的 291 单元特征；模型调用 0。
T-syn 20 个源系列按 14/6 源切分，汕头 42 个多候选连拍组按 29/13 切分。
各语料先 200 次偏暗/紧裁/闭眼惩罚更重的选择，再 200 次切换偏亮/松裁；少量批量接受只模拟 AI 首选弱信号。
训练动作重复抽取训练源的不同子集，400 次动作不是 400 个独立新拍摄组。
未来留出完整源组始终不训练；bootstrap 按独立留出源组重采样 1000 次，seed 固定。
模拟器验证管线，不能证明真实摄影师偏好效果或起步门槛。

| 语料 | 动作数 | L0 留出 top-1 | L1 留出 top-1 / 95% CI | 配对提升 95% CI |
|---|---:|---:|---:|---:|
| T-syn（6 留出源） | 10/25 | 0% | 66.67% [33.33%,100%] | [33.33%,100%] |
| T-syn | 50/100 | 0% | 83.33% [50%,100%] | [50%,100%] |
| T-syn | 200 | 0% | 100% [100%,100%] | [100%,100%] |
| 汕头（13 留出组） | 10/50 | 38.46% | 69.23% [46.15%,92.31%] | [-7.69%,61.54%] |
| 汕头 | 25 | 38.46% | 69.23% [38.46%,92.31%] | [-7.69%,69.23%] |
| 汕头 | 100 | 38.46% | 69.23% [46.15%,92.31%] | [0%,61.54%] |
| 汕头 | 200 | 38.46% | 76.92% [53.85%,100%] | [15.38%,69.23%] |

模拟用户与评估保留严重门槛/睁眼优先层级，L0 使用实际排名而非裸分。
两条曲线最后一个检查点仍变化，无后续检查点证明稳定；6 个源全中造成退化区间，不能解读为总体无误差。
生产两窗口时间切分均为 no-stable-heldout-improvement，不支持开启个人排序。SVG 曲线与完整结果在
[learning-curve.svg](artifacts/w7-learning/learning-curve.svg)、[report.json](artifacts/w7-learning/report.json)，临时目录也保留副本。
偏好切换后旧头 T-syn 一致率 100%→16.67%，漂移提示触发；汕头 76.92%→46.15%，不触发（区间重叠）。
T-syn 新偏好 top-1：不衰减 66.67% [33.33%,100%]，20 天半衰期 83.33% [50%,100%]；
汕头两种设置均为 61.54%，不能宣称显著改善。默认衰减设置与这个测试参数独立。

基线命令：`nice -n 10 node scripts/bench.mjs --w5 --compare data/cache/bench/reports/2026-10-11T00-38-44-385Z/report.json`。
报告：`data/cache/bench/reports/2026-10-11T02-48-49-854Z/report.json`。
对 SHA-256 一致的原 368 对，总体偏好、严重档 gate、源图误淘汰代理的变化均为 0，逐类别变化为 0。
加 84 个 W5 测量敏感性对后总体 438/452=96.90%，严重 gate 101/112=90.18%，源图误淘汰代理仍 1/20。
复用模型输出、重新计算轻量像素测量，没有冷模型推理；新增测量对不作为个人审美真值。
普通 `--compare` 首次发现签名漂移导致 388 个 cache miss，在指标阶段终止，后续采用该缓存 W5 回放。
所有命令以 nice -n 10 调用；沙箱拒绝 setpriority，不能声称降低了调度优先级。

模拟单测 `nice -n 10 node --test --test-concurrency=1 test/personalization-simulation.test.js`：3 pass、0 fail。
覆盖确定性动作/曝光、弱批量信号、未来源组留出、曲线、漂移切换、严重门槛/实际 L0 排名和 SVG 导出。

W7 最终基础设施/接入验收：特征内容身份、代理旧 run、仅特征删除原片后的相同 BT 重训、
只追加并发日志、批量低权重、真实曝光关联、undo、完整受保护库存墓碑、默认档 0/显式档 1、
profile 隔离/验证开关、时间/内容隔离、快照精确回滚、严重 gate 不跨层、关闭/切换恢复 L0均有单测。
L1 保留原 L0 rank/score/suggested；后续训练评估不把已个性化排序当基线；BT logit 另存，不冒充质量概率。
曲线报告还包含按组 bootstrap 的 pairwise、NDCG@5、有效对数和 tie 比例。
模拟紧裁信号使用脸/主体框面积代理，不等于真实构图偏好；汕头旧缓存无原图 SHA 时仅用稳定模拟身份，
实际特征库仍流式计算原片内容 SHA，代理回退明确区分身份。

最终指定全套命令：

```sh
nice -n 10 node --test --test-concurrency=1 --test-skip-pattern='fixture face detection recall|fixture grouping reaches'
nice -n 10 git diff --check
```

332 tests，331 pass、0 fail、1 skip；skip 沿用未显式开启的 Python worker 冒烟。
日志 `/tmp/w7-full-tests-final.log`，`git diff --check` 通过。未冷跑全库/外部模型，未调用 Eagle 写 API、
未修改或删除真实原片，未访问「未删减」原片；实际删除只发生在测试临时图片。
模拟曲线/缓存回放与单元集成已验证；真实摄影师跨会话盲标、真实 Eagle 只读端到端仍未验收。
W8 已贯通真实浏览器＋HTTP＋只读 stub，L1 正向应用等仍未全通过，见下方端到端模拟选片。
档 1 的原片被外部删除后不可补救；默认不存像素。RAW/HEIC 专用解码、保留期到期自动清理、档 2/3、
L2/L3 均未实现。改动保留在 w7-learn，未提交、未 push。
## W6 原生对焦

`test/native-image.test.js` 覆盖 RAW 内嵌/配对回退、代理尺寸映射、8 种 EXIF 方向和 256 MiB/1000 项裁块上限；`test/focus.test.js` 覆盖坐标映射、Sony/Ricoh makernote 解析及 Laplacian/高频信号；审阅接口测试覆盖路径穿越与未知眼部区域。原生解码通过 `nice -n 10` 串行执行，全尺寸图只在临时目录存在，落盘只保留局部 JPEG。

（早期中断记录，已由下述只读回放结果取代。）对焦目前只写入提示信号，未接入 L0 自动淘汰，避免未经留一/T-syn 校准误淘汰源图。

### W6 实机与 T-syn 回放（2026-10-11）

使用活动 Eagle 库中清单对应的 80 张 ARW（29 组，其中 4 组为多张组），只读原片和历史人脸结果；联系表及局部裁块位于 [`/tmp/w6-focus-qa/contact-sheet.html`](file:///tmp/w6-focus-qa/contact-sheet.html)，AF 叠加样例位于 [`/tmp/w6-focus-qa/af-overlays.html`](file:///tmp/w6-focus-qa/af-overlays.html)，明细为 `focus-results.json`、`summary.json`、`group-comparisons.json`。全尺寸处理串行运行；`nice -n 10` 在本机被沙箱拒绝 setpriority，但没有并发任务。原生局部指标有效 31/80（38.75%），49 张因没有可用眼部 ROI 或原生指标为 `na`；Laplacian 眼部清晰度范围 1.50–290.64，中位数 83.81。exiftool 对焦点读取 80/80（100%）；在有脸且能比较主体的 31 张中，AF 点命中主体 17/31（54.84%），命中眼部 13/31（41.94%），焦点打偏提示 18 张。单张耗时均值 617.6 ms、P95 736.8 ms，进程峰值约 838 MiB。Sony `FocusLocation` 按“图像宽、高、x、y”解析，以其自带宽高归一化，再按 EXIF 方向转换；`FocusFrameSize` 用于命中框。原生指标有效率低主要是历史 run 只有 31 张有可用脸部 ROI，且其中部分没有可靠眼部关键点；无脸或无眼部 ROI 时保持 `na`，不猜测。

T-syn/标准 bench compare 本轮未完成：用户已撤回 `bench.mjs` 的捷径并在后台执行真实 compare，本轮没有修改或运行 `scripts/bench.mjs`，因此不能把旧报告复制或硬写 delta 当作验证结果。眼部局部失焦类别和全部类别的真实偏好准确率、总体偏好、严重档 gate、源图误淘汰的本轮对比均记为“未完成”，待后台真实报告。

建议：继续默认关闭 L0 gate。候选阈值仅用于提示草案：在有可靠眼部 ROI、组内至少一张清晰参照且 native focus 有效时，眼部 Laplacian 低于组内中位数的 0.35 倍且同组最高/当前比值低于 0.5，可提示“严重眼部失焦”；AF 点偏离主体/眼部只作为附加提示。动感模糊、有意虚焦、无眼部 ROI、单张组和 `na` 不自动淘汰。正式启用前仍需留一/T-syn 扩充不同脸部尺寸、运动模糊和真实人工标签，并验证源图误淘汰不升。

## 端到端模拟选片（W8，2026-10-11）

以下先保留第一轮历史证据；第二轮结果见本节末尾。

真实 Edge headless + 本项目 HTTP 服务已跑通完整流程。20 项检查均有真实结果，但验收未全通过：**16 通过、4 失败、0 未执行，0 执行错误**。
最终代跑编号 `1791697597`，执行目录 `/tmp/w8-simulate-qa/execution-wo8lcy`。
指定完整 Node 回归 **350 通过、0 失败、1 跳过（351 项）**，退出码 0；`git diff --check` 通过。
代跑及回归子进程实际 nice 均为 15（比 10 优先级更低）；脚本保留已有低优先级，不主动调高。

在本 worktree 一条命令执行：

```sh
W8_BROWSER='/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge' scripts/simulate-culling.sh
```

不指定 `W8_BROWSER` 时尝试下载 Chromium。Playwright、npm 缓存、浏览器下载均在 `/tmp`，不改 package.json。
必要时使用 `HTTPS_PROXY=<HTTP_PROXY>`；可通过 `W8_POLICY=/tmp/my-policy.json`、
`W8_QA_OUT=/tmp/another-output` 覆盖策略和输出。默认策略固定 seed 808，暗调紧裁→亮调松裁，
误点 6%、AI 锚定 12%、每 10 组一天，每 17/23/19 组安排并列／整组拒绝／撤销，每 10 组训练；
30 组后切换偏好并冻结旧 head，先检查漂移，再重训。锚定读取页面实际首选，AI 隐藏时不锚定。
默认 `regression:true` 在浏览器、服务关闭后串行执行指定 Node 回归；自定义策略可关闭此项。

沙箱浏览器无法启动时使用用户准备的代跑器：`touch /tmp/w8-runner/request`；
每次至少间隔 15 秒读取 `/tmp/w8-runner/status`，上一轮结束后才能再次触发。
代跑日志和断言副本为 `/tmp/w8-runner/result-<id>.log`、`assertions-<id>.json`。
脚本记录每一步 start/done/fail、请求类型、POST 参数及响应码；失败保存对应步骤的截图与页面 HTML。
普通决定等待 15 秒，训练及整组理由的串行反馈等待 60 秒；超时记录实际失败，不跳过动作。

输入复用独立 worktree 的汕头 `data/runs/run-1791589678002` 和完整 T-syn 缓存（20 源图、388 图像）。
缺缓存即中止，模拟 pipeline 禁止冷模型调用。共 62 个多张组：58 组按策略审阅，另 2 组由双标签同时操作，
最后 2 组留给批量接受和撤销。全部决定、训练、profile、回滚、理由与扫描均由真实按钮／键盘操作触发。
HTTP GET 与文件读取仅用于检查，fixture 的预置与特征索引不是模拟用户决定。

每轮使用独立 `/tmp/w8-simulate-qa/execution-*/data/` 保存 run、decisions、事件、特征、快照。
缓存代理复制到该执行目录的 `photos/`；共享 `data/cache` 仅读取，原片和「未删减」不操作。
端口从 43200 选择，本轮 stub/service 为 43200/43201，不影响 43128。
服务注入模拟日期；墓碑只来自 stub 库存移除，不删除文件。仅特征重训暂时重命名模拟代理副本目录，finally 恢复。
Eagle stub 本轮收到 **4 个请求**：`GET /api/library/info` × 2；
`GET /api/item/list` × 2（offset 0、500，limit 500）。任何写请求／未知读取立即返回 405，并使断言失败。

产物在 `/tmp/w8-simulate-qa/`：`assertions.json`、`index.html`、`initial.png`、`final.png`、
`events.jsonl`、`learning-curve.json`、`performance.json`、`node-tests.log`（执行回归时）。
每次清理固定输出，失败证据保留在各自 execution 目录，避免混入旧截图／报告。

| 检查 | JSON 名称 | 结果 |
|---|---|---|
| 默认 L0 排序与建议（HTTP 精确比较及页面顺序） | default-baseline | 通过 |
| 候选集开关 | candidate-toggle | 通过 |
| 每次决定的事件、曝光关联及键盘动作前 DOM 核对 | event-actions-exposures | 通过 |
| 并列、理由、category | tie-reason-category | 通过 |
| 撤销事件 | undo | 通过 |
| 多天注入时钟 | multi-day-clock | 通过 |
| 关闭重开恢复 | reopen-restores | 通过 |
| 双标签保存及随后批量接受／撤销 | two-tabs | 通过 |
| 随动作数记录学习曲线 | training-curve | 通过 |
| 未验证快照阻止应用 | gate-block | 通过 |
| 验证快照允许应用 | gate-allow | 失败 |
| 应用后 L0 闭眼／硬伤门槛 | l0-hard-gates | 失败 |
| profile 隔离与重开恢复 | profile-isolation | 通过 |
| 快照权重回滚 | snapshot-rollback | 通过 |
| 排序回滚恢复 | ranking-rollback | 失败 |
| stub 删除库存与墓碑 | deletion-tombstones | 通过 |
| 照片不可用时仅特征重训一致 | feature-only-retrain | 通过 |
| 偏好切换后的漂移提示 | drift-after-switch | 失败 |
| 逐次 UI 响应及训练耗时 | ui-performance | 通过 |
| Eagle 只读请求 | no-eagle-writes | 通过 |

四项失败的解释：

- `gate-allow`：10/20/30 组及切换后、墓碑后训练均为 `ready:false`，原因都是 `no-stable-heldout-improvement`；
  脚本没有伪造允许应用的快照。这是本场景未满足正向覆盖前提，不证明允许分支有产品缺陷。
- `l0-hard-gates`、`ranking-rollback`：没有实际应用个人排序，应用后的硬门槛和排序恢复正向验收**未完成**，按要求明确记失败。
  快照权重回滚已通过，不能替代排序回滚。
- `drift-after-switch`：旧 head 上两段各 25 组，一致率 0.60→0.24，下降 0.36；
  区间分别 [0.40,0.80]、[0.08,0.40]，在 0.40 相接，未满足 `previous.lower > current.upper`，
  所以返回 detected=false，页面没有警告。保留保守门槛，不为让模拟通过而放宽。

本轮修复／定位：

- 第 17 组 `key:3` 请求确实发出，200 到达超过 15 秒；每张预览和 feedback 重复解析约 35.74 MB results，阻塞服务。
  新增最多保留两个 run 的单元索引，合并并发读取、按文件替换失效、返回脱离缓存的副本；
  preview/detail/face/focus-crop/feedback 使用单元读取，保持完整 analysisSignature，重放最新分组覆盖。
  decisions 避免重复全量读取，学习状态／训练／回滚只读 run 元数据，未验证 apply 提前拒绝；results 改紧凑 JSON。
- 旧个性化横幅每次决定都会评估；单个留出标注竟重排整个 run。现在只重排参与评估的组，验证结果不变。
- 陈旧标签页的批量接受可能覆盖另一标签的人工选择，撤销也可能清空它：批量前读取最新 decisions，再定义未审目标及撤销快照。
  浏览器已验证两标签选择在批量接受及撤销后仍保留。
- 第 47 组理由 chip 的等待条件正确，但 19 张反馈及修订串行，最后一条在原 15 秒后到达；
  属于批量等待预算不足，不是前端漏发。最终复验该步骤末条 201 实测约 8.5 秒（前次完整复验 11.4 秒）。
- 同组滚动后仍沿用初次 viewport：曝光去重键现包含 viewport，曝光请求按顺序发送，决定前等待对应曝光持久化。
  224 次决定均有新事件；159 次数字键动作将输入前真实 DOM 的顺序、viewport、AI 可见性与关联曝光逐一比较，0 不一致。
  学习操作等待面板显示对应状态；曝光单测也验证 viewport 改变及未完成请求的串行等待。

前一提交准备阶段修复的并发持久化、重复曝光丢胜者、关闭 L1／切 profile 的精确 L0 恢复、profile 重开丢失，
以及注入时钟合同保留在本分支；当前浏览器结果与单测分别提供对应证据。
新索引回归覆盖并发合并读取、调用方隔离、原子替换失效和分组覆盖；评估回归确保无关组不参与排名。
定向测试 33/33 通过（加入 viewport 回归之前）；最终完整回归包含该新增测试，350 通过、0 失败、1 跳过。
实际执行参数为 `node --test --test-concurrency=1`
`--test-skip-pattern='fixture face detection recall|fixture grouping reaches'`，完整日志在 `node-tests.log`。

性能来自本轮 224 次决定与 6 次训练的逐次记录，不设人为通过值。决定延迟包含输入、HTTP 持久化和人工标记显示；
训练延迟包含 HTTP 特征读取、训练／留出评估和面板更新，不是纯拟合 CPU 时间。
决定中位数 **1.23 s**、P95 **3.35 s**、最大 **5.80 s**；训练中位数 **5.35 s**、范围 **1.02–6.93 s**。
学习曲线检查点的决定动作数为 **40、78、115、224、224**（后两项分别是切换后与墓碑后），对应审阅过 10/20/30/60/60 组；
审阅过包含后来撤销或部分确认的组，最终界面完整确认计数为 55/62。两条墓碑真实写入本轮事件日志，代理不可用重训权重与数据摘要均一致。

限制：模拟用户仅验证流程，不能证明真实摄影师偏好效果；同源缓存、噪声和门槛可能使学习不获准应用。
原片真实删除后的训练、原生 1:1 放大镜、真实摄影师效果及自由文本理由入口**未完成**。
理由 chips 进入独立 feedback，learning 的 tie/reason/category 核对的是并列／整组拒绝附带理由。
双标签保证范围是同一个 Node 服务；多服务进程共写目录不在此次验证范围。

Git 暂存／提交未完成：无法创建主仓库 `.git/worktrees/w8-simulate/index.lock`，沙箱返回 Operation not permitted。
本轮源码、脚本、测试、文档改动保留在 w8-simulate；没有 push。

### 第二轮：正向应用、漂移与响应速度

最终结果：**20 通过、0 失败、0 未执行，0 执行错误**。代跑 `1791700119`，退出码 0；
独立数据目录 `/tmp/w8-simulate-qa/execution-2cJ4yk`。指定 Node 回归 **356 通过、0 失败、
1 跳过（357 项）**，退出码 0，耗时 66.93 s；模拟与回归 nice 均为 15。
924 次决定（汕头段 224、合成段 700）、8 次训练均有逐次性能记录。
事件核对没有漏记，159＋350 次数字键输入的真实 DOM 曝光顺序／viewport／AI 可见性没有不一致。

一条命令不变，默认策略现在串行执行两个隔离 run/profile：

1. 汕头＋原 T-syn 的 62 组场景，保留噪声、锚定、并列、拒绝、撤销、双标签、删除墓碑与
   离线重训检查；训练之后再次启用并点击应用，验证留出未改善时仍返回 409。
2. `run-w8-strong`／`strong`：362 个构造组。复用缓存 T-syn s001 的代理与特征模板，
   构造暗／紧、亮／松、中性三种指标对比；质量对比让 L0 首选中性候选。
   每个 JPEG 在 EOI 后附加模拟记录标识，SHA-256 来自实际代理字节；产品按这些 ID 进行
   时间／内容留出检查。代理像素仍同源，不是独立真实照片，构造标签／指标不能作为视觉泛化
   或真实效果证据；所有数据明确标注 synthetic-workflow-fixture。
3. 120 组一致暗调选择（零噪声／锚定）→面板训练／启用／应用→50 组稳定期→180 组亮调
   选择→重训／应用→回滚早期快照并重新应用。每 25 组关闭／重开，稳定期每 5 组查看一次。
   默认切换时注入 365 天间隔，面板将半衰期设为 3 天，以验收既有衰减机制；这些都是
   策略／时钟操作，没有修改应用门槛。noiseRate、anchorRate、批次大小、天数间隔和半衰期可配置。
4. 12 个未审留出组另含闭眼与严重模糊候选。闭眼采用明确的旧版计数合同；模糊指标取
   实际 `sharpnessBelow` 的十分之一（当前阈值 0.005，样本 0.0005）。
   验证软偏好高于正常候选的硬伤帧仍排在通过者之后，并将浏览器 DOM 顺序与真实 HTTP 排序核对。
   正反向排序改变后，比较 12 组 `JSON.stringify([ranking,suggested])` 的字节及汇总 SHA-256，
   同时核对回滚后的 DOM 顺序；不把其它已审组／时间元数据变化误称整份 results 文件恢复。

漂移改为直接对两个独立窗口一致率之差做 2000 次 bootstrap，单侧 95% 下界 >0 且下降
至少 0.2 才提示。仍只提示，不自动重训或应用。报告分别记录稳定期的 10 次重叠浏览器窗口
误报，以及 seed 919 的函数层平稳 Bernoulli 校准（每种一致率 200 个独立窗口）；后者不是浏览器
操作或真实摄影师误报率。长期两窗口都不匹配旧 head 时差值会归零，本提示不是持久告警。

性能保留每次决定、每次训练的实际值。输入事件→收到持久化响应并确认 DOM 的 nativeUiMs
与包含 Playwright 调度／等待的 automationResponseMs 分列；分别要求两个场景单次决定
P95 <300 ms，批量及理由修订的完整脚本耗时 <2 s。Server-Timing 记录 run、decisions、learning
阶段；没有提前确认未持久化事件。数据文件版本缓存、特征映射复用、词表／反馈缓存、UI 索引
及局部 DOM 更新减少重复工作；旧横幅在空闲 5 秒后拟合。decisions 仍原子全量写，没有引入 journal。
模拟器增量读取 JSONL，并不再将每次全量决定响应重复留在报告内，减少同进程 GC 干扰。

产物继续位于 `/tmp/w8-simulate-qa/`：`assertions.json`、`performance.json`、`learning-curve.json`、
`events.jsonl`、`index.html`、`initial.png`／`strong-final.png`、`node-tests.log`；每轮独立 execution
目录保留原始 decisions、学习事件、feedback JSONL、特征与快照。所有步骤及失败截图仍保留，
没有模拟动作直接修改这些存储；fixture 预置、纯函数统计校准与只读检查不作为浏览器行为。

限制仍包括真实摄影师效果、真实 Eagle 只读库验收、真实原片删除、原生 1:1／眼部 ROI 门槛
及自由文本理由入口；本轮目标是流程与性能，不证明构造偏好对真实照片有效。

第二轮断言结果（全部为本次真实代跑，不复用第一轮断言）：

| 检查 | 结果与证据 |
|---|---|
| 默认基线／候选开关 | 通过，初始排序与建议保持 L0，真实按钮开关 |
| 动作／曝光／并列／理由／分类／撤销 | 通过，924 决定均关联新事件；数字键曝光 509 次，0 不一致 |
| 多天／重开／双标签 | 通过，决定恢复；两个标签选择经历批量接受及撤销仍保留 |
| 学习曲线／拒绝门槛 | 通过，汕头训练仍不放行；启用后实际应用返回 409 |
| 正向应用／L0 保护 | 通过，初次训练的 72／48 与 96／24 两切分提升区间均 [1,1]，应用改变 242 个未审组；12 组软偏好高的硬伤帧仍最后 |
| profile／快照／排序回滚 | 通过，亮调重训后排序反转；回滚后 12 组排序＋建议字节及浏览器顺序一致 |
| 删除墓碑／仅特征重训 | 通过，stub 库存移除产生墓碑，模拟代理不可用时重训权重与数据摘要一致 |
| 漂移／稳定期 | 通过，汕头 0.60→0.24，差值单侧下界 0.12；合成切换后 25 组提示，稳定期 0／10 次误报 |
| 性能／Eagle 只读 | 通过，两场景 UI 单次 P95 均 <300 ms；所有批量／理由修订 <2 s，stub 0 写请求 |

排序回滚前后的 SHA-256 均为
`7e64da8e2d46d17612552bd129b36c5b8199821ece8809897710ec7a6cbc7acc`。
合成学习曲线在 240／700 个决定动作（120／350 组）训练后记录；切换后的前缀
10／25／50／100 组在 106 个留出组上的一致率为 0，200 组前缀为 1。
这是构造场景的真实计算结果，不证明真实照片上的学习效果。

误报校准：稳定浏览器窗口 0／10（这些窗口重叠，不是独立误报概率估计）；
函数层平稳一致率 0.24／0.60／0.90 下分别为 9／200、4／200、3／200，即
**4.5%、2.0%、1.5%**。保留检验近似与重复查看的限制，不声称普遍零误报。

性能对比：

| 口径 | 第一轮 | 第二轮汕头段 | 第二轮合成段 |
|---|---:|---:|---:|
| 全部决定脚本总耗时中位数 | 1227 ms（224 次） | 251 ms（224 次） | 428 ms（700 次） |
| 全部决定脚本总耗时 P95／最大 | 3350／5802 ms | 704／1001 ms | 831／1062 ms |
| 单次决定原生 UI 中位数／P95／最大 | 未单独记录 | 172／268／874 ms（163 次） | 234／259／638 ms（350 次） |
| 单次决定 Playwright 总耗时 P95 | 未按此子集汇总 | 399 ms | 479 ms |
| 批量操作总耗时最大 | 理由修订曾 11.4 s | 1001 ms | 1062 ms |
| 训练耗时中位数／范围 | 5.35 s／1.02–6.93 s | 2.77 s／0.64–4.70 s（6 次） | 1.97 s／1.01–2.92 s（2 次） |

本次两个理由修订为 389、889 ms。汕头决定链路的 run／decisions／learning 阶段
中位数分别 1.20／3.86／11.32 ms，P95 分别 7.98／11.21／28.04 ms。
原生 UI 的 P95 达标，但存在 874／638 ms 尾部；Playwright 调度总耗时的 P95 仍超过
300 ms，两种口径不能混写。第一轮到第二轮的总耗时比较也包含采集器优化，并非纯产品
隔离 A/B；逐次原始值、阶段计时和场景分组都留在 performance.json／assertions.json。

发现及修复：

- 每次决定重复解析整份 run、重写特征分组索引；改为按文件版本／输入上下文复用缓存。
  profile 学习只读取本 profile 的事件／特征，旧横幅的每键拟合改为空闲去抖。
- 完整卡片／缩略图重建和重复线性查找；用状态索引与按内容更新的 DOM 节点减少重排。
  feedback／词表重复文件读取，改为版本缓存与保序追加；decisions 原子写与学习日志持久化语义未变。
- 回归发现新增缓存漏 run 身份、DOM 替身缺 children、refresh 返回契约被去抖破坏，已修复；
  新测试覆盖调用方隔离、跨实例失效／串行、损坏历史、UTF-8 分片与并发证据读取。
- 初次合成“失焦”样本 0.01 未跨当前 0.005 硬门槛，导致 18 通过／2 失败；
  修正为从实际配置派生的 0.0005，补 DOM 与软分／硬层核对，未改产品门槛。
- 采集器重复解析整日志并积累全量决定响应，改为增量 JSONL 读取与精简响应证据，
  完整原始决定、事件与 feedback 仍保存在执行目录，没有伪造断言或复制旧报告。

本次 stub／服务端口为 43200／43201，未使用 43128。stub 收到全部 4 个请求：
`GET /api/library/info` ×2；`GET /api/item/list?offset=0&limit=500` ×1；
`GET /api/item/list?offset=500&limit=500` ×1。没有任何 Eagle 写请求；共享 cache 仅读，
模拟数据／决策／特征／偏好／事件全部位于本次 /tmp 执行目录，未操作原片或「未删减」。

第二轮最终 `git diff --check` 通过。尝试暂存本轮源码、脚本、测试和文档时，沙箱无法创建
主仓库 `.git/worktrees/w8-simulate/index.lock`（Operation not permitted）；改动保留在本
worktree，未提交、未 push。

## 真实 Eagle 只读验收（W10）

执行 `nice -n 15 node scripts/simulate-culling.mjs --real-eagle`；浏览器路径由
`W8_BROWSER` 设置，Playwright 可由 `W8_PLAYWRIGHT` 设置。库路径从不入库的
`config/local.json` 或环境变量读取，先硬校验当前库。
`W10_EAGLE_URL` 默认本地 Eagle，`W10_FOLDER` 默认既有汕头文件夹；
`W10_RUN_SOURCE`、`W10_POSE_CACHE` 可指定已存在的分析/姿态缓存。

`eagle-readonly-proxy.mjs` 只转发明确列举的 GET；未知读取、写请求及重定向均不转发。
真实模式记录全部请求与各方法/路径次数，任何拒绝记录使验收失败。
先运行实际 CLI doctor，再通过 `AnalysisPipeline.run` 串行迁移并重放已核对原片元数据、
真实文件夹成员的历史特征缓存；缓存缺失不冷跑模型。代理预览和所有新缓存、run、决定、
事件、特征、profile 仅写本轮临时目录。原生 focus 单独限制到按单元 ID 排序等距采样的 80 张子集，
复用既有 RTMW 坐标，记录前后人脸框估算/明确关键点/原生测量覆盖率与已知 AF 命中。
AF 命中表示点或 AF 框与眼部 ROI 相交，不是人工确认的对焦准确率。

浏览器执行少量保留/淘汰、自由文本与输入焦点检查、学习面板训练、原生脸/眼部 1:1
图像加载及 CSS 像素核对、读取报告链接导出。少量决定不要求学习获准应用。
原片操作仅读取，前后 SHA-256 核对所有参与文件；绝不调用 Eagle 写回/删除。
产物在 `/tmp/w10-real-eagle/execution-*/`，本次汇总为 `/tmp/w10-real-eagle/latest.json`；
80 张联系表与统计在 `/tmp/w10-eye-qa/`，不入库。

沙箱不能启动服务/浏览器时，向 `/tmp/w10-runner/request` 写入 `--real-eagle`，
用户的外部代跑器写回 status 和独立结果日志。必须查看实际日志和汇总后报告通过；
旧结果、未完成步骤及缓存模型分数均不能冒充本轮端到端或视觉质量证据。

### 当前执行证据与未完成项

真实首轮已读取 426 文件 / 213 单元，库硬校验、doctor、缓存特征分组排序、缩略图、
少量自由理由决定、学习训练与原生眼部 1:1 通过。报告导出因验收脚本误用 Fetch `ok`
而失败，已修复；首轮不计完整验收通过，最终 Pipeline 回放/80 张前后统计复验待代跑。

第一次完整指定 Node 回归 361 通过 / 1 失败，唯一失败为新增行长超限，已修正。
沙箱定向执行 `nice -n 15 node --test --test-concurrency=1`
`--test-skip-pattern='actual proxy' test/w10-eagle.test.js test/style.test.js`，6 通过 / 0 失败；
真正代理 socket 的新增测试以及完整回归复验仍待外部代跑。
`nice -n 15 node scripts/check-public-release.mjs` 为 0 命中，`nice -n 15 git diff --check` 通过。

已实际运行 `nice -n 15 node scripts/bench.mjs --compare`
`data/cache/bench/reports/2026-10-11T03-11-11-048Z/report.json`，
新报告为 `data/cache/bench/reports/2026-10-11T07-32-57-080Z/report.json`：
368 对偏好准确率 0.9646739130、严重问题 gate 101/112、源图误淘汰 1/20，三项差值均 0。
报告实测生成，但 CLI 计算后未退出，代跑器仍被阻塞；不能计为命令成功退出。
已修正 CLI 在全部文件持久化后退出，并增加 `EAGLE_BENCH_CACHE_ONLY=1` 拒绝冷算。
必须记录资源约束偏差：首次配置指纹变化使 388 张合成图本机重算，未按要求交给 Ray。
真实 Eagle 原片未冷跑模型；不把合成基准重算描述成缓存命中或合规 Ray 执行。

## W10：十万单元结果加载、分页与阶段续跑（2026-10-11）

新 run 使用 16 MiB 目标大小的不可变 JSONL 分片及 ID→字节偏移索引；索引只保存偏移、
组摘要和分析签名。单组/单元、图片、组列表和流式报告无需物化完整结果。
旧 `results.json` 只读兼容；旧 fingerprint JSONL 流式索引，新缓存原子单记录写入。
分页/过滤、20 组审阅页、各阶段检查点和取消边界见 [contracts](contracts.md#w10分段结果分页与阶段续跑主契约仍为-v1)。
局部决定/曝光只加载完整相关组，学习组索引合并其它页的上下文。

### 实际 Ray 测量

最终作业 `w10-scale-stress-fc56a27c1981` **SUCCEEDED**，墙钟 86.48 秒。
2 CPU、8 GiB、0 GPU，affinity 限 2 核；Node heap 2048 MiB、RSS 3 GiB 守卫，Sharp 并发 1。
Node 22.14.0 下载通过 SHA-256 校验；worker nice 15，三档串行，无真实照片/模型推理。
ONNX Runtime 安装显式 `ONNXRUNTIME_NODE_INSTALL=skip`，使用包内 CPU 库，跳过额外组件下载。
[测量快照](testing-data/w10-scale.json)仅包含公开指标，不包含基础设施路径或原始日志。

| 合成单元 | 结果字节数 | 冷首屏 HTTP ms | 单组 HTTP ms | Node maxRSS MiB | 进程组采样峰值 MiB | 实际 pipeline 续跑 ms |
|---:|---:|---:|---:|---:|---:|---:|
| 10,000 | 457,991,545 | 227.97 | 26.15 | 214.80 | 208.05 | 636.50 |
| 50,000 | 2,290,708,599 | 268.05 | 15.01 | 361.54 | 361.54 | 2,713.40 |
| 100,000 | 4,581,651,378 | 379.76 | 16.33 | 525.03 | 525.03 | 5,268.06 |

存储负载每单元约 45.8 KB：合成 embedding/measurements/geometry 数值数组，不是模型输出。
10 个单元一组；首屏 20 组，单组 10 个单元。冷首屏从新 RunStore 的 HTTP 请求开始，
包括索引读取、响应序列化和客户端 JSON 解码；单组在首屏后的热索引上测量。
这不是浏览器绘制时间，也不是冷磁盘/隔离 A/B 测试。每档单次观测，不声明 P95。

续跑测量真实调用 AnalysisPipeline：持久化轻量合成特征及已完成的分组检查点，
在进入排序时通过 AbortSignal 中断；重新打开 Checkpoints，跳过完成的特征阶段并完成排序。
断言最终单元/组数相符，analyzer 若被调用立即失败。续跑包括检查点索引重建、按单元读取、
fingerprint 核对和实际排名/候选集计算。它使用轻量合成特征，**不包含上述 45.8 KB 单元载荷、
真实模型推理、Eagle 扫描或原生 RAW 解码**；不能据此宣称十万真实照片完整分析已满足内存上限。
Node maxRSS 覆盖该档存储、HTTP、检查点生成、取消及续跑全过程；0.2 秒进程组采样可能遗漏瞬时峰值。

早期两次仅存储/HTTP/日志重放作业分别为 `9b3418c8dcea`、`9fa1919c9733`（同 w10 前缀），均成功；
不把日志重放替代实际 pipeline 续跑。`0238b6751b4c` 在 npm 准备阶段 FAILED，无压测结果；
停止请求返回 false，随后加安装 skip 重试成功。最终本线四个作业均终态，**无 RUNNING/PENDING**；未操作其它作业。

可复现入口（当前 stress-ray 脚本测 W10；W6 节保留历史测量）：

```sh
nice -n 15 node --max-old-space-size=2048 scripts/stress-results.mjs --units 100 --output /tmp/w10-final-smoke.json
source ~/.config/eagle-culling/env.sh
nice -n 15 python3 scripts/stress-ray.py submit
nice -n 15 python3 scripts/stress-ray.py status --id <本线作业ID>
nice -n 15 python3 scripts/stress-ray.py collect --id <本线作业ID>
nice -n 15 python3 scripts/stress-ray.py audit
```

本机仅 100 单元冒烟：首屏 593.97 ms，单组 98.32 ms，实际 pipeline 续跑 151.63 ms，
maxRSS 133.25 MiB。所有本机入口显式 nice 15；沙箱拒绝调整优先级，实际继承 nice 20。
没有本机万级压力或冷跑全库模型，未访问/写回 Eagle、未修改原片或保护库。

### 回归与质量

实际执行：

```sh
nice -n 15 node --max-old-space-size=2048 --test --test-concurrency=1 --test-skip-pattern='fixture face detection recall|fixture grouping reaches'
nice -n 15 python3 -m unittest scripts/test_stress_ray.py
PYTHONPATH=/tmp/w2-bench-pose EAGLE_POSE_PROVIDER=CPUExecutionProvider nice -n 15 node --max-old-space-size=2048 scripts/bench.mjs --compare data/cache/bench/reports/2026-10-11T03-11-11-048Z/report.json
nice -n 15 node scripts/check-public-release.mjs
nice -n 15 git diff --check
```

完整 Node：**362 pass / 0 fail / 1 skip，363 项，129.06 秒**；收尾定向回归 29/29。
Python 打包 unittest 1/1；公开检查 0 命中；diff check 通过。
新回归覆盖分页/过滤、偏移读取禁止完整结果物化、旧格式、跨实例失效、调用方隔离、
共享旧缓存尾部不改动/私有检查点尾部修复、取消/重启续跑、HTTP 续跑、报告 backpressure、
CSV/JSON 分页以及局部学习保留其它组上下文。

本次 bench 报告 `2026-10-11T07-32-57-080Z`，与指定最新同清单基线比较：
偏好准确率 96.47%、严重 gate 90.18%、源图误淘汰 5%；**三项 delta 均 0，368 对 unchangedRows=true**。
清单 SHA-256 相同，388 个图像字节均实际核对；扫描/取消钩子改变了代码缓存签名，
先串行重算像素指标/规则，复用原缓存的人脸/姿态/TOPIQ 输出刷新分析缓存，再真实运行 bench compare。
bench 显示 0/388 uncached，并实际重验 TOPIQ 文件及一次推理预检；不是复制旧报告或硬写 delta。
T-triage 仍 unavailable，真实审美效果未验证。

未完成：浏览器首屏渲染测量、十万真实模型全流程及完整重扫描/全阶段计算续跑压测、
统一生产资源调度、分片 generation/阶段日志自动回收，以及大型全 run 学习/修组物化接口进一步改造。
Sharp/ONNX 单次调用只在返回边界取消；进程中断可恢复，不提供断电 fsync 保证。

Git 收尾：尝试暂存上述改动时，沙箱拒绝创建 `.git/worktrees/w10-scale/index.lock`。
改动保留在 w10-scale，未暂存/提交、未 push。

## W11：合并后 Ray 真实冷算 bench（2026-10-11）

入口、环境与采集协议见 [bench-ray.md](bench-ray.md)，公开指标快照见
[testing-data/w11-raybench.json](testing-data/w11-raybench.json)。没有修改排序、规则或缓存签名算法；
bench 仅导出原有 analysisSignature，Python 符号链接补充 gitignore。

最终作业 `w11-raybench-ddcc847bce36` SUCCEEDED，720.207 秒；预留 2 CPU、0 GPU、8 GiB。
全部 388 张合成图在 Ray 冷算像素指标、TOPIQ、人脸、姿态与 signals/rules。
打包不包含旧分析缓存；五个模型和全部分析源代码逐文件核对 SHA-256。
两端签名均为 `85c08e66e3aca776001b685ee8d3d114957d63d477de69b73e18f53741c8fe63`。
388 条缓存按原有键导入；完整传输及每条 JSON 的 SHA-256 均通过，模型警告为空。

实际执行：

```sh
source ~/.config/eagle-culling/env.sh
nice -n 15 python3 scripts/bench-ray.py submit
nice -n 15 python3 scripts/bench-ray.py submit --reuse-assets w11-raybench-2ff9b78efd20
nice -n 15 python3 scripts/bench-ray.py status --id w11-raybench-ddcc847bce36
nice -n 15 python3 scripts/bench-ray.py collect --id w11-raybench-ddcc847bce36
unset PYTHONPATH EAGLE_POSE_MODE EAGLE_POSE_MODEL EAGLE_POSE_DETECTOR
EAGLE_PYTHON=python_worker/.venv/bin/python EAGLE_POSE_PROVIDER=CPUExecutionProvider EAGLE_BENCH_CACHE_ONLY=1 nice -n 15 node --max-old-space-size=2048 scripts/bench.mjs --compare data/cache/bench/reports/2026-10-11T03-11-11-048Z/report.json
nice -n 15 python3 scripts/bench-ray.py audit
nice -n 15 node --max-old-space-size=2048 --test --test-concurrency=1 --test-skip-pattern='fixture face detection recall|fixture grouping reaches'
nice -n 15 python3 -m unittest scripts/test_bench_ray.py
nice -n 15 python3 -m py_compile scripts/bench-ray.py scripts/test_bench_ray.py
nice -n 15 node scripts/check-public-release.mjs
nice -n 15 git diff --check
```

本机日志为 **0/388 uncached**，新报告
`data/cache/bench/reports/2026-10-11T14-39-30-841Z/report.json`。
清单 SHA-256 相同；368 对，unchangedRows=false。历史跨平台比较出现准确率下降；
该比较不作为 w10 同平台质量门槛，后续同平台控制见下节：

| 指标 | 新结果 | delta |
|---|---:|---:|
| 偏好准确率 | 354/368 = 96.19565% | -1/368 = -0.27174 百分点 |
| 严重 gate | 101/112 = 90.17857% | 0 |
| 源图误淘汰 | 1/20 = 5% | 0 |

全部判定变化共两行：

- `s006-excess-headroom-0.5`：gateRejected/standaloneGateRejected 从 true 变 false，
  pairDecision 从 rejected 变 selected；credit 仍为 1，sourceRejected 仍为 true。
  RTMW 左眼 EAR 0.282843 → 0.328798，跨过既有 0.30 门槛；右眼 EAR 仍约 0.285714。
  现有 assessClosedEyes 将闭眼从 gate 降为提示。该行 expectedGate=false，未改变严重 gate 总数。
- `s014-horizon-tilt-8`：credit 1 → 0，pairDecision candidate → selected，gate/sourceRejected 均未变。
  新姿态下左膝在图内接近下沿，现有 measurementPoints 压缩小腿有效性检查使膝/脚测量弃权；
  P-CROP-KNEE、P-CROP-ANKLE-FOOT 两项 violate 消失，罚分 0.035 → 0.015。
  退化分 0.5718 → 0.5918，超过源图 0.5865；TOPIQ 仅约 3e-7 差异，不解释 0.02 分变化。

另有四行仅退化分变化，credit/gate/sourceRejected/pairDecision 均不变。
完整六行逐字段差异见 [w11-raybench-row-changes.json](testing-data/w11-raybench-row-changes.json)。

| 行 | 退化分前 → 后 | 不再触发的罚分规则 |
|---|---:|---|
| s006-motion-blur-41 | 0.3265 → 0.3365 | P-CROP-ANKLE-FOOT |
| s007-noise-50 | 0.3948 → 0.4048 | P-CROP-ANKLE-FOOT |
| s007-face-highlight-clipping-2.5 | 0.5684 → 0.5784 | P-CROP-ANKLE-FOOT |
| s013-defocus-blur-1 | 0.5743 → 0.5843 | P-CROP-KNEE |

这些行同样是姿态测量/有效性改变后减少既有裁切罚分；没有 w10 排序或规则函数变更。
P-CROP-TIER 也由 violate 变为不可判定，但该规则不收费。

因果核对：合并后的相同 evaluate/ranking 代码直接读取原基线缓存，仍得到 96.46739%、
101/112、1/20，并复现两行原判定。因此变化来自新测得的姿态证据，不能据此归因于 w10 排序改动。
w10-eagle 的眼部 ROI 用于 focus/pipeline/查看器，常规 bench 不调用该路径；其 bench 改动仅
cache-only 冷算保护和退出行为。w10-scale 在 metrics 的改动是 Eagle 扫描/检查点，在 scorer
增加可选取消检查；bench 无 Eagle 扫描且未传 AbortSignal。两个提交均未改 ranking、signals、
eye-assessment 或姿态 worker。旧 PYTHONPATH 与当前本机 rtmlib 的 39 个 Python 文件 SHA-256
全部一致。跨平台 ORT/OpenCV 数值与姿态离散坐标敏感性是候选原因，底层原因尚未唯一定位；
没有为追平指标复用旧模型输出、改签名或改规则。

前三个作业依次因 OpenCV 缺 libGL、MediaPipe 缺 EGL 等运行环境问题终态 FAILED，
未导入不可用结果；用同 release 的 OpenCV headless 和作业临时 EGL/GLES 运行库解决。
四个作业均终态，audit 确认本线 RUNNING/PENDING 为 0；没有操作其它作业。

回归：Node 369 pass / 0 fail / 0 skip，153.90 秒；Python 4/4，编译通过；公开检查 0 命中，diff check 通过。
本机命令均请求 nice 15；沙箱拒绝提升优先级，实测继承 nice 20。
资源约束偏差：首次打包上传与 Node 回归曾重叠执行，未完全串行；bench 图像冷算全部在 Ray。
该阶段尚未完成同平台质量验收；现已由下节补齐。跨平台模型输出位级等价验证、
底层数值差异唯一归因仍未完成；T-triage 仍 unavailable。

Git 收尾：实际尝试暂存本轮八个文件，沙箱拒绝创建本 worktree 的 index.lock；
改动保留，未暂存/提交，未 push。


## W11：合并前后 Ray 同平台控制（2026-10-11）

**质量门槛必须同平台比较**。本次未修改当前分支源码，用 `git archive 89701ae`
打包合并前 v1.0.0 等价树。原成功合并作业 `w11-raybench-ddcc847bce36` 与基线使用
同一未重启 Ray 节点、相同 runtime_env/资源包、Node/npm 和实际安装的 Python 依赖版本，
五个模型及 EGL/GLES SHA-256 均一致。完整版本、哈希和逐点证据见
[同平台公开快照](testing-data/w11-ray-same-platform.json)。

基线作业 `w11-raybench-baseline-078c4c0f6147` SUCCEEDED，721.988 秒，2 CPU、0 GPU、8 GiB。
388 张图真实冷算，388 条缓存逐条验证后隔离收集，原缓存与 Mac 基线没有覆盖。
原始报告：`data/cache/bench/ray-baselines/89701ae/w11-raybench-baseline-078c4c0f6147/report.json`。
基线签名 `9e4f405976d8e2c9a9ae5dadb09827e46cac1d2a36384ed69254e0f1c0c4fb8e`，
合并后签名 `85c08e66e3aca776001b685ee8d3d114957d63d477de69b73e18f53741c8fe63`；
两者分别由各自原代码生成并验证，未改签名。按图像摘要关联后，**388 条完整缓存内容全部相同**。

实际执行（driver/compare 位于不入库的隔离缓存目录）：

```sh
source ~/.config/eagle-culling/env.sh
nice -n 15 python3 data/cache/bench/ray-baselines/89701ae/driver.py submit
nice -n 15 python3 data/cache/bench/ray-baselines/89701ae/driver.py status --id w11-raybench-baseline-078c4c0f6147
nice -n 15 python3 data/cache/bench/ray-baselines/89701ae/driver.py collect --id w11-raybench-baseline-078c4c0f6147
nice -n 15 node data/cache/bench/ray-baselines/89701ae/compare.mjs w11-raybench-baseline-078c4c0f6147
nice -n 15 python3 data/cache/bench/ray-baselines/89701ae/driver.py audit
nice -n 15 python3 -m unittest scripts/test_bench_ray.py
nice -n 15 node scripts/check-public-release.mjs
nice -n 15 git diff --check
```

| 指标 | Ray 基线与 Ray 合并后结果 | 合并后减基线 delta |
|---|---:|---:|
| 偏好准确率 | 354/368 = 96.195652% | 0 |
| 严重 gate | 101/112 = 90.178571% | 0 |
| 源图误淘汰 | 1/20 = 5% | 0 |

**unchangedRows=true，368 行完整报告全部一致，质量门槛通过**。
这直接证明 w10 在本清单与受控 Ray 环境中没有改变质量结果，无变化行需要代码二分。
此前仅用新代码回放旧缓存不足以证明这一结论；本次补上了旧树真实冷算对照。

Ray 基线对历史 Mac 基线仍有六行变化：准确率 delta 为 −0.27173913 百分点，
严重 gate 和源图误淘汰 delta 为 0，unchangedRows=false。
下表列每行主体 133 个关键点中绝对差值最大的置信度变化（方向为 Ray 减 Mac）；
所有 798 组逐点置信度及门槛距离均保存在公开快照中。

| 行 | 点索引 | Mac → Ray 置信度 | delta |
|---|---:|---:|---:|
| s006-motion-blur-41 | 55 | 0.908354521 → 0.937454164 | +0.029099643 |
| s006-excess-headroom-0.5 | 116 | 0.626444936 → 0.621943355 | −0.004501581 |
| s007-noise-50 | 103 | 0.624356508 → 0.671190739 | +0.046834230 |
| s007-face-highlight-clipping-2.5 | 14 | 0.698688269 → 0.697839081 | −0.000849187 |
| s013-defocus-blur-1 | 21 | 0.255619943 → 0.256805331 | +0.001185387 |
| s014-horizon-tilt-8 | 124 | 0.900618196 → 0.883336425 | −0.017281771 |

相关门槛逐项核对（最大差值点未必是触发规则的点）：

- `s013-defocus-blur-1` 左踝（15）0.299392580986 → 0.300252974033，delta +0.000860393047，
  相对 0.3 门槛距离 −0.000607419014 → +0.000252974033，确实卡在阈值边缘并跨过门槛。
  现有压缩小腿有效性分支变化，膝罚分消失；credit 不变。
- `s006-excess-headroom-0.5` 相关眼部置信度 1 → 1，远离 0.6 门槛；
  左 EAR 0.282842712475 → 0.328797974611 跨过 0.30 几何门槛，最小眼像素
  8.673898 → 7.537992 均大于 6。gate 变化由几何证据触发，并非置信度跨阈值。
- `s014-horizon-tilt-8` 左踝 0.307263463736 → 0.305715441704，
  左跟（19）0.302376538515 → 0.305691510439，距 0.3 为 +0.002376538515 → +0.005691510439，
  接近门槛但没有跨过。几何/有效性分支减少膝脚罚分，分数超过源图，credit 1 → 0。
- 其余三行没有相关置信度门槛跨越；最近腿部置信度分别为
  0.505007148 → 0.486272723、0.499701917 → 0.492185742、0.526997805 → 0.526815355，
  均远离 0.3。既有几何/边界/腿有效性分支减少脚罚分，判定和指标不变。

缓存坐标已裁到 [0,1]，无法仅凭缓存重建原始越界坐标并唯一定位全部几何阈值。
Mac 历史运行环境未重建；本次证明上述差异在没有 w10 的旧树上仍存在，
不能唯一归因于某个操作系统、ORT/OpenCV 或数值库实现。平台/环境差异与代码质量门槛分别记录。

两次准备失败均终态：`w11-raybench-baseline-59a4a54ce011` 因 OpenCV 共享文件被卸载破坏预检，
按原成功安装顺序修正；`w11-raybench-baseline-fc1031a26a7b` 因外部 Node runner 缺少参数分隔符，
在整批分析前退出，修正并检查 argv 后重提。未导入失败结果。
最终 audit 本线七个作业全部终态，RUNNING/PENDING=0，未操作他人作业。
947 个原缓存、报告、源码与模型文件 SHA-256 核对无变化；本机仅打包、传输、缓存比较与验证，未冷算。

本轮 Python unittest 4/4，隔离 driver 编译和 compare 语法检查通过；公开检查 0 命中，diff check 通过。
完整 Node 369/369 为上一阶段实跑记录，本轮仅文档/证据变化，未重复运行模型或完整 Node suite。
未完成：历史 Mac 环境重建、跨平台底层数值差异唯一归因、T-triage 真实审美验证。
同平台对照与本清单质量验收已完成；未提交、未 push。


## W15：v1.2.0 候选 Ray 同平台质量门槛（2026-10-12）

候选提交 `73e401e6ff3db4bbc25517013e0d7273d16fae6c` 的作业
`w11-raybench-907408355f00` SUCCEEDED，733.899 秒，2 CPU、0 GPU。
复用 w11 终态资源包前重新核对完整 tar SHA-256；五个模型、24 项锁定 Python 依赖、
Node/npm 版本及 EGL/GLES 哈希一致，执行节点与 runtime_env 环境变量相同。
388 张合成图在 Ray 真实冷算，传输及逐条 SHA-256 验证后导入 388 条缓存。
签名由当前原函数生成，没有改签名或复用旧分析输出；本机 cache-only 实测 0/388 uncached，
正常退出并生成 `data/cache/bench/reports/2026-10-11T18-14-12-528Z/report.json`。
与 [w11 同平台证据](testing-data/w11-ray-same-platform.json)及其对应 Ray 报告对照：
偏好准确率 354/368、严重 gate 101/112、源图误淘汰 1/20，**三项 delta=0**；
368 行完整报告（含判定与分数）逐行相同，unchangedRows=true，388 条完整缓存内容相同。
**本清单同平台质量门槛通过**；没有变化行需要定位代码。
[公开快照](testing-data/w15-raybench.json)保存代码/模型/报告哈希、版本及全部逐行核对证据。
仅新增该快照并追加本节，未修改 src、阈值、规则或签名；未访问/写回 Eagle 或修改原片。
结论限本合成清单与受控 CPU 环境；常规 bench 不执行 DINO embedding/原生裁切，
这些路径及其它 provider、真实摄影师偏好未完成验证，T-triage 仍 unavailable。

实际命令（采集日志及独立逐行/缓存比较程序位于不入库的临时目录）：

```sh
source ~/.config/eagle-culling/env.sh
nice -n 15 python3 scripts/bench-ray.py submit --reuse-assets w11-raybench-ddcc847bce36
nice -n 15 python3 scripts/bench-ray.py status --id w11-raybench-907408355f00
nice -n 15 python3 scripts/bench-ray.py collect --id w11-raybench-907408355f00
unset PYTHONPATH EAGLE_POSE_MODE EAGLE_POSE_MODEL EAGLE_POSE_DETECTOR EAGLE_SCORER_PROVIDER EAGLE_DINO_PROVIDER
EAGLE_PYTHON=python_worker/.venv/bin/python EAGLE_POSE_PROVIDER=CPUExecutionProvider EAGLE_BENCH_CACHE_ONLY=1 nice -n 15 node --max-old-space-size=2048 scripts/bench.mjs --compare data/cache/bench/reports/2026-10-11T14-39-30-841Z/report.json
nice -n 15 node --max-old-space-size=2048 --test --test-concurrency=1 --test-skip-pattern='fixture face detection recall|fixture grouping reaches'
nice -n 15 python3 -m unittest scripts/test_bench_ray.py
nice -n 15 python3 scripts/bench-ray.py audit
nice -n 15 node scripts/check-public-release.mjs
nice -n 15 git diff --check
```

Node 412/412 通过、0 失败/跳过，242.948 秒；Python 4/4 通过。
公开检查 0 命中，diff check 通过；最终 audit 该前缀 RUNNING/PENDING=0，
本轮只操作上述新作业，未操作其它线作业。所有本机命令请求 nice 15，沙箱拒绝调整，实测继承 nice 20；
Node heap 上限 2048 MiB，本机串行执行且没有整批模型冷算。未提交、未 push。


## W19：进度与常驻 exiftool

定向测试覆盖总体百分比单调性、扫描多次计数、滑动窗口预热/提速/停滞、未知总量、
续跑预热、历史耗时权重、HTTP 心跳/终态持久化，以及最近卡片与进行中卡片的中文展示。
Exiftool 测试覆盖复用、两 worker 输出隔离、跨 chunk ready 标记、二进制私有文件、
退出/超时/启动失败/管道错误/输出超限/缺文件的逐张回退、换行路径安全回退、取消无回退。
有 exiftool 时另用现场生成的 64×64 JPEG 和 ICC 数据，验证 Unicode 路径与单调用字节一致；
无 exiftool 时仅此真实工具测试明确 skip，不把 mock 当作工具实测。

配置从环境变量或不入库的 `config/local.json` 读取：
`EAGLE_EXIFTOOL` 指定可执行文件；`EAGLE_EXIFTOOL_WORKERS`、`EAGLE_NATIVE_CONCURRENCY`
默认 1、限 1–2；`EAGLE_EXIFTOOL_STAY_OPEN=0` 可禁用常驻模式。
`EAGLE_FACE_WORKERS` 和 `EAGLE_POSE_WORKERS` 默认跟随 pipeline 并发、最多 2。
常驻工具使用 `-stay_open True -@ -`，带编号 `-execute`/ready；二进制以
`-w! <private-temp-dir>/%0fpayload.bin` 输出，避免按 RAW 文件名生成路径或混淆 JPEG 字节与标记。
命令最长 60 秒，文本最多 1 MiB、二进制最多 128 MiB，空闲 5 秒退出，私有目录在 finally 清理。
Mac 子进程请求 nice 15，Windows 工具设置 BelowNormal；失败保留原有逐张取像路径。

人脸与姿态池在同一 run 的 16 张批次之间复用，阶段结束/异常/取消关闭。
原生解码默认仍串行，仅显式配置才并行两张；预览随既有 metrics worker 并发处理。
没有增加依赖、改变模型预处理、排序/规则/阈值，也没有并行 DINO 推理或额外扩大 RAW 缓冲。
完整 Windows 计时、结果差异、资源与验收边界见 [windows-validation.md](windows-validation.md)。


W19 最终证据：系统 Python 的完整回归 438 pass / 0 fail / 1 skip（本地姿态 smoke 未满足依赖），
Ray 打包 unittest 4/4；新签名 Ray 冷算 388 张后，Mac cache-only 实跑 0/388 uncached，
与任务前最新同清单报告比较三项 delta=0、368 行完全一致。
本轮 Ray 作业终态、自身活动作业 0；公开检查 0 命中、diff check 通过。
项目 Python 的一次 teacher CLI mock 超时及单项/完整复验、Windows 未完成项见上述验证文档。
