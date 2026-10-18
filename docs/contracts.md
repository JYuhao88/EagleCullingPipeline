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
  "progress": { "completed": 0, "total": 0, "cached": 0, "stage": "scanning|pairing|metrics|embedding|faces|pose|focus|grouping|ranking|done" },
  "startedAt": "ISO", "error": null, "libraryPath": "/abs/x.library", "itemCount": 76, "unitCount": 38, "groupCount": 0 }
```

## Decision（人工审阅决定，按拍摄单元记录）
```json
{ "contractVersion": 1, "unitId": "unit:A", "action": "selected|candidate|rejected", "flags": ["eyes-closed"],
  "source": "human|suggested", "updatedAt": "ISO", "category": "candidate|group|null",
  "tie": false, "reason": "各有所长或整组拒绝的简短理由" }
```
- 自由理由 `reason` 为最多 500 个 UTF-16 code units 的字符串；审阅卡片输入随保留/候选/淘汰提交，数字键在输入框焦点内不触发决定。服务端整批校验后原子写入，学习事件保存同一理由，报告新增 `decisionReason`。预设 feedback 理由仍保留。
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
| POST | /runs | body `{libraryPath?, itemIds?: string[], items?: Item[], options?}` → 202 AnalysisRun；忙碌409包含`{error,run}`与进度 | 分析 |
| GET | /runs/status | 只读活动/最近任务metadata；无活动进程的旧running返回interrupted，单任务GET一致 | 分析 |
| GET | /runs?limit=20&cursor=0 | `{runs: RunSummary[], page}`，按开始时间倒序 | 分析 |
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
| POST | /runs/:id/trash-rejected | body `{apply: false|true, confirm?: "MOVE_TO_TRASH"}`，默认预览；只移动人工淘汰单元的全部 item，跳过已不在资源库的 | 审阅 |
| POST | /runs/:id/writeback/revert | body `{apply?: boolean}`；默认执行，`false` 仅预览撤回 | 审阅 |
| POST | /runs/:id/groups/move | `{unitId, targetGroupId: "组 ID" 或 "new"}`，移动一个拍摄单元 | 审阅 |
| POST | /runs/:id/groups/split | `{groupId, unitIds}`，所选单元必须为原组的非空真子集 | 审阅 |
| POST | /runs/:id/groups/merge | `{groupIds}`，至少两个不同组，保留第一个组 ID | 审阅 |
| POST | /runs/:id/groups/undo | `{}`，撤销最近一次修正；空历史无操作 | 审阅 |
| GET | /runs/:id/report?format=json|csv | 每个文件一行：分组、排名、分数、理由、决定、写回标签和 tagsSource | 审阅 |

`GET /runs` 默认 limit=20，范围 1–100；cursor 为非负整数，参数无效返回 400。
page 为 `{total,cursor,limit,nextCursor}`，末页 nextCursor=null；同时间按 ID 倒序。
摘要字段：`id,status,startedAt,itemCount,unitCount,groupCount,reviewedGroupCount,scope,error,progress`。
只读取 run 元数据、分组摘要及人工决定，不读取完整 results、JSONL 结果分片或原片。
所有组内单元都有 source=human 决定才算已审；无轻量组摘要的旧 run 返回 reviewedGroupCount=null。
新 run 终态及修组后保存 review-summary.json；兼容未修组的旧 results-index.json 组摘要。
POST /runs 可带 `scope:{type:"selection"|"folder"|"library",label,folderId?}`，仅用于显示范围。
旧 run 的 scope 为 `{type:"unknown",label:"以前的分析"}`；失败/取消原因在 error 中，续跑使用 resumeRunId。

新分析结果持久化到 `data/runs/<id>/results-index.json` 与 JSONL 分片；旧 `results.json` 可读。结果缓存放在 `data/cache/`，按 fingerprint 命中。服务重启后仍能读取已有 run。成功写回后，最终标签按 `{id, fileName, tags, previousTags}` 持久化到 `data/runs/<id>/applied.json`，报告优先使用这些标签；没有该文件时使用 planned 标签。

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
- 移入回收站：`/apply` 只处理 `AI淘汰`，需要 `moveRejectedToTrash: true` 且 `confirm: "MOVE_TO_TRASH"`，默认关闭，永不真删。
  插件使用 `/trash-rejected`：只处理人工决定为淘汰的单元（不含 AI 建议淘汰但未决定的），同样需要确认词，永不真删。
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

W22：Mac 默认 provider 为 CPU，分析指纹的姿态键明确记录 `CPUExecutionProvider`，不再用 auto；
显式 provider 覆盖保留。缓存/检查点中的实际 detector/pose provider 不匹配或有回退记录时重新测量，
不得把回退结果当作请求 provider 的结果复用。Windows/Linux provider 顺序保持；实测边界见
[pose-provider.md](pose-provider.md)。

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

审阅交互：淘汰后理由面板不弹窗；1–9 临时切换前九项，Enter/Esc 或切图/切组结束面板并恢复 5/3/1 决定（与 Eagle 星级一致）。其余理由点击选择。默认预选 violate 或 gate 对应理由及模糊/闭眼/过曝/欠曝 flag；宽泛曝光违例根据方向证据区分明暗。组淘汰按每张的违例独立预选，混合选中显示“部分”；可取消或清空。S /“设为本组首选”记录新首选优于上一人工首选（无人工首选时用工具首选）；单纯多张保留不生成偏好对。U 撤销整批决定及该批所有理由修订。候选操作在反馈中表示 keep（继续留在候选池）。跳过补充保留默认理由，清空可提交无理由淘汰。

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

## 眼部 ROI 补全（W10）

`completeEyeRois` 使用已旋转代理图上的 RTMW WholeBody 68 点脸部索引 59–70，
两眼各六点置信度至少 0.5；优先保留现有有效 `eyes`/`eyeBoxes`。
空间匹配多个脸时弃权。无脸检测时需要完整 68 点均可靠及眼部中心位于人体框内，
新增 `roiSource:"rtmw-face"`、`eyesAssessed:false`，不生成闭眼分数。
新增 `eyeRoiSource:"rtmw-68"`、`eyeRoiConfidence` 仅说明定位来源。
原生 focus 与 focus-crop 共用补全函数；focus 缓存升级为 `focus-v3` 并包含 ROI 版本。
`AnalysisPipeline.run` 可传 `nativeFocus:false` 跳过原生 focus；默认保持启用，
用于把只读验收的原生解码限制到独立 80 张 QA，不改变评分模型。

## W10：分段结果、分页与阶段续跑（主契约仍为 v1）

新 run 使用 `results-index.json` + `results-<generation>/{units,results,items,groups}-<shard>.jsonl`。
每片目标上限 16 MiB；一条超限记录仍保持完整，不切断 JSON 行。
索引的 `storageVersion:1` 包含各类 ID 的 `[shard,byteOffset,byteLength]`、组摘要及分析签名。
先写不可变片，再原子发布索引，最后发布 run 终态。旧 generation 保留供在途读者使用，尚无自动回收。
旧 `results.json` 只读兼容；重新保存生成新格式，不修改旧文件。
旧格式兼容读取仍会物化完整旧 JSON；新格式的单元、组页、图片、报告路径按偏移读取。
内部 `get/results` 为旧学习/修组调用保留物化接口；仅 ≤64 MiB 的完整载荷可缓存，最多两个 run。
新 fingerprint 缓存放 `data/cache/results-v2/<hash-prefix>/<hash>.json`，原子替换；
旧 `data/cache/results.jsonl` 流式建立偏移索引，仅读取，不截断共享日志。

HTTP 新增/扩展：

| 请求 | 行为 |
|---|---|
| `GET /runs/:id/groups` | 仅组摘要：`id,unitIds,size,confidence,margin,flags,previewUnitId`，附 `run,page` |
| `GET /runs/:id/results?limit=20&cursor=0&filter=multi` | 返回本页完整组及其 units/results/items，附 `page` |
| `GET /runs/:id/results?groupId=<encoded-id>` | 按需加载一组 |
| `GET /runs/:id/results?unitId=<encoded-id>` | 返回该单元及其所属组；单元载荷只包含目标单元 |
| `GET /runs/:id/decisions?limit=20&cursor=0&filter=multi` | 与组页对应的有效决定，附 `page` |
| `GET /runs/:id/report?format=json\|csv&limit=20&cursor=0` | 按组分页报告；JSON `{rows,page}`；CSV 一文件一行 |
| `GET /runs/:id/report?format=json\|csv` | 流式导出全部报告；JSON 保留数组，CSV 保留 BOM/表头/转义 |
| `POST /runs` body `{resumeRunId:"run-..."}` | 使用原始输入及扫描检查点续跑同一 run；完成的 run 拒绝续跑 |

`limit` 默认 40，范围 1–200；`cursor` 为非负整数组偏移的字符串。
`page={total,cursor,limit,nextCursor}`，末页 `nextCursor:null`。
过滤值：`all,multi,confirm,singles,low-first,unreviewed,reviewed,issues,eyes-closed,blurry`；
`confirm` 指低把握组。过滤先于分页；游标仅在分组/决定和过滤条件不变时稳定。
新格式 `/results` 无查询时也默认分页；旧格式无分页查询保持旧完整响应。
报告分页单位是组，输出行数取决于该页组内单元和 RAW/JPG 成员数。
审阅页每次读取 20 组，并提供上一页/下一页；进度与批量操作显示/作用于当前页。
按单组审阅、决定、曝光保留完整组上下文；局部学习索引更新合并其它页的记录。

`checkpoints.jsonl` 为 run 私有追加日志；恢复时只索引偏移，忽略/修复未提交的末行。
扫描按 EXIF 批保存已发现文件，扫描/配对完成后保存 items/units；指标、嵌入、人脸、姿态、
原生焦点按单元保存；分组完成后保存组边界/重复候选；排序按组保存。
分组/排序检查点绑定单元 fingerprint 序列签名；输入变化不复用陈旧分组。
阶段 `progress.stage` 向后兼容增加 `embedding,pose`。
取消请求先发送 AbortSignal；扫描/EXIF、人脸/姿态 worker、异步分组、排序循环及各单元边界检查信号。
Sharp/ONNX 的单次原生调用无法抢占，取消在该调用返回后生效；不会启动下一批。
取消后的活动任务在 worker 全部退出/终态保存前继续占用本服务的分析槽位。
完成阶段可跳过；未完成的扫描枚举/分组从上一阶段边界重做；不承诺任意计算指令位置恢复。
检查点用于进程中断恢复，不提供断电时 fsync 事务保证。


## W19：分析总体进度（兼容扩展）

`Run.progress` 保留 `stage/completed/total/cached`，新增：

- `overallPercent`：0–100 的总体百分比，同一次执行中阶段切换和扫描子阶段切换不倒退；
  完成前最多 99.9，分析完成为 100。
- `elapsedSeconds`：本次执行的单调时钟已用时间；续跑重新预热，不沿用旧速率。
- `stageRatePerSecond`：30 秒滑动窗口内的当前阶段工作项/秒；
  至少观察 5 秒且完成 3 个工作项才提供数值，否则 `null`。
- `remainingSeconds`：以实测速率和阶段预算推算整个分析的剩余秒数；
  未预热、未知总数、阶段切换或窗口内无进展时为 `null`，完成为 0。
- `stageDurationsMs/stageWeights`：阶段耗时与本次使用的权重，供后续实测校准和诊断。

faces/pose 的工作项包含推理和后处理；ranking 以组计数，其余计数沿用阶段原本单位。
不能把所有阶段的速率都称为照片/秒。服务每秒更新已用时间，即使该阶段尚无新完成项。
初始权重取本轮 Windows CPU 采样比例的近似值；以后从最近最多 5 个未命中分析缓存、
且所有阶段都有有效耗时的成功 run 取归一化平均权重。设备/provider、照片内容和缓存命中
变化仍会影响预测；ETA 是以实际吞吐为输入的估计，不是完成时刻保证。
旧 run 缺少扩展字段时插件显示估算中/未记录，不按整个 run 的耗时伪造阶段速率。


## W22：跨分析拍摄元数据缓存

`data/cache/capture-metadata/metadata.json` 只保存 `parseCaptureMetadata` 的
`captureTime/exif/device` 输出，不缓存会话边界。键为规范化绝对源文件路径、实际
size、mtimeMs 的 JSON 数组的 SHA-256；Windows 使用 win32 路径规范化并忽略大小写。
解析器版本 `capture-v1` 变化、文件大小/mtime 变化、内容校验失败或结构损坏均失效；
读取期间文件变化、exiftool 失败/缺行/返回 Error 不写入缓存。成功读取但无 EXIF 可缓存。
文件以唯一临时文件加原子 rename 发布，缓存 I/O 失败不影响分析。
最多 20,000 条、32 MiB，写入时按最早插入顺序淘汰；可停服务后删除该文件冷启动，
可同时清理进程中断遗留的 `metadata.json.*.tmp`，不必清理其它缓存。
多进程同时发布可能丢失新增缓存条目，只导致后续重读。
扫描仍遍历全库，命中立即计入扫描 completed/cached；`scan:<id>` 检查点保持原行为，
会话由原有全库逻辑计算，不改变选择范围、分组或排序。

## W22 看图器高清缓存

原生区域 GET 保持 `box` 与面积上限 0.36，新增物理显示像素 `width/height`；
缺参和接近 1:1 保留原生分辨率，响应 `x-native-tier: mid|original`。
新增 `POST /runs/:id/native/:unit/prefetch`，可中止的本机串行低优先级预取，活动分析时跳过。
参数、LRU、取消边界与验证见 [native-mid.md](native-mid.md)，不参与分析/评分。

## 本地模型观察（W30，展示字段）

W36 的单张评片与后期建议目前只提供离线研究工具与研究结果：版本化提示词在
`ml/observe/prompts/critique-v1.md`，每条研究结果记录原文件 SHA-256、模型 revision、A/B 变体和固定种子。
A 只看最长边 768 的无元数据整图，B 另读已有分析结果中的已上线专科正类事实；没有发言不推断为否定。
研究输出含 `summary/strengths/issues/edits/verdict`，其中 `verdict` 只是待评估的模型文字，
不映射到生产规则 verdict、评分、排序、分组或人工决定。本轮不新增 HTTP 字段、检查器 UI 或运行时模型调用。
门槛、费用及全量/部分参照结果见研究文档 6.9 节；通过离线门槛也不等于 Windows GGUF 或真实 Eagle 端到端验收。
两个候选的全部计划推理与新增教师请求已结束；8B 基线保留部分核验，未追加。
格式合格率、三家票覆盖和冻结统计门槛分别报告；格式失败或缺参照不缩减完整计划分母。
本轮没有已验收的部署方案。回执确认金额、新增未知费用预留、429 次数与旧路径账务不确定性分开报告。
`python3 -m ml.observe.critique_sensitivity` 只从相同冻结输入和已收回的教师票生成事后描述，不覆盖验收报告或更改 v1 判定。
其多数条件精度、完整三票支持率、无人判错比例及两两 κ 使用各自明确分母；全弃权不能视为正确。
v2 的提示词方向与前瞻参照草案见 `ml/observe/prompts/critique-v2-plan.md` 及配套 JSON；尚未冻结完整提示词和独立留出，本轮未运行。
离线 W36 可用 `--replicas 2` 在同一个已准入 Ray 作业内运行两份独立单卡模型；同一照片的全部变体和复问留在同一卡。
提示词、生成设置及门槛不变。显存报告分别保留单卡最大峰值与两卡各自峰值之和；后者只是上界，不是同时峰值。
本轮获授权的并行准入为项目最多三个作业、其中最多两个申请 GPU，本线最多一个 GPU 推理和一个 CPU 教师评判作业。
MiniCPM 本次 loader 的参数驻留记录为 BF16；官方 int4 检查点身份不代表已验证 4-bit 驻留或 Windows GGUF 性能。

当前上线头为 `src/core/observation-heads/clip-face-v1.json`（在笑、嘴张开）与
`gaze-iris-q2-clip-v1.json`（看镜头，740 维虹膜二次项与 CLIP 整脸组合）；均只在 Open Images 上训练和校准，
验收数字见 [research-local-observations.md](research-local-observations.md) 6.2、6.7 节。每次分析开始只枚举一次此目录；
没有有效 JSON 头时完全跳过 `observations` 阶段，无编码器加载、模型哈希、裁剪、观察缓存或逐单元推理开销。
坏文件、缺字段、任意属性形状不符、模型不存在或 SHA 不符均停用该文件，不影响其它分析阶段。
安装或替换分类头后，在下次分析或续跑时生效；已完成 run 的历史结果不会自动重算。
视线头只输出正类“看镜头”，阈值 `0.91`、温度 `1.076452351253655`、最小脸高 `0.05`；
没有有效虹膜/姿态组合特征或 Python worker 不可用时弃权，其它头照常运行。观察继续只用于展示。

一个 JSON 文件是一组使用相同编码器和输入的二分类属性。根字段如下：

| 字段 | 要求 |
|---|---|
| `version` | 非空版本字符串，最长 128 字符；更换训练数据、预处理、权重或校准时升级 |
| `encoder` | `{id:"clip-b32-q"\|"dinov2-small"\|"mediapipe-iris-pose-q2-clip-b32-q", dimensions:512\|384\|740, modelSha256:"64 位小写十六进制"}`；虹膜组合编码器另须 `clipModelSha256`（同格式），且只接受 `face-crop` |
| `input` | `{type:"face-crop",expansion:1.8,size:384}` 或 `{type:"full"}`；`face-crop` 可加 `minFaceHeight`（0–1 开区间），主体脸框高度低于它时该头不裁剪、不推理、不发言 |
| `attributes` | 1–64 个属性，`id` 在该文件内唯一 |

本地模型位置分别为 `models/clip/vision_model_quantized.onnx` 与 `models/dinov2-small/model.onnx`；
DINOv2 保留现有 `EAGLE_DINO_MODEL` 覆盖，路径通过 `path.resolve/join` 处理。
虹膜组合编码器的主模型为 `models/mediapipe/face_landmarker.task`，`encoder.modelSha256` 对应该文件
（当前清单 SHA-256 为 `64184e229b263107bc2b804c6625db1341ff2bb731874b0bcc2fe6544e0bc9ff`），
`encoder.clipModelSha256` 对应上述 CLIP 文件。加载结果的 `model`、`clipModel` 为两个模型的绝对路径。
启动分析时流式计算本地模型文件 SHA-256，与头声明严格比对；组合编码器缺少任一文件、辅助 SHA 缺失、
格式错误或任一 SHA 不符时停用整个头。辅助 SHA 随头完整内容进入哈希与观察缓存身份。
编码器复用 `ai-tags.js` / `embeddings.js` 的进程内会话；会话身份含路径、大小、mtime 与原有 provider。
观察逐单元串行推理，沿用编码器现有线程数和 DINO provider；原图解码沿用 `withNativeImage` 的
nice/turbo 并发及内存预留。单次 Sharp/ONNX 调用不可抢占，返回后检查取消，不启动下一单元。

`face-crop` 选择主体人脸：有 `isMain` 人体时，只接受唯一一个超过半数面积落在该人体内的有效脸框；
没有主体人体时取最大有效脸框。主体匹配含糊、没有脸框时弃权。框坐标为旋转后画面的归一化坐标。
以框中心为中心，按实际像素宽高取 `floor(min(width, height, 1.8 * max(faceWidth,faceHeight)))` 边长的正方形；
贴边时整体平移回画面内（左上角四舍五入），不补黑，与老师标注和训练数据的裁剪
（`scripts/observe-teacher.mjs`、`scripts/openimages-sample-ray.py`）的方框几何一致。历史 JPEG 老师视图与生产 PNG
不逐像素相等；验收必须重新使用生产裁剪。ROI 以 Lanczos3 缩到
384×384 sRGB、无 alpha 的无损裁剪。优先复用 focus 回调已解码的像素，
非 RGB JPEG 路径复用 focus 既有 q96 JPEG 缓冲；focus 已缓存时使用相同有界原图入口，
只提取并缩放 ROI，不新增整张原图输出缓冲。原图不可用才退回已旋转的预览图。
此 384 裁剪再送入下述现有编码器预处理；编码器 ONNX 输入仍为 224，训练必须采用同一流程。

特征固定为：

- CLIP：现有 `rotate → cover 224×224 cubic → sRGB → /255 → CLIP mean/std`，
  mean `[0.48145466,0.4578275,0.40821073]`，std `[0.26862954,0.26130258,0.27577711]`；
  `image_embeds` 输出再作 L2 归一化，512 维。
- DINOv2：现有 `cover 256×256 Lanczos3 → 中心 extract [16,16,224,224] → /255 → ImageNet mean/std`，
  mean `[0.485,0.456,0.406]`，std `[0.229,0.224,0.225]`；不额外旋转输入，
  排除 CLS 的 patch 均值再 L2 归一化，384 维。
- 虹膜组合：同一 384 人脸裁剪送入 MediaPipe Face Landmarker，虹膜/眼角/眼睑与头部矩阵提取
  `ml/observe/gaze_geometry.py` 中固定顺序的 19 个几何数：每眼 6 个（水平/垂直虹膜偏移、眼睑开度、
  虹膜半径比、眼轴 sin/cos），左眼后右眼，再接水平/垂直偏移均值、水平偏移绝对值均值、
  两眼水平偏移之差，最后 yaw/pitch/roll 角度。无有效虹膜或头部矩阵时弃权。
  原始 19 维先以 Float32 固定，再转 Float64；共享 `geometry_terms_vector(raw19)` 依次输出
  原始 19 维、绝对值 19 维及含对角线的上三角乘积 190 维（先 i=0,j=0…18，再 i=1,j=1…18，依此类推），
  共 228 维；最后拼接上述归一化 CLIP 人脸 512 维，共 740 维。只用于展示观察，不参与评分或决定。
- `full` 直接使用管线的已旋转预览，沿用以上各自整图预处理，不解码原图。

每个属性必须包含：

| 字段 | 要求 |
|---|---|
| `id` | `[a-z][a-z0-9-]{0,63}`，正负状态共享同一个 ID |
| `type` | `"logistic"` 或 `"mlp"`；MLP 为一个最多 8 单元的 ReLU 隐层、一个输出 logit |
| `weights` | logistic：长度为 D 的有限数数组；MLP：长度 H×D，hidden-input 行优先；或下述量化字节 |
| `bias` | logistic：有限数；MLP：H 个有限数 |
| `outputWeights`, `outputBias` | MLP 必填，H 个有限数与一个有限数 |
| `normalization` | `{mean:[D 个有限数],scale:[D 个严格正有限数]}`；输入为 `(feature-mean)/scale` |
| `temperature` | 严格正有限数；正类概率 `p=sigmoid(logit/temperature)` |
| `showThreshold` | `(0.5,1]`；显示所选正/负状态的校准概率达到此阈值的观察 |
| `positive`, `negative` | `{text:"中文事实文案",tone:"good"\|"bad"\|"neutral"}`，非空且最多 12 个 Unicode 字符；`negative` 可省略，省略时只说正面结论 |

量化 `weights` 为标准 base64 字符串，附带
`quantization:{dtype:"int8"|"int16le",encoding:"base64"|"gzip-base64",layout:"hidden-input",scales:[每行正比例]}`。
logistic 视作 H=1；字节数严格等于 H×D×字长；int16 显式按 little-endian 解码。
解压输出长度有界。每行整数乘对应 scale 后再推理；bias 和输出层保留浮点。
参考假头见 `test/fixtures/observation-head.json`，不随生产目录自动加载。

若 `p>=0.5` 选正文案，置信度 `p`；否则选负文案，置信度 `1-p`。
任意非有限特征或 logit 不产生结论。温度和阈值由训练线用独立留出数据校准，运行时不估计。

focus 后新增可选 `progress.stage:"observations"`。完成单元用 `saveUnit` 保存该阶段，可续跑、可取消。
阶段缓存位于当前 cacheRoot 的 `observations/`，384 裁剪位于其 `crops/`；JSON 原子发布。
JSON 与裁剪一起计入现有缓存预算，可通过已有全缓存清理回收。
每组头缓存键含单元 fingerprint、头 version 与全部内容哈希、编码器 SHA、input、主体脸框、
原图/配对图/预览文件的路径、size、mtime；缺失文件也进入键，后来恢复会失效。
管线生成的预览使用内容寻址的文件名，忽略 LRU 访问导致的 mtime 变化，避免热缓存被访问动作失效。
命中时不裁剪、不推理；更换头、模型、输入或框时不复用旧结论。
没有有效头时删除本次分析内历史缓存的模型观察，避免继续展示已停用头的结果。
`AnalysisPipeline.run` 返回可选 `observationTimingMs`：`setup,prepareMs,cropMs,inferenceMs,reusedNativeCropMs,stage,total`（毫秒），
以及 `reusedNativeCrops,cacheHits`；total 为 setup+prepare+focus 内新增裁剪+观察阶段，
阶段内裁剪不重复计入。进度在启用观察时插入一个临时 0.5% 预算；该预算仅用于 ETA，实际耗时另记。

结果行可新增：

```js
observations: { version: 'observations-v1-<全部已加载头内容的哈希>', items: [
  { id: 'smile', text: '在笑', tone: 'good', source: 'model', confidence: 0.93,
    box: [0.2, 0.1, 0.4, 0.3] }
] }
```

`box` 可选，归一化指向原画面位置；face-crop 观察返回原主体脸框，full 观察不附框。
规则观察使用相同对象，但 `source:"rule"` 且不带置信度。
W32 新增 `focus-eye`「对焦点在眼部」，为 `neutral`（「对焦点在脸部」正例太少，未上线），
`box` 指向相机记录的对焦框，只描述记录位置，不保证眼部已合焦。
仅在 `focus.status === "ok"`、`afSource === "FocusLocation"`、有效对焦点位于有效对焦框内时考虑；
必须有唯一主体及唯一超过半脸面积落在主体框内的脸，鼻眼关键点置信度 ≥0.65 并匹配该脸，脸高 ≥4%。
主体脸部曝光测量至少 64 像素，黑/白溢出比例各 <50%，否则不发言；缺测同样弃权。
必须有两个完整落在该脸内的有效眼框；眼部观察要求对焦点落在其中一个眼框，且两个既有 AF 布尔值都为 `true`；
脸部观察要求点在脸框四边各内缩 20% 后的中央区域、整个对焦框与双眼框均无交叠，
且 `afPointOnSubject === true`、`afPointOnEye === false`；脸框边缘可能含头发，不据此发言。
既有 AF 布尔值聚合所有人脸，不能单独证明主体对焦位置。`na`、未知字段、含糊主体/脸匹配均静默。
本轮不输出偏离主体、失焦/运动模糊、裁切、遮挡或曝光观察；证据及未上线原因见研究记录的 W32 表。
`observationsFor(result)` 依次取规则「主体闭眼」、模型项、其余规则观察，同 ID 规则优先，
维持来源内顺序、过滤无效对象，最多 4 条（模型项排在一般规则之前，避免被路人、朝向等挤掉）；不修改结果行、评分、分组、阈值或建议。
`groupMembersModel`、`itemAnalysisModel` 都新增 `observations:Observation[]`；旧结果缺字段视为空。
检查器在对比句下显示「AI 观察（本地）」：✓/✗/· 沿用对比句主题，模型条目悬停显示校准置信度，
有 box 时在现有对比缩略图上画定位框（也支持键盘聚焦）。单张没有现有缩略图时只显示文字。
空列表、非结果态或多选时整节隐藏。保持现有 1.5 秒轮询，不增加请求。

组内对比（W32）仍为首选对第二名、其余对首选，默认最多三句，优先闭眼、清晰度/对焦位置及笑/嘴型，
再报切边、高光、倾斜、朝向/背景和亮度。观察缺失是未声明，不是负例；单侧只说“这张在笑”或“第 1 名嘴张开”，
不声称另一侧没笑或嘴未张开。同 ID 的两侧声明文字不同时才并列陈述；只有双方明确给出相反好坏状态才给方向性语气。
闭眼观察仅在 `facts.eyes` 未知时补充闭眼事实，不重复输出；闭眼对未知只陈述已知一侧，不能称另一侧睁眼。
单侧观察和裁切提示为中性，不表示另一张更好；单侧正脸/侧脸不生成对比句，只保留双方明确的正脸对侧脸。
空裁切列表不能证明肢体完整。
背景人物只比较两侧已声明的框占画面面积：面积比至少 2、绝对差至少 0.005 才说占比大小，同 ID 有多框时取最大有效框；
当前照片占比更大标 `worse`、更小标 `better`，沿用背景人物观察的 bad 语气；单侧存在和仅位置不同不生成对比句。
不匹配人物身份。该显著差异阈值不是新观察的模型门槛。

`groupMembersModel.facts` 的 `blur`、`tilted` 取 `boolean|null`：未评估保持 `null`；倾斜 warn 也不当作无倾斜。
对焦位置不生成对比句：单侧缺少 `focus-eye` 只表示未知；`focus.afPointOnEye` 汇总所有检测脸，也不用于对比句。
眼部/脸部清晰度仍沿用已有聚合测量，并非人物身份匹配。历史结果无需重算；这些派生展示字段不回写结果或人工决定。
无事实句时的总分说明也不再由另一侧的警告标记缺失推导“这张没有闭眼”等结论。

只使用已有依赖和模型会话，无线上模型调用。未在 Windows 实测。

W34 的 `scripts/observe-vlm-prepare.mjs`、`scripts/observe-vlm-ray.py` 和 `ml/observe/vlm_eval*.py`
仅为独立离线研究入口，不由分析管线或检查器导入，不新增观察来源或运行时下载。
研究作业只允许在 Ray 上显式执行；提交前校验包内照片为无元数据、长边不超过 768 的 JPEG。
VLM 作业申请一或两张 GPU，提交时持共享锁按 `ml/common/ray_admission.py` 检查本线同类单作业与项目资源上限，提交返回后立即释放锁。
经用户批准，项目最多三个活动作业，其中申请 GPU 的最多两个，每作业最多两张 GPU；第三个只留给显式不申请 GPU 的老师评判作业。
按提交的 entrypoint 资源分类，正数申请或 `entrypoint_resources.GPU` 即 GPU 作业；资源不明或元数据异常按 GPU 计，不根据进程命令或 CUDA 使用量猜测。
Ray 列表若省略 entrypoint 字段，则读取提交器写入的 `ecp_job_kind`、`ecp_requested_gpus` 元数据回执。
计分把缺答、解析失败和“看不清”保留为弃权；报告三次复问一致策略的正例精确率、Wilson 下限和条数，
不用多数负例形成的整体准确率替代上线门槛。具体许可与实测结论见观察研究文档 6.6、6.8 节。
W35 复用同一清单、问卷与计分，模型家族适配只改变加载及原生视觉预处理。
新模型家族与原生量化加载须记录完整加载诊断；缺失、多余、形状不符或转换错误均拒绝，
不能把部分随机初始化后仍能生成的模型计作成功。W34 原有 Qwen3-VL 加载路径保持不变。
模型 revision 必须为完整提交哈希；启用远程代码时，代码 revision 必须与权重相同，离线加载固定快照。
MiniCPM 压缩倍率在处理器和生成器两侧保持一致；单卡显存预算显式记录，默认仍为 12 GiB。
W35 使用独立作业前缀与缓存目录，保留共享锁及项目并发限制；不接入运行时或改变展示之外的任何决定。
评分器的可选 `--statements` 会在独立结果文件中补报所有反向陈述：预测与参照同时反转，
弃权不变，使用相同条数、精确率与 Wilson 门槛，并给出恒说反状态的参照基线。
此分析不改变已有正状态报告；事后发现的候选不得当作预先注册的独立上线验收。

W35 的 `scripts/observe-vlm-gguf-ray.py` 与 `ml/observe/vlm_eval_gguf_ray.py` 另测 GGUF 部署形态，
仍为 Ray 离线研究，本线最多一个作业。可选两个独立单卡副本在同作业内按清单序号交错分片，
同项三问不拆分、每副本单 slot 且参数一致；合并拒绝重复、遗漏及跨片身份，保留每副本 CUDA 与显存回执。语言权重、投影器及 llama.cpp 源码分别固定完整 revision，下载后逐文件校验 SHA-256；
模型文件只由 Ray 从公开仓库下载，本机打包与结果回传均不包含模型文件。
CUDA 构建和安装调试最多一小时；临时 `llama-server` 只绑定该 Ray 节点的 loopback，随作业回收，
不调用分析服务或 Windows。复用既有锁、清单、问卷、计分器、三问策略与门槛；无受约束 JSON 解码。
固定 greedy、种子、256 输出 token、4,096 上下文、单 slot、关闭 thinking 和 prompt KV 复用；
服务器显式关闭 reasoning 并把空 reasoning 标记与正文分开，不加 reasoning 预算强制采样；正文仍由原计分器直接解析，不剥标记修补答案。
非空 reasoning 计调用错误；冒烟在任一纳入数据集完全没有可解析问卷时失败，防止输出格式配置错误进入全量。
上下文溢出、缺少 token／计时／零缓存证明或调用失败均保留为执行错误，不能补猜答案。
分别记录服务器视觉编码／prefill／decode 计算区间、HTTP 往返和完整调用，显存为指定卡的采样峰值。
GGUF 与原生 Transformers 的模板、视觉实现及 kernel 不同；质量差值属于部署形态对照，不能全部归因于位宽，
也不能直接作为“单张评价＋后期建议”等其它用途的验收。
