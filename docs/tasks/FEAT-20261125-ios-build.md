# iPhone 工程与 GitHub Actions 构建

- 任务 ID `FEAT-20261125-ios-build`，类型 `feature`，状态 `IN_PROGRESS`。
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

待验证的 Actions 工作流为 `.github/workflows/ios.yml`，安装方式见 README 的「用 GitHub Actions 构建并安装到个人 iPhone」。首次推送任务分支会同时上传本地 main 相对远端的 69 个基线提交，已询问用户。当前没有远端运行编号或 IPA。拿到 IPA 后使用个人签名真机验收登录、同步及断网重启编辑。
