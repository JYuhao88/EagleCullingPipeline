# W14 更新实现与验证

## 实现

新增 updater、低优先级进程包装、更新路由、候选服务交接、插件横幅/设置、版本检查脚本及三组测试。
已有文件只修改 README、server、CLI、runs 路由和插件 HTML；未修改 pipeline、contracts、todo、testing。
工作区改动保留，未提交、未 push。更新流程使用 detached tag，数据与原片不写回 Eagle。
完整使用说明见 [auto-update.md](auto-update.md)。

## 实际验证命令

更新专项（14 项）与源码行长检查（1 项）合计 15/15 通过：

```sh
nice -n 15 node --max-old-space-size=2048 --test --test-concurrency=1 \
  test/updater.test.js test/update-routes.test.js test/update-restart.test.js test/style.test.js
```

完整服务实现的两次完整回归均为 395/395 通过，0 失败：

```sh
nice -n 15 node --max-old-space-size=2048 --test --test-concurrency=1 \
  --test-skip-pattern='fixture face detection recall|fixture grouping reaches'
```

测试在临时目录建立 bare origin 和克隆，包含 v1.0.0/v1.1.0/v1.2.0，
以及 annotated tag、预发布 tag、非 master tag 和版本不一致的发布。
覆盖六小时缓存、API 403 不影响 git 检查、脏工作区/分析中/未知 origin 拒绝，
npm 失败恢复提交与依赖、重启失败恢复、成功更新与 rollback，以及 HTTP 安全规则和分析互斥。
实际候选进程测试验证临时端口健康失败时旧服务可连接，成功后原端口由候选服务接管。

质量对比实际运行，使用最新同 manifest 基线，388/388 图像缓存命中，未冷跑模型批量计算：

```sh
nice -n 15 env -u PYTHONPATH -u EAGLE_POSE_MODE -u EAGLE_POSE_MODEL -u EAGLE_POSE_DETECTOR \
  EAGLE_PYTHON=python_worker/.venv/bin/python EAGLE_POSE_PROVIDER=CPUExecutionProvider EAGLE_BENCH_CACHE_ONLY=1 \
  node --max-old-space-size=2048 scripts/bench.mjs \
  --compare data/cache/bench/reports/2026-10-11T15-32-23-756Z/report.json
```

运行时临时链接已有 Python 环境，结束后移除本任务创建的链接；未修改 Python 实现。
报告 `data/cache/bench/reports/2026-10-11T16-03-27-649Z/report.json`：
368 对完全匹配，偏好准确率、严重档 gate、源图误淘汰三项 delta 均为 0，所有退化类别 delta 为 0，
unchangedRows=true，warnings=[]。T-triage 未就绪，top-1 delta=null，不声明真实摄影偏好验收通过。

```sh
nice -n 15 node scripts/check-update-version.mjs v1.0.0
nice -n 15 node scripts/check-public-release.mjs
nice -n 15 git diff --check
```

版本检查通过：开发线现有 package/manifest 均为 1.0.0；未将开发改动伪装成新的正式 Release。
公开检查 0 命中，diff check 通过；源码行长检查通过。最后仅修改测试 fixture 的自清理方式，并复跑候选交接与行长检查，3/3 通过。

## 未完成与环境限制

- Windows 实机 BelowNormal、npm.cmd 和候选进程交接：未完成；实现已提供 Windows 分支。
- Eagle 内完整横幅/设置/重载操作验收：未完成；策略单测与真实 Node 进程交接已验证。
- 沙箱拒绝 nice 优先级调整；实际命令均带 nice 15，但不能声称本轮实际降优先级生效。
- 首次候选测试的清理顺序问题已修正。两个早期测试候选进程的跨命令终止被沙箱以 EPERM 拒绝，
  需在本机清理；后续测试使用 fixture 自身的停止接口，并设置十秒生命周期上限，再清理目录。
- 未使用 Ray，未修改 Eagle 库、原片或用户 runs/决定/学习数据。
