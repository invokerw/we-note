# FEAT-20261125-share-duration · 文档分享有效期与分组

- `feature`，server / web，`DELIVERED`。用户选择方式 2，在任务分支验收，通过后合入本地 main。
- 基线 `main` 的 `20f8979`。分支 `codex/feature-share-duration-20261125`，worktree 为 `/Users/weifei/code/we-note/.worktrees/share-duration-20261125`。
- 原始需求为「文档的分享弹出界面，添加分享天数选择的功能吧，选择1天3天7天永久这样。 在用户设置的地方，分享的文档按笔记本查看，停止分享或者过期后删除显示」。
- 验收时从笔记弹窗选择 1 天、3 天、7 天或永久，默认 7 天。个人设置显示本账号各笔记本的有效分享。停止或到期时移除条目并收回访客访问权限，源笔记和已保存的副本保留。
- 在独立实例运行浏览器回归 `phase1.mjs`、`phase5.mjs`，运行服务端 `go test ./...`、`go vet ./...`，构建网页并交付。

## 验证与自审 · 2026-11-25

| 检查 | 命令与结果 |
| --- | --- |
| 服务端红灯 | 在 `services/api` 运行 `go test -count=1 ./internal/httpapi -run TestShareDurationsAndActiveList`，退出 1，基线返回 400，无法识别分享天数。 |
| 浏览器红灯 | `WENOTE_TEST_ORIGIN=http://localhost:19526 node apps/web/tests/phase1.mjs` 退出 1，基线找不到分享有效期选择框。 |
| 服务端绿灯与回归 | 新测试与 `TestLinkLifetimeScopeAndDownloadLimit` 通过。`go test -count=1 ./...`、`go vet ./...` 均退出 0。覆盖四种有效期、无效参数、用户隔离、到期边界、会话和停止分享。 |
| 客户端构建 | `./scripts/local.py start --port 19526` 从任务目录构建 Web、API 并启动成功，退出 0。Web 产物位于 `apps/web/dist`。 |
| 浏览器回归 | 使用 `WENOTE_TEST_ORIGIN=http://localhost:19526` 分别执行 `node apps/web/tests/phase1.mjs` 和 `node apps/web/tests/phase5.mjs`，均退出 0。覆盖默认选择、永久链接访问、保存副本、停止分享、跨库同名笔记与页面打开期间到期。 |

自审核对了旧链接的绝对到期时间、请求重试和快照清理。相对天数在服务端处理重试之后换算，永久链接继续保留快照引用。设置页复用服务端的有效链接条件，最近一条定时链接到期时更新列表，并清除空分组。`git diff --check` 通过。

## 任务分支验收

在 `http://localhost:19526` 使用普通验收账号 `share-review@example.invalid` 登录（密码随交付提供），或自行注册。进入「个人设置 → 我的分享」可看到「工作笔记」中的 3 天分享和「读书笔记」中的永久分享。打开任一示例笔记，点击「分享」，选择有效期并生成链接。可在「我的分享」停止对应链接，复查列表与访客访问。

独立实例 PID `32282`。相对于本任务 worktree，数据目录为 `services/api/data`，运行日志为 `dist/local/server.log`，构建日志为 `dist/local/share-build.log`。验收通过后在此目录执行 `./scripts/local.py stop`。
