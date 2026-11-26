# 历史版本保留、预览和恢复

2026-11-26 登记为 PLANNED，用户选择方式 2 后进入 IN_PROGRESS。基线 main `30405502a1abe4fbe0f735957b0329cbcfc60878`，分支 `codex/feature-note-history-20261126`，worktree 为 `/Users/weifei/code/we-note/.worktrees/note-history-20261126`。影响 server 和共享 Web 界面。

## 用户需求与验收条件

> 就实现前两条保留规则吧。不需要用户可以给重要版本命名并固定，直到主动取消。还有点击历史版本的时候使用弹窗吧。不要占用正文界面。在窗口里面可以点开查看每个版本的原文。可以点击恢复恢复至选中版本，界面你设计一下

- 每篇保留当前版本、最近十个旧版本以及含今天的三十个自然日中各日最后版本，两集合取并集。历史适用于存量和新增笔记，跨设备一致。
- 桌面弹窗左右分栏，手机在选中的原文和列表间切换；关闭回到原编辑模式并保留草稿。
- 按选定版本恢复生成新版本，保护未保存编辑、过期基准与只读访问。保留格式与原始字节。
- 保护分享、同步与图片引用；独立服务和 Web 产物从本 worktree 构建，按方式 2 交付。

## 验证计划

先运行 Go 保留规则回归及浏览器弹窗用例，验证失败后实现，运行服务测试、Web 构建和独立环境实测。

## 首轮交付与自审

- 2026-11-26 红阶段。`go test ./internal/store -run TestNoteHistoryRetention` 退出 1，列表返回 19 版，期望 13 版。`WENOTE_TEST_ORIGIN=http://localhost:18946 node apps/web/tests/phase1.mjs` 退出 1，原界面没有历史版本弹窗。
- 日期按 UTC+8 的自然日计算，与设备设置无关。当前版单列。后台在库有修改或跨日时重新计算保留集合，维护同步游标下界和幂等记录，分享与导出仍然引用的内容继续保留。已验证清理实际移除旧版本文件，保留分享原文，撤销分享后可回收，以及长期不编辑仍保留最近十个旧版本。
- 自审检查了新旧版本大小不同、已冻结分享、恢复请求重放、基准冲突和清理后的父版本信息。保留版本的原父版本 ID 可从创建事件读取；恢复使用库内原始内容引用。文本弹窗展示原文，二进制文件提供分页原始字节和下载。
- `services/api` 中 `go test ./...` 退出 0。同步模型 `node --test tests/protocol/sync-v1.test.mjs` 通过 98 项。`apps/web` 中 `node --test tests/*.test.mjs` 通过 12 项，`npm run build` 退出 0。
- 在最终独立实例上运行 `WENOTE_TEST_ORIGIN=http://localhost:18946 node apps/web/tests/phase1.mjs` 退出 0。Chrome 验证了草稿保护、Escape、桌面列表与原文、390 像素窄屏返回、恢复后编辑器显示选中原文，以及恢复前的内容仍可查看。桌面和窄屏实拍留在 `dist/local/history-dialog.png`、`dist/local/history-mobile.png`。

## 验收环境

从任务 worktree 执行 `./scripts/local.py start --port 18946`。地址 `http://localhost:18946`，PID 71270，健康检查 `curl -fsS http://localhost:18946/healthz` 返回 `{"status":"ok"}`。日志 `dist/local/server.log`，数据库及存储目录 `services/api/data`，Web 产物 `apps/web/dist`。验收结束后在同一工作区运行 `./scripts/local.py stop`。

使用 `dist/local/preview-login.txt` 内的试用账号登录，打开「历史版本验收 → 阅读清单.md → 更多操作 → 历史版本」。示例有三版，可选择第二版并点击「恢复此版本」，再打开历史查看恢复前的内容。方式 2，在独立分支等待用户验收。
