# Photo Triage 官方来源核验（2026-10-10）

T-triage 本次不可运行，组数为 0，top-1、强偏好成对准确率、bootstrap CI 都为 `null` / N/A。未将缺失数据记为 0% 准确率，也未以汕头/Eagle 文件夹名替代标签。

官方入口：[PIXL 论文页](https://pixl.cs.princeton.edu/pubs/Chang_2016_ATF/index.php)、[论文](https://gfx.cs.princeton.edu/gfx/pubs/Chang_2016_ATF/chang2016-triage-preprint.pdf)、[Benchmark](http://phototriage.cs.princeton.edu/)。Chang et al., *Automatic Triage for a Photo Series*, SIGGRAPH 2016。

已执行 Ray Jobs API CPU 核验，Ceph 路径 `<CEPH_ROOT>/bench/phototriage/`，外网经 `<HTTP_PROXY>`。官网 HTTP/HTTPS 主页及 `download.html` 都返回 503；可访问的官方 PIXL/GFX 论文页仅链接此官网，没有数据许可。不能确认“仅研究用”许可，因而停止在下载图像前。这里只能断言指定访问路径不可达，不能断言网站全球永久关闭。

官方 preprint §3.4（Benchmark）的短转述与定位另存于 [`phototriage-official-split-excerpt.json`](phototriage-official-split-excerpt.json)，来自 web 工具对官方 Princeton PDF URL 的索引文本提取。论文写验证划分为195组，同段写 train 4,560、test 967、总数 5,953；这三个划分数字之和为 5,722。当前没有可访问的实际 split 文件，不能确认这些数字对应发布版本，也不能把它们解释成当前验证集规模上限。原文还说明当时仅拟公开 train/validation 人工标签，test 通过线上服务评测；当前是否变化同样未核实。**本次不可运行的充分原因是官网/许可无法核验，而不是根据有矛盾的论文数字推断划分不可行。**

探测作业 `w2-bench-triage-probe-20261010` 与带完整校验导出的 `w2-bench-triage-probe-20261010-v2`，均只请求自有作业，不停止他人作业。证据保存为 cache 中的 `provenance-probe.json`、`provenance.json`，报告读取后者。作业状态应以最终 `/api/jobs/<id>` 响应为准。

## 可替代数据集（本次没有自动替换）

| 数据集 | 官方许可依据 | 能评测什么 / 限制 |
| --- | --- | --- |
| [AADB, Kong et al. ECCV 2016](https://github.com/aimerykong/deepImageAestheticsAnalysis) | 官方 README：Flickr Creative Commons 图像，dataset “for research purpose only”；需保留逐图原许可 | 美学总分、11属性、官方 train/val/test；不是同一场景连拍，不可当 T-triage top-1 |
| [KonIQ-10k](https://darus.uni-stuttgart.de/dataset.xhtml?persistentId=doi%3A10.18419%2Fdarus-2435) | 官方数据存储：CC BY 4.0，图像例外按 YFCC100M 每图 Creative Commons 许可 | 10,073张真实失真图、MOS及投票分布；可测技术质量，不是连拍偏好 |
| [PieAPP](https://github.com/prashnani/PerceptualImageError/blob/master/dataset/dataset_README.md) | 官方 dataset README：仅非商业/教育用途，完整细则在 `TERMS_OF_USE.pdf`；引用 PieAPP 和 Waterloo | 200源图，81,480人群成对偏好；test 40源图4,200对，适合合成退化的人群外部验证，非连拍审美 |

如采用替代数据，须在报告中更换基准名称和指标，先读完整许可，不能把替代数据成绩填写为 T-triage。

## 恢复接口与数据契约

```sh
nice -n 10 python3 ml/bench/phototriage.py probe --id w2-bench-triage-probe-<unique-id>
nice -n 10 python3 ml/bench/phototriage.py status --id w2-bench-triage-probe-<unique-id>
nice -n 10 python3 ml/bench/phototriage.py receive --id w2-bench-triage-probe-<unique-id>
```

`receive` 校验 gzip/base64 分块、chunk SHA-256、完整文件大小和 SHA-256、连续 chunk index 与完成标记，拒绝路径越界。默认只把官方探测证据保存到 `data/cache/bench/phototriage/`，没有图像下载后门。

未来经许可核实后的输入清单采用：

```json
{"status":"ready","license":{"status":"verified","sourceUrl":"...","textSha256":"..."},"groups":[{"id":"series-id","split":"validation","images":[{"id":"image-id","path":"images/series-id/image-id.jpg","order":0}],"preferredIds":["image-id"],"pairs":[{"winnerId":"image-id-a","loserId":"image-id-b","strength":0.8}]}]}
```

`path` 相对本机 `data/cache/bench/phototriage/`；`strength` 是人群选择 winner 的概率，强偏好筛选 `strength >= 0.7`。保留官方图像顺序、投票计数和 split 证据，不用模型预测生成 preferredIds。图像长边 1024 JPEG 的压缩版本只保存在 gitignore cache，元数据可进入 fixture。

补充 PDF 直接下载核验：自有 CPU 作业 `w2-bench-triage-paper-20261010` 请求官方 PIXL PDF，30秒超时后 FAILED，无遗留运行作业。故落地引文明确注明为 web 搜索工具的官方 URL 索引提取，未声称本次直接下载 PDF 验证。
