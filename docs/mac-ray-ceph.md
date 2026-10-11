# Mac、Ray 与 Ceph 操作记录

## 本地与节点配置

应用与 Python 研究脚本都读取忽略的 `config/local.json`，环境变量优先。
复制 [配置示例](../config/local.example.json) 后，把需要的占位符换成自己的值，删除不用的可选项。
不能把示例占位符当作真实连接配置。Python 另支持本机 `ECP_LOCAL_CONFIG` 指向其他私有 JSON。

| 变量 | 含义与要求 |
|---|---|
| `RAY_DASHBOARD` | 本机提交作业所用的 HTTP(S) Dashboard 根 URL；无默认值，访问 Ray 时必需 |
| `RAY_JOBS_URL` | 可选 Jobs API 根 URL；未设置时由 Dashboard 拼接 `/api/jobs/`，仍需配置 Dashboard |
| `ECP_CEPH_ROOT` | Ray 节点上的 eagle-culling 项目绝对根目录；不是 references 子目录。脚本在其下拼 `/references`、`/models/onnx`、`/bench/phototriage`、`/research`、`/stress` 等 |
| `ECP_CORPUS_ROOT` | 授权内部论文语料（不公开）的绝对根目录；语料任务必需，不公开真实位置 |
| `ECP_HTTP_PROXY` | 可选外网 HTTP(S) 代理 URL；空字符串表示不设置代理 |
| `ECP_CORPUS_INDEX_PATTERN` / `ECP_CORPUS_TEXT_PATTERN` | 论文扫描的索引/正文相对 glob 布局，示例只含中性默认值 |
| `ECP_CORPUS_INDEX_TEMPLATE` / `ECP_CORPUS_TEXT_TEMPLATE` | 书籍索引/正文相对 glob 模板，`{lang}` 替换为语言 |
| `ECP_CORPUS_ZH_PATTERN` / `ECP_CORPUS_EN_PATTERN` | 研究检索的中文/英文正文相对 glob 布局 |
| `ECP_CORPUS_FACET_PATTERNS` | 多角度检索的相对 glob 列表；配置值为 JSON 数组编码的字符串，路径基于语料根下的 `derived` |
| `EAGLE_LIBRARY_PATH` | doctor/analyze 默认 Eagle 库；显式 `--library` 优先 |
| `EAGLE_EXPECTED_LIBRARY` | Eagle API 预期活动库校验 |
| `EAGLE_LEARNING_LIBRARY` | 删除反馈扫描保护库；只设为自己的测试库或获准使用的库 |
| `EAGLE_PYTHON` | 本地人脸 worker、RAW 解码和 doctor 使用的 Python 可执行文件 |
| `ECP_EVAL_RUN` / `ECP_EVAL_CACHE` | 离线评估的本地结果 JSON/JSONL，不是远端项目根 |
| `ECP_SCORER_FIXTURE` | 手动 scorer parity 所用本地 fixture 目录 |

`HF_HOME`、`TORCH_HOME` 和 `NO_PROXY` 是个别研究入口使用的环境参数，按自己的节点缓存和网络部署配置。
它们不因名称自动转发；需要时由对应作业的 `runtime_env.env_vars` 显式提供。

公共 helper `ml/common/private_env.py` 收集本机配置文件与环境中的 `ECP_*`，合并进每个
Ray 作业的 `runtime_env.env_vars`，保留 working_dir、pip、线程参数和显式作业覆盖。
`ECP_LOCAL_CONFIG` 仅在本机使用，不转发；`RAY_DASHBOARD` 是提交端地址，也不转发。
helper 添加 `ECP_RAY_WORKER=1` 标记执行端，使执行端不能读取节点上的本地 JSON 代替缺失环境。
通过 `exec` 运送源码时会附带独立配置 helper；working_dir 作业包只含代码，不包含本地配置文件。

Ceph/语料作业缺少必需根目录、根目录是相对路径或仍含占位符时立即报错；
Dashboard 未配置时也在请求前报错，禁止默默连接本地地址。
本地路径可不存在（远端挂载不必在提交机上可见），但必须为绝对路径。
纯本地单元测试用显式临时目录和假 Dashboard；测试不调用真实 Ray，也不依赖内部存储。

## Ray 作业提交

提交入口是 `POST <RAY_JOBS_URL>`。作业使用 `runtime_env` 安装依赖；代理为 `<HTTP_PROXY>`。使用 pyiqa 时，entrypoint 必须先修正 OpenCV 包：

```bash
pip uninstall -y opencv-python
pip install --force-reinstall --no-deps opencv-python-headless
```

统一设置 `HF_HOME` 与 `TORCH_HOME` 为 `<MODEL_CACHE>`，避免把模型缓存写入临时盘。entrypoint 中若包含 `$`，提交 JSON 前必须转义，或先将脚本做 base64 编码，在节点解码后执行。

示例（字段按实际脚本补充）：

```bash
curl -X POST '<RAY_JOBS_URL>' \
  -H 'Content-Type: application/json' \
  --data @job.json
```

不要在本记录中提交新的 Ray 作业；这里只保留可复用的提交约定。

远端监听端口与访问方式由部署环境配置；公开版本不包含内部网络路由约定。

## Ceph 目录与权重

项目根目录：

```text
<CEPH_ROOT>/
├── datasets/
├── models/
│   └── onnx/
│       ├── topiq_nr_512.onnx
│       ├── topiq_nr_512.onnx.data
│       ├── topiq_iaa_512.onnx
│       ├── topiq_iaa_512.json
│       └── topiq_iaa_parity.json
└── research/
```

TOPIQ-NR 权重目录为 `<CEPH_ROOT>/models/onnx/`。同步后必须校验：

```text
topiq_nr_512.onnx      bc1f59ca097afadb7c9343fa370d0fe47b0cfe5e21b623957f597a6f2bea08eb
topiq_nr_512.onnx.data 0ab4e4c4da5eb6461357379178e96b06ebfc11105a02c0854598d56b910b2582
```

Mac 上 `.data` 曾出现前 80 MB 损坏、模型分数接近 0 的事件；修复时按 1 MB 分块与 Ceph 比对并补传。不要用复制操作跟随符号链接覆盖主仓库真实文件；`ml/scorer/fetch_weights.py` 会在目标已存在且 SHA 正确时跳过复制，两个文件均校验失败即报错。

## Mac 端检查

在主仓库（不是本 worktree）运行 Node scorer parity 检查：

```bash
node scripts/scorer-parity.mjs
```

Node 使用 `onnxruntime-node`、`intraOpNumThreads=3` 时，M3 Pro 单张约 307 ms；2 线程约 435 ms，768 长边预览输入约 312 ms。CoreML EP 因外部权重初始化失败，当前不采用。


## 本轮 TOPIQ-IAA 操作（2026-10-09）

导出使用 [`ml/eval/export_topiq_iaa.py`](../ml/eval/export_topiq_iaa.py)，固定 512 输入，原版 pyiqa `0.1.16`，网络内部 384 antialias resize 和 mean/std 均保留。POST 提交的 Python 脚本先 base64 编码，entrypoint 在修正 OpenCV 后解码执行；export job 使用 GPU=1，探测/传输 job 使用 GPU=0，未同时运行两个 GPU job。HTTP_PROXY/HTTPS_PROXY 指向 `<HTTP_PROXY>`，HF_HOME/TORCH_HOME 均按本文路径设置。

Ceph 权重随机 seek 加载非常慢。脚本在 `create_metric` 期间将 Ceph 上 torch checkpoint 顺序读入 BytesIO，再调用原始 `torch.load`；创建结束后恢复原函数。临时内存约增加一个 checkpoint 大小，这只在 Ray 导出环境执行，Mac 推理不依赖 torch。没有重写缓存或原始 checkpoint。固定 resize 算子要在同一设备上生成；CPU/GPU 浮点坐标舍入可造成约 1e-5 的像素差，导出脚本验证同设备版本最大差 1.192e-7，并以原版 pyiqa 分数另作精度门槛。

单文件 ONNX 与元数据均在 Ceph `models/onnx/`，没有外部 `.data`：

```text
topiq_iaa_512.onnx 516702434 bytes
sha256 1507e13834b375822b426adcf9984c1d2293d91270c887ff524bde7e32aed1ad
```

本轮直接 HTTP 18876 端口被网络返回 502，已停止临时只读服务；改用 Ray `api/jobs/<id>/logs/tail` WebSocket 传输 gzip/base64 块，每块 1 MiB，记录 offset 与 SHA-256，接收后再做全文件 SHA-256。传输也取回同一批 30 张 AVA JPG 和逐张参考 JSON，未读取或改动 Eagle 原片库。

校验/同步入口（在 model-eval worktree 中执行）：

```bash
nice -n 10 ml/.venv/bin/python ml/scorer/fetch_weights.py \
  --model topiq-iaa-onnx --source /tmp/topiq-iaa-transfer
# --target 可指定另一个仓库的 models/scorer 目录；必须具有该目录写权限。
```

本机所有计算命令均使用 `nice -n 10`。沙箱会拒绝再次 setpriority 并打印提示，但 `os.getpriority(os.PRIO_PROCESS, 0)` 实测为 **10**，继承优先级符合要求。主仓库 `nice -n 10 npm test` 已通过 **50/50**，无 skipped；未 commit/push。

本轮模型已完整同步到 model-eval worktree 的 `models/scorer/topiq_iaa_512.onnx`，整文件哈希再次通过。向主仓库 `models/scorer/` 写入时被当前沙箱拒绝（`PermissionError: [Errno 1] Operation not permitted`）；主仓库只允许写 `node_modules` 的权限配置无法完成该目标，所以主仓库权重同步仍未完成，未通过链接绕过限制。

最终 Mac 延迟、跨机器分差和部署决定记录在 [`docs/model-eval.md`](model-eval.md)。
