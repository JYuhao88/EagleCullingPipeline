# Eagle Culling v1.0

Eagle Culling 是一个本地运行的 Eagle 照片筛选工具：把同一拍摄的 JPG/HEIC 与 RAW 组成拍摄单元，
在代理预览上分析并分组排序，交由 Eagle 插件挑片；决定保存为 Eagle 星级，可选写回 AI 标签。

## 功能

- 配对 RAW+JPG/HEIC 拍摄单元；RAW 跟随所属单元。
- 生成最长边 1024、JPEG quality 88 的代理预览；支持 Eagle 缩略图回退。
- 计算清晰度、曝光、人脸/闭眼（可选 MediaPipe）和基础质量指标。
- 可选 DINOv2 embedding 做相似分组；缺模型时退回 hash + 时间分组。
- 组内排序并给出中文理由；结果按 SHA-256 指纹缓存，支持断点续跑。
- Eagle 插件并排审阅、快捷键、人工决定记录。
- 挑片决定保存为 Eagle 星级（精选 5、候选 3、淘汰 1）；AI 标签默认关闭，开启后幂等写回并保留人工标签；配对 RAW 跟随。
- 可选把人工标为淘汰的照片二次确认后移入 Eagle 回收站；导出 CSV/JSON 报告。

当前 `models/scorer` 不可用时，`src/core/scorer.js` 返回 `quality=null`、`aesthetic=null`、`calibrated=false`，
并在结果中保留警告；可用时使用已校验的 TOPIQ-NR ONNX。模型评测见 `docs/model-eval.md`。

## 环境要求

- macOS；Node.js ≥ 20。
- Eagle 4 已启动，并开启本地 API，默认 `http://127.0.0.1:41595/api/v2`。
- 可选：`python_worker` 虚拟环境和 MediaPipe，用于人脸/闭眼检测。

## 安装

```bash
npm install
uv venv --python 3.12 python_worker/.venv
uv pip install --python python_worker/.venv/bin/python -r python_worker/requirements.txt
```

模型文件按代码读取的路径放置：`models/mediapipe/face_landmarker.task`（MediaPipe）和
`models/dinov2-small/model.onnx`（DINOv2）。来源、SHA-256 和下载校验见
`python_worker/model-manifest.json`；程序不会隐式下载照片或模型。

## 快速开始

```bash
node src/cli.js doctor --library "/path/to/example.library"
node src/cli.js serve
```

`doctor` 检查 Eagle、library、`sips`、`sharp`、Python、MediaPipe 模型和 DINOv2 模型。
服务默认监听 `127.0.0.1:43125`，可用 `--port` 或 `CULLING_PORT` 覆盖。插件打开时先请求当前页面同源 `/health`；
不可用时回退到已保存地址，默认值为该地址，并在界面显示连接状态。

在 Eagle 中选择「插件」→「开发者选项」→「导入本地项目」，选择 `src/plugin`。
插件默认连接 `http://127.0.0.1:43125`。新手按三步使用：

1. 在 Eagle 左侧选择一个文件夹，或选中几张照片。主页显示当前库、文件夹和选中张数。
2. 点主按钮开始分析：有选中照片时优先分析所选，否则分析当前文件夹；完成后自动进入审阅。
3. 看每组相似照片，用 `1` 标精选、`2` 标候选、`3` 标淘汰，按 `Enter` 看下一组。

未连接时点「启动服务」。仓库路径、服务地址、可复制命令和手填分析记录 ID 都在默认折叠的「高级设置」。
仓库路径可编辑并保存在本机；默认从插件位置推导。直接启动需插件支持 Node `require` 和本机 HTTP 服务地址。
Unix 用 `nice -n 15`，Windows 直接用 `node`；两者都以并发 1 detached 启动，并每秒检查连接，最多 30 次。
启动失败请展开高级设置复制命令；Windows 命令在 PowerShell 执行。浏览器预览不能直接启动，也不能读取 Eagle 选中状态。
浏览器可在高级设置填写资源库路径后分析全库，或打开最近记录；默认先建议尝试一个文件夹。

分析显示「扫描 → 画质分析 → 人脸 → 分组 → 完成」，画质阶段估算剩余秒数，不把它当作完整任务耗时。
可取消分析，并在「最近的分析」里重新分析、复用已完成阶段。最近记录显示范围、时间、张数、分组及已审组数。
旧记录缺少轻量组摘要时会提示审阅进度暂不可用；服务不支持列表时只显示本机缓存的最近记录。

审阅页顶部保留返回、标题进度、筛选、帮助和更多。人脸对比、放大镜及候选集在「⋯」里；分组修正在折叠工具区。
「个性化（实验，默认关闭）」在设置抽屉内，需要明确启用、验证和应用。首次提示可关闭，并从帮助重新打开。
导出报告和回收站清理在「设置 › 分析记录」；开启「同时使用 AI 标签」后才能写回 AI 标签，写回先预览再确认。

纯 CLI 流程：

```bash
node src/cli.js analyze --library "/path/to/example.library" [--concurrency 2] [--out data/run.json]
node src/cli.js apply --run run-<id>                 # dry-run
node src/cli.js apply --run run-<id> --apply         # 写回 AI 标签
node src/cli.js apply --run run-<id> --revert        # 预览撤回上次写回
node src/cli.js apply --run run-<id> --revert --apply # 撤回上次写回
node src/cli.js apply --run run-<id> --apply --move-rejected-to-trash --confirm MOVE_TO_TRASH
node src/cli.js report --run run-<id> --format json --out report.json
node src/cli.js report --run run-<id> --format csv --out report.csv
```

`analyze` 输出的 run id 写入 `data/runs/<id>/`。`report --format` 默认 `json`；`apply` 写回前会校验 Eagle 当前 library。

## 插件快捷键

| 按键 | 操作 |
|---|---|
| `1` | 当前单元标记为精选 |
| `2` | 当前单元标记为候选 |
| `3` | 当前单元标记为淘汰 |
| `←` / `→` | 上一个/下一个单元 |
| `Enter` | 下一组；`Shift+Enter` 上一组 |
| `M` / `Shift+M` | 当前单元移到当前分组顺序的上一组 / 下一组（包含被筛选隐藏的组） |
| `G` | 当前单元移到新组 |
| `S` | 接受本组建议（当前排序首选保留，其余按建议决定） |
| `Z` | 同步放大/还原当前组全部大图；放大后指针移动可查看局部 |
| `F` | 打开/关闭组内人脸对比；`Esc` 关闭对比 |
| `U` / `Cmd/Ctrl+Z` | 撤销最近一次人工决定 |
| `A` / `Esc` | 全选 / 清除选择 |
| `Cmd/Shift` 点击 | 多选（Shift 支持范围） |
| 空格 | 全屏细节预览 |

输入框、文本框和下拉框获得焦点时快捷键不会触发。组内主视图上方显示按排序排列的缩略图条，
点击缩略图或 `←`/`→` 切换当前项。

卡片图片下方显示按面积从大到小排列的最多 4 张人脸；闭眼红框标「闭眼」，眼睛未评估时显示灰标。
有可用人脸的组会显示「对比人脸」按钮，也可按 `F`：每张照片占一列，同一位置的人脸占同一行，
按归一化中心距离最近邻一对一匹配（最大距离 0.18），未匹配留空。此视图按位置辅助比较，不识别人物身份。
人脸裁剪从细节图取源，每侧外扩脸宽/高的 35%，最长边不超过 320px，按需缓存在 run 的 `face/` 目录。
旧 run 缺少逐脸数据时正常显示照片；需重新分析得到 `faces` 字段才会出现人脸条和对比按钮。

审阅默认显示「多张组」，标题和已审进度均按当前筛选计数；「全部（含单张组）」可查看单张组。
「接受未审单张组建议」一键批量确认单张组，保留已有人工决定；接受所有未审组只处理当前筛选范围，
也保留组内已有人工决定。其他筛选项：先看需确认、未审阅、有问题、闭眼、模糊、已审。

分组工具栏支持移动当前照片到相邻组或新组、与上一组合并、拆分多选照片，以及撤销最近一次分组修正。
拆分需选择组内部分照片。修正保存到 `group-overrides.json`；排序及建议随之更新，人工决定不丢失，
原始分析结果保留。写回与报告使用修正后的分组。默认多张组筛选下，新建单张组会暂时隐藏，切换全部可查看。
侧栏的“闭眼照片标记淘汰”和“模糊照片标记淘汰”
只针对尚未人工决定的结果，执行前需要确认。

组列表和标题显示“需确认”“把握高”（单张显示“单张”）。第一、二名排序分差小于 `0.03`，
或首选有模糊、闭眼、过曝、欠曝标记时，需要人工确认；近分首选会提示“与第二名很接近，建议人工确认”。
下拉项“先看需确认”保留全部组并把需确认组排在前面。旧 run 打开时由服务补算，无需重新分析。
“接受所有把握高的组”仅处理完全没有人工决定的高把握组，确认框显示组数，可用 `U` 撤销整批。

多张组中恰好有一个人工保留项即计为一组偏好标注。累计至少 5 组且有足够完整指标时，
提示条显示已标注组上的两两一致率变化和剩余组数，点击“应用”按学习权重重新排序剩余多张组。
组内任意照片已有人工决定就会保留该组排序和建议；人工决定、全局权重和原片不会改变。
“忽略”后本次插件会话内不再提示该 run。指标不足或一致率为空时不显示提示。
一致率是拟合使用的标注组上的对比，不代表未审阅照片的预测准确率。

## 写回边界

写回只管理 `AI精选`、`AI候选`、`AI淘汰`、`AI闭眼`、`AI模糊`、`AI过曝`、`AI欠曝`。
它重新读取 Eagle 当前标签，移除旧 AI 标签后合并新 AI 标签；人工标签和星级保留。
一个拍摄单元的决定写到该单元所有 item（包括 RAW）。工具不移动、不重命名、不修改原文件，
也不修改 Eagle 文件夹或人工星级。

写回对话框按精选、候选、淘汰展示将新增/移除的 AI 标签数量、受影响文件和无变化文件数，
展开查看每类前 50 条文件名及标签变化；确认后才执行。预览到执行之间如有外部修改，以执行时实时标签为准。
写回完成后可点击「撤回本次写回」，恢复上次写回前的 AI 标签，同时保留现在的人工标签、星级和文件夹。
重复撤回不会再改写；失败项可重试。旧 `applied.json` 缺少 `previousTags` 时会明确拒绝撤回。
撤回不会恢复回收站位置，也不撤销审阅决定或分组修正。

回收站操作必须同时使用 `--move-rejected-to-trash` 与 `--confirm MOVE_TO_TRASH`；插件的「淘汰的移入回收站…」只移动人工标为淘汰的照片，也须输入确认词。
默认是 dry-run，请先在测试库试用。

## 清理旧缩略图

`restore-thumbnails` 仅用于清理 Windows 资源库中遗留的旧角标，不参与正常分析或写回。
它读取每行一个 Eagle item ID 的文件，并校验目标资源库；默认只 dry-run。
确认逐项结果无误后，才使用 `--apply` 和固定确认词调用 Eagle `refreshThumbnail`（兼容 V1/V2）：

```bash
node src/cli.js restore-thumbnails --library "/path/to/library.library" --ids-file ids.txt
node src/cli.js restore-thumbnails --library "/path/to/library.library" --ids-file ids.txt \
  --apply --confirm RESTORE_THUMBNAILS
```

该命令不生成角标、不备份或改写原片；只对明确提供的 ID 逐项刷新缩略图。

## 常见问题

- **Eagle 未启动**：`doctor` 的 `eagle` 为 false；启动 Eagle 并确认 41595 本地 API。
- **资源库不匹配**：写回前会比较 `library.path`；路径不同会拒绝写回。
- **HEIC 预览失败**：macOS 上先用 `sips` 转 JPEG；失败时尝试 Eagle 缩略图。
- **RAW 没有预览**：RAW 不直接解码；没有 Eagle 缩略图时带预览警告，分析仍保留结果。
- **python_worker 缺失**：人脸检测不可用，`faces/eyesClosed` 保持未知；其余 Node 分析继续运行。

## 文档索引

- `docs/product-spec.md`：产品约束；`docs/contracts.md`：HTTP/JSON 合同。
- `docs/architecture.md`：模块、数据流、缓存和进程模型。
- `docs/testing.md`：测试、fixture 和端到端验收。
- `docs/mac-ray-ceph.md`：Mac、Ray、Ceph 运行约束。
- `docs/model-eval.md`：打分模型评测与部署记录。

## 公开发布与本地配置

[v1.0.0 发布说明](docs/release-notes-v1.0.0.md)包含配置、功能边界与公开检查方法。
可复制 `config/local.example.json` 为忽略的 `config/local.json`，填入自己的 Eagle/Python 路径及可选研究配置；环境变量优先。
研究脚本同样读取该文件，Ray 作业会转发 `ECP_*`；缺少必需地址或存储根会报错。
完整变量含义见 [本地与 Ray 配置](docs/mac-ray-ceph.md)。
发布前运行 `nice -n 15 node scripts/check-public-release.mjs`。研究资料全文、照片、模型和本地回执不入库。

## 自动更新

首次安装请用 `git clone https://github.com/JYuhao88/EagleCullingPipeline.git`，
将克隆内 `src/plugin` 导入 Eagle，并从克隆根目录启动 `node src/cli.js serve`。
之后插件默认在主页、服务空闲时自动更新到正式版本，完成后重新加载插件。
「关于 / 更新」可关闭自动更新、查看更新内容、检查更新或回退到上一版。
工作区有未提交改动时拒绝更新并保留改动；审阅期间等待返回主页。
检查远端至少间隔六小时，使用 git 获取 tag，不依赖 GitHub API 限额。
安装、发布、依赖限制与恢复说明见 [自动更新说明](docs/auto-update.md)。
