# 直出样片记录：「20260718 汕头」（2026-10-10 更正）

> **更正：汕头与 Eagle 原样片均没有摄影师精选。** `good` 是含义未知的文件夹，不是摄影师挑选结果。旧文把其 40 个单元当作正类，所得 AUC、精选召回、误拒、组内 top-1、bootstrap CI 及「当前排序比随机差／与摄影师选择负相关」结论全部撤销；它们没有真实偏好标签依据。旧对比图也不能作为「模型 vs 摄影师精选」证据。用户无需为评测补做审美标注。

样片：Sony A7C II（ILCE-7CM2）+ FE 16-35mm F2.8 GM II，253 对 ARW+JPG，夜景街头人像为主。清单见 [`test/fixtures/shantou-20260718-samples.json`](../test/fixtures/shantou-20260718-samples.json)：保留全部 stem 和 `good` 文件夹的 40 个 stem，仅记录来源，`meaning: "unknown-folder, not photographer picks"`；不含 `selectedStems`。

## 与真值无关的运行事实

历史 run `run-1791589678002`：全库 582 文件 / 291 单元，本机冷跑 133 秒（nice 10，并发 2，平均 264% CPU）。汕头部分 253 单元被分成 52 组（32 个多张组、20 个单张）。这些是历史运行记录，不代表重新执行了本次基准。

历史 run 内所有 items 均无 `captureTime`，旧时间顺序基线实际退回文件名顺序。旧统计中建议保留（selected + candidate）为 219/253，这是工具输出数量，不能换算成精选召回或误拒率。曝光、清晰度、TOPIQ 与审美偏好的相关性也不能从未知文件夹归属推断。

## RAW 元数据（exiftool 13.55）

| 机身 | 格式 | 内嵌最大 JPEG | 对焦信息 |
|---|---|---|---|
| Sony A7C II | ARW | 7008×4672（全尺寸，`JpgFromRaw`） | `FocusLocation` 给出对焦点像素坐标，`FocusFrameSize`，`AFAreaMode`（如 Human Eye Tracking），`FocusDistance2` |
| Ricoh GR IIIx | DNG | 6000×4000（接近全尺寸，`SubIFD1:PreviewImage`） | `AFAreas`（in-focus 区域坐标）、`AFAreaSize`、`CAFArea` |
| Hasselblad X2D II 100C | 3FR | 3888×2918（约 1/3 线性尺寸） | 未读到对焦点；配对 HEIC 可作全尺寸来源 |

结论：Sony、Ricoh 可以直接用内嵌 JPEG 做 100% 对焦裁切，并用相机记录的对焦点做「焦点是否打在眼睛上」的参照；Hasselblad 需要用配对 HEIC 或解码 RAW。


## 后续评测

汕头及 Eagle 原 38 单元作为 T-syn 合成退化的源图候选，不直接充当审美真值。T-syn 的真值来自受控退化；T-triage 使用公开连拍数据的众包偏好；专家档位与用户日常使用的隐式保留／删除反馈提供独立补充。详见 [test-plan.md](test-plan.md)，本次当前基线见 [eval-baseline.md](eval-baseline.md)。

`eval-picks.mjs` 仍用于已有明确真值的外部 fixture 或显式 `--truth` 规则；直出样本清单只可限定范围，未提供真值时明确失败，默认不再加载汕头「精选」。任意文件夹、星级或标签均须先确认其语义，不能自动解释为审美标签。
