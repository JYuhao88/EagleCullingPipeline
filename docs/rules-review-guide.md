# 30 分钟规则审核指南

所有动作均为**建议，非决定**。输入 79 条候选，
建议合成 71 个审核主题（6 组，8 个别名）；
另统计 52 条正式规则。原文件保留。

## 审核方法与页面

启动服务后打开 http://127.0.0.1:43128/rules/review 。默认按优先级排序，可切换出现频次，结合来源、状态、aspect 筛选。先用 5 分钟检查下方 gate 例外，
再用 20 分钟每项约 40 秒审 Top 30，最后 5 分钟记录需测量与归并项。

每项先看转述与定位，再看例外及同组相邻帧：是否观察得到、是否影响同组选择、是否可能误杀？不确定就暂缓。measure 只是已有检查方式，代理测量不证明意图；本清单不新增阈值。建议批准保持原 hint，不能升级为 gate。

页面的“批准/修改/合并/删除”才写入已有决定格式，加载建议不会写决定。页面“合并”仅支持人像候选并入现有正式人像规则，**候选间及跨题材建议仅展示，不能通过该按钮执行**；请保留别名待后续实施，不要为完成清单逐条批准。
导出仍为草案，正式库不会改变；其他题材按页面已有独立草案下载。

现有小红书条目在页面属于只读参考；可核对建议与出处，不能点击批准。

## 排序口径

score = consistency + frequency + measurement + impact；consistency=30×(支持来源种类数−1)×(支持种类/全部种类)×source/(source+counterpoint)，逐项四舍五入；一致性为来源类型广度×支持占比启发式，不是科学置信度。frequency用原报告与已附条数最大值，20×log2(1+n)/log2(201)；measure=12，hybrid=6；gate=20，penalty=10，hint=0。例外不作反对票。

计数为聚合证据条数；supports单独计定位数，不当作独立观点。sourceTypeCount按video/book/course/paper/social；教师独立列来源。bySource计主出处聚合条数，supportCountsBySource展开支持出处，同一观点每来源计一次。

衣刀“期/段”是原报告下界（组内最大值），完整报告及档位对比在 JSON 的 frequencyReports。observed 是附带证据去重后的期、段、档位数；代表证据不能代替全量统计，重叠频次和档位不可直接求和。
缺失 kind 的内联证据与 issue/praise 计 source，但保留 originalKind。跨来源一致性只是审核顺序启发式，需人工检验条件是否一致。

## Top 30 待审

支持种类/全部种类；证据数为 source/exception/counterpoint；衣刀期/段为报告下界。表中来源与例外详情查 consolidated-review.json。

| 顺序 | 主条目 | 来源种类 | 证据数 S/E/C | 衣刀期/段 | 检查 / 影响 | 分数 / 建议 |
| --- | --- | --- | --- | --- | --- | --- |
| 1 | P-LIGHT-SHAPE 受光位置与明暗层次 | 5/5 | 269/2/1 | 79/242 | teacher / hint | 141 / 建议批准 |
| 2 | G-SUBJECT-HIERARCHY 主体与干扰的层级 | 5/5 | 154/1/1 | 59/122 | teacher / hint | 138 / 建议批准 |
| 3 | G-FRAMING-BALANCE 画幅分配与环境交代 | 5/5 | 150/2/2 | 63/125 | teacher / hint | 137 / 建议批准 |
| 4 | P-COLOR-INTENT 肤色与配色符合意图 | 4/4 | 161/0/0 | 61/141 | teacher / hint | 109 / 建议批准 |
| 5 | P-YD-INTERACTION 人物与物件互动 | 4/4 | 17/4/0 | 11/12 | teacher / hint | 102 / 建议批准 |
| 6 | P-YD-POSE-RESTRAINED 姿态拘谨 | 4/4 | 10/2/0 | 20/22 | teacher / hint | 102 / 建议批准 |
| 7 | P-YD-BG-DEPTH 空间纵深 | 4/4 | 7/0/0 | 16/19 | teacher / hint | 101 / 建议批准 |
| 8 | P-YD-GAZE-DIRECTION 视线意图 | 4/4 | 10/5/0 | 7/9 | teacher / hint | 100 / 建议批准 |
| 9 | P-YD-BG-SEPARATION 人物轮廓分离 | 4/4 | 10/0/1 | 43/66 | teacher / hint | 98 / 建议批准 |
| 10 | P-YD-MOTION-READABLE 动感加分 | 3/3 | 7/0/0 | 25/35 | teacher / hint | 74 / 建议批准 |
| 11 | P-YD-FACE-OCCLUDED 面部遮挡 | 3/3 | 12/9/0 | 6/8 | teacher / hint | 72 / 建议批准 |
| 12 | P-YD-POSE-COMPACT 肢体舒展 | 3/3 | 14/6/0 | 5/5 | teacher / hint | 71 / 建议批准 |
| 13 | P-YD-SHOULDER-NECK 肩颈轮廓 | 3/3 | 11/5/0 | 6/7 | teacher / hint | 71 / 建议批准 |
| 14 | P-YD-ACTION-MOMENT 动作完成瞬间 | 3/3 | 7/2/0 | 5/5 | teacher / hint | 69 / 建议批准 |
| 15 | P-YD-CATCHLIGHT 眼神光可信 | 3/3 | 6/2/0 | 2/5 | teacher / hint | 68 / 建议批准 |
| 16 | P-YD-BODY-PROPORTION 身形透视比例 | 3/3 | 13/3/1 | 14/14 | teacher / hint | 67 / 建议批准 |
| 17 | P-YD-MULTIPLE-SHADOWS 多重投影 | 3/3 | 6/0/0 | 4/4 | teacher / hint | 67 / 建议批准 |
| 18 | P-YD-PROFILE 剪影轮廓可读 | 3/3 | 5/0/0 | 2/2 | teacher / hint | 67 / 建议批准 |
| 19 | P-YD-NONFACE-HIGHLIGHTS 非面部高光细节 | 3/4 | 8/3/2 | 46/80 | measure / hint | 65 / 先验证测量 |
| 20 | P-YD-LIGHT-FLAT 光影空间感 | 3/4 | 6/8/0 | 30/37 | teacher / hint | 59 / 建议批准 |
| 21 | P-BOOK-ENVIRONMENT-CONTEXT 环境人像保留叙事背景 | 3/4 | 18/5/0 | 17/19 | teacher / hint | 57 / 建议归并 |
| 22 | P-YD-POSE-THEME 动作与情境 | 3/4 | 11/1/0 | 9/11 | teacher / hint | 55 / 建议批准 |
| 23 | P-YD-TILT 无意歪斜 | 2/3 | 5/3/0 | 53/90 | measure / hint | 49 / 先验证测量 |
| 24 | P-YD-SCENE-CONTRAST 场景光比 | 2/2 | 5/0/0 | 30/50 | teacher / hint | 45 / 建议批准 |
| 25 | P-YD-FACE-PERSPECTIVE 面部透视变形 | 2/2 | 6/0/0 | 27/36 | teacher / hint | 44 / 建议批准 |
| 26 | P-YD-SCENE-INTEGRATION 人物融入场景 | 2/2 | 5/0/0 | 23/29 | teacher / hint | 43 / 建议批准 |
| 27 | P-YD-HAIR-MOTION 发丝动态加分 | 2/2 | 5/0/0 | 19/23 | teacher / hint | 42 / 建议批准 |
| 28 | P-YD-NONFACE-SHADOWS 非面部暗部细节 | 2/3 | 5/1/0 | 9/13 | measure / hint | 42 / 先验证测量 |
| 29 | P-YD-SATURATION 饱和度过强 | 2/2 | 5/0/0 | 14/19 | teacher / hint | 41 / 建议批准 |
| 30 | G-BOOK-SEQUENCE-PACE 组照观看节奏 | 2/2 | 16/4/1 | 0/0 | teacher / hint | 40 / 建议批准 |

## 建议归并列表

- **P-BOOK-ENVIRONMENT-CONTEXT** ← P-YD-BG-BLACK、P-YD-BG-BLUR：均要求叙事环境可读；暗部与虚化分列子项，不推广到所有背景。
- **G-BOOK-STORY-FUNCTION** ← P-BOOK-EVENT-COVERAGE、G-COURSE-EDIT-JUSTIFICATION：均比较各帧独特贡献后去重；保留事件覆盖与相邻帧说明子项。
- **P-BOOK-GROUP-HEAD-LAYERS** ← P-COURSE-GROUP-HEAD-LAYERS：均复核合影头位高低与错位；保留逐人可读条件。
- **P-YD-TONAL-GRAY** ← L-WL-TONE-DEPTH：均复核明暗层级是否支持空间重点；跨题材保留柔和低反差例外。
- **P-BOOK-EXPRESSION-VARIETY** ← P-COURSE-POSE-SERIES：同组保留互补变化；表情与角位作为独立子项，非逐帧重复扣分。
- **P-YD-LIGHT-DIRECTION** ← L-WL-LIGHT-COHERENCE：均复核光向与局部受光可信关系；分别保留人像、风光适用范围。

归并仅减少审核主题，不删除子项。主 ID 优先选定义较完整或已有稳定引用的条目；全部成员定义、例外与来源保存在 members。姿态拘谨与表情自然只关联 P-POSE-WEIGHT / P-FACE-EXPRESSION，
不能把身体状态与脸部状态视为同一测量。表情变化与姿态序列归并后仍保留两个子项；事件叙事去重与合成源帧整组保留用途不同，后者不可并掉。手臂透视、身体比例、眼白、视线、群像状态与群像层次分别保留。

## 正式规则例外汇总

38 组、140 条去重 exception，全部条目在 JSON exceptionGroups.items；
以下每组 1–3 条代表。counterpoint 单独计数，未混入例外。来源定位均沿用现有数据，转述至多 40 字。无 exception 证据的正式规则仍有统计，但不列于此；规则自带 exceptions 不冒计成来源证据。

### P-EXPOSURE-INTENT 曝光服务于氛围（gate，10 条）

- 低调画面中人物可虚化，灯光成为中心 — book:photography-aesthetics-six-lectures · 第六讲／用光影营造意境美
- 人像肤色明度可随环境与表达目的变化 — book:ansel-negative · 章节17／Visualization and Image Values／段落7
- 熟悉环境中的儿童剪影可按轮廓表达保留 — book:photographing-children-babies · 章节27／#**Busy Kids**／段落9

### P-FACE-EYES 睁眼（gate，10 条）

- 睡眠婴儿肖像可保留闭眼状态 — book:children-portrait · 章节37／POSING TIPS BY AGE／段落3
- 有意闭眼是自画像的核心，不应误作眨眼淘汰 — book:why-focus-sample · 样章PDF第20–21页／Gavin Turk案例
- 闭眼依偎可支持可见的亲昵关系 — book:nyip-lower · PDF第89页／第21课／组合魅态摄影

### P-FACE-FOCUS 焦点在眼睛（gate，7 条）

- 表达梳妆动作时，焦点可在手而非眼 — book:photography-aesthetics-six-lectures · 第六讲／用摄影解读诗词的美
- 错落双人照可有意只突出前景一人 — book:digital-wedding · 章节80／#*Getting the Key Images*／段落28
- 柔焦与高反差可突出复合肖像的图形性质 — book:why-focus-sample · 样章PDF第17页／Second Beauty Composite

### S-FOCUS-INTENT 焦点服务于内容（gate，5 条）

- 人物可朦胧，灯光与环境成为主要表达 — book:photography-aesthetics-six-lectures · 第六讲／用光影营造意境美
- 朦胧建筑与人物可服务梦境式街头表达 — book:street-atlas · 章节222／TRENT PARKE／段落2
- 区域手动对焦可用于预判位置的抓拍 — book:street-52 · [p.367] 手动区域对焦

### S-EXPOSURE-CONTENT 关键内容可读（gate，3 条）

- 略欠曝形成剪影，可统一街道人群画面 — book:photography-aesthetics-six-lectures · 第六讲／用光影营造意境美
- 暗影与亮光可组织街景，不强求均匀可见 — book:street-atlas · 章节222／TRENT PARKE／段落2
- 画内小点光源溢出可正常，先看内容用途 — book:freeman-capturing-light · 章节78／GLOWING LIGHT Things Burning／段落2

### L-BLUR-CAMERA 区分相机抖动与长曝光（gate，2 条）

- 移动对象模糊而静物清楚可为有意表现 — book:understanding-exposure · 章节35／MOTOR DRIVES／段落14
- 有意相机运动可将稳定地景表现为短暂流动 — course:joel-meyerowitz · {"source":"materials-courses-meyerowitz","course":"joel-meyerowitz","episode":20,"episodeId":"materials-courses-meyerowitz-18abf9978780","start":244.94,"end":282.75}

### L-EXPOSURE-DETAIL 关键细节未不可恢复地裁切（gate，2 条）

- 小面积镜面高光可无细节，先核验其用途 — book:ansel-negative · 章节49／SUBJECT CONTRAST／段落4
- 故意过曝可形成风光表达，须先确认细节职责 — book:why-focus-sample · 样章PDF第7页／Introduction·Paul Graham简介

### L-FOCUS-REQUIRED 需要的焦平面清晰（gate，1 条）

- 焦点在窗框、窗外虚化可凝聚画面 — book:photography-aesthetics-six-lectures · 第一讲／知识之外的无言之美

### P-CROP-HAIRLINE 不切发际线（gate，1 条）

- 电影或时尚特写可裁至额头，仍需复核眉眼 — course:linhaiyin · {"source":"linhaiyin","course":"commercial-portrait","episode":5,"episodeId":"linhaiyin-bde73eeb0a60","start":1924.69,"end":1958.99}

### P-CROP-NECK 不切脖颈（gate，1 条）

- 眼部片段可独立成片，无须补齐锁骨或胸口 — book:photographers-eye-zh · PDF第59页／细节·洛特的眼睛

### P-CROP-WRIST 不切手腕和手指（gate，1 条）

- 手部近景以姿态与纹理成立，不要求手臂同框 — book:photographers-eye-zh · PDF第51–52页／细节·手与和服、让·考克多的手

### P-HAND-NATURAL 手自然、有交代（penalty，13 条）

- 轻握拳或持物可有意成立，先看动作用途 — book:digital-portrait · 章节89／Posing Your Subject／段落6
- 掌心迎镜可配合奔放动作，不必一律判错 — book:adler-posing · PDF第21页／导言／图I.6
- 自然张开的手指可轻触头脸，不按张指判爪状 — book:adler-boudoir · PDF第8页／姿势5／通用手部

### P-FACE-EXPRESSION 表情自然（penalty，10 条）

- 婴儿困倦或不笑的表情也可成立 — book:portrait-candid · 章节210／FOCUS ON THE EYES／段落4
- 认真、沉思、哭泣等神态也值得记录 — book:photographing-children-babies · 章节30／#**The Value of Other Moods**／段落2
- 松弛或面无表情的人像不必是过渡废片 — book:why-focus-sample · 样章PDF第7页及第18–19页／Introduction、Parr案例

### G-PROXY-BLUR 代理图清晰度需复核（hint，9 条）

- 虚实取舍可服务画面，不凭整图锐度拒绝 — book:photography-aesthetics-six-lectures · 第一讲／知识之外的无言之美
- 有意追随的运动模糊可成立，主体仍需可辨 — book:photographing-children-babies · 章节73／**Intentional Blur**／段落2
- 舞蹈慢门的运动模糊可用于表达动作 — book:digital-wedding · 章节61／*Fast Moves: Capturing High Action Moments*／段落29

### P-POSE-WEIGHT 重心与肩髋（hint，8 条）

- 正面平肩可形成稳定有力的肖像 — book:digital-portrait · 章节89／Posing Your Subject／段落2
- 正式合影可采用整齐静态的排列 — book:portrait-candid · 章节160／EXPLORE POSING TECHNIQUES／段落7
- 正式肖像可保持较直脊背与较方正肩线 — book:corrective-posing · 章节42／CHOOSE THE RIGHT STYLE／段落9

### P-BG-MERGER 背景不穿头（penalty，5 条）

- 有助理解主题的环境不必一律删除 — book:nyip-upper · [p.38] 第1课 1.4
- 树影跨越脸部仍可参与群像的明暗节奏 — book:photographers-eye-zh · PDF第150页／有利位置·莫斯科
- 背景图案有意呼应服装，可强化服装特征 — book:nyip-lower · PDF第48页／第20课／选择背景

### P-CROP-HEADROOM 头顶留白（penalty，5 条）

- 眼睛为主的近景可裁头，不强制头顶留白 — book:portrait-candid · 章节210／FOCUS ON THE EYES／段落3
- 近景可仅留帽子与部分脸来突出细节 — book:children-portrait · 章节38／POSING AIDS／段落9
- 紧凑近景有意切去部分头顶可成立 — book:kelby-natural-portrait · [p.109] 第6章 裁剪掉头顶部分

### S-MOMENT-ACTION 动作与关系在这一帧成立（penalty，5 条）

- 决定性时刻可由视觉形式成立，不必是戏剧高潮 — book:photographers-eye-excerpt · 导言摘录／Time·第5段
- 不同摄影师的必要瞬间不同，不设统一动作峰值 — book:magnum-streetwise · PDF第16页／前言·卡尔瓦观点（书内第12页）
- 平静弱瞬间也可在组照中承担意义 — course:magnum-street · {"source":"materials-course-texts","course":"magnum-street","episode":9,"episodeId":"magnum-street-1128638e1330","page":11}

### S-MOTION-INTENT 模糊有方向和用途（penalty，5 条）

- 主体清楚而背景拖曳可表达追随拍摄动感 — book:understanding-exposure · 章节35／MOTOR DRIVES／段落4
- 运动模糊可柔化奔跑跳跃的轮廓 — book:why-focus-sample · 样章PDF第6页／Introduction·Ryan McGinley简介
- 冻结擅长表现姿势，模糊擅长表现速度 — book:photographic-techniques-7 · PDF第289–291页／第八章第一节／动体效果

### P-POSE-LIMB-HIDDEN 避免断肢（penalty，4 条）

- 前景遮住部分腿部可为有意构图 — book:corrective-posing · 章节45／CONDENSING A POSE／段落14
- 后臂完整藏于身体后可成立，不要求四肢全露 — book:adler-50-poses · PDF第35页／姿势31
- 后侧手臂可完全藏起，避免只留来源不明的手 — book:valenzuela-posing-zh · PDF第161–162页／手部来源／图8.3–8.5

### P-COLOR-CAST 偏色需复核（hint，3 条）

- 灰中微青可营造冷意，不必强求中性 — book:photography-aesthetics-six-lectures · 第五讲／天青色里的“寂寞沙洲冷”
- 清冷意图可保留偏蓝环境或阴影 — course:liqiang · {"source":"liqiang","course":"liqiang-korean-lighting","episode":3,"episodeId":"liqiang-adac4fd7925b","start":280.41,"end":312}
- 室内冷暖光并存可勾勒人物线条与氛围 — course:linhaiyin · {"source":"linhaiyin","course":"commercial-portrait","episode":12,"episodeId":"linhaiyin-45bbb22ed4a1","start":1134.65,"end":1174.84}

### P-SUBJECT-PLACEMENT 主体大小与位置（hint，3 条）

- 人物可作为小符号，服务整体意境 — book:photography-aesthetics-six-lectures · 第四讲／构图里的留白
- 对称姿态与场景可支持居中构图 — book:master-guide · 章节43／Common Problems in Composition／段落4
- 放射线效果中主体居中可强化视觉表达 — book:photographic-techniques-7 · PDF第294页／第八章第一节／变焦拍摄

### S-OCCLUSION-INTENT 遮挡服务于观看（penalty，3 条）

- 水面反光叠合现实与倒影，可营造虚实层次 — book:photography-aesthetics-six-lectures · 第三讲／光对画面的影响
- 名义主体的局部遮挡可重排观看重点 — book:photographers-eye-zh · PDF第129页／有利位置·主题说明
- 遮头与网影可构成有意复杂表达 — course:joel-meyerowitz · {"source":"materials-courses-meyerowitz","course":"joel-meyerowitz","episode":8,"episodeId":"materials-courses-meyerowitz-2a8dfdd4cae1","start":222.58,"end":247.18}

### S-TILT-INTENT 倾斜有视觉作用（hint，3 条）

- 倒影可翻转呈现，先辨认意图再检查方向 — book:photography-aesthetics-six-lectures · 第二讲／练习驾驭定焦镜头，是训练观察力的基本功
- 倾斜线条可有构图用途，先区分意图 — book:freeman-vision · 章节58／STYLES OF COMPOSITION／段落3
- 斜向车身与背景拖影共同表现速度 — book:photographers-eye-zh · PDF第88页／边框·巴黎汽车俱乐部大奖赛

### L-HORIZON-PLACEMENT 地平线位置服务于内容（hint，2 条）

- 岸景与水中倒影可采用居中地平线 — book:photographic-techniques-7 · PDF第140页／第四章第二节／三分法
- 居中地平线可作为同景光色比较的稳定结构 — course:joel-meyerowitz · {"source":"materials-courses-meyerowitz","course":"joel-meyerowitz","episode":10,"episodeId":"materials-courses-meyerowitz-762e28e145e2","start":667.06,"end":710.78}

### L-NATURAL-COLOR 色彩与处理痕迹（penalty，2 条）

- 少量调色可协调场景，不必照搬自然色 — book:photography-aesthetics-six-lectures · 第三讲／光对画面的影响
- 雨雪雾中的淡雅色彩也可形成有效表达 — paper:paper-49f7f3d08a286c19 · 段落6／柔和色彩的运用

### P-CROP-TIER 景别档位（hint，2 条）

- 收窄处的裁切可保留曲线，不只按固定像幅档位 — book:adler-posing · PDF第284–285页／曲线／图8.32–8.35
- 双人裁成头部重点可改善可见身体比例失衡 — book:valenzuela-posing-zh · PDF第211页／双人比例／图12.4–12.5

### S-BACKGROUND-MERGER 背景粘连是否损害关系（penalty，2 条）

- 人物上方图形的色彩呼应可增强环境肖像 — course:joel-meyerowitz · {"source":"materials-courses-meyerowitz","course":"joel-meyerowitz","episode":4,"episodeId":"materials-courses-meyerowitz-b8cced06dde3","start":369.61,"end":400.35}
- 两个人头的叠合可形成有意雕塑感 — course:joel-meyerowitz · {"source":"materials-courses-meyerowitz","course":"joel-meyerowitz","episode":21,"episodeId":"materials-courses-meyerowitz-cde50d6eb843","start":575.87,"end":590.77}

### S-EDGE-CONTENT 画面边缘有交代（penalty，2 条）

- 陪体不必完整，不能为完整而削弱主体 — paper:paper-3cbe84f8cab60c5a · 段落7
- 新闻画面完整可指意义完整，而非外形全貌 — paper:paper-ea232b406161d1a4 · 段落9

### S-LAYERS-SEPARATION 层次可读（penalty，2 条）

- 互不相关的事件可由同一景框建立联系 — course:joel-meyerowitz · {"source":"materials-courses-meyerowitz","course":"joel-meyerowitz","episode":4,"episodeId":"materials-courses-meyerowitz-b8cced06dde3","start":148.36,"end":179.12}
- 前排人群可增加层次，不必都视为背景遮挡 — course:joel-meyerowitz · {"source":"materials-courses-meyerowitz","course":"joel-meyerowitz","episode":8,"episodeId":"materials-courses-meyerowitz-2a8dfdd4cae1","start":522.38,"end":544.08}

### S-NARRATIVE-EVIDENCE 关系有画面证据（hint，2 条）

- 无人组照也可借环境与生活遗留细节承载主题 — book:nyip-lower · PDF第433–434页／第30课／韦尔费尔岛图片故事
- 可见细节明确，照片意义仍可保持多义 — course:joel-meyerowitz · {"source":"materials-courses-meyerowitz","course":"joel-meyerowitz","episode":3,"episodeId":"materials-courses-meyerowitz-df06f789ad55","start":447.54,"end":480.2}

### G-EDGE-GRADIENT 边缘强对比需复核（hint，1 条）

- 框景可组织观看，边缘强线条非必然干扰 — book:photography-aesthetics-six-lectures · 第二讲／50mm焦距，进退自如

### L-FOREGROUND-ROLE 前景有作用（penalty，1 条）

- 枝干前景可遮挡部分建筑并引导观看 — book:photography-aesthetics-six-lectures · 第一讲／知识之外的无言之美

### L-LIGHT-INTENT 光线服务于意图（hint，1 条）

- 顶光或柔和光仍可有用途，不限定黄金时段 — paper:paper-09e3480ff75dbc24 · 段落15／5-2-4 中午的光线

### L-SEQUENCE-PRESERVE 合成序列整组保留（hint，1 条）

- 风光组照可保留不同视角，按整体用途复核 — paper:paper-1d56130f312d6505 · 段落29／景深对焦，评价测光

### P-HAND-WIDEANGLE 广角近距离的手脚放大（penalty，1 条）

- 鞋袜承担题材时，近处腿脚可有意成为重点 — book:valenzuela-posing-zh · PDF第199页／第一接触点／图11.4说明

### S-EYES-EXPRESSION 表情属于瞬间（hint，1 条）

- 遭水喷脸时闭眼退缩可成为有效的幽默瞬间 — book:nyip-lower · PDF第420页／第30课／专题摄影

### S-NOISE-STYLE 颗粒与粗粝是风格变量（hint，1 条）

- 放大颗粒是人物项目的表现方式，不是直接废片 — book:magnum-streetwise · PDF第311页／特伦特·帕克·相机是上帝（书内第307页）

## 复现

离线执行 `node scripts/consolidate-rules-review.mjs`，只重建本指南与 consolidated-review.json。证据新增后应重新生成；不读取或写入 decisions.json。
