# FEAT-20261125-personal-settings · 个人设置与侧栏入口

- 类型 `feature`，影响 server、Web、桌面、Android。状态 `MERGED`。
- 依据为 `main` 的 `b4d5cc5` 中的[已验收需求](../个人设置与侧栏入口需求.md)。验收条件见文档八个场景。
- 用户选择方式 2，任务分支验收后再合入。分支 `codex/feature-personal-settings-20261125`，工作区 `.worktrees/personal-settings-20261125`。
- 实现账户头像、密码、设置分类、库工具重排及邮箱收发下线。独立服务端使用本工作区的数据和日志。
- 验证使用 `go test ./...`、Web 构建及浏览器回归。任务分支已集成单篇分享提交 `375ebb2`。

## 开发、复测与自审

| 检查 | 结果 |
| --- | --- |
| `go test ./internal/httpapi -run 'TestPersonalAvatar\|TestMailboxRetired'`（两项测试） | 首轮退出 1，头像保存返回 404，已下线的收发接口仍可访问。实现后随全量测试通过。 |
| `go test ./...` 和 `go vet ./...`（`services/api`） | 退出 0。覆盖账户隔离、保存、无效图片、恢复默认、会话撤销及旧接口移除。 |
| `npm run build --prefix apps/web`、`npm run build:desktop --prefix apps/web` | 两个入口均退出 0。 |
| `node --test apps/web/tests/*test.mjs`、`cargo test --locked -p wenote-sync --lib` | 8 项前端测试与同步库单元测试通过。 |
| `node apps/web/tests/personal-settings.mjs` | 退出 0。桌面和手机宽度、两个独立会话，验证头像预览取消、保存与恢复，字号、草稿保护、改密与旧会话撤销。 |
| `node apps/web/tests/phase1.mjs`、`node apps/web/tests/phase5.mjs` | 均退出 0。分享已保存单篇、访客阅读、保存副本、撤销、回收站和账户活动可达。浏览器测试使用 `WENOTE_TEST_ORIGIN=http://localhost:19486`。 |
| 扩展回归 `phase2.mjs`、`phase4.mjs`、`gm.mjs` | 均退出 1。分别停在原可视化编辑器焦点、旧 `.mode-live` 元素和 GM 文本附件上传（415）。用分享基线 `375ebb2` 的产物、独立临时数据库和原脚本在同一位置复现。日志在 `dist/local/`。 |

自审时检查了两个工作区入口、数据表、账号切换和旧分享接口的调用方。补充了插件配置改变后的编辑器刷新，保留编辑草稿与历史副本数据。账号头像保存在服务端，以账号 ID 隔离。个人设置截图核对后调整了头像按钮和长邮箱换行。

## 任务分支验收

- 从本工作区执行 `./scripts/local.py start --port 19486`。服务入口 `http://localhost:19486`，PID `8907`，日志 `dist/local/server.log`，独立数据 `services/api/data/`。验收后执行 `./scripts/local.py stop`。
- 使用 `dist/local/验收账号.txt` 中的普通账号登录，或自行注册。示例账号有两个库，在「个人笔记」中可打开 `工作/周记.md`。在该笔记中编辑草稿，打开头像设置后更换头像，再返回正文检查草稿。从笔记标题操作生成单篇分享链接，通过头像中的「我的分享」按库查看和撤销链接。
- macOS ARM64 构建 `cargo build --locked -p wenote-desktop --release` 退出 0。运行本工作区的 `target/release/wenote-desktop`，服务地址填写 `http://localhost:19486`，选择专用本地目录同步后打开编辑器。
- Android 与桌面共用的前端产物位于 `apps/client/dist/`。`npm run android --prefix apps/client -- --debug` 退出 1，本机 SDK 目录为空，缺少 Android 命令行工具和 NDK。手机布局已使用 Chrome 验证，APK 与真机交互待验证。
- 已按方式 2 保留工作区、分支和服务，等待用户验收。

## 第二轮 · 笔记列表搜索

用户要求删除左栏独立搜索，将路径与正文关键词检索合并到第二栏。参照两张截图，显示最近搜索、目录范围和命中高亮。沿用方式 2，在同一工作区返工。

- 本轮同步 `main` 的 `c574a1a`，保留已验收的分享弹窗、目录树及个人设置入口。用户反馈后记为 `CHANGES_REQUESTED`，复测通过后重新交付。
- 红阶段 `WENOTE_TEST_ORIGIN=http://localhost:19486 node apps/web/tests/library-search.mjs` 退出 1。第二栏输入 `linux` 后找不到正文包含 `LiNuX` 的「命令.md」。
- 绿阶段同命令退出 0，覆盖文件和目录名称、已保存正文、当前目录与全库切换、最近搜索复用和清空、结果和正文高亮。旧独立搜索页及导航已移除。
- 自审发现搜索选项可能遮住第一条结果，改为在输入框下方占用列表空间，保留点击结果和键盘操作。复测 1280 px 与 390 px 宽度，截图位于 `dist/local/search-desktop.png` 和 `dist/local/search-mobile.png`。
- 最终执行 `npm run build --prefix apps/web`、`npm run build:desktop --prefix apps/web`、`cargo build --locked -p wenote-desktop --release`、`cargo test --locked -p wenote-sync --lib`、`go test ./...`（`services/api`）和 `git diff --check`，均退出 0。本地库回归覆盖断网时从 Markdown 和 JSON 内容命中，并跳过二进制脑图。
- 在已重建服务运行 `apps/web/tests/` 下的 `library-search.mjs`、`personal-settings.mjs`、`phase1.mjs` 和 `phase5.mjs`，四项浏览器回归均退出 0。
- 方式 2 验收地址仍为 `http://localhost:19486`，新 PID `13173`。原示例账号选「个人笔记」，从第二栏输入 `linux` 即可打开 `工作/终端笔记.md` 并看到正文高亮。macOS 可执行程序已更新；Android 验证限于共用前端构建和手机宽度，SDK 条件见上轮记录。

## 第三轮 · 侧栏回收站与设置内导出

按方式 2 在原 worktree 返工。删除左栏「库工具」菜单，将回收站放到文件夹树下方。导出移入头像打开的「个人设置 → 导出」，当前库创建导出任务，关闭设置后保留编辑草稿。删除网页、桌面和 Android 共用的加密笔记库入口及批量分享创建功能，保留历史加密密文和已有分享链接的读取、下载、保存副本与撤销。

- 红阶段新增的 `TestEncryptedVaultRoutesRetired` 和批量路径拒绝测试先失败，分别暴露旧加密接口仍返回 200 和目录分享仍可创建。
- 绿阶段通过服务端仅保留审计路由、单篇已保存笔记分享校验、网页与原生端入口调整，以及本地回收站枚举和恢复。
- `go test ./...`、`go vet ./...`（`services/api`）通过。
- `npm run build --prefix apps/web`、`npm run build:desktop --prefix apps/web`、`cargo test --locked -p wenote-sync --lib`、`cargo build --locked -p wenote-desktop --release` 和 `git diff --check` 通过。
- `WENOTE_TEST_ORIGIN=http://localhost:19486 node apps/web/tests/{personal-settings,phase1,phase5,library-search}.mjs` 顺序执行，四项均退出 0。覆盖桌面和手机宽度的设置、头像、密码、导出、回收站位置、单篇分享、旧入口消失和全文搜索。

## 第四轮 · 回收站列表、只读预览与目录操作

收到反馈后按 `CHANGES_REQUESTED` 在原工作树返工，继续使用验收方式 2。网页和本地客户端共用第二栏的回收站列表、右键菜单和右侧只读预览。点击目录清除预览，永久删除前需要确认。单篇笔记和目录按删除时的标识操作。服务端对同一次目录删除的成员在同一事务中恢复或清理，保留历史记录中独立删除的笔记。旧版逐文件保存的回收站记录可以继续逐项管理。

- `go test ./internal/httpapi -run TestTrashContentPreviewIsReadOnly -count=1` 首次运行得到预期的 404，补齐接口后通过。复查覆盖未登录和其他账号读取拒绝。`go test ./...`、`go vet ./...` 通过。
- `npm run build --prefix apps/web`、`npm run build:desktop --prefix apps/web`、`node --test apps/web/tests/*test.mjs`、`cargo test --locked -p wenote-sync --lib` 和 `cargo build --locked -p wenote-desktop --release` 通过。Rust 回归实际验证本地文件预览、整目录恢复、清理及同名冲突。
- 在独立服务依次执行 `apps/web/tests/` 中的 `trash.mjs`、`personal-settings.mjs`、`phase1.mjs`、`phase5.mjs` 和 `library-search.mjs`，五项通过。回收站专项覆盖只读 Markdown 和任务框、目录留白、右键菜单、删除取消及确认、目录和单篇删除批次隔离。
- 扩展 `gm.mjs` 回归仍在旧文本附件样例上传时返回 415，未执行到后台附件恢复场景。Android 真机待验收。

## 第四轮验收交付

- 服务地址 `http://localhost:19486`，PID `20278`，日志 `dist/local/server.log`，数据目录为本 worktree 下的 `services/api/data/`。
- macOS ARM64 产物为 `target/release/wenote-desktop`。Android SDK 仍不可用，手机布局使用 Chrome 宽度回归验证。
- 任务分支保留在 `codex/feature-personal-settings-20261125`，等待用户验收后再合入本地 `main`。

验收账号保存在本工作树 `dist/local/验收账号.txt`。登录后选择「回收站交互验收」，点击左侧回收站。左键点「周会记录.md」查看正文和右上角按钮，再点「归档资料」查看空白内容区。两项都可以右键恢复或永久删除。

## 第五轮 · 单篇笔记一键恢复

用户要求从预览或右键菜单直接恢复笔记。恢复时原父目录仍存在就回到原处，原父目录已不存在就用原文件名恢复到笔记库根目录。本轮在原任务分支按方式 2 返工，验证网页与本地笔记库。

- `CHANGES_REQUESTED` 时先运行新增的 Chrome 和 Rust 用例。`node apps/web/tests/trash.mjs` 退出 1，点击恢复后笔记仍留在回收站。`cargo test --locked -p wenote-sync --lib restore_note_uses_existing_parent_or_vault_root` 退出 101，旧逻辑重建了已删除的目录。
- 在同一事务内按当前库的有效文件或目录标记判断原目录是否存在，再校验目标路径。目标已有同名项时提示冲突，待恢复的版本留在回收站。自审核对了整目录恢复仍使用批次内各成员的完整路径，并保留旧目录标记的恢复方式。本地库按实际文件系统目录判断。
- `go -C services/api test ./...`、`go -C services/api vet ./...`、`cargo test --locked -p wenote-sync --lib`、`node --test apps/web/tests/*test.mjs` 和 `git diff --check` 通过。Web 构建、`npm run build:desktop --prefix apps/web` 和 `cargo build --locked -p wenote-desktop --release` 通过。
- 在 `http://localhost:19486` 运行 `apps/web/tests/trash.mjs` 和 `phase1.mjs` 均退出 0。覆盖原目录仍存在、仅父级或相似目录存在、右键和预览恢复全程无弹窗、同名冲突，以及恢复后重新打开正文。
- 按方式 2 重新交付，专用服务 PID `21807`，数据与账号沿用上轮。刷新网页，打开回收站即可验收。macOS 客户端为本工作区 `target/release/wenote-desktop`，Android 真机待验。

## 验收与合入

2026-11-25 19:11（北京时间）按方式 2 完成收尾。用户确认任务分支版本 `867fe8c` 验收通过（`ACCEPTED`）。本地 `main` 快进至该提交，`git merge-base --is-ancestor 867fe8c main` 验证通过。

已停止 19486 端口的验收服务，清理任务工作区及对应的本地分支，状态更新为 `MERGED`。验收数据、日志和 macOS 客户端保存在主工作区的 `dist/acceptance/FEAT-20261125-personal-settings-867fe8c/`。
