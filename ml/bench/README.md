# 独立评分基准

T-syn 采用缓存代理图，T-triage 采用经过许可核验的官方 holdout；不访问 Eagle API，不写回资源库。
`generate-syn.mjs` 默认读取保存的 `data/runs/run-1791589678002/results.json`，不依赖未知 `good` 文件夹。

```sh
nice -n 10 node scripts/bench.mjs --generate
nice -n 10 node scripts/bench.mjs
nice -n 10 node scripts/bench.mjs --compare data/cache/bench/reports/<时间>/report.json
```

需有现有 pipeline 使用的模型、Python 人脸/姿态依赖、`sharp` 与 ONNX Runtime。
`EAGLE_PYTHON` 未指定时优先 worktree `.venv`，其次主仓 `.venv`；评分器失败保留 `quality: null` 与警告。
本次主仓 Python 缺少 `rtmlib`、`tqdm`，临时安装 `rtmlib==0.0.16` 和 `tqdm==4.70.1` 到 `/tmp/w2-bench-pose`。
基线调用：

```sh
PYTHONPATH=/tmp/w2-bench-pose EAGLE_POSE_PROVIDER=CPUExecutionProvider nice -n 10 node scripts/bench.mjs
```

临时目录失效后需重新提供同版依赖；这不是部署新模型。`--generate` 同样继承这些环境变量。
脚本将本机模型/评分请求限制为串行批次，姿态 worker 数为 1，Sharp 线程为 1，TOPIQ/BLAS 线程最多 2。
本沙箱拒绝 `nice` 的 setpriority，进程仍执行；报告不会宣称成功调低系统优先级。

生成的 JPEG、关键点与分析缓存均位于 gitignore 的 `data/cache/bench/`；fixture 只保存来源、变换、哈希元数据。
按基准固定 pair/series 调用现有评分函数，绕过 grouping/embedding，不能用来评价分组算法。
同分不算 T-syn 正确，另记同分半分统计；T-triage 同分按并列首选平均，避免用 ID 打破平局伪造偏好。
源图及连拍组为 bootstrap 的独立重采样单位，默认 1000 次、seed 42。

T-triage 当前不可用，来源核验、替代许可与 CPU Ray 恢复命令见 [phototriage-provenance.md](phototriage-provenance.md)。
元数据在 `test/fixtures/bench-triage-manifest.json`，本机 cache 证据包含日志分块接回的 SHA256 校验文件。
一键入口优先读取 cache 的 `phototriage/manifest.json`，其次 `provenance.json`，最后 tracked 不可用记录。
恢复图像下载后需依来源文档的契约提供 `status: ready`、已核实许可、validation/test 划分和官方投票标签。

```sh
nice -n 10 node --test test/bench.test.js test/pick-eval.test.js
```

### W5 像素候选规则敏感性

```sh
nice -n 10 node ml/bench/generate-syn.mjs --w5
nice -n 10 node scripts/bench.mjs --w5 --compare data/cache/bench/reports/2026-10-10T05-56-30-237Z/report.json
```

输出扩展清单位于 `data/cache/bench/w5-manifest.json`；原始 tracked 清单与既有 JPEG 不变。生成三种各轻/重两档的实验退化，人物相关退化只接受符合 candidatePerson 有效性条件的已有源图姿态。默认 `--generate --w5` 也可生成该扩展清单。

W5 回放按基线 analysisSignature + 输入 SHA256 读取缓存；缺少任一既有项即失败，不冷跑模型。新增图只重算像素 metrics 与候选测量，固定复用源图 TOPIQ/人脸/姿态，以明确的 oracle 几何检验测量敏感性。默认排序未接入候选；新增图的冻结模型排序数值不是完整模型重测结果。连续量可测覆盖与经过夜景/高调/TOPIQ 等保护后的提示可判定覆盖分别报告。

`--compare` 在父清单哈希与每个原始 pair 的 id/sourceId/degradedId/sha256/degradation/strength 全部一致时才接受附加 pair；既有总体、每类、严重档 gate 与源图误淘汰比较只使用原始同输入子集。扩展总体另列，不能与原始不同组成总体直接认作回归。新增规则无 gate，新增类别也不声明强制拒绝。
