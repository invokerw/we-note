# 本地文件插件与右侧文档区

2026-11-26 · `feature` · Web、桌面、Android · `DELIVERED`

基线为本地 `main` 的 `23b26aa`，分支为 `codex/feature-plugin-document-ui-20261126`，工作目录为 `.worktrees/plugin-document-ui-20261126`。用户选择方式 2，先在任务分支验收，通过后再合入 main。预期改动集中在客户端，使用任务 worktree 构建 Web 和桌面前端。

## 用户原始需求

> 现在插件只是作为本地文件编辑显示的一个工具。不在考虑其他功能。还有我想规范下对于最右边界面的显示。我希望右上角有固定的操作比如说保存，加星，分享等(这个需要你考虑下哪些是固定的哪些是特定笔记的)，插件可以自定义添加右上角的按钮依据需要。然后，下面的显示一定要全屏。支持亮暗主题变化。这些都要写到文档以及代码接口中。还有啥需要思考的你可以帮我补充我们讨论

## 范围和验收条件

- [x] 规范限定为本地文件编辑、显示及其文档操作。保存、加星、分享、更多的顺序和可用条件由宿主管理。明确各端分享能力、只读、草稿及窄屏行为。
- [x] 可安装包经公开接口声明并执行当前文档的专用命令。保留旧版包的打开与保存路径。真实示例走通安装、显示、执行和撤销或放弃修改。
- [x] 标题下方铺满文档面板的可用宽高，包含空文档、错误和只读状态。正文负责滚动，插件切换时清除旧按钮。窄屏溢出操作仍可触达。
- [x] 跟随宿主实际亮暗配色，切换后保留草稿和编辑状态。正文、选区、焦点、禁用按钮可辨。
- [x] 增补可验证的接口说明、失败测试、聚焦回归和真实界面验收。从本 worktree 构建客户端并记录入口和测试结果。

## 记录

2026-11-26 登记需求，已核对 `NoteHeading`、Web `Editor`、桌面与 Android 共用入口及插件运行时。当前安装包只导出文本转换接口，外部插件没有标题栏命令声明；现有普通插件正文仍有工具栏和文本框。详细交互与接口提案见[文件插件开发规范](../插件开发规范.md)。

## 本轮交付与验证

2026-11-26，方式 2。可选 `actions` 扩展现有 API v1，`edit` 只改草稿，`message` 只显示文本。共享标题栏新增 `fileActions` 插槽。窄屏按正文面板宽度收纳操作，WASM 正文沿用宿主颜色，桌面插件的反向链接进入既有信息面板。

| 验证 | 命令和结果 |
| --- | --- |
| 红阶段 | 在 `apps/web` 执行 `node --test tests/plugin-actions.test.mjs`，退出 1，基线缺少 `documentActions`。 |
| 单元回归 | 在 `apps/web` 执行 `node --test tests/*.test.mjs`，退出 0，12 项通过。 |
| 界面验收 | 根目录执行 `WENOTE_TEST_ORIGIN=http://localhost:19876 node apps/web/tests/phase4.mjs` 和同环境的 `node apps/web/tests/theme.mjs`，均退出 0。覆盖安装旧清单、缺失导出拒绝、只读提示、转换结果保存和重开、主题切换保留草稿、全幅几何尺寸、390 像素窗口、禁用回退。 |
| 构建 | `npm run build --prefix apps/web`、`npm run build:desktop --prefix apps/web` 和 `cargo build --locked --offline -p wenote-desktop` 均退出 0。Vite 提示部分分块大于 500 kB。 |
| 自审 | 分开宿主保存和文件操作的挂载位置，移除桌面端占用正文的重复反向链接区域。补验只读命令、缺失导出、旧包和转换后实际存储字节。检查规范链接、清单与 ZIP 内容以及 `git diff --check`。 |

验收服务 `http://localhost:19876`，PID 65202，由 `./scripts/local.py start --port 19876` 启动。日志为 `dist/local/server.log`，数据为 `services/api/data`，停止命令为 `./scripts/local.py stop`。普通账号 `plugin-review@example.invalid` 已有「插件界面验收」库和 `标题栏示例.txt`，本地验收密码随交付消息提供。

产物为 `dist/acceptance/prefixed-text.zip` 和 macOS 可执行文件 `target/debug/wenote-desktop`。在个人设置里安装 ZIP，打开示例笔记，点击「英文转大写」，切换主题，再保存和重新打开。桌面端已构建，本轮实际交互验收使用 Chrome。本机默认 Android SDK 目录为空，未构建 APK 或验证设备。验收期间保留 worktree 和服务。受测提交可用 `git log -1 --format=%h -- apps/web/tests/plugin-actions.test.mjs` 查询。
