# 截图版笔记工作区

2026-11-24 `MERGED`，基线 `main` 的 `8e1774b`，分支 `codex/feature-note-workspace-20261124`，工作区 `.worktrees/note-workspace`。

用户确认[设计稿](../笔记工作区设计.md)，要求按有道截图完成紧凑三栏、单一浅色、手机适配。验收以真实编辑器的三栏尺寸、文字、搜索和文件定位、打开保存、专注与窄屏导航为准。复用现有 Web 和本地存储、文件插件与入口。在任务工作区构建 Web 和 Tauri 前端并运行浏览器回归，验收服务端口 18324。

## 实现与验收

普通笔记库的 Web 和 Tauri 入口共用 Mantine AppShell。桌面默认三栏，宽屏目录 202 px、列表 313 px，正文采用 14 px，文件标题 20 px。中等窗口收窄两列，平板用目录抽屉，手机逐屏浏览。布局按设备记忆，历史深色偏好进入普通笔记库时使用截图浅色。脑图文件继续使用插件自己的画布配色。网页列表使用服务提供的日期与文件大小，本地列表显示可用的路径与库信息。

1. 打开 `http://localhost:18324`，登录示例库，选择「读书笔记 → 操作系统 → Linux 内核设计与实现.md」。可对照[实际截图](../assets/mantine-workspace/implemented-desktop.png)。
2. 编辑一句文字，进入专注模式后退出，检查草稿，然后保存并重新打开。把窗口缩到 800 px，使用列表顶部按钮展开目录，再缩到 390 px，通过「笔记 / 新建 / 文件夹」切换。
3. 任务服务由 `./scripts/local.py start --port 18324` 启动，PID `98811`。服务日志位于 `dist/local/server.log`，数据位于 `services/api/data`。在任务目录执行 `./scripts/local.py status` 可查看状态，验收结束后可执行 `./scripts/local.py stop`。
4. macOS 入口为任务目录中的 `target/release/wenote-desktop`。Android 为 ARM64 调试包 `apps/client/src-tauri/gen/android/app/build/outputs/apk/universal/debug/app-universal-debug.apk`，验证设备为 `emulator-5598`。

## 测试与自审

| 检查 | 命令与实际结果 |
| --- | --- |
| 视觉回归 | `WENOTE_TEST_ORIGIN=http://localhost:18324 node apps/web/tests/theme.mjs` 首轮在右栏起点处失败，旧值 522 px。实现后实测 515 px，并通过白色纸面、14 px 正文、24 px 一级标题、草稿、保存与断点检查 |
| 平板目录 | 新增菜单焦点断言在旧实现失败。菜单挂入当前目录对话框后，通过键盘聚焦、Esc 关闭及重新选目录用例 |
| Web 构建及读写 | `npm run build --prefix apps/web` 通过。`WENOTE_API="$PWD/dist/local/wenote-api" node tests/e2e/desktop.mjs --browser` 通过双设备同步及五组浏览器端到端测试，覆盖历史、附件、导出、分享、插件及加密库 |
| 本地构建 | `npm run build:desktop --prefix apps/web` 与 `cargo build --locked -p wenote-desktop --release` 通过。macOS 验证包括编译和同步端到端测试 |
| 手机端 | 加载 `/private/tmp/wenote-android/env`，以任务目录的 `target/android-build` 为 Cargo 目标目录运行 `npm --prefix apps/client run android -- --debug`。安装后 `ANDROID_SERIAL=emulator-5598 WENOTE_TEST_ORIGIN=http://127.0.0.1:18324 node apps/web/tests/android.mjs` 通过，覆盖断网重启、返回、打印、导图修改和导出、系统分享、后台同步、冲突副本、分片附件与便携 ZIP |

自审时修复平板对话框内菜单拿不到焦点、触屏脑图缺少保存和导出入口的问题。同步测试改用附件目录中返回的真实 ID。用户验收期间保留任务分支、工作区、服务与构建产物。

实现提交 `d1fb934` 已于 2026-11-24 快进合入本地 `main`。服务健康检查返回 `ok`。当前等待用户验收。

## 验收归档

2026-11-24 `ACCEPTED`。用户确认本次工作区验收通过。

2026-11-24 `MERGED`。实现提交 `d1fb934` 和交付记录 `011bb0b` 已核实在本地 `main`。已关闭端口 18324 的验收服务与专用模拟器 `emulator-5598`，清理实现任务工作区与分支。macOS 程序、Android 安装包及验收库数据保存在主工作区 `dist/acceptance/FEAT-20261124-note-workspace/`，数据库完整性检查通过。
