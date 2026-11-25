# 笔记库资源重构

- 状态：`MERGED`。验收方式 2，用户已在任务分支完成验收。
- 来源：[已验收的设计](../笔记库与图片存储设计.md)，提交 `0f8ccec`。实现基线 `main` 的 `62eb565`。
- 分支 `codex/refactor-vault-note-resources-20261125`。worktree `/Users/weifei/.codex/worktrees/vault-note-resources-20261125/we-note`。
- 范围和验收：按设计落实库内 notes、assets、清单与恢复、图片读写和防盗链、引用及七天清理、旧库迁移、分享与导出和多端编辑。验证手动删除、回收站、旧链接、远程存储和离线兼容。
- 验证命令：服务端 `go test ./...`，Web `npm run build --prefix apps/web`，原生 `cargo test --workspace`，针对新行为先运行对应失败测试。独立服务与客户端入口在交付时记录。

## 本轮实现与验收入口

- Web 入口 `http://localhost:19127`，GM 入口 `http://localhost:19127/gm`。任务进程 PID `88250`，工作区内日志 `dist/local/server.log`，SQLite 和在线目录在 `services/api/data/`。首次进入 GM 时使用本工作区的 `services/api/data/setup.token` 创建管理员。在该任务库中新建 Markdown 笔记，插入一张 PNG，保存后在预览和源码模式查看。
- 客户端从本工作区构建。桌面调试程序 `target/debug/wenote-desktop`，连接上述本机服务。停止本次实例的命令为 `./scripts/local.py stop`。
- 上传会话记录实际上传者及发起笔记。Markdown URL 使用库所有者、库 ID、UTC 日期和 SHA-256。保存时写入并校验库内版本，服务启动及每分钟发布 `current` 和 `manifest.json`。若要从复制的库恢复到新目录，可执行 `python3 scripts/recover_vault.py <库副本> <新目录>`。工具按清单校验正文、历史和图片的长度与哈希。
- 删除笔记后可从回收站还原。实际清除笔记后，仍受其他笔记、历史版本或有效快照使用的图片继续保留。最后一个引用消失后由后台核对连续七天的宽限期。旧非图片资源和迁移时未确认归属的资源保留，旧库目录中的 `migration-report.json` 记录保护备份 ID 和待核对项。

## 验证记录

- 红阶段。库内目录测试曾报告 `notes/<id>/versions/<id>.md` 不存在，旧库测试曾报告 `migration-report.json` 不存在。浏览器用例在笔记上传字段返回 400、跨库保存返回 409 时失败。原生双设备用例先因缺少离线图片暂存入口失败，完成对应改动后这些用例通过。
- `go test -count=1 ./...` 和 `go vet ./...` 在 `services/api` 下通过。覆盖了旧链接、回收站、清理、迁移前保护备份和仅从库目录副本恢复。远程存储回归使用本机 S3 和 WebDAV 协议测试服务。
- `npm run build --prefix apps/web`、`npm run build:desktop --prefix apps/web`、`cargo build --locked --workspace`、`cargo test --locked --workspace` 和 `git diff --check` 通过。
- `WENOTE_API=dist/local/wenote-api node tests/e2e/desktop.mjs --images` 通过。运行真实本机 API、双设备同步用例及 Chrome。包括断网草稿插图、跨库粘贴、已授权预览、匿名读取、旧路由、跨源嵌图、撤销分享、从分享导入和回收站恢复。
- 扩展浏览器命令 `WENOTE_API=dist/local/wenote-api node tests/e2e/desktop.mjs --browser` 的 phase1 通过。phase2 在切换到可视化编辑器后，检查输入焦点的断言失败，后续全量用例没有跑完。Android 构建器报告 `ANDROID_HOME` 未设置且找不到本机 Android SDK；APK 和真机验收待补。
- 自审后修正了 GM 切换目标时提前提交数据库变更、相同哈希不同日期的对象回收，以及发布时一次性读入大笔记的问题。确认证明七天宽限的回归采用隔离库时间戳，未改系统时间。

按方式 2 保留此分支和服务，等待实现验收。受测代码提交可用 `git log -1 --oneline` 查看。

## 验收反馈 · 2026-11-25

用户要求用户与笔记库统一采用 8 位短 ID，后续自行清库。沿用任务分支验收。验证注册、邀请和初始化管理员、普通与加密库创建及冲突处理、图片链接、磁盘目录和设备同步。

- `CHANGES_REQUESTED` → `DELIVERED`。数据库使用实际短 ID。普通库、加密库和等待清理的库共享 ID 占用检查，遇到碰撞重新生成。验收服务保留原数据，新建帐号及库即可同时看到两段短 ID。
- 新用例先在旧实现上复现了用户和普通库带长前缀、加密库拒绝短 ID 的问题。Go 全量测试和 `go vet ./...` 通过，包含注册、初始化、邀请、重复邮箱和短 ID 碰撞回归。
- Web 和桌面前端构建、Rust 工作区构建和测试通过。`WENOTE_API=dist/local/wenote-api node tests/e2e/desktop.mjs --images` 通过，覆盖 Markdown 图片地址与实际帐号和库 ID 一致、双设备同步、防盗链，以及加密库首次保存时的碰撞重试和解锁。

## 图片链接验收反馈 · 2026-11-25

用户确认新图片 URL 末段使用 16 个十六进制字符，服务端使用完整 SHA-256 校验和去重。沿用方式 2，验证同库同日遇到前缀碰撞、重复上传、跨库复制，以及桌面读取和校验。

- `CHANGES_REQUESTED` → `DELIVERED`。同库同日为完整摘要分配固定短标识，默认取前 16 个十六进制字符。碰撞后保留第一个标识，再给后来的摘要分配 16 位标识。库内文件名、备份和去重使用完整摘要。
- `go test -count=1 ./internal/httpapi -run TestMultipartResumeAcrossRestart` 先复现了实际 URL 仍含 64 字符。修改后 `go test -count=1 ./...` 和 `go vet ./...` 通过。碰撞测试覆盖只匹配前缀的上传被拒绝、两个地址各自解析、重复上传复用标识。
- Web 和桌面前端构建、`cargo build --locked --workspace`、`cargo test --locked --workspace`、`git diff --check` 通过。`WENOTE_API=dist/local/wenote-api node tests/e2e/desktop.mjs --images` 通过，包括第二台设备首次联网下载、校验原图、跨库复制、分享和跨源嵌图检查。Android 真机仍待验收。
- 自审核对了引用提取、GC 和便携导出的历史链接处理。原验收入口可直接在 Markdown 笔记插入一张图，然后在源码中检查链接末段。

## 用户验收与合入 · 2026-11-25 15:03（北京时间）

- 用户确认验收完成。验收提交 `655a719` 从 `62eb565` 快进合入本地 `main`。`git merge-base --is-ancestor 655a719 main` 成功，合入后在主工作区运行 `go test -count=1 ./...` 通过。
- 19127 验收服务已停止，已删除合入的任务分支。Codex 保护当前会话的主工作区，归档操作被拒绝，目录保留在验收提交的 detached HEAD。
- 停服后将任务数据和服务日志复制到主工作区的 `dist/acceptance-backups/REFACTOR-20261125-vault-note-resources/`，并逐文件核对副本。
