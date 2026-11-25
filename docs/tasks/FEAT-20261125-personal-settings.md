# FEAT-20261125-personal-settings · 个人设置与侧栏入口

- 类型 `feature`，影响 server、Web、桌面、Android。状态 `DELIVERED`。
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
| `node apps/web/tests/phase1.mjs`、`node apps/web/tests/phase5.mjs` | 均退出 0。分享已保存单篇、访客阅读、保存副本、撤销、目录分享、回收站、加密库和账户活动可达。浏览器测试使用 `WENOTE_TEST_ORIGIN=http://localhost:19486`。 |
| 扩展回归 `phase2.mjs`、`phase4.mjs`、`gm.mjs` | 均退出 1。分别停在原可视化编辑器焦点、旧 `.mode-live` 元素和 GM 文本附件上传（415）。用分享基线 `375ebb2` 的产物、独立临时数据库和原脚本在同一位置复现。日志在 `dist/local/`。 |

自审时检查了两个工作区入口、数据表、账号切换和旧分享接口的调用方。补充了插件配置改变后的编辑器刷新，保留编辑草稿与历史副本数据。账号头像保存在服务端，以账号 ID 隔离。个人设置截图核对后调整了头像按钮和长邮箱换行。

## 任务分支验收

- 从本工作区执行 `./scripts/local.py start --port 19486`。服务入口 `http://localhost:19486`，PID `8907`，日志 `dist/local/server.log`，独立数据 `services/api/data/`。验收后执行 `./scripts/local.py stop`。
- 使用 `dist/local/验收账号.txt` 中的普通账号登录，或自行注册。示例账号有两个库，在「个人笔记」中可打开 `工作/周记.md`。在该笔记中编辑草稿，打开头像设置后更换头像，再返回正文检查草稿。通过库名旁的「库工具」进入批量分享，通过头像中的「我的分享」按库查看和撤销链接。
- macOS ARM64 构建 `cargo build --locked -p wenote-desktop --release` 退出 0。运行本工作区的 `target/release/wenote-desktop`，服务地址填写 `http://localhost:19486`，选择专用本地目录同步后打开编辑器。
- Android 与桌面共用的前端产物位于 `apps/client/dist/`。`npm run android --prefix apps/client -- --debug` 退出 1，本机 SDK 目录为空，缺少 Android 命令行工具和 NDK。手机布局已使用 Chrome 验证，APK 与真机交互待验证。
- 已按方式 2 保留工作区、分支和服务，等待用户验收。
