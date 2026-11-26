# Windows 便携包清理与正式发布流程修复

用户需求为「修复已知问题，每次都套补建分支吗？」。

- 类型 `bugfix`，影响 `server`、`android` 和镜像发布。2026-11-26 从 `main@73f863c198ea76686a05d0efe8dcf449ac8efdf8` 登记为 `PLANNED`，用户选择方式 2（任务分支验收）后转为 `IN_PROGRESS`。
- 任务分支 `codex/bugfix-release-import-20261126`，工作区 `.worktrees/release-import-20261126`。服务端验收使用此工作区的独立端口、数据和日志。

## 验收条件

- Windows 成功确认导入和无效 ZIP 预览结束时释放句柄并清理暂存文件。需要重新确认目录和事务回滚时保留暂存包，可继续重试。
- 正式发布在干净的 Android runner 初始化 SDK 后调用 `sdkmanager`，沿用原有 APK 签名和上传流程。Android 验收复用相同工具准备步骤。
- 标签工作流在发布前检查本轮镜像的 AMD64、ARM64 两种架构。容器启动期连接被重置时允许重试，API 或首页持续异常时验收失败。

## 验证记录

- v0.1.1 Windows 的 `TestPortableVaultImport` 在导入后暂存包仍存在时失败；发布任务因 `sdkmanager: command not found` 退出 127，镜像第一次探测出现连接重置。详见[Windows 验收](https://github.com/invokerw/we-note/actions/runs/45805709453)和[标签发布](https://github.com/invokerw/we-note/actions/runs/45805709498)。

- 红阶段用原发布脚本运行 `python3 tests/release/check-web.py`，退出 1。首次 HTTP 断连后脚本返回 4，只访问一次 `/healthz`。修复后相同命令退出 0，覆盖断连重试、异常 JSON 状态与错误首页。
- 任务工作区运行 `go test -count=1 -race ./...` 和 `go vet ./...`，均退出 0。扩展已有导入测试，检查无效 ZIP 预览也要清除文件。保留原有事务回滚、文件夹冲突重试和成功后文件消失的断言。
- `ruby` 成功解析改动的两个工作流和组合动作。`bash -n scripts/check-release-web.sh`、`git diff --check` 均通过。自审核对签名条件、发布依赖、镜像 digest 和两种目标架构的启动参数。
- `./scripts/local.py start --port 19461` 成功。独立服务 `http://localhost:19461`，PID 83607，工作区日志 `dist/local/server.log`、数据 `services/api/data/`。`bash scripts/check-release-web.sh http://127.0.0.1:19461`、`WENOTE_TEST_ORIGIN=http://localhost:19461 node apps/web/tests/personal-settings.mjs` 均退出 0。验收可注册普通账号、建立目标库后在「个人设置 → 导出/导入」选择便携 ZIP 并确认。停止命令为本工作区的 `./scripts/local.py stop`。
- 原生 runner 核对提交 `c90b272`。Windows 的 `go test ./...` 通过，macOS 桌面和网页验收通过。[桌面与网页运行](https://github.com/invokerw/we-note/actions/runs/45810649729)。Android 从共享 SDK 步骤成功构建并安装调试 APK，模拟器后续等待旧编辑模式按钮超时。[Android 运行](https://github.com/invokerw/we-note/actions/runs/45810652968)。Windows 后续双设备同步用例报系统错误 5。本轮未推送新版本标签。
- 用户补充「一起修到 CI 全绿」。验收现包括任务分支的 Windows、macOS 双设备及网页用例、Android 模拟器完整用例均通过。Windows 保留分片便携包导入、同步和内容核对；Android 通过现有编辑模式完成离线编辑、保存和同步。
- 原生客户端使用可写句柄暂存 ZIP，独占锁内定位到文件尾、核对偏移并写入。双设备回归增加拒绝重复首片和错误偏移的检查，再从正确偏移传完并核对导入内容。Android 用例从「更多操作 → 编辑模式 → 分屏编辑」进入源码栏，验证软键盘、离线草稿和附件粘贴。`WENOTE_API=./dist/local/wenote-api node tests/e2e/desktop.mjs --browser` 在本地 macOS 完整通过，`node --check apps/web/tests/android.mjs`、`cargo fmt --all -- --check` 和 `git diff --check` 均退出 0。
