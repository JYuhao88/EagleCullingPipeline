# Windows 本地观察 GPU 实测

本页记录 `w34-wingpu` 在 RTX 4070 Ti SUPER（16 GiB）上的短测。测试只使用从 `data/cache/observe/p1-panel/face/` 复制到本线缓存的 786 张 Open Images 脸裁剪；没有读取家庭照片，也没有连接或重启稳定服务。Node 为 24.14.1，`onnxruntime-node` 为 1.24.3，运行时列出 `cpu`、`dml`、`webgpu` 三个后端。每个进程设为 BelowNormal，开始前 GPU 利用率为 0%、CPU 总负载约 5–12%。显存是全设备采样值，包含桌面和其他程序，不是本进程独占值。

## 量化 CLIP B/32（已部署观察头）

模型是 `clip-b32-q`，SHA-256 为 `583fd1110a514667812fee7d684952aaf82a99b959760c8d7dca7e0ab9839299`。输入沿用观察头的 224×224 CLIP 归一化。CPU 两次短测的结果如下，第二次为 786 张完整留出面板：

| provider | 首次会话加载 | 热推理均值/中位数/P95 | 786 张预处理加推理 | 采样显存峰值 | GPU 利用率峰值 |
| --- | ---: | ---: | ---: | ---: | ---: |
| CPU | 188–205 ms | 14.0–14.1 / 13.6–13.7 / 17.2–17.3 ms/脸 | 20.0–20.4 s | 3,336 MiB | 0–5% |

显式 `dml` 在量化图的会话初始化阶段使 Node 进程以 Windows `0xC0000005`（access violation）退出，没有结果文件。因此 DML 没有可报告的延迟、显存、余弦或 786 张头部 show/no-show 对照；不能把崩溃当作 parity 通过，也不能替量化头发布 DML 结果。量化图在这台机器上继续使用 CPU。

## 较大 fp16 编码器探测

为满足模型尺寸探测，使用公开的 `onnx-community/siglip2-base-patch16-224-ONNX` 固定 revision `ba1f3b0843f24bc5417d38e19c37b287d719b2f4` 的视觉 fp16 文件，文件 SHA-256 为 `a1959f7bd3993a607e48839f6d01e25b876fe76afda301b028b78eef68aabd95`（约 186 MB）。这是独立的 768 维 SigLIP2 编码器，不是 `clip-b32-q`，也没有为它训练或发布观察头。

ORT 的默认优化级别在该 fp16 文件上初始化失败，错误指向 `InsertedPrecisionFreeCast...SimplifiedLayerNormFusion`。使用 `graphOptimizationLevel=disabled` 后可运行；64 张脸的低优先级短测如下：

| provider | 首次会话加载 | 热推理均值/中位数/P95 | 64 张预处理加推理 | 采样显存峰值 | 采样 GPU 利用率峰值 |
| --- | ---: | ---: | ---: | ---: | ---: |
| CPU | 220 ms | 158.4 / 156.3 / 170.3 ms/脸 | 11.0 s | 3,336 MiB | 0% |
| DML | 720 ms | 247.6 / 246.2 / 254.5 ms/脸 | 22.4 s | 3,336 MiB | 0% |

CPU 与 DML 的 64 个输出余弦为最小 0.5774、均值 0.7158（`basic` 优化级别的 8 张复核为最小 0.7127、均值 0.7433）。ORT 同时提示部分节点没有分配给首选 provider；这里没有把低采样利用率解释成 GPU 加速。该编码器在这套 Node/ORT 图上远高于约 30 ms/脸，也不能作为现有头的替代。

## 配置与建议

观察用的 CLIP 会话只走 CPU。本轮没有合并 DirectML 开关：量化图在 DML 上初始化即崩溃，SigLIP2 fp16 在 DML 上比 CPU 更慢且输出与 CPU 不一致。
CPU 上量化 CLIP 约 14 ms/脸，已满足需求；更大编码器在 CPU 上约 158 ms/脸，若将来验收通过，一批 291 张约多 46 秒，仍可接受。
真正利用这张显卡需要 CUDA 版推理运行时，这会新增依赖，需另行评审。

测量命令使用仓库内 `scripts/windows-observe-gpu-bench.mjs`（`--provider cpu|dml` 只用于实测），输出只应保存在本地缓存目录；benchmark 进程完成后需确认没有残留的 Node/PowerShell 子进程。
