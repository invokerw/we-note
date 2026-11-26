# 移除 XMind、JSON 专用编辑器并提供默认文本编辑器

用户原始需求：“删除xmind与json吧。把txt修改成如果没有插件可以打开的就使用默认的这个，换个名字”

- 任务 ID `FEAT-20261126-default-text-editor`，类型 `feature`，登记于 2026-11-26。
- 基线 `main` 的 `76e9883`，任务分支 `codex/feature-default-text-editor-20261126`。
- Worktree `/Users/weifei/code/we-note/.worktrees/default-text-editor-20261126`。
- 方式 2，在任务分支验收，通过后合入本地 main。
- 影响 Web、桌面、Android 的共享编辑器。客户端从本 worktree 构建，提供浏览器验收入口。

## 验收条件

- [x] 移除内置 XMind、普通 JSON 的注册、编辑、配置和专用转换入口。保留已有文件。
- [x] Markdown、Mind Elixir 和已启用的本地专用插件优先匹配；其余文件交给「默认文本编辑器」。
- [x] 默认编辑器可查看、编辑和保存 UTF-8 文本，保留 BOM 和换行。二进制内容可下载原件，禁止误写。
- [x] 支持导入、保存与跨设备同步其他 UTF-8 文本（含 .csv、.log 和无扩展名文件），保留文件名、目录、内容和版本。
- [x] 新建 Markdown 和思维导图的路径保持可用。

### 第二轮界面验收条件

- [x] 默认文本文件使用 `Document`，按纯文本显示与编辑，正文占满标题下方可用宽度和高度。
- [x] 正文移除截图中的保存、导出和「默认文本编辑器」标签。所有可编辑文件统一从右上角保存。
- [x] Markdown 标记作为普通字符，文本保存保留 BOM、换行和空行；已禁用 Markdown 插件的 `.md` 同样按纯文本打开。
- [x] 验证 Markdown、思维导图和 WASM 的右上角保存、只读插件和二进制下载，并在原入口交付。

### 第三轮插件设置验收条件

- [x] 将通用页面上的默认打开模式、正文字号和记住笔记模式归入 Markdown 插件设置，保留已有偏好值与保存方式。
- [x] 有设置项的插件在卡片上显示「设置」，点击打开独立弹窗。Markdown 弹窗同时提供原有的同步滚动与自动格式化选项。
- [x] 弹窗支持键盘和窄屏操作，关闭后返回原插件列表，保留编辑中的草稿。

## 状态与验证

- 2026-11-26 `PLANNED`，登记需求和验收条件。
- 2026-11-26 `IN_PROGRESS`，用户选择方式 2。先验证插件匹配和回退，再验证构建与客户端实际打开、保存操作。

- 2026-11-26 用户确认同时扩展文本文件导入与同步。影响服务端与同步核心，启动独立验收服务。

## 本轮验证和交付

| 阶段 | 命令（从对应包目录执行） | 结果 |
| --- | --- | --- |
| 红 | `node --test tests/default-editor.test.mjs`、`go test ./internal/store -run TestDefaultTextFormat`、`cargo test -p wenote-sync --lib scan_other_text_and_handle_extensionless_conflicts` | 分别退出 1、1、101。原实现返回五种插件、拒绝其他后缀且扫描四个文本仅找到一个。 |
| 绿 | `node --test tests/*.test.mjs`、`go test ./...`、`cargo test -p wenote-sync` | 全部退出 0。11 个前端测试、完整服务端测试、4 个同步核心单测通过。 |
| 跨设备 | `WENOTE_TEST_ORIGIN=http://localhost:18946 cargo test -p wenote-sync --test two_devices -- --ignored` | 退出 0。两台客户端同步 CSV 和无扩展名文本，另一端修改后内容一致。 |
| 浏览器 | 在 `apps/web` 运行 `node tests/native-editors.mjs`，以及设置 `WENOTE_TEST_ORIGIN=http://localhost:18946` 后分别运行 `node tests/phase4.mjs`、`node tests/entry-menu.mjs`、`node tests/theme.mjs` | 均退出 0。验证编辑器优先级与禁用回退、WASM 权限、JSON 保存、BOM/CRLF、二进制下载、导入、Markdown 与导图新建保存、移动端布局。 |
| 构建 | `npm run build --prefix apps/web`、`npm run build:desktop --prefix apps/web`、`cargo build --locked -p wenote-desktop` | 均退出 0。桌面入口 `target/debug/wenote-desktop`。 |
| Android | `npm run android --prefix apps/client -- --debug` | 退出 1。机器上的 Android SDK 目录为空，缺少 Android Studio 命令行工具。APK 和 Android 设备验证待具备工具链后执行。 |

自审覆盖前后端打开、转换、保存和同步入口。对无扩展名的冲突副本、旧二进制文件下载、移除专用编辑器后的样式、复制及移动后的内容验证和分块同步提交补齐处理。`git diff --check` 通过。

`DELIVERED`，方式 2。提交可通过 `git log -1 --format=%h -- apps/web/src/plugins/registry.ts` 定位。通过后再合并。

- 验收服务 `http://localhost:18946`，PID `57358`。服务和数据均属于本 worktree。
- 启动 `./scripts/local.py start --port 18946`，停止 `./scripts/local.py stop`。日志 `dist/local/server.log`，数据库 `services/api/data/wenote.db`。
- 使用交付消息中的本地验收账号，打开「编辑器验收」笔记库；亦可注册普通账号，创建笔记库并自行上传文件。
- 在「个人设置 → 编辑与插件」查看内置列表。打开 `配置.json` 或 `示例.csv`，修改后保存并重新打开；打开 `旧版格式.xmind` 可下载原件。通过新建菜单可分别验证 Crepe 和 Mind Elixir。

- 2026-11-26 `CHANGES_REQUESTED`，用户要求移除截图红框内的正文操作，采用全幅 Document 纯文本视图，保存统一进入右上角功能区。沿用方式 2。

### 第二轮交付

- 红阶段，使用独立服务执行 `WENOTE_TEST_ORIGIN=http://localhost:18946 node tests/phase4.mjs`（在 `apps/web` 中），退出 1，旧版 CSV/JSON 使用 textarea，没有全幅 Document。
- 绿阶段，同一命令退出 0。验证编辑区几何尺寸、文本原样预览、禁用 Markdown 后的编辑和保存、BOM/CRLF、写入冲突、只读插件和二进制原件下载。
- `node tests/native-editors.mjs`、`WENOTE_TEST_ORIGIN=http://localhost:18946 node tests/theme.mjs` 和 `node --test tests/*.test.mjs` 均退出 0。验证思维导图从标题栏保存、Crepe 编辑和响应式布局；单元测试 11 个通过。
- `npm run build --prefix apps/web`、`npm run build:desktop --prefix apps/web` 和 `cargo build --locked -p wenote-desktop` 均退出 0。macOS 客户端产物为本 worktree 的 `target/debug/wenote-desktop`。Android 测试脚本通过语法检查，本机缺少上轮记录的 Android SDK，未验证 APK。
- 自审复查保存权限、快捷键、二进制下载、编辑器切换与附件入口；纯文本不加载 Markdown 语言扩展或自动格式化。`git diff --check` 通过。
- `DELIVERED`。继续使用原服务、账号及方式 2。打开「示例.csv」可直接输入，并在右上角保存。在 1440 × 850 浏览器视口中，正文和编辑器同为 925 × 775 像素。实测截图 `dist/local/csv-editor.png`。

- 2026-11-26 `CHANGES_REQUESTED`，用户要求将 Markdown 专属偏好归入对应插件，并通过设置按钮弹窗配置。沿用任务分支验收。

### 第三轮交付

- 红阶段，在 `apps/web` 执行 `WENOTE_TEST_ORIGIN=http://localhost:18946 node tests/phase4.mjs` 退出 1。关闭插件设置时，通用页面仍显示一个默认打开模式控件，预期为零。
- 绿阶段，在同一验收服务运行 `tests/phase4.mjs` 和 `tests/personal-settings.mjs` 均通过。覆盖 Markdown 弹窗的独立打开和关闭、Esc 后的焦点、手机宽度下的滚动、偏好持久化和草稿保留。
- `node tests/native-editors.mjs` 通过，`node --test tests/*.test.mjs` 的 11 个测试通过。`npm run build --prefix apps/web`、`npm run build:desktop --prefix apps/web` 和 `cargo build --locked -p wenote-desktop` 均通过。本机缺少 Android SDK，未验证 Android 客户端。
- 自审复查了插件按钮的显示条件、弹窗关闭和原有 Markdown 偏好的读写。`git diff --check` 通过。
- `DELIVERED`，方式 2。使用原验收服务，打开「个人设置 → 编辑与插件」，点击 Markdown 卡片的「设置」。原有偏好会在弹窗中回显，修改时自动保存。

### 验收与归档

- 2026-11-26 `ACCEPTED`。用户确认「验收完毕」，通过的任务分支提交为 `2c6e531`。
- 2026-11-26 `MERGED`。本地 `main` 从 `76e9883` 快进到 `2c6e531`。`git merge-base --is-ancestor 2c6e531 main` 和 `git diff --exit-code 2c6e531 main` 均退出 0。
- 15:23（北京时间），任务服务已停止，任务 worktree 和本地任务分支均已删除。验收数据库及附件、服务日志、CSV 编辑器截图和 macOS 客户端保存在主工作区 `dist/acceptance/FEAT-20261126-default-text-editor-2c6e531/`。
