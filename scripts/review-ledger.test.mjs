import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import {
  arbitrate,
  activeIssues,
  emptyLedger,
  issueFingerprint,
  loadLedger,
  mergeReview,
  saveLedger,
} from './review-ledger.mjs';

const review = (decision, issue_updates, status = 'NEEDS_ATTENTION') => ({
  decision,
  summary: '结构化生命周期更新',
  self_review: {
    status,
    checked_issue_ids: issue_updates.filter(item => item.id).map(item => item.id),
    unresolved_issue_ids: issue_updates.filter(item => item.action !== 'FIXED').map(item => item.id).filter(Boolean),
    regression_checks: ['node --test tests/protocol/*.test.mjs'],
  },
  issue_updates,
});

const issue = (id = 'ISSUE-ABC123') => ({
  id, action: 'OPEN', severity: 'P1', title: '文件基准判断不正确', file: 'tests/protocol/sync-model.mjs', line: 10,
  evidence: '旧版本仍然提交成功', acceptance: '返回 FILE_VERSION_CONFLICT 且状态不变',
});

test('问题有稳定 ID，并经过 OPEN、FIXED 生命周期后允许 PASS', () => {
  const ledger = emptyLedger();
  const first = mergeReview(ledger, review('CHANGES_REQUIRED', [issue()]), 1);
  assert.equal(first.outcome, 'CHANGES_REQUIRED');
  const fixed = mergeReview(ledger, review('PASS', [{ ...issue(), action: 'FIXED' }], 'PASS'), 2);
  assert.equal(fixed.outcome, 'PASS');
  assert.equal(ledger.workflow_state, 'PASSED');
  assert.equal(ledger.issues['ISSUE-ABC123'].state, 'FIXED');
  assert.equal(ledger.events.filter(event => event.type === 'ISSUE_UPDATE').length, 2);
});

test('无进展达到阈值时进入人工仲裁', () => {
  const ledger = emptyLedger();
  mergeReview(ledger, review('CHANGES_REQUIRED', [issue()]), 1);
  const result = mergeReview(ledger, review('CHANGES_REQUIRED', [{ ...issue(), action: 'STILL_OPEN' }]), 2, { stagnationRounds: 1 });
  assert.equal(result.outcome, 'HUMAN_REVIEW');
  assert.equal(result.reason, 'NO_PROGRESS');
  assert.equal(ledger.workflow_state, 'HUMAN_REVIEW');
});

test('问题重开达到阈值时进入人工仲裁', () => {
  const ledger = emptyLedger();
  mergeReview(ledger, review('CHANGES_REQUIRED', [issue()]), 1);
  mergeReview(ledger, review('PASS', [{ ...issue(), action: 'FIXED' }], 'PASS'), 2);
  const result = mergeReview(ledger, review('CHANGES_REQUIRED', [{ ...issue(), action: 'REOPEN' }]), 3, { maxIssueReopens: 1 });
  assert.equal(result.outcome, 'HUMAN_REVIEW');
  assert.equal(ledger.issues['ISSUE-ABC123'].state, 'REOPENED');
});

test('人工仲裁写入账本并可重新打开问题', () => {
  const ledger = emptyLedger();
  mergeReview(ledger, review('CHANGES_REQUIRED', [issue()]), 1);
  arbitrate(ledger, 'ISSUE-ABC123', 'WAIVED', '产品确认该兼容性差异可以接受');
  assert.equal(activeIssues(ledger).length, 0);
  assert.equal(ledger.issues['ISSUE-ABC123'].human_note, '产品确认该兼容性差异可以接受');
  arbitrate(ledger, 'ISSUE-ABC123', 'REOPENED', '新需求重新要求修复');
  assert.equal(activeIssues(ledger).length, 1);
  assert.equal(ledger.issues['ISSUE-ABC123'].reopen_count, 1);
});

test('self_review 必须覆盖活跃问题', () => {
  const ledger = emptyLedger();
  const invalid = review('CHANGES_REQUIRED', [issue()]);
  invalid.self_review.checked_issue_ids = [];
  assert.throws(() => mergeReview(ledger, invalid, 1), /self_review 未列出本轮更新的问题/);
});

test('未知问题不能直接执行生命周期更新', () => {
  const ledger = emptyLedger();
  assert.throws(() => mergeReview(ledger, review('CHANGES_REQUIRED', [{ ...issue('ISSUE-UNKNOWN'), action: 'FIXED' }]), 1), /问题 ISSUE-UNKNOWN 不存在/);
});

test('账本可保存和恢复', () => {
  const path = join(mkdtempSync(join(tmpdir(), 'review-ledger-')), 'issues.json');
  const ledger = emptyLedger({ task_id: 'demo' });
  mergeReview(ledger, review('CHANGES_REQUIRED', [issue()]), 1);
  saveLedger(path, ledger);
  const restored = loadLedger(path);
  assert.equal(restored.meta.task_id, 'demo');
  assert.equal(restored.issues['ISSUE-ABC123'].title, '文件基准判断不正确');
  assert.deepEqual(JSON.parse(readFileSync(path, 'utf8')).version, 1);
});

test('没有显式 ID 的新问题使用稳定指纹', () => {
  const a = issueFingerprint({ severity: 'P2', title: '测试缺口', file: 'a.mjs', line: 4 });
  const b = issueFingerprint({ severity: 'P2', title: '测试缺口', file: 'a.mjs', line: 4 });
  assert.equal(a, b);
  assert.match(a, /^ISSUE-[A-Z0-9]+$/);
});
