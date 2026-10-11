# 实现计划（2026-10-10）

> 方案：[next-gen-plan.md](next-gen-plan.md)。测试：[test-plan.md](test-plan.md)。收集：[reference-collection.md](reference-collection.md)。

## 1. 实施原则

先确定输入输出契约，再拆分有明确文件边界和验收标准的实现任务。
隔离 worktree 与分支，审查实现、测试和评估证据后合并。并发和远端资源按部署环境配置，
不以历史内部资源额度作为公开运行要求。
老师模型仅供可选离线研究；不得把未经授权的照片、原文或凭证纳入发布包。

## 2. 契约

| 契约 | 内容 | 位置 |
|---|---|---|
| 测量信号 | 每个单元的 L0 信号名、取值范围、坐标系（原片像素 / 代理图归一化），如 `headroomHeads`、`edgeAtJoint[]`、`framingTier`、`eyeSharpnessNative`、`afPointOnEye` | `docs/contracts.md` §signals |
| 规则结论 | `{ruleId, verdict: pass/warn/violate/na, evidence, by: measure/teacher}`，每个单元一组 | `docs/contracts.md` §verdicts |
| 老师输出 | 逐条结论 + 整体建议 + 两两比较 `{a, b, winner, reasons, swapped}` | `docs/contracts.md` §teacher |
| 参考资料 | 视频点评抽取 `{bvid, segment, frame, tier, issues[ruleId], quotes[{text, t}]}` | `docs/contracts.md` §references |

## 3. 任务与波次

| 任务 | 内容 | 依赖 | 主要目录 | 验收 |
|---|---|---|---|---|
| **W1-A 评估工具** | `eval-picks` 多会话、30% 预算召回、浏览量、bootstrap 置信区间、时间顺序基线；真值支持 Eagle 星级和标签 | 无 | `scripts/`、`src/core/spot-eval.js`、`test/` | 汕头结果可复现；新指标有单元测试 |
| **W1-B 参考资料流水线** | 下载（已完成脚本）→ 语音转写 → 切照片 → 对齐，全部是 Ray 任务 | 下载完成 | `ml/references/` | 97 期全部有转写和照片切片；抽 3 期人工核对对齐 |
| **W1-C 测量层：关键点与裁切** | 接入 RTMW（ONNX），输出全身关键点；实现 `headroomHeads`、`edgeAtJoint`、`framingTier`、手截断；规则引擎对 `measure` 类规则出结论 | 信号契约 | `python_worker/`、`src/core/rules-engine.js`、`src/core/pose.js` | 汕头抽 50 张人工核对坏切 ≥ 90% 一致；单张 ≤ 150 ms |
| **W2-A 止损** | 曝光、TOPIQ、整图清晰度改为门槛；分组按时间间隔细分；允许一组多张入选 | W1-A | `src/core/ranking.js`、`grouping.js` | 汕头不低于随机，误拒率下降 |
| **W2-B 规则抽取** | Codex 从转写（必要时附截图）中抽取逐张点评、档位、规则候选；跨期汇总去重 → 规则库 v0.2 草案；**规则审核页**：浏览候选规则、正反例截图、跳回视频原话时间点，逐条通过/修改/删除 | W1-B | `ml/references/`、`src/rules/`、审核页 | 每条候选都有出处；你在审核页完成审核 |
| **W2-C 界面** | 规则面板、裁切参考线和骨架叠加、按问题筛选、「我故意的」豁免 | W1-C 契约（可先用假数据） | `src/plugin/`、`src/server/` | 浏览器实测截图；豁免写入事件日志 |
| **W3-A 老师试点** | 少量调用 可配置多模态服务 / Codex 看图：带规则逐条点评 + 组内两两比较；先抽样 20–50 张，在汕头精选和衣刀档位集上评估；结果缓存，用量记录 | 规则 v0.2、W1-B | `ml/teacher/` | AUC 明显高于 W2-A + W1-C 的规则组合 |
| **W3-B 原生分辨率对焦** | RAW 内嵌 JPEG 提取、眼部 100% 局部对焦指标、相机对焦点读取 | 信号契约 | `src/core/previews.js`、`focus.js` | 汕头抽查焦点打偏检出 |
| **W4-A 蒸馏与个人层** | 学生模型学老师结论；偏好头使用规则特征；按会话留一验证 | W3-A | `ml/student/`、`src/core/personalize.js` | 留出会话 AUC ≥ 0.70，误拒率 ≤ 2% |
| **W4-B 规模** | P0 规模改造、渐进处理、1 万文件压测 | 无（可随时插入） | `pipeline.js`、`run-store.js` | 压测结果写入 `testing.md` |

```text
契约 ──► W1-A 评估 ──► W2-A 止损 ─────────────┐
     ├─► W1-B 资料流水线 ──► W2-B 规则抽取 ──► W3-A 老师 ──► W4-A 蒸馏/个人层
     └─► W1-C 测量层 ──► W2-C 界面            │
                     └─► W3-B 对焦 ──────────┘
W4-B 规模：任一波次空出名额时插入
```

每个波次同时跑 3 个 Codex，一个结束就补下一个，不等整波完成。

## 4. 每个任务的固定流程

1. 我写任务说明（模板见下），创建 worktree，后台启动 Codex。
2. Codex 完成后，我审查 diff、跑验收命令；不通过就附上失败信息让它继续。
3. 合并进 `mac-ray-dev`，跑全量测试和 T1 评估，结果追加到对应文档，并在 `todo.md` 勾选。

任务说明模板：

```text
目标：……
背景文档：docs/next-gen-plan.md §…，docs/contracts.md §…
可修改：……　不可修改：……
输入/输出契约：……
验收：npm test；node scripts/eval-picks.mjs --run …；……
限制：本机 nice、并发 ≤ 2；Ray ≤ 2 GPU，用完无残留任务；不碰「未删减」；只在本分支提交，不 push。
完成时报告：改了什么、验收结果、已知问题。
```

## 5. 进度

| 日期 | 事项 |
|---|---|
| 2026-10-10 | 契约写入 `docs/contracts.md`（85a8bae）；RTMW/YOLOX 模型放入 `models/pose/`，worker 环境装好 onnxruntime 1.31 + rtmlib；第 1 波 3 个 Codex 启动：`w1-eval`、`w1-refs`、`w1-pose`（任务说明 `/tmp/codex-w1-*.md`） |
| 2026-10-10 | W2-B：CPU OCR/校验回传、预处理、版本缓存抽取、同义聚类/非选片分流/负样本、规则审核接口及独立页已实现；嵌套 Codex 初始化 EPERM，实际抽取未完成，三期样例/准确度和全量候选待沙箱外运行。HTTP 导出草案通路已验证；浏览器启动不可用，截图验收未完成。详细命令、数据报告和边界见 reference-collection.md §2.4。 |
| 2026-10-10 | W2-B 实际数据：97 期 / 11,957 段 OCR，1,773 段有档位（14.83%），195 文件 SHA-256 校验回传；97 期预处理；612 条低档待标注负样本。抽取成功 0，候选/非选片输出 0（受嵌套 Codex EPERM 阻塞）；npm test 128 通过 / 1 跳过 / 0 失败；本任务 Ray 无 RUNNING/PENDING 残留。 |
| 2026-10-10 | W2-A：曝光适合度/最大脸曝光、配置化 gate 后质量排序、60 秒时间跨度/两两直径分组完成。汕头 52→83 组、最大 66→19；全库 72→105 组，24 张 gate（闭眼 18 / 过曝 3 / 欠曝 4，可重叠）。只读全库 analyze 成功：run-1791606092754，582 文件/291 单元，291 signals、warnings=[]；最终缓存跑 12.307 秒。10 组联系表与 gate 表位于 /tmp/w2-fix-qa/。真实分组测试 F1=0.880 通过；定向 37/37 通过；指定完整测试 174 通过 / 1 既有长行失败（xhs-candidates.test.js:36、118），无新增失败。Git index.lock 被沙箱拒绝，保留改动，未提交/未 push。无精选真值，不报告 AUC 改善。详见 todo.md W2-A。 |
| 2026-10-10 | W2-UI：16 类淘汰理由词表、可跳过的多选理由及上下文数字快捷键、卡片规则证据/hint、组内改选偏好对；按库 SHA-256 分文件的追加式反馈（含替代与撤销重放）、统计 API 和独立 feedback-eval 已实现。新增测试 12/12 通过，含样式定向检查 13/13；指定全套 224 pass / 0 fail / 1 skip。43129 服务使用 `/tmp/w2-ui-qa/` 临时 fixture，health/catalog/stats 200，追加/修订/撤销 201；撤销后有效事件归零、无分母 rate=null。HTTP 证据 `/tmp/w2-ui-qa/http-checks.json`。浏览器自动审批拒绝本地 QA 页面访问，无截图/视觉验收；nice 优先级设置受沙箱限制，服务正常启动。未写回 Eagle、未触碰真实资源库；临时服务验收后停止。 |
