# Eagle 插件安装与后台行为

以 git 克隆安装，先按 [自动更新说明](auto-update.md) 安装 Node 依赖。
在 Eagle「导入本地项目」中分别导入：

- 主面板：克隆内 `src/plugin`，窗口为 420×600，可调整大小。
- 右侧检查器：同一克隆内 `src/inspector`，需要 Eagle 4.0 Beta 17+。

检查器通过 `../plugin/theme.js`、`../plugin/theme.css` 和 `../plugin/score.js` 共用主题及分数显示。
因此必须保留仓库目录结构，不要只复制检查器目录。更新整个克隆会同时更新两个插件；
三个版本号由 `scripts/check-update-version.mjs` 校验。Eagle 智能文件夹 API 需要 4.0 build22+。

## 紧凑任务面板

可见时每约 1.5 秒读取选择计数，优先使用 `countSelected()`；只在提交分析时取完整 ID。
选择优先于文件夹，未选择照片或文件夹时范围为整个资源库。隐藏时停止选择轮询；
切换资源库立即清除旧范围和结果，并按新库刷新最近记录，可见时重新读取选择。
首页只展示最近三条；「全部记录」保留服务分页和加载更多。
分析完成后保留结果摘要，点击「开始审阅」最大化窗口；返回时恢复 420×600。
旧 Eagle 没有 maximize 时尝试 `setSize` 到主屏工作区，窗口 API 缺失时保留可调整窗口。

齿轮打开独立设置视图，包含全速、自动启动、实时写回、星级、智能文件夹、个性化入口及关于/更新。
实时写回与星级默认关；智能文件夹默认开，但后两者的 UI 仅在实时写回打开时可用。
实际写回行为由审阅模块实现，面板只保存共享 localStorage 键。
服务地址、仓库路径、启动命令及按运行 ID 打开只出现在折叠诊断中。

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

## 只读检查器

`GET /items/:itemId/analysis?libraryPath=...` 返回最近一次完成并包含该条目的分析结果，
配对 RAW/JPEG 的所有 itemId 都映射到同一 unitId。无结果返回 404 和「尚未分析，在插件中分析后显示」。
按 libraryPath 在内存构建索引，新增运行或发布结果后失效；进度更新不反复重建。
首次按时间从新到旧扫描一次运行/单位索引，之后选择只读取对应单位、分组及当前人工决定。
索引保留最多三个资源库；人工决定和分组修正每次读取，避免显示过期决定。
质量分不可用仍返回 null，界面显示 —；不重新评分、不修改阈值。

检查器在 `onPluginCreate` 读取选择，同时兼容 `onPluginShow/onPluginHide`、库切换和 document 可见性。
官方 Inspector 示例未说明选择变化是否重建实例，也没有文档化的 item 选择变化事件，
所以可见时每约 1.5 秒检查单项选择；同一选择最多每 15 秒刷新结果。
隐藏时停止检查，旧选择的慢响应会丢弃。只使用 GET，不调用 Eagle save / 标签 / 星级写接口。
服务地址读 `eagle-culling-base`，缺省 `http://127.0.0.1:43125`。

## 依据与真实 Eagle 人工确认

依据本次提供的官方文档章节：Background Service、Inspector、manifest.json Configuration、event、window、screen、notification、item、app、smartFolder。
文档明确后台启动与显示/隐藏 API，但没有明确关闭按钮、应用退出和后台页面生命周期的完整组合。
以下必须在真实 Eagle / Windows 环境人工确认，模拟测试不能代替：

1. Eagle 启动时不弹出面板，点击插件显示窗口；关闭按钮只隐藏，活动任务仍轮询及通知。
2. `onbeforeunload` hide 处理不会阻止 Eagle 整体退出；自动更新 reload 能正常重新创建插件。
3. Inspector 选择另一照片时是否重建页面；新库、重载、DARK/LIGHT 主题及旧 API 降级正常。
4. 主插件与独立检查器的 localStorage 是否共享服务地址。若运行环境隔离，两者默认地址仍一致；自定义地址需在对应检查器存储设置。
5. Windows Node PATH、BelowNormal、windowsHide 和 detached 候选进程完成接管，主插件最大化/恢复尺寸正确。
6. 系统通知权限、内容及去重；Eagle 4.0 build22+ 智能文件夹能力由审阅线验证。

## 本地假 Eagle 预览

```sh
nice -n 15 node scripts/dev-panel-fixture.mjs
```

仅监听 127.0.0.1:43441，所有 Eagle 对象、服务状态及通知都是假的。
入口 `http://127.0.0.1:43441/lab` 包含 420×600 iframe 和状态/主题/选中数切换。
独立截图 URL 用 `http://127.0.0.1:43441/?state=<state>&theme=DARK`，LIGHT 把参数改为 LIGHT。
状态：offline、starting、none、selected（可加 `&n=8`）、folder、running、completed、settings、history、
inspector-result、inspector-empty、inspector-offline。
可在页面 `fixture.setSelection(n)`、`fixture.setFolder(true)`、`fixture.setTheme('LIGHT')` 切换假 Eagle；
`fixture.hide()/show()/changeLibrary()` 模拟生命周期，通知记录在 `fixture.notices`。
退出脚本用 Ctrl+C；不要指向真实服务或资源库。
