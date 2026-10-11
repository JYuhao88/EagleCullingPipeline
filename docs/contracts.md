# 数据契约 v1（分析引擎 ↔ 服务 ↔ 插件）

所有对象都带 `contractVersion: 1`，均为 JSON 可序列化对象。字段只能向后兼容地新增，不能改名或删除。校验函数在 `src/core/contracts.js`。

## Item（Eagle 中的一个文件）
```json
{ "id": "LXYZ...", "name": "DSC01234", "ext": "jpg", "path": "/abs/.../images/LXYZ.info/DSC01234.jpg",
  "size": 1234567, "mtimeMs": 1700000000000, "width": 6000, "height": 4000,
  "tags": ["人工标签"], "star": 3, "folders": ["..."], "thumbnailPath": "/abs/..._thumbnail.png|null",
  "captureTime": "2024-05-01T10:00:00.000Z|null" }
```

## CaptureUnit（拍摄单元，排序和决定的最小单位）
```json
{ "contractVersion": 1, "id": "unit:<主文件 itemId>", "primaryItemId": "LXYZ", "itemIds": ["LXYZ", "LRAW"],
  "formats": ["jpg", "arw"], "pairing": "paired|single|ambiguous", "pairingNote": "中文说明或空串" }
```
- 主文件优先 JPG/HEIC/PNG（可直接预览的格式）；RAW 跟随所属单元。

## UnitResult（每个拍摄单元的分析结果）
```json
{ "contractVersion": 1, "unitId": "unit:LXYZ", "fingerprint": "sha256(...)", "previewPath": "/abs/preview.jpg",
  "metrics": { "sharpness": 0.0, "exposure": 0.0, "clippedHighlights": 0.0, "clippedShadows": 0.0,
               "faces": 0, "eyesClosed": 0, "quality": 0.0, "aesthetic": 0.0 },
  "scorer": { "model": "technical-aesthetic-lite", "version": "1.0", "calibrated": false },
  "faces": [{ "box": [0.2, 0.1, 0.4, 0.4], "eyesClosed": false, "eyesAssessed": true,
              "blinkLeft": 0.12, "blinkRight": 0.08 }],
  "flags": ["blurry", "eyes-closed", "overexposed", "underexposed", "low-resolution"],
  "score": 0.0 }
```
- `metrics` 中数值统一归一到 [0,1]（`faces` 和 `eyesClosed` 为计数）；拿不到的值写 `null`。
- `source`（可选）记录代理与原生取像映射：`width`/`height` 为方向归一后的原片尺寸，`proxyWidth`/`proxyHeight` 为代理尺寸，`kind` 为 `embedded-jpeg|decoded-raw|jpeg|heic`；无法取得原生源时不猜尺寸。
- `focus`（可选）记录原生局部清晰度：`status` 为 `ok|na`，`eyeSharpnessNative`/`faceSharpnessNative` 为多尺度 Laplacian/高频信号，`relativeRank` 为组内相对名次，`afPointOnEye` 与 `afSource` 仅在 makernote 成功读取时填写；`naReason` 说明缺失原因。该信号当前只作提示，不改变既有排序或自动淘汰。
- `faces` 保存逐脸详情，`box=[x0,y0,x1,y1]` 是相对已旋转代理图的归一化坐标（[0,1]）。
  `blinkLeft` / `blinkRight` 对应 MediaPipe 的 `eyeBlinkLeft` / `eyeBlinkRight`，范围 [0,1]，不可用时为 `null`。
  `eyesAssessed` 表示两眼均有分数；未评估时 `eyesClosed=false`，不能据此认为睁眼。
  无人脸或模型不可用时 `faces=[]`；通过 `metrics.faces=0` / `null` 区分无人脸与未知。旧 run 可缺少 `faces`。
- 分析指纹版本为 `analysis-v6-exposure-gates`，附加姿态模型模式、provider 配置键；旧分析缓存不命中。`pose.cacheKey=signals-v2-edge-validity:portrait@0.1.0` 标记测量/规则阶段，缺失或版本不同会重跑姿态，不复用旧 signals。重新分析才会为旧 run 获取详情。

## Group（相似组）

W2-A（排序配置 v2.0，主契约仍为 v1）：`metrics.exposure` 改为曝光合适度，
`metrics.raw` 向后兼容增加 `midtoneFraction`、`previewSharpness`（代理图梯度原值）与可选 `faceExposure`
（`meanLuma` 0–255，`clippedHigh/clippedLow/midtoneFraction` 0–1）。
人脸曝光以最大检测脸为主体代理；无人脸保留整图曝光。排序先按严重硬伤门槛分层，再比较现有质量分；
gate 理由沿用 `ranking[].reasons`，未新增主结构字段。score 仍表示质量分，跨 gate 层的排名可与分数大小不同；
跨 gate 层的前两名不比较质量分差，`margin=null` 并保持低把握，避免误显示「与第二名很接近」。分析指纹升级为 `analysis-v6-exposure-gates`，旧 run 不自动改变。
拍摄时间从 EXIF 只读提取；分组增加完整链接直径、最大时间跨度及无完整时间时的文件序号跨度约束。
```json
{ "contractVersion": 1, "id": "group:<首个 unitId>", "unitIds": ["unit:A", "unit:B"],
  "ranking": [ { "unitId": "unit:A", "rank": 1, "score": 0.82, "reasons": ["最清晰", "曝光正常"] },
               { "unitId": "unit:B", "rank": 2, "score": 0.61, "reasons": ["可能模糊"] } ],
  "suggested": { "unit:A": "selected", "unit:B": "rejected" }, "confidence": "high", "margin": 0.21 }
```
- 单张也成一组（`unitIds` 长度为 1）。
- `reasons` 用中文短语，用户可以直接看懂。
- `margin` 是同 gate 层内按 rank 排序后第一名减第二名的排序分差，保留四位小数；单张、分数缺失或前两名跨 gate 层时为 `null`。
- `confidence` 为 `high|low|single`。多张组分差 `< 0.03`、分数缺失，或首选有
  `blurry|eyes-closed|overexposed|underexposed` 标记时为 `low`；否则为 `high`。
  `possibly-blurry` 不属于严重问题。近分首选理由追加“与第二名很接近，建议人工确认”。
- GET results 对旧 run 补算把握、分差和近分理由，读取不写回文件。

## AnalysisRun
```json
{ "contractVersion": 1, "id": "run-...", "status": "queued|running|completed|cancelled|failed",
  "progress": { "completed": 0, "total": 0, "cached": 0, "stage": "scanning|pairing|metrics|faces|grouping|ranking|done" },
  "startedAt": "ISO", "error": null, "libraryPath": "/abs/x.library", "itemCount": 76, "unitCount": 38, "groupCount": 0 }
```

## Decision（人工审阅决定，按拍摄单元记录）
```json
{ "contractVersion": 1, "unitId": "unit:A", "action": "selected|candidate|rejected", "flags": ["eyes-closed"],
  "source": "human|suggested", "updatedAt": "ISO", "category": "candidate|group|null",
  "tie": false, "reason": "各有所长或整组拒绝的简短理由" }
```
- `category`、`tie`、`reason` 是可选新增字段；旧决定缺失时按普通单张决定读取。`tie:true` 表示用户明确接受并列候选，`category:"group"` 可表示整组拒绝。

Group 可新增 `candidateSet`，不改变旧 `ranking`、`suggested` 字段：
```json
{ "mode":"epsilon-pareto", "dimensions":["sharpness","exposure","eyes","composition","quality","aesthetic","penalty"],
  "epsilon":{"sharpness":0.03}, "unitIds":["unit:A"], "entries":[{"unitId":"unit:A","candidate":true,"leaders":["清晰度领先"]}],
  "rejectedAll":false, "reason":null }
```
`unitIds` 为空且 `rejectedAll:true` 表示没有自动候选；缺失维度弃权，不视为 0 分。

## 服务端点（127.0.0.1:43125）
| 方法 | 路径 | 说明 | 负责方 |
|---|---|---|---|
| GET | /health | `{ok, service, contractVersion}` | 共用 |
| POST | /runs | body `{libraryPath?, itemIds?: string[], items?: Item[], options?}` → 202 AnalysisRun | 分析 |
| GET | /runs/:id | AnalysisRun | 分析 |
| POST | /runs/:id/cancel | 取消运行中任务；已结束返回 409 | 分析 |
| GET | /runs/:id/results | `{run, units: CaptureUnit[], results: UnitResult[], groups: Group[], items: Item[], groupOverrides, writebackAvailable: boolean}` | 分析 |
| GET | /runs/:id/preview/:unitId | 返回代理图（image/jpeg） | 分析 |
| GET | /runs/:id/detail/:unitId | 按需生成并缓存长边 2048 的 JPEG 细节图（image/jpeg） | 分析 |
| GET | /runs/:id/face/:unitId/:faceIndex | 按需裁剪指定人脸，长边不超过 320 的 JPEG（image/jpeg） | 分析 |
| GET/POST | /runs/:id/decisions | 读取或批量写入 Decision（持久化到 `data/runs/<id>/decisions.json`） | 审阅 |
| GET | /runs/:id/personalize | 返回偏好学习报告（结构见下） | 审阅 |
| POST | /runs/:id/personalize/apply | 无需 body；应用当前决定拟合的权重，只重排本 run 未审阅多张组 | 审阅 |
| POST | /runs/:id/apply | body `{apply: false|true, moveRejectedToTrash?: bool, confirm?: "MOVE_TO_TRASH"}`，默认 dry-run | 审阅 |
| POST | /runs/:id/writeback/revert | body `{apply?: boolean}`；默认执行，`false` 仅预览撤回 | 审阅 |
| POST | /runs/:id/groups/move | `{unitId, targetGroupId: "组 ID" 或 "new"}`，移动一个拍摄单元 | 审阅 |
| POST | /runs/:id/groups/split | `{groupId, unitIds}`，所选单元必须为原组的非空真子集 | 审阅 |
| POST | /runs/:id/groups/merge | `{groupIds}`，至少两个不同组，保留第一个组 ID | 审阅 |
| POST | /runs/:id/groups/undo | `{}`，撤销最近一次修正；空历史无操作 | 审阅 |
| GET | /runs/:id/report?format=json|csv | 每个文件一行：分组、排名、分数、理由、决定、写回标签和 tagsSource | 审阅 |

分析结果持久化到 `data/runs/<id>/results.json`；结果缓存放在 `data/cache/`，按 fingerprint 命中。服务重启后仍能读取已有 run。成功写回后，最终标签按 `{id, fileName, tags, previousTags}` 持久化到 `data/runs/<id>/applied.json`，报告优先使用这些标签；没有该文件时使用 planned 标签。

## 偏好学习：旧四指标与跨 run L1（向后兼容新增）

旧 `GET /runs/:id/personalize` / `POST .../personalize/apply` 保留四指标拟合和仅重排本 run 未审组。
`ready` 不再取决于固定 5 组：必须有真实 `updatedAt`，在 60%/80% 两个过去→未来整组切分中，
组/内容不得跨训练与留出，配对组 bootstrap 95% 提升区间下界均 >0。
`before/after` 仅来自留出组；不足时可为 `null`，`neededGroups:null`（不承诺固定起步数）。
新增 `splits, method, confidenceLevel, improvement, sampleCount, timestampedGroups`；原权重格式保留。
缺少时间的历史决定可读但不能伪造时间评估；无独立留出证据返回 `ready:false` / HTTP 409。

跨 run L1 只新增 `/runs/:id/learning` 系列接口，不改变 Decision 的字段/语义或 `decisions.json`：

| 方法 | 后缀 | 请求与行为 |
|---|---|---|
| GET | 空 | `?profileId=default`；返回 `config,head,report,snapshots,version,trainingData,profiles,drift` |
| POST | `/select` | `{profileId}`；选择 profile，未审组的其它/关闭快照恢复 L0，已审组保护 |
| POST | `/config` | `{profileId,config}`；关闭 L1 时未审组恢复 L0 |
| POST | `/exposure` | `{profileId,groupId,order,viewport,aiVisible,queryPolicy,allocationProbability,clientVersion}` |
| POST | `/backfill` | `{profileId}`；幂等回填当前 run 决定，历史曝光标未知 |
| POST | `/train` | `{profileId}`；只读取本地特征/事件，保存新快照与留出报告，不自动应用 |
| POST | `/rollback` | `{profileId,version}`；恢复精确权重/报告，需另行应用，保留全部事件 |
| POST | `/apply` | `{profileId}`；只有 enabled 且报告 ready 才重排未审组；否则 409、无结果写入 |
| POST | `/scan-deletions` | `{profileId}`；只读完整 Eagle 库存，核对受保护活动库前后均相同才写本地墓碑 |

profile ID 为 ASCII 字母/数字/下划线/连字符，1–80 字符，默认 `default`；人工切换，无自动混合。
默认 config：`enabled:false, halfLifeDays:90, recentGroups:25, driftThreshold:0.2,
debiasEnabled:false, debiasRate:0.05, pixelTier:0`。半衰期必须 >0；最近窗口 2–1000 组；档位仅 0/1。
UI 对照固定为 5% 的确定性交替顺序并隐藏建议；记录展示顺序与当次视口，不做主动学习自动排队。

L1 是带 L2 正则的 signed Bradley–Terry，小头输入为组内指标差、12 维固定 DINO 投影、缺失掩码，
另支持有来源的 portrait/street/landscape/general 概率×指标交互（缺失弃权，不估造类别）。
改动 AI/明确选择/批量接受的相对训练权重为 3/1/0.1，墓碑为 3；按组归一，配置半衰期衰减。
并列目标 0.5；整组拒绝不构造胜者；墓碑累计，整组删光不构造正例；undo 链优先。
批量接受不得作为“优于 L0”的评估证据。报告有整组 bootstrap 区间、有效组/对数、top-1、
pairwise、NDCG@5、tie 比例及 10/25/50/100/200 学习曲线；不足明确返回 `insufficient-data`。
启用需两个时间切分的 top-1 提升区间下界都 >0，并由用户手动应用；漂移只提示、不自动重训。
漂移比较相邻两个 `recentGroups` 非批量、有胜者的整组窗口：下降至少 `driftThreshold`，且
独立窗口差值 2000 次 bootstrap 单侧 95% 下界 >0 才提示。返回 `method,minimumDrop,difference`
作为新增诊断字段；数据不足保留 `insufficient-data`。重复查看不是多重检验校正。

应用保留严重硬伤/同组睁眼优先层级，已有任意人工决定的整组不动；不修改 Eagle 或全局权重。
ranking 可新增 `l0Rank,l0Score,preferenceScore`，Group 可新增 `l0Suggested,preferenceSnapshot`。
Group 另可保存 `l0Ranking`（应用前完整排序）与 `l0ReviewMetadata`（原 confidence/margin）；
关闭 L1 或切换 profile 时未审组精确恢复这些字段并移除 L1 快照元数据，旧 run 保留回退恢复路径。
`score` 仍为 L0 质量分；BT `preferenceScore` 是任意尺度 logit，不是概率。L1 rank 可与 score 大小不同；
L1 组保持 `confidence:low,margin:null`。后续评估必须使用保存的 L0 rank/score，不能用 L1 自作基线。

本地目录为 `data/learning/`（服务以 runs 根目录的同级 learning 为准）：
`features/v1/<前2位>/<sha256>.json`、`events/v1/events.jsonl`、`run-index/v1/`、
`preferences/<profile>/config.json,current.json,snapshots/<version>.json`、`pixels/v1/<sha>/manifest.json`。
特征 `schemaVersion:1` 存 embedding/metrics/focus/脸摘要/EXIF/抽取器/组上下文；缺失为 `na`。
identity.kind 区分 `original` 与 `proxy`，旧 run 只能取代理时明确标 proxy，不把 fingerprint 当内容哈希。
内容哈希用流式 SHA-256，持久 run 索引供原图删除后重放，不依赖 Eagle item 继续存在。
事件只追加，含时间/时区、run/group/profile、成员哈希、完整决定快照、实际 AI 建议与 L0 排名、
signal/tie/reason/category、曝光关联/耗时、模型/权重版本、undo 目标及删除证据；未展示不猜测曝光。
POST decisions 的 body 可新增独立 `learning:{profileId,signal,undo}`；这些信息不写入 Decision。
决定先保存；若附加特征/事件或像素保存失败，返回 `learningWarning`，界面明确显示，可回填重试。

档 0 不取像素。用户开启档 1 后，在之后的淘汰决定保存时串行复制原生局部（2–4 块、最长 512）
和最长 2048 总览 JPEG q92 到本地；不修改原片。已在 Eagle 外部删除的原片不能补取，标 unavailable。
可记录 retentionDays/expiresAt；到期自动清理、档 2/3、RAW/HEIC 专用解码暂未实现，不自动扩档。

人脸接口的 `faceIndex` 是 `results[].faces` 原数组的零基下标，不随插件按面积排序改变。
复用 detail 的取源与旋转逻辑：优先单元主文件，无法解码时回退代理图。按 box 每侧外扩脸宽/高的 35%，
裁切到图像边界后缩放（不放大小图），缓存到 `data/runs/<id>/face/<编码后的 unitId>-<faceIndex>.jpg`。
run ID 仅接受字母、数字、下划线和连字符；unit ID 解码后拒绝斜杠、反斜杠、NUL、`.` 和 `..`，
并要求单元存在于 run。无对应 run/单元/人脸、无效下标或 box、图像不可用均返回 404。

## 写回规则
- 动作标签：`AI精选` / `AI候选` / `AI淘汰`；问题标签：`AI闭眼` / `AI模糊` / `AI过曝` / `AI欠曝`。
- 一个单元的决定会写到该单元的**所有** item 上（包括 RAW）。
- 写回时只替换以 `AI` 开头的这 7 个标签，其它人工标签、星级、文件夹、注释一律保留。写回是幂等的。
- 移入回收站：只处理 `AI淘汰`，需要 `moveRejectedToTrash: true` 且 `confirm: "MOVE_TO_TRASH"`，默认关闭，永不真删。
- 不修改原片文件。

## 分阶段进度与分组修正

`serve --concurrency N` 控制分析并发，默认 2；插件启动命令使用 1 和 `nice -n 15`。
`GET /runs/:id` 新增 `startedAt`。指标阶段按已完成单元的平均耗时估计指标阶段剩余秒数；
人脸检测和最终分组阶段显示正在估算，不承诺准确的总 ETA。分析完成后插件自动进入审阅。
当前相似分组比较全量视觉信息；有 EXIF 时间时受组级时间跨度硬约束，人脸信息在指标完成后统一补充。
因此本版本不提供 partial groups 或提前审阅，避免后续合并改变已审组。

修正仅允许已完成 run，未完成返回 409；无效成员、空拆分、重复组等返回 400。
四个修正接口返回 `{groups, groupOverrides}`。`group-overrides.json` 格式为：

```json
{"contractVersion":1,"operations":[
  {"type":"move","unitId":"unit:A","targetGroupId":"new","newGroupId":"group:manual:UUID","updatedAt":"ISO"}
]}
```

`split` 记录 `groupId, unitIds, newGroupId`；`merge` 记录 `groupIds`。新组插入原组之后，空组移除。
加载 run 时重放操作，仅重算受影响组的排名及建议（复用 `rankGroup/suggestDecision`）。
撤销移除最后一个操作；原始 `results.json` 和 `decisions.json` 不变，人工决定仍按 unitId 优先。
写回及报告统一使用修正后的分组；读取时的 `run.groupCount` 随修正更新。

## 写回预览与撤回

`apply` dry-run 的 `results` 包含 `id, fileName, action, tags, previousTags, addedTags, removedTags, changed`。
`summary` 保留 `changed, unchanged, tags`，新增 `addedTags, removedTags`（标签增删总次数）及
`byAction`（各动作的 `changed, unchanged, addedTags, removedTags` 计数）。
插件按动作展示受影响文件数、无变化数和标签增删数，可展开每个动作前 50 条变化文件。
确认执行时重新读取当前标签，实际变化可能与预览之间的外部修改有关；执行结果以实时标签为准。

成功写回（含无变化项）记录写回前 `previousTags`。撤回读取上次 `applied.json` 对应项目的实时标签，
仅移除本工具管理的七个 AI 标签，再恢复 `previousTags` 中的这些 AI 标签；保留当前用户标签，
不写星级或文件夹。成功撤回更新记录的 `tags, revertedAt`，重复撤回不再改写，失败项可重试。
旧记录缺少 `previousTags` 时明确拒绝，不猜测旧标签；没有记录时也返回错误。
撤回不会恢复回收站位置，也不会撤销人工决定或分组修正。
CLI `apply --revert` 默认预览，追加 `--apply` 执行；HTTP 撤回接口默认执行。

真实照片分组测试使用独立临时缓存（`AnalysisPipeline` 的 `cacheRoot` 可覆盖，默认仍为 `data/cache`），
避免 worktree 的共享缓存链接受到沙箱写入限制；测试结束自动清理，不修改资源库。

## 下一代契约（2026-10-10，见 next-gen-plan.md）

以下对象同样带 `contractVersion: 1`，只能向后兼容地新增字段。

### Signals（L0 测量信号，按拍摄单元）

挂在 `UnitResult.signals` 下；缺失的信号不写，不写 `null`。坐标统一用**代理图归一化坐标** `[0,1]`（x 向右、y 向下，已按 EXIF 方向转正）；需要原片像素时用 `source.width/height` 换算。

```json
{ "contractVersion": 1,
  "source": { "width": 7008, "height": 4672, "proxyWidth": 2048, "proxyHeight": 1365, "kind": "embedded-jpeg|decoded-raw|jpeg|heic" },
  "persons": [{
    "box": [0.31, 0.08, 0.62, 0.97], "score": 0.93, "isMain": true,
    "keypoints": { "format": "coco-wholebody-133", "points": [[0.45, 0.12, 0.98], "..."] },
    "headHeight": 0.11,
    "headroomHeads": 0.42,
    "edgeAtJoint": [{ "edge": "bottom", "joint": "knee", "distanceHeads": 0.04, "side": "left" }],
    "framingTier": "chest|waist|thigh|full|knee-cut|other",
    "handsTruncated": [{ "side": "right", "edge": "right" }],
    "shoulderTilt": -4.2, "hipTilt": 3.1, "shoulderHipAngle": 7.3
  }],
  "focus": { "eyeSharpnessNative": 0.71, "afPoint": [0.48, 0.21], "afPointOnEye": true, "afSource": "sony-FocusLocation" },
  "faceExposure": { "faceClippedHighlights": 0.0, "faceClippedShadows": 0.01 } }
```

- `edgeAtJoint`：关节点在画外或距画面边缘 < 0.15 个头高、且相邻关节在画内时记一条；`joint` 取值 `hairline|neck|wrist|fingers|elbow|knee|ankle|foot`。
- `framingTier`：按画面下沿落在哪个身体区间判定；落在危险关节附近时写对应的 `*-cut`。
- 角度单位为度，顺时针为正。
- 模型直接预测的画外坐标仅在内部测量阶段使用，序列化 `keypoints.points` 的 x/y 截到 [0,1]；分数保留（截到 [0,1]）。因此只用序列化后的贴边点重新计算，无法恢复原始画外距离。新执行 QA 推理时 `raw-poses.json` 保存原始预测；若从旧 QA 的 all-results 重建该文件，画外坐标已经截断，不能恢复。
- 高分也不保证画外关节可信。当前实现对下沿严重压缩的下肢链做可观察性检查，无法定位时省略对应景别/输出 `na`，详见 research-portrait-body §7.2。可靠的 `pass` 与未检出/未知有区别。

`UnitResult.pose` 是可选诊断对象：`cacheKey`、`provider`（pose session 首个 provider）、`providers`（detector/pose session 列表）、`mode`、`timingMs`（detection/total），可能另有 `fallbackReason`。provider 列表不意味着每个算子都在首个加速器上执行。无人图也有检测耗时，但不执行 RTMW。

### RuleVerdict（规则结论）

挂在 `UnitResult.verdicts[]`。规则库见 `src/rules/*.json`（`id`、`severity`、`check.by`）。

```json
{ "contractVersion": 1, "ruleId": "P-CROP-KNEE", "rulesVersion": "portrait@0.1.0",
  "verdict": "pass|warn|violate|na", "by": "measure|teacher",
  "evidence": "下沿距左膝 0.04 头高", "personIndex": 0 }
```

- 同一规则可同时有 `measure` 和 `teacher` 两条；界面以 `measure` 为准，冲突时两条都显示。
- `gate` 规则 `violate` 时建议拒绝，但仍需人工确认。

### TeacherOutput（多模态老师，离线）

```json
{ "contractVersion": 1, "model": "qwen3-vl-…", "promptVersion": "teacher@0.1", "rulesVersion": "portrait@0.1.0",
  "unitId": "unit:…", "verdicts": ["RuleVerdict（by=teacher）"],
  "overall": { "suggestion": "keep|candidate|reject", "confidence": 0.7, "summary": "一句话点评" },
  "pairwise": [{ "a": "unit:…", "b": "unit:…", "winner": "a|b|tie", "reasons": ["表情更自然"], "swapped": false }] }
```

两两比较对每一对都问两次（`swapped` 为 false 和 true），两次不一致时记为 `tie`。

### ReferenceCritique（参考资料抽取，按被点评的照片）

存放在 Ceph `references/<来源>/`，仓库只存汇总。

```json
{ "contractVersion": 1, "source": "yidao", "bvid": "BV1TxLV6oE88",
  "segment": { "index": 12, "start": 431.2, "end": 488.0 },
  "frame": "frames/BV1TxLV6oE88/012.jpg",
  "tier": "夯|顶级|人上人|NPC|拉|null",
  "verdict": "good|mixed|bad|null",
  "issues": [{ "ruleId": "P-CROP-KNEE|null", "text": "腿切在膝盖了", "t": 452.3 }],
  "praises": [{ "ruleId": null, "text": "光线找得好", "t": 440.1 }],
  "topics": ["framing", "pose", "light", "color", "retouch", "gear"],
  "transcript": "该时间段的转写原文" }
```

`ruleId` 为 null 表示规则库里还没有对应规则，是新规则候选。

### Feedback（正常审阅产生的隐式反馈）

`contractVersion:1`；反馈独立于 `Decision` 和 Eagle 写回。审阅时异步记录保留、淘汰、组内首选变化、撤销；淘汰理由可多选或跳过。文件以资源库路径的 SHA-256 分库，追加到 `data/feedback/<64位库名哈希>.jsonl`，每行一条 JSON，不修改已有行。

```json
{ "contractVersion": 1, "id": "UUID", "at": "ISO",
  "runId": "run-...", "analysisSignature": "分析签名或结果指纹摘要",
  "unitId": "unit:B", "itemIds": ["B", "BRAW"],
  "action": "keep|reject|winner-change|undo", "reasons": ["R-P-EYES"],
  "prevWinner": "unit:A", "newWinner": "unit:B",
  "toolSuggestion": { "decision": "keep|reject|unknown", "gates": ["eyes-closed"],
                      "violations": ["P-FACE-EYES"] },
  "source": "review-ui" }
```

`prevWinner/newWinner` 仅用于 `winner-change`，表示新首选优于原首选；两者须不同且属于当前同一组，`unitId=newWinner`。`reasons` 是 `src/rules/reject-reasons.json` 中的理由 ID 数组，允许空数组；重复 ID 去重。`itemIds`、分析签名与工具建议由服务端从 run 获取，客户端无法覆盖。工具建议来自组建议（selected/candidate 均视为 keep）与严重门槛，`gates` 包含技术 flag 或违反的 gate 规则 ID，`violations` 只含 `verdict=violate` 的规则 ID；warn/hint 不自动等同拒绝。分析签名优先用 run 的签名，否则对有序 `[unitId,fingerprint]` 列表求 SHA-256。

每次追加由服务端生成 `id/at`。后续追加的理由修改可带 `replaces: "旧事件ID"`，替代同 run、同单元、同动作的有效事件；撤销追加 `action:"undo", undoOf:"有效事件ID"`。逆序重放计算有效事件：撤销替代事件后恢复被它替代的旧事件；已失效或跨 run/单元引用会拒绝。原始日志保留替代与撤销历史，不在统计中重复计数。不保存文件名、原图、标签、星级、文件夹或个人身份信息，日志也不保存资源库路径。

| 方法 | 路径 | 请求与响应 |
|---|---|---|
| GET | `/api/feedback/catalog` | `{contractVersion:1,reasons:[{id,label,ruleIds,genre,hotkey?}],rules:[{id,title,label,severity,hint}]}`；中文标签来自当前规则库及候选库，引用候选不表示该规则已启用 |
| POST | `/runs/:id/feedback` | body `{unitId,action,reasons?,prevWinner?,newWinner?,replaces?,undoOf?}` → 201 `{event:Feedback}`；不存在 run 返回 404，单元、动作、理由或引用无效返回 400 |
| GET | `/api/feedback/stats?runId=...` | 无 runId 汇总本地全部反馈库；有 runId 仅统计该 run，未知 run 返回 404 |

stats 返回 `{contractVersion,totalEvents,activeEvents,byAction,undoEvents,byReason,falseRejectProxy,keepRejectedProxy,reasonVerdictAgreement,winnerChangeRatio}`。`totalEvents` 为原始行数，`activeEvents/byReason` 与 `byAction` 的 keep/reject/winner-change 基于撤销及替代后的有效事件；`byAction.undo/undoEvents` 为原始撤销动作数。所有比率统一返回 `{numerator,denominator,rate}`，无分母 `rate:null`，不表示 0%。

- `falseRejectProxy`：工具建议 reject 而用户 keep 的数量 / 有效 keep/reject 中工具建议 reject 的数量。
- `keepRejectedProxy`：工具建议 keep 而用户 reject 的数量 / 有效 keep/reject 中工具建议 keep 的数量。组建议 selected/candidate 均视为 keep；unknown 不进入上述分母。
- `reasonVerdictAgreement`：有效 reject 中，与 `gates ∪ violations` 有规则 ID 交集或命中对应技术 gate flag（模糊、闭眼、过曝、欠曝）的理由数 / 有规则映射的所选理由数；重复/其他等 `ruleIds:[]` 不进入分母。它衡量理由对齐，不是摄影师真值准确率。
- `winnerChangeRatio`：有效 winner-change 数 / 有效 keep、reject、winner-change 总数；这是审阅动作比例，不是被审过的组中改选比例。

`node scripts/feedback-eval.mjs [反馈目录或JSONL文件]` 使用相同撤销重放及统计口径，默认 `data/feedback`；无数据或无对应分母时明确输出说明。

审阅交互：淘汰后理由面板不弹窗；1–9 临时切换前九项，Enter/Esc 或切图/切组结束面板并恢复 1/2/3 决定。其余理由点击选择。默认预选 violate 或 gate 对应理由及模糊/闭眼/过曝/欠曝 flag；宽泛曝光违例根据方向证据区分明暗。组淘汰按每张的违例独立预选，混合选中显示“部分”；可取消或清空。S /“设为本组首选”记录新首选优于上一人工首选（无人工首选时用工具首选）；单纯多张保留不生成偏好对。U 撤销整批决定及该批所有理由修订。候选操作在反馈中表示 keep（继续留在候选池）。跳过补充保留默认理由，清空可提交无理由淘汰。

反馈与写回使用独立请求：记录失败不阻塞决定或 Eagle 写回，写回失败不删除已记录反馈。既有 `/runs/:id/apply` 与写回标签契约保持不变。

## W6 规模兼容扩展（2026-10-11）

扫描 Item 新增可选 `fileStat: {size,mtimeMs,birthtimeMs}|null`、`device: {make?,model?,serial?}|null`、
`exif: {dateTimeOriginal,subSecTimeOriginal,offsetTimeOriginal,localDate}`、`sessionId`。
`captureTime` 为 EXIF 拍摄时间的 ISO 毫秒值；亚秒原字符串完整保存在 `exif.subSecTimeOriginal`，
时区偏移为 `±HH:MM` 或 null。无时区的 EXIF 按 UTC wall-time 时间轴表示，但 offset 保持 null，
不能将其当作已知 UTC 时间。文件 stat 不作为拍摄时间或会话边界。
会话按设备 make/model/serial、EXIF 本地日期、偏移及相邻拍摄间隔 >30 分钟拆分；
CaptureUnit 可带 `captureTime/sessionId`。RAW+JPG 在同会话同文件主干内配对，旧无 EXIF 输入维持旧逻辑。
EXIF/exiftool 不可用时保留无时间退化；有时间与无时间的同名文件保守分离，不猜测归属。

分组保持完整链接、平均相似度和最大组大小约束；有 EXIF 的单元通过时间桶索引仅访问
最大时间跨度（默认60秒）内的候选组，并隔离已知不同会话。缺少时间继续兼容全量候选路径。
`groupResults` 同步接口保留；pipeline 使用同分区的异步分批接口，支持取消。
新增可选 run/results 字段 `duplicateCandidates: { [unitId]: priorUnitIds[] }`：UTC 日不同的 pHash
半径4候选，最多100条/单元，只返回此前索引到的单元；这是重复召回证据，不自动合并连拍组、排序或淘汰。
旧结果缺字段可读。HTTP GET results 同样可返回此字段，当前插件尚未呈现重复候选。

run.json 仅包含轻量状态；进度默认每250ms或阶段变化持久化一次，进度读取不加载全 results。
扫描/配对完成后先保存轻量 run；终态一次写入完整 items/units/results/groups，并原子替换文件，
结果写完后再发布终态。未完成 run 不提供 partial groups；结果读取仍为完整 payload，尚无分页。
