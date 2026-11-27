# 笔记库 UI 组件与跨端交互统一

| 字段 | 内容 |
| --- | --- |
| 任务 ID / 类型 | `REFACTOR-20261127-library-ui` / `refactor` |
| 日期 / 状态 | 2026-11-27 / `MERGED`（两轮已交付改动验收通过） |
| 验收方式 | 2（任务分支验收，通过后合入本地 main） |
| 基线 | `main` · `c78ab416047f6011018261a15a789127c21961fd` |
| 分支 | `codex/refactor-library-ui-20261127` |
| worktree | `/Users/weifei/code/we-note-REFACTOR-20261127-library-ui` |
| 影响端 | Web、桌面、Android。本次涉及客户端，浏览器集成验收使用任务独立实例。 |

## 用户原始需求

> ui风格统一比如说 Ant design 他的button input 弹窗等选择都一致。我需要的是这种ui风格。
>
> 把ui风格的规则与修复方式写入文档。当前要修复的ui写一个文档，然后开始任务吧

## 范围与验收条件

- [ ] 按[笔记库 UI 风格规范](../笔记库UI风格规范.md)统一通用控件和交互，并逐项验收[当前 20 项修复清单](../笔记库UI修复清单.md)中的正常、失败及取消路径。
- [ ] Web、桌面与 Android 使用相同的动作名称和组件语义，桌面弹窗与手机面板保留适合平台的布局与返回行为。
- [ ] 宽屏与手机、浅色与深色分别验证主按钮、弹层和回收站预览。文件操作从列表与正文进入均展示一致的目标、校验和提交反馈。
- [ ] 覆盖设置、恢复、分享、导入导出、登录和同步入口，验证既有权限、文件读写、同步、插件保存与草稿保护。
- [ ] 自审、受影响测试与客户端构建通过，在选定分支交付可打开的验收入口；设备验证与浏览器模拟结果分别记录。

通用控件采用仓库已有的 Ant Design。管理后台作为组件用法参考。服务端协议、编辑器内核和笔记文件格式沿用现有实现。

## 实施与验证计划

1. 在任务 worktree 启动独立验收实例，记录端口、数据目录和日志。先在 `apps/web/tests/theme.mjs`、`entry-menu.mjs`、`trash.mjs` 等现有套件中复现按钮跨弹层、深色和文件入口问题。
2. 接入共享主题、控件和文件操作表单，从新建、重命名、移动、删除到恢复验证实际文件结果，然后按清单迁移设置、分享、导入和客户端入口。每轮先记录失败测试，再改实现，复查完整差异并重跑受影响用例。
3. 按变更运行 `apps/web` 下的 `node --test tests/*.test.mjs` 和使用 `WENOTE_TEST_ORIGIN` 的对应浏览器套件。构建 `npm run build --prefix apps/web`、`npm run build:desktop --prefix apps/web`，并按平台提供客户端入口或产物。
4. 每项的 TDD 命令、退出状态、受测提交及平台交付记录追加在本文件；在清单中更新进展。

## 状态与证据

| 日期 | 状态 | 记录 |
| --- | --- | --- |
| 2026-11-27 | `PLANNED` | 从本地 main 创建任务分支、登记开发账本、编写长期规范与本次修复清单。验收方式已询问，收到选择后进入实现。 |
| 2026-11-27 | `IN_PROGRESS` | 用户选择方式 2，启动独立验收环境并进入测试驱动实现。 |

## 首轮交付 · 文件操作和阅读主题

2026-11-27 在任务分支交付首轮实现。20 项整体范围仍以清单为准。本轮可验收新建笔记、建立库、上传路径、文件操作表单、手机回收站操作和深色阅读；设置、恢复、分享及其他待迁移入口留在任务清单中。

| 验证 | 命令与结果 |
| --- | --- |
| 红阶段 | 从独立实例运行 `WENOTE_TEST_ORIGIN=http://localhost:18327 node tests/library-ui.mjs`，首批四项失败，复现两种主色、两处深色对比度缺陷及正文重命名入口缺失。随后两项先用 `node --test --test-name-pattern` 单独运行，建库表单及回收站操作面板均因不可见而失败，退出 1。 |
| 绿阶段 | 在 `apps/web` 用同一实例运行 `node tests/library-ui.mjs`，6/6 通过。`node --test tests/*.test.mjs` 退出 0，16/16 通过。 |
| 回归 | 在 `apps/web` 逐一运行 `node tests/<名称>.mjs`，`entry-menu`、`theme`、`trash`、`phase1`、`phase4`、`recovery`、`library-search`、`starred-notes`、`personal-settings`、`sync-conflicts`、`native-editors` 均退出 0。`sync-conflicts` 使用本轮本地前端和模拟 IPC 覆盖宽屏、手机布局。 |
| 自审与复测 | 移除旧本地命名表单及 CSS；回收站 Markdown 接入完整阅读主题；目标目录下拉挂在当前对话框内。手动通过 Playwright 打开真实移动窗口核对选择器、Escape 与焦点，发现旧输入样式影响选择器内部输入，已收窄作用域。复跑 `library-ui`、`entry-menu`、`theme`、`sync-conflicts` 均为 0。 |
| 构建 | `npm run build --prefix apps/web`、`npm run build:desktop --prefix apps/web`、`cargo build --locked --offline -p wenote-desktop` 均退出 0。Vite 提示有超过 500 kB 的分块。 |
| Android | `npm run android --prefix apps/client -- --debug` 退出 1。Tauri 找到本机 SDK 目录，但缺少 Android 命令行工具。手机布局与模拟 IPC 已验证，APK 和真机待验。 |

### 验收入口

- Web 使用 `http://localhost:18327`，独立账号保存在工作区 `dist/local/preview-login.txt`。已通过浏览器登录并打开示例库的移动表单。打开「会议/周会.md」，从正文更多及列表右键分别操作；在回收站打开「待恢复.md」，在个人设置切换深色查看正文。
- macOS 程序为工作区 `target/debug/wenote-desktop`，本地客户端前端在 `apps/client/dist/`。验收实例由 `./scripts/local.py start --port 18327` 启动，PID 25827，日志 `dist/local/server.log`，数据 `services/api/data/`，停止命令 `./scripts/local.py stop`。
- 验收方式 2。任务 worktree、分支和实例保留，用户反馈沿用本任务记录。

受测实现提交 `e131c4a`。提交前 `git diff --cached --check` 退出 0。实现已在 `codex/refactor-library-ui-20261127` 交付首轮验收。

## 第二轮 · 个人设置文件选择

用户补充“个人设置中的选择文件也需要更新”。沿用方式 2，在原 worktree 更新清单第 14–16 项。

- [x] 账户与安全的「更换头像」、插件管理的「安装本地插件包」、导入的「选择 ZIP」共用带名称的 Ant Design 次按钮，可用鼠标和键盘打开系统文件选择器，适配浅色宽屏和深色手机布局。
- [x] 保留各入口的类型限制、忙碌或离线禁用条件。选中文件后进入对应预览或校验流程，取消选择保留当前状态，再选同一文件可重新处理。

| 验证 | 结果 |
| --- | --- |
| 红阶段 | 在 `apps/web` 执行 `WENOTE_TEST_ORIGIN=http://localhost:18327 node --test --test-name-pattern='个人设置的文件选择按钮' tests/library-ui.mjs`，退出 1。旧版宽屏和手机的头像入口均依赖覆盖在文字上的透明文件控件。 |
| 绿阶段与自审 | 对照三处调用检查文件类型、禁用条件、取消、重复选择和插件包异步校验的顺序。移除头像专用 CSS，补测离线和重新联网时 ZIP 按钮的状态。重建并重启任务实例后 `node tests/library-ui.mjs` 8/8 通过，覆盖 1280px 浅色与 390px 深色按钮的高度、圆角、颜色、对比度和回车打开选择器。浏览器集成命令使用同一 `WENOTE_TEST_ORIGIN`。 |
| 回归 | 在 `apps/web` 运行 `node --test tests/*.test.mjs`，16/16 通过。`node tests/personal-settings.mjs`、`node tests/phase4.mjs`、`node tests/client-mcp.mjs`、`node tests/sync-conflicts.mjs` 均退出 0。覆盖重复选择同一头像、便携包，以及取消选择后继续安装待确认插件。 |
| 构建与设备 | `npm run build --prefix apps/web`、`npm run build:desktop --prefix apps/web`、`cargo build --locked --offline -p wenote-desktop` 均退出 0。`npm run android --prefix apps/client -- --debug` 退出 1，本机 SDK 缺少命令行工具。手机浏览器布局已验证，Android 系统选择器真机待验。 |

验收实例为 `http://localhost:18327`，本轮服务 PID 32826，账号、日志、数据目录、macOS 程序与停止命令见上方验收入口。在「个人设置」依次进入「账户与安全」「编辑与插件」「导出/导入」，核对三个文件按钮；可选择头像查看预览，取消后再选同一张图片。

本轮受测实现提交 `0f1714c`，已在原任务分支交付验收。

## 验收与归档

2026-11-27 用户确认“验收完毕”，两轮已交付改动记为 `ACCEPTED`。本地 `main` 快进至 `c7816d9`，包含文件操作和阅读主题 `e131c4a`、个人设置文件按钮 `0f1714c`。已核对合入时的文件树与验收版本一致，状态转为 `MERGED`。其余 UI 迁移仍见[修复清单](../笔记库UI修复清单.md)，Android 真机验证仍待补充。

已停止 18327 端口的验收实例并清理任务 worktree 与本地任务分支。Web 与 macOS 产物、验收数据、日志和截图已归档至主工作区 `dist/acceptance/REFACTOR-20261127-library-ui-c7816d9/`，逐文件校验通过。
