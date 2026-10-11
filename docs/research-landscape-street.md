# 武林风光／街拍规则候选归纳（2026-10-10）

本轮仅新增审核候选、出处统计与审核接入，未改 landscape/street/general 正式规则、ranking 或 signals。无外部模型调用，无嵌套 codex exec。仓库仅保存不超过 40 字的点评转述、定位与归纳统计；视频、完整转写和未删减资料未导入或修改。

## 数据规模与统计口径

- 输入：`/tmp/w3-genres-data/wulin/extracted/<bvid>/*.json`，40 期、2591 个片段。
- 去重点评：3697 条；625 条已有非空 ruleId（16.91%），3072 条未映射（83.09%）。实际快照的未映射比例高于任务描述的约七成。
- 625 条原映射出处覆盖 22 条现有规则，完整存入 `src/rules/candidates/wulin-evidence.json`；候选保存 44 条代表出处。
- 输入快照摘要（排序相对路径和逐文件 SHA-256）：`fdd18c03afddb736c57f1ec8fd924f376ac04c9ba4727ea70b7674afc3f29779`。这与备份的规范清单摘要口径不同，不应混用。
- 支持期数按 bvid 去重，支持段数按 `(bvid, segment.index)` 去重。同段可既有批评又有赞扬，positive + negative 可能大于 segments。跨片段重复照片也可能被多次点评，段数不等于独立照片数。
- issue/praise 决定例子极性，不由 verdict 推断规则违反；全部候选为 `proposed`、`hint`，人工看成片判断，不增设信号或阈值。

| 点评分类 | 条数 |
| --- | ---: |
| 原提取已映射 | 625 |
| 具体候选子主题 | 301 |
| 宽主题观察，未直接升级为规则 | 1244 |
| 后期／拍摄计划／交付／系列／器材 | 248 |
| 笼统赞扬或未说明具体问题 | 432 |
| 语境不足或尚不能可靠合并 | 847 |

以上分类穷尽本快照，但不代表全部转述已经获得可执行规则。847 条仍明确待复核；1244 条宽主题观察只用于统计，不能误读为新增规则支持。

## 编码本与复现

语义候选由逐条阅读短转述后保守合并，精确文本索引冻结归属；文本检索辅助建立宽主题观察编码，宽编码不自动生成规则。编码本：`landscape-street-synthesis-codebook.json`；精确转述索引：`landscape-street-synthesis-index.json`，均在 `src/rules/candidates/`。

| 主题 | 具体子主题 |
| --- | --- |
| 构图与内容 | 观看停留点、前景纹理秩序、近景质感、中景空间缓冲 |
| 画幅与边界 | 天空内容作用、倒影及影子边界 |
| 光影 | 影调层级、局部光线逻辑 |
| 色彩 | 分区与环境呼应、风格例外 |
| 动静 | 流云、流水、光轨与静景的方向及形态 |
| 人文 | 可见细节、手势和互动支撑表达 |
| 宽观察 | 焦点、画质、曝光、几何、色彩、边界、构图、氛围 |
| 非选片 | 后期操作、拍摄计划、交付、组照用途、器材条件 |

生成器读取精确索引后只做验证、去重和统计。未知转述、未知映射规则、超过 40 字、危险帧路径或段外时间会报错；不会自动用关键词填补新语义。候选必须至少 3 期，最多 4 条出处，优先正反例与跨期；宽观察已被现有规则覆盖或过于混合，因此只保留计数。

```sh
python3 src/rules/candidates/synthesize-landscape-street.py --data-root /tmp/w3-genres-data/wulin
node --test test/wulin-synthesis.test.js test/rules-review.test.js
python3 -m unittest discover -s ml/references -p test_backup_wulin_extracted.py -v
```

## Top 具体观点

共 10 条 L、1 条 S。部分是对现有规则的更细检查问题，不表示需要增加同权重的独立规则；`relatedRules` 用于后续合并审核。频率仅计入精确索引中已纳入该子主题的未映射转述，因此是保守下界，不是词频估算。

| ID | 观点 | 支持期数 | 支持段数 |
| --- | --- | ---: | ---: |
| L-WL-ANCHOR | 观看路径有停留点 | 21 | 57 |
| L-WL-TONE-DEPTH | 影调层级服务空间与重点 | 20 | 33 |
| L-WL-NEAR-TEXTURE | 近景质感承接远景气势 | 18 | 24 |
| L-WL-DEPTH-BUFFER | 前中后景留有空间缓冲 | 17 | 35 |
| L-WL-MOTION-STATIC | 动静对照有形态与方向 | 17 | 30 |
| L-WL-REFLECTION-ROLE | 倒影与影子保留叙事作用 | 15 | 22 |
| S-WL-INTERACTION | 可见细节与互动支撑人文表达 | 12 | 20 |
| L-WL-FOREGROUND-ORDER | 前景纹理有秩序 | 12 | 15 |
| L-WL-COLOR-COHERENCE | 色彩分区与环境相互呼应 | 11 | 21 |
| L-WL-LIGHT-COHERENCE | 局部光线关系自洽 | 11 | 21 |
| L-WL-SKY-ROLE | 天空留白有内容作用 | 6 | 6 |

现有规则原映射 Top：

| 规则 | 期数 | 段数 | 正向段 | 反向段 |
| --- | ---: | ---: | ---: | ---: |
| L-FOREGROUND-ROLE | 32 | 94 | 71 | 23 |
| L-LIGHT-INTENT | 31 | 88 | 69 | 21 |
| L-NATURAL-COLOR | 31 | 138 | 3 | 135 |
| L-HORIZON-PLACEMENT | 30 | 88 | 8 | 81 |
| L-LEADING-LINES | 25 | 56 | 51 | 5 |
| L-EDGE-DISTRACTION | 16 | 29 | 0 | 29 |

没有正向例子的规则保留零计数，不制造“反例”。赞扬也只表明该段出现支持表达，不能证明其满足所有规则。

非选片主题只计数，无 evidence[]：

| 主题 | 点评条数 | 期数 | 段数 |
| --- | ---: | ---: | ---: |
| 后期操作与方案 | 152 | 32 | 135 |
| 拍摄时段与机位计划 | 68 | 25 | 65 |
| 投稿尺寸与交付 | 13 | 11 | 12 |
| 组照与创作用途 | 12 | 7 | 10 |
| 器材与拍摄条件 | 3 | 3 | 3 |

可见处理缺陷（白边、光色不协调、断层）与纯处理方案区别对待：前者可作为成片观察，后者只记流程计数。不能由成片证明快门、现场光色或 RAW 恢复能力。

## 与书籍／论文的一致与张力

核对的是本仓库 `book-evidence.json`、`paper-evidence.json` 已整理的短证据，不是重新阅读完整原书或验证论文质量。完整定位与来源 slug 保存在 codebook、候选 crossEvidence 和 wulin-evidence 的 crossEvidence。

- **天空占比**：武林的原映射覆盖 30 期／88 段，常建议少留天空，也有天空值得保留及留白成立的例子。《摄影美学六讲》第四讲／构图法则之结构平衡允许比例随视觉平衡变化；Master Guide 章节43／段落16的三分线建议被标作受意图限制的 counterpoint。结论是一致于内容优先，不能得出固定天空面积或“居中必错”。
- **自然色彩**：原映射 31 期／138 段，以偏色批评为主。《摄影美学六讲》第三讲／光对画面的影响允许少量调色；论文 `paper-7709fb61f58e199b` 段落7及其支持材料强调主次与统一。武林也肯定协调紫色、高饱和风格。张力在偏好自然与允许风格化之间，应提示不协调或突兀，而不是证明现场失真。
- **边缘干扰与完整性**：原映射风光边缘 16 期／29 段，多为批评。论文 `paper-3cbe84f8cab60c5a` 段落7允许陪体不完整，`paper-ea232b406161d1a4` 段落9强调意义完整；因此倒影／影子截断只有损害表达时才提示，不能把“所有物体必须完整”作为硬门槛。
- **前景与空间**：原映射 32 期／94 段。论文 `paper-b7bc16c4801a55d3` 段落13支持尺度和空间，`paper-5f14b6d264dad77a` 段落6警惕柳枝杂乱；《摄影美学六讲》第一讲／知识之外的无言之美允许枝干遮挡建筑并引导观看。支持前景有作用，保留框景／自然杂乱／无前景的例外。
- **光线与人文**：《摄影美学六讲》第三讲／摄影用光的误区允许阴雨柔光；论文 `paper-09e3480ff75dbc24` 段落15允许顶光用途。Freeman Vision 章节55／段落16、24强调多个好瞬间与手势差异。不能据此固定黄金时段、所有细节可见或只留一个自然笑容。

## 正式规则修改建议（未实施）

1. 将 SKY-ROLE 作为 L-HORIZON-PLACEMENT 的具体检查问题，并保留云层主题、大天空、对称和留白例外；原映射已有 91 条点评，不再把这部分重复算作新候选支持。
2. 将 FOREGROUND-ORDER／NEAR-TEXTURE／DEPTH-BUFFER 作为 L-FOREGROUND-ROLE 的子问题，避免新增同义计分项。
3. ANCHOR 提醒大场景与线条是否有落脚点；与 L-VISUAL-INTENT／L-LEADING-LINES 合并审核，保留抽象与类型学。
4. TONE-DEPTH／LIGHT-COHERENCE 与 L-LIGHT-INTENT 联审；禁止把全部可见细节、均匀明亮或自然现场作为默认审美。
5. COLOR-COHERENCE 补充 L-NATURAL-COLOR 的协调与风格例外；不添加饱和度阈值。
6. REFLECTION-ROLE／MOTION-STATIC 留作具体提示，保留碎片倒影、平静水面、冻结浪花等选择。
7. S-WL-INTERACTION 是人文素材向街拍迁移的候选，优先给 S-NARRATIVE-EVIDENCE／S-MOMENT-ACTION 补出处；不要当作街拍专属普适规律。

## 审核页和代表帧

- `/rules/data` 返回 `wulinCandidates`、`wulinEvidence`，并将现有 landscape/street/general 的武林出处附到只读 referenceRules。
- 来源下拉增加“武林”，可与状态及方面叠加。保留一刀证据；批准的武林候选按库导出 wulinDrafts，禁止合并进人像正式规则。
- 107 张去重代表帧：35 张从本地 QA HTML 仅解出内嵌 JPEG（未复制文字），72 张由独立 1 CPU／0 GPU 作业从 Ceph 定位读取并校验 SHA-256。帧取回作业已删除，无 package。
- 位置 `data/rules-review/frames/<bvid>/<nnnn>.jpg`，共 7,596,761 字节；`.gitignore` 的 `data/` 已覆盖，`git check-ignore` 确认。仓库只存 `wulin-frame-manifest.json` 的路径、尺寸与 SHA-256，帧不进 git。
- 使用实际仓库 router 对 107 个 `/rules/frames/...` 响应逐一比对 SHA-256，全部成功；DOM 测试覆盖筛选、图片和时间链接。另抽看了影调、人文、天空三组共12张拼图。未进行真实浏览器完整人工交互验收。

## 局限

- 武林素材以风光／城市风光为主；街拍、人文与环境肖像边界混合。1 条 S 候选只能表示迁移观察，无法证明街拍样本覆盖。
- 单一点评者与投稿筛选偏差明显；跨期重复不等于独立摄影师或普遍审美，频率不构成因果或效果指标。
- 短转述损失意图与比较关系；精确文本索引无法处理上下文中同一句话的不同含义。宽观察与847条未决保留待复核，宁缺毋滥。
- 代表帧来自段级抽帧，可能含比较图、修图软件界面和不同版本，未保证恰好对应点评 t 的局部细节；点击时间链接再核验。代理帧不能证明原图合焦、RAW恢复或现场真实性。
- 只有少量代表帧经过目视抽检，不能声称全部2591段完成图像级验收。

## 备份

独立工具 `ml/references/backup_wulin_extracted.py` 使用专有小 ZIP package 和唯一作业 ID，避开 upload_to_ceph.py 的全局锁与 `/tmp/ceph-upload/`。只提交 CPU=1、GPU=0；本轮同时存在备份与取帧时自有作业并发至多2。只删除自有作业和 package，不操作 liqiang/linhaiyin 上传进程。

```sh
python3 ml/references/backup_wulin_extracted.py --receipt /tmp/w4-wulin-backup-receipt.json
```

备份目标：`<CEPH_ROOT>/references/wulin/extracted/`。清单为2591个JSON／2,894,175字节，规范manifest SHA-256：`c05020975f5b8cebc923dcfead2f014c7604e05aa5e0a061359f9e5e6755f48d`。最终远端校验和资源清理状态见下方结果。

备份成功完成。远端逐文件 SHA-256 与规范清单摘要均一致；两个备份/清理作业串行执行，均1 CPU／0 GPU，结束后删除。独立 package 已验证不存在，自有备份作业列表为空。元数据回执：`ml/references/wulin-extracted-backup-receipt.json`；无需用户稍后补执行。包 SHA-256：`ac1e69ee5effe986dd4cc2805d810891ba325ca716199d29a2e7c733c6dc822a`。

## 验证结果

- `node --test test/wulin-synthesis.test.js test/rules-review.test.js`：9/9通过（归纳3、审核6）。
- Python 独立备份测试：3/3通过，覆盖允许清单、输入变化、空目录／符号链接、远端摘要及已有冲突文件。
- `npm test -- --test-skip-pattern='fixture face detection recall|fixture grouping reaches'`：270通过、0失败、1跳过（271个测试）。初跑新增代码行长失败，修正后复跑通过。
- `git diff --check` 通过；未提交、未 push。
