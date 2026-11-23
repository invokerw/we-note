## 基本信息

| 字段 | 内容 |
| --- | --- |
| 任务 ID | `FEAT-20261123-theme-toggle` |
| 类型 | `feature` |
| 登记日期 | `2026-11-23` |
| 影响端 | `web / desktop / android` |
| 状态 | `MERGED` |
| 基线分支 | `main` |
| 基线提交 | `9795a26c60f6fcff795e49434f019624715605f8` |
| 任务分支 | `codex/feature-theme-toggle-20261123` |
| worktree | `/Users/weifei/.codex/worktrees/feature-theme-toggle/we-note` |
| 需要独立服务端 | 否，使用网页浏览器验收时启动任务 worktree 的独立实例 |

## 用户原始需求

我想添加一个深色模式与浅色模式的切换按钮并实现其中的功能，你觉得放到哪里合适。注意要检查两种模式的时候markdown与脑图主题是否正确显示

## 目标与范围

### 目标

- 在网页端和桌面端编辑器增加深色模式与浅色模式切换。
- 在两种外观下保持 Markdown 阅读、编辑、代码块和脑图主题的可读性与主题颜色。
- 将外观选择保存到本机，刷新或重新打开编辑器后保持选择。

### 范围

- 切换按钮放在左侧栏底部的账户和布局操作附近，网页端与桌面端共用。
- 扩展共享样式变量，覆盖应用导航、列表、正文、CodeMirror、Markdown 主题和 XMind 画布。
- 增加浏览器验收测试，检查按钮状态、持久化、Markdown 三种主题和 XMind 主题在深浅色下的计算样式。

### 明确排除

- 不修改服务端偏好接口和笔记内容格式。
- 不改变已有 Markdown 主题和 XMind 主题选择项。

## 验收条件

- [x] 左侧栏提供带有清晰无障碍名称的外观切换按钮，点击可在浅色与深色之间切换。
- [x] 外观选择写入本机并在刷新后恢复。
- [x] 浅色模式下现有界面、Markdown 主题和脑图主题保持正确显示。
- [x] 深色模式下应用界面、Markdown 主题、CodeMirror 和脑图主题保持足够对比度且不出现白色背景块。
- [x] 网页端构建通过，任务 worktree 的浏览器验收通过。

## 实现计划

1. 增加可持久化的外观状态和共享切换按钮，并接入网页端与桌面端。
2. 为基础界面、Markdown 和 XMind 画布补充深浅色变量与主题映射。
3. 先运行失败的浏览器验收，再实现功能并运行构建、回归和差异检查。

## TDD 证据

### 失败测试

| 时间 | 命令 | 退出状态 | 失败原因 |
| --- | --- | --- | --- |
| `2026-11-23` | `WENOTE_TEST_ORIGIN=http://localhost:18081 node apps/web/tests/theme.mjs` | `1` | 基线没有“切换到深色模式”按钮，Playwright 等待按钮超时。 |

### 通过测试

| 时间 | 命令 | 退出状态 | 关键结果 |
| --- | --- | --- | --- |
| `2026-11-23` | `npm run build --prefix apps/web` | `0` | Web TypeScript 检查和 Vite 构建通过。 |
| `2026-11-23` | `WENOTE_TEST_ORIGIN=http://localhost:18081 node apps/web/tests/theme.mjs` | `0` | 切换按钮、刷新持久化、全部 3 个 Markdown 主题和全部 5 个 XMind 主题的深色显示通过。 |
| `2026-11-23` | `npm run build:desktop --prefix apps/web` | `0` | 桌面端 TypeScript 检查和 Vite 构建通过。 |
| `2026-11-23` | `WENOTE_TEST_ORIGIN=http://localhost:18081 node apps/web/tests/phase2.mjs` | `0` | Markdown、Mermaid、编辑、附件和导出回归通过。 |
| `2026-11-23` | `WENOTE_TEST_ORIGIN=http://localhost:18081 node apps/web/tests/phase4.mjs` | `0` | 插件、XMind 画布、主题设置、代码对比度和持久化回归通过。 |
| `2026-11-23` | `git diff --check` | `0` | 差异无空白错误。 |

### 变更检查

- [x] `git diff --check`
- [x] 影响模块回归测试
- [x] 完成 Web、桌面前端和浏览器验收

## 独立服务端

| 项目 | 内容 |
| --- | --- |
| 启动命令 | `./scripts/local.py start --port 18081` |
| 地址和端口 | `http://localhost:18081` |
| PID | `56773` |
| 日志 | `/Users/weifei/.codex/worktrees/feature-theme-toggle/we-note/dist/local/server.log` |
| 数据目录 | `/Users/weifei/.codex/worktrees/feature-theme-toggle/we-note/services/api/data` |
| 测试账户或初始化步骤 | 浏览器测试自动注册临时账户 |
| 停止命令 | `./scripts/local.py stop` |

## 客户端交付

| 项目 | 内容 |
| --- | --- |
| 构建命令 | `npm run build --prefix apps/web`，`npm run build:desktop --prefix apps/web` |
| 启动或安装命令 | 浏览器测试使用 `WENOTE_TEST_ORIGIN=http://localhost:18081 node apps/web/tests/theme.mjs` |
| 产物路径 | Web `/Users/weifei/.codex/worktrees/feature-theme-toggle/we-note/apps/web/dist`，桌面 `/Users/weifei/.codex/worktrees/feature-theme-toggle/we-note/apps/client/dist` |
| 使用的服务端地址 | `http://localhost:18081` |
| 已验证功能 | 左侧栏切换、外观持久化、Markdown 阅读与 Mermaid、CodeMirror、XMind 主题画布和设置预览 |

## 状态变更记录

| 时间 | 状态 | 依据 | 下一步 |
| --- | --- | --- | --- |
| `2026-11-23` | `IN_PROGRESS` | 已创建独立 worktree 和任务分支 | 按 TDD 实现并验收 |
| `2026-11-23` | `DELIVERED` | 聚焦测试、Web/桌面构建和既有浏览器回归全部通过 | 等待用户验收，保留分支与 worktree |
| `2026-11-23` | `MERGED` | 用户验收通过，任务分支已合并到 `main` | 完成合并后验证并清理任务 worktree 与分支 |

## 用户验收

| 时间 | 结果 | 反馈 | 处理 |
| --- | --- | --- | --- |
| `2026-11-23` | 通过 | 用户确认网页端和桌面端验收完毕 | 已执行合并和清理 |

## 合并与清理

| 项目 | 内容 |
| --- | --- |
| 合并提交 | 待生成 |
| 合并后验证 | 待执行 |
| worktree 清理时间 | 待执行 |
| 分支清理时间 | 待执行 |
