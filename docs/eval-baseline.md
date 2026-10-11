# mac-ray-dev 评测基线

本次在 `w2-bench` worktree 执行；`HEAD` 与 `mac-ray-dev` 均为 `c61b6db3d2eca9383bc4c27a10bf39e238670396`。
没有修改 ranking、scoring、grouping 或 pipeline；全部输入来自缓存代理图，不访问或写回 Eagle。

候选来源：汕头 253 单元，满足技术阈值 127、排除 126，按 stem 等距选 10；Eagle 原 38 单元，满足阈值 28、排除 10，等距选 10。阈值与生成参数见 `test/fixtures/bench-syn-manifest.json`。源图选取没有用未知文件夹、综合分、质量分或淘汰 flags。

技术退化有多档，但源图优于退化图是受控退化先验，不是摄影师审美真值。颈裁切用双肩中点估计，低可信关节跳过；倾斜仅验证注入旋转敏感性，未标注自然地平线。新增留白使用灰色画布，可能引入边缘伪影。


时间：2026-10-10T04:18:22.873Z；分支：w2-bench；HEAD：c61b6db3d2eca9383bc4c27a10bf39e238670396

使用现有 analyzeImage / TOPIQ / faces / pose / signals / rules / rankGroup / suggestDecision 函数；不修改评分。
固定按基准的 pair/series 排序，绕过相似分组与 embedding；这是评分基准，不是全流程分组验收。

T-syn：20 源图、368 对；偏好准确率 85.05%，95% CI [79.62%, 90.63%]。
源图误淘汰（保留先验代理指标）1/20 = 5.00%，bootstrap CI [0.00%, 15.00%]。
应淘汰退化图 gate 命中 21/112 = 18.75%。
源图误淘汰按独立单张 suggestDecision 计算，每张只计一次；不能据此宣称全库误删 ≤2%。
零误拒的小样本 bootstrap 会退化为 [0,0]，不能解读为总体误拒为零。

| 退化 | 对数 | 偏好准确率（同分不算正确） | 应淘汰 gate 命中 |
|---|---:|---:|---:|
| defocus-blur | 60 | 100.00% | 0/20 (0.00%) |
| motion-blur | 60 | 100.00% | 0/20 (0.00%) |
| underexposure | 40 | 100.00% | 10/20 (50.00%) |
| overexposure | 40 | 57.50% | 10/20 (50.00%) |
| noise | 40 | 97.50% | 0/20 (0.00%) |
| horizon-tilt | 40 | 87.50% | 0/0 (不可用) |
| excess-headroom | 20 | 70.00% | 0/0 (不可用) |
| joint-crop-wrist | 16 | 50.00% | 0/0 (不可用) |
| joint-crop-knee | 7 | 42.86% | 0/0 (不可用) |
| joint-crop-ankle | 3 | 66.67% | 0/0 (不可用) |
| head-top-crop | 13 | 53.85% | 0/0 (不可用) |
| face-highlight-clipping | 13 | 69.23% | 1/12 (8.33%) |
| joint-crop-neck | 16 | 81.25% | 0/0 (不可用) |

gate 以受控两图组实际 suggestDecision 的 rejected 为准；单张 serious-flag 检查另存 JSON。
裁切等规则 verdict 不自动改成拒绝：当前 pipeline 尚未把这些 verdict 接入 ranking/gate。
随机偏好基线 50%；源图/退化对的生成顺序没有拍摄时间含义。

T-triage：unavailable；组数 0。
原因：Official dataset licensing and downloads could not be verified (HTTP/HTTPS homepage and download.html all 503 through the requested Ray proxy). Actual released splits and current test-label availability are unverified.；top-1、成对准确率与 CI 均为 null。

bootstrap：固定 seed=42，1000 次，T-syn 按源图聚类、T-triage 按连拍组重采样。
本次作为首次基线，无先前合法同基准结果；后续可用 --compare <report.json> 比较。

模型警告：

- 无

运行：`nice -n 10 node scripts/bench.mjs`（请求并发 1，TOPIQ 线程 2；本次依赖设置见 ml/bench/README.md）。

与指定报告比较：{"syntheticAccuracyDelta":0,"sourceFalseRejectDelta":0,"triageTop1Delta":null}

## 执行证据与边界

完整 JSON/Markdown：`data/cache/bench/reports/2026-10-10T04-18-22-873Z/report.json` / `report.md`。

一次完整重算后按最终清单校验全部388张 JPEG；最终统计回放为 0/388 未缓存，模型警告为空。

T-syn总体85.05%（随机50%），没有先前同清单版本；缓存回放相对完整重算的准确率/源图淘汰率差值均为0；这是复现验证，不是新算法提升。仅失焦/运动模糊/欠曝/噪点达到90%成对目标，其他类别未达到；gate总体18.75%未达到90%，源图5%代理指标超过2%目标，但缺少独立保留真值，不能判定已证实误删5%。

源图DSC07060被检测器标记eyes-closed而淘汰。选源阈值仅覆盖清晰度/曝光，不能排除天然表情问题；因此5%是源图保留先验下的代理误淘汰率，不是经过专家确认的误删率。20张源图样本很小，不能推断全库表现。

关节裁切覆盖腕16、膝7、踝3、颈16对；总计42条跳过记录（无脸、无主体或关节置信度不足）。构图案例只设偏好预期，未标expectedGate，不能把0/0解释为0%通过。

T-triage为0组；许可/下载阻塞见 [来源与替代许可](../ml/bench/phototriage-provenance.md)。两次官网探测SUCCEEDED，补充PDF作业超时FAILED；三个自有Ray作业均已终态。未下载无许可图像。

相关Node测试16/16、Python传输测试7/7。最终全量指定命令174项：172通过、1失败、1跳过。唯一失败为HEAD已有test/xhs-candidates.test.js第36/118行超长；跳过local pose worker smoke（worktree本地.venv不存在，基线显式使用主仓Python与临时补充依赖）。没有新增失败。

本机均以nice -n10调用，但沙箱拒绝setpriority；优先级没有成功降低，模型请求串行、姿态worker=1。临时依赖与复现命令见 [bench说明](../ml/bench/README.md)。

限定范围外的docs/todo.md仍含旧汕头精选声明，已知不一致以本更正及新fixture为准。没有修改原片、Eagle写回、ranking/scoring/grouping/pipeline；工作区改动未提交、未push。

## W2-A 之后（2026-10-10，报告 `data/cache/bench/reports/2026-10-10T04-36-38-775Z/`）

T-syn 偏好准确率 85.05% → **94.02%**（95% CI 91.94–96.17%）；源图误淘汰代理 1/20 不变。主要提升：过曝 57.5% → 87.5%、面部高光溢出 69% → 92%、地平线倾斜 87.5% → 100%、头顶留白过多 70% → 100%、腕部裁切 50% → 87.5%。

退步/未解决：严重退化的 gate 命中下降（欠曝 10/20 → 1/20、过曝 10/20 → 5/20），模糊和噪点仍 0/20；头顶切 53.85%、踝部裁切 1/3 仍接近随机。gate 阈值需在 T-syn 严重档上校准，同时保持源图误淘汰不升。

## W2 gate/verdict 之后（2026-10-10，w2-gate）

正式报告：`data/cache/bench/reports/2026-10-10T05-42-31-551Z/report.json`；对照为执行开始时最新的 `data/cache/bench/reports/2026-10-10T05-20-04-266Z/report.json`。同一 manifest、20 源图、368 对，未改变分组算法或 bench 评估口径。
没有摄影师精选；以下偏好只验证受控退化方向，汕头只统计直出分布。

总体偏好 **94.02% → 96.47%**（+2.45 个百分点；355/368，95% CI 94.61%–98.36%）。
严重档 gate **7/112 → 101/112 = 90.18%**；源图误淘汰代理 **1/20 → 1/20**，仍只有 DSC07060 的闭眼，CI 0–15%。没有新增源图技术门槛淘汰。

| 分类 | 对数 | 偏好：之前 → 之后 | 严重 gate：之前 → 之后 |
|---|---:|---:|---:|
| defocus-blur | 60 | 100.00% → 100.00% | 0/20 → 19/20 |
| motion-blur | 60 | 100.00% → 100.00% | 0/20 → 19/20 |
| underexposure | 40 | 100.00% → 100.00% | 1/20 → 13/20 |
| overexposure | 40 | 87.50% → 92.50% | 5/20 → 19/20 |
| noise | 40 | 97.50% → 97.50% | 0/20 → 19/20 |
| horizon-tilt | 40 | 100.00% → 97.50% | 无 expectedGate |
| excess-headroom | 20 | 100.00% → 100.00% | 无 expectedGate |
| joint-crop-wrist | 16 | 87.50% → 93.75% | 无 expectedGate |
| joint-crop-knee | 7 | 71.43% → 57.14% | 无 expectedGate |
| joint-crop-ankle | 3 | 33.33% → 66.67% | 无 expectedGate |
| head-top-crop | 13 | 53.85% → 84.62% | 无 expectedGate |
| face-highlight-clipping | 13 | 92.31% → 100.00% | 1/12 → 12/12 |
| joint-crop-neck | 16 | 81.25% → 93.75% | 无 expectedGate |

关节裁切合计 33/42 → 36/42（78.57% → 85.71%）；踝部 1/3 → 2/3、头顶切 7/13 → 11/13。膝部 5/7 → 4/7、倾斜 40/40 → 39/40 有退步：源图本身也有检测违例，而退化后关键点/线段可能消失，na 不得冒充安全或补惩罚。
模糊两类与噪点均达 95% 组内 gate；欠曝仍 13/20，亮度下降但暗端没有充分损失的样本保持候选。噪点单张门槛为 20/20，受控两图组为 19/20：s006 的源图已有闭眼，两张都过硬伤门槛时，现有 suggestDecision 将排第一的严重图保留 candidate；未改这一决策契约。T-triage 仍 unavailable，不报告摄影师偏好或全库误删率。

### 阈值、交叉验证与风格保护

每折留出一张源图及其所有强度/类别变体。训练控制不得新增技术淘汰；候选先最大化严重召回，再减少中档触发，同分取更保守阈值；最终取 20 折众数。
初始无风格约束的模糊组合（方差 <600、TOPIQ <0.4）在联系表误伤夕阳虚焦前景/低纹理夜景；加入 TOPIQ 上限 0.2 的保守候选约束后重做 LOSO。对照结果只用于开发校准，不是独立盲测或审美真值。

| 门槛/检查 | 最终数值与单位 | 依据与留一结果 |
|---|---|---|
| 模糊 | 512 最大边、保持比例；拉普拉斯方差 <400（8-bit 亮度平方），且 TOPIQ <0.2 | 20/20 折同选；LOSO 38/40、技术源图误拒 0/20。严重失焦/运动各 19/20；舍弃高分严重模糊而保护低纹理场景。源图 TOPIQ 最低 0.514；汕头被初始组合误标的夕阳分为 0.237/0.294，最终保留。 |
| 噪点 | 同尺度亮度 2×2 HH 绝对残差中位数 /0.6745 >10，且 TOPIQ <0.4 | sigma 候选 8/9/10/11/12/14、质量 0.2/0.3/0.4/0.5；19 折选 10/0.4、一折 11/0.4。LOSO 19/20、误拒 0/20；源图 sigma 最大 8.90、严重档最小 10.61。纹理可混淆，故需低质量联合且缺失模型主动弃权。 |
| 整图过曝 | 无可靠 metrics 面部 ROI 时，亮度 ≥250 的比例 ≥0.10 | 19 折选 0.10、一折 0.15；与既有面部像素门槛联合 LOSO 18/20、误拒 0/20。源图整图最大 0.0132；无脸严重档多数 ≥0.1427。少量点光源/水面反射不按 1.5%–3.5% 的初始门槛硬拒绝。 |
| 整图欠曝 | 无可靠 metrics 面部 ROI 时，均值 <60、亮度 ≤5 比例 ≥0.02、亮度方差 <1000（96 最大边采样）三者同时成立 | 候选均值 20/30/40/50/60/70/80，死黑 0.02/0.05/0.1/0.2/0.3，方差 600/800/1000/1200/1500。19 折选 60/0.02/1000、一折 50/0.02/1000；LOSO 12/20、误拒 0/20。源图暗端最多 0.0188；被该组合覆盖的严重档方差最高 954。被初始组合误标的五张夜景方差 ≥1645，最终保留。 |
| 面部高光 gate | 既有比例 ≥0.08；metrics 面部 ROI 优先；缺该 ROI 时读取当前 measure-v3、主人物匹配的内脸像素，至少 64 px | 不读取 verdict。源图匹配脸亮端最大 0.0469、合成面部严重档 ≥0.5；补上以前已有像素测量未进入 gate 的路径，12/12 命中且源图不升。 |
| 保留的旧 gate | normalized sharpness <0.005；全局死黑 ≥0.85；metrics 脸死黑 ≥0.25 或脸均值 <18；闭眼 | 未重新拟合这些门槛。可靠脸优先于整图亮/暗背景；analyzeImage 不再先生成永久全局曝光 flags，避免后续正常脸无法撤销背景误标。脸框不等于皮肤掩码，仍需审阅。 |
| 可测量严重违例 | 脸亮端 >0.08；abs 可靠水平/竖线角度 >5° | 小于严重档仍按原 0.03 脸高光、2°/3°角度 warn；脸至少 64 px、两轴 ≥8 px，线共识 ≥0.65 的有效性要求不变。5°把已验证 3°轻档/8°严重合成倾斜分开，只用于组内偏好，不推断拍摄意图。 |
| 关节/头顶裁切 | 沿用已校准的 0.15 头高及可观察性逻辑 | 本轮不扩大边带、不把 na 算安全、不修改关键点或分组。 |

完整网格、逐折、输入特征与敏感性：`/tmp/w2-gate-qa/calibration.json`、`calibrate.mjs`、`features.json`、`weight-sensitivity.json`。初始探索另存 `calibration-initial.json`。

组内惩罚进 `ranking-weights.json`：每条独立关节规则 0.01（同一规则多人物只计一次）、头顶/发际线 0.05、面部高光 0.01、严重倾斜 0.005（水平/竖线/题材重复按同一族只计一次）。
只接 measure + violate；warn/hint 仅显示理由，na 不扣分，单张不扣分。关节 0.025–0.1 在探索回放损失更多偏好；头顶 0.05 与 0.1/0.2 同准确率，取小值；脸部 0.01 与 0.025–0.1 同准确率，取小值；倾斜 0.01–0.05 更易误伤天然倾斜，取 0.005。这个权重网格是样本内开发敏感性，不宣称交叉验证的独立偏好效果。
惩罚不传给 gateFlags/suggestDecision；面部 gate 只读像素/技术指标，与规则权重无关。真实全库仅规则惩罚消融改变 10 组首选，其中汕头 7 组；变化不是更符合摄影师审美的证明。

### 汕头直出分布与提示

先 GET `http://localhost:41595/api/library/info`，严格核对活动库 `<EAGLE_LIBRARY>`。实际全库 analyze 582 文件/291 单元跑通，warnings=[]；汕头限定清单的 253 单元，未写回 Eagle、未接触「未删减」。
隔离 `/tmp/w2-gate-qa/cache`、store:null，重算全部模型/像素而非复用旧 ResultsStore；完成后用最终阈值/权重重排已生成组，重建运行中配置产生的派生 flags，不重新分组。
W2-A 同范围硬伤标记 24/253 → **36/253（14.23%）**；实际 pipeline 建议 rejected **32**、selected 80、candidate 141。4 个有门槛问题的组内首位由 suggestDecision 返回 candidate，但 pipeline 既有多图组兜底又把它们提为 selected（confidence=low，带门槛理由）；因此标记数不等于 rejected 数。本轮保留这项现有策略，不把 gate 标记数冒充实际淘汰数。理由可重叠。

| gate 理由 | 单元数 /253 | 比例 |
|---|---:|---:|
| 模糊 | 0 | 0% |
| 噪点 | 0 | 0% |
| 过曝 | 15 | 5.93% |
| 欠曝 | 4 | 1.58% |
| 闭眼 | 18 | 7.11% |

没有单一理由超过 15%。过曝主要为代理图大面积死白天空/背景或面部溢出，欠曝四例是测得脸均值约 8–9 的夜间人像；留白、色温、夜景亮度本身不 gate。目视联系表保留夕阳虚焦前景、点光源反射与高对比夜景；没有真实保留标签，不能据此认证剩余 36 张都应淘汰，JPEG 高光也不代表 RAW 不可恢复。
汕头 61 张有可惩罚 measure 违例，54 张处于多图组而实际扣分；裁切惩罚没有制造新的门槛。

| 提示 | 之前 | 最终触发 /253 | pass / na |
|---|---:|---:|---:|
| P-CROP-HEADROOM | 177（69.96%） | 0（0%） | 55 /198 |
| P-COLOR-CAST | 176（69.57%） | 1（0.40%） | 37 /215 |
| G-PROXY-BLUR | 13 | 13（5.14%） | 240 /0 |
| P-SUBJECT-PLACEMENT | 15 | 15（5.93%） | 179 /59 |
| L-VERTICAL-LEVEL | 3 | 3（1.19%，含一条 severe violate） | 33 /217 |
| G-EDGE-GRADIENT | 0 | 0 | 253 /0 |
| P-CROP-TIER | 65 | 65（25.69%） | 26 /162 |
| P-POSE-WEIGHT | 188 | 188（74.31%） | 0 /65 |

其他 hint 规则均无触发（多数尚无实现而 na）；完整分布按单元去重见 summary.json。超过 20% 的两个旧提示明确保留限制：P-CROP-TIER 只是预定义景别列表检查，不是关节坏切；P-POSE-WEIGHT 对所有有肩髋数值者报告姿态，没有审美阈值，74.31% 是数值摘要而非已确认缺陷。本轮不为它们编造审美阈值，均不参与排名；后续应拆开普通测量摘要与主动风险提示。
留白只在同组同景别至少 3 张可靠样本、且 >max(1.2,中位数+0.75,中位数×1.5) 头高时 warn。色偏只在至少 3 张同组可用 RGB 对照、max 通道归一化后的最大通道中位数差 >0.18 且绝对偏差 >0.25 时 warn；可用 RGB 加权亮度 <60，或 R>1.12G 且 B<0.9G 的暖光场景为 na。相对规则均保留缺少对照/低可信的弃权；低触发率包含大量 na，不能当成新增测量准确率。

### 验证、联系表与运行边界

最终 `nice -n 10 npm test -- --test-skip-pattern='fixture face detection recall|fixture grouping reaches'`：**221 tests、220 pass、0 fail、1 skip**（9241 ms）。skip 为 worktree 未配置本地 Python 的 worker 冒烟，真正本地模型已在共享 Python 的全库分析中运行。相关阈值、warn/na、去重、非 measure、单张不扣分及背景/夜景保护测试通过；git diff --check 通过。
单独以共享 Python、CPU provider 跑 fixture grouping reaches：**1 pass、0 skip，38 单元、23 组、最大组 4，TP22/FP0/FN6，F1=0.88，72.65 秒**，与 W2-A 同值。分组文件与 HEAD 字节相同，HEAD/当前分组函数对相同新输入成员完全一致。
汕头仍 83 组；全库冷跑 106 组而旧快照 105 组。grouping-audit.json 证明旧输入回放仍 105，新输入 106；唯一差异是非汕头 B0006942–B0006945 的重算 phash/embedding（embedding 最大分量差约 0.033–0.039），B0006943 被拆出；不是阈值/规则进入了分组，也不声称旧缓存和新代理特征逐字相同。

正式 bench 使用以下环境：

```sh
EAGLE_PYTHON="<PYTHON_EXECUTABLE>" \
PYTHONPATH=/tmp/w2-bench-pose EAGLE_POSE_PROVIDER=CPUExecutionProvider \
nice -n 10 node scripts/bench.mjs --compare data/cache/bench/reports/2026-10-10T05-20-04-266Z/report.json
```

最终 0/388 uncached：用 SHA-256 核对相同图片，重算变更的 analyzeImage/normalizeMetrics/evaluateRules，复用未改变的 TOPIQ/人脸/姿态输出；脚本仍真实重验 TOPIQ 文件并执行本地预检。不是 388 张模型全部重新推理，签名、复用来源见 bench-cache-provenance.json，prepare-bench-cache.mjs 可重现。生成 report.md 的“不修改评分/尚未接入排序”等固定模板句仍是旧文字；未改 bench 脚本，实际行为与 JSON 指标以本节更正为准。
旧 ResultStore 未包含 raw.technicalDetail 时，新模糊/噪点组合主动弃权；需要新测量才能得到这些新门槛，本任务的文件限制不允许修改 pipeline 缓存键。
所有入口带 nice -n10；沙箱拒绝再次 setpriority，同样入口 os.getPriority() 实测为继承的 10。初始冷 bench 与全库分析并行，人脸默认两 worker 的阶段可能短暂超过总并发 2；发现后停止冷 bench，后续模型批次串行，单批最多 2。没有新增外部模型调用或模型部署。

联系表已目视检查：`/tmp/w2-gate-qa/contact-gate.jpg`、`contact-penalty.jpg`、`contact-style-protected.jpg`。同目录有 examples.json、style-protected.json、final-analyze.json、summary.json、proxy-sha256.json（253 个新缓存代理图）、library-info.json、分组审计与测试日志。未以代理图哈希冒充原片完整性证据；分析代码对 Eagle 原片没有写操作。
已知边界：欠曝 65% gate、膝部偏好 57.14%、头顶切两个漏检、少数严重模糊质量分较高而漏 gate、旧高频姿态/景别提示、旧缓存缺新指标、全库非汕头特征漂移；小样本/受控退化不能代替真实风格、表情与个人偏好验收。
Git 暂存失败：无法创建主仓 `.git/worktrees/w2-gate/index.lock`（Operation not permitted）。15 个改动文件保留在 w2-gate，未提交、未 push；没有改 grouping、pipeline、bench 脚本或契约结构。

## W2 gate2：白天空与垂眼保护（2026-10-10，w2-gate2）

本轮只改 metrics、ranking、规则引擎、闭眼判断、ranking-weights、对应测试和本文档/todo。
未改分组、pipeline、bench 评估口径、plugin、server、ml/references 或 Python worker；没有外部模型调用。
真值仍限 T-syn 合成退化和人工目测联系表，没有摄影师精选，也不报告真实误删率。

### 方法与阈值依据

天空在保持比例的最大边 96 px、8-bit 亮度图上测量：亮度 ≥232、与四邻域最大亮度差 ≤12，
且通过四连通连接上边缘。单个连通块至少占全图 1%，最深位置须 <65% 图高，排除后至少剩 35% 面积。
到达下部的白块不视为空；整个过曝图不会被解释成天空。所有参数写在 ranking-weights.json 的 sky 中。
掩码外重新计算亮度 ≥250 的裁切比例，沿用既有 10% 整图门槛；既有可靠脸优先路径及 8% 面部高光门槛保留。
天空裁切像素占全图 ≥10% 时仅提示「天空过曝无细节」。当前 sky-v1 测量还会撤销旧派生过曝 flag，
再按主体/面部测量重建，避免第二条 gate 路径重新使用整图高光比例。
面部 ROI 测量新增两轴至少 8 px（最大边 512 px）和存在置信度时 ≥0.5 的有效性检查。

这些空间阈值是保护条件，不是新的 LOSO 最优阈值或天空语义准确率：用指定联系表确定问题类型，
用白天空+正常主体、整体过曝、分离主体溢出、纹理高亮及面部溢出合成测试验证边界，再在固定 T-syn 回归。
DSC06997/DSC06976 全图高光裁切为 36.02%/18.08%，掩码外为 1.12%/2.12%；主体曝光正常，天空仍有 hint。

闭眼由 eye-assessment.js 统一供 ranking 和 P-FACE-EYES 使用。
用 RTMW WholeBody 的面部 68 点（总序列 23..90）：每眼上下睑两对距离之和 / (2×眼宽) 得 EAR，
按图像长宽比修正距离。鼻尖至双眼中点的纵向距离 / 下巴至双眼中点距离估俯仰比例，
鼻尖横向偏离双眼中点 / 外眼角距离估侧转比例；这是二维比例，不是校准的三维角度。
脸中心须属于主人物框，且 RTMW 双眼中心须落在该脸框内，避免重叠身体框把背景脸当主体。
DSC07021/22 的原 MediaPipe 闭眼信号实际上来自背景儿童，不是低头的前景主人物；本轮不再以此 gate。

| 闭眼保护条件 | 数值/行为 | 依据 |
|---|---|---|
| 测量可信 | 所需关键点和人物 score ≥0.6，存在脸 confidence/score 时 ≥0.6；眼宽 ≥6 代理 px | 低置信度、小眼区、缺姿态均 warn；当前 MediaPipe 输出没有逐脸置信度，关键点/人物分数是替代有效性条件。 |
| 俯仰/侧转 | 俯仰比例不在 [0.15,0.48] 或侧转比例 >0.30 | 排除强投影/侧脸；合成低头序列验证，不宣称姿态真值。 |
| 正视闭眼 | 既有 MediaPipe eyesClosed 且两眼 EAR ≤0.30；或双侧 blink 最小 ≥0.6、最大 ≥0.8 | EAR 只是支持已存在的闭眼信号；RTMW 眼睑有噪声，保留强双侧眨眼路径。DSC07060 EAR 0.348/0.241、blink 0.803/0.624，因此明显眨眼仍 gate。 |
| 低头/侧转闭眼 | 测量可信、两眼 EAR ≤0.10 且同组匹配人物有睁眼帧才 gate | 没有可靠组内对照或仅垂眼时 warn；不把低头本身当缺陷。 |
| 普通闭眼且组内有睁眼 | warn，组内排在可用睁眼帧之后，保留 candidate；明显眨眼例外 | 沿用已有组，不改分组；内部上下文保存判断，不给输入结果新增字段。 |

组内身份仅用同组脸位置/尺度连续性：中心距离 <0.6×当前脸框面积平方根，面积比在 (0.5,2)，
且只存在一个匹配脸；若提供 identityId 则须相同。睁眼对照需 eyesAssessed 且非闭眼，
存在几何时关键点置信度 ≥0.6、两眼 EAR >0.20。不是人脸身份识别，移动/遮挡或多人混淆仍需人工复核。
缺脸明细的旧标量计数保持兼容；有当前脸明细但没有可靠姿态时降为 warn。阈值集中在 ranking-weights.json 的 eyes 中。

### T-syn 前后：三项要求均保持

执行开始时最新报告为 `data/cache/bench/reports/2026-10-10T05-42-31-551Z/report.json`。
首轮正式比较报告 `2026-10-10T05-55-09-571Z` 对照该报告；后续修复输入副作用/理由文字后逐次对照当时最新报告。
最终报告：`data/cache/bench/reports/2026-10-10T05-56-30-237Z/report.json`，
其 --compare 对照为 `data/cache/bench/reports/2026-10-10T05-55-59-617Z/report.json`。各轮三项结果相同，warnings=[]。

| 指标 | W2 gate | W2 gate2 |
|---|---:|---:|
| 总体偏好 | 355/368，96.47% | 355/368，96.47% |
| 严重档实际 rejected 命中 | 101/112，90.18% | 101/112，90.18% |
| 源图单张误淘汰代理 | 1/20 | 1/20 |
| 严重整图过曝 / 面部高光 | 19/20 / 12/12 | 19/20 / 12/12 |

每类偏好和严重档 gate 均与起始报告相同；保留控制误淘汰仍为 DSC07060。
正式执行环境（nice 调整被沙箱拒绝，但 Node os.getPriority() 实测继承值为 10）：

```sh
EAGLE_PYTHON="<PYTHON_EXECUTABLE>" \
PYTHONPATH=/tmp/w2-bench-pose EAGLE_POSE_PROVIDER=CPUExecutionProvider \
nice -n 10 node scripts/bench.mjs --compare data/cache/bench/reports/2026-10-10T05-55-59-617Z/report.json
```

388 张输入逐一核对 SHA-256，从同一输入重算 analyzeImage/normalizeMetrics；复用未修改的本地 TOPIQ、
MediaPipe、RTMW 输出，重新解释眼睑/姿态和重算规则。bench 仍执行本地 TOPIQ 预检，模型不可用时 quality=null 的语义未改。
因此正式日志 0/388 uncached，不是 388 张模型重新推理。签名及复用来源见 `/tmp/w2-gate2-qa/bench-cache-provenance.json`，
可复现脚本 measure-bench.mjs/prepare-bench.mjs；没有修改 bench 来改变评估口径。

### 汕头同输入回放与目测

再次 GET `http://localhost:41595/api/library/info`，确认活动库 `<EAGLE_LIBRARY>`。
读取上一轮 final-analyze.json 的相同代理图、相同模型输出和相同分组，重算天空/有效面部 ROI、曝光适宜度和 gate/ranking。
253 张代理图 SHA-256 与上一轮全部相同；未写回 Eagle、没有访问「未删减」。这是同输入回放验证，非新冷跑全流程验收。

| 统计（理由可重叠） | 之前 | 之后 |
|---|---:|---:|
| gate 标记单元 | 36 | 8 |
| 实际 suggested rejected | 32 | 8 |
| selected / candidate | 80 /141 | 82 /163 |
| 过曝 | 15 | 2 |
| 欠曝 | 4 | 4 |
| 闭眼 | 18 | 2 |
| 模糊 / 噪点 | 0 /0 | 0 /0 |

28 张原 gate 标记放行，没有新增 gate。仍 gate 的全部 8 张：DSC07037/07098 面部严重溢出，
DSC07060/07063 可靠闭眼，DSC07138/07139/07140/07141 面部严重欠曝。
联系表已目视检查；这不等于认证其 RAW 不可恢复或摄影师一定应删。

- 放行全部 28 张：`/tmp/w2-gate2-qa/contact-released.jpg`。
- 仍 gate 全部 8 张：`/tmp/w2-gate2-qa/contact-still-gated.jpg`。
- 同目录 summary.json、examples.json、eye-assessments.json、final-analyze.json、proxy-sha256.json 和 library-info.json 保存逐图证据；replay.mjs 可复现。

### 测试与已知边界

新增天空合成图、正视闭眼/低头垂眼关键点序列、侧转/小眼区/低置信度、背景脸、同组睁眼及组内延后候选测试。
更新旧 pipeline 人脸测试：保留闭眼原始计数，但无可靠姿态的单侧 blink 不再断言 gate；改断言 warn 理由。
定向修复验证 25/25 通过；最终指定 npm test 结果见下方。

天空只是空间亮度代理：顶部白墙/强背光背景可能被当天空，DSC07012 岩壁旁白背景也因此放行；
超过图高 65% 的天空、被树冠完全隔开上边缘的天空可能仍无法排除。未实现语义天空分割或 RAW 高光恢复判断。
RTMW 眼睑分辨率有限；俯仰比受透视/头部滚转影响，位置/尺度匹配不等于身份认证；保守 warn 可能漏掉真实眨眼。
T-syn 未含独立标注的闭眼退化类别，新增闭眼证据是合成几何测试及联系表，并非盲测闭眼召回。
旧 ResultsStore 缺 skyExposure 时仍走旧整图指标，需重测；本任务未改 pipeline 缓存键。
bench 不单独哈希新 helper 文件，本轮 ranking/阈值配置已改变签名；以后仅改 helper 算法时需同步升级被签名的 ranking/config。
未改变欠曝、膝部裁切等上一节的已知不足。

最终 `nice -n 10 npm test -- --test-skip-pattern='fixture face detection recall|fixture grouping reaches'`：
**237 tests、236 pass、0 fail、1 skip，9614 ms**；日志 `/tmp/w2-gate2-qa/npm-test-final.log`。
skip 是 worktree 默认本地 Python worker 冒烟（未配置共享 EAGLE_PYTHON），不是本轮新增失败。
`git diff --check` 通过。当前 worktree 分支为 w2-gate2，改动保留；本会话 Git 元数据只读，未提交、未 push。
原片没有写操作；253 个代理图哈希一致仅证明代理图未变，不冒充原片完整性哈希证明。

## W5 候选规则验证（2026-10-11）

本轮是实验测量，不是四条规则的审美有效性认证。汕头没有摄影师精选，未把文件夹、星级或现有 selected 当真值。
正式规则 JSON、ranking-weights、生效 gate、分组与 contract v1 均未修改。
`src/core/candidate-measurements.js` 输出 pass/warn/violate/na；violate 仅表示更强的代理测量，severity 始终为 hint。
`EAGLE_W5_HINTS=1` 才在 pipeline 的串行像素阶段生成测量，复用已有人脸/姿态/TOPIQ；默认关闭。
现有 UI 把实验 verdict 显示在「规则提示」折叠区；候选 ID 不在 rulePenalty 映射，不产生扣分或拒绝。
关闭开关时清除缓存中的实验测量；重新排序仍保留启用时的提示。未冷跑全库、未调用外部模型 API。

### 测量与阈值依据

配置集中在 `src/core/candidate-config.json`（w5-v1，含受控退化参数），最长边 256 px、sRGB 8-bit。
这些是明确披露的保守操作阈值，**不是资料给出的审美阈值，也没有摄影师标注校准**。
先固定测量阈值，再检查汕头分布；没有用联系表调出一个目标触发率。下述严重档不改变 gate。

| 候选 | 测量、提示门槛与保护 | 已知误判/漏判；建议 |
|---|---|---|
| P-YD-TONAL-GRAY | 有效动态范围 P95−P5；16×16 小块亮度标准差的中位数作为局部对比度。range<70 且 local<10 为 warn；range<40 且 local<5 为 violate。mean<45 或 >210 返回 na；有缓存 TOPIQ>0.75 也返回 na。TOPIQ=null 时只用曝光保护，不生成质量分。 | 雾景、黄昏、柔和灰调可能提示；不用纯黑/纯白存在与否判断。**不建议排序**，先复核两个黄昏港口样例。 |
| P-YD-TILT | 直接映射 L-HORIZON-LEVEL、L-VERTICAL-LEVEL、S-TILT-INTENT：measure-v3、线置信度≥0.65、角度范围≤20°；绝对角度>2° warn，>5° violate；任一可靠轴可提示，无轴 na。 | 没有新增线检测器；山脊、树枝、透视、荷兰角无法判断意图。与既有规则重复，**不建议增加排序权重/重复扣分**。 |
| P-YD-NONFACE-HIGHLIGHTS | 人物框向外扩展宽高的8%；排除 sky-v1 空间掩码与全部可靠面部框；剩余区域 Y≥250 的像素比例>4% warn，>12% violate；有效像素≥128；mean>210 na。 | 不是衣服/头发语义分割；小反光点、白衣、白墙、未检出脸、漏分天空与 JPEG/RAW 恢复差异。**不建议排序**，本样本无触发。 |
| P-YD-BG-SEPARATION | 框两侧20%–80%高度各24点，在±6%框宽内找最强局部 RGB 边缘，内外各2.5%框宽带取平均；亮差<8且RGB RMS差<12计弱分离。弱比例>80% warn，>95% violate，至少24样本；mean<45或>210、内带mean<30且外−内>30的剪影返回na。 | 框边不是人物轮廓；会借背景纹理得到假pass，也会把同色服装/抽象重合当弱分离；无法确定美学意图。**不建议排序**，本样本无触发且覆盖较低。 |

人物相关测量要求主人物 score≥0.7、框面积5%–85%、左右均有至少2%画幅边距。
T-syn 的人物框普遍贴近下沿；测量只采样左右中段，因此允许上下裁切（坐标仍须在[0,1]），不用不可见底边证据。
这个有效性修正有几何依据，不是为了调提示率；122/253 无可靠侧边人物框，返回na。
灰平70/40与local10/5仅区分较窄/极窄亮度结构；高光4%/12%区分大于少量反光点的区域；
背景80%/95%要求大多数/几乎全部采样带同时缺少亮度及色彩差异。无审美标签，不能把这些门槛称为最优。
现有倾斜阈值来自正式规则配置而非重新拟合。新测量保留连续值，以便之后用人工标注校准。

### T-syn：同输入回归与新类别敏感性

```sh
nice -n 10 node ml/bench/generate-syn.mjs --w5
nice -n 10 node scripts/bench.mjs --w5 --compare data/cache/bench/reports/2026-10-10T05-56-30-237Z/report.json
nice -n 10 node scripts/w5-replay.mjs
```

本轮最终报告：`data/cache/bench/reports/2026-10-11T00-14-20-197Z/report.json`（同目录report.md）。
汇总`/tmp/w5-validate-qa/bench-summary.json`，逐图模型复用与新测量`bench-results.json`，日志`bench.log`/`generate.log`。
扩展清单 `data/cache/bench/w5-manifest.json` 保留原始 tracked 清单及 JPEG；父清单 SHA-256 与每个既有 pair
的 id/sourceId/degradedId/sha256/degradation/strength 都核对。缓存按基线 analysisSignature+图像SHA读取，缺失即失败，
不冷跑模型。新增84对只重算像素，固定复用源图 TOPIQ/脸框/姿态；**这是已知源图几何下的敏感性，不是新图模型完整推理**。
缓存质量是2026-10-10的本地模型输出快照，本轮未做模型可用性预检；缓存质量为null仍保持null。

| 同一368对回归指标 | 之前 | W5 | 差值 |
|---|---:|---:|---:|
| 总体偏好 | 355/368 = 96.47% | 355/368 = 96.47% | 0 |
| 严重档 gate | 101/112 = 90.18% | 101/112 = 90.18% | 0 |
| 源图误淘汰代理 | 1/20 | 1/20 | 0 |

13个既有类别全部偏好差值为0：defocus-blur、motion-blur、underexposure、overexposure、noise、horizon-tilt、
excess-headroom、joint-crop-wrist/knee/ankle/neck、head-top-crop、face-highlight-clipping。
368对的credit、gateRejected、sourceRejected逐行完全相同；未仅凭总体抵消变化。
含新增类别的冻结模型默认排序总体438/452=96.90%，严重档仍101/112，源图仍1/20；
不同类别组成、且新增TOPIQ未重推，因此不能把96.90%对96.47%称为排序收益。

| 新类别 | 轻/重受控变换 | 新规则连续量偏好准确率：轻 /重 | 覆盖 |
|---|---|---:|---:|
| tonal-gray | 以128为中心压缩sRGB对比度至0.32/0.12 | 20/20 /20/20，均100% | 40/40 |
| nonface-highlights | 框内非脸下半部局部RGB+145/+255并截断；小/大区域 | 11/11 /11/11，均100% | 22/22 |
| bg-separation | 框侧边±10%宽内，将背景/边缘RGB向内侧参照色混合50%/90% | 11/11 /11/11，均100% | 22/22 |

连续量分别为 range+localContrast（大为优）、非脸溢出比例（小为优）、亮差+RGB差（大为优）；无同分。
固定提示门槛的触发数另算：灰平轻11/20、重20/20；非脸高光轻6/11、重11/11；背景轻1/11、重4/11。
因此“连续量100%敏感”不等于提示召回100%；背景重档仍7/11为pass，阈值与框边代理尚不能支持实际取舍。
倾斜仅复用映射；已有horizon-tilt类别排序仍39/40=97.50%，这不是P-YD-TILT单独贡献的偏好结果。
11个可靠人物源图可生成两类人物退化，9个源图各按有效性条件跳过，没有把缺少几何计作通过。
本轮新类别没有expectedGate，不从敏感性先验推出审美淘汰。阈值保持固定，无监督拟合；尚不能声明真实人像偏好准确率。

### 汕头253单元与联系表

GET `http://localhost:41595/api/library/info` 核对活动库 `<EAGLE_LIBRARY>`；只读缓存代理。
从 `/tmp/w2-gate2-qa/final-analyze.json` 取name以DSC开头的**253**单元，排除另38个单元；分组和模型输出不变。
253个代理SHA-256与上一轮`proxy-sha256.json`全部一致，逐图明细在`/tmp/w5-validate-qa/all-results.json`。
在包含这253单元的83个原分组中另做启用/关闭提示的rankGroup回放：rank、score、gateFlags、suggestDecision全部不变；
关闭时与保存ranking的rank/score也完全一致，证据`/tmp/w5-validate-qa/rank-invariance.json`。
这只证明代理未改，不冒充原片完整性验证。未访问「未删减」，没有 Eagle 写回。

| 候选 | pass | warn | violate | na | warn+violate触发率 |
|---|---:|---:|---:|---:|---:|
| TONAL-GRAY | 194 | 2 (0.79%) | 0 | 57 (22.53%) | 0.79% |
| TILT | 59 | 8 (3.16%) | 5 (1.98%) | 181 (71.54%) | 5.14% |
| NONFACE-HIGHLIGHTS | 131 | 0 | 0 | 122 (48.22%) | 0% |
| BG-SEPARATION | 80 | 0 | 0 | 173 (68.38%) | 0% |

没有规则触发率超过20%；不能把高na率当作低误判率。灰平的57个na均为亮度保护；
背景的173个na为122个无可靠人物框+51个低/高调保护。高光可判定最大比例1.876%（低于4%）；
背景弱分离最大47.92%（低于80%），零触发并不能证明这些阈值有用或规则不会漏判。

联系表每份最多24张；trigger为触发，near-threshold为最接近warn阈值的pass，均附同名HTML/JSON和文件名。
灰平对照按两个条件中较大的标准化比值距联合边界排序；倾斜只用满足原置信度/范围的轴；没有把na混入对照。

- `/tmp/w5-validate-qa/P-YD-TONAL-GRAY/{trigger,near-threshold}.jpg`：触发2、对照24。
- `/tmp/w5-validate-qa/P-YD-TILT/{trigger,near-threshold}.jpg`：触发13、对照24。
- `/tmp/w5-validate-qa/P-YD-NONFACE-HIGHLIGHTS/{trigger,near-threshold}.jpg`：触发0（空提示图）、对照24。
- `/tmp/w5-validate-qa/P-YD-BG-SEPARATION/{trigger,near-threshold}.jpg`：触发0（空提示图）、对照24。

已初步目视检查触发和对照联系表，仍待用户判断：灰平DSC06958/06959是黄昏港口，柔和影调可能有意；
倾斜组包括山脊、湖面倒影、建筑透视和近景框架，线代理不能判断是否应校正。
高光对照包含DSC07037/07098面部溢出照片，候选排除脸后pass不代表整张无过曝；面部仍由原gate处理。
背景框侧边容易被栏杆/建筑的强边缘“通过”，未真正分割发丝或黑色衣服边缘。

### 例外人工复核设计草案

提示文案统一为「建议人工复核：是否属于有意表达；比较用途、轮廓/必要信息与相邻帧」。
只附加理由，不自动豁免、不改gate、也不从摄影师名望或图像暗亮推断意图。
依据是 `docs/research-books.md` 的教材例外与选片样章、`docs/research-courses.md` 的韩晶/大师课例外；
“常见”是本轮复核类别归纳，不是有分母的文献频次排序。

| 复核理由 | 附加条件（已有warn/violate或gate） | 来源边界 | 汕头单元数 |
|---|---|---|---:|
| 有意动感模糊 | 模糊gate或BLUR/SHARP/FOCUS提示 | 技艺p.141–142、纽约p.21/92；体育清楚动作要求仍成立；课程本身未补齐通用有意模糊证据 | 13 |
| 剪影/低调 | 欠曝gate、SHADOW提示或曝光提示含暗部证据 | 技艺p.322–323、纽约p.75/99；必要轮廓仍需可读，白礼服纹理不能自动免责 | 31 |
| 有意闭眼 | 闭眼gate或EYES/BLINK提示 | 韩晶26/27集闭眼笑、Why样章Turk20–21；正式合影仍需比较意外眨眼 | 15 |
| 紧裁头顶 | P-CROP-HAIRLINE提示 | 大师课裁切例外、教材局部特写；不是统一放宽关节裁切 | 3 |
| 有意背景重合 | BACKGROUND-MERGER/LAYERS-SEPARATION或新BG提示 | 衣刀候选已有剪影/同色隐身/抽象表达例外；不能宣称资料证明任意重合成立 | 0 |

理由可重叠，合计59/253（23.32%）个当前gate/warn单元会附加至少一个复核提示。
按**原保存分组ranking的硬伤门槛理由**统计，现有8个gate中6个附加上述理由；另2个是面部高光，
不借低调/剪影理由豁免。没有把单张闭眼gate重算误当当前组内gate。
名单 `/tmp/w5-validate-qa/exception-review.json`；计数 `/tmp/w5-validate-qa/stats.json`。
该设计仅文档和离线统计，未接入默认交互。

### 测试与验收边界

新增合成RGB测试覆盖对比度压缩、夜景/高低调、高TOPIQ保护、sky-v1/脸ROI排除、衣服区域溢出、
无人物/弱人物/横向裁切na、亮度与色彩分离、剪影保护、倾斜阈值映射、contract v1与提示UI。
两图排序对照断言score、gateFlags与rulePenalty完全一致；bench测试核对附加pair身份及敏感性缺测/同分。
指定Node全套：291 tests、290 pass、0 fail、1 skip；日志 `/tmp/w5-full-tests.log`。
skip沿用本地Python worker环境冒烟，不是新增失败；`git diff --check`通过。
`nice -n 10`都已尝试，但沙箱拒绝setpriority，不能声称成功降低OS调度优先级；Sharp串行。
本轮完成像素测量、缓存回放、联系表与规则/提示单测；没有进行全库冷模型推理、摄影师盲标、完整UI/Eagle写回验收。
保留worktree改动，未提交、未push。

## W6 候选集评估（2026-10-11）

本轮复用 `data/cache/bench/analysis` 和最新 T-syn report 的 `analysisSignature`，没有冷跑模型。入口为：

```sh
nice -n 10 node scripts/eval-candidates.mjs
```

脚本比较旧加权排序、严格 Pareto（ε=0）和 ε-Pareto。T-syn 的源图优于每张受控退化图，作为组内 top-1 和 pairwise 真值；前沿 top-1 为前沿中旧排序最高者，仅用于给集合定义一个可重复代表，前沿召回单独统计源图是否仍在前沿。pairwise 前沿同时保留计 0.5，bootstrap 按 20 个源图组重采样，seed=42、1000 次。

| 策略 | 组内 top-1 | pairwise | 源图前沿召回 | 前沿平均大小 | 源图排除代理 | 严重退化排除 |
|---|---:|---:|---:|---:|---:|---:|
| 旧加权 | 55.0% [35.0%,75.0%] | 96.20% [94.02%,98.10%] | 55.0% [35.0%,75.0%] | 1.00 [1.00,1.00] | 45.0% [25.0%,65.0%] | 96.77% |
| 严格 Pareto | 55.0% [35.0%,75.0%] | 55.84% [53.53%,58.15%] | 95.0% [85.0%,100%] | 9.00 [7.60,10.15] | 5.0% [0%,15.0%] | 100% |
| ε-Pareto | 45.0% [25.0%,65.0%] | 82.07% [78.67%,85.05%] | 55.0% [35.0%,75.0%] | 2.40 [1.95,2.85] | 45.0% [25.0%,65.0%] | 100% |

ε-Pareto 按退化类别的 pairwise 为：defocus 90.83%、motion 86.67%、欠曝 87.50%、过曝 71.25%、噪点 78.75%、水平线 86.25%、留白 87.50%、腕部裁切 78.13%、膝部裁切 28.57%、踝/脚裁切 33.33%、头顶裁切 76.92%、面部高光 88.46%、颈部裁切 71.88%。小类别区间很宽，不能据此调参或宣称审美改善。

汕头使用旧 run `run-1791589678002` 的 291 单元及 `data/cache/results.jsonl`，用当前合并后的时间分桶/分组代码重放得到 84 组。候选前沿大小分布为 `0:2, 1:56, 2:14, 3:6, 4:3, 6:3`；前沿至少 2 张 26 组，旧首选不在前沿 4 组，`rejectedAll` 2 组。汕头没有摄影师精选，不作真值。图片联系表和 HTML 在 `/tmp/w6-pareto-qa/shantou-contact.html`，图片目录为 `/tmp/w6-pareto-qa/images/`，机器可读汇总为 `/tmp/w6-pareto-qa/candidate-evaluation.json`。

建议继续保持审阅页默认旧排序。ε-Pareto 的 pairwise 明显低于旧加权，且 T-syn 源图前沿召回只有 55%；候选集适合作为低把握组和前沿至少 2 张组的人工复核视图。待真实偏好标签、前沿规模和误淘汰代理在留出数据上稳定后再考虑默认切换。

评估 JSON 的 `byDegradation` 同时包含各退化类别的 top-1、pairwise、前沿召回、前沿平均大小、源图排除代理和 bootstrap 区间；上表只摘录总体指标，避免把小类别的宽区间误读为调参证据。
### W6 原生对焦补充（2026-10-11）

活动库清单对应的 80 张 Sony ARW（29 组、4 个多张组）完成只读回放。原生眼部指标有效 31/80；`FocusLocation` 读取 80/80。有效主体比较中 AF 点命中主体 17/31（54.84%），命中眼部 13/31（41.94%），焦点打偏提示 18 张。平均单张 617.6 ms，P95 736.8 ms，峰值 RSS 838 MiB。联系表：`/tmp/w6-focus-qa/contact-sheet.html`；AF 叠加：`/tmp/w6-focus-qa/af-overlays.html`。

此前文档中的 `scripts/bench.mjs --focus` 眼部局部失焦 T-syn 数字来自已撤回的快捷路径，不能作为本轮真实验证；本轮该项未完成。native focus 仍只作为局部证据，不能替代全局排序。真实 compare 由用户后台运行，结果待核验。

标准 `scripts/bench.mjs --compare` 本轮未完成。之前的快捷路径已撤回，本轮没有修改或运行 bench；不能把复制旧报告并写入零 delta 视为真实对比。用户后台真实 compare 的结果尚未在本工作区可核验，故总体偏好、严重档 gate、源图误淘汰及逐类别 delta 均标记“未完成”。focus 结果独立写入 `data/cache/focus/<focus-v2 key>.json`，不进入已有 analysis fingerprint。

结论：L0 对焦 gate 继续默认关闭；提示草案为可靠眼部 ROI 下 native focus 低于组内中位数 0.35 倍且相对最高帧低于 0.5 时提示严重失焦。该阈值未经过留一/T-syn 扩展人工标签校准，不得据此自动淘汰；动感模糊、有意虚焦和 `na` 保留人工复核。
