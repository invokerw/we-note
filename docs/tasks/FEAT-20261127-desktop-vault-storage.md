# 桌面端账号笔记库存储与首次启动

2026-11-27 从 `main` 的 `37449f3` 登记为 `PLANNED`，用户选择方式 2，进入 `IN_PROGRESS`。分支 `codex/feature-desktop-vault-storage-20261127`，工作区 `/Users/weifei/code/we-note-FEAT-20261127-desktop-vault-storage`。影响 desktop，复用现有服务接口。

## 需求与验收

用户要求「选择笔记库存储位置，该用户的所有笔记库都存在这个存储位置」，完成同步后自动进入本地编辑器。

- 登录页显示「登录 WeNote」，首次选择一次系统文件夹，所有库各占一个子目录。
- 同账号复用位置和已同步的库，目录移动可重新定位。不同账号隔离；已有普通文件和不能确认归属的目录受到保护。
- 显示同步进度，支持失败重试和打开已就绪的库。无库账号能建立首库。可切换本地库和退出账号，重新打开可离线阅读。
- 保留移动端原有行为。先运行失败回归，再验证原生存储、入口交互和 macOS 打包。从本工作区交付应用，等待验收后合并。

## 首轮实现与自审

macOS 通过系统文件夹选择器保存账号位置。按服务 origin 和用户 ID 隔离账号，使用笔记库 ID 识别同名库及重命名库。每个子目录的名称包含库名和 ID。识别到属于当前账号可访问库的旧版绑定时，将原文件、离线草稿和同步记录复制到新目录。旧目录保留。普通非空目录或其他账号的位置需要明确选择建立专用子目录。

自审补齐了旧库迁移中断后的恢复、重新选位置时避免重复导入旧草稿、后台新增库的侧栏更新，以及无库账号直接从工作区建库。首次同步失败可以重试未完成库或打开已就绪的库。显式退出后清除活动会话，同账号仍可恢复文件位置。正常重启先打开已就绪的本地库和上次笔记。

| 验证命令 | 结果 |
| --- | --- |
| `cargo test --locked -p wenote-sync --test account_storage`（实现前） | 101，缺少账号存储模块；实现后通过 |
| `WENOTE_TEST_ORIGIN=http://localhost:18473 cargo test --locked --workspace -- --include-ignored --skip measure_sync` | 0，12 项通过，包括真实服务双库同步、双设备冲突及迁移后离线读取 |
| `python3 tests/performance/sync.py 1000` | 0，按专用夹具完成 1,000 文件六阶段；先前直接运行忽略的性能驱动因缺少夹具环境变量退出 101 |
| `npm run build:desktop --prefix apps/web`，`node apps/web/tests/mac-storage.mjs`，`node apps/web/tests/sync-conflicts.mjs` | 均为 0。生产前端资源结合模拟 IPC 覆盖目录选择、失败重试、切库、离线重启、重新登录及空账号建库，以及移动端原有冲突流程 |
| 在 `apps/client` 运行 `npm exec -- tauri build --debug --ci --bundles app --config '{"bundle":{"active":true,"macOS":{"signingIdentity":"-"}}}' -- --locked` | 0，Apple Silicon 本地验收包，ad hoc 签名 |
| `codesign --verify --deep --strict target/debug/bundle/macos/WeNote.app`，`open -g -n target/debug/bundle/macos/WeNote.app` | 0，验证签名及本机进程启动；原生目录面板的手动交互留待用户验收 |

## 验收入口

- 本工作区的 `target/debug/bundle/macos/WeNote.app`，服务地址填写 `http://localhost:18473`。
- 使用 `notes@storage.test` 验收已有「工作」「生活」和各自示例笔记的账号。选择空文件夹，观察两个库自动同步，进入编辑器后切换库，重新登录和重启。
- 使用 `new@storage.test` 验收首次创建笔记库、选用其他账号位置时的引导及独立存储。两个本机测试账号密码均为 `WeNote-Local-18473`。
- 服务由 `./scripts/local.py start --port 18473` 创建，PID 43280，日志 `dist/local/server.log`，数据 `services/api/data`。`./scripts/local.py status` 和 `/healthz` 已确认运行，验收后使用 `./scripts/local.py stop` 停止。

2026-11-27 `DELIVERED`。方式 2，受测提交 `b0a588e`。任务工作区、Apple Silicon 客户端和独立服务保留，等待用户验收。
