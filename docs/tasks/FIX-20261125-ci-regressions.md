# 修复桌面与网页验收的四个失败项

- 任务 ID `FIX-20261125-ci-regressions`，类型 `bugfix`，影响端 web / server，状态 `DELIVERED`。
- 用户要求「修复一下这几个失败吧」。来源为 GitHub Actions `Desktop and web acceptance` 运行 `45619965525`，提交 `ee81873`。
- 基线为本地 `main@67f30911fc3d5e1fdaf459f9327ec7a8b17b2be8`，工作区 `.worktrees/ci-regressions-20261125`，分支 `codex/bugfix-ci-regressions-20261125`。用户已选择方式 2，在任务分支验收，通过后合入本地 main。

## 验收条件

1. 从分屏切到可视化编辑后，编辑器就绪即可直接使用键盘输入；用实际浏览器验证焦点与首键输入。
2. 本地存储测试在 Windows 校验使用 `/` 的存储键，同时保留读回和磁盘文件检查。
3. 在 Windows 验证重启后的分片续传，能核对完整下载字节、持久化存储键和分片清理结果。
4. 恢复工具在 cp1252 输出环境中成功退出，并通过恢复后的笔记正文校验。损坏归档等实际恢复错误仍应报告失败。

## 已知失败与复测入口

macOS 的 `apps/web/tests/phase2.mjs` 在切换编辑模式后未观察到正文焦点。Windows 的 `TestLocalStorePutIsAtomicAndContentAddressed` 和 `TestMultipartResumeAcrossRestart` 在存储键比较失败，`TestVaultDirectoryContainsRecoverableNoteHistory` 在恢复工具打印中文完成提示时遇到 `UnicodeEncodeError`。

用 `go test ./internal/blob ./internal/httpapi ./internal/store`（工作目录 `services/api`）和 `WENOTE_API=... node tests/e2e/desktop.mjs --browser` 复测，并核对 macOS / Windows 两端结果。

## 2026-11-26 任务分支验收

在 macOS 重现原始 `phase2.mjs` 焦点断言失败（退出 1）。给恢复用例加上 `PYTHONIOENCODING=cp1252:strict` 后，修复前 `go test -count=1 -run '^TestVaultDirectoryContainsRecoverableNoteHistory$' ./internal/store` 退出 1，错误为打印中文时发生 `UnicodeEncodeError`。两个存储键断言的 Windows 失败来自上述远端运行。

编辑模式切换时记录焦点，Crepe 就绪后仅在用户未移往其他控件时接管键盘输入。两个存储键期望值使用 `path.Join`，原有磁盘路径仍使用 `filepath.Join`。恢复脚本保留可显示的中文提示，遇到不支持中文的输出编码时改用英文报告同一个修订号。

| 验证 | 结果 |
| --- | --- |
| `go test -count=1 ./...`（`services/api`） | 退出 0，包含三项原失败测试，恢复后读取的笔记正文正确 |
| 使用同一份修订 42 的清单运行 `scripts/recover_vault.py` | UTF-8 和严格 cp1252 均成功恢复并显示修订号，损坏清单返回非零 |
| `npm run build --prefix apps/web`、`npm run build:desktop --prefix apps/web`、`node --test apps/web/tests/*.test.mjs` | 均退出 0，10 个前端单测通过 |
| 真实 Chrome 的聚焦输入、延迟加载后移到搜索框两个场景 | 均退出 0，直接键入的正文正确，主动离开后焦点保留在搜索框 |
| `GOOS=windows GOARCH=amd64 CGO_ENABLED=1 CC=x86_64-w64-mingw32-gcc go test -c -o ../../dist/windows-regression/ ./internal/blob ./internal/httpapi ./internal/store` | 退出 0，已编译三个 Windows 测试程序，原生执行待 CI |
| `WENOTE_API=dist/local/wenote-api node tests/e2e/desktop.mjs --browser` | 退出 1。双设备同步、浏览器第一阶段、可视化编辑器焦点和首键输入均通过，后续 Tab 缩进断言失败。在 `67f3091` 的独立页面上仅主动聚焦后运行原步骤，实际 Markdown 与本轮相同 |

自审核对异步编辑器加载、切换焦点、输出编码及磁盘路径与存储键用途。两个存储测试仍检查完整内容读回。`git diff --check` 通过。

验收服务由 `./scripts/local.py start --port 18642` 从任务工作区启动。打开 `http://127.0.0.1:18642` 后注册测试账号。新建或打开 Markdown 笔记，从分屏切到可视化编辑，直接输入并保存。PID 41053，日志 `dist/local/server.log`，数据 `services/api/data/`。验收后可在任务工作区运行 `./scripts/local.py stop` 停止服务。
