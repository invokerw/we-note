# 修复桌面与网页验收的四个失败项

- 任务 ID `FIX-20261125-ci-regressions`，类型 `bugfix`，影响端 web / server，状态 `IN_PROGRESS`。
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
| `GOOS=windows GOARCH=amd64 CGO_ENABLED=1 CC=x86_64-w64-mingw32-gcc go test -c -o ../../dist/windows-regression/ ./internal/blob ./internal/httpapi ./internal/store` | 退出 0，已编译三个 Windows 测试程序，原生执行结果见下方 GitHub Actions 记录 |
| `WENOTE_API=dist/local/wenote-api node tests/e2e/desktop.mjs --browser` | 退出 1。双设备同步、浏览器第一阶段、可视化编辑器焦点和首键输入均通过，后续 Tab 缩进断言失败。在 `67f3091` 的独立页面上仅主动聚焦后运行原步骤，实际 Markdown 与本轮相同 |

自审核对异步编辑器加载、切换焦点、输出编码及磁盘路径与存储键用途。两个存储测试仍检查完整内容读回。`git diff --check` 通过。

验收服务由 `./scripts/local.py start --port 18642` 从任务工作区启动。打开 `http://127.0.0.1:18642` 后注册测试账号。新建或打开 Markdown 笔记，从分屏切到可视化编辑，直接输入并保存。PID 41053，日志 `dist/local/server.log`，数据 `services/api/data/`。验收后可在任务工作区运行 `./scripts/local.py stop` 停止服务。

## GitHub Actions 复测

任务分支提交 `7c6df47` 于 2026-11-26 在 macOS 和 Windows 上完成验收运行。两端的 `go test ./...` 均通过，其中包括 Windows 原先失败的本地存储键、重启后分片续传和 cp1252 恢复三项测试。两端的浏览器也都通过了切换到可视化编辑器后的焦点和首键输入检查。[运行记录](https://github.com/invokerw/we-note/actions/runs/45730164307)

两个浏览器任务随后都停在 `apps/web/tests/phase2.mjs:257`。按 Tab 后，断言期待两行纯文本，第二行以两个空格缩进。实际 Markdown 在两端都保留了粗体和段间空行。macOS 将四个空格插在“子”和“项”之间，Windows 将其追加在第二行末尾。此次运行总体失败，该断言之后的浏览器用例尚未执行。[macOS 日志](https://github.com/invokerw/we-note/actions/runs/45730164307/job/139609897235) · [Windows 日志](https://github.com/invokerw/we-note/actions/runs/45730164307/job/139609897722)

## 继续修复桌面与网页 CI

用户反馈「修复ci失败问题」，沿用方式 2。范围扩展到运行 `45730164307` 未通过的浏览器验收及后续阶段。验收条件为在当前产品入口验证编辑、附件、导出和插件等行为，并在同一修复提交上通过 macOS、Windows 两个完整任务。

`WENOTE_API=dist/local/wenote-api node tests/e2e/desktop.mjs --browser` 在修改前退出 1。按现有三种 Markdown 模式重建操作步骤，保留分屏两空格缩进，并在已知光标位置验证 Crepe 的 Tab、中文输入法、标记、跨段选区及撤销重做。通过当前「笔记信息」和源码编辑入口验证标题定位与导出。

新增断言复现了已完成任务按 Enter 后新项被勾选、异步图片上传及键盘保存后正文失焦、代码块光标对比度仅为 2.93 的问题。修复后从任务工作区运行同一条端到端命令退出 0。两个设备同步及全部五个浏览器脚本通过，验证了图片名称、图片预览、离线导出和断点续传后的原始字节。`npm run build --prefix apps/web`、`npm run build:desktop --prefix apps/web`、`node --test apps/web/tests/*.test.mjs` 及 `git diff --check` 均退出 0，前端单元测试 10 项通过。自审覆盖了输入法组合输入、异步操作结束时的焦点归属、非待办列表按键和测试中的跨平台光标定位。

远端运行 `45745802543` 在 `4bab7bf` 上通过 macOS 全部步骤。Windows 通过 Go、编辑器与文件菜单，阶段四 `phase4.mjs:171` 在源码编辑器重做时失败。已对照 CodeMirror 的 `historyKeymap` 修正测试按键，Windows 使用 Ctrl+Y，macOS 使用 Cmd+Shift+Z。断言仍逐行比较重做后的完整 Markdown。
