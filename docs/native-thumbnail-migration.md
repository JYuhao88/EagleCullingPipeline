# Eagle 原生缩略图迁移记录

## 目的

此前的自定义角标缩略图会覆盖 Eagle 的原生预览，导致 JPG/RAW/HEIC/3FR 的方向、清晰度和打开效果不可靠。本次处理采用可回收的“重新导入为原生项目”方案：不改原片，不直接修改 Eagle 内部数据库。

## 已完成的迁移

- 4,115 个带工具自定义缩略图的照片项目重新导入为 Eagle 原生项目。
- 新项目保留了原项目的标签、文件夹、备注和星级：4,115/4,115 全部一致。
- 旧项目通过 Eagle API 移入回收站，未物理删除；可用于回滚。
- 重复导入的 3 个失败尝试也已移入回收站。
- 当前活跃库中的自定义缩略图数量为 0。

## 当前审计结果（2026-10-12）

运行：

```powershell
npm run audit:native
```

结果：

```text
activeItems: 7937
activePhotos: 7915
customThumbnailCount: 0
missingNativeThumbnailCount: 0
orientationMismatchCount: 0
passed: true
```

审计同时检查每个活跃照片项目的 `_thumbnail` 文件方向是否与 Eagle 的宽高方向一致。当前 7,915 个照片项目无方向冲突。

## 用户侧刷新

迁移会产生新的 Eagle 项目 ID，因此 Eagle 可能暂时显示旧缓存。请完整退出 Eagle 后重新打开活动库；不要使用“恢复旧角标”或再次运行旧版 `thumbnail-bridge`。灰色的 `JPG`、`DNG`、`HEIC`、`3FR` 字样是 Eagle 原生格式标识，不是自定义角标。

## 回滚原则

旧项目仍在 Eagle 回收站，新项目仍在活动库。不要直接删除回收站内容。若确需回滚，应先导出 `data/native-migration.json`，逐项恢复旧项目后再处理新项目，避免丢失人工标签、文件夹或星级。
