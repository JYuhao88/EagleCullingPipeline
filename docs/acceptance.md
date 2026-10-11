# 验收清单（v1.0）

对照 `docs/product-spec.md` 与交付目标。证据以本机 `mac-ray-dev` 当前状态为准。

| # | 要求 | 如何验证 | 状态 |
|---|------|----------|------|
| 1 | hard cut：无角标桥接/任务心跳；保留 `restore-thumbnails` | `rg` 无 thumbnail-bridge；`node src/cli.js` 含 restore-thumbnails | 已满足 |
| 2 | 架构：`src/core` + contracts + 精简 server + 模块化插件 | 目录结构与 `docs/architecture.md` | 已满足 |
| 3 | 分析：配对/代理/指标/TOPIQ 质量分/分组/排序理由/指纹缓存 | `npm test`；`analyze` 缓存命中；美学权重 0 | 已满足 |
| 4 | 审阅：并排、1/2/3/Enter、闭眼/模糊筛选、组内缩略图条、进度 | `0057689`；`npm test` 插件逻辑 | 已满足 |
| 5 | 写回：仅 AI 标签、幂等、RAW 跟随、可选回收站二次确认 | `apply` 幂等 `changed=0`；写回单测 | 已满足 |
| 6 | 报告 CSV/JSON | `report --format csv\|json` | 已满足 |
| 7 | `npm test` 全绿（macOS） | `npm test` → pass（HTTP 沙箱 EPERM 除外时在本机复跑） | 已满足 |
| 8 | 测试库 E2E：38/38 配对，原片 SHA-256 不变 | `analyze` 输出 38 单元；apply 前后 SHA diff 空 | 已满足（2026-10-09 复测） |
| 9 | 模型评测：KonIQ/AVA SRCC、Mac≤400ms、权重在 ceph | `docs/model-eval.md`：TOPIQ-NR ONNX SRCC≈0.905，Mac≈307ms | 已满足 |
| 10 | 中文文档 + 不碰「未删减」+ Ray 无残留 + 只提交本地分支 | README / architecture / model-eval / mac-ray-ceph / research-culling；Ray Job API 无 RUNNING | 已满足（文档） |
| 11 | 排序质量本地一致率（替代不可得的 Photo Triage） | 抽查页标注 → `spot-check-score` / `fit-ranking-weights` | **待人工标注** |

抽查页：`exports/spot-check/run-1791546991006.html`（gitignore）。导出 JSON 后：

```bash
node scripts/spot-check-score.mjs --run run-1791546991006 --labels <导出.json>
node scripts/fit-ranking-weights.mjs --run run-1791546991006 --labels <导出.json>
```

## 取证记录（2026-10-09 21:33）

- `npm test`：50 pass / 0 fail
- 分析 run `run-1791546991006`：76 files / 38 units all `paired` / 20 groups / scorer `topiq-nr-onnx`
- 写回：`apply --run run-b6da4670-...` 幂等 changed=0；原片 SHA-256 与 apply 前一致
- Ray Job API：无 RUNNING/PENDING
- 分支：`mac-ray-dev`（未 push）
- 本机负载监控阈值已放宽；服务 `43125` health ok；Eagle 4.0.0
