# Windows 分析进程树资源实测

## 可复现只读命令

```powershell
powershell -NoProfile -ExecutionPolicy Bypass -File scripts/measure-analysis-resources.ps1
# 500 文件：每种 JPG/ARW/HEIC/3FR 取最多 125 个
powershell -NoProfile -ExecutionPolicy Bypass -File scripts/measure-analysis-resources.ps1 -PerFormat 125
```

命令只启动现有 `audit-real-analysis.mjs --semantic --adjacent --high-quality`，使用随机端口的分析服务，不替换当前 Eagle 服务。审计读取真实资源库的 20 个混合格式文件，模型分析合并为 10 个拍摄单元；报告和日志只写新建的系统临时目录。

默认 `PerFormat=5`；可传正整数扩大样本，非正数在启动分析、创建临时目录前拒绝。每格式是否有足够文件以实际报告为准，不把请求样本数当已测数量。不是插件的照片选择限制。

采样以该审计 Node 进程的真实 PID 为根，通过父子关系识别 Python 模型和 venv 启动器；不把其他 Python 程序或旧 Eagle 服务计算到进程树内存。保留根进程 OS 句柄直到退出，并记录退出码。监测失败会明确记入报告，不会杀掉分析或 Eagle。

## 2026-10-09 实测

成功报告：`C:/Users/Yuhao/AppData/Local/Temp/eagle-resource-audit-218f13d6fed74e6db92b7f32e0ecc33b/resources.json`。关联分析报告：`C:/Users/Yuhao/AppData/Local/Temp/eagle-real-analysis-qj2QTj/report.json`。

| 指标 | 观测值 |
| --- | --- |
| 审计退出码 / 监测错误 | 0 / 无 |
| 总耗时，含读取校验与监测开销 | 10,071ms |
| 进程树工作集观测峰值 | 779.2MiB |
| 进程树私有内存观测峰值 | 993.1MiB |
| 单个 Node 工作集观测峰值 | 约 262MiB |
| 单个 DINO Python 工作集观测峰值 | 约 357MiB |
| 两个人脸 Python 工作集各自观测峰值 | 约 128 / 129MiB |
| 所有进程最后观测累计 CPU 时间之和 | 18,609ms |
| 冷分析 / 重复分析 | 4,655 / 277ms |
| 原片 SHA-256 / 元数据字节未变 | 20 / 20 |

累计 CPU 时间可大于墙钟时间，因为有多个进程/线程并行；包含读原片进行完整性校验，不能当作纯模型 CPU 耗时。

GPU 为 RTX 4070 Ti SUPER，`nvidia-smi` 可见总显存 16,376MiB。采样前整机使用 4,581MiB，过程中整机观测最高 4,747MiB、利用率最高 17%。这是包括 Eagle、桌面等的整机计数，增加的 166MiB 不能当作模型显存分配量，也不能证明模型峰值显存只有这些。DirectML/WDDM 下未得到可靠的逐模型显存归因。

### 并行图片解码与技术评分 v3 后复测

报告 `C:/Users/Yuhao/AppData/Local/Temp/eagle-resource-audit-9238700149fe41bd97d59fb4dc590088/resources.json`，关联 `C:/Users/Yuhao/AppData/Local/Temp/eagle-real-analysis-JRWhz7/report.json`，分析报告 UTC `2026-10-08T20:22:21.862Z`。仍为 20 文件/10 拍摄单元，独立服务只读；退出 0、监测无错误、16 次资源采样，总墙钟 11,386ms（含 SHA 校验/监测）。进程树工作集观测峰值 804.9MiB、私有内存 1,024.2MiB；Node 进程工作集采样峰值约 560MiB，分析内置更频繁 RSS 采样为 602MiB，两种采样不能混作同一个严格峰值。冷分析 5,869ms、0 分析失败、检出 5 张脸，20 个原片 SHA 和元数据字节全部未变。

整机 GPU 基线 4,555MiB、观察到最高 4,738MiB、利用率最高 15%；仍不是逐模型显存归因。复测时另一隔离 PyTorch 环境的下载/安装正在运行，未进行 CUDA 模型推理，因此本次不是排除后台活动的纯性能基准。小样本能够运行不等于全库持续压力验收。先前 779.2MiB 是旧调度下的历史观测，不应当作新解码并行度下的内存保证。

### 500 文件进程树复测（当前技术评分 v3）

命令 `-PerFormat 125` 成功退出 0，监测无错误。报告：`C:/Users/Yuhao/AppData/Local/Temp/eagle-resource-audit-3d647d29e0494185be838fec145820dd/resources.json`；关联分析：`C:/Users/Yuhao/AppData/Local/Temp/eagle-real-analysis-chYhra/report.json`，UTC `2026-10-08T20:33:12.979Z`。

| 指标 | 观测值 |
| --- | --- |
| 文件 / 拍摄分析单元 | 500 / 250 |
| 首次分析 / 重复分析 / 全样本聚类暂存 | 36,129 / 6,548 / 306ms |
| 总墙钟，包含原片前后 SHA 校验和采样 | 154,628ms |
| 进程树工作集 / 私有内存观测峰值 | 1,274 / 1,549.1MiB |
| Node 工作集观测峰值 / 内置 RSS 采样峰值 | 约 631 / 636MiB |
| DINO / 两个人脸 worker 各自工作集观测峰值 | 约 372 / 147 / 152MiB |
| 分析失败 / 元数据变化 / 原片 SHA 变化 | 0 / 0 / 0 |
| 解码活动峰值 / Sharp 每图线程 | 4 / 2 |
| DINO / 人脸模型进程启动次数 | 1 / 2 |
| 语义缓存重复命中 / 实际推理单元 | 250 / 250 |

所有结果为 `preview-v3-technical-only`，主体/构图指标均为未评估空值；250 个语义向量有效，重复分析向量一致。结束时图片、人脸、语义、聚类队列全部排空。工作集和私有内存不是同一口径；进程树峰值不能用各进程不同时刻峰值简单相加代替。

237 个采样点，实际相邻间隔平均 652.6ms，范围 592.1–997.4ms；每轮采样平均开销 444.6ms。因此短时峰值仍可能漏采。累计最后观察的进程 CPU 时间 456,828ms，包含原片哈希；多线程 CPU 时间可超过墙钟，不能当作模型推理用时。

整机 GPU 基线 4,655MiB、利用率 72%，过程中整机观察最高 4,739MiB / 79%。有其他桌面/后台负载；不能把显存差额当模型占用，也不能宣称本次是独占 GPU 测试。首次为新工具缓存和模型会话，操作系统缓存未清空。

本机能完成此规模的只读分析和缓存复用，不意味着全库/极端解码/长期运行、真实 Eagle 写回和 UI 流畅度已达标；照片筛选准确率仍无人工真值。生产服务/旧角标未由本次测试改变。

## 采样精度与性能边界

配置采样等待间隔 200ms，但 CIM 进程树发现与 GPU 查询需要时间。此次 15 个样本，实际相邻间隔平均 653ms，范围 590–840ms；每轮采样耗时平均 441ms。另行检查 CIM 发现约 467ms，GPU 查询约 67ms。因此不得称为“200ms 精度”，也可能漏掉短时内存和显存峰值。监测工具不接入生产分析热路径。

工作集相加可能重复计算共享页面，不是独占物理 RAM；私有内存是另一种口径，也不等于当前驻留内存。报告保存每次原始样本、每个 PID 的起始时间与最后观测 CPU，不将不同口径混为一个资源上限。

这个样本说明当前机器能运行两个人脸模型加一个 DINO DirectML 模型，并完成真实混合预览分析；不证明全库长时间运行、高并发原图解码、最极端照片、GPU 其他应用竞争时全部达标。仍需 500/全库持续负载、更多分辨率和多人场景、缓存增长和准确性验收。

当前生产端口仍返回 0.3.0；这次测量没有完成部署，也没有恢复旧角标。Computer Use 技能存在，但当前会话没有它要求的 `node_repl` 控制通道，不能因此宣称已经操作或检查真实 Eagle 界面。
