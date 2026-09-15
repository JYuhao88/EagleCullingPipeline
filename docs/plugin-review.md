# Eagle 中文审阅插件

## 目标

`src/plugin` 已从原始 JSON 调试页升级为面向摄影分拣的中文审阅界面。用户在 Eagle 里选择一组照片后，可以直接看到缩略图、当前留存状态、AI 建议、中文原因、质量分、相似组和 RAW/JPG 配对提示。

插件只提供三种非破坏性审阅动作：

| 界面动作 | Eagle 标签 | 含义 |
| --- | --- | --- |
| 精选保留 | `ai:selected` | 组内首选或人工明确保留 |
| 候选 | `ai:candidate` | 需要继续比较，默认安全状态 |
| 待删除复核 | `ai:rejected` | 只进入人工复核队列，不删除文件 |

没有“直接删除”按钮。插件代码不会调用 `moveToTrash()`，也不会修改星级、文件夹或原始文件。

## 中文审阅内容

界面将模型输出和现有标签转换为可读原因，而不是显示原始 JSON：

- `possibly-blurry`：清晰度偏低，可能失焦或存在运动模糊；
- `eyes-closed`：检测到闭眼，请重点复核人物表情；
- `overexposed` / `underexposed`：显示曝光风险，分析结果可用时同时显示溢出像素比例；
- 相似组：说明组内张数，并指出本张是否为当前综合质量首选；
- `ai:original`：明确提示 RAW/3FR/DNG 是受保护母片；
- `ai:paired`：说明已找到 RAW/JPEG 或 3FR/HEIC 拍摄配对；
- `ai:pair-uncertain` / `ai:unpaired-original`：要求人工确认，不给出自动删除建议；
- `analysisSource=proxy`：明确说明本次基于 Eagle 预览图，未解码或修改原片。

单张照片即使存在模糊、曝光或闭眼提示，也默认进入“候选”，不会仅凭一个技术指标自动判为待删除。只有相似组中非首选照片会显示“待删除复核”建议，用户仍需点击后才写标签。

## 使用流程

1. 在项目目录启动本地分析服务：

   ```powershell
   npm run serve
   ```

2. 在 Eagle 里选择同一次拍摄、同一连拍或希望比较的一批照片。建议 5–100 张，硬上限 500 张。
3. 打开“摄影筛选助手”。插件会自动读取选择和现有 AI 标签，不运行模型也能开始复核。
4. 点击“AI 分析所选照片”，本地服务计算 pHash、清晰度、曝光、构图/主体代理分和闭眼提示，并按相似组排序。
5. 使用状态筛选或搜索缩小范围。点击缩略图/“在 Eagle 中定位”回到 Eagle 原图；使用“保留 / 候选 / 待删复核”保存单张决定。
6. 键盘高效分拣：`J/K` 或方向键移动，`1` 保留，`2` 候选，`3` 待删除复核，`Enter` 在 Eagle 中定位。

## 安全写入设计

保存状态时，插件不会直接使用分析开始时的旧对象。它先调用 `eagle.item.getById(id)` 获取最新项目，再移除三种旧 AI 审阅状态，合并新状态，最后调用该 Item 实例的 `save()`：

```text
重新读取当前项目
  → 保留人工标签、质量标签、配对标签
  → 只替换 ai:selected / ai:candidate / ai:rejected
  → Item.save()
```

这符合 Eagle 官方建议：通过 `Item` 实例修改属性并调用 `save()`，不要编辑资源库内部的 `metadata.json`。官方也提供 `getSelected()`、`getById()`、`select()`、`open()` 和 `thumbnailURL`，分别用于读取当前选择、刷新单项、定位照片及在 HTML 中安全显示缩略图。[Eagle Item API](https://developer.eagle.cool/plugin-api/api/item) [Modify Data](https://developer.eagle.cool/plugin-api/tutorial/modify-eagle-data)

## RAW/JPEG 与内存策略

交互分析请求会设置 `analysisPath = thumbnailPath || filePath`。只要 Eagle 有缩略图，RAW、3FR、DNG、HEIC 和 JPEG 都分析缩略图；原始文件路径和相机分辨率仅作为元数据保留。这样避免在用户使用 Eagle 时读取并解码 40–100MP 原片，也让不同格式使用同一视觉代理参与相似性比较。

限制也必须明确：预览图适合初筛和排序，不适合判断 RAW 最终显影后的精确色彩、暗部恢复或高光余量。因此界面会标出“基于预览图”，RAW 母片仍按 `ai:original` 保护。

## 开发者模式安装

Eagle 官方支持 Window Plugin：工具栏选择“插件 → 开发者选项 → 创建插件 → Window Plugin”，把插件目录设为项目中的 `src/plugin`。如果 Eagle 先生成了一个新目录，用整个 `src/plugin` 覆盖该目录，不能漏掉 `review-model.js`。[Your First Plugin](https://developer.eagle.cool/plugin-api/get-started/creating-your-first-plugin)

`manifest.json` 已设置 `devTools: true`。打开插件窗口后按 `F12` 可查看 console、网络、内存和性能。官方调试文档明确支持该流程。[Debug Plugin](https://developer.eagle.cool/plugin-api/get-started/debugging)

推荐按以下顺序验收：

1. 5–20 张 JPG，确认中文名、缩略图、定位和单张标签保存；
2. 一组 JPG+ARW 和一组 3FR+HEIC，确认配对与母片保护文案；
3. 一组真实连拍，确认相似分组和首选排序；
4. 100–500 张混合格式，观察 Eagle UI、Node 内存、CPU 和 RTX 显存；
5. 重新打开插件和 Eagle，确认状态标签持久化且人工星级/文件夹未变化。

## 已完成测试

- 纯函数测试覆盖中文原因、状态汇总、搜索/筛选、相似组建议和标签合并；
- RAW 代理测试使用不可解码的假 `.3fr` 原片和 PNG 缩略图，证明分析只读取代理，同时保留 11656×8742 原始尺寸；
- Windows Edge smoke test 加载完整插件 DOM，验证 4 张演示数据、中文搜索和状态筛选；
- 同一 smoke test 注入模拟 Eagle API，执行一次 `Item.save()`，确认人工标签、`ai:paired`、4 星和用户文件夹不变。

这些测试证明插件逻辑和浏览器运行时可用；仍需在 Eagle 开发者模式里完成上述 5–20 张真实选择集验收，才能称为完整的 Eagle 集成测试。
