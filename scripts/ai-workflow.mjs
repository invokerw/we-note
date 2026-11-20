#!/usr/bin/env node
import { execFileSync, spawnSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { closeSync, existsSync, lstatSync, mkdirSync, openSync, readFileSync, writeFileSync } from 'node:fs';
import { basename, dirname, join, resolve } from 'node:path';
import { parseArgs } from 'node:util';
import { checkModel, desktopModel, withDshProfile } from './dsh-model.mjs';
import {
  arbitrate,
  loadLedger,
  mergeReview,
  renderActiveIssues,
  saveLedger,
  summarizeLedger,
} from './review-ledger.mjs';

const bundle = '/Applications/DeepSeek Harness.app/Contents/Resources/runtime/cli/bin/dsh';
const usage = `node scripts/ai-workflow.mjs start (--task TEXT | --task-file FILE)
  [--slug NAME] [--rounds N] [--review-rounds N] [--check 'TEST COMMAND'] [--no-commit]
  [--max-issue-reopens N] [--stagnation-rounds N]
  [--dsh-model-source auto|desktop|headless]
node scripts/ai-workflow.mjs resume --run RUN_DIR
  [--rounds N] [--review-rounds N] [--check 'TEST COMMAND'] [--no-commit]
  [--max-issue-reopens N] [--stagnation-rounds N]
node scripts/ai-workflow.mjs arbitrate --run RUN_DIR --issue ISSUE-ID
  --decision waive|reopen|stop --note TEXT
node scripts/ai-workflow.mjs check-model [--dsh-model-source auto|desktop|headless]

评审以 .ai-workflow/runs/<id>/issues.json 记录问题生命周期。达到轮次、重开或停滞阈值时进入人工仲裁。`;

function git(cwd, ...args) {
  return execFileSync('git', args, { cwd, encoding: 'utf8' }).trimEnd();
}

function invoke(cwd, logs, label, bin, args, input = '') {
  console.log(label);
  const stdout = join(logs, `${label}.out`);
  const stderr = join(logs, `${label}.err`);
  const out = openSync(stdout, 'wx', 0o600);
  const err = openSync(stderr, 'wx', 0o600);
  try {
    const result = spawnSync(bin, args, { cwd, input, stdio: ['pipe', out, err] });
    if (result.error) throw result.error;
    if (result.status !== 0) throw new Error(`${label} 退出 ${result.signal ?? result.status}，详见 ${stderr} 和 ${stdout}`);
  } finally {
    closeSync(out);
    closeSync(err);
  }
  return stdout;
}

function codexDecision(cwd, logs, label, bin, prompt, statuses) {
  const schema = join(logs, `${label}.schema.json`);
  const answer = join(logs, `${label}.json`);
  writeFileSync(schema, JSON.stringify({
    type: 'object', additionalProperties: false, required: ['status', 'report'],
    properties: { status: { type: 'string', enum: statuses }, report: { type: 'string' } },
  }));
  invoke(cwd, logs, label, bin, ['exec', '-s', 'read-only', '--output-schema', schema, '-o', answer, '-'], prompt);
  const result = JSON.parse(readFileSync(answer, 'utf8'));
  if (!statuses.includes(result.status) || typeof result.report !== 'string' || !result.report.trim()) {
    throw new Error(`Codex 输出无效，详见 ${answer}`);
  }
  return result;
}

function reviewSchema() {
  return {
    type: 'object', additionalProperties: false,
    required: ['decision', 'summary', 'self_review', 'issue_updates'],
    properties: {
      decision: { type: 'string', enum: ['PASS', 'CHANGES_REQUIRED', 'HUMAN_REVIEW'] },
      summary: { type: 'string' },
      self_review: {
        type: 'object', additionalProperties: false,
        required: ['status', 'checked_issue_ids', 'unresolved_issue_ids', 'regression_checks'],
        properties: {
          status: { type: 'string', enum: ['PASS', 'NEEDS_ATTENTION'] },
          checked_issue_ids: { type: 'array', items: { type: 'string' } },
          unresolved_issue_ids: { type: 'array', items: { type: 'string' } },
          regression_checks: { type: 'array', minItems: 1, items: { type: 'string' } },
        },
      },
      issue_updates: {
        type: 'array',
        items: {
          type: 'object', additionalProperties: false,
          required: ['action', 'severity', 'title'],
          properties: {
            id: { type: 'string' },
            action: { type: 'string', enum: ['OPEN', 'UPDATE', 'STILL_OPEN', 'FIXED', 'REOPEN'] },
            severity: { type: 'string', enum: ['P0', 'P1', 'P2', 'P3'] },
            title: { type: 'string' },
            file: { type: ['string', 'null'] },
            line: { type: ['integer', 'null'] },
            rule: { type: ['string', 'null'] },
            evidence: { type: 'string' },
            acceptance: { type: 'string' },
          },
        },
      },
    },
  };
}

function codexReview(cwd, logs, round, bin, prompt) {
  const schema = join(logs, 'review.schema.json');
  const answer = join(logs, `review-${round}.event.json`);
  writeFileSync(schema, JSON.stringify(reviewSchema()));
  invoke(cwd, logs, `review-${round}`, bin, ['exec', '-s', 'read-only', '--output-schema', schema, '-o', answer, '-'], prompt);
  const result = JSON.parse(readFileSync(answer, 'utf8'));
  if (!result || !['PASS', 'CHANGES_REQUIRED', 'HUMAN_REVIEW'].includes(result.decision)) {
    throw new Error(`Codex 评审事件无效，详见 ${answer}`);
  }
  return result;
}

function options() {
  return {
    task: { type: 'string' }, 'task-file': { type: 'string' }, slug: { type: 'string' }, run: { type: 'string' }, issue: { type: 'string' },
    decision: { type: 'string' }, note: { type: 'string' }, rounds: { type: 'string' },
    'review-rounds': { type: 'string' }, check: { type: 'string', multiple: true, default: [] },
    'dsh-model-source': { type: 'string', default: 'auto' }, 'max-issue-reopens': { type: 'string' },
    'stagnation-rounds': { type: 'string' }, 'no-commit': { type: 'boolean' }, help: { type: 'boolean', short: 'h' },
  };
}

function parsePositive(value, label) {
  const number = Number(value);
  if (!Number.isSafeInteger(number) || number < 1) throw new Error(`${label} 必须是正整数。`);
  return number;
}

function reviewPrompt({ spec, request, report, ledger, checks }) {
  const active = renderActiveIssues(ledger);
  return `你是独立评审者。在当前 worktree 中阅读 ${spec}、原始设计文档和 git diff --cached。先进行自我审查，再更新问题账本。不要输出长篇 review 报告，只输出 schema 要求的结构化评审事件。

原始需求
${request}

实现报告（仅作线索）
${report}

本轮验收命令
${checks.join('\n') || '没有额外验收命令。'}

当前问题账本中的未关闭问题
${active}

规则
1. 为每个仍未解决的已有问题输出同一个 issue id，并用 UPDATE 或 STILL_OPEN 更新证据和验收条件。修复后用 FIXED。已 FIXED 的问题再次出现用 REOPEN。新问题用 OPEN，并给出稳定、简短、可复用的标题。
2. 使用 P0、P1、P2、P3 分级。P0 是数据丢失或安全边界，P1 是核心正确性，P2 是重要兼容性或测试缺口，P3 是低风险改进。
3. issue_updates 只记录问题生命周期变化，不复制完整评审报告。summary 控制在几句话内。
4. self_review 必须列出检查过的问题 ID、未解决问题 ID、实际运行的回归检查。未解决问题存在时不能返回 PASS。
5. 只有问题账本没有 OPEN 或 REOPENED 问题、自我审查为 PASS、验收命令通过时才能返回 PASS。需要用户决定时返回 HUMAN_REVIEW。`;
}

function validateCommon(values, command) {
  const rounds = parsePositive(values.rounds ?? '3', '--rounds');
  const reviewRounds = parsePositive(values['review-rounds'] ?? values.rounds ?? '3', '--review-rounds');
  const maxIssueReopens = parsePositive(values['max-issue-reopens'] ?? '2', '--max-issue-reopens');
  const stagnationRounds = parsePositive(values['stagnation-rounds'] ?? '2', '--stagnation-rounds');
  if (command === 'start' && (values.task === undefined) === (values['task-file'] === undefined)) throw new Error(usage);
  return { rounds, reviewRounds, maxIssueReopens, stagnationRounds };
}

function writeMeta(logs, meta) {
  writeFileSync(join(logs, 'meta.json'), `${JSON.stringify(meta, null, 2)}\n`, { mode: 0o600 });
}

function runCycles({ root, work, logs, base, branch, spec, specPath, request, codex, dsh, model, values, startRound, maxRounds, reviewRounds, maxIssueReopens, stagnationRounds }) {
  const issuesPath = join(logs, 'issues.json');
  const ledger = loadLedger(issuesPath, { task_id: basename(logs), spec, branch });
  const frozenSpec = readFileSync(specPath, 'utf8');
  let feedback = renderActiveIssues(ledger);
  const endRound = Math.min(startRound + reviewRounds - 1, maxRounds);
  function assertTask() {
    if (git(work, 'rev-parse', 'HEAD') !== base || git(work, 'branch', '--show-current') !== branch) throw new Error('任务分支或基线发生变化。');
    if (!lstatSync(specPath).isFile()) throw new Error('任务书被删除。');
    if (readFileSync(specPath, 'utf8') !== frozenSpec) throw new Error('任务书内容发生变化。');
  }
  for (let round = startRound; round <= endRound; round += 1) {
    const output = withDshProfile(model, args => invoke(work, logs, `implement-${round}`, dsh,
      [...args, '--permission-mode', 'workspace-write', '--approval-policy', 'never', '-'],
      `在当前工作区按 ${spec} 实现和测试。保留任务书和 Git 状态，提交由调度器完成。列出实际测试命令、结果和未验证项。阻塞时最后一行写 IMPLEMENTATION_STATUS: BLOCKED，完成时写 IMPLEMENTATION_STATUS: COMPLETE。\n\n当前问题账本与修复要求\n${feedback}`));
    const report = readFileSync(output, 'utf8').trimEnd();
    if (report.split('\n').at(-1)?.trim() !== 'IMPLEMENTATION_STATUS: COMPLETE') throw new Error(`实现未确认完成，详见 ${output}`);
    assertTask();
    const checks = [];
    for (const [index, command] of values.check.entries()) {
      const label = `check-${round}-${index + 1}`;
      try {
        invoke(work, logs, label, '/bin/sh', ['-c', command]);
        checks.push(`通过 ${command}`);
      } catch (error) {
        feedback = `请修复验收失败并重新验证。命令 ${command}\n${readFileSync(join(logs, `${label}.out`), 'utf8').slice(-4000)}\n${readFileSync(join(logs, `${label}.err`), 'utf8').slice(-4000)}`;
        if (round === endRound) throw error;
        break;
      }
    }
    if (checks.length !== values.check.length) continue;
    assertTask();
    git(work, 'add', '-A');
    git(work, 'diff', '--cached', '--check');
    const tree = git(work, 'write-tree');
    if (!git(work, 'diff', '--cached', '--name-only', '--', '.', `:(exclude)${spec}`)) throw new Error('没有任务书以外的实现变更。');
    const review = codexReview(work, logs, round, codex, reviewPrompt({ spec, request, report, ledger, checks }));
    const merged = mergeReview(ledger, review, round, { maxIssueReopens, stagnationRounds });
    saveLedger(issuesPath, ledger);
    if (merged.outcome === 'HUMAN_REVIEW') {
      console.log(`需要人工仲裁（${merged.reason}）。问题账本：${issuesPath}`);
      return;
    }
    if (merged.outcome !== 'PASS') {
      feedback = renderActiveIssues(ledger);
      console.log(`第 ${round} 轮发现问题，下一轮只处理问题账本中的未关闭项。\n${feedback}`);
      continue;
    }
    assertTask();
    if (git(work, 'write-tree') !== tree || git(work, 'diff', '--name-only') || git(work, 'ls-files', '--others', '--exclude-standard')) throw new Error('评审期间候选内容发生变化，需要重新评审。');
    if (values['no-commit']) return console.log(`第 ${round} 轮评审通过，候选内容已暂存到 ${work}`);
    git(work, 'commit', '-m', `Implement ${values.slug ?? 'task'}`);
    if (git(work, 'rev-parse', 'HEAD^{tree}') !== tree) throw new Error('提交内容与评审快照不同，请检查 Git hook 和已创建的本地提交。');
    return console.log(`第 ${round} 轮评审通过，已提交 ${git(work, 'rev-parse', '--short', 'HEAD')} 到 ${branch}`);
  }
  saveLedger(issuesPath, ledger);
  throw new Error(`已达到评审上限。问题账本和工作区已保留：${issuesPath}`);
}

function start(values, limits) {
  const dsh = process.env.DSH_BIN || (existsSync(bundle) ? bundle : 'dsh');
  if (process.env.DSH_HOME) process.env.DSH_HOME = resolve(process.env.DSH_HOME);
  if (values.help) return console.log(usage);
  const request = (values.task ?? readFileSync(values['task-file'], 'utf8')).trim();
  if (!request) throw new Error(usage);
  const slug = values.slug ?? 'task';
  if (!/^[a-z0-9][a-z0-9-]{0,63}$/.test(slug)) throw new Error('--slug 使用 1 到 64 个小写英文字母、数字或连字符。');
  const codex = process.env.CODEX_BIN || 'codex';
  execFileSync(codex, ['--version'], { stdio: 'ignore' });
  const model = desktopModel(values['dsh-model-source']);
  checkModel(dsh, model);
  const root = git(process.cwd(), 'rev-parse', '--show-toplevel');
  const base = git(root, 'rev-parse', 'HEAD');
  const id = `${slug}-${randomUUID().slice(0, 8)}`;
  const branch = `codex/${id}`;
  const logs = join(root, '.ai-workflow', 'runs', id);
  const work = join(logs, 'worktree');
  mkdirSync(logs, { recursive: true, mode: 0o700 });
  console.log(`任务分支 ${branch}\n工作区 ${work}\n运行记录 ${logs}`);
  git(root, 'worktree', 'add', '-b', branch, work, base);
  writeFileSync(join(logs, 'request.md'), request);
  const spec = `docs/tasks/${id}.md`;
  const specPath = join(work, spec);
  const plan = codexDecision(work, logs, 'plan', codex,
    `根据用户需求和仓库现状编写 Markdown 任务书。列出目标、范围、接口或文件、可验证的验收条件、实现步骤和测试命令。report 放全文。条件充分时 status 为 READY，缺少必要决策时写 BLOCKED 和原因。用户需求如下。\n${request}`,
    ['READY', 'BLOCKED']);
  if (plan.status !== 'READY') throw new Error(plan.report);
  mkdirSync(dirname(specPath), { recursive: true });
  writeFileSync(specPath, `${plan.report.trim()}\n`, { flag: 'wx' });
  writeMeta(logs, { id, root, base, branch, work, spec, limits, created_at: new Date().toISOString() });
  runCycles({ root, work, logs, base, branch, spec, specPath, request, codex, dsh, model, values: { ...values, slug }, startRound: 1, maxRounds: limits.rounds, reviewRounds: limits.reviewRounds, maxIssueReopens: limits.maxIssueReopens, stagnationRounds: limits.stagnationRounds });
}

function resume(values, limits) {
  if (!values.run) throw new Error('resume 需要 --run RUN_DIR。');
  const logs = resolve(values.run);
  const meta = JSON.parse(readFileSync(join(logs, 'meta.json'), 'utf8'));
  const ledger = loadLedger(join(logs, 'issues.json'));
  if (ledger.workflow_state === 'PASSED') throw new Error('该运行已经通过评审并提交，不能重复 resume。');
  if (ledger.workflow_state === 'STOPPED') throw new Error('该运行已被人工停止，请先重新打开相关问题后再 resume。');
  const dsh = process.env.DSH_BIN || (existsSync(bundle) ? bundle : 'dsh');
  const codex = process.env.CODEX_BIN || 'codex';
  execFileSync(codex, ['--version'], { stdio: 'ignore' });
  const model = desktopModel(values['dsh-model-source']);
  checkModel(dsh, model);
  const request = readFileSync(join(logs, 'request.md'), 'utf8').trim();
  const startRound = (ledger.last_review_round ?? 0) + 1;
  const persisted = meta.limits ?? {};
  const effective = {
    rounds: values.rounds === undefined ? persisted.rounds ?? limits.rounds : limits.rounds,
    reviewRounds: values['review-rounds'] === undefined
      ? (values.rounds === undefined ? persisted.reviewRounds ?? limits.reviewRounds : limits.rounds)
      : limits.reviewRounds,
    maxIssueReopens: values['max-issue-reopens'] === undefined ? persisted.maxIssueReopens ?? limits.maxIssueReopens : limits.maxIssueReopens,
    stagnationRounds: values['stagnation-rounds'] === undefined ? persisted.stagnationRounds ?? limits.stagnationRounds : limits.stagnationRounds,
  };
  runCycles({ root: meta.root, work: meta.work, logs, base: meta.base, branch: meta.branch, spec: meta.spec, specPath: join(meta.work, meta.spec), request, codex, dsh, model, values, startRound, maxRounds: startRound + effective.rounds - 1, reviewRounds: effective.reviewRounds, maxIssueReopens: effective.maxIssueReopens, stagnationRounds: effective.stagnationRounds });
}

function runArbitration(values) {
  if (!values.run || !values.issue || !values.decision || !values.note) throw new Error('arbitrate 需要 --run、--issue、--decision 和 --note。');
  const decisions = { waive: 'WAIVED', reopen: 'REOPENED', stop: 'STOPPED' };
  if (!decisions[values.decision]) throw new Error('--decision 只能是 waive、reopen 或 stop。');
  const path = join(resolve(values.run), 'issues.json');
  const ledger = loadLedger(path);
  arbitrate(ledger, values.issue, decisions[values.decision], values.note);
  saveLedger(path, ledger);
  console.log(`已记录人工仲裁：${values.issue} -> ${values.decision}\n${path}`);
  console.log(JSON.stringify(summarizeLedger(ledger), null, 2));
}

function main() {
  const { values, positionals } = parseArgs({ allowPositionals: true, options: options() });
  const command = positionals[0];
  if (values.help || !command) return console.log(usage);
  if (command === 'check-model') {
    const dsh = process.env.DSH_BIN || (existsSync(bundle) ? bundle : 'dsh');
    return checkModel(dsh, desktopModel(values['dsh-model-source']));
  }
  if (command === 'arbitrate') return runArbitration(values);
  const limits = validateCommon(values, command);
  if (command === 'start') return start(values, limits);
  if (command === 'resume') return resume(values, limits);
  throw new Error(usage);
}

try { main(); } catch (error) { console.error(error.message); process.exitCode = 1; }
