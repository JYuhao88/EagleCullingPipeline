# 发布与插件自动更新

首次安装使用公开仓库的 git 克隆，Eagle「导入本地项目」指向克隆内 `src/plugin`：

```sh
git clone https://github.com/JYuhao88/EagleCullingPipeline.git
cd EagleCullingPipeline
npm ci --ignore-scripts
node src/cli.js serve --concurrency 1
```

插件「关于 / 更新」显示版本、更新说明、检查与回退按钮，以及默认开启的「自动更新」。
后台每分钟读取本机服务状态；服务缓存远端检查至少六小时，手动检查也遵守该间隔。
只使用 `git ls-remote --tags origin` 获取 `vX.Y.Z` 正式版本；不依赖 GitHub REST API。
这里的正式版指符合版本格式的 tag；仓库发布者必须只为正式 Release 创建这种 tag，
草稿或预发布应使用带后缀的 tag，不能先发布正式格式 tag 再将 Release 标成预发布。

关闭自动更新后仍显示新版横幅。点击「稍后」推迟本次打开期间的更新；下次打开恢复检查。
审阅期间不自动更新，手动更新也要求先返回主页。分析运行中拒绝更新，更新期间拒绝新分析。
主页空闲时自动检查并更新；成功后重新加载插件。Python 依赖有变化时显示手动安装提示。
检查失败保留上次结果并说明原因，不触发自动更新。

## 更新与回退保证

更新整个克隆而非只替换插件。origin 仅允许指定公开仓库的 HTTPS 或 SSH 地址。
工作区必须干净（包括未跟踪且未忽略的文件），绝不 reset、stash 或删除用户改动。
fetch 后验证目标是 tag 对应提交、属于 origin/master 历史，并验证 package/插件版本与 tag 一致。
更新使用 `git checkout --detach <commit>`，不移动本地 master 或开发分支。
`data/update-history.json` 保存上一提交；「回退到上一版」执行相同的安全检查、依赖安装和重启。
回退成功后上一版本成为刚离开的版本，可再次切换。

仅当 lockfile 改变时执行 `npm ci --ignore-scripts`。这阻止项目和依赖安装脚本，
但部分原生依赖可能依赖安装脚本，候选服务启动失败时会恢复旧提交并重装旧 lockfile。
不要为了通过健康检查自动放开脚本；此类依赖应由维护者提供无需脚本的发布或另行说明安装步骤。
Python requirements/pyproject/poetry 清单改变只提示，绝不自动安装。
候选服务仍会执行仓库内服务代码，健康检查只证明启动和 HTTP 健康端点，不证明全部模型可用。

候选 Node 进程先监听临时本机端口，验证带本次随机标识的 `/health` 后接管原端口，
再次验证健康后旧进程退出。失败则终止候选进程、恢复旧监听与提交。
保留启动参数、环境变量和工作目录；生产更新需用 CLI 启动，嵌入式服务默认不允许更新。
日志写入 `data/logs/update-*.log`。git 超时两分钟，npm 超时十分钟；候选启动/交接等待各三十秒。
POSIX 子进程使用 nice 15，Windows 使用 BelowNormal；npm 使用 npm.cmd。
更新不会调用 Eagle 写接口，不删除 runs、决定、学习记录、模型或缓存。
掉电或进程被强杀可能留下 `data/update.lock`；确认没有更新进程后，手动移除该锁再回退。

## 服务接口

- `GET /update/status`：当前 HEAD tag、package 参考版本、远端版本、更新说明摘要、上次检查时间，
  是否可更新及原因、回退是否可用、阶段和失败信息。
- `POST /update/apply` / `POST /update/rollback`：使用 JSON 请求，返回 202，轮询 status 查看结果。
  请求接收并不等于更新成功；拒绝和失败通过 status 的 failed/error 报告。
- 阶段：preparing → download → install（可省略）→ restart → completed，失败为 failed。

## 发布前检查

发布者同时修改 `package.json`、`src/plugin/manifest.json` 和 lockfile 里的项目版本，
新增 `docs/release-notes-vX.Y.Z.md`，然后运行：

```sh
nice -n 15 node scripts/check-update-version.mjs vX.Y.Z
nice -n 15 node --test --test-concurrency=1 test/updater.test.js
nice -n 15 node --test --test-concurrency=1 --test-skip-pattern='fixture face detection recall|fixture grouping reaches'
nice -n 15 node scripts/check-public-release.mjs
nice -n 15 git diff --check
```

创建 tag 后发布对应正式 GitHub Release。不可重指已发布 tag，不为草稿和预发布使用正式格式 tag。
版本检查脚本不修改版本号，防止发布时遗漏同步。当前开发线保留已有版本号，不冒充新 Release。
更新测试在临时本地 bare 仓库运行，不访问真实 GitHub；Windows 与 Eagle UI 仍需各自运行验收。
