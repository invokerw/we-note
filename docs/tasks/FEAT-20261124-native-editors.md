# Crepe 编辑器与 Mind Elixir 导图

2026-11-24 · feature · Web、桌面与 Android · `IN_PROGRESS`

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

- Web 服务 `http://127.0.0.1:18274`，PID `24552`，日志 `dist/local/server.log`，数据目录 `services/api/data`。在本工作区执行 `./scripts/local.py status` 查看状态，`./scripts/local.py stop` 停止服务。
- 此验收库可通过 `/gm` 和工作区的 `services/api/data/setup.token` 设置第一个本地账户。浏览器自动化另用临时库和一次性账户。
- macOS 运行 `./dist/acceptance/WeNote`。Android 安装 `dist/acceptance/WeNote-arm64-debug.apk`；USB 调试时执行 `adb reverse tcp:18274 tcp:18274`，客户端服务地址填 `http://127.0.0.1:18274`。
- 在笔记库新建 Markdown，切换「编辑模式 → 可视化编辑」，改一段后保存。在「编辑模式 → 思维导图」点击章节可跳回正文。
- 从文件夹或文件的操作菜单选「新建 → 思维导图」，输入名称，创建 `.mind.json`。添加子主题、修改备注、撤销重做，保存后重新打开核对。Android 窄屏可横向滚动节点工具栏。
