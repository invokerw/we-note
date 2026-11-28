# v0.1.3 发布构建阻塞修复

## 基本信息

| 字段 | 内容 |
| --- | --- |
| 任务 ID | `FIX-20261128-release-build` |
| 类型 | `bugfix` |
| 登记日期 | `2026-11-28` |
| 影响端 | `server / web / desktop / android` |
| 状态 | `IN_PROGRESS` |
| 开工前确认的验收方式 | `2. 任务分支验收，通过后再合入` |
| 基线分支 | `main` |
| 基线提交 | `117d3a55a790544a8d4538818f8c0fe38763403c` |
| 任务分支 | `codex/bugfix-release-build-20261128` |
| worktree | `/Users/weifei/.codex/worktrees/bugfix-release-build-20261128/we-note` |
| 需要独立服务端 | 待定位，若端到端复现需要则使用独立实例 |

## 用户原始需求

> 修复问题，构建 release吧

背景是 `v0.1.2` 发布工作流未完成。

## 已知问题与复现证据

2026-11-28 推送 `v0.1.2` 后，GitHub Actions Release 运行 `46115108001` 出现以下结果。

- 四个平台客户端构建通过。
- `Server image` 在 Dockerfile 的 `RUN npm run build` 失败。
- `Publish GitHub Release` 被跳过。
- 同一提交的桌面与网页验收运行 `46115107958` 在 Ubuntu 和 macOS 的 `node tests/e2e/desktop.mjs --browser` 失败，Windows 通过。

## 目标与范围

### 目标

修复阻塞正式发布的 Web 生产构建和跨平台桌面端到端验收问题，使修复提交可以通过 `v0.1.3` 发布流程。

### 范围

- 在任务 worktree 复现 `npm ci --prefix apps/web` 和 `npm run build --prefix apps/web`。
- 定位 Docker 镜像构建中的 Web 构建失败并补充必要回归测试或构建检查。
- 定位 Ubuntu、macOS 的桌面端浏览器验收失败，修复代码、测试入口或跨平台时序问题。
- 按任务验收方式构建并验证 Web、桌面、Android 和服务端镜像发布入口。
- 更新本任务记录，保存每轮命令、结果、受测提交和发布状态。

### 明确排除

- 不扩展产品功能。
- 发布版本采用新建的 `v0.1.3`，保留远端已有的旧 `v0.1.2` tag。
- 不绕过失败 job 或手工伪造 Release。

## 验收条件

- [x] 任务 worktree 中 `npm ci --prefix apps/web` 和 `npm run build --prefix apps/web` 通过。
- [x] 相关 Node、桌面和服务端回归测试通过，保留能够覆盖本次错误的回归验证。
- [ ] Docker 多阶段构建完成，服务端镜像能通过发布脚本的双架构启动检查。
- [ ] Web、Windows、macOS、Linux 和 Android 的发布构建入口通过，客户端产物可被工作流收集。
- [ ] 推送 `v0.1.3` 后 Release 工作流所有 job 通过，GitHub Release 生成安装包和镜像说明。
- [x] `git diff --check` 通过，任务记录和开发账本包含本轮交付证据。

## 需求变更记录

- 2026-11-28 登记任务。基线为当前 `main@117d3a5`，先复现发布工作流中 Web 镜像构建和跨平台桌面端到端失败。
- 2026-11-28 用户选择方式 2，在任务分支验收通过后再合入。

## 实现计划

1. 阅读发布工作流、Dockerfile、Web 构建入口和桌面端到端测试，确认失败的最小原因。
2. 先补充能复现问题的测试或构建检查，再实施最小修复。
3. 运行聚焦测试、Web 构建、桌面端回归和镜像检查。
4. 自审完整差异，提交任务分支，并按验收方式交付。
5. 通过验收后推送 `v0.1.3`，确认 Release 工作流和发布资产。

## TDD 证据

### 失败测试

| 时间 | 命令 | 退出状态 | 失败原因 |
| --- | --- | --- | --- |
| 2026-11-28 | `npm run build --prefix apps/web` | 2 | 当前主工作区缺少已安装的依赖，TypeScript 报告多个依赖模块无法解析，需在任务 worktree 执行干净安装后确认真实失败。 |
| 2026-11-28 | GitHub Actions `Release` run `46115108001` | failure | Docker `RUN npm run build` 失败，导致服务端镜像和 Release job 失败。 |
| 2026-11-28 | GitHub Actions `Desktop and web acceptance` run `46115107958` | failure | Ubuntu 和 macOS 的 `node tests/e2e/desktop.mjs --browser` 失败，Windows 通过。 |
| 2026-11-28 | `python3 tests/release/check-web.py` | 1 | 新增回归检查先于修复失败，确认 Docker 上下文和 Chrome 配置均缺失。 |
| 2026-11-28 | `python3 tests/release/check-web.py` | 1 | 第二轮回归检查先于修复失败，确认 Linux Chrome for Testing 还缺少 runner 依赖配置。 |
| 2026-11-28 | 模拟 Docker Web 上下文的 `npm run build` | 1 | 无法解析 `../../../../skills/wenote-notes/SKILL.md?raw`。 |

### 通过测试

| 时间 | 命令 | 退出状态 | 关键结果 |
| --- | --- | --- | --- |
| 2026-11-28 | `npm ci --prefix apps/web` | 0 | 干净安装完成。 |
| 2026-11-28 | `npm run build --prefix apps/web` | 0 | Web 生产构建通过。 |
| 2026-11-28 | `npm run build:desktop --prefix apps/web` | 0 | 桌面前端构建通过。 |
| 2026-11-28 | `python3 tests/release/check-web.py` | 0 | 发布启动探针测试通过，包含 Linux Chrome 依赖配置检查。 |
| 2026-11-28 | `go test ./...` in `services/api` | 0 | 服务端测试通过。 |
| 2026-11-28 | `node --test apps/web/tests/mcp-tools.test.mjs apps/web/tests/assistant.test.mjs apps/web/tests/assistant-web-search.test.mjs apps/web/tests/web-build-history.test.mjs` | 0 | Web 相关测试通过。 |
| 2026-11-28 | `CHROME_PATH=... WENOTE_API=./wenote-api node tests/e2e/desktop.mjs --browser` | 0 | Rust 同步、账户存储和完整浏览器验收通过。 |
| 2026-11-28 | `npm ci --prefix apps/client` | 0 | 客户端 release 依赖安装通过。 |
| 2026-11-28 | `cargo build --locked --workspace` | 0 | Rust workspace 构建通过。 |
| 2026-11-28 | Tauri macOS `.app` bundle | 0 | `WeNote.app` 构建完成。 |
| 2026-11-28 | macOS DMG bundle | 1 | 本机 Finder AppleEvent 超时，`.app` 已成功生成。 |

### 变更检查

- [x] `git diff --check`
- [x] 影响模块回归测试
- [ ] 发布构建和镜像检查

## 每轮自审与交付

| 轮次 / 对应反馈 | 自审发现及优化处理 | 复测命令和结果 | 验收分支及受测提交号 | 验收入口 |
| --- | --- | --- | --- | --- |
| 首轮修复 | 修复 Docker 构建上下文和跨平台 Chrome 配置，补充发布回归检查。采用新建 `v0.1.3`，保留远端已有的旧 `v0.1.2` tag。 | Web、桌面前端、Rust、Go、浏览器验收和 macOS `.app` 已通过，DMG 受本机 Finder 超时影响。旧运行中 Ubuntu 和 Windows 已通过，macOS 浏览器验收超时。 | `codex/bugfix-release-build-20261128`，`26846f8` | [Desktop and web acceptance](https://github.com/invokerw/we-note/actions/runs/46133621551) |
| 第二轮修复 | 为 Linux runner 的 Chrome for Testing 安装系统依赖，并补充回归检查。 | Ubuntu 通过，Windows 浏览器验收失败，macOS 仍在运行。`python3 tests/release/check-web.py` 通过。 | `codex/bugfix-release-build-20261128`，`febfdcf` | [Desktop and web acceptance](https://github.com/invokerw/we-note/actions/runs/46137882558) |
| 第三轮修复 | 保留 Linux 和 macOS 的显式 Chrome 路径，让 Windows 使用 runner 自带的 Chrome 通道，避免 Windows 浏览器验收回归。 | `python3 tests/release/check-web.py` 通过，等待新的三平台 GitHub Actions 验证。 | `codex/bugfix-release-build-20261128`，待提交 | 分支 push 后检查 GitHub Actions |

## 独立服务端

| 项目 | 内容 |
| --- | --- |
| 启动命令 | 待确定 |
| 地址和端口 | 待确定 |
| PID | 待确定 |
| 日志 | 待确定 |
| 数据目录 | 待确定 |
| 测试账户或初始化步骤 | 待确定 |
| 停止命令 | 待确定 |

## 客户端交付

| 项目 | 内容 |
| --- | --- |
| 构建命令 | `npm ci --prefix apps/client`，Tauri macOS `.app` release build |
| 启动或安装命令 | `/Users/weifei/.codex/worktrees/bugfix-release-build-20261128/we-note/target/aarch64-apple-darwin/release/bundle/macos/WeNote.app` |
| 产物路径 | `target/aarch64-apple-darwin/release/bundle/macos/WeNote.app` |
| 使用的服务端地址 | 浏览器验收使用独立随机端口，由 `tests/e2e/desktop.mjs` 启动临时 API |
| 已验证功能 | 桌面存储、同步冲突、MCP、助手、分片上传、入口菜单和阶段验收 |

## 状态变更记录

| 时间 | 状态 | 依据 | 下一步 |
| --- | --- | --- | --- |
| 2026-11-28 | `IN_PROGRESS` | 用户选择方式 2，已完成 `26846f8` 和 `febfdcf`，用户选择发布 tag 为 `v0.1.3`。Ubuntu 已通过，Windows 浏览器验收失败，macOS 仍在运行。 | 保留 Windows runner 自带 Chrome 通道并重新等待三平台验收 |

## 用户验收

| 时间 | 结果 | 反馈 | 处理 |
| --- | --- | --- | --- |
|  | 待验收 |  |  |

## 验收通过后的清理

| 项目 | 内容 |
| --- | --- |
| 用户确认通过的交付提交 | 待填写 |
| 合并后验证 | 待填写 |
| worktree 清理时间 | 待填写 |
| 分支清理时间 | 待填写 |
