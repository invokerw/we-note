# Mantine AppShell 工作区设计文档交付

| 字段 | 内容 |
| --- | --- |
| 类型与影响端 | `docs` · Web、桌面、Android |
| 基线 | 本地 `main` · `722fae3` |
| 分支 | `codex/docs-mantine-workspace-20261124` |
| worktree | `.worktrees/mantine-workspace` |
| 状态 | `CHANGES_REQUESTED` |

## 需求与验收

用户选定 Mantine AppShell，希望获得一份可以先评审的 WeNote 详细设计文档。交付中文 Markdown 及配图，覆盖现有信息架构、桌面与手机布局、编辑及跨端差异、交互状态、组件迁移和验收场景。本轮交付物是设计稿，客户端实现属于后续开发任务。

## 验证与交付

2026-11-24 已登记。从任务 worktree 验证文档内的本地引用、配图与章节，自审完整差异并运行 `git diff --check`。文档交付使用仓库文件作为验收入口，无需运行独立服务。

### 首轮检查

- 登记后执行 `test -s docs/笔记工作区设计.md`，退出 1，当时设计文件尚未建立。
- 完稿后在任务工作区运行临时 Python 检查脚本 `verify.py`，退出 0。确认 8 节设计、17 个本地文件引用及两张可解码的配图。官方组件说明书链接列于设计正文。
- 自审时对照 `LibraryUI.tsx` 的实际快捷键、`PhoneUI.tsx` 的系统返回处理、`desktop.tsx` 的本地保存，以及 Rust `catalog` 的联网路径。修正草稿离开动作的表述，重绘示意图中缺失的菜单箭头，目视检查两张最终配图。`git diff --check` 退出 0。
- 交付入口为[笔记工作区设计](../笔记工作区设计.md)。按本文前两节审阅桌面和手机流程，再核对跨端功能及验收场景。

2026-11-24 `DELIVERED`。设计提交 `1acd78b` 已快进合入本地 `main`，`git merge-base --is-ancestor 1acd78b main` 退出 0。保留分支和 worktree 供用户评审及返工。

## 第二轮 · 根据有道云笔记调整主题

2026-11-24 `CHANGES_REQUESTED`。用户认为初稿色调冷清，要求参考有道云笔记重新设计主题。沿用原任务工作区，以 `1bb84ee` 为本轮基线。评审稿需给出参考依据、浅深色用途、桌面与手机视觉效果，并验证关键文字与交互状态的对比度。

检查旧稿 `rg -q '暖杏' docs/笔记工作区设计.md` 退出 1。核对有道 Mac App Store 官方截图后重绘三张 WeNote 工作区示意图，分别展示桌面日间、手机流程、桌面夜间。自审核对两套主题的按钮前景色、选中项和文档所列色值，并逐张检查中文文字和面板边界。`python3 contrast.py` 退出 0，两套主题共 12 组前景背景对比均超过 4.5∶1。临时文档检查 `verify-theme.py` 退出 0，检查 8 节设计、18 个本地引用和 3 张 PNG。`git diff --check` 退出 0。
