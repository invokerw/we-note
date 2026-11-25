# FEAT-20261125-share-links · 笔记分享链接

- 类型 `feature`，影响 server / web。当前状态 `DELIVERED`。
- 开发依据为 `main` 的 `02e790d` 所收录的[笔记分享链接需求](../笔记分享链接需求.md)。用户选择方式 2，先在任务分支验收，通过后合入。
- 分支 `codex/feature-share-links-20261125`，独立工作区 `/Users/weifei/code/we-note/.worktrees/share-links-20261125`。
- 从单篇笔记创建可复制的 URL，访客直接阅读正文和快照图片，下载原始文件，登录后选择自己的库和目录保存并打开副本。保留已有链接的密码、撤销与权限规则。
- 验收覆盖文档的四个场景，另测二进制源文件、老链接和移动浏览器。运行 Go 分享测试、服务端回归、Web 构建和浏览器回归，用独立实例交付。

## 开发与验证 · 2026-11-25

| 检查 | 结果 |
| --- | --- |
| 服务端失败测试 `go test -count=1 ./internal/httpapi -run TestSharedSourceDownload` | 退出 1，基线的源文件下载路由返回 404。 |
| 浏览器失败测试 `WENOTE_TEST_ORIGIN=http://localhost:19475 node apps/web/tests/phase1.mjs` | 退出 1，基线笔记没有「分享」链接入口。 |
| 服务端回归 `go test -count=1 ./...`、`go vet ./...` | 均退出 0。覆盖二进制原件、中文文件名、未授权下载、快照成员和次数限制。 |
| Web 构建 `npm run build` | 在任务的 `apps/web` 构建成功，产物位于 `apps/web/dist`。 |
| 浏览器回归 `WENOTE_TEST_ORIGIN=http://localhost:19475 node apps/web/tests/phase1.mjs` | 退出 0。桌面端发送后修改来源，390 px 宽的访客页面仍展示原正文和图片，下载的文件与分享版本逐字节相同。登录后保存并打开副本，撤销原链接后副本仍可编辑、看图。 |
| 兼容回归 `WENOTE_TEST_ORIGIN=http://localhost:19475 node apps/web/tests/phase5.mjs` | 退出 0。旧密码链接、次数限制、收件箱导入、来源更新正常。 |
| 演示笔记 | Chrome 实际打开验收链接，核对标题和图片解码，新账号注册后创建首个库，保存并打开副本成功。 |

自审中统一了单文件和 ZIP 的下载计数规则，单文件读取失败时回滚计数。历史附件可在阅读页展开并下载快照 ZIP。复查了完整差异，`git diff --check` 通过。快捷链接沿用既有默认有效期 7 天，可在分享管理中撤销。

## 任务分支验收

- 从任务工作区执行 `./scripts/local.py start --port 19475`。独立 Web 和 API 入口为 `http://localhost:19475`，第二轮服务 PID 为 `10390`。
- 数据目录 `services/api/data`，服务日志 `dist/local/server.log`，构建日志 `dist/local/share-build.log`，演示链接保存在 `dist/local/demo-share.url`。所有路径均相对于本任务 worktree。
- 打开演示链接即可阅读和下载。要验证保存，点击「保存到我的笔记」，使用独立实例中的普通账号登录，或直接注册。也可从笔记标题栏自行分享并在分享管理中撤销。
- 方式 2 验收中，保留服务和分支。验收通过后从本工作区执行 `./scripts/local.py stop`。

## 第二轮反馈 · 2026-11-25

状态 `CHANGES_REQUESTED`。访客在弹窗登录，成功后在同一弹窗以树状选择目标库和目录。已登录直接选位置，可取消并回到当前正文。沿用方式 2。

- 原任务分支同步 `main` 后进行返工。浏览器回归 `WENOTE_TEST_ORIGIN=http://localhost:19475 node apps/web/tests/phase1.mjs` 在基线退出 1，等待「保存到我的笔记」弹窗超时。
- 登录成功后切换弹窗内容。复用工作区目录树，把每个库作为可选根节点，展开时读取其目录。单文件从新选择器保存时直接落入所选目录。旧调用和多文件分享保留已有路径规则。
- 自审检查了取消、跨库切换、同库重复保存和首次创建笔记库的路径。沿用同一链接在同一笔记库只保存一次的规则，在选定位置与历史副本位置不同时提示首次保存路径。
- 最终 Web 构建 `npm run build --prefix apps/web`、服务端 `go test -count=1 ./...` 和 `go vet ./...`、`git diff --check` 均退出 0。原验收实例上的 `phase1.mjs` 和 `phase5.mjs` 均退出 0，覆盖手机宽度登录、取消重开、选择两级子目录、跨库切换与库根保存，并核对了保存后打开的实际路径。
- 本轮状态 `DELIVERED`。使用同一端口、演示链接、数据和日志，继续按方式 2 在原任务分支验收。
