# v1.0.0 发布说明

v1.0.0 提供本地运行的 Eagle 选片流水线。分析、分组、排序和审阅供用户辅助决策，
审美建议仍需人工确认。公开仓库不附带私人照片、课程视频、书籍全文、内部论文语料或模型权重。

## 包含的功能

- 本地扫描与 RAW/JPG/HEIC 拍摄单元配对、代理预览、指纹缓存、断点续跑及取消。
  可选人脸/闭眼、姿态、相似度嵌入与质量模型；缺模型时保留缺失状态和警告。
- Eagle 只读分析；可选写回 AI 标签、预览写回、幂等更新和撤回。
  写回前核对当前库，保留人工标签与星级；RAW 跟随所属单元。
  移入回收站需要额外确认，默认不开启。
- 相似分组、组内排序、硬伤提示与中文理由；人像、风光、街头及通用规则引擎。
  规则审阅页汇集书籍、课程、论文与匿名评论的短转述和定位，候选规则需审核。
- 插件审阅页：组内对比、缩略图导航、快捷键、人工分组、撤销、CSV/JSON 报告。
  对焦位置提示、原生局部指标及 1:1 放大镜辅助检查细节。
- 候选集视图默认关闭；启用后显示多个互有优势的候选，不把不同维度压成唯一审美答案。
- 偏好学习默认关闭：本地特征库、追加事件日志、多 profile、训练验证、回滚及漂移提示。
  只有验证门槛满足才允许偏好头影响排序；像素保留默认档位为 0（仅特征）。
- 规模优化：会话分区、时间桶候选索引、跨日重复证据、Map 查找、轻量进度更新和原子终态保存。
  跨日重复证据不自动合并分组或淘汰照片。

## 已知限制

候选集和偏好学习已有合成数据、缓存回放及模拟选择验证，尚未经真实用户选择验证。
模拟结果不等于用户满意度、真实摄影师精选准确率或生产质量保证。
既有样片文件夹含义未知，不能作为摄影师精选标签；已撤销的对比图不随发布分发。

技术分数不能替代对表情、手势、姿态、构图和拍摄意图的判断。
模型不可用时质量分数为 `null`，不以启发式分数冒充模型输出。
对焦提示和原生细节读取受格式、元数据及解码器支持限制；RAW（包括 3FR）需要验证本地解码支持。
书籍/课程/论文定位来自既有研究记录，OCR、转写和文献年代仍可能有误。
完整分析后才进入审阅，不支持边分析边提前审阅。

## 运行要求与配置

本地基线要求 Node.js ≥20、`npm install` 安装依赖。
当前使用说明以 macOS 与 Eagle 4 为主；Eagle 需开启本地 API。
API 默认端口为 41595；服务默认监听 `127.0.0.1:43125`，可用 `--port` 或 `CULLING_PORT` 覆盖。
可选 Python 环境、MediaPipe、DINOv2、RAW 解码及其他模型的安装要求分别见
[README](../README.md)、[worker 说明](../python_worker/README.md)和模型 manifest。
模型文件放在忽略的 `models/`，不会隐式下载。普通本地使用不要求 Ray、远端存储或内部语料。

```sh
cp config/local.example.json config/local.json
```

编辑 [配置示例](../config/local.example.json)，把每个占位符换成自己的路径，或删掉不用的键。
`config/local.json` 不入库，环境变量优先；JSON 非法、配置类型错误或仍含占位符时会清晰报错。
可配置键如下：

| 键 | 用途 |
|---|---|
| `EAGLE_LIBRARY_PATH` | doctor/analyze 的默认库；显式 `--library` 优先 |
| `EAGLE_EXPECTED_LIBRARY` | Eagle API 操作的预期库校验 |
| `EAGLE_LEARNING_LIBRARY` | 删除反馈扫描的保护库；缺失时使用无法匹配正常库的安全默认 |
| `EAGLE_PYTHON` | 本地人脸 worker、RAW 解码和 doctor 的 Python 可执行文件 |
| `ECP_EVAL_RUN` / `ECP_EVAL_CACHE` | 离线评估所需的本地结果 JSON / JSONL |
| `ECP_SCORER_FIXTURE` | 手动 scorer parity 的本地 fixture 目录 |

```sh
nice -n 15 node src/cli.js doctor
nice -n 15 node src/cli.js serve
```

研究脚本与应用一致读取 `config/local.json`，环境变量优先。公共 helper 为
`ml/common/private_env.py`；本地可用 `ECP_LOCAL_CONFIG` 指定其他不入库的配置文件。
需要的 `RAY_DASHBOARD`、`ECP_CEPH_ROOT` 或 `ECP_CORPUS_ROOT` 缺失、为空、仍是占位符时立即报错，
存储根还必须是绝对路径。没有默认本地 Ray 地址或相对存储目录。
`ECP_CEPH_ROOT` 是远端项目根，脚本会在其下拼接 `/references`、`/models/onnx`、`/research` 等。
`ECP_CORPUS_ROOT` 是授权内部语料根；可选 `ECP_HTTP_PROXY` 默认为空。
所有 Ray 提交使用公共 helper 合并 `ECP_*` 到 `runtime_env.env_vars`，保留作业已有参数；
`RAY_DASHBOARD` 和本机配置文件路径不传给节点，本地配置文件不加入作业包。
执行端仅使用已转发的环境配置，缺少根目录就退出，不静默回退。
完整变量表及作业配置说明见 [Mac/Ray 配置](mac-ray-ceph.md)。
既有上传 manifest 的本地路径已换成占位符，应重新生成自己的清单；回执默认写到忽略的
`ml/references/local/`。历史去敏回执只用于审计计数，不能直接作为连接/上传配置。

内部论文语料（不公开）仅供有权限的内部使用者使用。路径由 `ECP_CORPUS_ROOT` 配置；
索引和正文布局分别通过 `ECP_CORPUS_INDEX_PATTERN` / `ECP_CORPUS_TEXT_PATTERN`（论文）、
`ECP_CORPUS_INDEX_TEMPLATE` / `ECP_CORPUS_TEXT_TEMPLATE`（书籍，含 `{lang}`）、
`ECP_CORPUS_ZH_PATTERN` / `ECP_CORPUS_EN_PATTERN` / `ECP_CORPUS_FACET_PATTERNS`（研究检索）配置。
公开仓库仅保留中性布局默认值和书目定位，不包含内部目录名、原始语料 ID 或全文。

## 公开检查与发布边界

```sh
nice -n 15 node scripts/check-public-release.mjs
nice -n 15 node --test --test-concurrency=1 --test-skip-pattern='fixture face detection recall|fixture grouping reaches'
nice -n 15 python3 -m unittest discover -s ml/references -p 'test_*.py'
nice -n 15 python3 -m unittest discover -s ml/references/books -p 'test_*.py'
git diff --check
```

检查脚本覆盖 `git ls-files` 跟踪文件及待添加但未忽略的文件，列出命中文件和行号并返回非零退出码。
检查内部主机、个人路径、集群存储、语料定位、凭证、agent 记忆引用、嵌入图像及非白名单媒体/二进制；
JSON 的短转述、摘录和摘要逐项不超过 40 字。书目名称、章节、页码和时间点不属于转述文本。
不把较长的程序规则说明当作第三方原文。

白名单仅有两项：

1. `src/plugin/logo.png`：人工核对为相机图标，没有人像；按固定 SHA-256 检查，替换即失败。
2. `127.0.0.1`：本地服务和合成测试的 loopback 地址，没有外部基础设施身份；不豁免所在文件其他内容。

其余 SVG 为代码生成的图标或学习曲线，不含照片、截图或嵌入位图。
`data/`、`models/`、`node_modules/`、`exports/`、本地配置与环境文件已忽略。
fixtures 仅保存非图像数据与文件名/stem 等信息。

此检查验证当前文件树，不扫描历史提交。单个 squash 合入时须确认公开 master、已有 tag/PR、
附件及发布包没有保留原敏感内容；也需人工确认第三方材料授权和照片隐私边界。
本次自动化验证不代表真实 Eagle 写回、Ray 作业、模型冷启动或真实用户端到端验收。
