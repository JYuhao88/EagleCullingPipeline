# 中文摄影论文与教学文章：第二证据来源

日期：2026-10-10；分支 `w3-papers`。正文仅保存在 `/tmp/corpus/papers/`，本轮由助手阅读、复核和提炼，没有调用外部模型或上传正文。仓库只保存短转述、标题及定位信息。这里的“论文”是来源集合的简称，包含期刊文章、教学连载和来源类型不明确的文章，不能一概视为经过同行评审的研究。

## 1. 筛选范围与数量漏斗

扫描 Ceph 的 `<CORPUS_INDEX>` 全部 2,000 个分区，原文来自 `<CORPUS_TEXT>`。本次实际 zh 索引为 47,085,205 行；不是背景中跨语言/跨来源的 1.71 亿行。宽泛标题匹配本次为 36,311 行，不沿用先前约 4.8 万的估计。

| 阶段 | 数量 | 说明 |
|---|---:|---|
| zh 索引全量 | 47,085,205 | pyarrow 向量化过滤，8 个进程 |
| 宽泛摄影/人像/肖像/街拍/照片编辑标题 | 36,311 | 诊断计数，不是后续过滤的母集 |
| 正向词命中 | 4,456 | 人像、构图、用光、曝光、纪实、风光、新闻、瞬间等组合 |
| 排除词后 | 4,355 | 排除摄影测量、医学、遥感、发电、绘画、设计等 |
| 标题复核中间包 | 767 → 702 → 609 | 多轮缩小范围，不等于正文相关性判定 |
| 最终标题候选 | 481 | 609 包中明确拒绝 128 条；候选清单逐项复核 |
| 取回非空正文 | 481 | 全部验证原文 id 与索引 id 一致 |
| 重点段落精读 | 126 | 实践类 110、教学/理论代表 16 |
| 进入映射的文献 | 95 | 其余精读文献未形成足够可靠、可见的新证据 |

正向词与排除词在 `ml/references/corpus/paper-filter.json`。不是单独用“构图”“用光”“风光”匹配；例如“利用光纤”和“风光互补”不会因包含词片段进入实践候选。标题去重会合并空格、标点差异。长度保留 800–20,000 chars，作为本轮筛选边界，不是质量指标。

配置的 `selection.reviewedAccept` 保存 481 条经过人工复核的 id、标题和复核顺序。以 4,355 条扫描结果重放 `select`，长度拒绝 309、人工清单拒绝 3,565、选中 481，逐字段及顺序复现 `/tmp/corpus/papers/candidates.jsonl`。漏斗中间包来自探索筛选；最终重放用保存的人工清单，不能把该清单当成对新语料自动成立的相关性分类器。换语料快照应重新复核标题；缺少已审核 id 或标题改变时脚本报错。

最终清单保留标题、年份、channel、doc_type、chars、id、file、row_group、row 和索引分区。定位信息是元数据，没有把正文放入配置。

### 类别与来源

| 实践主题 | 篇数 |
|---|---:|
| 人像、肖像、姿态 | 118 |
| 构图、景深 | 136 |
| 用光、光影、逆光、曝光 | 74 |
| 风光摄影 | 94 |
| 新闻、瞬间、抓拍、选片/编辑 | 115 |
| 纪实、街头、街拍 | 9 |

同一标题可属于多个主题，不能加总当作总篇数；新闻与纪实主题亦有交叉。channel 为 cnki 285、quark 134、baidu_wenku 46、secdata_std 12、web_crawl 2、wanfang 2。doc_type 为 journal_article 125、article_like 135、other 220、thesis 1。来源索引有不少不确定类型；没有把 `other` 修饰成学术期刊。

## 2. 取回方式与可复用操作

脚本 `ml/references/corpus/fetch_corpus_papers.py` 提供 scan/select/fetch/status/receive/stop。依照仓库既有 Ray 提交及 stdout 回传方式，urllib 绕过代理；本地不需要读 Ceph，也不需要 pyarrow，扫描/定位时远端需要 pyarrow。Ray Jobs 地址默认 `<RAY_JOBS_URL>`，可用 `RAY_JOBS_URL` 覆盖。

scan 为 CPU 8、GPU 0；fetch 为 CPU 1、GPU 0。原文 parquet 使用 `sorted(glob('**/*.parquet'))` 定位 file 下标，读取指定 row_group/row 后必须通过 id 校验，未通过便停止该批，不能静默采用猜测位置。481 篇均通过，正文总计 1,565,926 字符。

20 个正文批次：fetch00–fetch18 每批 25 篇，fetch19 为 6 篇。最多同时 2 个本轮 CPU 作业；脚本提交前检查自己前缀的 RUNNING/PENDING 数量，达到 2 时拒绝新提交。应从单一协调进程顺序提交，预检查不是跨进程原子锁。不会停止别人的作业。

每段用 gzip + base64 回传，含分段索引、分段 SHA-256、整文件大小/SHA-256、结束标记。接收先核验整批，再用 `.part` 文件原子替换，拒绝缺块、重复块、损坏块和路径穿越。正文和筛选输出限制在 `/tmp/corpus/papers/` 下。日志上限为 30,000,000 字节，远端预留 100,000 字节给运行信息；超过则应减小批次。实测正文单批最大 199,527 字节，扫描日志 852,710 字节，都远低于上限。

可在 worktree 根目录重放已完成的本地选择及取回，不必重新提交作业：

```sh
python ml/references/corpus/fetch_corpus_papers.py select --candidates /tmp/corpus/papers/reproduced-candidates.jsonl --stats /tmp/corpus/papers/reproduced-selection-stats.json
python ml/references/corpus/fetch_corpus_papers.py status --id w3-papers-fetch19-20261010
python ml/references/corpus/fetch_corpus_papers.py receive --id w3-papers-fetch19-20261010
python ml/references/corpus/fetch_corpus_papers.py --help
```

新扫描用 `scan --id w3-papers-<唯一编号>`，取回扫描用相同 id 的 `receive`；重新审核配置后运行 `select`。新正文批次用 `fetch --id w3-papers-<唯一编号> --offset 0 --batch-size 25`，查询完成再 receive，之后推进 offset。已有 id 不重复提交。`stop` 仅用于主动取消自己的作业，本轮作业已经全部终止，无需 stop。

第一次扫描因远端 exec 环境无 `__file__` 而失败，修正后 scan2 成功；这不是缺正文或 id 校验失败。最后 Ray 审计列出自己的 22 个作业：20 个 fetch 和 scan2 为 SUCCEEDED，初始 scan 为 FAILED，RUNNING/PENDING 均为 0。

## 3. 两阶段阅读及证据边界

481 篇全部做了标题、小标题和摘要/短段的快速复核；快速分级为实践潜力 341、偏理论/教学 139、无关 1。实践潜力是进入阅读优先级的标记，不表示每篇都已有可用于选片的独立结论。无关项《新闻摄影瞬间的选择》正文主要混入宣传/新闻发展讨论，未进入证据。

第二阶段重点阅读 126 篇中的可操作章节和相邻语境：110 篇实践类、16 篇理论/教学代表。其正文文件共 259,060 字符，这是所选文件体量，**不是声称逐字读完的数量**。对最终引用的 130 个不同段落做了全文语境复核，共形成 182 个“规则—文献—段落”关联。只转述成片可判断的动作、形体、关系、明暗和色彩。其余 215 篇具有实践潜力的长尾只做快速复核，没有冒充已精读；本轮是优先样本提炼，未穷尽整个实践集合。

选择理由：优先包含具体姿态/用光案例、邻帧变化、现场取舍或成组照片用途的文章；同类通用构图教程只取代表，理论性文化心理、器材介绍、后期菜单步骤和拍摄者内心描述不进入规则。正文含摄影术语不等于段落相关，几何“放射”和作者“航空”单位也不能自动判成无关。

分栏/OCR 混杂被逐段排除。例如部分文章夹入广播新闻、家电、打印机说明或太平天国文字；有的把秋色教程与超现实合成混在一起。未采用“F1 大景深”一类可疑技术描述，也未把三分法的错误数学叙述做成依据。未检查原版图像，仅阅读正文及图注，不能声称完成照片视觉验证。

定位按解码正文中 `re.split(r'\n\s*\n', text)` 的非空段落从 1 编号，附临近短小标题；是本地语料定位，不是印刷页码。原始 SHA-256 可在本地取回记录复核；本轮重新检查 481 个文本文件校验和及所有 182 条定位，全部通过。转述也检查未作为原句直接复制。

精读集合中 77 篇 year 来源为 none、27 篇 head_rough、14 篇 article_no、6 篇 issue、1 篇 received、1 篇 doi。保留索引 year 与 `yearSource`，未可靠确定的年份保持 null。head_rough、收稿年和编号推定年都不能视为已核实的出版年份；表中数字仅代表索引记录。

## 4. 产物与重复支持计数

`paper-evidence.json`：contractVersion 1，126 篇文献登记，55 组映射，覆盖 45 个不同规则 ID。其中 source 34、exception 18、counterpoint 3，95 篇实际参与支持，130 个不同支持段落。多个文献支持同一条短转述合并到 `supports`；`paperSlug/locator` 保留首项以兼容详情展示，所有定位仍在 supports 中。

`supportCount` 精确等于该组 supports 的不同 paperSlug 数量；同一篇两个段落只计一篇。同一文献支持两个规则可分别计数，不能把规则计数相加当成独立文献总量。标题规范化去重只消除明显同标题副本；连载、同作者和近似教学转载仍可能相关。因此这里是“语料文献支持篇数”，**不是独立实验、作者数、科学共识强度或可用于排序的权重**。

`paper-candidates.json` 保持 contractVersion 1 与 papers 登记，rules 为空：现有规则足以覆盖本轮可靠观点，未为满足数量造新规则。后续新增须满足 source:"paper"、status:"proposed"、severity:"hint"、可见教师判断及最多 4 条短证据。本轮无需修改正式库、ranking 或 signals。

### Top 观点

| 规则 | 类别 | 支持篇数 | ≤40 字转述 |
|---|---|---:|---|
| G-SUBJECT-HIERARCHY | source | 11 | 背景与陪体应衬托主体，避免无关内容抢眼 |
| P-YD-BG-SEPARATION | source | 11 | 明暗、色彩或轮廓差异使人物与背景可辨 |
| S-MOMENT-ACTION | source | 11 | 比较动作、神态与物件关系是否清楚 |
| P-YD-ACTION-MOMENT | source | 9 | 动作和神态的关键瞬间支持同组优选 |
| P-FACE-EXPRESSION | source | 9 | 比较自然神态，允许不同表情各有用途 |
| P-LIGHT-SHAPE | source | 8 | 光影应呈现脸部或形体的层次与质感 |
| L-LIGHT-INTENT | source | 7 | 比较光影是否呈现地形、质感与气氛 |
| P-YD-POSE-RESTRAINED | source | 6 | 自然的动作与神态比勉强板脸更易成立 |
| P-YD-LIGHT-FLAT | exception | 5 | 柔和散射光也能清楚表现细节或高调氛围 |
| P-YD-MOTION-READABLE | source | 5 | 运动姿态或痕迹可作为瞬间比较线索 |
| P-EXPOSURE-INTENT | source | 5 | 非剪影人像需让必要面部细节可读 |
| P-EXPOSURE-INTENT | exception | 5 | 剪影可舍去脸部细节，以形体轮廓表达 |
| P-YD-INTERACTION | source | 5 | 人物互动应能读出动作、支撑或视线呼应 |
| P-YD-POSE-THEME | source | 5 | 表情、姿态与形体应共同支持可见情境 |
| P-YD-LIGHT-FLAT | source | 4 | 需塑形时保留明暗差异，避免空间显平 |

这些文章与易道的主要一致点是：人物/背景可辨、光影塑形、动作与神态、姿态及视线呼应。例外主要限制把经验变成统一淘汰门槛：剪影不强求脸部亮度、柔光不必有强反差、同色可形成整体、黑背景可隐藏杂物、白色影棚背景可有意过曝、失败或反应瞬间不必输给动作峰值。

### 易道 P-YD-* 逐项对应

下表按直接 source 支持数优先排列；“例外篇数”支持的是例外观点，不能算成原判据的直接赞同。无论文映射的易道候选不在表中，也不声称被文献否定。

| 易道候选 | 出处篇数 | 例外篇数 | 对照与适用边界 |
|---|---:|---:|---|
| P-YD-BG-SEPARATION | 11 | 0 | 明暗、颜色、轮廓均可分离；不限定只能虚化背景 |
| P-YD-ACTION-MOMENT | 9 | 1 | 比较关键动作和神态；失败、反应也可成立 |
| P-YD-POSE-RESTRAINED | 6 | 0 | 自然姿态与神态；不由姿态推断真实心理 |
| P-YD-INTERACTION | 5 | 0 | 手臂、支撑、视线呼应提供可见关系 |
| P-YD-MOTION-READABLE | 5 | 0 | 动作或痕迹可读；不设跳跃高度/速度门槛 |
| P-YD-POSE-THEME | 5 | 0 | 形体、表情相协调；不认证身份与故事 |
| P-YD-LIGHT-FLAT | 4 | 5 | 塑形需层次；柔和散射光/高调也有效 |
| P-YD-PROFILE | 4 | 0 | 剪影轮廓与动作可辨；不要求面部纹理 |
| P-YD-SCENE-CONTRAST | 4 | 0 | 过大光比可能损失必要内容；不推导固定光比 |
| P-YD-BG-DEPTH | 3 | 0 | 前中后景远近关系；不用背景复杂度代替层次 |
| P-YD-GAZE-DIRECTION | 3 | 0 | 互动视线是线索；不要求所有人看镜头 |
| P-YD-CATCHLIGHT | 1 | 0 | 眼神光与环境光协调；未支持双眼必须各有光点 |
| P-YD-MULTIPLE-SHADOWS | 1 | 0 | 复核投影干扰；不按灯具数淘汰 |
| P-YD-NONFACE-SHADOWS | 1 | 0 | 内容需要的衣物暗部细节；无固定黑位阈值 |
| P-YD-EXPOSURE-READABLE | 0 | 4 | 有意剪影按轮廓表达复核 |
| P-YD-COLOR-LAYERS | 0 | 2 | 相近色也能形成统一，不强求色块数量 |
| P-YD-BG-BLACK | 0 | 1 | 阴影可隐藏无关杂物 |
| P-YD-BG-BLUR | 0 | 1 | 装饰光斑可衬托人物 |
| P-YD-FLARE-DETAIL | 0 | 1 | 眩光可以有意，仍需保留表达内容 |
| P-YD-NONFACE-HIGHLIGHTS | 0 | 1 | 白背景有意过曝，以主体未损为边界 |

### 与书籍、小红书及正式规则的关系

与书籍已有证据交叉的规则 ID 共 23 个：G-FRAMING-BALANCE, G-PROXY-BLUR, G-SUBJECT-HIERARCHY, L-FOCUS-REQUIRED, L-FOREGROUND-ROLE, L-LIGHT-INTENT, L-NATURAL-COLOR, L-SEQUENCE-PRESERVE, L-VISUAL-INTENT, P-COLOR-INTENT, P-CROP-HEADROOM, P-EXPOSURE-INTENT, P-FACE-EXPRESSION, P-FACE-FOCUS, P-LIGHT-SHAPE, P-YD-BG-BLACK, P-YD-BG-BLUR, P-YD-COLOR-LAYERS, P-YD-LIGHT-FLAT, P-YD-NONFACE-HIGHLIGHTS, S-MOMENT-ACTION, S-OCCLUSION-INTENT, S-UNIQUE-COVERAGE。共同支持主题主次、视觉平衡、光影用途和不完整画框等；剪影、运动模糊及非眼睛主体的例外方向一致。这里的交叉计数是规则覆盖，不表示两套转述逐字同义。

与小红书候选交叉共 4 个：G-FRAMING-BALANCE, G-SUBJECT-HIERARCHY, P-COLOR-INTENT, P-LIGHT-SHAPE。优先给这些现有候选增加出处，不再另建 paper 副本。书籍唯一新候选 `L-BOOK-TREE-FORM` 没有获得足够直接的论文依据，本轮未强行贴树木/前景文章作支持。

三组 counterpoint 为：`P-POSE-WEIGHT` 的坐卧姿支撑与站姿重心判断不可混用（3 篇）；`P-CROP-HEADROOM` 抓拍取景过紧可能丢失现场信息（1 篇）；`L-FOREGROUND-ROLE` 前景柳枝也可能制造杂乱（1 篇）。它们限制规则适用范围，不证明任何固定阈值错误。眼神光文章本身有“一只眼不能无光”的教学断言；只采用与环境光源协调这一较弱观点，没有把前一断言泛化。室内轮廓光文章对高光层次存在内部张力，也未据此放宽人物必要细节。

## 5. 连拍与组内选片

| 文献与定位 | 是否直接谈多张/序列 | 可见的比较问题 |
|---|---|---|
| 人像摄影美姿设计蹲姿与跳跃，段落25/27/33 | 直接建议多拍优选；27 是过程说明，未另算规则证据 | 肢体伸展、腾空姿态、神态在哪帧更协调 |
| 新闻摄影抓拍七法，段落12/17 | 直接谈多拍再选；12 未另算规则证据 | 舞动等不可预测动作，比较自然神态与关系 |
| 人像摄影中双人美姿技巧 站姿1，段落8 | 直接比较同一基本姿势的多幅图 | 手臂、头部、视线和神态微变是否形成呼应 |
| 专题纪实摄影中的瞬间把握，段落8/11/12 | 直接涉及多个瞬间/系列；并非普通连拍 | 不同意义的瞬间应否分别保留 |
| 抓拍体育新闻摄影的典型瞬间，段落16 | 直接讨论多个有新闻价值的时刻 | 失误、反应、旁观者是否提供不同信息 |
| 风光摄影与组照，段落29 | 直接谈组照 | 不同视角/情趣是否为整体提供贡献，避免只留一张 |
| 风光摄影进阶教程，段落26 | 直接谈定时间隔连续帧/延时 | 序列帧按用途复核，不能因相似全部合并 |
| 风光摄影作品的后期表现技巧（连载之13），段落7/8/10 | 案例可归纳；不是明确的连拍选片手册 | 船的位置、倒影和杂乱前景在哪帧更清楚 |
| 风光摄影作品的后期表现技巧-5顶光的魅力，段落7/8 | 等待合适位置的案例 | 普通时段的光影与车辆位置是否形成关系 |

直接多拍/组照建议与本轮归纳分开计数。没有找到系统的接触表编辑实验、连拍赢家标注或机器评分阈值；支持的是比较问题，不能据此调整 ranking 权重。新闻摄影的新闻价值也含照片之外的事实，本轮仅采用画面关系、动作、神态等可见部分。

## 6. 审核页接入与测试

`GET /rules/data` 同时返回 paperCandidates、paperEvidence，规则详情的 paperEvidence 附文献元数据与全部支持定位；有文献证据的其他正式库及小红书规则出现在只读 referenceRules。页面增加“论文”来源过滤、文献篇数及出处/例外显示，不取原文或图片，不计入视频频次。

用真实 worktree 数据直接调用路由（未启动 HTTP 服务），`/rules/data` 返回 200：126 篇登记、55 组映射、0 新候选、45 个带论文证据的规则 ID；62 个可审核规则、27 个只读参考规则。所有支持定位均附上文献元数据。本地审计记录 `/tmp/corpus/papers/api-audit.json`。

审核与导出兼容书籍接入：portrait 仍走旧 draft/path；未来批准的非人像 paper 候选进入 paperDrafts[library] 独立下载，bookDrafts 保留。实物 JSON 本轮无 paper 新候选，批准/合并/导出路径由合成 fixture 测试，不对真实规则提交决定。

验证命令（从本 worktree 根目录）：

```sh
python -m unittest discover -s ml/references/corpus -p 'test_*.py'
node --test test/rules-review.test.js test/books-review.test.js test/papers-review.test.js test/paper-rules.test.js test/style.test.js
npm test -- --test-skip-pattern='fixture face detection recall|fixture grouping reaches'
```

Python 合成单元测试 10/10，通过筛选/人工清单重放、id 校验、中文多块解码、校验损坏/缺块、输出路径约束及 CPU/并发提交限制；不依赖集群。Node 定向 19/19，通过真实数据契约、API、合并定位、跨库导出、DOM 展示及样式约束。指定全套 264 tests，263 pass、0 fail、1 skip，12863.90 ms；跳过项为可选 Python worker 冒烟，指定过滤的两项真实图库测试未重跑。完整日志 `/tmp/corpus/papers/npm-test-final.log`。初轮只有新增代码 5 行超过长度限制，修正后上述全套通过。真实浏览器视觉布局未验收；DOM 回归测试不能替代视觉验收。没有使用测试中的合成文献充当语料证据。

## 7. 局限与后续审核

- cnki/教学连载较多，质量、独立性与观点年代参差；正文来源不能当选片实验。
- 标题筛选、800 字下限会遗漏短而有效的文章；正向词以摄影实践组合为主，也可能漏掉未显式含关键词的编辑文章。
- 341 篇实践潜力中本轮重点阅读 110 篇，长尾 215 篇仍可继续抽样；95 篇支持数是当前提炼结果，不是全语料观点频率。
- 同标题去重没有识别所有近复制文章或同作者连载，支持篇数不可直接转换为置信度或权重。
- 混栏/OCR、来源类型与年份误识别降低证据可复核性；没有编造印刷页码、作者、刊名或 DOI。
- 理论中的情绪、文化符号和拍摄过程描述不一定能凭照片判定；少量代表阅读只用于范围/局限说明。
- 尚需摄影师逐项审核观点/例外，并用实际邻帧与交付用途验证；没有修改正式规则，也没有证明自动测量、阈值或选片效果。

## 8. 精读文献登记与选取理由

下表列出 126 篇重点阅读文献，与两个 JSON 的 papers 登记一致。年份为索引字段，缺失用“未知”；yearSource 见 JSON。最后一列为阅读选择主题及是否形成可复核规则证据。完整 481 候选元数据仅在本地 candidates.jsonl。

| slug | 标题 | 索引年 | channel / doc_type | 选取理由与用途 |
|---|---|---|---|---|
| paper-fc7e9b4ebd235bcd | 黑白人像摄影，也能让你很有范儿！ | 2008 | cnki / other | 人像/姿态；有成片可见映射 |
| paper-09e3480ff75dbc24 | 摄影用光之三 | 未知 | cnki / other | 用光/曝光；有成片可见映射 |
| paper-4eef298928e340c4 | 摄影构图学习时间与空间把握 | 未知 | baidu_wenku / other | 构图/景深；有成片可见映射 |
| paper-08f375f1794645d9 | 风光摄影作品的后期表现技巧-2 | 未知 | cnki / other | 风光；代表阅读，未采纳映射 |
| paper-14bfd696a625e5d3 | 浅谈新闻摄影瞬间表现技巧 | 1961 | cnki / other | 新闻/瞬间/取舍；有成片可见映射 |
| paper-538808d7f58a07da | 纪实摄影及其抓拍技巧研究 | 未知 | cnki / article_like | 纪实/街头、新闻/瞬间/取舍；代表阅读，未采纳映射 |
| paper-ed125f0247008c12 | 人像摄影之色彩处理 | 未知 | cnki / other | 人像/姿态；有成片可见映射 |
| paper-b5c9bfa3bfb3c293 | 摄影中的用光 斑 竹：付士红 嘉 宾：潘新田 | 2005 | cnki / other | 用光/曝光；代表阅读，未采纳映射 |
| paper-e7b0c837852cd62c | 摄影基础：景深 | 未知 | cnki / other | 构图/景深；有成片可见映射 |
| paper-4b3be32820842a5c | 风光摄影 | 未知 | cnki / other | 风光；有成片可见映射 |
| paper-b197c21465a9a75f | 新闻摄影巧用光 | 1974 | cnki / other | 用光/曝光、新闻/瞬间/取舍；有成片可见映射 |
| paper-d8b828af0ca0c1f2 | 专题纪实摄影中的瞬间把握 | 1993 | cnki / journal_article | 纪实/街头、新闻/瞬间/取舍；有成片可见映射 |
| paper-39729549be5eba78 | 人像摄影中的“免费”背景  图文 ／ 曾立新 | 未知 | cnki / other | 人像/姿态；有成片可见映射 |
| paper-701cdfed722cf249 | 逆光人像打造清新风格 | 未知 | cnki / other | 人像/姿态、用光/曝光；有成片可见映射 |
| paper-900080f8b0077266 | 摄影构图中的形状及意义 | 未知 | quark / other | 构图/景深；有成片可见映射 |
| paper-b7bc16c4801a55d3 | 风光摄影的技巧掌握风光摄影的技巧 | 未知 | quark / other | 风光；有成片可见映射 |
| paper-a856ac531bec265d | 新闻摄影抓拍七法 | 未知 | cnki / other | 新闻/瞬间/取舍；有成片可见映射 |
| paper-e5c99c32c7df37dd | 浅谈纪实摄影“决定性瞬间”的意义 | 2019 | quark / article_like | 纪实/街头、新闻/瞬间/取舍；代表阅读，未采纳映射 |
| paper-e37c0dbc6fde9b5e | 逆光人像篇 | 2008 | cnki / other | 人像/姿态、用光/曝光；有成片可见映射 |
| paper-d7f12e1dbbcef169 | 彩色摄影的用光特点 | 未知 | cnki / other | 用光/曝光；有成片可见映射 |
| paper-0c8bf885f81644cb | 谈摄影构图的特点 | 未知 | quark / other | 构图/景深；代表阅读，未采纳映射 |
| paper-3353918d431216b0 | 风光摄影中的光线运用 | 未知 | cnki / other | 风光；有成片可见映射 |
| paper-bbf6e6bd79350f5a | 浅谈摄影记者的抓拍意识 | 未知 | cnki / other | 新闻/瞬间/取舍；代表阅读，未采纳映射 |
| paper-34554c337e533a25 | 浅谈纪实摄影中的抓拍与摆拍 | 1930 | cnki / other | 纪实/街头、新闻/瞬间/取舍；代表阅读，未采纳映射 |
| paper-740d2ff2720b0a8e | 人像摄影中双人美姿技巧 站姿3 | 未知 | cnki / other | 人像/姿态；有成片可见映射 |
| paper-b956df5623da1890 | 浅谈风景摄影用光 | 1999 | cnki / other | 用光/曝光；有成片可见映射 |
| paper-7bbe06133fa85ba3 | 摄影构图入门 让照片自己说话 | 1965 | cnki / other | 构图/景深；有成片可见映射 |
| paper-7709fb61f58e199b | 风光摄影作品的后期表现技巧（连载之14） | 未知 | cnki / other | 风光；有成片可见映射 |
| paper-45a78c70c8424957 | 新闻摄影的抓拍让新闻更加鲜活 | 1928 | cnki / other | 新闻/瞬间/取舍；有成片可见映射 |
| paper-c12f3c7a7c898e23 | 摄影构图方法研究 ——视觉心理学在纪实摄影构图中的运用 | 2014 | quark / article_like | 构图/景深、纪实/街头；有成片可见映射 |
| paper-cf71560885796882 | 人像摄影美姿设计蹲姿与跳跃 | 未知 | cnki / other | 人像/姿态；有成片可见映射 |
| paper-6a2b4c02ed0af02c | 论舞蹈摄影用光 | 未知 | baidu_wenku / other | 用光/曝光；有成片可见映射 |
| paper-3cbe84f8cab60c5a | 摄影构图的视觉思维 | 未知 | cnki / other | 构图/景深；有成片可见映射 |
| paper-256b5440f12ec6fa | 风光摄影作品的后期表现技巧（连载之15） | 未知 | cnki / other | 风光；有成片可见映射 |
| paper-0e3bf95a26e6e3bb | 浅议新闻摄影中的抓拍手法 | 2014 | cnki / journal_article | 新闻/瞬间/取舍；有成片可见映射 |
| paper-d4f68ffdf7de1424 | 略论纪实人像摄影的特点及拍摄技巧 | 未知 | quark / article_like | 人像/姿态、纪实/街头；有成片可见映射 |
| paper-5459dea19c4e2370 | 人像摄影后期调色**之浪漫秋色效果 | 未知 | cnki / other | 人像/姿态；代表阅读，未采纳映射 |
| paper-e2774a6ee7c58934 | 摄影曝光疑难要掌握 | 1995 | cnki / other | 用光/曝光；代表阅读，未采纳映射 |
| paper-a1d836952b4ab59f | 摄影构图要素 | 未知 | cnki / other | 构图/景深；代表阅读，未采纳映射 |
| paper-5f14b6d264dad77a | 风光摄影作品的后期表现技巧（连载之13） | 未知 | cnki / other | 风光；有成片可见映射 |
| paper-c76dbc48dd77c5c5 | 新闻摄影抓拍技巧浅谈 | 1996 | cnki / other | 新闻/瞬间/取舍；有成片可见映射 |
| paper-00157ca0e95f9d85 | 布列松纪实摄影《决定性瞬间》的美学解读 | 2016 | quark / journal_article | 纪实/街头、新闻/瞬间/取舍；代表阅读，未采纳映射 |
| paper-746bd9b9b758e4c0 | 户外人像摄影闪光灯使用技巧    1 | 未知 | cnki / other | 人像/姿态；有成片可见映射 |
| paper-bb5dfa50dcf9a883 | 风景摄影常用光比平衡方法 | 未知 | cnki / other | 用光/曝光；代表阅读，未采纳映射 |
| paper-d0b1a47b65a16189 | 人像摄影构图中点的运用 | 未知 | baidu_wenku / other | 人像/姿态、构图/景深；有成片可见映射 |
| paper-3e986b8b7a25f22e | 风光摄影，要拍就请专业些 | 未知 | cnki / other | 风光；代表阅读，未采纳映射 |
| paper-8aa3370231b6e3a7 | 新闻摄影中拍摄角度的选择与运用 | 未知 | cnki / other | 新闻/瞬间/取舍；有成片可见映射 |
| paper-435d7254d496ae51 | 纪实性人像摄影的特点 | 未知 | cnki / other | 人像/姿态、纪实/街头；代表阅读，未采纳映射 |
| paper-e6e8744ffb4dfa1e | 人像摄影的 经典布光之蝴蝶光 | 未知 | cnki / other | 人像/姿态；有成片可见映射 |
| paper-74cd730571b3615e | 摄影曝光的控制与运用 | 未知 | cnki / other | 用光/曝光；有成片可见映射 |
| paper-0a66b2043073515a | 摄影构图中点线面的应用作用 | 2013 | baidu_wenku / journal_article | 构图/景深；有成片可见映射 |
| paper-60b98fcd3096550a | 风光摄影作品的后期表现技巧- 4 | 未知 | cnki / other | 风光；有成片可见映射 |
| paper-8c8c2738d97cf020 | 探析新闻摄影中的抓拍技巧 | 未知 | cnki / article_like | 新闻/瞬间/取舍；有成片可见映射 |
| paper-b7deb0472a59b863 | 人像摄影魅力光线之顶光 | 未知 | cnki / other | 人像/姿态；有成片可见映射 |
| paper-8252aa1b2a6edbd0 | 摄影用光基本光型分析 | 未知 | cnki / article_like | 用光/曝光；有成片可见映射 |
| paper-928728efe4b54c43 | 人物摄影中的“抓拍”技巧和构图原则分析 | 未知 | quark / article_like | 构图/景深、新闻/瞬间/取舍；有成片可见映射 |
| paper-bfc1e7826e929feb | 风光摄影作品的后期表现技巧-5顶光的魅力 | 2011 | cnki / other | 风光；有成片可见映射 |
| paper-89a36642b0c7bacb | 新闻摄影的瞬间思维 | 2009 | quark / other | 新闻/瞬间/取舍；代表阅读，未采纳映射 |
| paper-8e49b232ce73d689 | 人像摄影美姿设计之—**特殊姿态 | 未知 | cnki / other | 人像/姿态；有成片可见映射 |
| paper-f19e8d7c72348902 | 浅谈摄影创作中光影的运用 | 2015 | baidu_wenku / journal_article | 用光/曝光；代表阅读，未采纳映射 |
| paper-e4b7c2703de2386d | 浅谈商业摄影中景深的运用 | 未知 | cnki / article_like | 构图/景深；有成片可见映射 |
| paper-cac20ed6fe32d8d5 | 浅谈新疆风光摄影中的渲染气氛 | 未知 | quark / other | 风光；代表阅读，未采纳映射 |
| paper-688bb1b10f21e773 | 浅析新闻摄影构图中主体与陪体的关系 | 未知 | cnki / article_like | 构图/景深、新闻/瞬间/取舍；有成片可见映射 |
| paper-6fe7b1b2135cb650 | 浅谈闪光灯在人像摄影中的布光运用 | 2018 | baidu_wenku / journal_article | 人像/姿态；有成片可见映射 |
| paper-dd4709af803c253a | 谈谈逆光人像拍摄的要点 | 2011 | cnki / journal_article | 人像/姿态、用光/曝光；有成片可见映射 |
| paper-dca4ba72eea228d9 | 漫谈摄影构图五要素 | 1979 | quark / article_like | 构图/景深；有成片可见映射 |
| paper-1e0c4d7fd995553c | 风光摄影中的“逆袭”技术技巧 | 未知 | cnki / other | 风光；代表阅读，未采纳映射 |
| paper-8d707b0bd5542467 | 浅析新闻摄影中的“抓拍” | 1945 | cnki / other | 新闻/瞬间/取舍；有成片可见映射 |
| paper-6b9ff8fa09f1718f | 人像摄影魅力光线之侧光 | 未知 | cnki / other | 人像/姿态；有成片可见映射 |
| paper-09bd81cfdd6ba060 | 室内摄影的曝光 | 2005 | cnki / other | 用光/曝光；代表阅读，未采纳映射 |
| paper-d2fddcfb8e77138d | 谈摄影构图与创作 | 2017 | baidu_wenku / journal_article | 构图/景深；代表阅读，未采纳映射 |
| paper-839e1a22f99900a6 | 浅析自然风光摄影中的光线运用 | 未知 | quark / article_like | 风光；有成片可见映射 |
| paper-514d8d6c8a77f01a | 抓拍体育新闻摄影的典型瞬间 | 未知 | cnki / article_like | 新闻/瞬间/取舍；有成片可见映射 |
| paper-e0f66818855c4693 | 户外人像摄影2闪光灯使用技巧 | 未知 | cnki / other | 人像/姿态；有成片可见映射 |
| paper-ed7968b3a23d65a2 | 探究人像摄影的光影处理 | 2017 | baidu_wenku / journal_article | 人像/姿态、用光/曝光；有成片可见映射 |
| paper-c56574b0bfd3a52e | 阴影在摄影构图中的运用 | 未知 | quark / article_like | 构图/景深；有成片可见映射 |
| paper-d1083034cd3c8dbd | 风光摄影中的焦点选择 | 未知 | quark / other | 风光；有成片可见映射 |
| paper-0b49b8b1fdcf1dd9 | 新闻摄影拍摄技巧探讨 | 未知 | cnki / article_like | 新闻/瞬间/取舍；有成片可见映射 |
| paper-8e66a4b18ca09696 | 形神兼备是人像摄影的灵魂 | 未知 | quark / other | 人像/姿态；有成片可见映射 |
| paper-b0161f01acf52695 | 艺术摄影的用光技巧分析 | 2018 | baidu_wenku / journal_article | 用光/曝光；代表阅读，未采纳映射 |
| paper-e22cbbc171bf278f | 人像摄影构图方式剖析 | 2018 | baidu_wenku / journal_article | 人像/姿态、构图/景深；有成片可见映射 |
| paper-b078a9d66e541928 | 秋天的风光摄影 Scenery Photography in Autumn | 未知 | quark / other | 风光；有成片可见映射 |
| paper-effe3561fe5f118e | 新闻摄影记者的拍摄角度探析 | 未知 | cnki / other | 新闻/瞬间/取舍；有成片可见映射 |
| paper-62111e0c81fa96e4 | 谈人像摄影的写形与传神 | 未知 | quark / other | 人像/姿态；有成片可见映射 |
| paper-264a5683810eded4 | 浅谈艺术摄影中的用光技巧 | 2020 | quark / journal_article | 用光/曝光；代表阅读，未采纳映射 |
| paper-ffd7322aade10400 | 探析摄影构图技巧 | 2018 | baidu_wenku / journal_article | 构图/景深；有成片可见映射 |
| paper-91146b07f731e7f6 | 风光摄影中色彩的运用与表达方法探析 | 2019 | cnki / journal_article | 风光；有成片可见映射 |
| paper-ea232b406161d1a4 | 浅论新闻摄影构图 | 未知 | cnki / other | 构图/景深、新闻/瞬间/取舍；有成片可见映射 |
| paper-261ea14a892df29e | 人像摄影美姿造型 | 未知 | cnki / other | 人像/姿态；有成片可见映射 |
| paper-337598f21c3ba0c2 | 用光线作画人像摄影技巧指导 | 未知 | cnki / article_like | 人像/姿态、用光/曝光；有成片可见映射 |
| paper-b7c2af0bacc5410a | 浅谈摄影构图中形线元素的表现 | 未知 | cnki / other | 构图/景深；代表阅读，未采纳映射 |
| paper-c255590aa5d7aafa | 聆听那片静谧的湿地 ——手机风光摄影谈 | 未知 | cnki / other | 风光；有成片可见映射 |
| paper-d52f6848422d596b | 论消防新闻摄影构图中的主体 | 未知 | cnki / article_like | 构图/景深、新闻/瞬间/取舍；有成片可见映射 |
| paper-2d7a2077e46f121e | 浅谈人像摄影中影调与色彩的运用技巧 | 2018 | baidu_wenku / journal_article | 人像/姿态；有成片可见映射 |
| paper-874dddb2816437c9 | 浅谈摄影中的光影处理 | 2013 | baidu_wenku / journal_article | 用光/曝光；代表阅读，未采纳映射 |
| paper-7311a7a045107854 | 浅谈摄影构图的技巧 | 2020 | baidu_wenku / journal_article | 构图/景深；有成片可见映射 |
| paper-3b6e42f125a746d5 | 风光摄影构图中的色调与意境 | 未知 | baidu_wenku / other | 构图/景深、风光；代表阅读，未采纳映射 |
| paper-300de9b99c8e2aba | 论新闻敏感与新闻摄影抓拍意识的关系 | 2017 | cnki / journal_article | 新闻/瞬间/取舍；有成片可见映射 |
| paper-84b088f6dea2e963 | 人像摄影的魅力光线之硬光 | 未知 | cnki / other | 人像/姿态；有成片可见映射 |
| paper-32a8cbe588349918 | 摄影中的用光技巧分析 | 未知 | cnki / article_like | 用光/曝光；代表阅读，未采纳映射 |
| paper-349416c2ed1f1c1c | 摄影与摄影构图 | 未知 | cnki / article_like | 构图/景深；代表阅读，未采纳映射 |
| paper-3ad2f63bbaff6ed6 | 风光摄影创作技巧探析 | 未知 | cnki / other | 风光；有成片可见映射 |
| paper-8ef26034e0bb00ab | 新时期新闻摄影的构图方法研究 | 1983 | quark / article_like | 构图/景深、新闻/瞬间/取舍；有成片可见映射 |
| paper-54dcca5693e902d6 | 新春出行人像摄影指南 | 未知 | cnki / other | 人像/姿态；有成片可见映射 |
| paper-31769ac1dd5de3d7 | 人面桃花 相映 一逆光人像拍摄与反光板的运用 | 未知 | quark / other | 人像/姿态、用光/曝光；有成片可见映射 |
| paper-f49fbe284416d03a | 数码摄影构图技巧分析 | 2020 | baidu_wenku / journal_article | 构图/景深；有成片可见映射 |
| paper-8dd0460bf393f66f | 风光摄影进阶教程 | 未知 | cnki / other | 风光；有成片可见映射 |
| paper-8cb8113e94585b76 | 浅谈新闻摄影构图 | 1986 | cnki / article_like | 构图/景深、新闻/瞬间/取舍；代表阅读，未采纳映射 |
| paper-0c034f507791f0c9 | 人像摄影的技巧与处理探讨 | 2019 | quark / journal_article | 人像/姿态；有成片可见映射 |
| paper-fbdda3c84de06576 | 关于摄影曝光控制的意义 | 未知 | cnki / article_like | 用光/曝光；代表阅读，未采纳映射 |
| paper-47a102a310612721 | 浅谈人像摄影中的眼神光运用 | 2008 | quark / journal_article | 人像/姿态；有成片可见映射 |
| paper-482b717f8053eb54 | 人像摄影中双人美姿技巧 站姿1 | 未知 | cnki / other | 人像/姿态；有成片可见映射 |
| paper-a33fd135f10d62bd | 浅谈人像艺术摄影的姿态 | 1980 | cnki / other | 人像/姿态；代表阅读，未采纳映射 |
| paper-691ea9a6cd605198 | 人像摄影中不同场景的美姿设计(上) | 2010 | cnki / other | 人像/姿态；有成片可见映射 |
| paper-3814136d4d0ca1c8 | 室内人像摄影布光技巧 | 未知 | cnki / article_like | 人像/姿态；有成片可见映射 |
| paper-94c6246b7afd5eb5 | 解读新闻摄影中的不完整构图 | 2004 | cnki / journal_article | 构图/景深、新闻/瞬间/取舍；代表阅读，未采纳映射 |
| paper-feab4578695704ea | 掌握逆光人像摄影技巧 轻松拍出靓丽的逆光作品 | 2000 | cnki / other | 人像/姿态、用光/曝光；有成片可见映射 |
| paper-19b05b523a934efb | 外景人像摄影的用光 | 未知 | cnki / other | 人像/姿态、用光/曝光；有成片可见映射 |
| paper-1d56130f312d6505 | 风光摄影与组照 | 未知 | cnki / other | 风光；有成片可见映射 |
| paper-5b0a3d6918de2fb3 | 浅谈人像摄影的姿态设计 | 未知 | cnki / article_like | 人像/姿态；有成片可见映射 |
| paper-eb5bc9890b882810 | 浅谈人像摄影的技巧 | 2015 | baidu_wenku / journal_article | 人像/姿态；有成片可见映射 |
| paper-2d030497f8115976 | 新闻摄影抓拍的最佳时机 | 2000 | quark / other | 新闻/瞬间/取舍；有成片可见映射 |
| paper-9914005ed73dd174 | 黑白艺术人像摄影中的影调 | 未知 | quark / other | 人像/姿态；有成片可见映射 |
| paper-ce7b4be03668d983 | 谈现代影楼人像摄影的特征及实践 | 2007 | cnki / journal_article | 人像/姿态；有成片可见映射 |
| paper-258a7f07b3d54a71 | 人像摄影中不同场景的美姿设计（下） | 1979 | cnki / other | 人像/姿态；有成片可见映射 |
| paper-49f7f3d08a286c19 | 风光摄影作品的后期表现技巧（连载之16） | 未知 | cnki / other | 风光；有成片可见映射 |

最终 `git diff --check` 通过。只修改本任务授权文件；正文与日志仍在 `/tmp/corpus/papers/`，未接触 Eagle 图库、“未删减”、正式规则、ranking 或 signals；未提交、未 push。
