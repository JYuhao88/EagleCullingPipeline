# 人像评估：从「只看脸」到手、体态和裁切（2026-10-10）

## 1. 现状

人像相关的信号目前只有：人脸数、闭眼、整图清晰度、曝光、TOPIQ 技术质量。审阅页同组两张（如 R0011321 与 R0011322）在手的位置、身体角度、腿部裁切位置上明显不同，但分数差异几乎全部来自曝光（99 vs 81）。汕头评估里人脸数和未闭眼是仅有的正相关信号，曝光和技术质量反而负相关，见 [eval-shantou-20260718.md](eval-shantou-20260718.md)。

## 2. 要补的信号

以全身关键点（身体 17 + 脚 6 + 脸 68 + 双手 42 = 133 点）为基础，大部分规则都能直接计算。

### 2.1 裁切（硬规则，适合做门槛和解释）

来自人像构图的通用规则：脆弱部位不可裁切。

| 画面边缘落在 | 判定 |
|---|---|
| 头顶上方留 1–2 拳（约 0.3–0.6 个头高） | 好 |
| 发际线、脖颈 | 差 |
| 胸口上下（三分人像）、臀部以上（半身）、大腿上（七分）、全身含完整脚 | 好 |
| 手腕、手指、肘、膝盖、脚踝、半只脚 | 差 |

实现：对每个关节点，计算它到四条画面边缘的距离（以头高归一化）。关节点在画外或紧贴边缘，而其相邻关节在画内，就记为「在该关节处裁切」。输出裁切位置和档位（三分 / 半身 / 七分 / 全身 / 坏切），审阅页直接显示「裁在膝盖」这类理由。左右边缘同理，检查手和肘有没有被切。

### 2.2 手（「手是人的第二表情」）

- 手是否可见、是否被画面边缘或其他物体截断；
- 手指关键点的置信度和展开程度：攥拳、只露半截、手指粘连等都容易显得僵；
- 手的位置：靠近脸、插兜、扶物、叉腰等常见摆姿可以作为特征，由用户偏好决定好坏，不预设；
- 广角近距离时手和脚的透视放大（这批汕头用 16-35mm）。

### 2.3 体态

- 肩线和髋线的倾斜与相对角度：重心偏移（对立式站姿、S 形）通常比双肩水平正对镜头更自然；
- 头部偏转、下巴角度、视线方向（是否看镜头）；
- 躯干前倾或后仰；
- 腿长比例：脚是否靠近画面底边、机位高低导致的腿部压缩或拉长；
- 四肢是否被身体或画框挡住，形成「断肢」。

### 2.4 脸（在现有基础上补全）

表情（笑、自然、半张嘴）、视线，以及原生分辨率下的眼部对焦，见 todo「原生分辨率对焦」。

### 2.5 背景与主体关系

头后有没有杆子或线条穿过、主体在画面中的位置、地平线倾斜。这部分用显著性图和直线检测，优先级低于前几项。

## 3. 规则与学习的分工

- **规则只用来做门槛和解释**：坏切、手被截、闭眼、焦点不在眼睛上。这类问题摄影师几乎都会拒绝。规则必须允许按类别关闭，因为街拍、创意人像会刻意破坏规则。
- **偏好用学习**：同为合格的帧，手放哪、看不看镜头、要明亮还是氛围，交给 L1 偏好头从用户的选择里学习（见 [research-scale-learning.md](research-scale-learning.md) §4）。手、体态、裁切的特征作为偏好头的输入，比现在只有 5 个技术分强得多。
- 真值和测试按 [test-plan.md](test-plan.md) 执行，新增信号要单独报告分项 AUC。

## 4. 模型选型

| 方案 | 关键点 | 运行 | 许可 | 备注 |
|---|---|---|---|---|
| RTMW / DWPose（rtmlib） | 全身 133 点（含手、脸、脚） | ONNX，CPU 可跑 | Apache-2.0 | 首选：一次推理覆盖身体、手和脸，能接入现有 `onnx_worker.py` |
| MediaPipe Pose + Hand Landmarker | 身体 33 点 + 每只手 21 点 | CPU | Apache-2.0 | 已用 MediaPipe 做人脸；需要两次推理，多人场景较弱 |
| ViTPose | 身体 17 点（全身版 133 点） | 需要 GPU 才快 | Apache-2.0 | 精度高，适合在 Ray 上离线做真值核对 |

先用汕头样片做探针：抽 50 张，比较 RTMW 与 MediaPipe 的手部关键点在夜景下的稳定性，以及单张耗时（预算：单张 ≤ 150 ms，仍用 nice 和并发 2）。

## 5. 参考来源的优先级

1. **摄影师本人的选择**：唯一能决定权重的依据。
2. **有人类判断的数据集**：构图（CADB）、裁切（GAIC、FCDB、CPC）、属性美学（AADB、PARA）、个性化（PARA、FLICKR-AES）。用来预训练和校准。
3. **论文里的方法**：姿态感知构图、人像裁切、美学点评模型。
4. **专业摄影书籍和教程**：适合列出规则清单、给 UI 的理由措辞，但不能告诉我们规则的权重，也不知道摄影师何时会故意破坏规则。可以让多模态大模型带着这些规则做离线点评老师，而不是直接作为打分依据。

## 6. 论文库补检

之前的 12 个检索主题偏向选片、美学模型和偏好学习，没有覆盖姿态、裁切和拍摄技巧。2026-10-10 新增 5 个主题（姿态体态、人像裁切取景、拍摄技巧、以人为中心的美学、美学点评），连同人脸质量、美学属性两个旧主题一起，在 Ray 上重扫英文全量 head index（1.24 亿条，401 个任务，493 秒）。脚本：`ml/research/search_corpus_facets.py`（`FACETS_ONLY` / `FACETS_TAG` 环境变量）；原始命中在 Ceph `research/facets-portrait-technique/`。

| 主题 | 去噪后命中 | 噪声来源 |
|---|---:|---|
| 姿态体态 | 4429 | 绝大多数是姿态估计、手势识别、人体成分，不涉及美学 |
| 人像裁切取景 | 2847 | 新闻「框架」分析占多数；自动裁切论文集中且质量高 |
| 拍摄技巧 | 1012 | 科研摄影技术（显微、航拍）占多数；有少量专业摄影书和教程 |
| 人像/人脸质量 | 2809 | 牙科微笑美学、人脸识别质量占多数 |
| 以人为中心的美学 | 88 | 人文类摄影评论较多 |
| 美学点评 | 59 | 哲学美学较多 |

**结论**：直接给「姿态好不好看」打分的研究很少；裁切和构图研究成熟，有大规模人类标注数据；美学点评数据集可以作为多模态模型的老师。论文库里也收有专业摄影书（如 *Master Guide for Professional Photographers*），可以从中提取规则清单。

### 6.1 精选

姿态与人像：
- Data-driven Suggestions for Portrait Posing：用数据给人像摆姿建议，最接近「体态评分」。
- Aesthetic Composition in Portrait Photography：人像构图规则的量化。
- HumanAesExpert: Advancing a Multi-Modality Foundation Model for Human Image Aesthetic Assessment：专门针对人物图像的美学评估，含姿态、身材比例、服装等维度。
- Aesthetic Quality Assessment of Headshots；The Beauty of Capturing Faces: Rating the Quality of Digital Portraits；An Image Quality Assessment Dataset for Portraits（PIQ23）。
- All Smiles: Automatic Photo Enhancement by Facial Expression Analysis；Discriminating genuine and fake smiles：表情选帧，可直接用于连拍组。
- Learning Face Image Quality from Human Assessments。

裁切与构图：
- Image Composition Assessment with Saliency-augmented Multi-pattern Pooling（CADB 构图数据集）。
- Reliable and Efficient Image Cropping: A Grid Anchor based Approach（GAIC）；Listwise View Ranking for Image Cropping；Rethinking Image Cropping: Exploring Diverse Compositions from Global Views；ProCrop: Learning Aesthetic Image Cropping from Professional Compositions；Carousel（多目标高分辨率裁切数据集）。
- 用法：不是去裁图，而是评估「现有画框」在候选框排序中的位置；画框远差于最优候选，说明构图或裁切有问题。

点评与拍摄指导：
- Understanding Aesthetics with Language: A Photo Critique Dataset for Aesthetic Assessment；Aesthetic Critiques Generation for Photos（PCCD）；Aesthetic Attributes Assessment of Images with AMANv2 and DPC-CaptionsV2；Towards Personalized Aesthetic Image Caption。
- Advanced Aesthetic Reasoning with Relative-Absolute Policy Optimization：多模态大模型的美学推理。
- Enhancing Amateur Photography: A Deep Learning Mobile Application for Real-Time Aesthetic Feedback。

书籍与教程类（规则来源）：*Master Guide for Professional Photographers*；*Secrets of Indoor and Outdoor Model Photography*（John Kelly）；Summary of Commercial Photography Skills in the Context of Visual Communication；Style and Pose Wedding Photography Through Single Lighting。

### 6.2 检索的局限

- 只扫了英文 title + 正文开头；中文语料还没有建立 head index，中文摄影教程类内容基本没覆盖。
- 词表匹配对「composition」「framing」「skeleton」这类多义词噪声很大。下一步用向量检索（标题和摘要的 embedding），按上面精选论文做种子扩展引用。

## 7. 实现与实测（W1-C，2026-10-10）

### 7.1 实现边界与契约

新增 `python_worker/pose_worker.py`、`src/core/pose.js`、`signals.js`、`rules-engine.js` 和 `scripts/pose-qa.mjs`。流水线写入可选 `UnitResult.signals`、`verdicts`；旧结果仍可校验。排序没有改动。检测器先处理代理图，只有检测到人体才调用 RTMW；无人图保存空 persons，规则为 `na`。人脸框用于主体选择的支持项，不将人脸框外推成虚构的人体框。

模型均从本地 `models/pose/` 读取，不走 rtmlib 的下载入口，没有安装新包。YOLOX 使用 `yolox_m_8xb8-300e_humanart-c2c7a14a.onnx`、640×640 输入；导出模型包含 NMS，rtmlib 对其保留检测分数 >0.3 的框。RTMW 使用 `rtmw-dw-x-l_simcc-cocktail14_270e-256x192_20231122.onnx`（balanced，默认）或 `rtmw-dw-x-l_simcc-cocktail14_270e-384x288_20231122.onnx`（performance）。133 点包含 17 身体、6 脚、68 脸、42 手。人物 score 是身体 17 点的平均置信度截到 [0,1]；主体按框面积 × 居中系数 × score 选择，框内存在已检测人脸时乘 1.2。所有人物都保留，规则仅评估主体。

Python 常驻 JSONL 进程每个只加载一次模型；Node 池最多两个进程，支持取消和超时（默认 300000 ms，空闲 30000 ms 后退出），流水线结束关闭池。每个 ORT session 的 intra/inter-op 线程数均为 1。Provider 配置顺序为 DirectML → CUDA → CoreML → CPU，失败转 CPU，`UnitResult.pose` 记录实际配置的 provider、两模型 provider 列表、模式、耗时与回退原因。这是 session 的实际 provider 配置，不代表每个算子都由加速器执行。Windows/DirectML 尚未实机验证。

指纹为 `analysis-v5-pose-signals`，含模型模式/provider/本地模型路径配置键；测量阶段另用 `signals-v2-edge-validity:portrait@0.1.0`。旧测量键重跑姿态，不能复用旧 signals；重跑前删除旧测量，失败则省略 signals 并给 na，避免超时残留旧结果。已有指标阶段可以复用。未修改 results-store、ranking、plugin 或 server。

### 7.2 阈值与假设

- 可靠点阈值为 0.3；邻关节必须可靠且在画内。关节距边缘严格 <0.15 头高时记录，可靠画外点也按契约记录；低分但非零点只在边缘窄带参与判断，远处低分预测不定位为关节坏切。
- 发际线不是 RTMW 的点：眉心取 COCO WholeBody 点 44/45 的可靠均值，下巴为点 31；发际线沿眉心远离下巴方向外推 0.65 倍眉心—下巴向量。头高为下巴到该估计位置的纵向距离。只有 0.015–0.8 代理图高度的头高参与裁切测量。发型体积、帽子、强烈偏头均可能破坏假设，不能把这个位置当真实头顶。
- 横向距边和肩髋角度按代理图宽高比校正。肩/髋线按画面左→右方向测角，顺时针为正；肩髋夹角为两条无方向直线的较小夹角。
- 针对 RTMW 将画外下肢挤到下沿的现象，加入有效性检查：髋/膝/踝可靠且在画内，膝 y≥0.85、踝 y≥0.9、踝不比膝向上超过 0.05 图高、大腿投影长 >0.05 图高，而小腿投影长 <大腿的 40%，则膝/踝/脚测量视为不可观察。输出仍保留原模型分数，相关规则 `na`。此检查也可能保守地过滤真实透视缩短或屈腿，不能据此判姿态好坏。
- full 要求双踝和六脚点都可靠、画内且未触发上述有效性检查。肩—髋区间前 55% 为 chest，后段为 waist，髋—膝间为 thigh；下沿距膝 <0.15 头高为 knee-cut。没有足够区间信息时省略景别。
- 原生眼睛对焦、相机对焦点、透视缩短、肢体遮挡、人脸曝光仍为 `na`，不使用整图指标代替。闭眼只使用匹配主体且 `eyesAssessed=true` 的人脸。肩髋规则库没有 pass/violate 阈值，因此输出角度和 `warn`，不发明审美阈值。这些规则的测试覆盖 `na`/`warn`，不能为了「每条规则都有 pass/violate」伪造结论。

### 7.3 模型与耗时

同一批 8 张有脸的汕头图（每张检测到 2–13 人），CPU balanced 平均 2313.38 ms/张，performance 3314.26 ms/张；全部主体关键点平均坐标差约 0.003–0.029 图幅，不能将两模型接近视为正确性真值。选 balanced 是速度取舍。CoreML 的 balanced 探针在创建模型时失败：`Failed to create MLModel ... error code: -6`，没有可用的 CoreML 吞吐数字；实现已加入加载/推理失败回退。没有重新安装环境依赖。

汕头 253 张按旧 run 的已转正代理图重新推理一次（串行 CPU balanced）：总墙钟 **335895.26 ms（335.90 秒）**，检测+全体关键点+信号平均 **1324.62 ms/张**；100 张单人图平均 **1065.47 ms/张**。总耗时包括进程/模型初始化和规则处理，平均值不含初始化、联系表渲染。有效性修正后用已保存的序列化关键点重新计算信号/渲染，没有把缓存重算时间冒充全量模型推理时间。253 张模型可用率 253/253，全部 signals/verdicts 通过契约校验。**150 ms 预算未达到**。

所有推理命令都调用 `nice -n 10`，并发 1 或 2。当前沙箱返回 `nice: setpriority: Operation not permitted`，因此不能声称实际 nice=10；通过串行探针、每 session 单线程及阶段间顺序运行限制负载。

```sh
EAGLE_PYTHON="<PYTHON_EXECUTABLE>" EAGLE_POSE_PROVIDER=CPUExecutionProvider nice -n 10 node scripts/pose-qa.mjs --run run-1791589678002 --concurrency 1
node scripts/pose-qa.mjs --run run-1791589678002 --reuse
node --test test/signals.test.js test/rules-engine.test.js test/pose.test.js test/face-data.test.js
```

相关测试：41 项，40 pass、0 fail、1 skip（没有设置 EAGLE_PYTHON 的 worker 冒烟）；另设实际 EAGLE_PYTHON 单独执行 worker 冒烟：1 pass、0 fail、0 skip，确认两个连续 JSONL 请求不凭空生成白图人体。覆盖各信号、边缘/画外/低分、宽高比、压缩下肢、缓存升级、缺预览、已有结果兼容与规则证据。

### 7.4 联系表与目测质量

输出目录 `/tmp/w1-pose-qa/`：`contact-1.jpg` 至 `contact-5.jpg`、`labels-template.json`（每张模型结论，人工字段空）、`labels-self-review.json`（本次目测）、`all-results.json`、`raw-poses.json`。50 张包含 26 精选、24 非精选、26 竖图、24 横图、23 多人图；绿色框为主体，灰框为其他人，蓝色骨架，红色为所有人的关节边缘警告。坏切统计仅针对主体，不以背景路人拒绝照片。

以下二元统计把「未检出」（其中包括 `na`）视为阴性，是检测结果的一致率，不是可靠 pass 的准确率；必须连同未知结论审阅。

目测的二元问题是「主体是否在危险关节处被画框裁切」，不把留白过多、普通大腿/躯干裁切或未精选等同于坏切。38 张可判断样例 **29/38 一致（76.3%）**，12 张不确定不计分母；按全部 50 张的已确认一致计为 29/50，不能宣称其余正确。确定样例的预测正例 11 张，其中 TP=2、FP=9，正例精确率 18.2%，FN=0；正例只有两张，且标注者也是实现者，这不是独立测试集。首次直接使用分数+相邻点时仅 20/38 一致；下肢有效性检查后改善，仍**未达到 90% 验收**，不适合接入自动拒绝。

不确定样例：DSC07034、DSC07035、DSC07174、DSC07168、DSC07167、DSC07140、DSC06944、DSC07063、DSC07179、DSC07148、DSC07153、DSC07149。部分真实膝/肘位置在边缘或画外，联系表无法定位，需摄影师在代理图上人工确认。明显误报仍包括 DSC07070、DSC07091、DSC07118 等：正常大腿切点却预测出下沿脚。DSC07174 等近景曾被预测为 full；街景/建筑有小人体框误检；夜景低分手指也可能漏检。发际线和人体外推均不能提供真实可见性标签。后续需要真实裁切位置标注、人体可见性校准/分割，而不能仅提高分数阈值并把未知当 pass。

### 7.5 全库与完整测试验收

全库读取前通过 `http://localhost:41595/api/library/info` 断言活动库为 `<LOCAL_PATH>`。只执行 analyze，没有写回 Eagle；未访问其他库。运行命令（额外限制既有 scorer/DINO 的线程数）：

```sh
EAGLE_PYTHON="<PYTHON_EXECUTABLE>" EAGLE_POSE_PROVIDER=CPUExecutionProvider EAGLE_DINO_THREADS=1 EAGLE_SCORER_THREADS=1 nice -n 10 node src/cli.js analyze --library "$HOME/Pictures/example.library" --concurrency 2
EAGLE_PYTHON="<PYTHON_EXECUTABLE>" EAGLE_POSE_PROVIDER=CPUExecutionProvider EAGLE_DINO_THREADS=1 EAGLE_SCORER_THREADS=1 nice -n 10 npm test
```

第一次全库 run `run-1791594736861`：582 文件、291 单元、72 组，503680 ms，缓存命中 0，291/291 signals 和 verdicts。随后有效性版本重跑 `run-1791595251471`：缓存命中 291，但姿态池超时，旧 signals 残留；**该 run 不能作为最终测量验收**。已修复刷新前清除旧测量并增加回归测试，单请求 timeout 改为 300000 ms。完整测试的第一次启动已中止，不能作为测试通过证据。

当前环境 `git add` 被拒绝：无法创建主仓库 `.git/worktrees/w1-pose/index.lock`（Operation not permitted）。所有代码/文档留在 w1-pose 工作区；未提交、未 push。文档 todo 只勾选已完成的工程与 QA 产物，质量/性能目标保持未完成。

修复后最终全库 run **`run-1791598432850`**：日志为 `分析完成：582 个文件，291 个单元，72 组`、`耗时 201719 ms；缓存命中 291`。291/291 signals、291/291 verdicts，全部 UnitResult 校验通过，全部 `pose.cacheKey` 等于当前版本、provider 全为 CPUExecutionProvider，warnings=[]。与第一次全库结果比较，groups（含排序）完全相同。run 数据位于 `data/runs/run-1791598432850/results.json`。这次指标/人脸缓存命中、姿态仍重新推理；不能将 201.72 秒与首次包含全部分析阶段的 503.68 秒混为同一口径。

最终 run 的汕头子集 253 单元包含 557 个检测人体、59 个无人单元；检测均值 869.86 ms/张，检测+全体关键点（含代理图解码）均值 1319.12 ms/张。这是并发 2 的 session 内计时，和独立串行探针接近，但不是每张的墙钟间隔。

完整套件中的真实人脸召回/误检用例已通过，耗时 509335 ms；全套还包括重新生成代理图的真实分组用例，因此新增姿态后不再符合原先 4–5 分钟的全套时间估计。

完整 `npm test` 实际结果：**148 tests，146 pass，2 fail，0 skipped，1043644.94 ms（17.39 分钟）**。真实人脸召回通过；真实分组失败 `paired F1 0.015 below target`（该用例 528281.73 ms）；另一个失败为长行格式。已经修复所有本任务新文件的长行，相关 41 项为 40 pass、0 fail、1 skip（未设置 Python 时）；实际 Python 的冒烟也在完整套件通过。

格式修复后运行 `npm test -- --test-skip-pattern='fixture face detection recall|fixture grouping reaches'`（两项已跑过且昂贵的真实图库用例被过滤）：日志汇总 148 tests、147 pass、1 fail、0 skipped、7454.82 ms；Node 把被过滤文件的空套件计成通过，这**不代表两项图库用例再次执行通过**。唯一剩余失败为未修改的 `scripts/eval-picks.mjs:73 (164)` 和 `:80 (153)` 长行。用户允许修改范围不包含该脚本，因此没有越界修复。

分组失败核对：真值只覆盖原样片，实际用例把新增汕头后的全库也计入 predicted，带来大量未标注的 pair。对旧 run `run-1791589678002` 和最终新 run 按同一真值复算，均为 TP=26、FP=3113、FN=2、F1=0.016419；新旧 groups 完全相同。本任务没有修改分组或 ranking，不能声称已修复该基线问题。**完整 npm test 全绿验收未通过**；须由相应负责方修正分组真值/评估范围和 eval-picks 长行后再验收。

最终文件清单：新增 1 个 Python worker、3 个 core 模块、1 个 QA 脚本、3 个测试文件；修改 pipeline、contracts 校验及 contracts/research-portrait-body/todo 三份文档。QA 渲染格式修复后再次从保存的关键点快照生成，仍为 5 张联系表、50 标签；没有额外模型全量推理。

早期全量 QA 在脚本增加 raw 保存之前已启动，因此本次 `raw-poses.json` 是从首轮 all-results 的序列化关键点重建的快照，原始画外坐标不能恢复。联系表后续重算使用这份快照；新执行脚本会直接保存 worker 原始预测。下一次独立质检应重新推理而非依赖旧快照。

## 8. W2 可测量规则与关节裁切校准（2026-10-10，已恢复并完成本轮验证）

### 8.1 老师脚本与样本准备

已阅读 §7、Signals/RuleVerdict 契约及三套规则库、小红书候选/淘汰理由。
衣刀候选当前 `extractionStatus=not-run`、rules=[]，不能据此宣称有已审核规则。
汕头没有精选，仅是直出样本；W1 模板的 selected 字段不作为真值，也不进入老师提示。
保持原 50 个分层 unitId，生成 50 张独立标注图（干净代理图 + 主体框/关键点叠图 + 画面边缘）。
产物为 `/tmp/w2-measure/teacher/<unitId哈希>/annotation.jpg`；索引 `prepared.json`。

新增 `ml/teacher/joint_crop_teacher.py`，依赖本机 Python/Pillow、codex CLI。
固定问题分别询问腕/肘/膝/踝/脖颈/发际线裁切、边、置信度、可见证据，交换选项顺序问两次。
结构化 schema 强制六类关节，额外校验状态/边的语义、置信度有限且在 [0,1]。
两次任一关节状态/裁切边不一致、uncertain 或置信度 <0.7，该关节归 uncertain；
任一关节 uncertain 则整张 uncertain，不作为 pass。未知没有伪装成阴性。
辅助点是预测，提示明确禁止将其当真值；不要求模型推断照片审美或用户取舍。

缓存键包括图像内容、unitId、关键点、提示/schema、provider 和模型，原始回答和验证回答均留存。
进程锁防止并行续跑；串行 nice 调用，累计硬上限 150 次（含失败/中断），不自动重试。
`calls.json` 在启动前预留次数，逐次记录耗时；准备图不会覆盖实际标注结果。
默认模型 `gpt-6.1-sol`，与本机配置一致，可显式传 `--model`。
操作说明见 [ml/teacher/README.md](../ml/teacher/README.md)。

### 8.2 沙箱阻塞与外部执行

实际老师 CLI 探针 **1 次启动尝试、0 次成功回答、1.059 秒**。
失败日志 `/tmp/w2-measure/teacher/e6ae35ef1673cbb4f2aa/exec-0.log`：
`Error: failed to initialize in-process app-server client: Operation not permitted (os error 1)`。
调用前置 nice 也返回 `setpriority: Operation not permitted`，因此不能声称沙箱中实际 nice=10。
探针使用 gpt-6.1，失败发生在 app-server 初始化；脚本默认已对齐本机 gpt-6.1-sol，未再重复探针。
按本任务明确要求，此处完成脚本/测试后停止，等待用户在沙箱外运行并 resume。
这不是模型标注失败或已完成 50 张标注，不能报告新准确率。

```sh
cd <LOCAL_PATH>
nice -n 10 python3 ml/teacher/joint_crop_teacher.py \
  --input /tmp/w1-pose-qa --out /tmp/w2-measure/teacher --max-calls 150
```

保留现有 calls.json，同目录可直接续跑。预计 100 次成功回答，加首次失败为 101 次启动尝试。
检查 summary.json 中 complete=true、outputSamples=50、completedCalls=100；
随后发送 `resume /tmp/w2-measure/teacher`。预算耗尽或任何失败会立即退出并报告原因。

### 8.3 首次停点的验收边界（历史记录，恢复结果见 §8.5–8.9）

关节新一致率、合成裁切准确率、误报/漏报、8–10 条 measure 规则、全量触发分布和
`/tmp/w2-measure-qa/` 十例联系表均待外部标注后实施，未标记完成。
本轮未修改 signals、规则引擎或规则 JSON，未触碰 ranking/scoring/grouping、Eagle 或未删减图库。
旧 W1 raw 快照已截断画外坐标，后续复用需明确此限制；合成样本应保留已知裁切真值。
六关节老师标签不能直接等同 P-CROP-WRIST（还含 fingers）和 P-CROP-ANKLE-FOOT（还含 foot）的
合并命中，后续要按相同关节集合对齐预测与老师标签，并同时报告 na/uncertain 覆盖率。
阈值依据须来自合成退化/已知裁切；缺依据的曝光意图、主体位置、边缘干扰、偏色只输出 hint/warn，
按现有 verdict 契约以 warn + hint severity 表达提示。

### 8.4 本轮验证

`nice -n 10 node --test test/joint-crop-teacher.test.js`：Node 包装测试 1 pass，内含 7 个
Python unittest 用例；两次调用与缓存续跑、图/模型变更失效、prepare-only、失败计数、预算上限、
回答非法值/NaN/Inf、交换选项与 uncertain 归并均通过。实际老师调用仍仅为 1 次失败探针，
测试用 mock CLI 不请求模型，不占老师预算。`git diff --check` 通过。

指定命令 `nice -n 10 npm test -- --test-skip-pattern='fixture face detection recall|fixture grouping reaches'`：
**170 tests、168 pass、1 fail、1 skip、9896.64 ms**。唯一失败为 style：
`test/xhs-candidates.test.js:36 (146)`、`:118 (151)`，已用 `git show HEAD:test/xhs-candidates.test.js`
验证同样存在于基线，本轮未改该文件，没有新增失败；未越界修改现有候选测试。
完整套件尚非全绿，skip 为未配置 EAGLE_PYTHON 的真实 worker 冒烟；两个昂贵 fixture 按要求过滤。
本轮改动留在 w2-measure 工作区，未提交、未 push。


### 8.5 恢复后的老师统计与逐关节评估

老师在沙箱外完成，本次恢复 **没有新增老师调用**，calls.json 前后 SHA-256 相同。
总计 102 次启动尝试、100 次成功、2 次失败，累计逐调用计时 2645.689 秒（44.09 分钟，非本轮复算耗时）。
两次交换选项的原始关节回答 297/300 状态及裁切边一致（99%），其中包含共同 uncertain，不能当可靠标签。
保持老师文件原样，不使用样本级 overall 过滤。某关节 uncertain 只排除该关节；其余确定关节保留。

| 关节 | 老师 safe | 老师 crop | uncertain | 当前可测并一致 |
|---|---:|---:|---:|---:|
| 腕 | 29 | 0 | 21 | 29 |
| 肘 | 31 | 0 | 19 | 31 |
| 膝 | 1 | 0 | 49 | 0 |
| 踝 | 1 | 0 | 49 | 0 |
| 颈 | 33 | 0 | 17 | 33 |
| 发际线 | 35 | 0 | 15 | 35 |

130 个确定标签中 128 个可测、全部一致：**128/128=100%**；可测覆盖率及确定标签上的已确认一致
均为 **128/130=98.46%**。另外 2 个确定标签对应模型 na，未算 pass。
全 300 个关节槽位的已确认一致为 128/300=42.67%；170 个 uncertain 不进准确率分母。
用 HEAD 基线测量代码、同一关键点快照和相同关节集合复算，基线也是 128/128、2 na。
因此本数据没有证明真实坏切正例的召回改善，不能将 §7 的 29/38 样本级口径写成提升到 100%。
`/tmp/w2-measure-qa/teacher-comparison.json` 保留每个关节的老师状态、模型状态与排除原因。

### 8.6 合成裁切、改进与准确率

新增 `ml/teacher/joint_crop_synthetic.mjs`：6 张已审看的单人源图，48 张真实像素裁切，
32 个危险切点、16 个安全对照；腕/颈各 18，膝/踝各 6。按源图拆为校准 24、评估 24。
汕头四张长裙图不能看到膝/踝，仅生成腕/颈标签；膝/踝来自 bench s011/s012。
边界取源点位置 ±0.004 图高；安全对照使用大腿中段，颈查询另有上臂中段对照。
每个真值仅针对 queryJoint，不把其他关节碰边判为该查询的坏切。
膝源点可见，踝在贴身靴内、颈由鼻肩插值，是近似几何真值；不冒充老师/专家精确标注。
源码坐标变换只留作来源证据，**预测来自裁切后的实际模型重新推理**。
共 58 次像素推理（48 张 + 修正 10 张切点后重跑），CPU 串行，累计推理墙钟 111.99 秒。
最终 48/48 可用、48/48 检出人物；没有部署新模型。nice 已调用但 setpriority 被沙箱拒绝。

主要测量改进：

- 下沿压缩的小腿/大腿长度比从 0.4 扩至 0.8；增加边缘反向小腿的检查。
  高分且距下沿 <0.15 头高的膝点（≥0.75）可单独保留，不能因画外小腿坍缩而一起丢失。
  同时膝踝分数均 ≥0.8 且小腿长 >0.8 头高的可信屈腿链保留；这不是透视或姿态审美评分。
- 脚/手指预测须达到 0.3 分，低分贴边点不能直接触发坏切。相邻点允许 ≤0.005 头高的微小数值越界，
  修复真实裁切中肘点超出约 0.0004 图幅导致腕点被丢弃的问题。
- 头部被上沿切掉时，脸点被挤压不能可靠给头高：边距单位所用的估计头尺度取肩宽 ×0.6，
  颈位置取肩中点向上 0.35 个此尺度。`headScaleSource=shoulder-estimate`，省略发际线/留白判断。
  其他普通情况仍用眉心/下巴尺度和 0.15 头高边带，不扩大通用坏切边带。
- `jointObservability` 明确区分已定位与不可测；无命中且双侧/邻点未可靠定位时为 na，不能凭一侧点给 pass。
  原关键点分数/坐标不改；序列化坐标仍按旧契约截断。

| 实际像素合成评估 | HEAD 基线 | 当前 |
|---|---:|---:|
| 全 48 张已确认正确/全部（na 留在分母） | 31/48=64.58% | **44/48=91.67%** |
| 可测样本条件一致率 | 31/46=67.39% | 44/44=100% |
| 校准集已确认正确/全部 | 16/24=66.67% | 22/24=91.67% |
| 源图隔离评估集已确认正确/全部 | 15/24=62.50% | 22/24=91.67% |
| TP / FP / FN / na | 19 / 2 / 13 / 2 | 32 / 0 / 0 / 4 |

剩余四个 na 是 s011/s012 的 knee-safe-midsegment、ankle-safe-midsegment：安全大腿裁切后看不到相应关节，
只能保持未知。腕/颈各 18/18 确认正确；膝/踝各 4/6 确认正确、2 na。
原有误报例 DSC07070、DSC07091、DSC07118 的膝/踝脚合并规则现在均为 na，而非猜测 pass；
基线合成漏报例 s011-neck-joint-plus、DSC07108-neck-joint-plus、DSC07105-wrist-joint-plus 均已识别。

**91.67% 是本组合成已确认正确比例，不能认证真实图库坏切已达 ≥90%。**
源图相关且评估集在开发有效性检查时也被审看，这是探索性验证，不是独立盲测。
校准网格 0.4/0.6/0.8 压缩比、0.15/0.25/0.35 颈边带在本校准集均 22/24；
因此保留 0.15 通用边带，0.8 压缩比的选择还参考已审看的下沿假脚。
报告 `/tmp/w2-measure/synthetic/evaluation.json` 包含参数、逐例 TP/FP/FN/na、基线提交和敏感性数据；
`contact.jpg`、`manifest.json`、`raw-poses.json`、`inference-provenance.json` 可审计像素与推理来源。

### 8.7 十类可测量检查与阈值依据

增加六个规则 ID：P-CROP-ELBOW、P-SUBJECT-PLACEMENT、P-COLOR-CAST、L-VERTICAL-LEVEL、
G-EDGE-GRADIENT、G-PROXY-BLUR；补齐已有曝光、水平线、街拍倾斜、头部/关节规则。
重复题材与关节 ID 合计 18 个 check.measure 配置，按测量内容归为以下十类。
已有规则的非 check 字段与库版本未改；measure.version 和阶段缓存键区分新旧算法。

| 测量类 | 规则 ID | 信号及阈值 | 触发结论 |
|---|---|---|---|
| 面部曝光 | P-EXPOSURE-INTENT | 主体内脸框亮端 >0.03 或暗区 >0.25；内框 ≥64 px、两轴 ≥8 px | warn |
| 水平参照倾斜 | L-HORIZON-LEVEL | abs(horizontalTiltDegrees)>2°，线共识 ≥0.65 | warn |
| 建筑竖线倾斜 | L-VERTICAL-LEVEL、S-TILT-INTENT | abs(verticalTiltDegrees)>3°，线共识 ≥0.65 | warn |
| 关节裁切 | P-CROP-NECK/WRIST/ELBOW/KNEE/ANKLE-FOOT | <0.15 头高/可靠画外点，结合有效性与可观察性 | violate/na |
| 头部裁切/留白 | P-CROP-HAIRLINE、P-CROP-HEADROOM | 发际线边带；留白参考 0.3–0.6、0.1–1.2 头高 | 发际线 violate；当前留白仅 warn |
| 主体位置/大小 | P-SUBJECT-PLACEMENT | 框面积 <0.02 或到中心/最近三分交点的较小距离 >0.25（欧氏距离/√2） | hint→warn |
| 边缘强梯度干扰 | G-EDGE-GRADIENT | 外缘 6% 带均值梯度/内部均值梯度（分母至少 1）>2 | hint→warn |
| 灰世界偏色 | P-COLOR-CAST | (max 通道均值−min)/max >0.25；15<亮度<240 的像素 ≥64 | hint→warn |
| 亮/暗端点 | L-EXPOSURE-DETAIL、L-SHADOW-RECOVERY、S-EXPOSURE-CONTENT | 风光 >0.02/0.10，街拍 >0.08/0.25 | warn |
| 代理模糊 | G-PROXY-BLUR | 拉普拉斯方差 <200，最大边 512 px、保持比例 | hint→warn |

像素检查通过 `computeProxyMeasurements` 接入现有 detectPose→computeSignals→evaluateRules 路径，
仅在姿态阶段末尾串行读取已转正代理图，不改 scoring/ranking/grouping。
附加 `Signals.imageMeasurements`（version=measure-v3、代理分辨率、直方图/梯度/方差/色彩/线段数值）、
逐人物 faceExposure 与主体几何字段、jointObservability；RuleVerdict 的数值 evidence 带信号名、单位和阈值。
缺像素/缺脸/小脸/无可信线/版本不匹配输出 na。
图像级规则只评估一次，不因多人重复计数；可选 genres 筛选，默认输出所有题材分支。
不要求用户打标签，不把这个默认分布称为自动题材分类后的通过/拒绝分布。

合成退化来自 `ml/teacher/measure_calibration.mjs` 的 34 个真实 PNG 样本，
结果保存在 `/tmp/w2-measure/calibration/`。每张走真正图像解码、测量和规则链：

- 亮端为任意 RGB 通道 ≥252，整图死黑为亮度 ≤3；面部过暗另用亮度 ≤15。
  白背景/中性脸通过，白脸和暗脸提醒，未把整图曝光冒充脸部曝光。
  比例阈值无真实风格/RAW 可恢复性标签，故两种题材阈值都仅提醒，高调/低调不硬拒绝。
- 0/3/8° 合成水平/竖线测得 0/2.9977/7.9993°，最大误差 0.0023°。
  Hough 从梯度 ≥20 的定向边采样，最多 2500 点；角度 -12…12°、步长 0.5°，
  支撑线跨度 ≥0.35、占用率 ≥0.45，最终共识 ≥0.65 才输出角度。
  这只证明线的几何方向，不证明是海平线、建筑水平或必须校正透视。
- 色偏对照 0.20、退化 0.2889，阈值 0.25 可区分这组 RGB 退化；对应小红书「偏色太重」候选，
  但不能推断暖灯/绿植/胶片风格不符合意图。
- 边缘梯度比对照 0.8969、强边缘退化 49.7475；阈值 2 只标注意力风险，不识别杂物类别。
- 清晰纹理方差 13131.03，轻微高斯 1268.39，强高斯 47.37/1.74，强运动 57.55/150.59。
  原拟阈值 60 漏报一例强运动，调整为 200，位于本样本可分区间 (150.59,1268.39]。
  全局纹理、方向和缩图影响数值，不能区分失焦/运动，也不是原生眼睛清晰度或有意模糊标签。
- 主体面积/锚点距离、头部留白没有独立审美标注，仅 hint/warn；新版本将原留白超界违例降为 warn，
  保留旧无版本信号调用的兼容行为。不能为了覆盖 violate 测试而把这些启发式变成门槛。

### 8.8 汕头全量复算与分布

253/253 输出通过 UnitResult 契约校验，代理图 SHA-256 前后一致，图像测量失败 0。
复用 W1 保存关键点，测量与哈希/契约校验约 3.3 秒（不含联系表渲染），不是全量姿态推理性能。
旧画外坐标已截断的限制仍存在；输出明确标记 reusedKeypoints 与 clamped-W1。
阶段缓存升级为 signals-v3-proxy-joint-validity:measure-v3；实际流水线遇到旧测量键仍按现有协议刷新姿态。

以下为 18 个配置规则及三项已有可运行测量，trigger=warn 或 violate 的单元数；
其余未实现的 measure 规则全部 253 na/0 trigger，完整分布见 summary.json。

| Rule ID | pass | warn | violate | na | trigger |
|---|---:|---:|---:|---:|---:|
| G-EDGE-GRADIENT | 253 | 0 | 0 | 0 | 0 |
| G-PROXY-BLUR | 240 | 13 | 0 | 0 | 13 |
| L-EXPOSURE-DETAIL | 226 | 27 | 0 | 0 | 27 |
| L-SHADOW-RECOVERY | 239 | 14 | 0 | 0 | 14 |
| L-HORIZON-LEVEL | 33 | 10 | 0 | 210 | 10 |
| L-VERTICAL-LEVEL | 33 | 3 | 0 | 217 | 3 |
| P-CROP-HEADROOM | 8 | 177 | 0 | 68 | 177 |
| P-CROP-HAIRLINE | 182 | 0 | 3 | 68 | 3 |
| P-CROP-NECK | 184 | 0 | 0 | 69 | 0 |
| P-CROP-WRIST | 146 | 0 | 18 | 89 | 18 |
| P-CROP-KNEE | 58 | 0 | 26 | 169 | 26 |
| P-CROP-ANKLE-FOOT | 26 | 0 | 23 | 204 | 23 |
| P-EXPOSURE-INTENT | 152 | 8 | 0 | 93 | 8 |
| P-CROP-ELBOW | 173 | 0 | 11 | 69 | 11 |
| P-SUBJECT-PLACEMENT | 179 | 15 | 0 | 59 | 15 |
| P-COLOR-CAST | 77 | 176 | 0 | 0 | 176 |
| S-EXPOSURE-CONTENT | 231 | 22 | 0 | 0 | 22 |
| S-TILT-INTENT | 33 | 3 | 0 | 217 | 3 |
| P-CROP-TIER | 26 | 0 | 65 | 162 | 65 |
| P-POSE-WEIGHT | 0 | 188 | 0 | 65 | 188 |
| P-FACE-EYES | 145 | 0 | 15 | 93 | 15 |


灰世界色偏 176/253 触发，反映暖夜景、服饰/绿植等场景通道主导的影响，不能视为 176 张应淘汰。
水平线 210 na、竖线 217 na 为主动弃权；无可靠线不等于画面平直。
联系表 `/tmp/w2-measure-qa/contact-10.jpg` 已目视检查：包含前三个修正的 W1 假脚例、
面部暗区、代理模糊、水平/竖线、高光端点等十例；完整数字与裁切判断在 examples.json。
旧支持的景别与闭眼仍按原规则返回，未修改排序、权重或分组。

### 8.9 验证、补标与限制

新增五个测试文件（其中老师包装含 7 个 Python 用例）、一个真实预测快照 fixture；
覆盖 pass/warn/na、关节 violate、逐关节 uncertain 过滤、原始关键点不变、代理测量入姿态阶段、
缓存升级、像素曝光与脸框匹配、真实 PNG 倾斜/模糊/色偏、合成裁切边界与断点缓存。
指定完整测试 **199 tests、197 pass、1 fail、1 skip、8685.38 ms**，没有新增失败。
唯一失败仍为 HEAD 原有 test/xhs-candidates.test.js:36 (146) 与 :118 (151) 的长行，未修改该既有测试。
skip 是未配置 EAGLE_PYTHON 的 worker 冒烟；实际像素合成推理已另行完成。
两个昂贵 fixture 按指定模式过滤，不声称它们重新执行通过。

```sh
nice -n 10 node ml/teacher/measure_calibration.mjs --out /tmp/w2-measure/calibration
nice -n 10 node ml/teacher/joint_crop_evaluate.mjs --input /tmp/w2-measure/synthetic
nice -n 10 node ml/teacher/measure_qa.mjs --out /tmp/w2-measure-qa
nice -n 10 npm test -- --test-skip-pattern='fixture face detection recall|fixture grouping reaches'
```

未新增老师调用、不写回 Eagle、不访问未删减库。只读取缓存代理图/关键点/老师结果，
原图没有写操作；253 个缓存代理图 SHA-256 逐张一致，未以原图哈希冒充缓存图哈希。
本轮模型部署 0；本机作业/姿态池并发不超过 2，独立合成推理与像素 QA 串行。
所有执行入口尝试 nice -n10，但受限沙箱不允许 setpriority，不能宣称真实降优先级。

若需要认证真实正例的 ≥90% 目标，需补标以下 9 张中当前老师 uncertain 的预测坏切关节：
DSC07034（膝）、DSC07174（腕）、DSC07050（膝）、DSC06944（肘/膝）、DSC06983（肘）、
DSC07063（膝）、DSC07179（腕/膝/踝）、DSC07148（膝）、DSC06942（肘/膝）。
名单与代理路径见 supplementary-label-requests.json；本轮未请求或执行补标，不占更多老师预算。
这些样本若仍不可定位必须继续 uncertain，需要另找可见关节的独立正例。
小样本近似几何真值、不可恢复的 W1 画外坐标、宽衣/遮挡/透视可观察性和灰世界/线段语义仍是限制；
当整个姿态模型不可用，现有 pipeline 会跳过 signals，图像规则也为 na，未越界修改该流程。


相关定向测试最后结果：67 tests、66 pass、0 fail、1 skip，4128.03 ms；git diff --check 通过。
Git 暂存尝试被拒绝：无法创建主仓库 .git/worktrees/w2-measure/index.lock（Operation not permitted）。
改动保留在 w2-measure 工作区，未提交、未 push。实际文件清单：修改三份 core、三份规则 JSON、
research-portrait-body/todo；新增 general.json、ml/teacher 下五个脚本及 README、五个测试及一个预测 fixture。
