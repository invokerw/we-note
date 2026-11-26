# FEAT-20261126-portable-import · 离线便携包导入

- 2026-11-26 · feature · server / web / desktop / android · MERGED（Web / macOS，Android APK 待验证）
- 基线及已确认设计提交 `main` / `e494fd2`。工作区 `.worktrees/portable-import-20261126`，分支 `codex/feature-portable-import-20261126`。
- 用户选择方式 2，在任务分支验收，通过后再合入本地 main。
- 原始需求「在用户设置里面添加一个导入的选项」「导出改成 导出/导入 功能都放到一个分页里」。范围与验收场景见[已确认设计](../离线便携包导入设计.md)。
- 验收检查涵盖同页导出和导入、多端选择文件、预览和取消、整批冲突避让、跨库资源重建、损坏包拒绝、重试与同步一致性。
- 计划先执行失败测试，完成格式和服务端事务，再接入各端设置、验证和自审。从任务工作区启动独立服务、构建客户端后提交验收。

## 实现与验证记录

- 红阶段。在 `services/api` 执行 `go test ./internal/store -run TestPortableVaultImport` 退出 1，提示缺少预览和确认方法。使用现有导出器生成跨库样本。后续针对带别名的根路径双链、代码中的源库图片 URL 的用例均先复现失败，再修正。
- 服务端。实现 ZIP 清单与 SHA-256 校验、可取消的预览、冲突目录重新确认、目标资源和版本登记、幂等提交，复用分享的资源存储和正常笔记写入事务。每个 ZIP 接受最多 256 MiB、解压 512 MiB、10000 个条目，待确认包按 24 小时清理。
- 自审。核对文件和资源的事务边界、只读权限、同名目录、原生上传分片及同步、重复确认和草稿保留。补测写入最后阶段失败后的回滚和重试，修正 Markdown 代码示例被误登记为资源引用及双链在解析时被拆分的问题。
- `services/api` 中的 `go test ./...` 退出 0，覆盖损坏清单、校验失败、权限、冲突、目标库图片和提交回滚。`apps/web` 中的 `node --test --test-concurrency=1 tests/*.test.mjs` 退出 0，12 项通过。最初从仓库根目录运行时两个 Vite 测试未找到模块，切到该测试要求的前端目录后通过。
- `npm run build --prefix apps/web` 和 `npm run build:desktop --prefix apps/web` 均退出 0。Vite 提示部分分块超过 500 kB。`WENOTE_TEST_ORIGIN=http://localhost:19626 node apps/web/tests/personal-settings.mjs` 与 `phase2.mjs` 退出 0，覆盖同页导出、取消与确认导入、手机宽度、保留草稿、上传图片和离线 ZIP 阅读。
- `WENOTE_TEST_ORIGIN=http://localhost:19626 cargo test --locked --offline -p wenote-sync --test two_devices -- --ignored` 退出 0。真实客户端分片提交便携包，同库冲突后导入到新目录，另一设备同步可见。
- `cargo build --offline --locked -p wenote-desktop` 和 `apps/client` 下的 `./node_modules/.bin/tauri build --debug --bundles app` 均退出 0。`npm run android --prefix apps/client -- --debug` 退出 1，本机 Android SDK 目录缺少命令行工具，`/usr/libexec/java_home -V` 亦未找到 JDK。Android APK 与设备实测待补。

## 任务分支验收

1. 在此工作区启动的独立服务为 `http://localhost:19626`，PID 81430。服务日志 `dist/local/server.log`，数据 `services/api/data/`。使用 `python3 scripts/local.py status` 查看，验收通过后用 `python3 scripts/local.py stop` 停止。
2. 在网页用 `dist/local/验收账号.txt` 中的本地测试账号进入「导入验收」库，打开「头像 → 个人设置 → 导出/导入」。选择 `dist/local/导入验收样例.zip`，可核对带图笔记和同名路径。确认后打开导入目录，也可切到新库验证无冲突的原路径导入。
3. macOS 应用在 `target/debug/bundle/macos/WeNote.app`。填写上述服务地址，登录并选目录，先同步再进入本地编辑器的同一设置页。
4. 按方式 2 保留任务分支、工作区与服务，等待用户验收。

## 2026-11-26 · 导入预览弹窗

用户反馈「选择导入后的显示的数据是否可以弹窗显示。然后确认取消导入」。本轮沿用方式 2。选包校验成功后自动打开「导入预览」，展示笔记和资源数量、目标目录、冲突及原有预览详情，底部提供「取消导入」和「确认导入」。取消成功后回到设置、库内文件数不变；确认成功后回到导入结果。确认时若目标变化或请求失败，在弹窗内提示并允许继续。窄屏可滚动查看详情，既有待确认记录可从设置重新打开预览。

- 红阶段。浏览器回归 `WENOTE_TEST_ORIGIN=http://localhost:19626 node apps/web/tests/personal-settings.mjs` 退出 1，旧页面没有可见的「导入预览」对话框。
- 实现与自审。校验成功后打开原生模态对话框。按 Esc 可先收起，稍后从「查看导入预览」继续；点击「取消导入」成功后清理暂存。断网时仍可返回设置。预览内容可滚动，操作按钮位于底部。服务端返回新目录时在原弹窗内更新并显示提示。
- 复测。上述浏览器命令退出 0，验证了取消后笔记数量、Esc 返回与重新打开、目标目录在确认前被占用后再次确认、手机 390 px 宽度及草稿保留。`apps/web` 下 `node --test --test-concurrency=1 tests/*.test.mjs` 12 项通过。`npm run build --prefix apps/web`、`apps/client` 下 `./node_modules/.bin/tauri build --debug --bundles app` 和 `git diff --check` 均退出 0。沿用上方服务、账号和样例，macOS 验收应用已重建。

## 2026-11-26 · 导入完成记录

用户要求「如果没有删除的机制就不要记录了」。验收时，成功导入应在同一事务中移除预览，只在当前设置页显示一次结果。重新打开设置或刷新后只显示待确认预览。升级时清理旧的完成记录，保留实际笔记、资源及仍待确认的预览。重复确认同一预览不能再次写入。沿用任务分支验收。

- 红阶段。`services/api` 下 `go test ./internal/store -run TestPortableVaultImport` 退出 1，复现旧完成记录和新确认的预览仍在数据库中。旧服务的 `WENOTE_TEST_ORIGIN=http://localhost:19626 node apps/web/tests/personal-settings.mjs` 退出 1，第二个浏览器会话仍能读到完成记录。
- 变更与自审。成功导入在写入笔记和资源的同一事务内删除预览，写入失败后可以重试。成功响应供当前页面提示数量和目录。补测真实提交成功后丢弃响应，再次确认时页面收起失效预览并提示核对目标目录，库中只有一份本次导入的笔记。
- 升级验证。重启独立验收服务前后核对 SQLite，旧完成记录由 10 条变为 0 条。待确认预览仍为 1 条、笔记文件 68 个、资源 7 个。网页及 macOS 验收入口见上文。
- 复测。`services/api` 下 `go test ./...`、`apps/web` 下 `node --test --test-concurrency=1 tests/*.test.mjs`（12 项）、上述浏览器回归和 `WENOTE_TEST_ORIGIN=http://localhost:19626 cargo test --locked --offline -p wenote-sync --test two_devices -- --ignored` 均退出 0。`python3 scripts/local.py start --port 19626` 重建网页并启动服务，`apps/client` 下 `./node_modules/.bin/tauri build --debug --bundles app` 与 `git diff --check` 退出 0。

## 验收归档

- 2026-11-26 `ACCEPTED`。用户确认验收完毕，受测功能提交为 `f2d69d0`。
- 2026-11-26 18:49 `MERGED`。本地 `main` 快进合入 `f2d69d0`，`git merge-base --is-ancestor f2d69d0 main` 验证通过。已停止 19626 端口的独立服务，删除任务 worktree 和本地任务分支。
- macOS 应用、导入样例、验收数据和日志保存在主工作区 `dist/acceptance-backups/FEAT-20261126-portable-import/`。已核对应用和数据副本，归档数据库的 `PRAGMA quick_check` 返回 `ok`。
