# 笔记库与图片存储设计文档任务

| 字段 | 内容 |
| --- | --- |
| 任务 ID / 类型 | `DOCS-20261125-vault-note-images` / `docs` |
| 开工日期 / 状态 | 2026-11-25 / `DELIVERED` |
| 验收方式 | 2 · 在任务分支审文档，通过后合入 |
| 基线 | `main` · `519f7c1c537729d4f0ccae0aecb1be8ca2c8ba07` |
| 分支 | `codex/docs-vault-note-images-20261125` |
| worktree | `/Users/weifei/.codex/worktrees/docs-vault-note-images-20261125/we-note` |
| 影响端 | server / web / desktop / android |

## 范围与验收条件

交付[笔记库与图片存储设计](../笔记库与图片存储设计.md)。用户要求按库归集笔记与图片，移除独立附件能力，图片含用户、笔记、日期和哈希，使用 GM 笔记存储位置。所有数据经 `addr` 读取，Markdown 使用映射到 `addr` 的 `public-url`。用户先审核设计，再进入实现。

审核时对照示例检查 URL 和存储路径，核对历史数据、协作权限和跨端行为，确认文末待定项。此轮交付为 Markdown 文档，验证相对链接、格式和修改范围。文档处于任务分支时保留 worktree。

## 状态记录

- 2026-11-25 · `IN_PROGRESS`，从本地 main 建立设计分支，登记审核范围。

- 2026-11-25 · `DELIVERED`，自审后补入库清单与按修订恢复规则。使用 `python3` 核对设计稿及任务登记的 10 条相对链接，退出 0。文档差异用 `git diff --cached --check` 验证。审核入口为上方设计稿，提交可用 `git log -1 -- docs/笔记库与图片存储设计.md` 查询。等待用户审核设计。
