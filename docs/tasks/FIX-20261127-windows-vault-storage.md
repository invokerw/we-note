# Windows 笔记库存储与启动修复

2026-11-27 登记 `PLANNED`，用户要求「修复下Windows的问题吧也按照mac」，确认方式 2（任务分支验收）后进入 `IN_PROGRESS`。基线 `main@56be625`，任务分支 `codex/bugfix-windows-vault-storage-20261127`，工作区 `/Users/weifei/code/we-note-FIX-20261127-windows-vault-storage`。影响 Windows 客户端，使用现有服务。

## 问题与验收

Windows 在登录后展示逐库填写目录的同步表单，成功后仍需手动打开编辑器。退出账号也保留旧版最近笔记入口。

- 登录 WeNote，首次通过 Windows 原生文件夹选择器选择账号级位置，取消可重选。同步所有库并自动进入编辑器，可切换库，失败重试和空账号建库沿用 macOS 行为。
- 同账号记住位置，重启可离线使用；退出后回到登录页，切换账号独立初始化。普通文件和旧绑定依 macOS 原则处理。
- 验证 Windows 目录名和旧库迁移的兼容性，构建 x64 客户端并在原任务分支交付。

## 实现与验证

Windows 和 macOS 共用账号初始化页面、目录归属校验、同步和离线编辑流程。Windows 使用与当前窗口关联的系统文件夹选择器。旧库迁移跳过进程锁文件，按顶层条目从暂存目录恢复，保留原目录及离线编辑。原账号记录和已登记的目录名继续有效。

| 命令或检查 | 结果 |
| --- | --- |
| 修改实现前运行桌面界面测试，以及 `cargo test --locked -p wenote-sync --test account_storage vault_names_are_portable` | 分别退出 1、101，旧入口没有登录 WeNote 标题，生成的目录名包含 Windows 禁用字符 |
| `npm run build:desktop --prefix apps/web`，`node apps/web/tests/desktop-storage.mjs`，`node apps/web/tests/sync-conflicts.mjs` | 均退出 0。用构建产物和模拟 IPC 验证中文 Windows 路径、取消重选、全库同步、失败重试、换库、离线重启和账号隔离 |
| `cargo test --locked --offline --workspace` | 退出 0。自审补测迁移中的中断恢复和锁文件，并确认同名普通笔记文件仍能复制 |
| `WENOTE_API=/tmp/wenote-win-storage-acceptance-api node tests/e2e/desktop.mjs` | 退出 0。任务源码构建的临时 API 上，双设备同步与冲突 2 项、账号存储 5 项通过，服务已随测试停止 |
| `RUSTC_BOOTSTRAP=1 CARGO_TARGET_X86_64_PC_WINDOWS_GNU_LINKER=x86_64-w64-mingw32-gcc cargo build --offline --locked --release --target x86_64-pc-windows-gnu -Zbuild-std=std,panic_abort -p wenote-desktop --bin wenote-desktop` | 退出 0。前置 debug 链接因 GNU 链接器导出符号数限制失败。交付优化的 release 二进制 |
| `file`、`x86_64-w64-mingw32-objdump -p`、ZIP 完整性与 SHA-256 检查 | EXE 为 Windows x64 GUI 程序，配套的 x64 `WebView2Loader.dll` 随包提供；归档 SHA-256 为 `899dcf247f3c104c6ba03cfa33cdd81ca0d751333dacb56a7dc03448df5dd936` |

## 客户端验收

将本工作区 `dist/acceptance/WeNote-Windows-x64.zip` 解压到安装有 WebView2 Runtime 的 Windows x64 电脑，运行 `WeNote.exe`。服务地址使用验收人员现有的 WeNote HTTPS 服务（服务在同一台 Windows 电脑时可用 `http://localhost:8080`）。用含两个库的账号验证首次选目录、同步和自动打开编辑器，退出后换账号检查独立目录。原生文件夹对话框与 WebView2 真机启动由 Windows 设备验收。
