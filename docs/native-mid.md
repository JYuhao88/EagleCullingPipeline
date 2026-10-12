# 看图器本机高清缓存

`src/core/native-mid.js` 在 `data/cache/native-mid/` 保存方向归一的 JPEG。
源文件和派生图仅在本机处理；不调用云端，不写回 Eagle，不修改原片。
键为 SHA-256，包含主文件和配对文件的路径、size、mtime、版本、长边、JPEG 质量及解码器配置。
文件内容路径不写入公开测试或报告。JPEG 和 metadata 各自原子 rename，metadata 最后发布。
清理按 JPEG 最近访问时间执行 LRU，统计 JPEG 与 metadata 总字节，只清理该独立目录。

配置通过环境变量或不入库的 `config/local.json`，值使用字符串：

| 配置 | 默认 | 范围 |
|---|---:|---:|
| `EAGLE_NATIVE_MID_EDGE` | 6144 | 512–8192 |
| `EAGLE_NATIVE_MID_QUALITY` | 96 | 80–100 |
| `EAGLE_NATIVE_MID_MAX_BYTES` | 2147483648 | 0–34359738368；0 禁用 |

JPEG 使用 4:4:4 色度采样，不放大小图。它是有损显示缓存，不能用于评分或原生 focus。
`GET /runs/:id/native/:unit?box=...&width=...&height=...` 新增物理显示像素需求。
客户端对向外吸附的整个裁块计算 `width/height`，包含 devicePixelRatio。
仅当两个方向的需求都不超过缓存区域分辨率，且均小于原图区域像素的 90% 时使用缓存。
缺参、无效参数、缓存未就绪/损坏或接近 1:1 时保留既有原图裁块，不放大缓存代替原图。
`x-native-tier: mid|original` 暴露给客户端，显示「高清缓存」或「原图」；加载仍显示「读取原图…」。
原图路径仍使用既有局部 JPEG 96 缓存；“原图”表示原生分辨率，HTTP JPEG 不是无损字节。

`POST /runs/:id/native/:unit/prefetch` 保持请求直到后台预取完成，返回
`available/cached/width/height/naReason`；不返回本机路径。
打开看图器预取当前与同组相邻照片，客户端逐张发送；切换和关闭中止过期 fetch。
整个预取队列并发 1，使用原生解码的低优先级队列，等待前台解码空闲，不占用第二个解码槽。
有活动分析时直接返回 `analysis-busy`，分析开始时中止在途预取。
工具进程可中止，sharp 单次调用只能在返回边界取消；取消后不发布未完成缓存。
缓存裁块直接返回内存 JPEG，不额外保存每个平移区域。

实测入口（调用者先取得 `/tmp/w22-heavy.lock`）：

```sh
nice -n 15 node --max-old-space-size=2048 scripts/bench-native.mjs <local-run-id>
```

此脚本只在 43331 启动服务，结束时关闭；从指定 run 选大 JPEG 配对单元。
只清除被测单元自己的 native-mid 键；原图裁块放私有临时目录，退出时清理。
记录冷区域、预取、五次热区域、1:1 tier、PSNR/最大误差/MAE、Node RSS 与原片 SHA-256 不变。
一致性比较为冷请求的原生裁块缩放到相同显示尺寸，与热缓存裁块的 RGB 差异；
缓存图先整图缩放再裁剪，有 JPEG 误差及亚像素裁块取整差异，不能承诺像素完全一致。
RSS 为 Node 进程指标，不包含 exiftool/解码器子进程。实测与回归证据在下方补充。


## 本机接口实测

在全局锁内运行上述入口，端口 43331；源为 7008×4672 的 embedded-jpeg，
缓存 4096×2731，区域 `[0.25,0.25,0.5,0.5]`，显示 800×533。
本样本约 3274 万像素，不是背景描述的 6000 万像素，耗时不能替代其它源/解码器的测量。
“冷”指该单元没有 native-mid 和局部裁块缓存，不表示操作系统磁盘缓存已清空。

| 阶段 | 实际耗时 | Node 阶段峰值 RSS |
|---|---:|---:|
| 冷区域，original | 757.66 ms | 166.55 MiB |
| 预取 | 653.49 ms | 307.31 MiB |
| 热区域，mid，5 次 | 118.70 / 125.02 / 112.67 / 96.55 / 111.40 ms | 318.89–328.22 MiB |

热请求中位数 112.67 ms，相对冷请求约 6.72 倍；整个 Node 进程最大 RSS 332.31 MiB。
比较同尺寸 RGB：PSNR 47.8856 dB，最大通道误差 9/255，平均绝对误差 0.66357/255。
这些一致性数字限该样本/区域，未验证所有照片或 RAW 解码器；不用于证明评分变化。
1:1 请求返回 `original`；被测主/配对原片前后 SHA-256 均不变。
服务在脚本 finally 中关闭，局部裁块临时目录删除，只留下该单元的本机 native-mid 缓存。
所有命令请求 nice 15；沙箱拒绝调整，实际进程 nice 20。RSS 不包含子进程。

## 默认长边 6144

Retina（devicePixelRatio 2）下 Z 首次放大到 2.5×，实测请求为区域
`[0.28125,0.28125,0.71875,0.71875]`、显示 1480×1974，约为 33 MP 原图区域的 68%、
100 MP 的 40%，未接近 1:1。4096 长边的缓存只有 1344 px，覆盖不了，于是退回原图：
100 MP HEIC 实测 3669 ms。改为 6144 后，同一请求的结果（582 张资源库中的 8 个单元）：

| 源 | 预取（冷） | 首次放大 | 再次放大 |
|---|---:|---:|---:|
| 100 MP HEIC，缓存 4608×6144 | 10.9 s | mid 821 ms | mid 421 ms |
| 33 MP embedded-jpeg，缓存 6144 长边 | 1.5–2.4 s | mid 260–738 ms | mid 308–752 ms |
| 2240×3360 JPEG（已超 1:1） | 4.9 s | original 588 ms | original 15 ms |

缓存文件 6–14 MB，2 GiB 上限约 200 张。比原图分辨率低于 1:1 的源仍读原图。

## 验证边界

定向命令：

```sh
nice -n 15 node --test test/native-mid.test.js
nice -n 15 node --test test/viewer.test.js
nice -n 15 node --test test/native-image.test.js
nice -n 15 node --test test/style.test.js
```

缓存/接口 8 项、viewer 7 项、既有原生取像 4 项通过；换行修正后 style 1 项通过。
第一次完整回归为 457 pass / 1 fail / 1 skip，148.99 秒；唯一失败为新增文件的 8 处超长行，
已经修正。skip 为系统 Python 的本地 pose smoke 缺依赖/模型，不计作模型通过。

本轮真实执行的质量命令（在全局锁内）：

```sh
EAGLE_PYTHON=python_worker/.venv/bin/python EAGLE_POSE_PROVIDER=CPUExecutionProvider EAGLE_BENCH_CACHE_ONLY=1 nice -n 15 node --max-old-space-size=2048 scripts/bench.mjs --compare data/cache/bench/reports/2026-10-12T02-17-07-342Z/report.json
```

返回 `Cache-only benchmark refuses 388 cold images`，退出码 1，未产生可比较的新报告。
当前基树的 metrics/faces/pose 已不同于最新基线对应源码；本轮没有改动这些文件或评分/分组逻辑。
因此本线单独未完成评分门槛。三线合并后在 Ray 冷算 388 张（签名 `880ac430…`），
cache-only 比较三项 delta=0、368 行 unchangedRows=true。
没有本机整批冷算，也没有把照片或派生图发送到 Ray/云端；需要由有当前签名缓存的受控环境补齐。

最终完整回归（取得全局锁后，串行测试文件）：

```sh
EAGLE_PYTHON=python3 nice -n 15 node --max-old-space-size=2048 --test --test-concurrency=1 --test-skip-pattern='fixture face detection recall|fixture grouping reaches'
nice -n 15 node scripts/check-public-release.mjs
nice -n 15 git diff --check
```

**458 pass / 0 fail / 1 skip，459 项，148.24 秒**；最终源码包含取消时机与 cache-limit 修正。
公开检查 499 文件、0 命中，diff check 通过。重负载均持有全局锁；回归期间轻量日志读取与
静态检查有交错，没有并行执行本线的两个重负载。没有修改依赖、提交或 push，未启动 Ray 作业。
未完成：3FR/其它 RAW 解码器的像素与资源实测；100 MP HEIC 的计时见「默认长边 6144」。
