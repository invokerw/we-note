# Crepe 编辑器与 Mind Elixir 导图

2026-11-24 · feature · 服务端、Web、桌面与 Android · `DELIVERED`

用户选择方式 2，在任务分支验收，通过后才合入 main。基线 `16d29c8`，设计提交 `6d11538`，分支 `codex/feature-crepe-mind-elixir-20261124`，worktree `/Users/weifei/code/we-note/.worktrees/native-editors`。

按设计交付可选的 Crepe Markdown 编辑、标题导图、新建 `.mind.json`、原生画布、保存与导出重开。验收关注 Markdown 原文保留、输入与附件、节点结构、文件路由与三端构建。使用 node:test、浏览器验收、Web/Tauri 构建和任务专用本地服务。

## 验证与自审

| 项目 | 命令及结果 |
| --- | --- |
| 红阶段 | `node --test apps/web/tests/native-editors.test.mjs` 退出 1，缺少原生导图读取与 Markdown 局部修改模块 |
| 单元回归 | `node --test apps/web/tests/*test.mjs` 退出 0，共 7 项 |
| 浏览器 | `node apps/web/tests/native-editors.mjs` 退出 0。真实 API 和 Chrome 验证 Markdown 局部编辑后的 YAML、CRLF、空行、强调写法，章节定位，新建导图、节点备注、撤销重做、箭头、主题、布局和普通 JSON 分派 |
| Web 与桌面前端 | `npm run build --prefix apps/web`、`npm run build:desktop --prefix apps/web` 退出 0。Vite 提示部分分块超过 500 kB，Crepe 按需加载 |
| macOS | `cargo build --locked -p wenote-desktop --release` 退出 0，产物为 Apple Silicon 可执行程序 |
| Android | `npm run android --prefix apps/client -- --debug` 退出 0。使用独立 Cargo 目标目录重新生成 Android Kotlin 绑定，产出 ARM64 调试 APK |
| 手机回归 | `ANDROID_SERIAL=emulator-5604 node apps/web/tests/native-editors.mjs --android` 退出 0。实际 APK 与临时 API 验证 Web → Android 同步，手机编辑保存，断网重启读取，恢复连接后比对服务端的正文与节点备注 |
| 变更检查 | `git diff --check` 和暂存区检查通过 |

自审补齐了复合后缀的创建和复制、保存回执与草稿快照的区分、异步图片预览 URL 释放、手机横向工具栏及关系箭头与节点相交处的点击命中。移动端测试在只读模拟器执行。实体设备中文输入法连续组词、Windows 和 Linux 客户端、超大笔记性能尚待验证。含引用定义等无法安全映射的 Markdown 会提示使用源码编辑。

## 任务分支验收入口

- Web 服务 `http://127.0.0.1:18274`，PID `31963`，日志 `dist/local/server.log`，数据目录 `services/api/data`。在本工作区执行 `./scripts/local.py status` 查看状态，`./scripts/local.py stop` 停止服务。
- 打开 Web 首页，选择「创建账户」，填写邮箱和至少 8 位密码，点击「注册并登录」。创建第一个笔记库后，桌面端和 Android 可用同一账号登录此服务。
- macOS 运行 `./dist/acceptance/WeNote`。Android 安装 `dist/acceptance/WeNote-arm64-debug.apk`；USB 调试时执行 `adb reverse tcp:18274 tcp:18274`，客户端服务地址填 `http://127.0.0.1:18274`。
- 在笔记库新建 Markdown，切换「编辑模式 → 可视化编辑」，改一段后保存。在「编辑模式 → 思维导图」点击章节可跳回正文。
- 从文件夹或文件的操作菜单选「新建 → 思维导图」，输入名称，创建 `.mind.json`。添加子主题、修改备注、撤销重做，保存后重新打开核对。Android 窄屏可横向滚动节点工具栏。

2026-11-24 已在任务分支交付实现 `4876d60`。保留任务工作区、本地服务、模拟器与产物，待用户验收。

## 11 月 24 日验收反馈 · 普通账号自助注册

用户要求默认可以创建账号并登录，方便测试。沿用方式 2。验收条件为全新数据库及当前独立实例均可从 Web 首页用邮箱和密码注册普通账号并直接登录，管理员权限仍由单独的初始化流程授予，升级时保留已经保存的注册策略。

本轮按 `CHANGES_REQUESTED` 返工。普通用户注册和登录使用服务端原有鉴权流程，新的数据库初始值为开放注册、邮箱验证可选。现有验收库只更新这两项设置。

| 验证 | 命令与结果 |
| --- | --- |
| 红阶段 | `go test ./internal/httpapi -run '^TestDefaultRegistrationAndLoginWithoutAdmin$' -count=1` 退出 1，首次普通注册返回 403 `REGISTRATION_DISABLED` |
| 服务端 | `go test ./... -count=1` 退出 0。含首次普通注册、立即登录、笔记库访问、管理员接口拒绝和既有邀请策略保留 |
| 浏览器 | `node apps/web/tests/native-editors.mjs` 退出 0。临时空库从首页注册并自动登录，进入创建第一个笔记库页面，再用同一账号登录并编辑保存 Markdown 和导图 |
| 管理员策略 | `node apps/web/tests/gm.mjs` 退出 0。管理员主动设置仅邀请注册和强制邮箱验证后，邀请、邮件验证与登录流程通过 |
| 独立实例 | `./scripts/local.py start --port 18274` 重建并启动成功。`curl -fsS http://127.0.0.1:18274/api/v1/auth/registration` 返回 `open` 和 `false`，`/healthz` 返回 `ok` |

自审已将依赖旧默认值的邀请和备份测试改为显式设置对应策略。普通账号浏览器验收覆盖了首页注册和已有账号登录两个入口。本轮按方式 2 交付。
