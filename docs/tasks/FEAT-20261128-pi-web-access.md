# FEAT-20261128-pi-web-access

## 基本信息

| 字段 | 内容 |
| --- | --- |
| 任务 ID | `FEAT-20261128-pi-web-access` |
| 类型 | `feature` |
| 登记日期 | `2026-11-28` |
| 影响端 | `web / desktop / android / iOS` |
| 状态 | `IN_PROGRESS` |
| 开工前确认的验收方式 | 2（任务分支验收，通过后再合入 main） |
| 基线分支 | `main` |
| 基线提交 | `15fb4bf` |
| 任务分支 | `codex/feature-pi-web-access-20261128` |
| worktree | `/Users/weifei/code/we-note/.worktrees/pi-web-access-20261128` |
| 需要独立服务端 | 否。各客户端直接调用 OpenAI Responses API，复用现有 WeNote API 的登录和笔记能力。 |

## 用户原始需求

> 使用内部工具实现 web 相关工具，使用 OpenAI 的搜索功能。

此前已验证 OpenAI-compatible Responses endpoint 可以使用 `web_search`。此前任务曾按 `pi-web-access + MCP` 实现，用户在验收讨论中将方案调整为 WeNote 内部 AgentTool 方案。

临时 API Key 不写入仓库、任务记录、日志和测试夹具。

## 方案变更

| 日期 | 变更 |
| --- | --- |
| 2026-11-28 | 初始方案使用 `pi-web-access@0.48.0`，通过桌面 MCP 和外部 Streamable HTTP Gateway 提供网络工具。 |
| 2026-11-28 | 根据用户反馈改为 WeNote 内部 AgentTool，直接调用 OpenAI Responses API 的 `web_search`，取消客户端对 MCP Gateway 的依赖。 |

## 新目标

在 WeNote 个人笔记助手中提供客户端内部网络工具。Agent 使用固定的 `AgentTool` schema，工具直接调用 OpenAI Responses API 的原生 `web_search` 能力，并将搜索结果与来源返回给 Pi Agent Core。

### 目标调用链

```text
Pi Agent Core
    ↓
WeNote 内部 AgentTool
    ↓
WebSearchService
    ├─ Web / Android / iOS → OpenAI Responses API
    └─ Desktop → OpenAI Responses API，必要时经 Tauri HTTP command
    ↓
OpenAI Responses API
    ↓
web_search
```

## 目标范围

### 内部网络工具

- `web_search`
- `get_search_content`
- `fetch_content`
- `source_check`

### 平台支持

- Web、Android、iOS 和桌面端都在客户端注册内部网络工具。
- 所有平台共享工具 schema、OpenAI Responses 请求格式、结果结构、来源提取和历史展示。
- 客户端复用当前模型配置中的 endpoint、模型和 API Key。

### OpenAI 配置

各客户端复用当前助手模型配置中的：

```text
Base URL: https://api.ergou.vip/v1
Responses endpoint: https://api.ergou.vip/v1/responses
Search model: gpt-6.2-sol
API Key: 当前模型配置中的密钥
```

Web、Android、iOS 和桌面端都使用当前客户端配置发起搜索请求。

## 实现要求

### AgentTool 层

- 新增或改造 `apps/web/src/assistant/webSearch.ts`。
- 由 `createWebSearchTools()` 返回固定的 `AgentTool[]`。
- 关闭网络搜索时不注册工具。
- `execute` 负责状态、取消、服务调用和结果转换。
- 工具 schema 不从外部服务动态发现。

### OpenAI Responses 层

- 使用 Responses endpoint。
- 请求体包含配置的搜索模型、用户查询和 `tools: [{ "type": "web_search" }]`。
- 解析文本输出、来源 URL 和来源标题。
- 适配 OpenAI-compatible endpoint 的 `/responses` 路径。
- 将 Provider 错误转换为 WeNote 稳定错误码。

### 客户端请求层

实现客户端 OpenAI Responses API 适配。

```text
POST <baseUrl>/responses
Authorization: Bearer <model API key>
```

客户端复用当前模型配置中的 Base URL、API Key 和搜索模型。Web、Android、iOS 的 endpoint 需要允许客户端跨域请求。桌面端可以直接使用相同请求，也可以通过 Tauri 转发。

网页读取需要限制：

- URL scheme
- 私有地址和回环地址
- 响应大小
- 响应时间
- 内容类型

### Tauri 层

- 允许客户端前端直接发起 HTTPS 搜索请求。
- 如目标 endpoint 的跨域策略不适合桌面 WebView，可增加直接 HTTP 搜索命令。
- 移除或停用本地 `pi-web-access-mcp` 进程启动逻辑。
- 支持 AbortSignal 对应的请求取消。
- API Key 不写入配置文件和临时文件。

### UI 和历史

- 保留联网搜索开关。
- 移除 MCP Gateway URL 设置项。
- 增加搜索服务状态。
- 保留搜索状态提示。
- 保留来源链接展示和历史持久化。
- 搜索结果不绕过笔记写入预览和用户确认。

## 验收条件

### Agent 和客户端

- [ ] 内部 `web_search` 工具可以被 Pi Agent Core 调用。
- [ ] `get_search_content` 可以读取当前轮次缓存结果。
- [ ] `fetch_content` 可以读取符合安全限制的网页正文。
- [ ] `source_check` 可以返回来源核验结果。
- [ ] 关闭网络搜索时，Agent 不注册网络工具。
- [ ] 搜索状态、停止传播、超时和错误提示正常。
- [ ] 来源标题和 URL 可以点击。
- [ ] 来源刷新或重新打开历史对话后仍可见。

### 客户端请求

- [ ] Web、Android、iOS 和桌面端可以发起 OpenAI Responses `web_search` 请求。
- [ ] 请求使用当前模型配置中的 Base URL、API Key 和搜索模型。
- [ ] API Key 只出现在 Authorization 请求头。
- [ ] OpenAI Responses `web_search` 请求成功。
- [ ] `api.ergou.vip/v1` 与 `gpt-6.2-sol` 的受控搜索请求成功。
- [ ] 客户端 Provider 错误返回稳定错误码。
- [ ] 超时和取消正常。
- [ ] 回环地址、私有地址、过大网页响应和不支持的内容类型被拒绝。
- [ ] API Key 不出现在日志、Agent prompt、工具结果和会话正文中。
- [ ] 不新增 MCP Gateway 或服务器端搜索密钥配置。

### 现有功能回归

- [ ] 笔记搜索、读取和导图读取仍然正常。
- [ ] 笔记创建、编辑、移动和删除继续经过预览与确认。
- [ ] 搜索结果不会直接写入笔记。
- [ ] Web 构建通过。
- [ ] Tauri 编译通过。
- [ ] Android 和 iOS 构建或入口验证通过。

## 历史实现记录

此前提交 `9407247` 实现了 `pi-web-access@0.48.0` 的 MCP stdio 和 Streamable HTTP 客户端，提交 `28dda81` 记录了该实现的交付状态。该实现保留为方案变更前的验证依据，后续改造会移除其网络搜索运行时依赖。

此前已经验证：

- `initialize` 和 `tools/list` 可以正常完成。
- `web_search`、`fetch_content`、`get_search_content`、`source_check` 可以被发现。
- OpenAI-compatible Responses endpoint 可以完成受控 `web_search` 请求。

新方案需要重新实现内部工具、客户端 Responses 适配和对应测试。历史 MCP 测试不能替代新方案的验收。

## 实施顺序

1. 更新 TypeScript 工具层，移除运行时 MCP 工具发现和调用依赖。
2. 实现客户端 Responses API 请求、文本解析和来源归一化。
3. 实现网页读取安全策略和来源核验。
4. 在 Web、桌面和移动端入口复用前端 HTTPS 请求适配。
5. 更新 `runTurn`、设置页、上下文缓存键和历史来源处理。
6. 先补充失败测试，再按最小改动实现内部工具。
7. 运行 TypeScript、Web、桌面和 Tauri 测试。
8. 自审完整差异，修复问题并重新测试。
9. 在任务分支提供 Web、桌面和移动端验收入口。

## TDD 记录

### 既有历史测试

此前 MCP 方案的测试已通过，记录在历史交付版本中。新方案需要新增失败测试覆盖内部 `AgentTool` 和客户端 Responses 请求。

### 新方案测试记录

| 日期 | 命令 | 结果 | 关键结果 |
| --- | --- | --- | --- |
| 2026-11-28 | `node --test apps/web/tests/assistant-web-search.test.mjs` | 通过 | 内部 AgentTool、Responses 请求、来源解析、缓存、网页读取和错误码 |
| 2026-11-28 | `node --test --test-concurrency=1 tests/*.test.mjs` | 通过 | Web 测试 36 项通过 |
| 2026-11-28 | `npm run build --prefix apps/web` | 通过 | Web TypeScript 和 Vite 构建通过 |
| 2026-11-28 | `npm run build:desktop --prefix apps/web` | 通过 | 桌面前端 TypeScript 和 Vite 构建通过 |
| 2026-11-28 | `cargo fmt --check --manifest-path apps/client/src-tauri/Cargo.toml` | 通过 | Tauri 格式检查通过 |
| 2026-11-28 | `cargo check --locked --manifest-path apps/client/src-tauri/Cargo.toml` | 通过 | Tauri 编译检查通过 |
| 2026-11-28 | `cargo test --locked -p wenote-desktop --lib` | 通过 | Tauri 单元测试 3 项通过，授权环境重跑确认本地 socket 测试正常 |
|  |  | 待执行 | 真实 Responses Provider 请求和 Web、桌面、移动端人工入口验收 |

## 服务端边界

| 项目 | 内容 |
| --- | --- |
| 搜索服务 | 不新增 WeNote 搜索 API，不新增 MCP Gateway。 |
| OpenAI 搜索密钥 | 由各客户端当前模型配置提供。 |
| 现有 API | 继续负责登录、笔记和同步，不参与搜索请求。 |
| 服务端改动 | 本方案不要求 Go API 改动。 |

## 客户端交付

| 项目 | 内容 |
| --- | --- |
| Web 构建 | `npm run build --prefix apps/web` |
| 桌面构建 | `npm run build:desktop --prefix apps/web`、`cargo build --locked -p wenote-desktop --release` |
| Web 入口 | 在模型设置中开启网络搜索，复用当前模型 Responses 配置。 |
| 桌面入口 | 在模型设置中开启网络搜索，复用当前模型 Responses 配置。 |
| 移动入口 | 在移动端助手中开启网络搜索，复用当前模型 Responses 配置。 |

## 状态变更记录

| 日期 | 状态 | 依据 | 下一步 |
| --- | --- | --- | --- |
| 2026-11-28 | `PLANNED` | 已从 `main` 创建任务 worktree，完成初版 MCP 设计 | 等待用户确认验收方式 |
| 2026-11-28 | `IN_PROGRESS` | 用户选择方式 2，完成初版 MCP 客户端实现 | 等待用户确认新的内部工具方案 |
| 2026-11-28 | `IN_PROGRESS` | 用户要求改为客户端内部 AgentTool 和 OpenAI Search | 更新设计，重写客户端实现和补充集成测试 |
| 2026-11-28 | `IN_PROGRESS` | 已完成客户端内部网络工具、设置项和 Tauri 清理，Web 与桌面构建通过 | 在任务分支运行授权环境 Tauri 测试，等待用户验收 |

## 用户验收

| 日期 | 结果 | 反馈 | 处理 |
| --- | --- | --- | --- |
| 2026-11-28 | 待验收 | 已完成第一轮客户端内部工具实现和自动化测试 | 请在任务分支验收搜索开关、真实 Provider 请求、来源展示和笔记写入确认流程 |

## 验收通过后的清理

| 项目 | 内容 |
| --- | --- |
| 用户确认通过的交付提交 | 待填写 |
| 合并后验证 | 待填写 |
| worktree 清理时间 | 待填写 |
| 分支清理时间 | 待填写 |
