# 参考资料收集（2026-10-10）

> 目的：为规则库（[next-gen-plan.md](next-gen-plan.md) §3）和多模态老师（§4）提供专家来源和评估数据。
> 存储：大文件放 Ray 集群的 Ceph 盘 `<CEPH_ROOT>/references/`；仓库只放清单、脚本和抽取出的结构化结果。
> 使用范围：仅用于本项目的内部研究和评估，不转发原始视频，也不把截图发布出去；规则库里只保存提炼后的规则和出处（视频号 + 时间点）。

## 1. 要收集什么

### 人像课程素材（W4，2026-10-10）

来源为本机 `<LOCAL_PATH> 摄影素材`，只读扫描、SHA-256 和 ffprobe；
不移动、不修改、不删除源文件，不访问「未删减」。仅用于内部参考，视频/PDF 正文不进入仓库。
清单见 [`portrait_courses_manifest.json`](../ml/references/portrait_courses_manifest.json)，
每项包含原路径、原文件名、大小、SHA-256、稳定英文 slug 的远端相对路径；视频另记时长和编码。

**2026-10-11 本机整理**：上述素材与 `photography/tmp/books` 合并到 `<LOCAL_PATH>`，
`books/{01-选片与观看,02-姿势,03-综合技法,04-街头纪实}`、`courses/{01-人像姿势,02-人像布光,03-商业人像,04-大师课}`、`notes/`；
旧路径到新路径的映射在 `materials/notes/reorg-map.json`。清单中的 `local` 已改为新路径，已上传文件的远端路径不变；
新增素材用 source `materials-books`、`materials-course-texts`（课程字幕与讲义）、`materials-courses`（课程视频），
远端为 `references/<source>/raw/<相对 materials 的路径>`。上传状态身份只取 source/remote_rel/size/sha256，移动本机文件不影响续传。
下表与后文是整理前的历史记录，回执里的本机路径保持原样。

| source | 文件数 | 字节数（十进制 GB） | 视频总时长 | 本轮范围 |
|---|---:|---:|---:|---|
| hanjing | 80 | 5,858,838,633（5.859 GB） | 44,192.179 秒（12.276 小时） | 上传试点 |
| liqiang | 34 | 2,185,175,092（2.185 GB） | 11,157.954 秒（3.099 小时） | 不上传，留给用户后台执行 |
| linhaiyin | 37（17+14+6） | 51,497,032,737（51.497 GB） | 84,512.946 秒（23.476 小时） | 不上传，留给用户后台执行 |
| photo-books | 7 | 666,284,904（0.666 GB） | 不适用 | 上传试点 |

林海音按 `commercial-portrait`、`season-3`、`season-2` 隔离，韩晶用 `hanjing-posing`，
李强用 `liqiang-korean-lighting`，PDF 用 `photography-books`；slug 之下保留中文课程目录与原名。
PDF 白名单：《拍照姿势》《斯科特·凯尔比的自然光人像摄影手册》《斯科特 凯尔比的 风光摄影手册》
《街头摄影  52个任务清单》《摄影技艺教程第7版_13241922》《美国纽约摄影学院摄影教材》上、下册。

跳过规则与实际观察：
- 本机实际只跳过《摄影必修课（套装4册）.pdf》，97,301,970 字节，不在明确白名单内。
- `林海音/林海音/林/` 实际不存在，不能声称本轮确认了该目录的逐字节重复；清单 observations 明确记为不存在。
  若以后恢复该目录，生成器必须匹配商业人像文件的大小和完整 SHA-256，否则拒绝生成清单，不静默跳过。
- 实际未发现独立 `.vip`、`.exe/.apk/.html/.txt/.jpg/.DS_Store`；生成器仍排除它们，不运行或打开 exe/apk。
  `.vip.mp4` 是本轮明确允许的视频文件名，不能按 `.vip` 加密后缀误删。
- `林海音第三期/1.mp4` 标记为视频流有解码错误，但保留；ffprobe 元数据不代表全流解码通过。
- 李强目录实测为 2.185 GB，并非约 50 GB；林海音实测为 51.497 GB。

上传工具：[`upload_to_ceph.py`](../ml/references/upload_to_ceph.py)，仅 Python 标准库，生成清单另需 ffprobe。
HTTP 绕过所有代理，实测 dashboard 为 `<RAY_DASHBOARD>`、Ray 2.51.1；
每批最多 90 MiB 有效载荷，ZIP_STORED 包体小于 100 MiB，PUT 到 `/api/packages/gcs/_ray_pkg_<hash>.zip`。
作业 `runtime_env.working_dir` 指向包；只申请 1 CPU、0 GPU，全局文件锁防止同机多进程并行，
每次只提交一个作业。本地优先级至少 nice 10；临时 zip 用完即删。
`--max-mbps` 按十进制兆比特/秒限制 PUT（例如 80 为约 10 MB/s），默认不设网络限速。
清理使用 Ray 2.51.1 的 internal_kv package namespace，属于版本相关内部 API，不等同于公开 HTTP DELETE package 接口。

状态保存在 `/tmp/ceph-upload/<source>/state.json`，原命令重跑即可续传；
状态与清单身份绑定，每次启动重新检查 Ceph 正式文件及 `.part` 的长度、完整前缀 SHA-256，
以远端真实进度为准，而非盲信本地状态。冲突/损坏直接报错，不覆盖正式文件，不截断未知部分。
批内按 offset 写 `.part`、fsync；文件末块完整 SHA-256 通过后改名；上传结束再独立审计全部文件。
每批作业内删除自己的 GCS 包，终态后删除自己的作业记录；重跑先回收上次已登记的自有资源，
最终另一个 CPU 作业复核所有自有包已不存在，并检查自有作业记录没有残留。
Ceph 的 source/raw/课程目录权限 0700，文件按私有 umask 创建。

```bash
python3 ml/references/upload_to_ceph.py --plan '<LOCAL_PATH> 摄影素材' \
  --output ml/references/portrait_courses_manifest.json
nice -n 10 python3 ml/references/upload_to_ceph.py ml/references/portrait_courses_manifest.json \
  --sources hanjing photo-books
```

通用单 source 输入格式为 `{"source":"example","files":[{"local":"/absolute/file", "remote_rel":"course/file", "sha256":"可省略"}]}`；
省略 hash 时上传前计算，提供 hash 时上传前重新比对。多 source 清单使用每个 files 项的 source。
远端固定为 `references/<source>/raw/<remote_rel>`；拒绝重复目的地、路径逃逸与本地文件符号链接。

剩余大课程由用户在沙箱外执行，**本轮不自动运行**：

```bash
cd <LOCAL_PATH>
mkdir -p /tmp/ceph-upload
nohup nice -n 10 python3 -u ml/references/upload_to_ceph.py \
  ml/references/portrait_courses_manifest.json --sources liqiang linhaiyin --max-mbps 80 \
  > /tmp/ceph-upload/remaining.log 2>&1 &
```

中断后重复相同命令；不要删除 `/tmp/ceph-upload/` 状态，系统清除 /tmp 后仍可通过远端前缀校验续传，
但失去本地资源登记会失去旧自有作业/包的自动清理证据。回执写为 `ml/references/<source>_upload_receipt.json`，不含凭据。
试点已完成（2026-10-10）：韩晶 80/80 + PDF 7/7，共 6,525,123,537 字节；
两个 source 的逐文件及独立作业 SHA-256 全一致。同一命令再次运行，两个 source 均上传 0 字节，
说明完整文件自动跳过；启动时本机源文件重新计算 SHA-256 与清单一致。
另有统一跨 source 最终审计，记录目录 0700、无 `.part`、全部自有 package 不存在及作业记录无残留。
回执见 [`hanjing_upload_receipt.json`](../ml/references/hanjing_upload_receipt.json)、
[`photo-books_upload_receipt.json`](../ml/references/photo-books_upload_receipt.json)、
[`portrait_courses_pilot_receipt.json`](../ml/references/portrait_courses_pilot_receipt.json)。

| 试点 | 完成上传的活跃耗时（含调度、审计、清理） | 端到端 MB/s | 仅 HTTP PUT MB/s |
|---|---:|---:|---:|
| 韩晶 | 1,948.131 秒（32 分 28 秒） | 3.008 | 5.702 |
| 7 本 PDF | 240.352 秒（4 分 0 秒） | 2.772 | 6.345 |
| 合计 | 2,188.483 秒（36 分 28 秒） | 2.982 | 5.761 |

吞吐以成功 PUT 的 ZIP 字节计算，包含少量包开销；合计成功包体 6,525,437,339 字节。
上轮网络中断及等待空档、未完成 PUT 的未知传输量不计入上述活跃耗时/吞吐。
零重传复核另耗时 60.936 秒，统一跨 source 审计作业另见总回执，不计入首次上传吞吐。
韩晶登记 64 个包（含中断时首包），PDF 8 个包，72 个自有 URI 均核实不存在；本机临时 ZIP 为 0，保留续传状态。
最初恢复清理两次因 `ray._private.internal_kv` 不存在而失败，已改用实测存在的
`ray.experimental.internal_kv`；失败作业也已删除。沙箱外层 nice 命令有 setpriority 警告，
但进程继承的 nice 实测已为 10，回执记录 10，并非降优先级未生效。
Ray JobSupervisor 终止后可能重建已删除的 FAILED 记录；本轮自有探针记录已再次删除，
最终连续三次空记录检查通过，工具也加入此复核，不删除其他人的记录。
Python 单测 16/16 通过；指定 Node 测试 266 tests、265 pass / 0 fail / 1 skip，未新增失败。
未改正式规则库、ranking 或 signals；未提交、未 push。

| 类别 | 内容 | 用途 | 状态 |
|---|---|---|---|
| 专家点评视频 | 衣刀「人像摄影点评」合集，97 个，53 小时 | 规则来源 + 带专家等级的评估集 | 已下载 97/97（480P + 音频，6.64 GB，Ceph `references/yidao/raw/`） |
| 其他题材专家候选 | 武林40期完整点评合集；Thomas、赵钢、聿铭优先核验样本；潘庆华129条短点评作补充 | 风光/画面关系规则与风格例外 | 公开API元数据已统计，视频下载0；逐张/评级仅元数据线索，街拍/婚礼专项仍缺，见[其他题材研究](research-genres.md#9-b站专家点评来源检索)与[候选清单](../ml/references/genre_sources_candidates.json) |
| 吴晓隆购买课程 | 黄金时代51集、当代21集，72集/9.324 GB；高相关19集 | 风光/街头/纪实及故意破规则的风格参照 | 72/72已上传、9.324 GB、Ceph独立SHA-256全一致；Ray活跃作业与GCS包残留0，见[课程清单](../ml/references/wuxiaolong_manifest.json)与[上传记录](../ml/references/wuxiaolong_upload_receipt.json)；不转写/截帧，不把大师图像放仓库 |
| 风光/街拍规则种子 | 各15条，measure/teacher/measure+teacher、严重程度及例外 | 下一代规则库研究草案 | 已写landscape/street；sources暂为todo:book，新增检测/序列保护尚未实现；规则测试通过 |
| 你认可的书籍和教程 | 人像优先，其次街拍、风光 | 规则的权威出处 | 等你给清单 |
| 你的选片习惯 | 最看重什么、常故意破哪些规则 | 个人 profile 默认值 | 等你口述或文字 |
| 你的完整拍摄批次 + 最终选择 | 风光、街拍、活动、中画幅各一次以上 | 真值（[test-plan.md](test-plan.md)） | 已有汕头 1 批 |
| 公开数据集 | CADB、GAIC/CPC、PCCD/RPCD、AADB/PARA、HumanAesExpert、PIQ23 | 老师和学生模型的预训练与校准 | 待取，需逐个确认许可 |
| 模型权重 | RTMW 全身关键点（已下载）、中文语音识别（小模型） | 测量层、视频转写 | 部分完成；不部署多模态大模型 |
| 论文 | 中文 head index、向量检索、引用扩展 | 方法依据 | 待做 |

## 2. 衣刀人像点评合集

来源：<https://space.bilibili.com/18241328/lists/357491?type=season>，清单：[`ml/references/yidao_portrait_critique_manifest.json`](../ml/references/yidao_portrait_critique_manifest.json)。

**为什么适合**：每期逐张点评观众投稿的人像，讲清楚好在哪、差在哪；2026 年的「从夯到拉」系列还会给每张照片排档位。这相当于「照片 + 专家理由 + 专家等级」三元组，比书更贴近我们的任务：书只给规则，这里还给出规则在真实照片上怎么用、哪条更要紧。

**限制**：
- 视频里的照片是屏幕画面，分辨率有限、带界面叠加，适合评构图、姿态、光线、色调，不适合判断对焦。
- 点评以单张好坏为主，不是同组选片；用来校准老师的规则判断和等级，不直接当选片真值。
- 有不少后期、布光、器材的内容，与选片无关，抽取时要分开。
- 匿名只能拿到 480P，没有字幕。2026-10-10 用本机 Edge 的登录态（大会员）补下了 1080P 视频（`video1080.m4s`）和 B 站 AI 中文字幕（`subtitle-ai-zh.json`），与自建语音识别互相校对。
- cookie 只存放在 Ceph 私有文件 `<LOCAL_USER>/.secrets/bili_cookie`（目录 700、文件 600），通过一次性 Ray 任务写入后删除了任务记录，下载任务只读取文件路径；本机不保留副本。不再需要时删除该文件，或在 B 站退出登录使其失效。

**数据量**：音频 + 480P 共 6.64 GB（已下载）；1080P 视频约 50–60 GB（下载中）。

### 2.1 处理流程

| 步骤 | 内容 | 资源 | 输出（Ceph `references/yidao/`） |
|---|---|---|---|
| 1 下载 | `ml/references/fetch_bilibili.py`：调用 view/playurl 接口取 DASH 音视频流分别保存（yt-dlp 抓网页会被返回 412） | Ray CPU，并发 4，经代理 | `raw/<bvid>/audio.m4s`、`video.m4s`、`info.json` |
| 2 转写 | FunASR 1.3.1：Paraformer 中文 + FSMN VAD + CT 标点，句级与 token 时间戳 | Ray，1 张 H20 | `asr/<bvid>.jsonl` |
| 3 切照片 | 1 FPS 场景检测 + pHash/SIFT，同图局部放大合并；编辑器文档标签辅助识别；排除讲解/文字/网页 | Ray CPU | `frames/<bvid>/<序号>.jpg`、`segments/<bvid>.json` |
| 4 对齐 | 完整句子按可见照片区间的最大重叠分配一次，保留原句时间戳 | CPU | `critiques/<bvid>.jsonl`：照片、时间段、原话 |
| 5 抽取 | Codex 从每张照片的点评转写里抽取：结论、档位（从夯到拉）、问题列表（映射到规则 id）、新规则候选（附简短转述和时间点）；转写说不清时才附截图 | Codex（文本为主），少量看图 | `extracted/<bvid>.jsonl` |
| 6 汇总 | 跨 97 期合并同义规则，统计出现频次和典型例子，区分选片相关和后期/布光/器材 | CPU + Codex | `rules-candidates.json` → 仓库 `src/rules/` v0.2 草案 |
| 7 评估集 | 带档位的照片作为老师的评估集：抽样调用 可配置多模态服务 带规则点评，看能否复现专家档位 | 可配置多模态服务（少量） | `eval/yidao-tiers.jsonl` |

步骤 6 的结果由你审核后才进入规则库；每条规则保留出处（视频号 + 时间点），审核时可以直接跳到原视频。

### 2.2 需要你决定

- 是否提供 B 站登录 cookie（只用于下载 1080P 和 AI 字幕；存放在 Ceph 你名下的私有路径，用完可删）。不提供也能做，截图分辨率低一些。
- 是否还有其他博主或合集需要一起收（例如风光、街拍点评）。


### 2.3 W1-B 实际流水线（2026-10-10）

脚本：`ml/references/asr_job.py`、`segment_job.py`、`align_job.py`、`verify_job.py`，提交与查询入口 `submit.py`。
它们只读 `raw/`，输出使用 `.part`/临时文件再原子替换。ASR 检查完成文件的句子与时间戳；切分检查算法版本、采样率和截图；对齐用输入/输出 SHA-256 判断是否跳过。`--bvids` 可选取试点，`--env REF_FORCE=1` 可强制重跑。

**转写方案**：FunASR 1.3.1 的 `paraformer-zh` 实际解析为 ModelScope
`iic/speech_seaco_paraformer_large_asr_nat-zh-cn-16k-common-vocab8404-pytorch`；VAD 为
`iic/speech_fsmn_vad_zh-cn-16k-common-pytorch`，标点为
`iic/punc_ct-transformer_cn-en-common-vocab471067-large`。选用它是因为中文句子、标点和原生 token 时间戳可一起输出，试点可读且无需另建时间戳模型。`imageio-ffmpeg` 的静态二进制将 m4s 音频解码为 16 kHz 单声道，由 soundfile 读成数组交给模型，避免 FunASR 调用不存在的系统 ffmpeg。默认 `REF_ASR_BATCH_SECONDS=1200`；单进程顺序处理，始终只申请 1 GPU、2 CPU。`REF_ASR_BACKEND=whisper` 是可选的 faster-whisper large-v3 回退，当前数据未用它。

两期试点：`BV1za411Y7TW`（509.70 秒、162 句）和 `BV1M34y1e7nY`（2506.11 秒、1082 句），模型缓存后的单期耗时分别为 4.59 和 12.78 秒，模型加载 27.50 秒。抽查“样片”“人像摄影点评”“逆光”文本可读；后续全量中也出现“直闪”“色温”。保留原始识别文字，不把“衣刀”误识别成“易道”等同音词自动改写。这里是文本与时间戳抽查，未做逐句人工听写 WER 测量。`token_timestamps` 为模型 token 的时间区间，不承诺中文分词后的词级边界。

**照片切分方案**（`scene-phash-sift@5`）：静态 ffmpeg 按 1 FPS 解码，忽略右侧栏和底部摄像头/字幕区域计算场景变化；pHash、色彩直方图和 SIFT 单应性联合判断同图。SIFT 只在中央图像区域匹配，避免不同照片因共用 UI 被合并。极端眼睛局部放大缺乏可匹配像素时，检测到暗色编辑器后用选中文档标签前缀辅助关联。相邻同图合并；中间最多 6 秒非照片界面且两侧同图时合并，并以 `intervals` 记录实际可见区间。不同照片插入后的返回仍保留独立时间段，以 `photo_id` 关联（搜索最近 12 个不同照片）。代表帧优先较完整的视图和锐利帧，保存原生 480P 全屏 JPEG，保留界面以便追溯。

动态开场可提供主播背景负样本；高运动、低细节、黑底文字和大面积亮色网页过滤为 `other`；中央分隔带启发式识别 `compare`。这不是语义模型，不能保证所有布局都正确。试点反复检查了短片讲解、旧直播和新直播：旧直播 1249–1452 秒连续脸部/眼睛放大操作已合为一段，代表帧保留完整脸部；文件列表弹窗仍可能出现在部分代表帧，新直播 2243–2256 秒的中央文字截图仍被标为照片（已知误检），没有把这类启发式结果宣称为人工验收通过。全量使用 `REF_CONCURRENCY=24`，每 worker 2 CPU，ffmpeg/OpenCV 单线程，加驱动为 49 CPU；与 ASR 同跑最多 51 CPU，GPU 为 1。

**对齐与 QA**：每句按 `intervals` 的最大重叠分配一次；重叠相同用句子中点，再用较早段。不拆改 ASR 原文。`other` 的话不进入 critiques；`transcript_segments` 保留原始句子时间。`tier`、`verdict` 为 null，`issues`、`praises`、`topics` 为 []。`photo_id`、`kind`、`phash`、`intervals` 为向后兼容附加字段。覆盖率是照片/比较段实际可见区间并集除以音频时长，不包括合并段里的弹窗。

三期 QA：`BV1za411Y7TW`、`BV1M34y1e7nY`、`BV1TxLV6oE88`。
Ceph `qa/<bvid>.html` 是包含所有缩略图、时间段与转写前 80 字的离线联系表，另列被排除的 `other` 段。本机副本 `/tmp/w1-refs-qa/qa/`。三期初步统计：3/105/184 个照片或比较段，0/0/2 段无转写，覆盖率 3.14%/71.66%/84.05%。首期以讲解为主，低照片覆盖率符合抽查画面。联系表仍需使用者人工复核，不是逐张标注真值。

可独立重跑（从仓库根目录）：

```sh
python ml/references/submit.py asr --bvids BV1za411Y7TW,BV1M34y1e7nY
python ml/references/submit.py segment --env REF_CONCURRENCY=24
python ml/references/submit.py align --env REF_QA_BVIDS=BV1za411Y7TW,BV1M34y1e7nY,BV1TxLV6oE88 --env REF_EXPORT=1
python ml/references/submit.py logs --id <submission_id> --export-dir /tmp/w1-refs-qa
python ml/references/submit.py verify
python ml/references/submit.py list
python -m unittest discover -s ml/references -p 'test_*.py'
```

`submit.py` 用 base64 entrypoint 提交，代理和 HF_HOME 沿用本任务提供的设置；`--id` 指定作业 ID，`status`/`logs`/`stop` 查询或停止指定作业。`verify_job.py` 用 8 个 I/O 线程、申请 8 CPU，默认只读检查 ASR、segments、critiques 契约、截图 JPEG 文件头和原始文件清单，不能代替照片语义正确性的人工核对。`--env REF_AUDIT_WRITE=1` 可把审计证据追加到 `pipeline-report.json`，仍不修改 raw。

**已知问题**：1 FPS 边界约有一秒量化误差、不到 3 秒的照片可能归入 `other`；高度裁切、后期变形与极小照片仍可能残留碎段；编辑器标签相同前缀可能误合并；静态主播、局部网页、黑底/高调照片存在分类误差；并排照片不会拆成单独画面；480P、UI 遮挡和低清无法用于对焦评估；跨边界句子整体归到一个段，可能带入少量相邻照片评论；同音摄影术语与型号数字需要后续抽取阶段结合截图和原视频核对。


**全量运行结果**：97/97 ASR、segments、critiques，报告 `failed_videos=0`，无零照片期。
共 190,708.43 秒音频（52.97 小时）、85,743 句，11,957 个照片/比较时间段，9,774 个启发式 `photo_id`（不是人工标注的独立照片数）；照片可见时长 157,739.81 秒，覆盖率 **82.71%**。**69 个段无转写**（0.58%），未虚构补文，逐期计数在 `pipeline-report.json`。另有 274 句没有落入可见区间；原句仍完整保存在 ASR 中，下游可按时间回看。

| 阶段 | 成功作业 ID | Ray 作业墙钟耗时（含启动） | 成功单期处理累计 | 资源 |
|---|---|---|---|---|
| ASR 全量（跳过两期试点） | `w1-refs-asr-full-1010` | 1700.52 秒 / 28 分 20.5 秒 | 97 期 1663.83 秒 | 1 GPU、2 CPU |
| 切分全量（跳过三期试点） | `w1-refs-segment-full-1010` | 403.95 秒 / 6 分 44 秒 | 97 期 7827.99 worker 秒 | 24 × 2 CPU + 1 驱动；0 GPU |
| 对齐与联系表 | `w1-refs-align-full-1010` | 156.83 秒 / 2 分 36.8 秒 | 报告 `alignment.wall_seconds` | 1 CPU、0 GPU |

以上是最终成功运行耗时，不包含前期模型约 2.1 GB 下载、依赖安装与多轮切分调参时间。初次试跑失败原因是 FunASR 文件读入仍调用系统 ffmpeg；改为 soundfile 数组后成功。首个依赖环境曾用 `numpy<2`，与 Python 3.13/集群依赖不合，随后改用 `numpy>=2,<3`。失败试跑均终止或已进入终态，产物以最终成功侧车为准。

报告还包含摄影术语命中样例：“直闪”281 句、“套头”20 句、“色温”120 句、“逆光”696 句；35mm/85mm 以数字及中文读法搜索，命中可能含其它数字，不能当术语准确率。检验是 12 项本地测试、实际视频试跑与逐期产物审计，未声称照片语义分类已达到人工准确率阈值。浏览器渲染检查受到本机缓存目录写权限限制；离线 HTML 的内嵌图片、文本和字段结构已核对，图像联系表已抽查。

修改范围仅 `ml/references/` 和本文件。Git 提交受沙箱阻止：worktree 索引锁实际位于主仓库 `.git/worktrees/w1-refs/index.lock`，当前没有写权限；未创建提交、未 push。


最终文件审计：`w1-refs-verify-v2-1010` 成功，97/97 通过、错误 0，检查 31,793 个 JPEG 文件头（包含 `other` 段截图），耗时 459.45 秒，8 CPU/8 I/O 线程、0 GPU。`pipeline-report.json.verification` 保留审计证据；原始清单大小 6,660,029,650 字节，清单指纹是路径/大小/mtime 的 SHA-256，不是原始视频内容哈希，也没有借此宣称前后内容一致性。

最终 GET `/api/jobs/`：本次 `w1-refs-*` 无 RUNNING/PENDING。共享集群另有非本次提交的 `raysubmit_jv4XRWSHGXY9Yiv3` 为 RUNNING，未停止其它任务。

### 2.4 W2-B 规则抽取与审核（2026-10-10）

已实现 CPU OCR（`ml/references/tier_ocr_job.py`）、校验回传（`transfer_rules.py`）、
关键词预处理及 Codex 抽取（`extract_critiques.py`）、跨期聚类汇总（`aggregate_rules.py`）和规则审核页。
原始 `critiques/` 不改；OCR 结果写 Ceph `critiques-v2/`。
档位规范化为「夯 / 顶尖 / 人上人 / NPC / 拉」，旧「顶级」归到「顶尖」；
置信度 < 0.75、右侧同时有多个独立档位标签时留空；同一 `photo_id` 多段投票，平票留空。
整屏标题卡只接受包含「投稿 / 路人」且有明确唯一档位的文字。
`ocrText` 保存识别文本、置信度和框；不把排行榜投票选项里的等级当成当前等级。

**实际阻塞**：嵌套 `codex exec` 在初始化 in-process app-server 时返回
`Operation not permitted (os error 1)`。试探调用 1 次，8 段，耗时 1.222 秒，失败；
成功抽取 0 段。因此暂无真实新规则候选、非选片转述或 10 条人工抽查样例，准确度不可计算。
空候选文件明确写 `extractionStatus: not-run`，不代表已完成全量抽取。
负样本在 `/tmp/w2-rules-data/negatives.jsonl`；只有 OCR 低档且尚未抽取的行带
`labelingStatus: tier-only-unextracted`、`violatedRules: []`，不可当作逐规则监督标签。
后续完成抽取后，将低档和明确批评合并为规则级负样本，用于老师规则判断校准和学生训练，
不能用专家档位直接代替摄影师同组选片真值。

**运行命令**（在本 worktree；需沙箱外运行 Codex 步骤）：

```bash
# CPU OCR；最多 8 个 OCR worker、每 worker 2 个 CPU 线程，GPU 为 0。
nice -n 10 python3 ml/references/transfer_rules.py ocr --id w2-rules-ocr-new --workers 8
python3 ml/references/submit.py status --id w2-rules-ocr-new
# 作业结束后导出文本；通过 /api/jobs/<id>/logs，gzip+base64 分块和 SHA-256 双校验。
python3 ml/references/transfer_rules.py export --id w2-rules-text-new
python3 ml/references/submit.py status --id w2-rules-text-new
# 上一条 status 显示 SUCCEEDED 后再取回。
python3 ml/references/transfer_rules.py receive --id w2-rules-text-new --dest /tmp/w2-rules-data
nice -n 10 python3 ml/references/extract_critiques.py --preprocess-only
# 先每期只跑一批，人工查看，再去掉 --max-batches 跑完整的三期。
nice -n 10 python3 ml/references/extract_critiques.py \
  --bvids BV1TxLV6oE88 BV1M34y1e7nY BV1za411Y7TW --concurrency 2 --max-batches 1
nice -n 10 python3 ml/references/extract_critiques.py \
  --bvids BV1TxLV6oE88 BV1M34y1e7nY BV1za411Y7TW --concurrency 2
# 只有三期质量确认后，才运行全量（去掉 --bvids）。
nice -n 10 python3 ml/references/aggregate_rules.py --data-root /tmp/w2-rules-data
```

预处理写 `/tmp/w2-rules-data/preprocessed/<bvid>.jsonl`，含主题、评价句位置和非选片/可跳过标记。
抽取默认每批至多 8 个分块、18,000 字符（JSON 数据，不含规则提示），长段每 6,000 字符切分，
并发仅 1 或 2；不丢弃长转写。缓存按 bvid、段号、输入 SHA、prompt、规则库、schema 版本，
位于 `/tmp/w2-rules-data/extracted/<bvid>/`；变更输入会失效。模型输出必须覆盖每个分块，
规则 ID 必须存在或为 null，转述 1–40 字，时间点必须在该照片可见区间内；失败也写 `usage.jsonl`。
后期步骤、器材、服化道另存 `/tmp/w2-rules-data/non-selection.json`。
汇总先以同义替换和字符二元组相似度（阈值 0.52）做 complete-link 聚类，再一次 Codex 命名，
命名未执行时 `--offline` 仅生成明确标记 `namingStatus: offline` 的临时陈述。
此聚类是候选整理，仍需要人工审核，不能保证所有同义项已合并。

**审核页与缩略图**：启动服务不占用 43125：

```bash
EAGLE_PYTHON="<PYTHON_EXECUTABLE>" \
  nice -n 10 node src/cli.js serve --port 43126
# 有真实候选后，只回传每条候选的最多四张代表性截图。
python3 ml/references/transfer_rules.py frames --id w2-rules-frames-new \
  --candidates src/rules/candidates/portrait-v0.2-candidates.json
python3 ml/references/submit.py status --id w2-rules-frames-new
# 上一条 status 显示 SUCCEEDED 后再取回。
python3 ml/references/transfer_rules.py receive --id w2-rules-frames-new --dest data/rules-review/frames
```

打开 <http://127.0.0.1:43126/rules/review>；也能直接打开 `src/plugin/rules-review.html`，
此时数据连接到 43126。API 为 `GET /rules/data`、`POST /rules/decisions`、`POST /rules/export`。
审核决定追加保存到 `src/rules/review/decisions.json`，带 timestamp；同进程并发写入串行化。
导出写 `src/rules/review/portrait.v0.2.draft.json`，不覆盖 `portrait.json` v0.1。
当前实际导出只含 16 条种子，用于验证导出通路，尚非新增候选审核成果。
截图缓存限 `data/rules-review/frames/`，服务拒绝路径穿越与逃逸 symlink。
原视频和截图不入仓库，仓库出处只有简短转述、bvid 和时间点。

**验证边界**：HTTP 页面、JS/CSS、数据和导出实测可访问；接口测试使用独立临时目录，
覆盖修改、通过、合并、删除、并发追加和保留 v0.1。Computer Use Chrome/IAB 不可用；
Playwright 尝试本机 Edge 后以 SIGABRT 中止，未完成浏览器交互验收、未生成截图。
HTTP 证据放 `/tmp/w2-rules-qa/`。本机 `nice -n 10` 返回优先级调整不允许，命令仍运行；
不能声称已成功降低进程优先级。不触碰 Eagle 写入、不 push。

#### W2-B 本轮数据与验证结果

97/97 期、11,957 段；档位 1,773 段（14.83%），截图处理错误 0。
档位段数：夯 174、顶尖 442、人上人 545、NPC 611、拉 1；来源为 ocr-label 1,757、ocr-titlecard 16。
195 个 JSONL/元数据文件通过 gzip+base64 分块 SHA-256 与文件 SHA-256 校验，位于 `/tmp/w2-rules-data/critiques-v2/`；97 期预处理完成。
低档负样本 **612 段**，其中 **0 段**具有已抽取的违反规则；全部是 `tier-only-unextracted`，当前用途仅是待标注池。
成功抽取 0 段；选片候选输出 0 条、非选片转述输出 0 条，均因抽取未运行，不是全量内容不存在这些规则。
因此未取回候选截图，10 条抽取样例及准确度尚不能提供。三期试点覆盖率见下表，覆盖率不代表 OCR 正确率。
同图投票依赖 W1-B 的 `photo_id`；归并错误、过渡画面、多图比较及 OCR 漏字可能导致档位错配，需人工复核。

`npm test`：129 项，128 通过、1 跳过、0 失败（最新一次约 25.8 秒）；新增相关测试 7 项全部通过。
HTTP 页面/资源/数据/导出实测通过；浏览器 QA 阻塞，截图 0 张，证据及说明位于 `/tmp/w2-rules-qa/`。
v0.1 种子 SHA-256 与 HEAD 一致：`c02a1b847a77c3881f582f30a787c61c92d460d464c8b11f0a8ab0c85f95d752`。
本任务 7 个 Ray 作业均为终止状态，成功任务 GPU 为 0；没有本任务 RUNNING/PENDING 残留，不操作其他人的作业。
首次旧 RapidOCR 安装失败（Python 3.13 不兼容），切换 RapidOCR 3.10.0 + ONNX Runtime 1.31.0 后成功；完整 OCR 作业使用 16 CPU、8 worker。
为遵守可修改目录限制，草案放 `src/rules/review/portrait.v0.2.draft.json`。没有提交或 push。

逐期档位覆盖率（按段统计，不按独立照片统计）：

| bvid | 段数 | 有档位段数 | 覆盖率 |
|---|---:|---:|---:|
| BV1za411Y7TW | 3 | 0 | 0.00% |
| BV1M34y1e7nY | 105 | 0 | 0.00% |
| BV1RT4y1a7tR | 110 | 0 | 0.00% |
| BV1C94y117Lj | 27 | 0 | 0.00% |
| BV1L94y127yr | 40 | 0 | 0.00% |
| BV1sv4y1m7ce | 23 | 0 | 0.00% |
| BV1gP411u7UF | 32 | 0 | 0.00% |
| BV1BZ421N7Lm | 104 | 0 | 0.00% |
| BV1pi421a7N9 | 96 | 0 | 0.00% |
| BV1Yf421q76x | 45 | 0 | 0.00% |
| BV1M4421U7MC | 101 | 0 | 0.00% |
| BV1kS421R7SZ | 63 | 0 | 0.00% |
| BV1ws421M7ou | 62 | 0 | 0.00% |
| BV1Vx4y1t7g3 | 60 | 0 | 0.00% |
| BV1Vz421z7K6 | 41 | 0 | 0.00% |
| BV1WT42167Fa | 86 | 0 | 0.00% |
| BV1XZ42157B5 | 73 | 0 | 0.00% |
| BV1XcpgeaEgL | 64 | 0 | 0.00% |
| BV18BtNe8EdF | 76 | 0 | 0.00% |
| BV14TDQYoEWj | 142 | 0 | 0.00% |
| BV1a6SVYoE6D | 125 | 0 | 0.00% |
| BV1VWy6YREZz | 99 | 0 | 0.00% |
| BV1QN2QYWEvk | 90 | 0 | 0.00% |
| BV1BW2VYoEgK | 75 | 0 | 0.00% |
| BV1gaxFeGE1V | 111 | 0 | 0.00% |
| BV1qPt4eAEDq | 48 | 0 | 0.00% |
| BV1FM4m117JV | 61 | 0 | 0.00% |
| BV1K142187NJ | 75 | 0 | 0.00% |
| BV1StUMYiEcd | 146 | 0 | 0.00% |
| BV1kXBUYLEEt | 132 | 0 | 0.00% |
| BV13FUDYdEfh | 113 | 0 | 0.00% |
| BV1XDqXYuEef | 104 | 0 | 0.00% |
| BV1TPkuYnEs1 | 163 | 0 | 0.00% |
| BV1m86RYGEBw | 118 | 0 | 0.00% |
| BV1JZryYTEP7 | 88 | 0 | 0.00% |
| BV1Y8fYYBE9Y | 102 | 0 | 0.00% |
| BV1UWQoY5EWy | 137 | 0 | 0.00% |
| BV1bEZNYEEmv | 142 | 0 | 0.00% |
| BV19GnUzcEU9 | 152 | 0 | 0.00% |
| BV1ARsKzTE5p | 149 | 0 | 0.00% |
| BV19x4tzpE52 | 172 | 0 | 0.00% |
| BV1dExJzwE4X | 153 | 0 | 0.00% |
| BV1yDpqzpEck | 154 | 0 | 0.00% |
| BV17EHQzmEbn | 149 | 0 | 0.00% |
| BV1eFaWzpEve | 145 | 0 | 0.00% |
| BV1fdvwzLEmM | 122 | 0 | 0.00% |
| BV1E5Y9zEE4s | 196 | 0 | 0.00% |
| BV1HpbAzKEPN | 174 | 0 | 0.00% |
| BV1wUtFzZEn8 | 136 | 0 | 0.00% |
| BV1J289z1EJN | 162 | 0 | 0.00% |
| BV19U84zbEdv | 120 | 0 | 0.00% |
| BV1TJu6zNEWg | 172 | 0 | 0.00% |
| BV1oV3Bz7Epn | 156 | 0 | 0.00% |
| BV1693JzMEkD | 149 | 0 | 0.00% |
| BV1oZK8z2EeM | 140 | 0 | 0.00% |
| BV1rzN7z7EgK | 162 | 0 | 0.00% |
| BV1HpTYzwEjf | 132 | 0 | 0.00% |
| BV19p7ezjEpQ | 169 | 0 | 0.00% |
| BV1X67JzBELo | 168 | 0 | 0.00% |
| BV1qpEdzSEvm | 137 | 0 | 0.00% |
| BV1MDEzz4ERu | 148 | 0 | 0.00% |
| BV1LYVBzHE24 | 181 | 0 | 0.00% |
| BV1L6CRBdEMs | 166 | 0 | 0.00% |
| BV1Nzq5BCEVT | 105 | 0 | 0.00% |
| BV1etmtB9Ekj | 143 | 0 | 0.00% |
| BV1ae2YBwE2Z | 146 | 0 | 0.00% |
| BV1JLU1BSEfs | 143 | 0 | 0.00% |
| BV1fECcB3EAy | 158 | 0 | 0.00% |
| BV1UF14BTEyv | 162 | 0 | 0.00% |
| BV1uiV86MEmA | 161 | 97 | 60.25% |
| BV1E8G86EE3a | 187 | 107 | 57.22% |
| BV1TxLV6oE88 | 184 | 120 | 65.22% |
| BV1K89sBEE7z | 172 | 114 | 66.28% |
| BV1WAo4BsE5w | 113 | 68 | 60.18% |
| BV1iLdrBUEvo | 127 | 65 | 51.18% |
| BV1c3deBuEbp | 29 | 11 | 37.93% |
| BV1PUXfBgEPt | 140 | 86 | 61.43% |
| BV1379VBoEsm | 105 | 76 | 72.38% |
| BV17owUzxEwK | 199 | 87 | 43.72% |
| BV1CDP9zXE1N | 96 | 62 | 64.58% |
| BV1SkPcz7EYS | 151 | 73 | 48.34% |
| BV16sfBBdE2y | 156 | 83 | 53.21% |
| BV15QfdBwErR | 121 | 0 | 0.00% |
| BV1QF6uB1EBX | 192 | 0 | 0.00% |
| BV1GGzuBCEPw | 156 | 0 | 0.00% |
| BV1KArCBvEwW | 172 | 0 | 0.00% |
| BV1LLibBaEt9 | 135 | 0 | 0.00% |
| BV1JViYBJESE | 130 | 0 | 0.00% |
| BV1dtB4BaEgG | 159 | 0 | 0.00% |
| BV1NwqjB2EEa | 82 | 0 | 0.00% |
| BV1pQJ56YE7c | 154 | 103 | 66.88% |
| BV1r3Ts64EQE | 180 | 116 | 64.44% |
| BV1BxM26nETV | 72 | 60 | 83.33% |
| BV1TPt16LEVY | 139 | 99 | 71.22% |
| BV12Ge36YEXY | 214 | 180 | 84.11% |
| BV1raaZ6EE6u | 95 | 61 | 64.21% |
| BV1rYaZ6mE3x | 133 | 105 | 78.95% |

### 2.5 衣刀规则候选归纳（2026-10-10，w2-synth）

本节更新 §2.4 的历史阻塞状态：本轮以本机已抽取缓存为输入，完成语义归纳；不重新抽取、不调用外部模型、不联网。
已阅读具体转述并与实际规则陈述比较，先剔除笼统判断，再按可见对象、症状和关系归纳；字面检索仅用于查找转述，最终归属保存为逐条审核索引，不沿用 4,038 个相似度簇。

**数据和统计口径**：97 期、6,651 个唯一已抽取段；`issues` 与 `praises` 合计 6,292 条点评，5,978 种不同转述。
候选的 `inputSegments` / `extractedSegments` 均为 6,651、`extractionStatus: complete`，只指这批已抽取输入完成归纳；不表示 §2.4 的 11,957 段全量可见区间均完成抽取。
`promptVersion: critique@0.2.1`、`rulesVersion: portrait@0.1.0` 沿用缓存元数据；当前实际 portrait 文件已有 19 条，去重同时比较 general 的 2 条与 xhs 的 5 条候选。
频次按 `(bvid, segment)` 去重计算段数，按 bvid 计算期数；相同转述在不同段仍计为不同点评。同段可以支持多个不同准则，不把段数或点评次数当作独立照片数。

**过滤**：4,082／6,292 条（**64.88%**）笼统评价未作为规则证据，包括「构图不佳／很差／欠佳」「照片不错」「调整后更好」，以及只说后期、光线、肤色不好而未交代症状的评价。
另有 23 条虽提到具体部位，但不能稳定推导共享准则，记作 `unresolvedConcrete`；461 条归入非选片；其余 1,726 条作为选片规则归纳或映射依据。
过滤不抹掉差评段的整体负信号；未具体化的差评不获得推测的规则 ID。

**候选结果**：[portrait-v0.2-candidates.json](../src/rules/candidates/portrait-v0.2-candidates.json) 共 **42 条**，按出现期数、段数排序。
全部至少出现在两期；40 条负面问题、2 条正面加分（动感、飞扬发丝），全部 `status: proposed`、`severity: hint`，无未经审核的 gate / penalty 提议。
每条陈述不超过 80 字，带例外、`frequency{episodes,segments}`、`polarity`、`tierContrast` 和最多 4 条跨期代表证据。
证据只保留不超过 40 字的转述、bvid、段号、秒数、档位及截图相对路径；`text` 是审核接口的兼容别名，内容与 `paraphrase` 相同。

| aspect | 候选数 |
|---|---:|
| pose | 9 |
| quality | 7 |
| face | 6 |
| light | 6 |
| background | 5 |
| color | 4 |
| exposure | 3 |
| framing | 2 |

其中 3 条 `check.by: measure` 只用已有代理信号：歪斜使用 `horizontalTiltDegrees` / `verticalTiltDegrees` 和对应 lineConfidence，高光/暗部使用 `clippedHighlights` / `clippedShadows`。
各自注明不能识别场景意图或定位非面部区域的限制，不新造阈值；其余 39 条 `teacher` 需结合成片与拍摄意图判断，本轮并未调用老师模型。
可见的塑料皮肤、白边、透视及合成穿帮属于成片判断；具体液化、布光、器材、调色操作和组照编排属于非选片复盘。

**已有规则证据**：[existing-evidence.json](../src/rules/candidates/existing-evidence.json) 累积 **809 条规则—点评证据归属**，对应 **791 条去重点评**，覆盖 22 个已有 ID（16 个 portrait、1 个 general、5 个 xhs）。
肤色、面部明暗、表情、闭眼、焦点、常见裁切与背景穿头优先映射现有准则；笼统抽取映射亦重新核实，例如只有天空过曝不会归入面部曝光规则。
已有证据全量保留；审核页最多显示 4 条代表证据。通用库和 xhs 的证据由 `/rules/data.referenceRules` 只读展示，不因归纳自动批准 xhs 候选，也不加入人像草案导出。

**Top 15 候选**（按期数）：

1. `P-YD-TONAL-GRAY`：检查画面是否灰平、亮暗层次粘连，导致轮廓与质感难以区分。（60 期／106 段）。
2. `P-YD-TILT`：检查地平线、建筑或框架是否无意歪斜并削弱画面稳定感。（53 期／90 段）。
3. `P-YD-NONFACE-HIGHLIGHTS`：检查衣服、头发或环境的高光是否大面积溢出并丢失需要保留的细节。（46 期／80 段）。
4. `P-YD-BG-SEPARATION`：人物、衣服和发丝轮廓应与背景可区分，避免无意融成一块。（43 期／66 段）。
5. `P-YD-SCENE-CONTRAST`：检查亮暗反差是否过强，使所需人物或环境细节难以同时辨认。（30 期／50 段）。
6. `P-YD-LIGHT-FLAT`：需要立体感的画面中，检查均匀平光是否抹平人物与环境的空间层次。（30 期／37 段）。
7. `P-YD-COLOR-LAYERS`：需要色彩层次的画面中，检查是否通篇同色或冷暖趋同而难以区分内容。（27 期／41 段）。
8. `P-YD-FACE-PERSPECTIVE`：检查面部是否明显拉长、放大或扭曲，结合距离与画面位置复核透视或处理痕迹。（27 期／36 段）。
9. `P-YD-MOTION-READABLE`：动作或运动痕迹清楚支持人物状态时，可作为组内优选线索。（25 期／35 段）。
10. `P-YD-EXPOSURE-READABLE`：检查整体曝光是否使需要表达的内容难以辨认；不把偏暗或偏亮本身当作错误。（24 期／39 段）。
11. `P-YD-SCENE-INTEGRATION`：检查人物与场景的光影、质感及接地关系是否连贯，避免无意悬浮或贴图感。（23 期／29 段）。
12. `P-YD-POSE-RESTRAINED`：检查动作是否僵硬端着、摆拍痕迹过重而不符合画面的自然状态。（20 期／22 段）。
13. `P-YD-HAIR-MOTION`：飞扬或掠过脸颊的发丝能增强画面的动感和空气感，可作为组内优选线索。（19 期／23 段）。
14. `P-YD-BG-BLACK`：环境承担表达作用时，背景不应黑成一片而丢失场景信息。（17 期／19 段）。
15. `P-YD-COMPOSITE`：检查换天、叠加雨雪或景深效果是否与原画面的尺度、虚实及光影关系相符。（16 期／20 段）。

**非选片主题**：[portrait-non-selection.json](../src/rules/candidates/portrait-non-selection.json) 共 **16 个主题**、461 条点评，每主题带期数、段数、归纳陈述及 1–2 条证据：

组照景别与动作变化、创作策划与参考模仿、组照主题与情绪连贯、拼图、排版与封面用途、特效与合成制作、服装妆造与发型设计、器材、焦段与曝光设置、机位、视角与拍摄距离、模特外貌、审美与客户偏好、场地与置景道具选择、补光与选光方法、灯位、灯距与布光操作、模特引导与动作设计、调色工具与分区、拍摄时段选择、后期目标质感与风格。

**负样本**：`/tmp/w2-rules-data/negatives.jsonl` 共 **3,748 段**，其中 3,497 段来自本批抽取，251 段保留原有未抽取的低档样本。
每行新增 `ruleIds`，兼容字段 `violatedRules` 同步；仅引用当前正式、xhs 或新候选 ID，不引用相似度簇或非选片主题。
1,329 段有具体规则归属、2,419 段为空列表。低档、明确差评或 bad verdict 保留整体负信号，空规则列表不等于没有问题；正面点评不因档位低而变成违例。
这些归属仍是文本候选标注，不是截图确认的逐规则训练真值。

**可复核与复现**：
[语义码本](../src/rules/candidates/portrait-synthesis-codebook.json) 和 [逐条转述索引](../src/rules/candidates/portrait-synthesis-index.json) 保存人工归属；
[本地生成器](../src/rules/candidates/synthesize-portrait.py) 只执行去重、计数与输出，对新增未审核转述报错，不自动套关键词或调用模型。
`synthesis.inputDigest` 记录抽取文件摘要，计数与证据可从只读 extracted 缓存重建。

```bash
python3 src/rules/candidates/synthesize-portrait.py --data-root /tmp/w2-rules-data
node --test test/rules.test.js test/rules-review.test.js test/aggregate-rules.test.js test/portrait-synthesis.test.js
npm test -- --test-skip-pattern='fixture face detection recall|fixture grouping reaches'
```

**验证**：针对性测试 9／9 通过；全套测试 213 项，212 通过、1 跳过、0 失败（包含新结构与跨库证据接口测试）。
用指定 Python 环境、端口 43126 启动真实 CLI 服务，HTTP `/rules/review` 与 `/rules/data` 均为 200；数据返回 42 条候选、16 条 portrait 已有证据及 6 条跨库只读证据，随后关闭服务。
审核页支持 polarity、档位对比、测量信号和 `paraphrase`，跳转秒数与截图相对路径保留兼容；未进行截图或浏览器交互验收。
`nice` 返回 `setpriority: Operation not permitted`，服务仍运行，不能声称已降低优先级。
当前本地 `data/rules-review/frames/` 缓存不存在，截图暂不能显示；本轮未联网取图，也未把截图放入仓库。

**局限**：ASR 同音字、短转述缺上下文及取样间隔可能误指点评对象，未回听或逐图核实。
本批档位覆盖 **1,029／6,651 段（15.47%）**：NPC 361、人上人 336、顶尖 252、夯 80，未检出拉；全量 OCR 覆盖仍是 §2.4 的 14.83%。
`tierContrast` 是低档 NPC/拉与高档夯/顶尖/人上人中出现的段数，并列出未归入两档的段数；不是概率、因果作用或有效分类能力。
点评对象是观众投稿，带有点评者风格与投稿筛选偏差，组照/对比画面及邻段重复也可能影响证据归属，不能泛化为所有人像或摄影师个人同组选片真值。
正式规则库未修改，本轮未提交或 push。

### 2.6 未抽取段排查（2026-10-11）

**结论与证据边界**：历史数量差为 **11,957 − 6,651 = 5,306 段**。当前同一批 OCR 文本的默认预处理会跳过 **5,319 段**、送抽取 **6,638 段**。跳过策略足以解释差额的量级，但与历史输入仍差 **13 段**，不能宣称已逐段闭合。当前与 `4eab26b` 的衣刀 skip 判定相同；历史可能包含默认过滤前的试点或 `--include-skipped` 输入，也可能有未完成批次，均缺日志/缓存证据。不能把 5,306 全部当作抽取失败，也不能把 6,638 当作未抽取数。

**数据找回**：本机 `/tmp/w2-rules-data/` 已不存在。Ceph `references/yidao/` 有 `critiques/`（291 文件）和 `critiques-v2/`（195 文件），根目录无 `extracted/`、`preprocessed/` 或备份档案。`backup_wulin_extracted.py` 的固定目标是 `references/wulin/extracted`，不能作为衣刀备份证明；本次在衣刀根目录未发现对应备份。抽取缓存和 usage 日志未找回，不能恢复逐期已抽取清单、失败重试次数或完整 6,651 段输入。

使用 `transfer_rules.py export/receive` 回传 195 个 OCR JSONL/元数据文件到 `/tmp/w5-yidao-gap/`；gzip+base64 分块和整文件 SHA-256 均通过。另以同一分块协议回传只含计数的原始/OCR 对照：97 期、11,957 行，段身份/时间与转写逐行相同，差异均为 0；因此未重复下载原始全文。另只读接收历史 `w2-rules-export-full-1010` 日志产物（195 文件校验通过）；97 个历史 OCR JSONL 与当前文件逐字节相同，排除了该历史导出至今的 OCR 输入变化，但不能恢复抽取执行历史。当前 `--preprocess-only` 成功处理 97 期。全文及预处理副本仅留 Ceph 与该临时目录。

#### 逐期统计

“跳过”为 `skipSuggested`；“非选片主题”表示 topics 全部在 retouch/gear/styling/other 内，与跳过重叠，**不是人工判定无选片价值**；“评价”为具有 `evaluationSpans` 的段数，“默认有效”为不建议跳过。评价位置是转写字符区间，不是秒数。已有候选代表与 existing-evidence 全量出处可证明 **882 个唯一段曾抽取**，全部属于当前默认有效段；下表“已抽取≥”仅为这个可复核下界，不是逐期完整计数。逐期真实已抽取及未抽取有效段均为未知，不能由下界取补集冒充漏抽。

| bvid | 总段 | 有转写 | 跳过 | 非选片主题 | 有评价位置 | 默认有效 | 已抽取≥ |
|---|---:|---:|---:|---:|---:|---:|---:|
| BV12Ge36YEXY | 214 | 214 | 93 | 121 | 78 | 121 | 21 |
| BV1379VBoEsm | 105 | 104 | 54 | 67 | 26 | 51 | 7 |
| BV13FUDYdEfh | 113 | 113 | 41 | 53 | 36 | 72 | 14 |
| BV14TDQYoEWj | 142 | 142 | 62 | 84 | 50 | 80 | 7 |
| BV15QfdBwErR | 121 | 121 | 47 | 68 | 40 | 74 | 8 |
| BV1693JzMEkD | 149 | 149 | 64 | 97 | 61 | 85 | 16 |
| BV16sfBBdE2y | 156 | 155 | 87 | 113 | 48 | 69 | 12 |
| BV17EHQzmEbn | 149 | 149 | 53 | 82 | 59 | 96 | 14 |
| BV17owUzxEwK | 199 | 199 | 103 | 131 | 61 | 96 | 15 |
| BV18BtNe8EdF | 76 | 76 | 26 | 42 | 30 | 50 | 6 |
| BV19GnUzcEU9 | 152 | 151 | 52 | 77 | 60 | 100 | 15 |
| BV19U84zbEdv | 120 | 120 | 46 | 72 | 47 | 74 | 9 |
| BV19p7ezjEpQ | 169 | 168 | 80 | 106 | 59 | 89 | 13 |
| BV19x4tzpE52 | 172 | 172 | 62 | 96 | 69 | 110 | 10 |
| BV1ARsKzTE5p | 149 | 148 | 69 | 91 | 49 | 80 | 12 |
| BV1BW2VYoEgK | 75 | 75 | 35 | 43 | 23 | 40 | 10 |
| BV1BZ421N7Lm | 104 | 103 | 44 | 65 | 36 | 60 | 2 |
| BV1BxM26nETV | 72 | 71 | 32 | 41 | 26 | 40 | 7 |
| BV1C94y117Lj | 27 | 26 | 17 | 18 | 1 | 10 | 2 |
| BV1CDP9zXE1N | 96 | 96 | 42 | 56 | 39 | 54 | 11 |
| BV1E5Y9zEE4s | 196 | 196 | 86 | 112 | 63 | 110 | 9 |
| BV1E8G86EE3a | 187 | 183 | 91 | 123 | 62 | 96 | 15 |
| BV1FM4m117JV | 61 | 60 | 31 | 38 | 23 | 30 | 2 |
| BV1GGzuBCEPw | 156 | 156 | 87 | 119 | 47 | 69 | 15 |
| BV1HpTYzwEjf | 132 | 132 | 61 | 77 | 43 | 71 | 15 |
| BV1HpbAzKEPN | 174 | 173 | 59 | 106 | 82 | 115 | 17 |
| BV1J289z1EJN | 162 | 161 | 75 | 110 | 69 | 87 | 8 |
| BV1JLU1BSEfs | 143 | 141 | 57 | 77 | 53 | 86 | 18 |
| BV1JViYBJESE | 130 | 129 | 56 | 78 | 45 | 74 | 17 |
| BV1JZryYTEP7 | 88 | 88 | 49 | 62 | 27 | 39 | 5 |
| BV1K142187NJ | 75 | 74 | 28 | 44 | 32 | 47 | 3 |
| BV1K89sBEE7z | 172 | 170 | 77 | 109 | 56 | 95 | 12 |
| BV1KArCBvEwW | 172 | 172 | 74 | 118 | 69 | 98 | 15 |
| BV1L6CRBdEMs | 166 | 166 | 85 | 109 | 44 | 81 | 7 |
| BV1L94y127yr | 40 | 40 | 26 | 29 | 4 | 14 | 0 |
| BV1LLibBaEt9 | 135 | 135 | 67 | 89 | 47 | 68 | 7 |
| BV1LYVBzHE24 | 181 | 179 | 70 | 100 | 64 | 111 | 17 |
| BV1M34y1e7nY | 105 | 105 | 40 | 68 | 40 | 65 | 8 |
| BV1M4421U7MC | 101 | 101 | 43 | 65 | 39 | 58 | 11 |
| BV1MDEzz4ERu | 148 | 147 | 78 | 97 | 43 | 70 | 10 |
| BV1NwqjB2EEa | 82 | 82 | 36 | 50 | 25 | 46 | 6 |
| BV1Nzq5BCEVT | 105 | 105 | 48 | 72 | 40 | 57 | 10 |
| BV1PUXfBgEPt | 140 | 139 | 63 | 86 | 47 | 77 | 6 |
| BV1QF6uB1EBX | 192 | 191 | 124 | 155 | 48 | 68 | 1 |
| BV1QN2QYWEvk | 90 | 90 | 42 | 57 | 27 | 48 | 9 |
| BV1RT4y1a7tR | 110 | 107 | 47 | 69 | 48 | 63 | 7 |
| BV1SkPcz7EYS | 151 | 151 | 63 | 92 | 57 | 88 | 14 |
| BV1StUMYiEcd | 146 | 144 | 71 | 87 | 45 | 75 | 5 |
| BV1TJu6zNEWg | 172 | 171 | 73 | 110 | 67 | 99 | 14 |
| BV1TPkuYnEs1 | 163 | 162 | 68 | 98 | 58 | 95 | 12 |
| BV1TPt16LEVY | 139 | 139 | 31 | 57 | 77 | 108 | 18 |
| BV1TxLV6oE88 | 184 | 182 | 79 | 105 | 57 | 105 | 12 |
| BV1UF14BTEyv | 162 | 160 | 70 | 101 | 49 | 92 | 10 |
| BV1UWQoY5EWy | 137 | 136 | 66 | 90 | 45 | 71 | 7 |
| BV1VWy6YREZz | 99 | 99 | 48 | 67 | 36 | 51 | 3 |
| BV1Vx4y1t7g3 | 60 | 59 | 24 | 33 | 24 | 36 | 6 |
| BV1Vz421z7K6 | 41 | 40 | 11 | 20 | 23 | 30 | 5 |
| BV1WAo4BsE5w | 113 | 112 | 47 | 61 | 30 | 66 | 8 |
| BV1WT42167Fa | 86 | 86 | 33 | 44 | 30 | 53 | 11 |
| BV1X67JzBELo | 168 | 166 | 71 | 94 | 50 | 97 | 13 |
| BV1XDqXYuEef | 104 | 104 | 36 | 59 | 42 | 68 | 7 |
| BV1XZ42157B5 | 73 | 73 | 39 | 48 | 20 | 34 | 13 |
| BV1XcpgeaEgL | 64 | 64 | 29 | 41 | 20 | 35 | 3 |
| BV1Y8fYYBE9Y | 102 | 102 | 42 | 60 | 37 | 60 | 10 |
| BV1Yf421q76x | 45 | 43 | 19 | 27 | 18 | 26 | 5 |
| BV1a6SVYoE6D | 125 | 124 | 57 | 78 | 45 | 68 | 7 |
| BV1ae2YBwE2Z | 146 | 145 | 75 | 94 | 54 | 71 | 8 |
| BV1bEZNYEEmv | 142 | 142 | 69 | 93 | 46 | 73 | 6 |
| BV1c3deBuEbp | 29 | 29 | 10 | 12 | 5 | 19 | 1 |
| BV1dExJzwE4X | 153 | 150 | 60 | 87 | 72 | 93 | 14 |
| BV1dtB4BaEgG | 159 | 157 | 87 | 111 | 52 | 72 | 6 |
| BV1eFaWzpEve | 145 | 145 | 63 | 90 | 49 | 82 | 8 |
| BV1etmtB9Ekj | 143 | 143 | 61 | 85 | 56 | 82 | 14 |
| BV1fECcB3EAy | 158 | 156 | 76 | 92 | 41 | 82 | 10 |
| BV1fdvwzLEmM | 122 | 122 | 61 | 71 | 31 | 61 | 5 |
| BV1gP411u7UF | 32 | 31 | 25 | 29 | 4 | 7 | 0 |
| BV1gaxFeGE1V | 111 | 110 | 49 | 69 | 35 | 62 | 7 |
| BV1iLdrBUEvo | 127 | 127 | 63 | 84 | 39 | 64 | 4 |
| BV1kS421R7SZ | 63 | 62 | 27 | 42 | 27 | 36 | 7 |
| BV1kXBUYLEEt | 132 | 130 | 59 | 83 | 45 | 73 | 11 |
| BV1m86RYGEBw | 118 | 118 | 62 | 78 | 35 | 56 | 7 |
| BV1oV3Bz7Epn | 156 | 155 | 74 | 102 | 53 | 82 | 7 |
| BV1oZK8z2EeM | 140 | 139 | 66 | 90 | 39 | 74 | 6 |
| BV1pQJ56YE7c | 154 | 154 | 72 | 105 | 54 | 82 | 5 |
| BV1pi421a7N9 | 96 | 96 | 46 | 66 | 37 | 50 | 5 |
| BV1qPt4eAEDq | 48 | 48 | 20 | 24 | 16 | 28 | 5 |
| BV1qpEdzSEvm | 137 | 137 | 39 | 69 | 66 | 98 | 20 |
| BV1r3Ts64EQE | 180 | 179 | 73 | 103 | 69 | 107 | 13 |
| BV1rYaZ6mE3x | 133 | 131 | 52 | 73 | 47 | 81 | 9 |
| BV1raaZ6EE6u | 95 | 93 | 41 | 48 | 22 | 54 | 12 |
| BV1rzN7z7EgK | 162 | 162 | 76 | 102 | 56 | 86 | 9 |
| BV1sv4y1m7ce | 23 | 23 | 17 | 19 | 3 | 6 | 0 |
| BV1uiV86MEmA | 161 | 160 | 68 | 100 | 64 | 93 | 8 |
| BV1wUtFzZEn8 | 136 | 136 | 48 | 72 | 56 | 88 | 9 |
| BV1ws421M7ou | 62 | 62 | 38 | 45 | 17 | 24 | 4 |
| BV1yDpqzpEck | 154 | 152 | 54 | 97 | 69 | 100 | 18 |
| BV1za411Y7TW | 3 | 3 | 2 | 2 | 0 | 1 | 0 |
| **合计** | **11,957** | **11,888** | **5,319** | **7,351** | **4,174** | **6,638** | **882** |

#### 原因分布与抽样

下列是**当前预处理跳过原因**，不是历史未抽取原因的已确认分布：

| 当前跳过原因（互斥） | 段数 |
|---|---:|
| 无转写 | 69 |
| 有转写、仅 other、无词表评价句 | 4,386 |
| 有转写、仅非选片主题组合、无词表评价句 | 864 |
| 合计 | 5,319 |

`other` 在这里是主题词未命中；W1 的画面 `kind=other` 本来就不进入这 11,957 行，不能再用它解释数量差。无“好看/不好”等词表评价句也不等于没有实质点评。历史未抽取归因（可跳过/无转写/失败/只跑部分）无法精确分配；若 6,651 段确实来自此同一身份全集，则至少 13 个历史抽取段现在会被建议跳过，但这不能证明其余默认有效段全部成功。

为查漏，对有转写且建议跳过的行检索「歪、斜、糊、模糊、过曝、死白、死黑、灰、脏、塑料、穿帮、穿头、僵、呆、用力过度、磨皮」，得到 **197 段人工复核池**。这只是查找线索，含讲解/操作及同音误识别，既非有效点评真值，也不是完整召回。以下 10 段已阅读上下文，确有成片问题/比较准则；全为 `skipSuggested=true`、`evaluationSpans=[]`，不在已保留出处的 882 段中。**因缓存缺失，仍不能确认它们历史未抽取**。秒数是照片段起点定位，不冒充精确评价起点。

| ≤40 字转述 | bvid | 段号 | 秒数 |
|---|---|---:|---:|
| 长焦加滤镜后画面过糊 | BV12Ge36YEXY | 29 | 226 |
| 一组照片过多使用强制歪斜 | BV12Ge36YEXY | 101 | 912 |
| 全图磨皮抹掉头发和墙面质感 | BV12Ge36YEXY | 443 | 2857 |
| 视觉冲击应来自视角而非歪斜 | BV13FUDYdEfh | 123 | 444 |
| 锐化过多使成片显脏 | BV13FUDYdEfh | 226 | 926 |
| 画面元素普遍歪斜，基本功不足 | BV15QfdBwErR | 47 | 155 |
| 应保留横平竖直的照片 | BV15QfdBwErR | 88 | 367 |
| 天空失去细节，成片灰蒙 | BV16sfBBdE2y | 185 | 618 |
| 层次通透但反差显得太硬 | BV16sfBBdE2y | 299 | 1130 |
| 照片普遍歪斜，影响观看感受 | BV17owUzxEwK | 32 | 185 |

#### 补抽价值估计

**已确认历史未抽取的有效点评：未知。** 当前可确认 10 段有内容但被默认预处理跳过；同类机器复核池 197 段，档位如下。OCR 档位仅作描述，不能替代有效性或违规标签。

| 档位 | 197 段复核池 | 全部 5,319 跳过段 |
|---|---:|---:|
| 夯 | 2 | 94 |
| 顶尖 | 14 | 190 |
| 人上人 | 12 | 209 |
| NPC | 10 | 251 |
| 拉 | 0 | 1 |
| 未知 | 159 | 4,574 |

当前默认有效 6,638 段中档位为夯 80、顶尖 252、人上人 336、NPC 360、拉 0、未知 5,610；其漏抽档位分布同样未知。全体真实新增有效段的保守边界为 **0–5,306**（假定历史快照确为此全集子集），无法据此给可靠点估计。

仅作预算情景：历史平均 6,292/6,651≈0.946 条点评/段，选片归属 1,726/6,651≈0.260 条/段。如果恢复缓存后确认这 10 段都缺失且抽取产率相同，约新增 **9–10 条点评、2–3 条选片归属**；如果复核池 197 段全部有效且缺失，约 **186 条点评、51 条选片归属**。这不是置信区间或实际新增预测；定向查漏与历史抽取存在选择偏差，实际可为 0，也可每段多条。

对 42 条候选的影响需要新点评人工归属后计算。样例可能补强 `P-YD-TILT`、`P-YD-SCENE-CONTRAST`、`P-YD-TONAL-GRAY`，磨皮/锐化也可能归入已有准则或非选片主题；不能由关键词直接增加频次。每条候选在既有期内新增段只增加 segments，首次在某期出现才增加 episodes；同段同规则去重。缺失身份和语义归属未确定，不能声称候选会增加多少条或修改现有排序。

**建议**：值得优先恢复原抽取快照，再人工复核 197 段并定向补抽；目前不建议把约 5,300 段全量重抽。若原缓存最终不可恢复，应另行确定重建快照的预算和审核范围，不能称作“只补缺失”。本次未调用模型、未运行归纳，也未改候选/证据或正式规则。

#### 补抽命令与续跑

已准备 `/tmp/w5-yidao-gap/prepare-supplement.py` 和 `reviewed-substantive-keys.json`（上述 10 段；可在人工复核后扩充）。**当前准备命令会明确 STOP，因为原缓存缺失；不能提供已经确认可执行的缺失段清单。** 恢复原缓存到 `/tmp/w5-yidao-gap/restored/extracted/` 后，脚本先验证 6,651 个唯一段及 `synthesis.inputDigest`，再以 `(bvid, segment.index)` 做差集；选入默认有效缺失段及已人工确认的跳过缺失段。新旧数据分开，避免变更规则库后旧缓存签名失效导致重抽。脚本内容如下，临时目录清理后可重新保存：

```python
import hashlib,json
from pathlib import Path
root=Path('/tmp/w5-yidao-gap')
baseline=root/'restored/extracted'
files=sorted(baseline.glob('*/*.json'))
candidate=json.loads(Path('src/rules/candidates/portrait-v0.2-candidates.json').read_text())
assert files, 'STOP: restore the original extracted snapshot first; none found'
assert hashlib.sha256(''.join(hashlib.sha256(p.read_bytes()).hexdigest() for p in files).encode()).hexdigest()==candidate['synthesis']['inputDigest'], 'STOP: baseline digest differs from reviewed snapshot'
old={}
for p in files:
 r=json.loads(p.read_text()); k=(r['bvid'],r['segment']['index'])
 assert k not in old or old[k]==r, 'STOP: conflicting baseline segment'
 old[k]=r
assert len(old)==candidate['inputSegments']==6651
reviewed={tuple(k) for k in json.loads((root/'reviewed-substantive-keys.json').read_text())}
out=root/'supplement'
assert not out.exists(), 'STOP: supplement already exists; resume extraction in that directory'
selected={};seen=set()
for p in sorted((root/'preprocessed').glob('BV*.jsonl')):
 for r in map(json.loads,p.read_text().splitlines()):
  k=(r['bvid'],r['segment']['index']);seen.add(k)
  if k in old or (r['preprocessing']['skipSuggested'] and k not in reviewed):continue
  r.pop('preprocessing') # preserve original OCR row for input signature
  selected.setdefault(p.name,[]).append(r)
assert old.keys()<=seen and reviewed<=seen
assert selected, 'STOP: no confirmed missing selected segments'
for name,rows in selected.items():
 p=out/'critiques-v2'/name;p.parent.mkdir(parents=True,exist_ok=True)
 p.write_text(''.join(json.dumps(r,ensure_ascii=False)+'\n' for r in rows))
(out/'selection.json').write_text(json.dumps({'baselineDigest':candidate['synthesis']['inputDigest'],'segments':sum(map(len,selected.values())),'keys':[[r['bvid'],r['segment']['index']] for rows in selected.values() for r in rows]},ensure_ascii=False,indent=2))
print('READY',sum(map(len,selected.values())))
```

```bash
# 仓库根目录；仅准备差集，不调用模型。先恢复缓存，否则 STOP。
python3 /tmp/w5-yidao-gap/prepare-supplement.py
# 仅当上一步 READY 才由外部执行；本次未执行。
nice -n 10 python3 ml/references/extract_critiques.py   --data /tmp/w5-yidao-gap/supplement --concurrency 2 --keep-going --include-skipped
# 中断或批次失败后重复同一抽取命令即可续跑；不要重复准备命令。
```

`--include-skipped` 只用于已筛选的 supplement 子集，否则上面的实质点评样例仍会被过滤。缺失清单不包含任何已恢复的旧段；默认每批 8 个分块、18,000 字符，单分块 6,000 字符。新签名缓存可续跑，失败不写完成缓存；损坏的已有缓存解析/校验仍会终止，须人工隔离后再运行。保持 supplement 输入、prompt、schema 和规则库不变，否则签名失效。当前默认 portrait 虽仍标 0.1.0，内容已有 19 条，不能仅凭版本字符串认为旧输入签名相同。

#### 后续增量归纳流程（需后续单独执行）

1. 备份原快照；把补抽输出与旧 6,651 段合并到独立 `/tmp/w5-yidao-gap/merged/extracted/`，每个 `(bvid, index)` 只留一份有效缓存，检查所有点评 ≤40 字、秒数在可见区间内，确认 prompt/schema/规则语义一致。不要让旧/新签名的不同内容同时存在；当前生成器会报 `conflicting segment cache`，并要求 promptVersion/rulesVersion 唯一，不能通过改写版本标签伪造一致性。
2. 枚举新增 issues/praises 的 exact text，逐条人工归属。已有转述沿用索引；新转述补入 `portrait-synthesis-index.json` 的 entries/assignments，标已知规则 ID、`vague`、`unresolved` 或 `NS:*`。需要新准则/非选片主题时，先在 `portrait-synthesis-codebook.json` 的 rules/nonSelection 补定义并检查 ID；不要自动关键词归类，不要写正式规则库。词义相同的新表述也需要索引条目。
3. 另行修改并测试 `synthesize-portrait.py` 的 `assert len(rows)==6651`，改为核验本次审核的合并快照数量/清单和摘要，同时更新相关固定快照测试；保留“未审核转述报错”与冲突/版本校验。它不是追加计数器，必须对审核后全部缓存重算，避免同段重复计频。
4. 执行 `python3 src/rules/candidates/synthesize-portrait.py --data-root /tmp/w5-yidao-gap/merged`。该命令会重写候选、existing-evidence、non-selection 和临时 negatives；只能在新索引/码本审核后执行。复核每条规则的去重期数/段数、代表证据、档位分布和 inputDigest；新增候选继续 proposed，不自动影响 ranking/signals。
5. 若改脚本则补单测；运行 `python3 -m unittest discover -s ml/references -p 'test_*.py'` 及 `node --test test/portrait-synthesis.test.js test/rules.test.js test/rules-review.test.js`，检查增量数和未审核转述拒绝行为。后续单独审核/提交，不 push。

**本次验证与资源**：Python references 测试 120 项，115 通过、5 跳过、0 失败；未改仓库脚本。三个自有 Ray 作业为 `w5-yidao-gap-inspect-1011`、`w5-yidao-gap-export-1011`、`w5-yidao-gap-compare-1011`，均 SUCCEEDED、各 1 CPU/0 GPU，自身并行峰值 2。结束后仅删除这三个终态作业记录，确认自有记录及 RUNNING/PENDING 均为 0；未创建 Ray 包、未碰别人的作业、未接触 Eagle 图库或「未删减」。回传/统计/清理凭据位于 `/tmp/w5-yidao-gap/`。Git 暂存因主仓库 worktree `index.lock` 写入被沙箱拒绝，文档改动保留，未提交、未 push。

## 3. 其他题材与吴晓隆课程（W1-D）

评估方案、来源推荐、公开数据许可边界和课程相关性见 [research-genres.md](research-genres.md)。B站候选只检索元数据，后续确认采集范围后才下载；不能把搜索下界写成全账号总量。吴晓隆课程仅供内部研究，Ceph课程根目录私有，不分发原视频/转写/大师作品图像。后续复用其他分支的转写与截帧流水线，由用户审核提炼规则，再写“课程名 + 集号 + 时间点”到规则库。本任务未提炼已观看的课程规则，不虚构时间点。

## 4. 武林与吴晓隆（W3，2026-10-10）

本节为用户指定范围的内部研究采集。仓库仅保存元数据、脚本、测试和短转述；视频、截图和转写留在私有 Ceph，取回文本放在 `/tmp/w3-genres-data/`。未操作「未删减」，未改正式规则库，也未运行沙箱内嵌套 `codex exec`。

### 4.1 范围与处理口径

- 武林：`genre_sources_candidates.json` 中 mid=474457011 的摄影点评合集全部 40 个视频；这是视频数，含短片和上下集，不代表 40 个连续编号。`build_genre_manifests.py` 生成 `wulin_critique_manifest.json`，下载后用公开 `info.json` 补发布时间与实际时长。Ceph 根为 `references/wulin/`，依次复用 fetch、FunASR、segment、align、verify。
- 吴晓隆：原 72 集仅取 `relevance=high` 的 19 集，文件名相关性仍需人工复核。`wuxiaolong_asr_manifest.json` 的稳定 ID 为课程名 SHA-256 前 10 位加集号，`source_path` 指向原始已上传 MP4。FunASR 输出带秒数的句子到 `references/wuxiaolong/asr/`，没有截帧或照片切分。
- 武林下载并发 2，初始每任务随机等待 4–8 秒，硬上限 4。只有 Ceph 私有 cookie 文件路径通过 `BILI_COOKIE_FILE` 传入，cookie 内容不回传。1080P 保存为 `video1080.m4s`；AI 字幕是否存在逐期统计，缺字幕仍使用 FunASR。
- 两套 ASR 串行使用同一张 GPU，每作业 2 CPU、1 GPU；其他作业为 CPU。`REF_LOG_TEXT=0` 关闭 ASR 原文抽样日志，完整文本通过 gzip/base64 分块传输，逐块及逐文件 SHA-256 核对。
- 武林布局抽样同时有全屏照片、编辑器和左右对比图。`REF_LAYOUT=wulin` 将分析裁剪设为归一化 x=0.02–0.98、y=0.03–0.97；SIFT 匹配区域为 640×360 特征图的 x=150–495、y=44–340。初版宽匹配区域会将共享固定界面的不同照片误合并，已回退到中央区域，并以 `identity_version=wulin-central-sift@1` 使旧版武林缓存失效。另在全量对齐中发现两期全部被旧讲师负样本误排除：武林固定头像/栏目与不同照片共享，因此武林关闭开场讲师负样本，缓存仅接受 `host_negative_templates=0`，verify 同时拒绝旧负样本产物；衣刀开场讲师排除保持原逻辑。从 1080P 解码为宽 854 像素、等比高度，1 FPS 取样；代表图也是此解码尺度。衣刀默认裁剪与原生解码行为不变。布局、匹配版本、视频名、解码宽度进入分段恢复检查与统计，避免复用错误布局的旧产物。
- 吴晓隆六主题为 landscape/风光、street/街拍、documentary/纪实、composition/构图、light/光线、viewing/观看方式。每个命中带前后各 1 句上下文，跨句间隔最多 20 秒，相邻窗口合并跨度最多 180 秒；单个超长句不硬截断。每行包含时间、主题、命中关键词、0 基含尾句子范围和带时间的句子。主题可以重叠，覆盖秒数按区间并集、句数按索引去重，不能相加主题时长。

### 4.2 结果与 QA

| 资料 | 实际完成 | ASR 时长 | ASR 句数 | 候选段 | 覆盖率 |
|---|---:|---:|---:|---:|---|
| 武林点评 | 40/40 视频 | 105,673.790 秒（29.35 小时） | 42,026 | 4,252 photo + 20 compare = 4,272 | 候选实际可见区间 98,786.90 秒，时长 93.48%；候选分配 39,687 句（94.43%） |
| 吴晓隆高相关课程 | 19/19 集（原 72 集） | 37,933.420 秒（10.54 小时） | 17,079 | 826 主题段；不切照片 | 去重 2,704 句（15.83%）；区间并集 7,107.338 秒（18.74%） |

武林 40 期均为 1080P，30/40 有 AI 字幕；音视频合计 14,524,083,736 字节（14.52 GB）。40 个发布时间全部从公开 info.json 补齐，均单 P；公开时长 105,696 秒，单期与 ASR 时长差最大 1.04 秒。ASR 使用 NVIDIA H20、单 GPU，峰值分配显存 5.519 GB。对齐未分配句子 111，归入 other 的句子 2,228，无转写候选段 68；身份链接数 2,693 不能当作独立作品数。

审计 40/40 通过，检查 6,613 个代表 JPEG 签名、分段时间线、ASR 完整性、来源和 critiques SHA-256。原始输入只核对存在、大小、mtime 与目录清单 SHA-256，**没有计算整段视频内容 SHA-256**。两套文本逐块/逐文件校验后取回（武林 126 个文本/元数据文件、吴晓隆 40 个；另显式取回 3 个 QA HTML），武林 critiques 本机再核对 40 个输出散列及 4,272 行来源/区间，吴晓隆 19 集/826 行课程、文件集号与句子范围审计通过。

| 阶段 | 作业 ID | API 墙钟秒 | 状态 |
|---|---|---:|---|
| 武林下载 | `w3-genres-wulin-fetch-1010` | 1870.280 | SUCCEEDED |
| 武林 ASR | `w3-genres-wulin-asr-1010` | 1300.372 | SUCCEEDED |
| 武林最终分段（缓存复用 + 修复重建） | `w3-genres-wulin-segment-v3-1010` | 1558.105 | SUCCEEDED |
| 武林最终对齐 | `w3-genres-wulin-align-v2-1010` | 70.952 | SUCCEEDED |
| 武林审计 | `w3-genres-wulin-verify-1010` | 159.389 | SUCCEEDED |
| 武林文本导出 | `w3-genres-wulin-export-1010` | 12.305 | SUCCEEDED |
| 武林 QA 导出 | `w3-genres-wulin-qa-1010` | 19.428 | SUCCEEDED |
| 吴晓隆 ASR | `w3-genres-wuxiaolong-asr-1010` | 387.235 | SUCCEEDED |
| 吴晓隆主题窗口 | `w3-genres-wuxiaolong-topics-v2-1010` | 12.805 | SUCCEEDED |
| 吴晓隆文本导出 | `w3-genres-wuxiaolong-export-v2-1010` | 7.141 | SUCCEEDED |

以上 API 时间包含环境准备、排队、输入等待和执行，毫秒差除以 1000，不等于纯算法耗时。初版宽 SIFT 的全量分段作业已 STOPPED，随后 `w3-genres-wulin-segment-v2-1010` 全 40 期完成（1649.956 秒）；最终作业只重建曾使用开场负样本的 12 期、复用其余 28 期。首次全量对齐 `w3-genres-wulin-align-full-1010` 因两期零候选而 FAILED，修复后重新全量对齐。UI 探针 v2/v3 因过强的“调整后仍同图”断言 FAILED，v4 的不同照片/原样复制回归通过。全部作业状态和时间保存在 `ml/references/w3_genres_run_receipt.json`；本任务作业均已终止，未操作其他人的作业。

最终三期 QA 联系表（首/中/末期）为 `/tmp/w3-genres-data/wulin/qa/BV1Cy4y157vi.html`、`BV1KR4y1e77x.html`、`BV1NZhw6cEpS.html`，同目录 `*-sheet-*.jpg` 可浏览缩略总览。原始截图/带转写的 HTML 均不入仓库。文本位于 `/tmp/w3-genres-data/wulin/critiques/` 和 `/tmp/w3-genres-data/wuxiaolong/topics/`；Ceph 产物分别在 `references/wulin/`、`references/wuxiaolong/`。


最终三期 QA 抽查：首期 #15（59–109 秒）编辑器照片已从旧 other 恢复为 photo；原则文字页 24–55 秒、器材示意 956–971 秒仍进入候选，左右对比与末尾拼版仍常标为 photo。中期 0–51 秒讲师开场、51–69 秒原则页、图库网格也混入。末期 7–99 秒部分开场视频、284–391 秒文字/宣传页与 393–451 秒文件夹/图库列表混入，但 451 秒后的雪景、3471–3915 秒的编辑器调整和对比可见内容保留；同图多个调整视图经常各成一段。查看了首期第 0 页、中期第 0 页、末期第 0/5 页及零候选诊断图，没有逐帧审阅全部 21 页。关闭武林负样本避免整期漏掉照片，也增加了讲师/栏目页混入；这里报告候选召回与误分观察，不提供精度真值。

旧版试点三期联系表的问题记录（最终产物按新匹配版本重建）：全屏风光、编辑器图、同图调整前后和多图拼版都能保留；但首期 35–55 秒的原则文字页、第二期开始的文字页被误归入 photo/compare，第三期 118–142 秒的器材演示也进入候选。部分左右比较仍被标成 photo；首期 59–109 秒的编辑器照片被标 other，运动/转场可能造成漏段。末尾拼版不等于单张作品。上述为目测抽查，不是逐段真值或准确率；高覆盖率不能证明照片分段的精度。

### 4.3 抽取准备与沙箱外命令

`extract_critiques.py --source wulin --data DIR` 读取 `DIR/critiques/*.jsonl`；衣刀仍默认读取 `/tmp/w2-rules-data/critiques-v2/`，用 portrait 规则、原提示词和 schema。`--rules` 可提供一个或多个规则文件，重复 ID 若内容冲突则拒绝；武林默认合并 landscape+street，仅用于映射，正式文件不改。

武林主题词覆盖 composition、horizon、light、weather-timing、layers、color、subject、moment、story，以及 retouch/gear。主题标记是候选筛选，不是专家判定；`--preprocess-only` 只写本地标记，完全不调用模型。抽取缓存包含来源、规则内容、schema 与提示词签名；输出删掉转写，仅保留每条 1–40 字转述和时间。Codex 并发仅允许 1 或 2。

以下命令在**沙箱外终端**执行；本轮停在抽取准备，由用户运行。先完整处理 QA 的 3 期，抽查至少 10 条短转述、对应时间与规则 ID；确认 ASR/切分误差可以接受后再全量。不要把 `--max-batches` 的部分完成当成三期完成。

```bash
cd <LOCAL_PATH>

nice -n 10 python3 ml/references/extract_critiques.py \
  --source wulin --data /tmp/w3-genres-data/wulin \
  --rules src/rules/landscape.json src/rules/street.json \
  --preprocess-only

nice -n 10 python3 ml/references/extract_critiques.py \
  --source wulin --data /tmp/w3-genres-data/wulin \
  --rules src/rules/landscape.json src/rules/street.json \
  --bvids BV1Cy4y157vi BV1KR4y1e77x BV1NZhw6cEpS --concurrency 2

# 审核试点后，全量可恢复运行；已通过相同签名校验的段会跳过。
nice -n 10 python3 ml/references/extract_critiques.py \
  --source wulin --data /tmp/w3-genres-data/wulin \
  --rules src/rules/landscape.json src/rules/street.json --concurrency 2
```

吴晓隆 topics 是讲座主题索引，不能当成逐图 critique 填进抽取器；后续规则提炼应回听上下文，引用课程、集号和时间点并由用户审核。

### 4.4 复现与限制

提交器新增 `--manifest`、fetch/topics 阶段，保留衣刀默认 manifest。使用 `REF_OUT` 分离两套产物；武林 segment 设置 `REF_VIDEO_NAME=video1080.m4s`、`REF_LAYOUT=wulin`，align 设置 `REF_SOURCE=wulin`，verify 设置相同视频名与 `REF_SOURCE=wulin`。全量处理可以设置 `REF_WAIT_INPUT_SECONDS=1800` 等待下载原子发布输入；默认 0，不改变旧流水线。CPU 文本导出如下（作业 ID 必须使用新的唯一值，完成后再 receive）：

```bash
python3 ml/references/transfer_genres.py export --source wulin --id w3-wulin-export-NEW
python3 ml/references/submit.py status --id w3-wulin-export-NEW
python3 ml/references/transfer_genres.py receive --source wulin --id w3-wulin-export-NEW

python3 ml/references/transfer_genres.py export --source wuxiaolong --id w3-wuxiaolong-export-NEW
python3 ml/references/submit.py status --id w3-wuxiaolong-export-NEW
python3 ml/references/transfer_genres.py receive --source wuxiaolong --id w3-wuxiaolong-export-NEW

python3 -m unittest discover -s ml/references -p 'test_*.py'
node --test test/references-extraction.test.js
npm test -- --test-skip-pattern='fixture face detection recall|fixture grouping reaches'
```

最终回归：Python discovery 34 项、29 通过/5 跳过（本机缺可选视觉依赖或外部试点图）；Node 定向 2/2；指定 npm 全套 214 项、213 通过/1 跳过/0 失败。固定 UI 不应合并不同照片的视觉回归另在 Ray 有 OpenCV 的环境通过；新增固定栏目负样本策略测试在本机通过。日志保存在 `/tmp/w3-genres-python-final.log`、`/tmp/w3-genres-node-final.log`、`/tmp/w3-genres-npm-final.log`。

文本导出模式只读 critiques/topics 与统计元数据；QA 导出需显式 `qa --source wulin --bvids` 三个 ID，取回独立 HTML 联系表。接收器拒绝目录逃逸、不完整传输、重复/缺失分块和校验不符。

照片身份、photo/compare/other 是视觉启发式，不等同独立作品数；静态讲师、文字页、白底或极简照片、编辑器 UI、缩放和对比版式都可能误分。1 FPS 会漏掉短切，跨边界整句只按最大重叠归入一段，可导致邻照片错配。ASR 有同音字与人名误差；未逐句回听。关键词主题索引有召回与精度偏差，不代表课程主题完整覆盖，更不是可直接加入正式规则的真值。吴晓隆抽样中，“社会”可以只指城市环境，“框架”可以指理论框架，分别误召回纪实/构图；主题索引需要人工读上下文。文件编号与口播课程序号也不总相同：抽样文件 20 对应口播第 19 课、文件 06 对应口播第 5 课；manifest 保留文件编号，引用时必须注明课程与文件集号并结合秒数定位。武林未做衣刀等级 OCR，tier/verdict 保持 null；课程没有照片段数。
