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

## 2026-11-27 网页模型连接反馈 · CHANGES_REQUESTED

用户在验收网页连接自选模型端点时看到 `Connection error.: Failed to fetch`。沿用方式 2。在实际浏览器检查请求和响应，核对端点可用协议，在本机验证临时凭据可用的连接路径。验收要求为可访问的端点能进行工具测试，跨域或网络失败时指出当前站点、模型服务及可采取的操作，能够读取的 HTTP 错误保留上游诊断。通过真实跨域 HTTP 回归覆盖浏览器网络边界。

红阶段：`WENOTE_TEST_ORIGIN=http://localhost:19453 node apps/web/tests/assistant-browser.mjs` 退出 1，真实跨域预检被拒后页面只显示原始 `Failed to fetch`。

### 反馈验证与交付 · DELIVERED

Chrome 从验收地址访问用户网关的 Chat Completions 与 Responses 路径时，两者的 OPTIONS 响应均缺少 `Access-Control-Allow-Origin`。使用用户提供的临时凭据在本机读取 `/v1/models` 成功。在一次独立测试进程中，连接 Pi 的 `testModel`、客户端 `modelFetch` 与桌面端实际的 Rust `forward`，使用 Responses 和 `gpt-6.2-sol` 成功完成 `check_connection`。这项实测仅发送工具测试消息。

网页连接失败时显示模型服务、当前网页来源和桌面直连方式。自审发现 Pi 会显示最内层异常，已将可读诊断放在它能呈现的位置。Chrome 回归在启用请求模拟之前访问独立 HTTP 测试端点，覆盖预检拒绝（只收到 OPTIONS）及允许跨域的 401（网页保留网关错误）。

- `WENOTE_TEST_ORIGIN=http://localhost:19453 node apps/web/tests/assistant-browser.mjs` 退出 0，网页连接诊断和原有写入与历史流程通过。
- `node --test apps/web/tests/mcp-tools.test.mjs apps/web/tests/assistant.test.mjs` 退出 0，7 项通过。`git diff --check` 退出 0。
- `./scripts/local.py stop` 及 `./scripts/local.py start --port 19453` 退出 0，重建后验收地址仍为 `http://localhost:19453`，PID 更新为 22993。桌面 `tauri build --debug --bundles app`（启用 bundle）退出 0，试用产物为 `target/debug/bundle/macos/WeNote.app`。
- 受测功能提交 `ce3b987`，按方式 2 在任务分支验收。打开桌面客户端，进入笔记库的「个人设置 → 笔记助手」，填写上述协议、模型及网关地址，输入本次会话的 Key 后点「测试连接」。网页使用该网关需要网关允许验收站点跨域访问。

## 2026-11-27 聊天模块加载失败 · CHANGES_REQUESTED

用户在已打开的验收页首次发送消息时，本地 `turn-DW9Wpc4o.js` 返回 404。沿用方式 2。复现网页更新后旧标签页加载聊天代码的流程。本地验收发布需保留上一版资源；若聊天模块已不可用，应保留原输入、提示刷新，且本轮刷新前不产生重复消息、模型请求或笔记写入。以 Chrome 从发送入口验证恢复和后续对话。

用户随后反馈网关回 `401 API_KEY_REQUIRED`。增加验收条件：网页刷新后，对于之前带 Key 保存的模型，发送前在本地提示补填，保留草稿；历史配置收到网关明确的缺少密钥反馈时给出可读指引；可匿名使用的端点继续支持。仅在本页内存保存密钥，用模拟凭据核对设置、刷新、重新输入与实际聊天请求的认证头。

红阶段：`node --test apps/web/tests/web-build-history.test.mjs` 退出 1，第二次构建删除首版聊天模块。`WENOTE_TEST_ORIGIN=http://localhost:19453 node apps/web/tests/assistant-browser.mjs` 退出 1，聊天模块 404 时仅显示浏览器异常，用户输入已被移入历史。

### 网页聊天验收 · DELIVERED

受测功能提交 `1ac9529`，沿用方式 2。已从对应提交重建报错页的旧静态依赖，`turn-DW9Wpc4o.js` 已恢复 HTTP 200。同一目录重建保留当前及上一版资源。聊天模块成功加载后才记录用户消息，加载期间继续输入的草稿也会保留。自审核对了旧配置的 401 恢复流程和无密钥服务的行为。

- Chrome 在验收网页的独立空库使用 Responses 和 `gpt-6.2-sol` 实际发送一条测试消息，确认带 Bearer 凭据，网关返回 HTTP 200，助手显示预期回复。
- `node --test apps/web/tests/web-build-history.test.mjs apps/web/tests/assistant.test.mjs apps/web/tests/mcp-tools.test.mjs` 退出 0，共 8 项。`WENOTE_TEST_ORIGIN=http://localhost:19453 node apps/web/tests/assistant-browser.mjs` 退出 0，覆盖聊天模块 404、匿名模型、刷新后缺少 Key、旧配置 401 恢复草稿、重新填写后的认证头及正常写入流程。
- `WENOTE_API=dist/local/wenote-api node tests/e2e/desktop.mjs --browser` 退出 0，桌面调试应用重新构建成功。验收网页已重建并运行在 `http://localhost:19453`，PID 24641。
- 刷新网页，在「个人设置 → 笔记助手」重新填入 Key 并保存，可从右栏发送草稿。密钥仅存在页面内存，本机配置保存此前是否使用过 Key 的标记。

## 2026-11-27 生成笔记时持续请求 · CHANGES_REQUESTED

用户提供的 Responses 流正常完成，一次 create_note 包含 Markdown 正文和网关要求填写的 root_topic，整轮仅有工具事件。按方式 2 修复客户端对这类参数的适配，流式显示起草进度和正文，保留预览后确认写入；对确实无效且连续失败的工具调用给出可见错误并结束本轮。验收涵盖真实响应回放、无写入预览、单次确认保存和失败退出。

### 工具调用回放验收 · DELIVERED

受测功能提交 `36b3eac`，方式 2。附件显示网关为 create_note 的 text 和 root_topic 同时设置必填，两者均有值，模型以 167 个参数增量发送整篇 Markdown。客户端按笔记种类处理不适用的参数，再交给 MCP 原有校验。起草内容在助手栏中即时显示，完整调用经过校验后出现可应用的预览。工具连续两轮失败后结束本轮并显示原因。自审移除了诊断中回显原始工具参数的部分。

- 红阶段以附件驱动 `apps/web/tests/assistant-browser.mjs`，退出 1，已收到全部正文的客户端仍仅显示「正在生成」。使用同一附件回放修复版本，退出 0。Chrome 验证结束事件到达前可见正文，正式预览的文字与模型输出相同，点击前测试库为空，确认后只生成目标笔记。连续无效的工具调用在两次请求后结束。
- `node --test apps/web/tests/assistant.test.mjs apps/web/tests/mcp-tools.test.mjs apps/web/tests/web-build-history.test.mjs` 退出 0，9 项通过。`WENOTE_API=dist/local/wenote-api node tests/e2e/desktop.mjs --browser` 退出 0，独立环境上的助手和既有流程通过。正式回归使用合成数据，仓库中未保存用户附件。
- 网页 `http://localhost:19453` 重新构建启动，PID 27943。原 worktree 下的 `target/debug/bundle/macos/WeNote.app` 重新打包成功。试用时刷新网页并补填当前页面的模型密钥，发送新建笔记的请求，确认预览后保存。

## 2026-11-27 记住本机模型密钥 · CHANGES_REQUESTED

用户希望填写一次 API Key，刷新或下次打开客户端时直接读取。沿用方式 2。在模型设置加入可选的「在本机记住密钥」，按 WeNote 服务、账号和模型端点绑定，使用客户端本地加密存储。在本机取消记住后保存可删除持久凭据。原有仅本页使用的设置继续可用。验收覆盖全新页面直接聊天、浏览器重启、地址及账号隔离、取消记住以及原有临时 Key 流程。

### 本机密钥记忆验收 · DELIVERED

受测功能提交 `a5fd225`，沿用方式 2。首次默认仅当前页面使用。勾选「在本机记住密钥」保存后，Web 和原生前端使用 Web Crypto 加密并按账号保存到当前客户端；端点和账号参与认证加密。不可导出的加密密钥保存在 IndexedDB，配置与密文一次写入，本次自审核对了首次并发保存、取消记忆和旧版配置的读取。取消勾选并保存即可清除持久密文。

- 红阶段 `WENOTE_TEST_ORIGIN=http://localhost:19453 node apps/web/tests/assistant-credentials.mjs` 退出 1，缺少记住密钥选项。修复后同一 Chrome 用户目录关闭进程并重启，直接聊天通过，账号及端点隔离、加密存储和取消记忆通过。
- `WENOTE_API=dist/local/wenote-api node tests/e2e/desktop.mjs --browser` 退出 0，包含上述持久化回归及原有助手、笔记与同步流程。助手、MCP 和构建历史的 9 项聚焦测试通过。`git diff --check` 通过。
- 验收网页按原地址 `http://localhost:19453` 重建并启动，PID 32681。macOS 调试包已重新构建至 `target/debug/bundle/macos/WeNote.app`。重启自动读取已在 Chrome 实测，原生端本轮验证到构建。

## 2026-11-27 助手开关并入标题行 · CHANGES_REQUESTED

用户反馈助手开关独占顶部一行，挤压笔记空间。沿用方式 2。收起时开关和笔记标题操作共用一行，空库仍可打开。展开后右栏从工作区顶边延伸到底边，历史、新建对话和收起开关共用栏标题行。手机在当前页面标题行提供同一个开关。验收测量开合前后各栏的顶边、按钮位置与可点击区域，并检查返回笔记和草稿恢复。

红阶段运行 `WENOTE_TEST_ORIGIN=http://localhost:19453 node apps/web/tests/assistant-browser.mjs`，退出 1。收起状态的编辑区起点实测为 34 像素，预期为 0。

自审在 1280 像素窗口发现展开四栏后普通短文件名也被截断。补充验收：该宽度完整显示「周报.md」，模式菜单仍可操作。

### 标题行布局验收 · DELIVERED

受测提交 `0d839d7`，沿用方式 2。Chrome 在 1280 像素桌面和 390 像素手机视口测量收起、展开两种布局。空编辑区、笔记和手机列表均贴顶，开关原位切换，历史、新建对话和已有标题操作可分别点击。自审时修正了手机背景列表的隐藏范围，并在四栏挤窄编辑区时将模式选择器折为图标，短文件名显示完整。

- `WENOTE_TEST_ORIGIN=http://localhost:19453 node apps/web/tests/assistant-browser.mjs` 退出 0，覆盖标题布局、模式菜单、对话历史、写入和草稿恢复。
- `WENOTE_API=dist/local/wenote-api node tests/e2e/desktop.mjs --browser` 和 `git diff --check` 均退出 0。
- Web 重新构建并运行在 `http://localhost:19453`，PID 35749，`/healthz` 返回 `ok`。刷新后打开笔记，点击「更多操作」右侧的分栏图标试用。macOS 调试包 `target/debug/bundle/macos/WeNote.app` 构建成功，本轮交互验证在 Chrome 完成。
