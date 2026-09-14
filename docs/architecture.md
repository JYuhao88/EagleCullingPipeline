# 技术架构与实现边界

## 数据流

```text
Eagle Plugin
  ├─ 选择扫描范围
  ├─ 读取 item.id / filePath / tags / folders / star / modifiedAt
  ├─ 启动本地 worker
  ├─ 展示结果和原因码
  └─ 人工确认后 save() / moveToTrash()

本地 Worker
  ├─ 当前可运行：Node.js + sharp 读取 Eagle .info 图片
  ├─ SHA-256 / pHash / 梯度清晰度 / 直方图曝光
  ├─ 本地 HTTP 服务：127.0.0.1:43125
  ├─ 可插拔：Python/ONNX MediaPipe、DINO、TOPIQ/LIQE、Q-Align
  └─ SQLite/JSON 结果缓存
```

## 结果记录

```text
item_id, file_path, file_sha256, phash,
embedding_model, embedding_version,
sharpness_score, face_count, face_sharpness_score,
eyes_closed_probability, exposure_score,
composition_score, subject_score, aesthetic_score,
overall_score, confidence, duplicate_cluster_id,
review_status, analyzed_at
```

使用 `item_id + modifiedAt + model_version` 做增量分析键。写回前重新读取 `modifiedAt`，发现用户已修改则跳过并提示。

## 目录约定

- `src/plugin/`：Eagle Window/Background Plugin。
- `src/image-analyzer.js`：当前 Node.js 基线分析器和 pHash 聚类。
- `src/server.js`：供 Eagle 插件调用的本地分析服务。
- `python_worker/worker.py`：可选 GPU TorchScript worker；必须显式提供本地 checkpoint，不隐式联网下载。
- `data/results.sqlite`：本地结果数据库，不提交 Git。
- `data/cache/`：代理图和模型缓存，不提交 Git。
- `docs/`：研究和设计文档。

## 实现原则

1. 默认只读分析。
2. 标签采用 `ai/` 前缀，并合并而不是替换用户标签。
3. 默认不覆盖人工评分。
4. 删除只调用 Eagle 回收桶能力，不直接删除文件。
5. 所有模型、阈值和结果可版本化、可重算。
6. 使用 Eagle 官方 API，不直接写 `metadata.json`。
