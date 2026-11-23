# Markdown 保存自动格式化

## 基本信息

| 字段 | 内容 |
| --- | --- |
| 任务 ID | `FEAT-20261123-markdown-save-format` |
| 类型 | `feature` |
| 登记日期 | `2026-11-23` |
| 影响端 | `web` / `desktop` / `android` |
| 状态 | `MERGED` |
| 基线分支 | `main` |
| 基线提交 | `9795a26c60f6fcff795e49434f019624715605f8` |
| 任务分支 | `codex/feature-markdown-save-format-20261123` |
| worktree | `/Users/weifei/.codex/worktrees/feature-markdown-save-format-20261123/we-note` |
| 需要独立服务端 | 网页端验收需要，格式化模块本身不需要 |

## 用户原始需求

> markdown 我想加一个保存自动格式化的功能，参考 https://github.com/Yaozhuwa/easy-typing-obsidian 对本地项目进行规划，有什么细节不确定的可以和我讨论

## 目标与范围

### 目标

- 在 Markdown 笔记保存前，根据可配置规则整理正文，网页、桌面和 Android 复用同一套行为。
- 保留现有 Markdown 扩展的语义和原始文件的 BOM、换行风格、附件链接与历史版本能力。
- 把格式化规则拆成可测试的纯函数，保存流程只负责应用结果并提交文件。

### 初步范围

- 增加 Markdown 设置项，控制是否启用“保存时自动格式化”。
- 在网页端云端保存和本地编辑器保存入口接入同一个 Markdown 格式化模块。
- 第一阶段优先支持保存时的文本排版规则，代码围栏、数学块、YAML Front Matter、链接目标和 HTML 属性等保护区域不参与普通文本格式化。
- 使用现有 Markdown 解析器和节点位置信息识别普通文本、行内代码、行内数学、链接、任务列表、引用和 Callout。
- 格式化发生变化时通过 CodeMirror 事务更新编辑器正文，保存后“已保存”状态、正文预览、后续编辑和撤销行为保持一致。
- 增加纯函数单元测试和网页端保存验收，覆盖云端和本地笔记库两个入口。

### 明确排除

- 第一阶段不实现 Easy Typing 的完整输入时规则引擎、自动配对、Tab 跳出、智能退格、自定义正则规则和代码块增强编辑。
- 第一阶段不默认执行全角半角标点转换、英文句首大写或会明显改变作者语气的标点改写。
- 第一阶段不新增服务端格式化接口，格式化结果由客户端在提交或写入本地目录前生成。
- 不在打开文件时自动改写并创建新版本。

## 参考项目提炼

参考项目 Easy Typing 的相关能力分为三层。

- 保存或快捷键触发的全文、选区和当前行格式化。
- 输入过程中的中英文、中文与数字间距，行内代码、公式和链接的间距，以及代码块、数学块和 Front Matter 保护。
- 独立的规则引擎、自定义正则规则和配对符号编辑增强。

本任务先采用第二层中的“文档级安全规则”，把输入过程增强和可编程规则留到后续任务。参考项目文档中的默认保护区域包括代码块、数学公式块和 Front Matter。外部参考项目为 [easy-typing-obsidian](https://github.com/Yaozhuwa/easy-typing-obsidian)。

## 推荐的第一阶段规则

以下规则作为实现讨论稿，最终以用户确认的范围为准。

- 中日韩文字与拉丁字母相邻时补一个普通空格。
- 中日韩文字与数字相邻时补一个普通空格。
- 数字与拉丁字母相邻时按统一规则处理，默认补一个普通空格。
- 普通文本与行内代码、行内数学、Markdown 链接或 Wiki 链接相邻时使用软空格规则。已有标点或空格时不重复插入。
- 删除普通文本行尾多余空格，保留 Markdown 硬换行所需的两个空格。
- 连续空白行、标题和列表的结构性空行是否整理，需要在范围确认后决定，避免和作者刻意留白冲突。
- 代码围栏内部、数学块内部、YAML Front Matter、链接 URL、HTML 标签属性和 Mermaid 代码内容保持原文。

所有规则都需要具备幂等性，连续保存两次得到相同正文。无法安全解析的正文保留原文并阻止格式化结果覆盖保存，界面给出可读错误信息。

## 现有代码入口

| 位置 | 当前职责 | 计划变化 |
| --- | --- | --- |
| [apps/web/src/markdown/document.ts](../../apps/web/src/markdown/document.ts) | Markdown 解析、GFM、数学、Front Matter、Callout 和 Wiki 链接识别 | 复用解析器或抽出安全区域识别能力 |
| [apps/web/src/markdown/Source.tsx](../../apps/web/src/markdown/Source.tsx) | CodeMirror 文本编辑器、正文同步和选区维护 | 接收保存格式化产生的文档变更，保留光标与撤销能力 |
| [apps/web/src/Editor.tsx](../../apps/web/src/Editor.tsx) | 网页端读取、编辑、云端保存和版本提交 | 在 `save()` 中调用共享格式化流程 |
| [apps/web/src/desktop.tsx](../../apps/web/src/desktop.tsx) | 桌面和 Android 本地目录读取、编辑和保存 | 在 `save()` 中调用同一共享格式化流程 |
| [apps/web/src/preferences.ts](../../apps/web/src/preferences.ts) | Markdown 设置归一化、本地与远端设置 | 增加格式化开关和规则配置的兼容默认值 |
| [apps/web/src/markdown/Settings.tsx](../../apps/web/src/markdown/Settings.tsx) | Markdown 插件设置界面 | 增加保存格式化开关和后续规则选项 |
| [apps/web/tests/phase4.mjs](../../apps/web/tests/phase4.mjs) | 网页端插件设置和编辑器验收 | 增加保存后正文与保护区域断言 |

## 建议的实现结构

1. 先创建 `markdown/saveFormat.ts` 之类的纯格式化模块，输入 Markdown 字符串和规则配置，输出正文、变更信息和可选诊断。
2. 先为保护区域和代表性文本样本写失败测试，再实现最小的扫描与替换逻辑。
3. 使用 AST 节点位置和必要的词法扫描限定替换范围，不通过“先渲染再序列化”重建全文，避免丢失未知语法、缩进和作者原始布局。
4. 保存前以 CodeMirror 变更应用格式化结果，更新 `TextFile` 的规范化正文，再提交序列化字节。
5. 统一网页端与本地编辑器的保存状态更新，确保格式化后的正文成为新的已保存基准，避免保存按钮继续显示脏状态。
6. 增加配置归一化、旧设置兼容、桌面本地保存和网页云端保存的回归验收。

## 待讨论决策

### 触发时机

- 已确认只在用户点击“保存”或按 `Ctrl/Cmd+S` 时执行。
- 桌面端定时同步不触发格式化。
- 第一阶段不增加独立的“格式化并保存”命令。

### 默认规则

- 已确认中英文间距、中文与数字间距、数字与英文间距默认开启。
- 已确认清理普通行尾多余空格，同时保留 Markdown 硬换行所需的两个空格。
- 已确认整理结构性空行。具体空行规则写入测试样例。
- 已确认第一阶段暂不转换中文标点。

### 保护范围

- 代码围栏、数学块、Front Matter、行内代码、行内数学、Markdown 链接、图片、URL、HTML 标签和 Wiki 链接整体保持原文。
- Mermaid 围栏按普通代码围栏保护。
- 表格单元格和 Callout 正文中的普通文字按普通文本处理。

### 保存与撤销

- 已确认格式化作为一次 CodeMirror 事务，支持一次撤销恢复。
- 已确认格式化失败时阻止本次保存并显示错误。
- 格式化完成后的保存提示沿用现有保存提示，是否补充“已自动格式化”由实现阶段根据现有交互决定。

## 验收条件

- [x] Markdown 设置中可以启用或关闭保存时自动格式化，旧用户设置可正常归一化。
- [x] 只有点击保存或按 `Ctrl/Cmd+S` 时触发格式化。
- [x] 网页端显式保存触发格式化，保存到服务端的正文与编辑器正文一致。
- [ ] 桌面和 Android 本地编辑器显式保存触发同一格式化结果，桌面入口已完成构建验证，运行时待用户验收。
- [x] 中英文、中文与数字的默认规则按确认后的样例生效，并且重复保存结果稳定。
- [x] 普通行尾空格和连续空行按确认规则整理，Markdown 硬换行的两个空格保留。
- [x] 第一阶段不转换标点。
- [x] 代码块、数学块、Front Matter、链接 URL、HTML 属性和 Mermaid 内容保持保护规则要求的原文。
- [ ] BOM、CRLF 或原始换行风格、附件链接和 Wiki 链接的跨端运行时验收待用户确认，格式化接入沿用现有 `TextFile` 序列化。
- [x] 格式化失败会在提交请求前中断保存，并由现有错误提示处理。格式化后的保存状态、预览和一次撤销已通过 Web 验收，光标与继续输入行为待用户验收。
- [x] 格式化模块的单元测试、网页端构建和受影响的端到端验收通过。
- [x] `git diff --check` 通过，任务记录包含真实命令和退出状态。

## 实现计划

1. 已确认触发时机、默认规则、空行处理、保护范围和错误处理策略。
2. 已创建任务 worktree 和 `codex/feature-markdown-save-format-20261123` 分支，并补充账本和任务记录中的基线信息。
3. 编写保护区域、间距、幂等性和行尾处理的失败测试。
4. 实现共享格式化模块，接入网页端和本地编辑器的保存流程。
5. 增加设置 UI、设置持久化和网页端保存验收。
6. 运行构建、聚焦测试、端到端测试和人工验收，完成自我验收后交付用户确认。

## TDD 证据

### 失败测试

| 时间 | 命令 | 退出状态 | 失败原因 |
| --- | --- | --- | --- |
| 2026-11-23 | `node --experimental-strip-types --test apps/web/tests/markdown-save-format.test.mjs` | 1 | 新增 Front Matter 后尾随空格回归测试先失败，暴露了按全文偏移截取当前行的错误。 |

### 通过测试

| 时间 | 命令 | 退出状态 | 关键结果 |
| --- | --- | --- | --- |
| 2026-11-23 | `node --experimental-strip-types --test apps/web/tests/markdown-save-format.test.mjs` | 0 | 5 个格式化单元测试通过，覆盖间距、保护范围、尾随空格、空行和幂等性。 |
| 2026-11-23 | `go build -mod=readonly -o ../../runtime/wenote-api ./cmd/wenote-api`（工作目录 `services/api`） | 0 | 独立验收服务端构建完成。 |
| 2026-11-23 | `npm run build --prefix apps/web` | 0 | Web 客户端类型检查和生产构建通过。 |
| 2026-11-23 | `npm run build:desktop --prefix apps/web` | 0 | 桌面客户端类型检查和构建通过，产物位于 `apps/client/dist`。 |
| 2026-11-23 | `WENOTE_TEST_ORIGIN=http://127.0.0.1:59321 node apps/web/tests/phase4.mjs` | 0 | 阶段四浏览器验收通过，覆盖默认设置、云端保存格式化、保护区域、一次撤销和现有功能回归。 |
| 2026-11-23 | `git diff --check` | 0 | 差异空白检查通过。 |

### 变更检查

- [x] `git diff --check`
- [x] 影响模块回归测试
- [x] 网页端构建
- [x] 网页端云端保存验收
- [ ] 桌面或 Android 本地保存人工验收

## 独立服务端

| 项目 | 内容 |
| --- | --- |
| 启动命令 | `runtime/wenote-api -addr 127.0.0.1:59321 -db runtime/wenote.db -blobs runtime/storage -web-dir apps/web/dist` |
| 地址和端口 | `http://127.0.0.1:59321` |
| PID | PTY 会话 `52860`，已于 2026-11-23 停止 |
| 日志 | PTY 标准输出，启动信息为 `WeNote API listening on 127.0.0.1:59321` |
| 数据目录 | `runtime/wenote.db` 和 `runtime/storage` |
| 测试账户或初始化步骤 | 阶段四脚本使用随机邮箱注册账户并创建“插件验收”库 |
| 停止命令 | 在 PTY 会话 `52860` 发送 `Ctrl-C` |

## 客户端交付

| 项目 | 内容 |
| --- | --- |
| 构建命令 | `npm run build --prefix apps/web`，`npm run build:desktop --prefix apps/web` |
| 启动或安装命令 | Web 使用独立 API 服务地址打开浏览器，桌面构建产物可从 `apps/client/dist` 启动 |
| 产物路径 | `apps/web/dist`，`apps/client/dist` |
| 使用的服务端地址 | `http://127.0.0.1:59321` |
| 已验证功能 | Web 设置默认值、显式保存格式化、保护 Markdown 区域、一次撤销和阶段四回归。桌面入口已完成构建验证，Android 本地运行尚未在当前环境启动。 |

## 状态变更记录

| 时间 | 状态 | 依据 | 下一步 |
| --- | --- | --- | --- |
| 2026-11-23 | `PLANNED` | 需求已归类，已完成现有保存链路和参考项目调研 | 用户确认规则 |
| 2026-11-23 | `IN_PROGRESS` | 用户确认 7 项范围，已创建任务 worktree 和分支 | 编写失败测试并实现格式化模块 |
| 2026-11-23 | `DELIVERED` | 自我验收通过，Web、桌面构建和阶段四浏览器验收完成 | 用户验收 |
| 2026-11-23 | `ACCEPTED` | 用户确认验收通过 | 合并到 `main`，更新账本并清理任务 worktree 与分支 |
| 2026-11-23 | `MERGED` | 合并提交 `73f018a`，合并后单测和 Web/Desktop 构建通过 | 任务完成 |

## 用户验收

| 时间 | 结果 | 反馈 | 处理 |
| --- | --- | --- | --- |
| 2026-11-23 | 已验收 | 用户确认 Web、桌面构建和保存格式化功能通过验收 | 合并到 `main` 后记录最终提交和清理结果 |

## 合并与清理

| 项目 | 内容 |
| --- | --- |
| 合并提交 | `73f018a`（`feat(markdown): format on explicit save`） |
| 合并后验证 | `node --experimental-strip-types --test apps/web/tests/markdown-save-format.test.mjs`、`npm run build --prefix apps/web`、`npm run build:desktop --prefix apps/web`、`git diff --check`，均退出状态 0 |
| worktree 清理时间 | 2026-11-23 |
| 分支清理时间 | 2026-11-23 |
