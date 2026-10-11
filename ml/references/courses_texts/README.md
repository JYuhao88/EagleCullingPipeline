# 课程字幕与讲义文字层

只读 `portrait_courses_manifest.json` 的 `materials-course-texts` 条目。原文件须位于
`references/materials-course-texts/raw/<remote_rel>`，存在最终文件、大小与 SHA-256
均匹配才可处理；`.part` 不算到达。脚本不上传、不读取视频、不操作其他人的作业。

从 worktree 根目录执行，每步先用 `status --id <自己的ID>` 确認终态成功：

```sh
python3 ml/references/courses_texts/ray.py watch --wait-seconds 3600
python3 ml/references/courses_texts/ray.py extract
python3 ml/references/courses_texts/ray.py export --manifest-only
python3 ml/references/courses_texts/ray.py receive --id <自己的导出ID>
python3 ml/references/courses_texts/ray.py search --terms editing culling sequence selection
python3 ml/references/courses_texts/ray.py receive --id <自己的检索ID>
python3 ml/references/courses_texts/ray.py export --ids <清单内的文件稳定ID>
python3 ml/references/courses_texts/ray.py receive --id <自己的导出ID>
python3 ml/references/courses_texts/ray.py jobs
```

watch 的 status 必须同时为 `SUCCEEDED` 与 `readyComplete: true` 才算到齐；
超时后按间隔重新等待。相邻到达检查至少间隔 300 秒；watch 在 Ray 内以 300 秒间隔检查，活跃 watch
期间不能再提交到达检查。启动命令失败而未执行检查的作业可重试。ledger 与检查
状态有文件锁；最多两项自有活跃 CPU 作业，每项 1 CPU / 0 GPU，ledger 在 HTTP
请求前落盘。入口脚本 gzip/base64 压缩，避免命令长度上限。仅查询 ledger 中的 ID。

字幕支持 UTF-8 BOM、UTF-16 BOM、GB18030、CRLF 及逗号/小数点毫秒格式。
移除索引、时间轴及格式标签；保留 cues 与合并后的 sentences。按终止标点、超过
2 秒的空隙或合并跨度超过 30 秒断句。同 cue 内多句共享该 cue 的时间范围，不推算
词级精确时刻。源文件起止相等的零时长 cue 原样保留并计数，不补造时间；
零时长独立句不能用于要求正时间窗的证据。没有标点的片段也按上述边界分段，不声称语言学断句真值。PDF 用
`pypdf==6.1.1` 提取文字层，保留实际 PDF 页号与空页统计，不做 OCR。

Ceph 输出 `references/materials-course-texts/text/<course-slug>/<稳定ID>.json`；
顶层 `materials-course-texts-manifest.json` 记录输入及输出校验和、集数/句数/页数。
Michele 的 `episode` 是排序后的唯一文件编号，`topic`、`originalEpisode` 和 `title`
保留主题与原集号。其他课程沿用文件名前缀集号；无前缀的 Class Workbook 为 0。
稳定 ID 由课程 slug 与 remote_rel 的 SHA-256 前 12 位组成。

相同内容的文件保留全部处理记录，`duplicateOf` 指向规范文件，并设
`count_only: true`，不能重复作为证据。统计需同时给出文件总量与去重内容总量。

全文只写 Ceph 与 `/tmp/w4-mastercourses/`。导出必须显式指定稳定 ID；检索仅回传
命中句/页及前后各两行，作为粗读索引，不自动生成观点。完整输出 SHA 校验后再
生成 gzip/base64 块；接收逐块及全文件 SHA-256 校验，原子写入。取回后由人工精读
上下文，仓库只保存短转述和定位。完成后删除本轮 `/tmp/w4-mastercourses/`，保留
仓库内的元数据处理清单及运行 receipt；不清理他人目录或上传 package。
