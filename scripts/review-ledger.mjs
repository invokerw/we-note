import { createHash } from 'node:crypto';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';

export const SEVERITIES = ['P0', 'P1', 'P2', 'P3'];
export const ISSUE_STATES = ['OPEN', 'FIXED', 'REOPENED', 'WAIVED', 'STOPPED'];
export const REVIEW_ACTIONS = ['OPEN', 'UPDATE', 'STILL_OPEN', 'FIXED', 'REOPEN'];

const ACTIVE_STATES = new Set(['OPEN', 'REOPENED']);

function now() {
  return new Date().toISOString();
}

function clean(value) {
  return String(value ?? '').trim().replace(/\s+/g, ' ');
}

export function issueFingerprint(issue) {
  const source = [issue.severity, issue.title, issue.file, issue.line, issue.rule].map(clean).join('|');
  return `ISSUE-${createHash('sha256').update(source).digest('hex').slice(0, 10).toUpperCase()}`;
}

export function emptyLedger(meta = {}) {
  return {
    version: 1,
    meta,
    workflow_state: 'RUNNING',
    issues: {},
    events: [],
    last_review_round: 0,
    no_progress_rounds: 0,
    active_signature: '',
  };
}

export function loadLedger(path, meta = {}) {
  if (!existsSync(path)) return emptyLedger(meta);
  const ledger = JSON.parse(readFileSync(path, 'utf8'));
  if (ledger.version !== 1 || !ledger.issues || !Array.isArray(ledger.events)) {
    throw new Error(`问题账本格式无效：${path}`);
  }
  ledger.meta = { ...meta, ...(ledger.meta ?? {}) };
  ledger.workflow_state ??= 'RUNNING';
  return ledger;
}

export function saveLedger(path, ledger) {
  writeFileSync(path, `${JSON.stringify(ledger, null, 2)}\n`, { mode: 0o600 });
}

export function activeIssues(ledger) {
  return Object.values(ledger.issues).filter(issue => ACTIVE_STATES.has(issue.state));
}

export function activeSignature(ledger) {
  return activeIssues(ledger)
    .map(issue => [issue.id, issue.severity, issue.state, issue.title, issue.file, issue.line, issue.rule].map(clean).join('|'))
    .sort()
    .join('\n');
}

function updateIssue(previous, update, round) {
  const id = previous?.id ?? update.id ?? issueFingerprint(update);
  const action = update.action ?? 'UPDATE';
  const state = action === 'FIXED' ? 'FIXED'
    : action === 'REOPEN' ? 'REOPENED'
      : previous?.state === 'FIXED' && action !== 'FIXED' ? 'REOPENED'
        : 'OPEN';
  const reopenCount = (previous?.reopen_count ?? 0) + (action === 'REOPEN' ? 1 : 0);
  const issue = {
    ...previous,
    id,
    severity: update.severity ?? previous?.severity,
    title: update.title ?? previous?.title,
    file: update.file ?? previous?.file ?? null,
    line: update.line ?? previous?.line ?? null,
    rule: update.rule ?? previous?.rule ?? null,
    evidence: update.evidence ?? previous?.evidence ?? '',
    acceptance: update.acceptance ?? previous?.acceptance ?? '',
    state,
    reopen_count: reopenCount,
    first_seen_round: previous?.first_seen_round ?? round,
    last_seen_round: round,
    updated_at: now(),
  };
  if (!SEVERITIES.includes(issue.severity) || !issue.title) {
    throw new Error(`问题更新无效：${id} 缺少合法 severity 或 title。`);
  }
  return issue;
}

function validateUpdate(update) {
  if (!REVIEW_ACTIONS.includes(update.action)) throw new Error(`问题 action 无效：${update.action}`);
  if (update.action !== 'OPEN' && !clean(update.id)) throw new Error('已有问题的更新必须包含稳定 issue id。');
  if (update.action === 'OPEN' && update.id && !/^ISSUE-[A-Z0-9]+$/.test(update.id)) throw new Error(`issue id 无效：${update.id}`);
}

export function mergeReview(ledger, review, round, { maxIssueReopens = 2, stagnationRounds = 2 } = {}) {
  if (!['PASS', 'CHANGES_REQUIRED', 'HUMAN_REVIEW'].includes(review.decision)) {
    throw new Error(`评审 decision 无效：${review.decision}`);
  }
  if (!review.self_review || !['PASS', 'NEEDS_ATTENTION'].includes(review.self_review.status)) {
    throw new Error('评审缺少 self_review.status。');
  }
  if (!Array.isArray(review.issue_updates)) throw new Error('评审缺少 issue_updates 数组。');
  const beforeSignature = activeSignature(ledger);
  const updates = review.issue_updates;
  for (const update of updates) validateUpdate(update);
  const seen = new Set();
  for (const update of updates) {
    const id = update.id ?? issueFingerprint(update);
    if (seen.has(id)) throw new Error(`同一轮重复更新问题：${id}`);
    seen.add(id);
    const previous = ledger.issues[id];
    if (update.action === 'OPEN' && previous) throw new Error(`问题 ${id} 已存在，不能再次 OPEN。`);
    if (update.action !== 'OPEN' && !previous) throw new Error(`问题 ${id} 不存在，不能执行 ${update.action}。`);
    ledger.issues[id] = updateIssue(previous, { ...update, id }, round);
    ledger.events.push({
      type: 'ISSUE_UPDATE',
      round,
      at: now(),
      issue_id: id,
      action: update.action,
      severity: ledger.issues[id].severity,
      state: ledger.issues[id].state,
      evidence: update.evidence ?? '',
    });
  }
  const active = activeIssues(ledger);
  const activeIds = new Set(active.map(issue => issue.id));
  for (const issue of active) {
    if (!seen.has(issue.id)) throw new Error(`评审未更新仍活跃的问题：${issue.id}`);
  }
  const checkedIds = new Set((review.self_review.checked_issue_ids ?? []).map(clean));
  const unresolvedIds = new Set((review.self_review.unresolved_issue_ids ?? []).map(clean));
  for (const id of seen) {
    if (!checkedIds.has(id)) throw new Error(`self_review 未列出本轮更新的问题：${id}`);
  }
  for (const id of activeIds) {
    if (!checkedIds.has(id) || !unresolvedIds.has(id)) throw new Error(`self_review 未完整列出未解决问题：${id}`);
  }
  for (const id of unresolvedIds) {
    if (!activeIds.has(id)) throw new Error(`self_review 将已关闭问题列为未解决：${id}`);
  }
  if (review.self_review.status === 'PASS' && unresolvedIds.size > 0) {
    throw new Error('self_review.status 为 PASS 时不能存在未解决问题。');
  }
  if (review.decision === 'PASS' && (active.length > 0 || review.self_review.status !== 'PASS')) {
    throw new Error('评审返回 PASS 时，问题账本必须为空且 self_review 必须为 PASS。');
  }
  const afterSignature = activeSignature(ledger);
  ledger.last_review_round = round;
  ledger.no_progress_rounds = beforeSignature === afterSignature && afterSignature ? ledger.no_progress_rounds + 1 : 0;
  ledger.active_signature = afterSignature;
  ledger.events.push({
    type: 'REVIEW',
    round,
    at: now(),
    decision: review.decision,
    self_review: review.self_review,
    summary: clean(review.summary),
    active_issue_ids: [...activeIds].sort(),
  });
  const reopenLimit = active.some(issue => issue.reopen_count >= maxIssueReopens);
  const stagnant = ledger.no_progress_rounds >= stagnationRounds && active.length > 0;
  if (reopenLimit || stagnant) {
    ledger.workflow_state = 'HUMAN_REVIEW';
    ledger.events.push({
      type: 'HUMAN_REVIEW_REQUIRED',
      round,
      at: now(),
      reason: reopenLimit ? 'ISSUE_REOPEN_LIMIT' : 'NO_PROGRESS',
      active_issue_ids: active.map(issue => issue.id).sort(),
    });
    return { ledger, outcome: 'HUMAN_REVIEW', reason: reopenLimit ? 'ISSUE_REOPEN_LIMIT' : 'NO_PROGRESS' };
  }
  if (review.decision === 'HUMAN_REVIEW') {
    ledger.workflow_state = 'HUMAN_REVIEW';
    return { ledger, outcome: 'HUMAN_REVIEW', reason: 'MODEL_REQUESTED' };
  }
  if (review.decision === 'PASS' && active.length === 0 && review.self_review.status === 'PASS') {
    ledger.workflow_state = 'PASSED';
    return { ledger, outcome: 'PASS' };
  }
  ledger.workflow_state = 'RUNNING';
  return { ledger, outcome: 'CHANGES_REQUIRED' };
}

export function renderActiveIssues(ledger) {
  const issues = activeIssues(ledger);
  if (!issues.length) return '当前问题账本没有未关闭问题。';
  return issues.map(issue => [
    `${issue.id} [${issue.severity}] ${issue.title}`,
    `位置：${issue.file ?? '未指定'}${issue.line ? `:${issue.line}` : ''}`,
    `证据：${issue.evidence || '未提供'}`,
    `验收：${issue.acceptance || '未提供'}`,
    `重开次数：${issue.reopen_count}`,
  ].join('\n')).join('\n\n');
}

export function arbitrate(ledger, issueId, decision, note) {
  const issue = ledger.issues[issueId];
  if (!issue) throw new Error(`不存在问题 ${issueId}`);
  if (!['WAIVED', 'REOPENED', 'STOPPED'].includes(decision)) throw new Error('人工仲裁只能选择 waive、reopen 或 stop。');
  issue.state = decision === 'WAIVED' ? 'WAIVED' : decision === 'REOPENED' ? 'REOPENED' : 'STOPPED';
  if (decision === 'REOPENED') issue.reopen_count = (issue.reopen_count ?? 0) + 1;
  issue.human_note = clean(note);
  issue.updated_at = now();
  ledger.events.push({ type: 'HUMAN_ARBITRATION', at: now(), issue_id: issueId, decision, note: issue.human_note });
  ledger.active_signature = activeSignature(ledger);
  ledger.no_progress_rounds = 0;
  ledger.workflow_state = decision === 'STOPPED' ? 'STOPPED' : 'RUNNING';
  return ledger;
}

export function summarizeLedger(ledger) {
  return {
    workflow_state: ledger.workflow_state ?? 'RUNNING',
    issues: Object.values(ledger.issues).map(issue => ({
      id: issue.id,
      severity: issue.severity,
      title: issue.title,
      state: issue.state,
      reopen_count: issue.reopen_count,
      file: issue.file,
      line: issue.line,
    })),
  };
}
