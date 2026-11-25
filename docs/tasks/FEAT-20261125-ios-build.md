# iPhone 工程与 GitHub Actions 构建

- 任务 ID `FEAT-20261125-ios-build`，类型 `feature`，状态 `DELIVERED`。
- 用户需求「好的补上ios工程吧」「2，我希望使用githubaction进行构建」。用于个人 iPhone 安装。
- 验收方式 2。在任务分支试装通过后合入本地 main。
- 基线 `main@d676b0b`，分支 `codex/feature-ios-build-20261125`，工作区 `.worktrees/ios-build`。
- 范围为现有 Tauri 客户端的 iOS 工程、应用私有目录同步、手机工作区、Actions 真机包及个人签名安装说明。复用现有服务，无服务端修改。
- 验收条件为 Actions 从干净环境构建 ARM64 iPhone 应用，下载产物后按说明完成个人签名并在 iPhone 启动，用已有 HTTPS 账户登录、同步笔记并断网重启打开编辑器。
- 构建和客户端回归在任务工作区执行，真机与个人签名由用户验收。

## 构建与验收记录

| 命令 | 退出状态 | 结果 |
| --- | --- | --- |
| `npm run ios --prefix apps/client`（实现前） | 1 | 缺少 ios 构建入口 |
| `npm run build:desktop --prefix apps/web` | 0 | 完成类型检查和原生客户端前端打包 |
| `cargo check --offline --locked -p wenote-desktop` | 0 | 共享 Rust 命令通过桌面目标编译 |
| `cargo test --offline --locked -p wenote-sync` | 0 | 3 个单测通过，1 个需要运行中 API 的测试按既有设置跳过 |
| `node --test tests/protocol/*.test.mjs` | 0 | 98 项通过 |
| `node /tmp/wenote-ios-ui-test.cjs` | 0 | 本地 Chrome 对构建产物模拟 iOS、Android、macOS 的 Tauri 接口，检查登录、目录选择、提交的同步参数和后台同步控件 |
| `xcodegen generate --spec apps/client/src-tauri/gen/apple/project.yml`、`plutil -lint` | 0 | 生成共享 scheme，工程、Info.plist 和 entitlements 通过格式校验 |
| `npm run ios --prefix apps/client`（实现后） | 1 | Tauri 已识别工程。本机只有 Command Line Tools，`xcrun simctl list runtimes` 返回 72，需在 GitHub macOS runner 归档 |

自审时核对了锁定版本的 Tauri CLI，ARM64 导出目录为 `gen/apple/build/arm64`。工程脚本使用仓库锁定的 CLI 并从客户端目录调用，移除了开发机路径。手机工作区复用紧凑布局，Android 专用后台任务和返回事件仍按平台启用。

用户已允许推送任务分支。首次远端运行 `45618440672` 已生成 `WeNote.ipa` 并通过包标识和 iPhoneOS 检查，`lipo` 参数顺序导致架构检查退出 1。已按该工具的命令格式调整，用本机 ARM64 二进制验证后重新构建。安装步骤见 README 的「用 GitHub Actions 构建并安装到个人 iPhone」。

## 方式 2 交付

受测提交 `ee81873ddccd0cedd7038cb33b035e51517bb0cb` 已推送到任务分支。[iOS IPA 运行 45619965527](https://github.com/invokerw/we-note/actions/runs/45619965527) 的构建、校验及上传均通过。已下载 artifact `15024676142` 到工作区 `dist/ios/ee81873/WeNote-iphone-unsigned.ipa`。本地复查 ZIP 完整性、Info.plist 和可执行文件架构通过，标识 `com.wenote.ios`，iPhoneOS 16.0+，ARM64。IPA SHA-256 为 `3e1fbe38e9616749232ee77f18e23cec8ba155b177652c251df151409ef92705`。

同一提交的独立桌面与网页验收运行 `45619965525` 有失败项。macOS 浏览器在 `apps/web/tests/phase2.mjs:251` 的编辑器焦点断言失败，Windows 服务端在本地存储、分片续传与可恢复历史测试中失败。日志见该运行。个人签名、真机登录、同步和断网重启编辑等待用户验收，保留任务分支和 worktree。
