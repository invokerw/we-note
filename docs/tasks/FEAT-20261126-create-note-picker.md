# 创建笔记窗口

2026-11-26，feature，影响 Web、桌面及 Android 的共享客户端。基线 `main@23b26aa`，任务分支 `codex/feature-create-note-picker-20261126`，worktree `/Users/weifei/code/we-note/.worktrees/create-note-picker-20261126`。用户选择方式 2，在任务分支验收通过后合入。

## 原始需求

> 参考这个新建笔记，做出符合wenote的创建笔记窗口，然后调用默认的创建笔记

## 范围与验收

- 侧栏、Web 空状态和手机新建入口先打开图标选择窗口。「新建笔记」包含 Markdown 和思维导图，「更多方式」包含已有的文件和文件夹上传。
- 选择后沿用对应端的默认创建流程、当前目录和格式初始内容，取消窗口或取消命名时不写入文件。
- 适配窄屏、深浅色、键盘关闭，保留目录右键操作与已有草稿保护。本轮仅调整客户端。
- 先运行浏览器失败测试，再接入窗口。验证相关浏览器回归、Web 与桌面构建，从任务工作区提供独立验收入口。

## 进度

- 2026-11-26 `PLANNED`，从基线创建任务分支并登记。
- 2026-11-26 `IN_PROGRESS`，用户选择方式 2。
- 红阶段，在 `apps/web` 运行 `WENOTE_TEST_ORIGIN=http://localhost:18276 node tests/phase1.mjs`，退出 1。原侧栏直接弹出路径输入，测试等待带「更多方式」的选择窗口超时。

## 验证和自审

- 2026-11-26，`npm run build --prefix apps/web`、`npm run build:desktop --prefix apps/web`、`cargo build --locked -p wenote-desktop` 均退出 0。
- 在 `apps/web` 运行 `node --test tests/*.test.mjs`，11 项通过。设置 `WENOTE_TEST_ORIGIN=http://localhost:18276` 后分别运行 `node tests/phase1.mjs` 和 `node tests/entry-menu.mjs`，均退出 0。覆盖侧栏和空白页入口、默认命名与取消、文件夹上传、窄屏深色样式、子目录创建导图并显示中心节点，以及原有目录菜单与草稿保护。
- 自审中修正跨宽度切换时可能遗留的弹窗行内坐标，重新构建客户端并复跑两套浏览器回归。已检查实际桌面宽度截图及 `git diff --check`。
- `node --check apps/web/tests/android.mjs` 退出 0。`npm run android --prefix apps/client -- --debug` 退出 1，本机缺少 Android SDK 命令行工具，APK 构建及真机验证待具备工具链后执行。

## 验收入口

- 在任务 worktree 运行 `./scripts/local.py start --port 18276`。访问 `http://localhost:18276`，试用账号和密码保存在 `dist/local/preview-login.txt`。已为该帐号创建「我的笔记库」。点击「新建笔记」，选择 Markdown 或思维导图，确认路径并打开笔记；也可在更多方式中上传文件或文件夹。
- 独立实例 PID 63371，日志 `dist/local/server.log`，数据 `services/api/data`，健康检查 `curl -fsS http://localhost:18276/healthz` 返回 `ok`。验收结束后从本 worktree 运行 `./scripts/local.py stop`。
- Web 产物 `apps/web/dist`，实拍 `dist/local/create-note-window.png`。桌面客户端 `target/debug/wenote-desktop`，运行 `./target/debug/wenote-desktop` 后可连接同一服务。
