# 用 Codex 和 DeepSeek Harness 完成一次开发任务

在 WeNote 的 Codex 对话中描述需求并说“用仓库的 AI 协作流程执行，评审通过后本地提交”，或者在仓库根目录运行以下命令。首次使用先按下文“配置与验证”安装脚本依赖。调度器调用本机 Codex CLI 执行规划和评审，每次评审使用独立会话。上下文通过原始需求、任务书、Git 差异和测试结果传递。

```sh
node scripts/ai-workflow.mjs start --slug asset-url \
  --task '根据产品设计写出稳定 Asset URL 的协议示例，覆盖附件重命名后旧 URL 仍可用的情况。'
```

## 从需求到提交

1. 调度器从当前 `HEAD` 新建 `codex/<任务名>-<标识>` 分支和独立 Git worktree。当前目录里的未提交文件不进入任务。已有设计、代码和测试应位于基线提交中。
2. Codex 以只读模式检查仓库，输出目标、边界、验收标准和测试方法。调度器将任务书保存为 `docs/tasks/<任务名>-<标识>.md`。如果 Codex 指出需要产品决策，流程停在规划阶段。
3. `dsh --profile headless` 在任务工作区编写代码并运行测试。每轮提交说明包含实际执行的命令和结果。实现者只获得工作区写权限。调度器检查任务书、分支和基线是否仍然一致。
4. 调度器运行调用方指定的验收命令，暂存候选变更，并运行 `git diff --cached --check`。Codex 只读评审完整暂存差异，按任务书核对实现。发现问题时，下一轮 DSH 收到具体反馈，在原工作区继续修改。验收命令失败也会把输出交回 DSH。
5. Codex 返回结构化 `PASS` 后，调度器核对 Git 树并创建本地提交。提交包含任务书和实现。终端会显示分支名和提交号。合并及推送由任务发起者决定。

## 配置与验证

需要 Node.js 20 或以上、npm、Git、本机可用的 Codex CLI，以及支持 `headless` 和 `--patch` 的 DSH。在这台 Mac 上，脚本能直接找到 DeepSeek Harness 桌面应用附带的 CLI。`CODEX_BIN` 和 `DSH_BIN` 可指定其他可执行文件的绝对路径。

首次检出后，在仓库根目录安装脚本的 YAML 解析依赖，再核对模型。升级 DSH 或在桌面端切换默认模型后，重新执行第二条命令即可。

```sh
npm ci --prefix scripts
node scripts/ai-workflow.mjs check-model
```

`check-model` 用实际 DSH 的 `--dump-config` 组合配置，显示生效的提供方和模型。它可以离线运行。模型端点连通性和凭据有效性要到实际调用时才能确认。

本机已用 DSH `0.2.2-rc.5` 验证。原生 headless 使用独立的模型和凭据配置。调度器在 `start` 和 `check-model` 中可用 `--dsh-model-source` 指定模型来源。

| 取值 | 行为 |
| --- | --- |
| `auto`（默认） | 优先使用桌面端显式保存的默认模型。桌面配置文件或模型选择缺失时，使用原生 headless 配置。 |
| `desktop` | 要求桌面端已保存默认模型。适合需要固定走桌面配置的任务，缺少选择时会在创建任务前停止。 |
| `headless` | 使用 headless 自己的 profile 和凭据策略。适合已有独立配置的 CLI 或 CI。 |

桌面模式读取 `$DSH_HOME/profiles/desktop/cordis.patch.yml`（默认 `DSH_HOME` 为 `~/.dsh`），将默认模型和所选提供方配置（自定义网关使用 `llm-pi-ai`）作为临时 `--patch` 传给 headless，同时启用 `credentials`、`authorization` 和 `deepseek-account`。凭据由 DSH 从自己的存储中解析，保留环境变量后备。临时文件仅当前用户可读写，位于仓库之外，每次 DSH 调用退出后清理。同一进程内各轮使用启动时读到的模型选择，`resume` 会重新读取当前 DSH 配置。

可用 `--task-file <文件>` 读取较长需求。程序默认最多实施和评审三轮，可用 `--rounds 5` 调整。支持重复传入 `--check`，每条命令均在任务 worktree 中运行。例如项目采用 Go 模块后可使用 `--check 'cd services/api && go test ./...'`。这些命令由本机 Shell 执行，应由调用方提供。省略时，评审者根据 DSH 的测试报告和仓库证据判断。首次试用可加 `--no-commit`，通过后保留已暂存的候选变更。

## 查看结果与处理失败

运行记录位于 `.ai-workflow/runs/<任务名>-<标识>/`。`request.md` 保存原始需求，`plan.json` 保存规划结果，`implement-1.out` 保存首轮实施报告，`review-1.event.json` 保存首轮机器可读事件，`issues.json` 保存问题生命周期。`check-*.out`、`check-*.err` 保存本地验收输出。旁边的 `worktree/` 是任务分支的独立检出目录。

模型调用出错、返回格式无效、实现被阻塞或用完轮数时，脚本以非零状态结束。可在 Codex 中打开刚才输出的 worktree，读取最近评审和日志，从保留的改动继续。重新运行 `start` 会从当前目录的 `HEAD` 创建一个新任务。

## 评审闭环与问题生命周期

评审结果保存在每个运行目录的 `issues.json`。Codex 每轮只返回结构化问题更新、自我审查结果和简短摘要。问题使用稳定 ID，字段包括严重级别、状态、文件位置、证据、验收条件、重开次数和事件历史。`review-*.event.json` 只保存机器可读事件，问题账本是后续轮次的依据。

问题状态按以下规则流转。

- `OPEN` 表示首次发现或仍未修复。
- `REOPENED` 表示已经标记修复后再次出现。
- `FIXED` 表示本轮有证据证明已修复。
- `WAIVED` 表示人工仲裁接受该问题。
- `STOPPED` 表示人工决定停止当前任务。

严重级别使用 `P0` 到 `P3`。`P0` 表示数据丢失或安全边界，`P1` 表示核心正确性，`P2` 表示重要兼容性或测试缺口，`P3` 表示低风险改进。任何 `OPEN` 或 `REOPENED` 问题都会阻止提交。

默认最多进行三轮评审。可以分别调整实现与评审上限、问题重开上限和无进展上限。

```sh
node scripts/ai-workflow.mjs start \
  --slug sync-protocol \
  --task-file request.md \
  --rounds 4 \
  --review-rounds 3 \
  --max-issue-reopens 2 \
  --stagnation-rounds 2
```

当问题连续没有变化，或同一问题重开达到上限，流程进入人工仲裁并保留工作区。人工仲裁后可以从原运行继续。

```sh
node scripts/ai-workflow.mjs arbitrate \
  --run .ai-workflow/runs/<任务标识> \
  --issue ISSUE-ABC123 \
  --decision waive \
  --note '产品确认该兼容性差异可以接受'

node scripts/ai-workflow.mjs resume \
  --run .ai-workflow/runs/<任务标识> \
  --rounds 2 \
  --review-rounds 2 \
  --check 'node --test tests/protocol/*.test.mjs'
```

`self_review` 要列出检查过的问题、仍未解决的问题和实际回归命令。只有问题账本为空、自我审查通过、验收命令通过时才允许提交。

`resume` 会优先沿用任务创建时保存的轮次、重开和停滞阈值。只有显式传入对应参数时才覆盖原配置。已经进入 `PASSED` 或 `STOPPED` 状态的运行不能重复恢复。
