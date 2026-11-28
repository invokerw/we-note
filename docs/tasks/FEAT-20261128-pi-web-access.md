# FEAT-20261128-pi-web-access

## 基本信息

| 字段 | 内容 |
| --- | --- |
| 任务 ID | `FEAT-20261128-pi-web-access` |
| 类型 | `feature` |
| 登记日期 | `2026-11-28` |
| 影响端 | `web / desktop / android / iOS` |
| 状态 | `DELIVERED` |
| 开工前确认的验收方式 | 2（任务分支验收，通过后再合入 main） |
| 基线分支 | `main` |
| 基线提交 | `15fb4bf` |
| 任务分支 | `codex/feature-pi-web-access-20261128` |
| worktree | `/Users/weifei/code/we-note/.worktrees/pi-web-access-20261128` |
| 需要独立服务端 | 否。首轮接入桌面本地 MCP 和外部 MCP Streamable HTTP Gateway。 |

## 用户原始需求

> 可以，写个开发文档，开始做吧

此前已确认采用 `pi-web-access`，在其中配置 OpenAI Search。已验证用户提供的临时网关 Key 可访问 `https://api.ergou.vip/v1/models`，并使用 `gpt-6.2-sol` 在 `/v1/responses` 中完成 `web_search`。临时 Key 不写入仓库和任务记录。

## 目标与范围

### 已交付目标

在 WeNote 个人笔记助手中接入 `pi-web-access@0.48.0` MCP，将 OpenAI Responses 的 `web_search` 能力作为网络工具提供给 Pi Agent Core，并展示搜索状态和来源。

### 已实现范围

- 固定并验证 `pi-web-access@0.48.0` 的 MCP 初始化和工具发现
- 实现 MCP stdio 和 Streamable HTTP 客户端适配
- 接入 `web_search`、`fetch_content`、`get_search_content`、`source_check`
- 使用 OpenAI provider、Responses endpoint 和用户配置的搜索模型
- 桌面端通过 Tauri 启动本地 MCP 子进程
- Web、Android 和 iOS 通过配置的 MCP Gateway 地址连接
- 增加联网搜索开关、状态提示、来源保存和来源展示
- 增加 Bearer 请求头、60 秒 HTTP 超时、AbortSignal 取消和工具缺失过滤
- 复用现有笔记 MCP、写入预览和授权边界

### 明确排除

- 不在仓库保存任何 API Key
- 不自动将未引用笔记正文发送到网络搜索服务
- 不把搜索结果直接写入笔记
- 不在本任务中实现多提供商自动回退
- 不接入图片、视频和其他非文本搜索
- 不依赖 ChatGPT 网页登录态
- 不在本任务中新增可公开部署的 Gateway 服务

## 验收条件

- [x] `pi-web-access` 可以完成 MCP 初始化和工具发现。
- [x] Agent 适配层可以通过 MCP 调用网络工具，并把结果转换为 Pi Agent 工具结果。
- [x] OpenAI Responses provider 使用配置的 endpoint 和模型执行搜索。
- [x] 使用 `https://api.ergou.vip/v1` 与 `gpt-6.2-sol` 的受控请求已成功。
- [x] 关闭联网搜索时，Agent 不注册网络工具，也不发起网络搜索请求。
- [x] 搜索状态、停止传播、HTTP 超时和 Tauri 取消链路已接入。
- [x] 最终回答可以展示可点击的来源标题和 URL。
- [x] 来源随本机会话保存，刷新或重新打开历史对话后仍可见。
- [x] API Key 不出现在代码、日志、Agent prompt、工具结果和会话正文中。
- [x] 现有笔记读取、写入预览和用户确认流程通过回归测试。
- [x] Web 构建、桌面前端构建和 Tauri 编译通过。
- [ ] 外部 Gateway 的实际部署、浏览器真实搜索和 Android、iOS 真机搜索待用户验收。

## 需求变更记录

| 日期 | 变更 |
| --- | --- |
| 2026-11-28 | 确定使用 `pi-web-access` 作为统一搜索工具层，OpenAI Responses Search 作为提供商。 |
| 2026-11-28 | 增加桌面 Tauri MCP 传输和 Web、移动端 Streamable HTTP Gateway 传输。Gateway 服务本身不在本任务实现。 |

## 实现计划

1. 固定 `pi-web-access` 版本并完成本地 MCP 的 `initialize`、`tools/list` 和 `web_search` 冒烟测试。
2. 实现 Web Access MCP 连接、会话生命周期、工具发现、调用转发、取消和超时。
3. 将 Web Access 工具与 WeNote MCP 工具合并到 Pi Agent Core。
4. 增加搜索状态、来源归一化、历史保存和消息展示。
5. 增加配置项、权限开关和错误提示。
6. 完成 Web、桌面和移动端入口验证。
7. 运行聚焦测试、回归测试、构建和端到端验收。
8. 自审差异并按验收方式交付。

以上第 1 至第 5 项已完成，第 6 项完成客户端入口和构建验证，外部 Gateway 与移动真机部分保留给验收环境。

## TDD 证据

### 失败测试

| 日期 | 命令 | 退出状态 | 失败原因 |
| --- | --- | --- | --- |
| 2026-11-28 | `node --test apps/web/tests/assistant-web-access.test.mjs` | 1 | 首轮缺少 `apps/web/src/assistant/webAccess.ts`，按 TDD 先固定失败基线。 |

### 通过测试

| 日期 | 命令 | 退出状态 | 关键结果 |
| --- | --- | --- | --- |
| 2026-11-28 | `node --test apps/web/tests/assistant-web-access.test.mjs` | 0 | 7 项通过，覆盖来源提取、结果转换、开关、缺少网关、通知格式、HTTP 会话和 Bearer 请求头。 |
| 2026-11-28 | `node --test apps/web/tests/assistant.test.mjs apps/web/tests/assistant-web-access.test.mjs` | 0 | 11 项通过，覆盖配置归一化、Gateway URL 校验、笔记写入策略和 Web Access 适配。 |
| 2026-11-28 | `node --test --test-concurrency=1 tests/*.test.mjs` | 0 | Web 前端测试 31 项通过。测试输出包含既有 Vite WebSocket 监听权限提示，不影响测试结果。 |
| 2026-11-28 | `npm run build --prefix apps/web` | 0 | TypeScript 检查和 Web Vite 构建通过。 |
| 2026-11-28 | `npm run build:desktop --prefix apps/web` | 0 | 桌面前端 TypeScript 检查和构建通过，产物位于 `apps/client/dist/`。 |
| 2026-11-28 | `cargo check --manifest-path apps/client/src-tauri/Cargo.toml` | 0 | Tauri Rust 代码编译通过。 |
| 2026-11-28 | `cargo test --locked -p wenote-desktop --lib` | 0 | 3 项 Tauri 原生单元测试通过。 |
| 2026-11-28 | `cargo build --locked -p wenote-desktop` | 0 | 桌面端 debug 构建通过。 |
| 2026-11-28 | `cargo build --locked -p wenote-desktop --release` | 0 | macOS ARM64 release 编译通过。 |
| 2026-11-28 | `pi-web-access@0.48.0` MCP stdio 冒烟 | 0 | `initialize` 和 `tools/list` 成功，发现 4 个网络工具。 |

## 变更检查

- [x] `git diff --check`
- [x] 影响模块回归测试
- [x] 完成 MCP 协议冒烟验收
- [x] 完成 Web 构建
- [x] 完成桌面前端和 Tauri 编译验证
- [ ] 完成外部 Gateway 和移动真机验收

## 每轮自审与交付

| 轮次 / 对应反馈 | 自审发现及优化处理 | 复测命令和结果 | 验收分支及受测提交号 | 验收入口 |
| --- | --- | --- | --- | --- |
| 首次交付 | 修复搜索配置归一化丢失 `webSearch: true`、MCP 初始化通知错误带 ID、HTTP 空通知响应、Gateway URL 校验、上下文缓存隔离和 Tauri 取消链路。未把 API Key 写入代码、配置文件、日志或会话历史。 | Web 31 项、聚焦 11 项、Tauri 3 项通过，Web 和桌面前端构建通过。 | `codex/feature-pi-web-access-20261128`，提交 `9407247` | 使用本 worktree 的 Web 构建或 `target/release/wenote-desktop`，在模型设置中开启「网络搜索」。桌面端网关地址留空，Web 或移动端填写外部 MCP Gateway。 |

## 独立服务端

| 项目 | 内容 |
| --- | --- |
| 启动命令 | 未新增。桌面端由 Tauri 启动 `pi-web-access-mcp`，缺少本机命令时回退 `npx -y pi-web-access@0.48.0`。Web、Android、iOS 需要外部 MCP Streamable HTTP Gateway。 |
| 地址和端口 | 外部 Gateway 地址由用户在模型设置中填写。 |
| PID | 桌面 MCP 进程由 Tauri 管理。 |
| 日志 | 不写入仓库日志。子进程标准错误被丢弃，协议标准输出只作为 MCP 通道。 |
| 数据目录 | 桌面临时配置位于 Tauri `app_cache_dir/pi-web-access/web-search.json`，不包含 API Key。 |
| 测试账户或初始化步骤 | 填写 Responses Base URL、模型 ID、API Key，打开联网搜索。Gateway 模式需要符合 MCP Streamable HTTP 的外部服务。 |
| 停止命令 | Tauri 取消调用会终止当前子进程，应用退出时由进程生命周期回收。 |

## 客户端交付

| 项目 | 内容 |
| --- | --- |
| 构建命令 | `npm run build --prefix apps/web`、`npm run build:desktop --prefix apps/web`、`cargo build --locked -p wenote-desktop --release` |
| 启动或安装命令 | `target/release/wenote-desktop`，服务地址按现有桌面流程配置。 |
| 产物路径 | `/Users/weifei/code/we-note/.worktrees/pi-web-access-20261128/apps/client/dist/`，`target/release/wenote-desktop` |
| 使用的服务端地址 | `https://api.ergou.vip/v1`，仅用于此前受控测试。 |
| 已验证功能 | MCP 初始化、工具发现、工具适配、搜索开关、来源保存、Web 和桌面构建、Tauri 原生编译及既有单元测试。 |

## 状态变更记录

| 日期 | 状态 | 依据 | 下一步 |
| --- | --- | --- | --- |
| 2026-11-28 | `PLANNED` | 已从 `main` 创建任务 worktree，完成设计文档和任务记录 | 等待用户确认验收方式 |
| 2026-11-28 | `IN_PROGRESS` | 用户选择方式 2，开始在任务分支实现 | 完成 MCP 适配和聚焦测试 |
| 2026-11-28 | `DELIVERED` | 实现、测试、自审和构建已完成，任务分支保留待用户验收 | 用户验收外部 Gateway 和移动端场景 |

## 用户验收

| 日期 | 结果 | 反馈 | 处理 |
| --- | --- | --- | --- |
|  | 待验收 |  |  |

## 验收通过后的清理

| 项目 | 内容 |
| --- | --- |
| 用户确认通过的交付提交 | 待填写 |
| 合并后验证 | 待填写 |
| worktree 清理时间 | 待填写 |
| 分支清理时间 | 待填写 |
