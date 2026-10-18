# 本地观察运行时验证（2026-10-16）

本轮接入分类头加载、focus 后观察阶段、阶段缓存与检查器展示。生产头目录只有说明，功能默认关闭。
没有真实训练头，下面的数字仅验证运行时性能与工程正确性，不表示笑或其它属性的识别质量。
未在 Windows 实测。无 Ray 作业，无 AIHub 调用，无依赖改动，无提交。

## 单元实测

只读输入来自 `data/runs/run-0076cf02-981a-44e6-89fd-70995fe57883`，1 个有主体脸的照片单元，
原图旋转后 4672×7008。直接调用管线，不起服务，不操作 Eagle。持有 `/tmp/w29-heavy.lock`，
命令使用 `nice -n 15` 前缀；当前沙箱拒绝设置 nice，沙箱外执行又被 Never 审批策略拒绝，
因此不能证明本次进程实际处于低优先级。模型保留原有两线程设置，只运行此单元的小样本。
所有写入均在本线独立的 `data/cache/observe-runtime/` 下，历史 run 和既有缓存未改写。

使用测试假头，并绑定各本地真实编码器的实际 SHA；输入是原图主体脸 1.8 倍正方形、384 裁剪。
指标、分组输入复用历史结果；先预热既有阶段（包括场景标签的 CLIP 会话）。
比较关闭、冷观察缓存、热观察缓存；这三次跳过已完成的 focus。另清理私有 focus/观察缓存，
验证在 focus 回调内复用原图像素的路径。每种仅一次采样，无统计置信区间。

| 实测 | CLIP B32 量化 | DINOv2 small |
|---|---:|---:|
| 关闭观察的总耗时 | 42.51 ms | 41.20 ms |
| 冷观察缓存总耗时 | 320.36 ms | 433.12 ms |
| 冷缓存增加的总耗时 | 277.86 ms | 391.92 ms |
| 热观察缓存总耗时 | 95.02 ms | 89.19 ms |
| 热缓存增加的总耗时 | 52.52 ms | 47.98 ms |
| 热缓存命中 | 1/1 | 1/1 |
| 热缓存裁剪/推理 | 0 / 0 ms | 0 / 0 ms |
| focus 像素复用时观察自身总耗时 | 84.80 ms | 145.23 ms |
| 其中新增脸裁剪 | 18.36 ms | 19.45 ms |
| 其中真实编码器推理 | 22.89 ms | 82.48 ms |

热缓存仍有每次分析一次的模型 SHA 校验（CLIP 49.61 ms，DINO 45.16 ms），不按单元重复。
两编码器每次都返回 1 条测试观察；热缓存不推理，原图像素复用计数均为 1。
两次实测的 `equalGroups:true`：分组和排序与关闭观察时完全相同。
脚本显式断言热缓存命中，访问生成预览的 LRU mtime 不再使观察缓存失效。

日志：`data/cache/observe-runtime/benchmark-clip/report.json`、
`data/cache/observe-runtime/benchmark-dino/report.json`。假头临时目录在完成后删除。
复现时传入本机已有小任务 ID 和独立缓存目录，并在命令外持有重负载锁：

```sh
nice -n 15 node scripts/benchmark-observations.mjs --run <小任务ID> --encoder clip-b32-q \
  --cache-dir data/cache/observe-runtime/<独立目录>
```

此脚本不会训练头，不写历史 run，不调用线上模型；它读取原图，不导出照片。

## 正确性证据

- 假 logistic 头经标准化及温度校准的正、负输出均为 0.9，误差 <1e-12；
  ReLU MLP 的浮点、int8、gzip int16 little-endian 输出一致。
- 坏 SHA、坏形状、缺字段、校准错误或模型替换均停用该头；无头阶段、计时及推理完全跳过。
- 阈值过滤、全部缓存键字段变化、低置信缓存重算、取消传播、阶段续跑、缓存热命中都有测试。
- focus 测试断言原图入口只调用 metadata 与像素解码两次，观察仅使用回调中的已解码像素。
- 主体人脸匹配含糊时弃权；边缘补黑后始终输出 384×384，未持有第二张原图缓冲。
- 规则优先、稳定去重、最多四项、两个服务端模型下发及检查器隐藏/标记/置信度/位置悬停均有测试。
- 检查器换图复用对应成员的观察；悬停框不发请求，空列表隐藏整个小节。

真实头仍等待训练线提供及逐属性上线验收。规则观察占位由 rules 线合并时替换。

## 检查结果

17 个测试文件逐个串行执行，共 106 项全部通过：
`observation-head`、`observation-runtime`、`inspector-observations`、`run-progress`、`start-ux`、
`inspector`、`inspector-compare`、`inspector-groups`、`inspector-detail`、`ai-tags`、`aesthetic-head`、
`focus`、`focus-jpeg-roi`、`result-cache`、`segmented-results`、`cache-budget`、`style`。
没有运行整个仓库测试套件。`check-public-release` 扫描 631 个文件，0 命中；`git diff --check` 干净。
独立检查器备用 HTML 与主插件检查器保持一致。实测进程已结束，重负载锁已释放，没有启动服务。
