# w24-panel 交付核对

此线负责紧凑任务面板、后台服务和独立检查器（共享方案第 1、3、5 项）。
没有提交，没有修改依赖清单或锁文件，没有调用真实 Eagle 或触碰真实照片。
完整安装、Eagle API 文档依据和人工确认项见 [Eagle 集成说明](eagle-integration.md)。

## 文件与分工

| 文件 | 原因 |
| --- | --- |
| `src/plugin/index.html` 的 head / start、`start-model.js`、`start-view.js`、`start.css` | 紧凑首页、范围、结果、最近 3 条 / 全部记录、设置二级视图 |
| `src/plugin/style.css` 顶部基础规则 | 字体、字号、基础控件和背景改用共享主题变量；审阅规则保留 |
| `src/plugin/manifest.json` | 420×600、360×480 最小值、resizable、serviceMode |
| `src/plugin/panel-settings.js` | 统一存储键、默认值和依赖开关 |
| `src/plugin/background.js` | 健康 / 端口判断、自动启动、通知持久去重、窗口生命周期 |
| `src/plugin/api.js` | 轻量 countSelected，提交时才读取完整 ID |
| `src/plugin/window-mode.js`、`plugin.js` 三行接入 | 进入审阅最大化，返回恢复紧凑首页；审阅实现保持原样 |
| `src/plugin/update-banner.js / .css` | 顶部紧凑横幅，关于/更新移到设置，允许更新 reload |
| `src/inspector/manifest.json / index.html / inspector.js / inspector.css / logo.png` | 独立只读检查器、共享主题、单项选择变化兼容 |
| `src/server/item-analysis.js` | 最近完成运行的条目索引与 GET 只读查询 |
| `src/server/run-store.js` | 发布代数使索引失效、按库过滤列表、增加建议计数；列表仍不返回库路径 |
| `src/server/runs-routes.js`、`src/server.js` | 新路由、完成计数及 health 活动运行 ID，已有字段不移除 |
| `scripts/check-update-version.mjs`、`check-public-release.mjs` | 检查器版本一致性、同一相机图标哈希白名单 |
| `scripts/dev-panel-fixture.mjs` | 自有 43441 端口、可切换假 Eagle / 假服务 |
| `test/start-ux.test.js / report-format.test.js / runs-list.test.js / updater.test.js` | 更新完成后的显式审阅断言、清理定时器、库过滤及检查器版本 fixture |
| `test/panel-background.test.js / inspector.test.js / panel-preview.test.js` | 新逻辑、只读查询、缓存失效、manifest、状态页脚本验证 |
| `docs/auto-update.md / eagle-integration.md / w24-panel-validation.md` | 安装、更新许可、运行行为与验收证据 |

`service-start.js` 本身无需改动：已有 serviceLaunch 使用 CLI，POSIX nice 15，Windows Node 直接启动。
CLI `serve()` 注册 restartService，无需新增更新许可环境变量。背景模块保留 detached / stdio ignore / unref，
Windows 调用 BelowNormal 和 windowsHide；现有真实候选接管 / 健康失败回退测试仍适用。
工作区 `test/theme.test.js` 另有格式变化，本线未改变其逻辑。

## 功能与不变量证据

| 要求 | 实现及证据 |
| --- | --- |
| 第 1 项：紧凑面板 | scope card and main button；compact home limits recent cards；primary folder analysis；完成后留面板并显式开始审阅 |
| 可见时轻量选择轮询，隐藏停止 | lightweight scope uses countSelected；hidden background stops Eagle selection reads；库切换清除旧范围 / 记录 |
| 设置默认值和存储键 | settings exact keys and defaults；标签/星级默认关，智能文件夹/自动启动缺省开；UI 依赖实时写回 |
| 第 3 项：自动启动不重复 | auto start refuses running, disabled, non-local；launch blocks occupied or newly disabled startup；Windows BelowNormal 测试 |
| 后台活动通知与去重 | completion and failure notify once across fresh instances；service-existing analysis completes in hidden background |
| 空闲不轮询运行 | 每分钟 health 发现外部活动 ID；仅跟踪活动时每 5 秒读运行；更新检查保持每分钟 |
| 更新接管 | real candidate promotes on original port；real candidate health failure keeps old service；沿用 CLI restartService，保留旧更新器安全检查 |
| 第 5 项：检查器 | item index hits paired IDs in latest matching library；只读路由 200/404/400/405；publication / new run invalidation |
| 检查器状态、慢响应、格式和版本 | inspector view model；selection refresh ignores stale responses and never writes Eagle；manifests exact supported extensions；version divergence refused |
| 默认排序、规则、阈值、分组、评分、planWriteback 不变 | 未改对应 core 实现；新增的是展示、GET 索引和运行计数字段；完整回归验证已有排序 / 写回等用例 |
| 现有分析范围、取消、分页、更新/回退、个性化、帮助不丢 | 原操作入口保留或移入设置 / 全部记录；原审阅区块、review-*.js、viewer、keyboard、writeback-dialog 未改 |
| 默认只读，不在真实 Eagle 操作 | 新面板只读选择、写 localStorage / 服务请求；检查器只 GET；所有验证使用假对象或临时 fixture |
| 不改依赖 / 框架 / 缓存 | 无新增 npm/Python 依赖，无 package/lock 改动，无缓存清理；原生 ES module |
| 公开仓库约束 | public-release 扫描；检查器 logo 与主插件相同 SHA-256，精确白名单 |
| Windows / 主题 / 老 API | 平台启动与路径测试；只使用 theme.css 变量；API 特性检测，计数/窗口降级说明，通知缺失静默跳过 |
| 资源及分工 | 实现与验证阶段终端入口 nice -n 15；完整回归持 /tmp/w23-heavy.lock、单并发并限 570 秒；预览仅 43441，结束关闭 |

## 命令与结果

相关回归：

```sh
nice -n 15 node --test --test-concurrency=1 test/runs-list.test.js test/inspector.test.js test/start-ux.test.js test/panel-background.test.js test/panel-preview.test.js test/report-format.test.js test/style.test.js
```

此组合曾得到 43/43 通过；后续代码及最终完整回归结果以交付消息和本节最终记录为准。
完整回归命令（持全局锁，单次最多 570 秒，结束立即释放）：

```sh
nice -n 15 node --max-old-space-size=2048 --test --test-concurrency=1 --test-skip-pattern='fixture face detection recall|fixture grouping reaches'
nice -n 15 node scripts/check-public-release.mjs
nice -n 15 node scripts/check-update-version.mjs
nice -n 15 git diff --check
```

首次回归遇到旧完成行为断言及未释放定时器，570 秒退出并释放锁；修正了断言并关闭测试中的自动轮询。
第二次回归 494/495 通过，唯一失败为列表不应返回 libraryPath，已移除不必要返回字段，保留原断言。
最终完整回归：495/495 通过，fail 0 / skipped 0，退出码 0，164.45 秒，锁已释放。
完整日志：`/tmp/w24-full-regression-pass.log`。
最终 public-release：528 文件，0 命中；主插件与检查器版本检查为 v1.2.5；git diff --check 干净。
此前失败与超时记录保留在 `/tmp/w24-full-regression.log` 和 `/tmp/w24-full-regression-final.log`，没有隐藏失败。

实现与验证命令均带指定 nice 前缀；本机 sandbox 报 `setpriority: Operation not permitted`，
因此不能声称本轮测试的调度优先级已实际降低。

## 预览与未完成的人工验收

```sh
nice -n 15 node scripts/dev-panel-fixture.mjs
```

420×600 控件入口：`http://127.0.0.1:43441/lab`。
所有下表 URL 都应分别用 DARK 和 LIGHT 截图，LIGHT 只需替换 `theme=DARK`。

| 状态 | URL |
| --- | --- |
| 服务未运行 | http://127.0.0.1:43441/?state=offline&theme=DARK |
| 启动中 | http://127.0.0.1:43441/?state=starting&theme=DARK |
| 无选择/首次空记录 | http://127.0.0.1:43441/?state=none&theme=DARK |
| 选中 N 张 | http://127.0.0.1:43441/?state=selected&n=8&theme=DARK |
| 文件夹 | http://127.0.0.1:43441/?state=folder&theme=DARK |
| 分析中 | http://127.0.0.1:43441/?state=running&theme=DARK |
| 完成 | http://127.0.0.1:43441/?state=completed&theme=DARK |
| 设置 | http://127.0.0.1:43441/?state=settings&theme=DARK |
| 全部记录 | http://127.0.0.1:43441/?state=history&theme=DARK |
| 检查器有结果 | http://127.0.0.1:43441/?state=inspector-result&theme=DARK |
| 检查器未分析 | http://127.0.0.1:43441/?state=inspector-empty&theme=DARK |
| 检查器服务未运行 | http://127.0.0.1:43441/?state=inspector-offline&theme=DARK |

24 状态/主题页面、内嵌假 Eagle 脚本语法、/lab 控件语法、服务与检查器状态码、资源 HTTP 验证已通过。
这不等于浏览器渲染验收：浏览器策略拒绝 127.0.0.1:43441 的访问，本轮没有截图或实测无滚动证明。
需要在真实 Eagle 人工确认：后台启动不弹窗、关闭隐藏而非退出、Eagle 整体退出与更新 reload、
Inspector 实例重建与选择变化、主插件/检查器存储隔离、通知权限及去重、Windows PATH/优先级/候选接管、窗口恢复尺寸。
实时写回和智能文件夹实际行为由 w24-review 实现；turbo 并行性能由加速线实现，本线只负责键与请求字段。
