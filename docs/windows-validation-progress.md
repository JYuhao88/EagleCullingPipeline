# Windows 检验进度

时间 | 步骤 | 状态 | 产物路径 | 下一步
--- | --- | --- | --- | ---
2026-10-11T14:59:37.226540+00:00 | 两端盘点：既有 bundle clone、npm ci 日志存在；尚无完整验证证据 | done | <validation-root> | 断连安全安装与回归
2026-10-11T15:05:25.714614+00:00 | CIM setup PID 6848 初次失败：PowerShell 重定向锁冲突 | failed | <validation-root>/logs/setup.log | 改用任务启动器
2026-10-11T15:05:25.714815+00:00 | 用户目录 Python 3.12 与 DirectML provider 核实 | done | <validation-root>/logs/providers.log | 回归修复
2026-10-11T15:05:25.714821+00:00 | Windows Node 初轮 359 pass / 9 fail / 2 skip | failed | <validation-root>/logs/node-tests.log | 修复 Python、盘符、换行
2026-10-11T15:05:25.714825+00:00 | Mac 首轮 Node 370 pass / 0 fail | done | /tmp/w12-mac-regression.log | 改动后复验
2026-10-11T15:05:25.714828+00:00 | CPU→DML 合成对照 PID 7832 | running | <validation-root>/logs/bench.log | 轮询逐图缓存
2026-10-11T15:05:25.714831+00:00 | Windows 修复后回归 （PID 见 Windows PROGRESS） | running | <validation-root>/logs/regression.log | 核对 exit
2026-10-11T15:06:23Z | Windows 回归修复复验 PID 18656：Node 370/370，Python 3/3 | done | <validation-root>/logs/node-tests-repaired.log | CPU→DML bench
2026-10-11T15:16:30.010515+00:00 | CPU 388 张冷算结束：506.44 秒；启动器退出码复验成功 | done | <validation-root>/logs/bench-cpu.exit | DirectML
2026-10-11T15:16:30.010931+00:00 | DirectML 合成对照 PID 2960 | running | <validation-root>/logs/bench-dml.log | 逐图缓存续跑
2026-10-11T15:16:30.010943+00:00 | Mac cache-only bench 拒绝 388 张冷算，未推理 | failed | /tmp/w12-mac-cache-bench.log | Windows 完成数值对照
2026-10-11T15:26:00Z | DML bench 388 张完成；服务 Node PID 32584 BelowNormal；UI PID 19364 | running | <validation-root>/qa/plugin-e2e | 完成审阅、还原库

## 用户手动验证步骤

在 Eagle 打开已导入插件 → 地址 http://127.0.0.1:43125 → 重新连接 →
先选安全文件夹中的几百张照片 → 分析所选 → 审阅保留/淘汰并写理由 →
学习面板 → 1:1/眼部 → 导出 JSON/CSV。已有进行中任务时显示进度，失败/中断显示原因。
不使用写回。用户服务 Node PID 32596，数据独立 windows-user；
用户自愿停止只执行 Stop-Process -Id 32596。测试43135不会操作用户run。
新配置500张样本：8000张同分布线性约2h32；评分cohort非随机样本，实际可能数小时，尚未实跑全库。

2026-10-11T15:33:00Z | 服务改常驻人脸池；新服务 Node PID 9488，UI 续跑同一检查点 | running | <validation-root>/logs/ui-e2e2.log | 审阅并核哈希
2026-10-11T15:32:28.786337+00:00 | 399 原片/203 单元分析与审阅缩略图完成 | done | <validation-root>/qa/plugin-e2e | 决定理由、学习、1:1、导出
2026-10-11T15:33:30.420315+00:00 | 紧急暂停：用户 43125 服务不得被自动化占用/取消/重启；修原子写与恢复 | running | <validation-root>/logs/service2.log | 只读盘点用户 run
2026-10-11T15:39:24.043178+00:00 | 原子重试 9 处；用户服务 32836/43125 与测试 44900/43135 已隔离；恢复 UI 5 场景通过、用户 POST 0 | done | <validation-root>/qa/recovery/acceptance.json | Windows 回归与独立小样本分阶段计时
2026-10-11T15:46:07.101983+00:00 | Windows 修复后完整 Node 377/377，Python lock1、upload18，doctor全true | done | <validation-root>/logs/node-tests-emergency.log | 独立 E2E 分阶段计时
2026-10-11T15:48:17.596977+00:00 | 紧急修复完成；独立 E2E 399/203/43，299.826秒，哈希399一致，GET8写0；8000张线性约1h40（未跑全库） | done | <validation-root>/qa/plugin-e2e-isolated | 再继续 GPU Python 对照与规模
2026-10-11T15:50:28.845700+00:00 | Mac 最终 Node 376 pass/0 fail/1 skip；公开扫描0与diffcheck通过；Windows代码patch回传 | done | /tmp/w12-mac-release.log | GPU Python对照PID40900继续
2026-10-11T16:10:00Z | 后台扫描202与进度修复部署；用户服务PID47928，维护确认无active与pending连接 | done | <validation-root>/logs/user-service-scan.log | 最新回归与GET-only恢复复验
2026-10-11T16:08:52.624485+00:00 | Node/Python388逐项差异与两库只读库存完成 | done | docs/testing-data/windows-parity.json | 同组非零评分证据与规模结果
2026-10-11T16:10:49.841873+00:00 | 扫描修复复验Windows Node378/378；恢复UI5场景通过POST0，截图一次失败独立记录；用户PID47928保持运行；后续任务PID48268排队 | done | <validation-root>/qa/recovery/acceptance.json | 规模后评分与标准bench
2026-10-11T16:11:56.684135+00:00 | Mac最新完整Node378/378；公开429文件0命中、diffcheck通过；Windows代码checkpoint回传 | done | /tmp/w12-mac-scan-regression.log | 后台任务结果收集
2026-10-11T16:14:34.844873+00:00 | 首库1500原片/774单元/226组完成，SHA1500一致，GPU DML，质量/人脸/姿态缺失0；规模子集仅1评分，不具同组真值 | done | docs/testing-data/windows-scale-library-1.json | 第二库与专门评分队列
2026-10-11T16:20:25.752671+00:00 | 连续断网恢复修复复验六场景通过，最新Mac/Windows完整Node均378/378 | done | docs/testing-data/windows-recovery-ui.json | 第二库哈希/模型及后续队列
2026-10-11T16:21:23.688501+00:00 | 用户优先观察器PID49088部署：GET观察43125，只取消43135或停止本次bench自有PID树 | done | <validation-root>/logs/user-priority.log | 用户活跃时测试让路、保留检查点
2026-10-11T17:16:42.690688+00:00 | 规模3000原片/1539单元/563组SHA全一致；ExifTool便携安装与用户11724/测试47928空闲升级；最新双平台Node379/379 | done | docs/testing-data/windows-scale-library-2.json | 实片EXIF证明、排队评分与标准bench

2026-10-11T17:22:05.441131+00:00 | EXIF实片两库各8张哈希一致、doctor所有检查true；库存快照差异原因未确认；现有评分/标准bench队列放行 | done | docs/testing-data/windows-exif-check.json | 收集评分和标准入口真实结果

2026-10-11T17:24:28.605274+00:00 | 单任务中断终态修复4定向测试通过；用户服务维护因连接活动中止，未重启11724 | failed | <validation-root>/w12-user-status-maintenance.ps1 | 队列结束后确认空闲再部署

2026-10-11T17:27:08.213812+00:00 | 中断终态补齐；自有观察器改短连接后空闲部署，用户PID32596/43125 ready，切库0写0；评分进入姿态 | done | <validation-root>/logs/user-service-status.log | Windows复验与标准bench结果

2026-10-11T17:28:49.683946+00:00 | Mac收尾Node378pass/0fail/1skip，115.868秒；公开437文件0命中、diffcheck通过 | done | /tmp/w12-mac-final-regression-safe.log | Windows评分、标准bench及收尾回归

2026-10-11T17:32:57.687683+00:00 | 新EXIF配置评分500原片/291单元/109组570.376秒、SHA500一致；71评分单元仅1信息组，条件星级AUC0.5726744；8000线性约2h32非承诺 | done | docs/testing-data/windows-ratings.json | 标准bench和Windows收尾回归

2026-10-11T17:40:10.606352+00:00 | 标准bench三项delta0/368逐行一致；Windows379pass、Mac378pass/1skip、恢复6场景pass；61代码哈希一致；测试服务停止、用户32596/43125保留 | done | docs/windows-validation.md | 用户原生宿主与评分来源反馈、后续可选验证

2026-10-11T17:40:36.317267+00:00 | 最终style通过、公开440文件0命中、git diff --check通过；全部产物和限制已整理 | done | docs/windows-validation.md | 保留用户服务，等待原生宿主/评分来源确认

2026-10-11T17:46:05.303115+00:00 | mac-ray-dev冲突内容解完，新主页与恢复逻辑整合；Git index.lock沙箱阻止merge收尾；Windows空闲部署用户42488/43125 ready | done | <validation-root>/logs/user-service-ux.log | 两端完整回归与新主页Edge复验

2026-10-11T17:47:46.780236+00:00 | 新主页Mac完整Node411pass/0fail/1skip；Windows用户42488/43125保留，回归/Edge复验进行中 | running | <validation-root>/logs/regression-ux.log | 收集Windows结果和手动试用步骤

2026-10-11T17:53:55.595351+00:00 | 新主页合并代码与Windows部署完成；Mac411pass/1skip/0fail、Windows412pass/0fail；Edge恢复6场景通过，最新截图1次失败；公开473文件0命中、diffcheck通过 | done | docs/windows-validation.md | 用户原生Eagle重新加载试用；Git合并提交待有写权限终端收尾
2026-10-11T17:53:55.595351+00:00 | 用户服务42488/43125健康BelowNormal，active=null；用户试用：Eagle重新加载插件，选安全的几百张文件夹，点分析当前文件夹主按钮；最近分析可查看进度/失败重试 | done | <validation-root>/repo/src/plugin | 保持用户服务运行；停止前确认PID和无分析，PowerShell Stop-Process -Id 42488
