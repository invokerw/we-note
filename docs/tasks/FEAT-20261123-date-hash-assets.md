# WeNote 任务记录

## 基本信息

| 字段 | 内容 |
| --- | --- |
| 任务 ID | `FEAT-20261123-date-hash-assets` |
| 类型 | `feature` |
| 登记日期 | `2026-11-23` |
| 影响端 | `all` |
| 状态 | `DELIVERED` |
| 基线分支 | `main` |
| 基线提交 | `9795a26` |
| 任务分支 | `codex/feature-date-hash-assets-20261123` |
| worktree | `/Users/weifei/.codex/worktrees/feature-date-hash-assets/we-note` |
| 需要独立服务端 | 否，先通过 API 单元测试和构建验收 |

## 用户原始需求

导出的图片url我希望加上日期，比如说 [https://localhost:8443/assets/2026/11/23/2c1adc268dafcda9d12fca50887e8f91](https://localhost:8443/assets/2026/11/23/2c1adc268dafcda9d12fca50887e8f91) 这样的。我希望文件保存的路径也是 日期目录和hash

## 目标与范围

### 目标

- 附件的 canonical URL 使用 `/assets/YYYY/MM/DD/<hash>` 格式。
- 本地 Blob 和 S3 Blob 使用日期目录与内容哈希作为对象路径。
- 旧的 Asset ID URL 和已有 Blob 存储键继续可读，避免已有笔记和历史数据失效。

### 范围

- 服务端 Asset URL 生成、解析、访问和引用校验。
- 本地文件系统与 S3 Blob 存储键。
- Web 分享预览和 Rust 客户端对新 Asset URL 的读取。
- 相关 API、存储和回归测试及接口说明。

### 明确排除

- 不改变数据库中的 SHA-256 内容校验格式。
- 不迁移已经存在的 Blob 文件，已有数据库 `storage_key` 继续作为读取依据。

## 验收条件

- [x] 新建附件返回的 `canonical_url` 包含 UTC 日期目录和内容哈希。
- [x] 新建附件写入的本地文件路径包含 Vault、日期目录和内容哈希。
- [x] 新 URL 可以完成附件访问和正文引用校验。
- [x] 旧 Asset ID URL 和已有旧存储键仍可读取。
- [x] Web、Rust 客户端和导出相关测试通过。

## 实现计划

1. 先补充日期哈希 URL 与存储路径的失败测试。
2. 修改 Blob 接口、数据库读取和 Asset 路由，接入日期目录和内容哈希。
3. 更新客户端、文档和回归测试，执行 Go、Rust、Web 构建与差异检查。

## TDD 证据

### 失败测试

| 时间 | 命令 | 退出状态 | 失败原因 |
| --- | --- | --- | --- |
| 2026-11-23 | `go test ./internal/blob ./internal/store` | 1 | 新增测试先于实现运行，缺少 `PutAt` 和 `canonicalAssetURL`。 |
| 2026-11-23 | `cargo test -p wenote-sync-core` | 127 | 初次执行时包名错误且此前环境没有 Cargo 工具链。 |

### 通过测试

| 时间 | 命令 | 退出状态 | 关键结果 |
| --- | --- | --- | --- |
| 2026-11-23 | `go test ./internal/httpapi -run TestMultipartResumeAcrossRestart -count=1 -timeout 30s -v` | 0 | 新 URL 访问、旧 URL 访问和日期存储键断言通过。 |
| 2026-11-23 | `go test ./... -timeout 120s`（`services/api`） | 0 | API、Blob、数据库、导出、分享和同步测试全部通过。 |
| 2026-11-23 | `npm ci --prefix apps/web && npm run build --prefix apps/web` | 0 | TypeScript 检查和 Vite 生产构建通过。 |
| 2026-11-23 | `git diff --check` | 0 | 差异无空白错误。 |
| 2026-11-23 | `cargo test --locked -p wenote-sync` | 0 | Rust 同步核心编译和单元测试通过，1 个需要 API 服务的端到端测试按设计忽略。 |

### 变更检查

- [x] `git diff --check`
- [x] 影响模块回归测试
- [x] 需要时完成协议、端到端或构建验收

## 独立服务端

| 项目 | 内容 |
| --- | --- |
| 启动命令 | 不适用 |
| 地址和端口 | 不适用 |
| PID | 不适用 |
| 日志 | 不适用 |
| 数据目录 | 不适用 |
| 测试账户或初始化步骤 | 使用 Go 测试夹具 |
| 停止命令 | 不适用 |

## 客户端交付

| 项目 | 内容 |
| --- | --- |
| 构建命令 | `npm run build --prefix apps/web` |
| 启动或安装命令 | 未启动独立服务，使用 API 测试夹具验收 |
| 产物路径 | `/Users/weifei/.codex/worktrees/feature-date-hash-assets/we-note/apps/web/dist` |
| 使用的服务端地址 | 测试使用内存数据库和临时 Blob 目录 |
| 已验证功能 | 日期哈希 URL、附件读取、旧 URL 兼容、导出和正文引用校验 |

## 状态变更记录

| 时间 | 状态 | 依据 | 下一步 |
| --- | --- | --- | --- |
| 2026-11-23 | `IN_PROGRESS` | 需求已登记，已创建独立 worktree 和任务分支 | 完成 TDD 开发和自我验收 |
| 2026-11-23 | `DELIVERED` | Go 全量测试、Web 构建、Rust 同步核心测试和差异检查通过 | 等待用户验收 |

## 用户验收

| 时间 | 结果 | 反馈 | 处理 |
| --- | --- | --- | --- |
| 2026-11-23 | 已验收 | 用户确认验收完成。 | 允许合回基线并清理任务分支。 |

## 合并与清理

| 项目 | 内容 |
| --- | --- |
| 合并提交 | 待填写 |
| 合并后验证 | 待填写 |
| worktree 清理时间 | 待填写 |
| 分支清理时间 | 待填写 |
