## Codex 与 DeepSeek Harness 协作

用户明确要求按 Codex + DSH 流程开发时，在本仓库根目录使用 `node scripts/ai-workflow.mjs start`。首次检出后先执行 `npm ci --prefix scripts`。DSH 升级或切换模型后，可用 `node scripts/ai-workflow.mjs check-model` 核对生效的提供方和模型。把原始需求作为 `--task` 或 `--task-file` 传入，用户指定的验收命令通过 `--check` 传入。仅讨论设计、查看进度或直接评审时，处理当前请求即可。

启动任务的 Codex 对话负责等待调度器退出。成功时报告任务书、评审结果、验证情况和本地提交号。失败时先查看调度器输出的工作区和本轮记录，从已完成的步骤排查。该入口仅由接到用户请求的对话启动。被调度的规划、实现和评审进程直接完成各自阶段。评审只维护 `.ai-workflow/runs/<id>/issues.json` 中的问题生命周期和简短结构化事件，不重复生成长篇报告。达到评审轮次、问题重开或停滞上限时必须进入人工仲裁，仲裁后用 `resume` 继续。
