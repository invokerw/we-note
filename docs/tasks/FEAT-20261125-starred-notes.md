# 笔记加星与快速访问

- 任务 `FEAT-20261125-starred-notes`，类型 `feature`，状态 `ACCEPTED`。
- 已验收需求来自 `main` 的 `c6f8589`，见[笔记加星需求](../笔记加星需求.md)。
- 用户选择方式 2，在任务分支验收，通过后合入本地 `main`。
- 分支 `codex/feature-starred-notes-20261125`，工作区 `.worktrees/starred-notes-20261125`。
- 范围为笔记工作区的加星导航、条目菜单、标题栏和按用户与库隔离的持久状态。
- 验收覆盖空列表、右键目标、双向切换、草稿与光标、同名路径、刷新和切库。
- 计划执行加星端到端用例和 Web 构建，在任务工作区提供独立验收入口。

## 开发与验证

- 红阶段在隔离实例运行 `WENOTE_TEST_ORIGIN=http://localhost:19571 node apps/web/tests/starred-notes.mjs`，退出 1。Chrome 在等待侧栏「加星」时超时。
- 绿阶段接入网页和本地客户端共用的侧栏、笔记菜单与标题栏。本次使用客户端本地存储，按账号、笔记库隔离。网页登录按文件 ID 识别笔记，本地库按完整路径区分笔记，应用内移动时迁移对应标记。离线打开的本地库使用独立的本机身份。
- 自审核对了右键目标、切换库、搜索范围、移动本地文件、跨标签页更新和点击星形时的编辑器焦点。网页与手机宽度测试加入同一浏览器的第二个标签页，验证一处取消后另一处的标题栏也会更新。
- 在任务工作区执行 `npm run build --prefix apps/web`、`npm run build:desktop --prefix apps/web`、`cargo build --locked --offline --release -p wenote-desktop`，均退出 0。
- `node --test apps/web/tests/*test.mjs` 通过 10 项。以 `WENOTE_TEST_ORIGIN=http://localhost:19571` 执行 `node apps/web/tests/starred-notes.mjs`、`node apps/web/tests/library-search.mjs`、`node apps/web/tests/trash.mjs`，最终均退出 0。`git diff --check` 通过。

## 方式 2 验收交付

- 从本 worktree 执行 `./scripts/local.py start --port 19571` 启动的隔离服务位于 `http://localhost:19571`，PID 33076，日志 `dist/local/server.log`，数据目录 `services/api/data/`。验收完成后可在同一目录执行 `./scripts/local.py stop`。
- 测试账号与直达笔记库地址见工作区的 `dist/local/验收账号.txt`。选「加星验收」，右键 `工作/计划.md` 加星，在左侧「加星」打开它，编辑正文后用右上角星形取消。回到原文件夹可再次加星。
- macOS 可执行程序位于 `target/release/wenote-desktop`。手机交互已在 Chrome 的 390 px 视口验证，原生客户端完成 macOS 构建，真机交互待验收。
- 2026-11-25 任务由 `IN_PROGRESS` 转为 `DELIVERED`。任务分支、worktree 和服务保留至用户明确验收通过。

## 用户验收与合入

2026-11-26，用户确认版本 `7e0ffc1` 验收完毕，按方式 2 收尾。
