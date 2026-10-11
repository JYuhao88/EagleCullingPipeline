# 选片效果测试方案（2026-10-10 更正）

> 汕头 `20260718 汕头` 与 Eagle 原 38 个样片单元都是相机直出样本，没有摄影师精选。`good` 文件夹含义未知。旧 AUC、召回与「比随机差」结论已在 [eval-shantou-20260718.md](eval-shantou-20260718.md) 撤销。用户不需要亲自为基准打审美标签。

## 1. 测试分层

| 层 | 内容 | 什么时候跑 | 工具 |
|---|---|---|---|
| T0 单元与契约 | 代码正确性、接口契约、写回可撤回 | 每次修改相关模块 | `node --test`；最终全量检查 |
| T1 选片效果 | T-syn 可控退化、T-triage 连拍偏好、专家档位、隐式反馈 | 改测量、权重、候选算法前后 | `scripts/bench.mjs`；有明确真值时 `scripts/eval-picks.mjs` |
| T2 规模 | 1 万文件单批、10 万单元全库的耗时、内存、首屏时间 | 规模改造前后 | 压测脚本（待写），结果写入 `testing.md` |
| T3 实机 | Eagle 插件内启动服务、审阅、写回、撤回 | 发版前 | 清单见 `acceptance.md` |

## 2. 真值来源

| 基准 | 真值来源与范围 | 防止误用 |
|---|---|---|
| T-syn | 清晰、曝光正常的直出源图及可复现的成对退化；`expectedWinner: source`，严重缺陷另记 `expectedGate` | 仅验证退化方向及门槛，不代表源图是艺术佳作；同一源图所有退化必须在同一划分 |
| T-triage | Chang et al., SIGGRAPH 2016，官方验证／测试划分中 300–500 组连拍的众包偏好 | 先核实研究使用许可；不将训练划分用于验收；强偏好对阈值 ≥ 0.7；许可或下载阻塞则报告不可用，不伪造结果 |
| 专家档位 | 衣刀公开点评的档位及逐条理由（另一任务产出） | 保留出处、时间段、档位；只评估已有明确点评的样本；专家档位不是用户偏好 |
| 隐式反馈 | 用户日常选片中的保留、删除与规则豁免 | 不要求专门标注；未知／未审阅不是负类；保留与删除均保存反馈；训练与验证按会话隔离 |

汕头样本清单为 `test/fixtures/shantou-20260718-samples.json`，含 `allStems` 和未知语义文件夹列表，没有 `selectedStems`。Eagle 的文件夹、星级、标签也只有在语义确实得到确认后才可通过显式 `--truth` 使用。无需等待用户提供精选即可运行 T-syn 与许可允许的 T-triage。

源图覆盖需报告汕头与 Eagle 原样片各自的候选数、实际源图数、排除原因、相机／题材分布。T-syn 至少按关节裁切（腕、膝、踝、脖颈）、头顶切、留白过多、地平线倾斜 3–8°、运动／失焦模糊多档、±1.5–2.5EV（含面部高光）、强噪点拆开统计。无法可靠定位关节或地平线时不得伪装成已覆盖样本，报告跳过理由。

## 3. v1 gate 与偏好指标

以下是验收目标，不是已经达到的基线结果；本次实测及覆盖限制见 [eval-baseline.md](eval-baseline.md)。

| 指标 | 分母与含义 | v1 目标 |
|---|---|---|
| T-syn 源图误淘汰率 | 源图单张 `suggestDecision` 为 rejected 的比例；每源图只计一次 | ≤ 2%；同时报告源图数与不确定性 |
| T-syn 成对偏好准确率 | 源图分严格高于退化图的对数／可评估对数；同分单列，不算正确 | 总体及各类 ≥ 90%；多档退化分层报告 |
| T-syn gate 触发率 | 标注 `expectedGate` 的退化图在受控两图组中 `suggestDecision` 为 rejected 的比例 | 严重缺陷总体 ≥ 90%；每类单报，不混入只有扣分期望的样本 |
| T-triage 组内 top-1 | 与人群首选一致的组数／可评估组数 | 高于随机与时间顺序基线；报告差值及 bootstrap 95% CI |
| T-triage 强偏好成对准确率 | 仅偏好强度 ≥ 0.7 的官方标注对 | 高于随机与时间顺序基线；报告有效对数及 bootstrap 95% CI |
| 专家档位／规则一致性 | 有公开点评真值的样本，与专家档位顺序及缺陷判断的一致性 | 先建立独立基线；不得用未知样本补分母 |
| 隐式反馈保留误拒率 | 已确认日常保留的单元中被建议淘汰的比例 | ≤ 2%，按留出会话验证；未审阅样本不计 |

T-syn 不能验证表情、姿态美感或个人风格。T-triage 的众包偏好也不等于用户的个人审美。各来源独立报告，不把不同真值混成一个 AUC。闭眼、焦点等未由本次合成覆盖的 gate，需另有可靠样本才可宣称验证。

bootstrap 以独立源图（T-syn）／整组（T-triage）为重采样单位，避免把同源多档退化或组内相关对当作独立观察；报告固定随机种子、次数、95% CI。基线保留缺失值，评分器不可用时 `quality: null`，不替换成启发式质量分，也不把分析失败算成正确。

## 4. 每次改动的流程

1. 只跑相关 T0；最终跑一次 `npm test -- --test-skip-pattern='fixture face detection recall|fixture grouping reaches'`。
2. 使用固定元数据清单、变换参数、图片哈希及划分重跑基准；不修改 ranking/scoring/grouping/pipeline 来迎合评测。
3. 生成 JSON + Markdown：规模、按类准确率、gate、源图误淘汰率、T-triage top-1／成对偏好、CI、随机／时间基线及前次基线差值。
4. 失败、未知、缺失信号与跳过都明确列出；既有缓存回放与重新分析分开说明。
5. 报告保存到 `data/cache/bench/reports/<时间>/`，当前 `mac-ray-dev` 对照写入 `docs/eval-baseline.md`。

本机命令使用 `nice -n 10`，并发 ≤ 2；只读 Eagle，不写回，不访问任何名为「未删减」的对象。Ray 仅使用 CPU，结束时确认自己的 job 无 RUNNING/PENDING，不操作别人的作业。

## 5. 显式真值评估工具

`eval-picks.mjs` 保留多会话汇总、多预算召回、浏览量、组 bootstrap CI、随机／时间／文件名基线，仅用于已确认语义的真值。它读取保存的 run，不查询 Eagle。

```bash
nice -n 10 node scripts/eval-picks.mjs --run <runId> --fixture <confirmed-picks.json> --budget 0.3 --out /tmp/eval.json --md /tmp/eval.md
nice -n 10 node scripts/eval-picks.mjs --run <runId> --fixture test/fixtures/shantou-20260718-samples.json --truth 'star>=4'
nice -n 10 node scripts/eval-picks.mjs --config /tmp/sessions.json
```

第二条只在该 run 星级的偏好语义已确认时有意义，不表示汕头已有这种标注。配置为数组 `[{"run":"<runId>","fixture":"<fixture.json>"}]`，fixture 路径相对配置文件目录。重复 `--truth` 按 AND 组合；单元任一配对 item 满足全部条件即入选。`starTruth`、`tagTruth`、`folderTruth` 可通过 `anyTruth`／`allTruth` 组合。fixture 的 `allStems` 限定范围；显式 truth 覆盖 `selectedStems`。缺少 `selectedStems` 且没有 truth 时立即拒绝，不再默认加载汕头清单。

默认 `--bootstrap 1000 --seed 42 --random-iterations 100`。预算保留 `floor(单元数 × budget)`；模型按综合分，组内 top-1 按 rank，仅统计范围内恰好一张明确精选的多张组。跨会话汇总重新计算而非平均会话指标；时间缺失时退回文件名顺序。综合 AUC、预算召回等仅在此类已确认真值上适用，不能恢复旧汕头结论。
