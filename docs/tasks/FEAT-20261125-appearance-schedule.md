# FEAT-20261125-appearance-schedule · 外观与自动切换

- feature，Web / 桌面 / Android 共用笔记工作区。
- 用户需求：「需要添加白天黑夜主题切换功能，支持设置自动切换，你看应该加到哪里，并设计实现功能」。
- 验收方式 2。基线 `main` 的 `d676b0b`，分支 `codex/feature-appearance-schedule-20261125`，工作树 `.worktrees/appearance-schedule`。
- 状态 `DELIVERED`。客户端功能，本地专用 Web 服务用于交互验收。

## 验收条件

- 头像 → 个人设置 → 外观可选固定深浅色、跟随系统、定时，每台设备保存选择，保留旧版手动选择。
- 定时默认 07:00 / 19:00，支持跨午夜与自定义，在分界时刻和唤醒后更新。
- 工作区、设置、Markdown、脑图同步变色，编辑草稿与光标保持；覆盖桌面和手机宽度。

## 验证记录

| 命令 | 退出 | 结果 |
| --- | --- | --- |
| `node --test apps/web/tests/appearance.test.mjs`（红阶段） | 1 | 基线缺少偏好读取和自动解析函数。 |
| `WENOTE_TEST_ORIGIN=http://localhost:19527 node apps/web/tests/theme.mjs`（红阶段） | 1 | 基线设置没有「外观」，按钮等待超时。 |
| `node --test apps/web/tests/*test.mjs` | 0 | 全部 10 项通过，覆盖新设备、旧值、损坏设置、固定模式及正反向跨日时段。 |
| `WENOTE_TEST_ORIGIN=http://localhost:19527 node apps/web/tests/theme.mjs` | 0 | 实际系统色变化、分钟边界、唤醒、错误时间、刷新、草稿与选区、手机布局、原生脑图与 XMind 画布颜色。 |
| `WENOTE_TEST_ORIGIN=http://localhost:19527 node apps/web/tests/personal-settings.mjs` | 0 | 个人设置桌面和手机回归通过。 |
| `node apps/web/tests/native-editors.mjs` | 0 | 首次在旧按钮「插入附件」等待超时，按现有入口「插入图片」修订断言。复测 Markdown 三种模式与脑图编辑保存通过。 |
| `npm run build --prefix apps/web`、`npm run build:desktop --prefix apps/web`、`cargo build --locked -p wenote-desktop --release` | 0 | 最终 Web、原生共用前端和 macOS ARM64 可执行程序已构建。 |
| `npm run android --prefix apps/client -- --debug` | 1 | 本机 Android SDK 目录为空，缺少命令行工具。手机布局已用 Chrome 验证，APK 和真机待验证。 |
| `git diff --check` | 0 | 差异检查通过。 |

## 自审与方式 2 交付

2026-11-25 建立独立任务后进入 `IN_PROGRESS`。复查发现新设置、手机导航、搜索框和原生脑图有固定浅色，已接入配色并复查计算样式。原生脑图在显示层适配，切换设备外观不会改写导图内容。已在全新浏览器环境登录示例账号，确认默认跟随系统；已检查定时设置画面。

受测功能提交 `c0d103c`，状态 `DELIVERED`，用户验收后合入。下列路径均相对本任务工作树。

- 访问 `http://localhost:19527`，凭据在 `dist/local/验收账号.txt`。笔记库「主题体验」包含 Markdown、XMind 和原生脑图。点头像 → 个人设置 → 外观，选择模式。如需快速测试定时，把下一次切换设到下一分钟，关闭设置后继续编辑。
- 专用服务启动命令 `./scripts/local.py start --port 19527`，PID `23543`，日志 `dist/local/server.log`，数据目录 `services/api/data`，停止命令 `./scripts/local.py stop`。
- macOS 使用 `./target/release/wenote-desktop`，同步地址填写 `http://localhost:19527` 并选择本地目录，打开笔记编辑器体验。
