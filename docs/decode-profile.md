# Focus：块对齐局部 JPEG 的等价优化

## 当前结果

默认 focus 已接入块对齐局部 q96 JPEG：先用原 `withNativeImage().image()` 完成一次解码/方向变换，
只对每个 ROI 外扩到整图坐标的 8×8 块边界后编码 q96，再解码按 ROI 偏移裁回，
保留原 ROI 默认 q80 JPEG 和 `focusMetrics()` 计算。

512 个随机图/ROI 比较（奇数尺寸、四边、极小图、8 种 EXIF 方向）逐像素相等；
真实 18 个成功单元的 73 个 ROI Buffer 相等。
最终默认函数 A/D/A/D 两轮，每轮 20/20 focus 结果 JSON deepEqual，含 18 个成功单元和两个不可用 HEIC。
逐脸、眼部清晰度、尺寸、状态、naReason、AF 字段、relativeRank 均一致；两次 A、两次 D 各自也 deepEqual。

此前直接删除两层 JPEG 的 B 实验产生数值差异，已停止；本次保留有损处理，只缩小编码区域，
不会将 B 方案的近似输出带入默认路径。

## 编码/解码前提核对

本机 Sharp 0.33.5、libvips 8.15.3、MozJPEG 4.1.5；读取 `.jpeg({quality:96,chromaSubsampling:'4:4:4'}).options`：

| 项 | 实际值 |
|---|---|
| quality / chromaSubsampling | 96 / 4:4:4 |
| progressive | false |
| mozjpeg preset | 未启用 |
| trellisQuantisation / overshootDeringing / optimiseScans | false / false / false |
| optimiseCoding | true（Huffman 熵编码，不改变量化系数） |
| quantisationTable | 0 |
| keepMetadata / output colourspace | 0 / sRGB |

核对 Sharp `lib/constructor.js`、`lib/output.js`、`src/pipeline.cc`，以及匹配版本的
[libvips vips2jpeg.c](https://github.com/libvips/libvips/blob/v8.15.3/libvips/foreign/vips2jpeg.c#L567) 和
[MozJPEG jcparam.c](https://github.com/mozilla/mozjpeg/blob/v4.1.5/jcparam.c#L459)：
libvips 在 `jpeg_set_defaults()` 前选择 JCP_FASTEST，关闭 MozJPEG 的 max-compression trellis/overshoot 默认；
smoothing_factor=0。内部 trellis_quant_dc 虽初始化为 true，trellis_quant=false 时该优化不启用。
4:4:4 不发生跨像素的色度下采样；原完整解码没有 resize，保留 Sharp 原解码设置。

方向完全复用原 `image()`：2/4/5/7 先 flop，3/4→180°，5/8→270°，6/7→90°。
JPEG 保存的默认 sRGB 转换和去元数据在 raw 物化时等价复现；只对 8 位、3 通道 JPEG 原生源启用。
其他格式/深度/通道或 JPEG 默认编码参数发生变化时回退原整图 q96 路径。
不会强制改变现有编码选项来换取等价。

第一版直接在 `image().flop().rotate(0)` 后 `.extract()`，在 orientation 2 下失败：
Sharp 的 flop-only 管线会先 extract 后 flop，裁错的是区域而不是 JPEG 块理论。
现实现先物化 upright raw，再裁块；512 个比较和默认函数 8 方向测试均通过。

## 改动边界

- `src/core/focus-jpeg-roi.js`：8 像素对齐、局部 q96 往返、原 ROI q80、运行时编码前提检查。
- `src/core/focus.js`：可选 ROI JPEG 提供函数和 `analyzeFocusFromNativeImage()`；旧 nativeBuffer/nativePath 调用保持旧语义。
- `src/core/pipeline.js`：仅原生 callback 内调用新入口及 import；未动并发、调度、检查点或 focus 缓存键。
- `scripts/profile-focus.mjs`：A/B、A/C、A/D 独立进程交替测量；D 直接调用默认入口。
- `scripts/check-focus-jpeg-pixels.mjs`：真实只读 ROI 像素比较及差异位置采集。
- `test/focus-jpeg-roi.test.js`：编码前提、512 像素比较、q80 字节比较、8 方向默认 focus/PNG 回退/无 faces 比较。
- `test/profile-focus.test.js`：保留前轮 A 计时等价和错误 B 的拒绝测试。

没有修改 native-image.js 的原生解码或调度；没有改 metrics/scorer、模型、阈值、分组、规则。
保留 `analysis-v6-exposure-gates` 与 focus-v3 原缓存语义，已有分析缓存不需失效。
没有添加跨单元像素缓存或磁盘派生图缓存；每单元只保留一份 upright raw 和当前 ROI 临时缓冲，
callback 结束后不再持有它们。原 160,000,000 input pixels 上限和原生 workerLimit 保持不变。
33 MP 测试源 raw 为 98,224,128 字节（93.67 MiB）；Sharp 既有有界缓存策略未在生产路径改动。

## 同环境 A/D/A/D 实测

样本 `run-1791589678002`：6 个 2240×3360 JPEG、12 个约33 MP JPEG/RAW 配对、2 个100 MP HEIC/3FR配对。
成功原生源为6个 JPEG、12个 embedded-JPEG；两个 HEIC 的 sips 产物 corrupt header，rawpy 也不可用，
每轮返回 native-source-unavailable，未视为成功解码。

A 是旧的完整 q96 再逐 ROI q80 路径；D 是默认入口，不是另一个简化的实验计算器。
同一20单元四轮源文件 path/size/mtime 一致；各轮 Eagle 活动库在开始/结束均与 run 库路径一致。
全部照片只在本机处理；报告存 `data/cache/w23-decode/`，未上传。

每轮独立 Node 子进程，Sharp concurrency=1、memory cache=32 MiB、items=10、单元间显式 GC，A/D 相同；
macOS 后台 QoS。`nice -n 15` 被执行，但沙箱打印 setpriority 拒绝，未核实实际 nice 值。
以下 RSS 是独立 Node/Sharp 进程峰值，不含 exiftool/sips，不是整条分析流水线的 RSS。

| 配对轮 | A focus 总秒 | D 默认总秒 | 耗时变化 | A Node RSS MiB | D RSS MiB | RSS 变化 |
|---|---:|---:|---:|---:|---:|---:|
| 1 | 53.374 | 24.359 | -54.36% | 691.55 | 326.36 | -52.81% |
| 2 | 41.890 | 23.057 | -44.96% | 670.84 | 352.34 | -47.48% |

包括两个失败 HEIC 的降级耗时。18 个成功单元四轮总秒分别为 49.368/20.152/37.979/18.361。
A1 maker-note 明显慢于其余轮（6.812 s 对 2.1–2.4 s），存在启动/系统噪声，不能全部归因于编码优化。
排除抽取/maker-note，仅原生取像后处理，A1/A2 为 36.382/29.509 s，D1/D2 为11.209/10.610 s。
不以这些后台绝对数字外推主代理的前台吞吐；主代理可用同脚本前台复测。

子步骤累计秒；包含关系不重复相加：

| 子步骤 | A1 | D1 | A2 | D2 |
|---|---:|---:|---:|---:|
| Maker-note | 6.812 | 2.388 | 2.132 | 2.233 |
| RAW 尺寸/方向 | 1.564 | 1.411 | 1.413 | 1.189 |
| 内嵌 JPEG 抽取及失败尝试 | 6.802 | 7.535 | 7.000 | 7.110 |
| HEIC sips（未成功） | 1.526 | 1.491 | 1.493 | 1.649 |
| 整图解码/方向/q96 JPEG | 24.981 | — | 20.074 | — |
| 旧逐 ROI 源解码/裁块/q80 | 10.363 | — | 8.339 | — |
| 默认一次解码＋全部 ROI 总计 | — | 11.209 | — | 10.610 |
| 默认块对齐 q96＋解码偏移裁块＋q80 | — | 1.043 | — | 0.891 |
| ROI q80 解码/resize/灰度 | 0.579 | 0.568 | 0.676 | 0.589 |
| 清晰度数值计算 | 0.436 | 0.518 | 0.393 | 0.485 |

libvips 原管线融合 decode/orient/encode，计时 A 保持原执行方式；前轮独立拆解探针
`focus-probe-b93By7/probe.json` 检查 raw 像素和完整 q96 JPEG 字节相等：
小 JPEG decode/方向/编码 179.626/77.844/316.909 ms；33 MP embedded-JPEG 为297.586/394.117/1175.296 ms。
该探针不混入本次 A/D 的性能或 RSS。

## 一致性与证据

- `aligned-pixels-rT8vsO/report.json`：18成功单元，73/73 ROI Buffer 相等；两个 HEIC不可用。
- `focus-abab-GMpLEa/`：实验 A/C/A/C，两个配对全部20/20 deepEqual。
- `focus-abab-0rJyjh/`：最终 A/D/A/D，两个配对全部20/20 deepEqual，A重复/D重复各自一致。
- `focus-abab-0rJyjh/difference-summary.json`：冻结291单元其余分析字段，替换 A/D focus 重放，
  84组的 unitIds、ranking、confidence/margin、suggested、candidateSet deepEqual。

这些是本机只读原生阶段及冻结特征回放，不是完整重新运行所有视觉模型的端到端验收。

## 可复现命令

```sh
nice -n 15 sh -c '
  until mkdir /tmp/w23-heavy.lock 2>/dev/null; do sleep 15; done
  trap "rmdir /tmp/w23-heavy.lock" EXIT
  FOCUS_PROFILE_VARIANT=default node --max-old-space-size=2048 scripts/profile-focus.mjs
'
# 真实像素检查也在同样的锁内串行运行：
nice -n 15 node --expose-gc --max-old-space-size=2048 scripts/check-focus-jpeg-pixels.mjs
# 不跑视觉模型的报告/冻结特征回放：
nice -n 15 node scripts/profile-focus.mjs --summarize data/cache/w23-decode/focus-abab-0rJyjh
nice -n 15 node --test --test-concurrency=1 test/focus-jpeg-roi.test.js
```

脚本每轮子进程125秒超时，4轮合计控制在10分钟锁窗；本线锁在测量结束后释放。
临时计时模块只在自身 worktree 的 src/core 下生成，结束删除；没有启动服务或动其他线端口。
报告带真实路径，只保存在共享缓存本线子目录，不加入仓库。

## 质量检查与限制

`bench.mjs` analysisSignature 白名单为 metrics/scorer/ranking/faces/pose/signals/rules/candidate 等源码，
不包含本轮 focus.js、pipeline.js 或新 helper；白名单文件均未修改。
因此条件式 Ray 冷算门槛不触发，没有提交 Ray 作业，也不声称另外取得三项delta=0/unchangedRows。

默认功能已实现并取得逐像素及逐字段证据；尚无成功100 MP HEIC focus或Windows实机测量。
非RGB JPEG路径保留旧行为；Windows provider选择和缓存键未改动。
最终指定锁内完整回归：475 tests、475 pass、0 fail，206.994 秒。
fixture face recall/grouping 被指定 skip-pattern 排除，不能将汇总 skipped=0 理解为这两个 fixture 已执行。
公开检查、diff结果见下面的最终复核；未 git commit。

```sh
nice -n 15 sh -c '
  until mkdir /tmp/w23-heavy.lock 2>/dev/null; do sleep 15; done
  trap "rmdir /tmp/w23-heavy.lock" EXIT
  node --max-old-space-size=2048 --test --test-concurrency=1 \
    --test-skip-pattern="fixture face detection recall|fixture grouping reaches"
'
nice -n 15 node scripts/check-public-release.mjs
nice -n 15 git diff --check
```

最终公开发布扫描 scanned=517、removed=0、hits=0，记录在本机 `/tmp/w23-aligned-public.json`；diff check 返回0。
本线默认测量、像素检查、完整回归均完成并释放本线锁，临时计时模块已删除，没有启动服务。

## 合并后前台复测（主代理，2026-10-12）

合并姿态线程与本优化后，前台 38 单元独立冷缓存，`python3 scripts/bench-performance.py --mode normal --label fg-merged-normal`：
总耗时 50.8 s（仅姿态线程时 58.5 s，修改前 77 s），Node 峰值 RSS 1.51 GiB（之前 2.10 GiB）。
`node scripts/compare-performance.mjs fg-fix-normal fg-merged-normal` 报告 `identical: true`。
