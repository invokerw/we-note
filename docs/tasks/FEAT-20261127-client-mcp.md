# 客户端 MCP 笔记与导图

基线 `main@d23846e`。分支 `codex/feature-client-mcp-20261127`，worktree `.worktrees/client-mcp`。2026-11-27 登记 PLANNED，用户选定方式 2 后进入 IN_PROGRESS。需求依据为主工作区的 `docs/MCP 笔记编辑设计.md` 草案及本轮确认的功能范围。原始需求「只做mcp相关的」「希望所有端都支持」。

## 范围与验收条件

- 网页、桌面、移动端共用文件搜索、读取、新建、文本更新、移动、软删除；导图节点查询、批量增删改及移动保护。插件格式处理复用客户端逻辑。
- 连接按账号和库授权，读写隔离、可撤销。桌面通过回环 HTTP，网页和手机可在当前应用使用协议工具。
- 带版本及路径提交，未保存草稿受保护。重试幂等；离线快照可读取，联网恢复后同步并暴露冲突。
- TDD 使用 Node 工具测试、浏览器协议与连接测试、Rust 传输测试及客户端构建。独立验收服务和可用产物见后续记录。iOS 集成依赖单独的工程分支。内置个人助手留待后续规划。
- 2026-11-27 追加范围，沿用任务分支验收。交付给笔记用户的 `wenote-notes` Skill、安装说明和可解压的包。Skill 应使用已授权的 WeNote MCP 工具完成文件与节点增删改查，处理同名目标、版本冲突、重试和离线回执。用真实客户端执行 Skill 中的 Markdown 定点替换和导图分支编辑示例，并核对其他同名目标未变。

## 实现与验证

用户已授权推送任务分支并运行现有 GitHub Actions。既有桌面 CI 扩充为 macOS、Windows、Linux，并在 macOS runner 上检查 iOS 模拟器目标的共享客户端库。Android CI 在模拟器上安装 APK，运行原生导图离线读写。iOS 完整安装包及真机操作仍依赖独立工程。

先让 Node 工具测试因缺少模块失败，再实现原文替换、节点操作及字段保留。补充回归测试先复现摘要跨父节点和损坏标签识别问题，再修复。浏览器回归覆盖独立助手授权、版本竞争、断网重放、跨标签草稿及第三方 WASM 格式。用隔离的 macOS WKWebView 与真实笔记目录验证授权、外部 HTTP 握手及同一追加重试。

自审核对了离线回执、原生写入后进程中断的重放、插件升级、账号和库隔离、HTTP 鉴权及导图关联数据。按当前平台编译目标选择桌面传输，各助手持有独立可撤销的凭据。

网页验收服务 `http://localhost:19439`，PID 5655；日志 `dist/local/server.log`，数据 `services/api/data`。可注册普通测试账号并新建笔记库。macOS 启动产物 `dist/local/wenote-desktop`，服务地址填上面的地址，同步并打开库后，在「个人设置 → MCP 连接」授权。验收结束后可在此 worktree 运行 `./scripts/local.py stop`。

## 分支交付

2026-11-27 · `DELIVERED` · 方式 2。受测提交 `fbbc7f94ac6a2c77ad342bb1cca62bceb50c8ad8` 已推送至 `origin/codex/feature-client-mcp-20261127`。验收期间保留任务分支、worktree 及本机服务。

| 平台 | 已通过的验证 |
| --- | --- |
| 网页 | Chrome 实测搜索、文本及导图增删改查、第三方 WASM 格式、独立授权与撤销、旧版本冲突、跨标签草稿保护、重复写入和离线同步。 |
| macOS、Windows、Linux | 三个 runner 均构建客户端并通过 HTTP 鉴权、工具测试、双设备同步和浏览器回归。macOS 本机另由独立进程经 HTTP 对实际 WKWebView 初始化、发现工具、重复追加并核对笔记目录原文。[桌面与网页 CI](https://github.com/invokerw/we-note/actions/runs/45936029526) |
| Android | API 35 x86_64 模拟器安装调试 APK，离线重启、授权、新建导图、添加及查询节点、整图移入回收站，随后通过原有同步与冲突恢复验收。[Android CI](https://github.com/invokerw/we-note/actions/runs/45936031163) · [模拟器 APK 工件](https://github.com/invokerw/we-note/actions/runs/45936031163/artifacts/15171211094) |
| iOS | 共享原生客户端通过 `aarch64-apple-ios-sim` 目标编译检查。完整 iPhone 应用的签装与真机操作待 iOS 工程集成后验证。 |

跨平台回归还复现并修复了恢复 Android 后台绑定时缺少账号缓存的问题，保留了对应回归测试。Android 测试在每次重启应用后重新连接当前 WebView。旧版只读插件仍通过安装与权限用例。

手动验收可打开 `http://localhost:19439`，或从本 worktree 打开 `dist/local/WeNote MCP.app`（Apple Silicon）。登录后选库，进入「个人设置 → MCP 连接」。先用只读连接列出工具，再为另一助手授权编辑，按读取的版本和路径追加一句或创建一张 `.mind.json` 导图。软件内可核对正文、节点或回收站；撤销单个连接后可继续使用另一个助手。

## 配套 Skill 验收

2026-11-27 · `CHANGES_REQUESTED` → `DELIVERED` · 沿用方式 2。可分发的 Skill 位于 [skills/wenote-notes](../../skills/wenote-notes/SKILL.md)。将 `dist/local/wenote-notes.zip` 解压到助手的技能目录，再连接测试库。需要重新打包时，在任务分支根目录运行 `git archive --format=zip --output=dist/local/wenote-notes.zip HEAD:skills wenote-notes`。

- 安装包校验。`quick_validate.py skills/wenote-notes` 最初因缺少 `SKILL.md` 退出 1。实现后对源码和解压目录校验均退出 0。已核对归档清单和解压后文件与源码逐字节一致。
- 客户端验收。在 `http://localhost:19439` 的独立测试库中，以 Chrome 执行从安装包正文提取的两个 `tools/call` 示例，退出 0。在两个目录新建同名周报，翻页定位 `产品/周报.md`，修改指定句子后核对正文和换行。在两个分支各建「调研」节点，只在「产品」下添加两级节点并读回父子 ID。重复请求各执行一次，旧版本写入返回 `FILE_VERSION_CONFLICT`。
- 自审对照客户端的八个工具签名、插件类型、同步回执和错误处理，确认 Skill 使用当前连接提供的工具名。安装说明见项目 README 的「通过 MCP 编辑笔记」。本轮交付范围为 Skill 和说明，客户端产物及跨平台验证记录见上表。
