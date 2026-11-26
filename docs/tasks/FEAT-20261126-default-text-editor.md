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
