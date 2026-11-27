# 笔记助手 UI 优化

| 字段 | 内容 |
| --- | --- |
| 类型与状态 | `feature` · `DELIVERED` · 2026-11-27 |
| 影响端 | Web、桌面、Android、iOS 共用的客户端助手与原生模型传输 |
| 本轮交付 | 任务分支实现 `20530db`，等待用户验收 |
| 开发验收方式 | 用户已选 2，在任务分支验收，通过后合入本地 `main` |
| 基线与分支 | `main@37449f3` → `codex/feature-assistant-chat-ui-20261127` |
| worktree | `/Users/weifei/.codex/worktrees/assistant-chat-ui-20261127/we-note` |
| 服务端 | 模型请求由客户端发出，无服务端开发需求 |

## 用户需求及变更

> 关于个人助手的ui优化，我希望使用 ant design x 这个库来优化个人助手页面。我希望模型地址与key的配置挪到个人助手右上角的设置中，弹出窗口设置url与key。然后模型选择在聊天框附近，注意是否需要加推理等级，模型的获取通过url自动获取吧。然后就是ui看看是否可以使用 ant design x

2026-11-27 用户补充「先写文档，另外可以参考doc中的ui优化文档」。本轮在任务分支编写需求草案，用户确认文档后再提交本轮已确认的内容。

2026-11-27 用户提出核验 Sub2API 的模型与推理等级，并了解其他协议如何发现能力。修订验收条件：保留基础模型目录，以同服务扩展目录按模型 ID 补全档位。选择有效等级时按协议传值，信息缺失或切换后失效时回到服务默认。Claude 和 Gemini 原生协议作为调研参考。

2026-11-27 用户将首版限定为 OpenAI 兼容协议。设置和验收仅覆盖 Responses 与 Chat Completions，包含 Sub2API 的模型目录和可选推理等级。Anthropic 与 Gemini 原生协议退出本轮范围。

## 范围和验收依据

设置弹窗、输入区模型选择、目录异常恢复、推理等级取舍、现有助手流程和跨端验收均以[笔记助手 UI 优化设计](../笔记助手UI优化设计.md)为准。界面组件采用笔记库共享主题，聊天及工具调用复用 Pi。用户确认开始实施。功能实施时先按设计中的验收路径编写失败测试，再从此 worktree 构建客户端并记录真实验证结果和验收入口。

## 实施记录

用户确认开始，按方式 2 在本分支实施。计划运行目录与协议单测、原生传输测试、助手浏览器回归及 Web 和桌面构建，使用独立本地实例验收。

## 模型目录客户端版本

按设备本地日期，每天首次启动 Web 或本地笔记客户端时，从 npm 的 `@openai/codex` 稳定发布标签读取版本。当天重复启动复用缓存，获取失败时使用上次版本，首次离线使用已验证的内置版本。普通目录独立加载，扩展目录使用当次确认的版本。验收覆盖跨日、重复启动、超时及异常版本。

## 首次交付 · 2026-11-27

方式 2，受测提交 `569b41b`。网页 `http://localhost:19469`，PID 46537。日志 `dist/local/server.log`，数据 `services/api/data`。在本实例注册普通账号、创建库并展开笔记助手，设置服务地址后选模型和推理等级。验收期间保留工作区和服务，清理时运行 `./scripts/local.py stop`。

- 红阶段新增目录合并、协议字段及每日版本单测，各自首次运行退出 1，缺少目标模块。实现后 `node --test apps/web/tests/assistant*.test.mjs apps/web/tests/{mcp-tools,web-build-history}.test.mjs` 退出 0，共 12 项。`cargo test --manifest-path apps/client/src-tauri/Cargo.toml --lib model::tests` 退出 0，共 2 项。
- `npm --prefix apps/web run build`、`WENOTE_API=dist/local/wenote-api node tests/e2e/desktop.mjs --browser` 均退出 0。在独立验收页单独运行 `assistant-browser.mjs` 和 `assistant-credentials.mjs` 也通过。受控网关核对了目录使用的版本、两个协议的 ultra 字段和当前页面密钥。Chrome 在 1280px 浅色和 390px 深色验证弹窗、草稿和发送按钮位置，真实启动更新到 0.172.0。
- 在 `apps/client` 执行 `./node_modules/.bin/tauri build --debug --bundles app --config '{"bundle":{"active":true}}'` 退出 0，产物 `target/debug/bundle/macos/WeNote.app`。手机交互通过浏览器窄屏验证，本轮未做 Android/iOS 真机测试。
- 自审修正切换服务时旧目录短暂参与自动选择的问题，并核对多窗口同日更新、离线回退和失败后的草稿恢复。`git diff --cached --check` 退出 0。

## 2026-11-27 · 对话体验补充设计（用户已确认）

用户希望详细参考 Ant Design X 的通用、表达、思考过程和反馈组件，评估如何调整现有聊天。沿用方式 2。本轮产出组件取舍和使用示例数据的交互样稿，功能验收版本仍为 `569b41b`。设计评审可检查摘要和工具进度各自的来源、草稿到确认的状态、反馈的作用域，以及窄栏中输入区的可用性。[交互设计](../笔记助手UI优化设计.md#用-ant-design-x-调整一轮笔记对话)

样稿反馈：三个场景的输入框底部都需要模型选择和推理等级选择。示例验收覆盖切换模型后回到对应默认等级、切换前后的草稿以及窄屏发送按钮。

按用户截图修订样稿：输入区合并为「模型 · 推理等级」单入口。打开先列模型，选定后在同一浮层显示该模型的分档滑杆。验收切换、返回模型列表、恢复默认、外部点击及窄屏布局。

2026-11-27 用户确认按最终样稿实施。验收涵盖模型与等级的两步浮层、单气泡流式输出、服务公开摘要、实际工具步骤与已读来源、逐条反馈、空状态和历史导航。继续以方式 2 交付。

## 对话与模型选择器交付 · 2026-11-27

受测提交 `20530db`。本机验收页 `http://localhost:19469`，PID 62494，日志 `dist/local/server.log`，任务库数据 `services/api/data`。可用本实例账号登录，或注册普通账号并新建笔记库。桌面构建位于 `target/debug/bundle/macos/WeNote.app`。验收采用方式 2，确认通过后合入本地 `main` 并用 `./scripts/local.py stop` 清理本实例。

1. 打开笔记助手，在右上角设置中保存 OpenAI 兼容服务地址和可选 Key。在输入框写草稿后打开底部按钮，依次选模型和滑杆档位。点击浮层模型名可返回，右上角可恢复默认。检查按钮回显与草稿。无档位的模型可直接发消息。
2. 在新会话点一个建议，检查草稿与焦点。输入 `@` 引用一篇笔记，发送总结请求，从「本轮读取」打开文件。回复生成中可向上滚动或停止；公开摘要可展开。复制、评价或编辑原问题后可从历史切回对话。
3. 请求创建或修改笔记，核对起草内容、目标路径和操作回执。点「放弃」应保留原文，点「应用修改」只保存一次。

旧构建运行更新后的浏览器回归在模型列表选择处失败。补齐实现后，自审核对了逐轮气泡、公开摘要的增量和最终事件去重、反馈的本机作用域和工具回执。手机截图发现全局输入框背景遮住滑杆，新增明暗主题断言复现，修正后复测通过。

- `node --test apps/web/tests/assistant*.test.mjs apps/web/tests/{mcp-tools,web-build-history}.test.mjs` 通过 14 项，`cargo test --manifest-path apps/client/src-tauri/Cargo.toml --lib model::tests` 通过 2 项。
- `npm --prefix apps/web run build`、`WENOTE_API=dist/local/wenote-api node tests/e2e/desktop.mjs --browser` 和桌面 `tauri build --debug --bundles app` 均退出 0。浏览器使用受控网关核对两种协议的出站等级、流式摘要、停止起草、已读来源、反馈恢复、待确认修改、历史草稿以及 390px 宽的滑杆和发送按钮。`git diff --cached --check` 通过。
- 手机在浏览器窄屏验证。Android SDK 目录为空，本轮未构建手机安装包或进行 Android、iOS 真机验证。
