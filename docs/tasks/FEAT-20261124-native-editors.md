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
- 在笔记库新建 Markdown，切换「编辑模式 → 可视化编辑」，改一段后保存。切换到「分屏编辑」核对 Markdown 源码，再切换「预览」查看正文。
- 从文件夹或文件的操作菜单选「新建 → 思维导图」，输入名称，创建 `.mind.json`。添加子主题、修改备注、撤销重做，保存后重新打开核对。Android 长按节点或空白画布后松开即可打开相应菜单。

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

## 11 月 24 日验收反馈 · 可视化编辑排版

用户希望了解可用模式并优化可视化编辑的外观。沿用方式 2，在 Web、桌面和 Android 共用的 Crepe 编辑器中调整中文排版、内容宽度与深色外观，通过浏览器检查字号偏好、标题比例和窄屏布局。

| 验证 | 命令与结果 |
| --- | --- |
| 红阶段 | `node apps/web/tests/native-editors.mjs` 退出 1。旧版一级标题 42px、二级 36px、正文 16px。列表结尾的示例笔记因编辑器附加空段而隐藏正文 |
| 视觉与保存 | `node apps/web/tests/native-editors.mjs` 退出 0。Chrome 检查标题层级、字号切换、宽屏行长、390px 窄屏、深色画布，并逐字比对列表后续写保存的 Markdown。示例截图 `dist/acceptance/crepe-typography.png` |
| Web 和单元测试 | `npm run build --prefix apps/web`、`node --test apps/web/tests/*test.mjs` 退出 0，共 7 项单元测试。18274 验收服务实际返回的 Crepe 样式和脚本与本次构建逐字节一致 |
| 客户端 | `npm run android --prefix apps/client -- --debug` 及 `cargo build --locked -p wenote-desktop --release` 退出 0。已更新 `dist/acceptance/WeNote` 和 `dist/acceptance/WeNote-arm64-debug.apk` |
| Android | `ANDROID_SERIAL=emulator-5608 node apps/web/tests/native-editors.mjs --android` 退出 0。在独立只读模拟器验证登录、Crepe 保存、离线重开和同步。自审时补齐了同时连接多台模拟器时测试连接的释放 |

本轮重新交付方式 2。Web 刷新后打开 Markdown 的「可视化编辑」验收。Apple Silicon 客户端完成构建，实际交互通过 Chrome 和 Android WebView 验证。

## 11 月 24 日验收反馈 · 精简 Markdown 模式

沿用方式 2。Markdown 菜单和默认模式设置保留分屏编辑、可视化编辑和预览。移除可视化编辑的「插入附件」按钮。检查旧偏好、手机编辑和独立导图文件。

| 项目 | 验证结果 |
| --- | --- |
| 红阶段 | `node apps/web/tests/native-editors.mjs` 在原代码上分别复现多余的三个菜单项和可视化编辑中的附件按钮，退出 1 |
| 单元 | `node --test apps/web/tests/*test.mjs` 退出 0，8 项通过。旧值 `live`、`edit`、`map` 分别映射为可视化编辑、分屏编辑和预览 |
| Chrome | `node apps/web/tests/native-editors.mjs` 退出 0。验证菜单与设置一致、旧账号和单篇笔记模式迁移、可视化编辑无附件按钮、分屏保留附件、特殊语法切换分屏及独立导图保存重开 |
| Android | `ANDROID_SERIAL=emulator-5608 node apps/web/tests/native-editors.mjs --android` 退出 0。已验证手机菜单、可视化编辑保存、同步与离线重开 |
| 构建及交付 | `npm run build --prefix apps/web`、`npm run android --prefix apps/client -- --debug`、`cargo build --locked -p wenote-desktop --release` 退出 0。Web 首页与静态编辑器脚本已核对，任务工作区的 APK 和 macOS 客户端已更新 |

本轮自审核对了手机编辑和新建笔记的入口、普通文本的编辑模式以及 Crepe 遇到专用语法时的分屏入口。默认 Markdown 编辑器采用 Crepe，手机浏览笔记先进入预览。按方式 2 在原分支交付。

## 11 月 25 日验收反馈 · 可视化编辑左对齐

沿用方式 2。正文栏靠左并预留边距，桌面扩宽时标题和段落起点固定，手机可写宽度和段落操作可用。

- 旧版在 1440px 浏览器窗口中正文左边距为 114.5px，`node apps/web/tests/native-editors.mjs` 在新验收条件下退出 1。
- 新版在 1440px、1920px 和 390px 窗口将标题和正文放在编辑区左侧 40px 处。段落添加和拖动按钮在边距内纵向排列。自审复查了缩放窗口后的按钮命中范围与横向溢出。
- `node apps/web/tests/native-editors.mjs` 和 `node --test apps/web/tests/*test.mjs` 退出 0，浏览器覆盖编辑、保存和三种宽度。实际效果图为 `dist/acceptance/crepe-left-aligned.png`。
- `npm run build --prefix apps/web`、`npm run android --prefix apps/client -- --debug` 和 `cargo build --locked -p wenote-desktop --release` 退出 0。本工作区的 macOS 程序和 APK 已更新，本轮交互验收使用 Chrome。18274 验收服务实际返回的 Crepe 样式与本次构建一致。

## 11 月 25 日验收反馈 · 可视化编辑自适应左边距

沿用方式 2。在可视化编辑中，标题和正文的左边距按编辑区宽度的 7% 计算，下限 40px，上限 96px。验收覆盖手机、常规桌面和宽屏窗口，并检查段落按钮的可点击范围。

- 红阶段在 925px 宽的编辑区测得原边距为 40px，期望 64.75px。调整后 `node apps/web/tests/native-editors.mjs` 通过，覆盖 390px、1440px 和 1920px 窗口及缩放后段落按钮的位置。宽屏截图为 `dist/acceptance/crepe-fluid-inset.png`。
- `node --test apps/web/tests/*test.mjs` 的 8 项测试通过。自审复核了正文最大宽度、标题对齐、按钮空间和移动端横向溢出。
- Web、macOS 和 Android 构建通过，验收客户端已更新，18274 服务返回的样式与此次构建一致。本轮交互检查使用 Chrome。

## 11 月 25 日验收反馈 · 思维导图画布与右键菜单

沿用方式 2，修复 Web、桌面和 Android 导图编辑区布局。画布应铺满文件标题下方的可用空间。保存、导出、节点编辑及布局操作移入上下文菜单，手机可长按操作，关系箭头等输入浮于画布上。

- 红阶段 `node apps/web/tests/native-editors.mjs` 退出 1。原画布左右各留 22px，上方留 124.4px，底部留 52.6px。
- `ANDROID_SERIAL=emulator-5612 node apps/web/tests/native-editors.mjs --android` 退出 0。Chrome 验证菜单关闭、备注保存重开、撤销与重做、关系箭头、布局、主题、文件导出和宽窄窗口四边。Android WebView 用触屏手势验证长按节点、长按空白处保存、离线重开和回网同步。
- 自审与手机实测发现本地客户端底部还有 49px 的反向链接栏。已将导图的反向链接移入标题「更多操作」并复测入口与画布边界。关系箭头与备注使用浮层，打开时画布尺寸不变。
- 8 项 `node --test apps/web/tests/*test.mjs` 通过。`npm run build --prefix apps/web`、`npm run android --prefix apps/client -- --debug`、`cargo build --locked -p wenote-desktop --release` 退出 0。已核对 18274 验收服务的首页和导图脚本，更新 `dist/acceptance/WeNote`、`dist/acceptance/WeNote-arm64-debug.apk`，截图为 `dist/acceptance/mind-context-menu.png`。macOS 完成构建，本轮界面交互在 Chrome 和 Android 模拟器验证。
