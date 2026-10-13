# Eagle 插件安装与后台行为

以 git 克隆安装，先按 [自动更新说明](auto-update.md) 安装 Node 依赖。
在 Eagle「导入本地项目」中导入克隆内的 `src/plugin`。它同时声明主面板（420×600，可调整大小）和右侧检查器
（代码在 `src/plugin/inspector/`，需要 Eagle 4.0 Beta 17+）。

如果某个 Eagle 版本不显示这个插件的右侧检查器，再单独导入 `src/inspector`：它是只含检查器的备用插件，
加载同一份 `src/plugin/inspector/` 代码，因此必须保留仓库目录结构。两者不要同时启用，否则右栏会出现两块。
更新整个克隆会同时更新主面板和检查器；
三个版本号由 `scripts/check-update-version.mjs` 校验。Eagle 智能文件夹 API 需要 4.0 build22+。

## 紧凑任务面板

可见时每约 1.5 秒读取选择计数，优先使用 `countSelected()`；只在提交分析时取完整 ID。
选择优先于文件夹，未选择照片或文件夹时范围为整个资源库。隐藏时停止选择轮询；
切换资源库立即清除旧范围和结果，并按新库刷新最近记录，可见时重新读取选择。
首页展示最多 5 条任务，宽窗口最多 20 条；「全部任务」保留服务分页和加载更多。
主窗口只提供设置、开始分析、进度、任务列表、写回、清理和报告导出。
分析完成后保留结果摘要；任务主动作「在 Eagle 中挑片」选中第一张照片，让右侧检查器接手。
次要动作「写回 / 清理…」打开首页内的「完成」面板，显示已决定数量并提供 CSV / JSON 报告。
「预览写回更改…」先生成 dry run，再打开确认对话框；可选移入回收站需输入 `MOVE_TO_TRASH`。
「撤回本次写回」恢复本次写入的标签和星级，回收站操作不会撤销。
插件保留可调整窗口及尺寸记忆，不因挑片自动最大化。

齿轮打开独立设置视图，包含全速、自动启动、实时写回、星级、智能文件夹及关于/更新。
实时写回与星级默认关；智能文件夹默认开，但后两者的 UI 仅在实时写回打开时可用。
检查器读取共享 localStorage 键执行实时写回；主窗口保存设置并提供手动写回。
服务地址、仓库路径、启动命令及按记录 ID 打开完成面板只出现在折叠诊断中。

## 后台运行、启动与通知

`main.serviceMode: true` 使 Eagle 启动时创建后台插件。创建时先检查 `/health`：
自动启动缺省开启，仅在地址为本机 HTTP、仓库绝对路径可用且存在 Node 运行环境时启动。
自动检测路径来自 `file://.../src/plugin/index.html`；可以在高级设置中覆盖。
启动前再做健康检查并检查 TCP 端口，端口被其他服务占用时拒绝重复启动。
自动启动关闭后，创建和异步端口检查之后都不会自动拉起服务；用户仍可手动重试启动。
POSIX 使用 `nice -n 15 node src/cli.js serve --concurrency 1 --port <port>`；
Windows 直接启动 Node，设置 BelowNormal 和 windowsHide。子进程 detached、stdio ignore、unref，
插件窗口隐藏不会通过父进程管道终止 CLI。
启动失败首页显示一行提示与重试，详细错误在诊断。忽略标准流，后续服务错误应在诊断终端中用复制命令复现。

CLI 的 `serve()` 注册 `restartService`，因此自动启动与手动 CLI 具有相同更新许可；
无需 `EAGLE_ALLOW_UPDATE` 开关。候选进程带 IPC 在临时端口验证健康，再接管原端口；
旧进程退出后候选 disconnect/unref。更新日志仍写 `data/logs/update-*.log`。
更新器触发插件重载时允许 unload，其余窗口关闭转成 hide，保持活动任务轮询。

有活动分析时每约 5 秒查询一次运行状态，窗口隐藏也继续。创建时恢复服务已有活动运行，
之后通过每分钟 `/health` 的 `activeRunId` 发现外部新运行；空闲时不轮询运行接口。
完成/失败通过 `eagle.notification.show` 通知。已跟踪运行与已通知 ID 按服务地址持久保存，
重新打开、重载页面不重复通知；API 缺失时静默跳过。通知不读取图像、不写 Eagle。
仍保留每分钟的更新状态检查及更新器的远端缓存限制。

## Eagle 原生挑片与交互检查器

所有照片查看都在 Eagle 自己的网格和预览中进行，所有挑片操作由右侧检查器提供。
检查器的决定通过本地服务保存，沿用已有的学习、继承和实时写回路径；不写原片。
主窗口不再提供内置查看器、遥控器、审阅页或专注挑片入口。

检查器提供精选、候选、淘汰及「恢复为 AI 建议」，支持组间导航和组内大缩略图。
组内比较表展示排名、评分和问题标记，显示当前照片与本组最佳照片的差异。
分组修正和任务级批量操作也在检查器中完成；点击缩略图在 Eagle 中选中照片。
旧版 Eagle 没有 `item.select` 时仍可决定，但需要手动选择下一张。
快捷键仅在检查器有焦点时生效，Eagle 主窗口有焦点时插件收不到按键。

AI 标签按任务单独选择，默认关闭。开启后只写入 Eagle 资料库元数据（`AI精选`、`AI候选`、`AI淘汰` 及问题标签），每次写回记录原标签，关闭任务开关可精确恢复。设置中的“清除插件写入的标签”只删除本插件定义的 AI 标签，不改其它标签；星级仍只由有记录的任务撤回。

## 检查器读取与同步

`GET /items/:itemId/analysis?libraryPath=...` 返回最近一次完成并包含该条目的分析结果，
配对 RAW/JPEG 的所有 itemId 都映射到同一 unitId。无结果返回 404 和「尚未分析，在插件中分析后显示」。
按 libraryPath 在内存构建索引，新增运行或发布结果后失效；进度更新不反复重建。
首次按时间从新到旧扫描一次运行/单位索引，之后选择只读取对应单位、分组及当前人工决定。
索引保留最多三个资源库；人工决定和分组修正每次读取，避免显示过期决定。
质量分不可用仍返回 null，界面显示 —；不重新评分、不修改阈值。

检查器在 `onPluginCreate` 读取选择，同时兼容 `onPluginShow/onPluginHide`、库切换和 document 可见性。
官方 Inspector 示例未说明选择变化是否重建实例，也没有文档化的 item 选择变化事件，
所以可见时每约 1.5 秒检查单项选择；同一选择最多每 15 秒刷新结果。
隐藏时停止检查，旧选择的慢响应会丢弃。读取分析结果使用 GET，人工决定通过服务接口保存。
星级同步与实时写回由检查器处理，使用主窗口设置保存的共享键。
服务地址读 `eagle-culling-base`，缺省 `http://127.0.0.1:43125`。

## 依据与真实 Eagle 人工确认

依据本次提供的官方文档章节：Background Service、Inspector、manifest.json Configuration、event、window、screen、notification、item、app、smartFolder。
文档明确后台启动与显示/隐藏 API，但没有明确关闭按钮、应用退出和后台页面生命周期的完整组合。
以下必须在真实 Eagle / Windows 环境人工确认，模拟测试不能代替：

1. Eagle 启动时不弹出面板，点击插件显示窗口；关闭按钮只隐藏，活动任务仍轮询及通知。
2. `onbeforeunload` hide 处理不会阻止 Eagle 整体退出；自动更新 reload 能正常重新创建插件。
3. Inspector 选择另一照片时是否重建页面；新库、重载、DARK/LIGHT 主题及旧 API 降级正常。
4. 主插件与独立检查器的 localStorage 是否共享服务地址。若运行环境隔离，两者默认地址仍一致；自定义地址需在对应检查器存储设置。
5. Windows Node PATH、BelowNormal、windowsHide 和 detached 候选进程完成接管，主插件窗口尺寸恢复正确。
6. 系统通知权限、内容及去重；Eagle 4.0 build22+ 智能文件夹写回能力正常。

## 本地假 Eagle 预览

```sh
nice -n 15 node scripts/dev-panel-fixture.mjs
```

仅监听 127.0.0.1:43441，所有 Eagle 对象、服务状态及通知都是假的。
入口 `http://127.0.0.1:43441/lab` 包含 420×600 iframe 和状态/主题/选中数切换。
独立截图 URL 用 `http://127.0.0.1:43441/?state=<state>&theme=DARK`，LIGHT 把参数改为 LIGHT。
无头浏览器截 420 宽面板时用同源包装 `http://127.0.0.1:43441/lab?bare=1&state=settings&theme=DARK&w=420&h=900`；
跨源（file://）包装页里的设置状态不可靠。settings/history 会重试直到对应界面显示。
状态：offline、starting、none、selected（可加 `&n=8`）、folder、running、completed、settings、history、
inspector-result、inspector-empty、inspector-offline。
可在页面 `fixture.setSelection(n)`、`fixture.setFolder(true)`、`fixture.setTheme('LIGHT')` 切换假 Eagle；
`fixture.hide()/show()/changeLibrary()` 模拟生命周期，通知记录在 `fixture.notices`。
退出脚本用 Ctrl+C；不要指向真实服务或资源库。

## 空闲预处理（默认关闭）

- 由主插件（后台服务窗口）每分钟检查一次，满足条件最多每 15 分钟发起一次：设置开启、服务已连接、在时段内、
  插件窗口隐藏、非电池供电、系统空闲 ≥10 分钟、没有正在进行的分析。
- 电源：优先 Electron `powerMonitor`（渲染进程通常不可用），否则用 Chromium Battery API；都不可用时视为未知，不运行。
  空闲：`powerMonitor.getSystemIdleTime()`，macOS 退回 `ioreg` 的 HIDIdleTime；都不可用时只按时段判断。
- 候选：`eagle.item.getIdsWithModifiedAt()` 取最近 30 天修改过的 id（最多 1000），`getByIds` 后按 `importedAt`
  过滤最近 30 天导入的图片；旧版 Eagle 退回 `item.get({ fields })`。服务端 `POST /runs/analyzed` 去掉已分析的，单次最多 300 张。
- 运行：`POST /runs { purpose: 'prefetch' }`，固定普通性能模式；不进入最近记录、检查器索引、学习数据和通知，
  `/health` 用 `prefetchRunId` 而不是 `activeRunId`。只保留最近 5 条预处理记录。
- 让出：窗口显示、空闲 <60 秒、改用电池或离开时段时由插件取消；用户的正式分析请求会先取消预处理再开始。
- 只读：不调用任何写 Eagle 的 API。
