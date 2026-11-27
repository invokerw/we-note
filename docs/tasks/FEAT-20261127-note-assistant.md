# 客户端个人笔记助手

2026-11-27 · `feature` · 从 `PLANNED` 转入 `IN_PROGRESS`。用户选择方式 2，先在任务分支试用，通过后合入 main。

基线 `main@c78ab41`，分支 `codex/feature-note-assistant-20261127`，工作区 `/Users/weifei/code/we-note-FEAT-20261127-note-assistant`。需求原文「功能就是调用mcp或者skill写笔记」「那就使用pi」「和左边的栏位一样在右侧单独做一个栏位」「助手的聊天记录是否有保存」。[设计依据](../客户端个人笔记助手设计.md)

## 范围及验收

- Web、桌面和手机共享 Pi 助手，用本机模型配置直连 Chat Completions 或 Responses。支持停止、流式回复和测试工具调用。
- 工作区右上角唯一开关。右栏中显示对话、写入预览和固定输入框。窄屏、收起和展开保留本机草稿。
- 按账号、服务地址、库隔离持久会话。历史列表、新对话、切换和重启恢复。
- 内置笔记 Skill。引用笔记、授权搜索本库、预览后才提交同一 MCP 请求。覆盖文本、导图、版本冲突、撤销和重试。
- 测试先行，运行聚焦测试、客户端构建及浏览器验收，自审通过后提交到本分支。以本 worktree 的独立应用入口和可构建原生产物交付。

## 2026-11-27 首轮交付 · DELIVERED

实现使用 Pi Agent Core 1.6.1 和随应用打包的 `wenote-notes`，把当前库签发给内置助手的工具映射到 Agent，批准后通过原 MCP 写入。网页直连用户填写的端点，原生客户端通过流式 IPC 访问端点。首版开放 Chat Completions 和 Responses。模型地址和 ID 保存在设备上，API Key 仅在当前应用会话内使用。原生端的可选系统钥匙串记忆功能仍属设计建议。

| 验证 | 结果 |
| --- | --- |
| `node --test apps/web/tests/assistant.test.mjs` | 红阶段退出 1，缺少策略模块。补齐后退出 0，覆盖配置校验、受限引用、预览及基准版本 |
| `node --test apps/web/tests/mcp-tools.test.mjs apps/web/tests/assistant.test.mjs` | 退出 0，7 项通过 |
| `npm --prefix apps/web run build` 和 `npm --prefix apps/web run build:desktop` | 均退出 0，类型检查、网页及原生前端构建通过 |
| `WENOTE_TEST_ORIGIN=http://localhost:19453 node apps/web/tests/assistant-browser.mjs` | 退出 0。在 Chrome 中经 Pi 的两个模型适配器与受控 SSE 交互，验证工具测试、建文前预览、改提案、单次保存、收起展开、选历史、草稿恢复、窄屏及切库隔离 |
| `WENOTE_API=dist/local/wenote-api node tests/e2e/desktop.mjs --browser` | 退出 0，独立实例上的双设备同步、Markdown、插件、MCP、回收站、分享及助手回归通过 |
| `cargo test --locked -p wenote-desktop --lib` | 退出 0。两项通过，其中原生模型传输连接实际回环 HTTP 服务，核对认证头、中文流内容及结束事件 |
| 在 `apps/client` 执行 `./node_modules/.bin/tauri build --debug --bundles app --config '{"bundle":{"active":true}}'` | 退出 0。生成 Apple Silicon 调试应用 `target/debug/bundle/macos/WeNote.app` |

自审修复了空库首次加载时 React key 重复导致的重复侧栏、原生消息流的结束顺序、切换授权或模型后旧上下文的复用。导图预览使用现有节点变换计算受影响的关联线和摘要。中断后可核对 MCP 已有回执，同参数重试复用原操作 ID。

### 试用入口

- 网页 `http://localhost:19453`。独立实例 PID 17209，日志 `dist/local/server.log`，数据 `services/api/data`。可注册普通账号并创建笔记库。验收期间保留服务，停止命令为本 worktree 的 `./scripts/local.py stop`。
- macOS 在任务 worktree 运行 `open target/debug/bundle/macos/WeNote.app`。服务地址填写同一地址并打开测试库。
- 从「个人设置 → 笔记助手」填写模型地址和 ID，按端点要求填 Key，点「测试连接」。工作区右上角展开助手并为测试库授权编辑，输入「新建周报.md，写入联调定于周五」，查看预览、应用并打开结果。右栏顶端时钟可找回历史对话。
- 本次模型验收使用受控响应。用户自选模型的实际生成质量待试用。未运行 Windows、Linux 和移动端原生设备验收，本机 Android SDK 目录为空，iOS 工具链仅有 Command Line Tools。窄屏交互已在手机尺寸的 Chrome 中验收。

受测功能提交 `a42e95f`，分支 `codex/feature-note-assistant-20261127`。按方式 2 保留验收环境，等用户试用反馈。
