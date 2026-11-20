#!/usr/bin/env node
/**
 * 破坏性验证（变异测试）。
 *
 * 每个变异都在**独立临时副本**中只改一处实现、夹具或文档，然后运行同一测试文件。
 *
 * 判定不依赖任何测试 reporter 的文本输出：这里用 `node:test` 的**编程式 `run()` API**
 * 在子进程里收集结构化事件（失败测试的**精确名称** + 错误消息），再据此判定。
 * 因此把 `--test-reporter` 换成 tap / spec / dot 都不会改变结论。
 *
 * 每个变异至少声明：
 *   - `failTests`：必须失败的测试**精确名称**，且是**完整集合**（既不能少、也不能多）；
 *   - 可选 `expectError`：某个命中测试的错误消息必须包含的稳定诊断片段。
 *
 * 判定是集合相等：`{顶层失败测试名} === failTests`。缺任何一个指定失败都算未命中，
 * 出现任何未声明的额外顶层失败也算未命中——否则「顺带打挂一堆无关测试」会被误当成
 * 「精确覆盖了某条规则」。测试名一律取自 `node:test` 的结构化失败事件，不做子串猜测。
 * 若一个变异合理地会让多个测试失败，必须在 `failTests` 里显式列全。
 *
 * 用法：node tests/protocol/mutation-check.mjs
 */

import { copyFileSync, cpSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(HERE, '..', '..');
const MODEL = 'tests/protocol/sync-model.mjs';
const TEST = 'tests/protocol/sync-v1.test.mjs';
const FIXTURE_STALE = 'tests/sync-fixtures/stale-cursor-recovery.json';
const FIXTURE_SINGLE_HASH = 'tests/sync-fixtures/historical-single-hash-replay.json';
const FIXTURE_DELETED = 'tests/sync-fixtures/update-deleted-file.json';
const FIXTURE_COMPRESSED = 'tests/sync-fixtures/compressed-history-recovery.json';
const DOC = 'docs/同步操作协议-v1.md';
const RUNNER = '__mutation-runner.mjs';

const read = (root, file) => readFileSync(join(root, file), 'utf8');
const write = (root, file, text) => writeFileSync(join(root, file), text);
const readJson = (root, file) => JSON.parse(read(root, file));
const writeJson = (root, file, value) => write(root, file, `${JSON.stringify(value, null, 2)}\n`);

/** 精确单点替换：出现次数不符就报错，避免「改到别处却以为验证过了」。支持字面串或带 `g` 的正则。 */
function replaceOnce(root, file, from, to, label) {
  const text = read(root, file);
  if (from instanceof RegExp) {
    const matches = [...text.matchAll(from)];
    if (matches.length !== 1) throw new Error(`变异「${label}」的正则命中 ${matches.length} 次（期望 1 次）: ${file}`);
    write(root, file, text.replace(from, to));
    return;
  }
  const count = text.split(from).length - 1;
  if (count !== 1) throw new Error(`变异「${label}」的锚点出现 ${count} 次（期望 1 次）: ${file}`);
  write(root, file, text.replace(from, to));
}

/* ---- 稳定的测试标识：与测试文件里的 test(...) 名称逐字一致 ---- */
const T = {
  histSingleHash: '历史加载接受单哈希基准，并保证原样重放命中首次结果（HIST-01）',
  histRequestSet: '历史首次请求的加载失败集合覆盖完整路由、query、方法、操作与不可重放请求（HIST-02）',
  histBlob: '历史首次请求的 blob_reference 必须与可留存原始字节和版本引用一致（HIST-03）',
  histGraph: '版本图必须校验同文件父版本、先后顺序与无环（HIST-04）',
  histCompression: '压缩语义：缺少保留 Change 的文件仍可由初始快照证明当前指针（HIST-05）',
  histBaseRevision: '首次写入 revision N 的历史请求必须满足 base_revision <= N-1（HIST-06）',
  histMetadata: '每次成功 update_file_content 必须保存用于核对的 metadata（HIST-07）',
  writeDeleted: '已删除文件的内容更新必须恢复 is_deleted=false 且与最后一条 Change 自洽（WRITE-01）',
  errorReused: 'IDEMPOTENCY_KEY_REUSED 对可重放与不可重放两类 ID 返回各自恢复字段（ERROR-01）',
  trackRequestId: 'request_id 序号范围是 1..999999，req_000000 必须被拒绝（TRACK-01）',
  stateDeepCopy: 'createVaultState / snapshotState 必须深拷贝嵌套 metadata、body、headers 与 query（STATE-01）',
  revisionExhausted: 'revision 达到可安全表示上界时必须返回稳定错误且不复用 revision（REV-01）',
  testExpectedResult: '夹具 expected_result 中一个错误业务值必须让 runScenario 失败且不登记（TEST-01）',
  testCrossFields: '提交与 pull 的字段交叉断言对 operation_id / device_id / operation 变异敏感（TEST-02）',
  testMainLoop: '五个必需场景均已由主循环实际执行，且每一步都登记在统一执行记录里（SYNC-V1-007）',
  testAllScenarios: '全部已加载场景都会由主循环实际执行，且每一步都跑过',
  testAsync: '至少一个成功提交场景通过异步 resolveUpload 返回 Promise<Buffer>（TEST-04）',
  testEnvelope: '统一夹具执行器表达 query.vault_id 不匹配与 REQUEST_ID_EXHAUSTED（TEST-05）',
  historyReplay: '历史重放校验完整：改历史 Change / 版本 / 首次请求并重算指纹后必须失败（SYNC-V1-001）',
  historyOperation: '历史 operation_id 全局唯一：任何历史 Change 的 ID 都不得被新的不同 operation 复用（SYNC-V1-008）',
  revisionContinuity: 'initial_state 的 revision 必须连续、change_id 必须全局唯一（SYNC-V1-011）',
  requestSequence: '删除 initial_state.request_sequence 后不得重用历史 request_id（SYNC-V1-012）',
  snapshotCoverage: 'snapshotState 覆盖上传会话、已占用 operation_id 与所有影响协议结果的状态（SYNC-V1-009）',
  rejectNoState: '拒绝请求不得新增版本 / Change / Blob / 幂等记录或推进 revision（SYNC-V1-009）',
  uploadBroken: '上传会话被改坏时提交必须失败，且失败分支不得推进 vault_revision（SYNC-V1-009）',
  recordTiming: '执行记录只在请求/响应/全部断言完成后登记：断言失败必须不留记录（SYNC-V1-007）',
  hardcodedCursor: '续拉游标跟随快照 revision 变化，硬编码 6 必然失败',
  zeroCursor: '绑定游标 0 是合法取值：零游标案例走与场景完全相同的执行路径（SYNC-V1-003）',
  cursorRecovery: '过期游标恢复：快照后变更恰好出现一次，且续拉游标取自 manifest 快照',
  idempotentLedger: '历史幂等账本：原请求重放返回首次结果，同 ID 异内容拒绝',
  idempotentCrossCheck: '历史幂等账本的指纹、首次请求与历史 Change 必须在加载阶段相互核对',
  fingerprintSnapshot: '状态快照把幂等指纹纳入比较，连续重放不会掩盖指纹丢失',
  methodJoint: '方法与路径联合校验：合法组合成功，错误方法返回 METHOD_NOT_ALLOWED',
  vaultMismatch: 'VAULT_MISMATCH 错误结构包含 expected_vault_id，且缺失标识不会被误报成 VAULT_MISMATCH',
  combinedInvalid: '组合非法请求：先完成类型与取值校验，再判断 operation 是否支持',
  stableErrors: '协议外请求与非法基准返回稳定错误码',
  metadataRequired: 'metadata.format 是必填项：文档、模型与测试一致',
  timestampStrict: 'client_timestamp 严格遵循 RFC 3339 的日期与时间取值',
  pullIdentifiers: 'pull 与 manifest 的标识字段必填且类型正确，否则 INVALID_REQUEST 且不进入业务判定',
  modeRequired: 'MODE_REQUIRED 回显请求取值但不带成功响应的 mode 字段',
  refIntegrity: '版本、Blob 与上传会话的引用完整性',
  conflictDirections: '冲突判定必须同时校验 base_version_id 与 base_content_hash',
  conflictNoSideEffects: '冲突场景不产生远端副作用',
  docFixtures: '协议文档引用的夹具与样本全部存在，且场景名双向一致',
  docErrorCodes: '协议文档声明的错误码与字段名与模型常量一致',
  stepEvidenceEffective: '初始状态下每个 step 的状态证据确实在断言链上生效',
  envelopeSuccess: '成功响应同样携带 endpoint / method / allowed_method（RESP-ENVELOPE-001）',
  histRequestComplete: '历史首次请求必须通过完整字段校验，且通过后原样重放仍命中首次结果（HIST-REQUEST-001）',
  histPath: '历史 Change / file / 首次请求 / 幂等结果四方的 path 必须互相一致（HIST-PATH-001）',
  histPointer: '文件当前指针必须等于历史最终版本，且 format / is_deleted 自洽（HIST-POINTER-001）',
  histVersionSource: '有对应 Change 的历史版本必须携带 created_by_device_id 与 created_at（HIST-VERSION-001）',
  reservedOperation: 'reserved_operation_ids 不得与历史 Change 或幂等键重复（OP-ID-RESERVED-001）',
  requestIdRange: 'request_id 序号可用范围是 1..999999，不得生成七位标识（REQUEST-ID-001）',
  initialFile: 'initial_state.files 的 path 与 format 必须符合协议取值域（INITIAL-FILE-001）',
  ledgerReplayClosedLoop: '历史账本通过加载后，原样重放必须命中首次结果（请求校验与重放路径闭环）',
  evidenceRequired: '夹具步骤必须同时携带非空 expected_result 与真实状态证据',
  sampleMatch: '初始版本记录与正文样本逐项对照（完整哈希与字节数）',
  standardRequest: '标准 Request 的 POST JSON 正文必须被真正解析（SYNC-V1-010）',
  fieldSource: 'buildRequest 保留夹具字段来源：header 不复制成 query，同 Vault query.vault_id 允许（SYNC-V1-013）',
  errorEnvelope: '错误响应保留 endpoint / method / allowed_method（含 405 与 404）',
  postQuerySeparation: 'POST 请求体与查询串严格分离，错误按请求体校验（SYNC-V1-005）',
  headerCase: '请求头名称大小写无关：X-Device-Id 与 Idempotency-Key',
  histVersionComplete: '每个由历史 Change 产生的版本都必须与文件格式及首次请求元数据绑定（HIST-VERSION-002）',
  uploadFingerprint: '提交必须核对 completed 上传会话的内容指纹，篡改会话后不得写入任何状态（UPLOAD-FINGERPRINT-001）',
  minAvailableNull: 'initial_state 的 min_available_revision 只有缺省才默认 0，显式 null 必须被拒绝（SYNC-V1-014）',
  pullEnvelope: '统一执行器完整校验 pull 成功响应 envelope 与业务字段（PULL-ENVELOPE-001）',
  mutationJudge: 'mutation-check 的 judge 要求顶层失败集合与 failTests 完全相等（MUTATION-JUDGE-001）',
  // 最终复审（HIST-01..04 / TRACK-01 / BLOB-01 / ROUTE-01 / SUBMIT-01 /
  // MANIFEST-01 / REPLAY-01 / FIXTURE-01 / STATE-01 / REV-01 / MUTATION-01）
  histLineEnding: '历史版本与首次请求的 metadata.line_ending 必须比较字段存在性与取值（HIST-01）',
  histCompressedMeta: '历史版本的 metadata.format 与所属文件绑定，复用版本的删除状态不得因缺 metadata 被误拒（HIST-02）',
  histParentChain: '历史加载不接受更新基准回退，也不接受指向未来版本的 Change（HIST-03）',
  histUrlQuery: '历史首次请求的 URL 查询串必须参与加载校验（HIST-04）',
  trackRequestIdStrict: 'request_log / 幂等账本的 request_id 必须严格是六位字符串（TRACK-01）',
  blobSizeConsistency: '同完整哈希的 Blob 与上传会话不得声明不同大小（BLOB-01）',
  blobReuseError: '已有 Blob 复用失败的错误必须带 upload_content_size，且不改变状态（BLOB-01）',
  routeEncodedVault: '标准 Request 必须能访问 URL 编码的非 ASCII Vault ID（ROUTE-01）',
  submitBinding: 'submit 成功结果必须完整绑定请求与写入状态（SUBMIT-01）',
  manifestBinding: 'manifest 成功响应必须完整校验 header、排序与每个条目的全部字段（MANIFEST-01）',
  replayOptionalKey: '历史首次请求可以省略 Idempotency-Key，且省略后仍可原样重放（REPLAY-01）',
  stateCollections: 'validateInitialState 与 createVaultState 对缺省集合使用一致语义（STATE-01）',
  revisionLinear: 'revision 连续性校验按实际记录检查，不随巨大 vault_revision 线性循环（REV-01）',
  fixtureErrorCode: '错误步骤必须声明非空 expected_result.code（FIXTURE-01）',
  mutationRunner: 'mutation-check 的临时 runner 在失败时必须返回非零退出码（MUTATION-01）',
  histSuccessorScenario: '场景：historical-successor-version（historical-successor-version.json）',
  fixtureShape: '夹具形状：request_sequence 只能出现在 initial_state 内（FIXTURE-SHAPE-001）',
  docMutation: '协议文档第 9 节声明的变异数量必须等于 mutation-check.mjs 的实际数量（DOC-MUTATION-001）',
  fixtureLoaded: '夹具目录非空且五个必需场景全部加载',
};

const scenarioTest = (name) => `场景：${name}（${name}.json）`;

const MUTATIONS = [
  {
    id: 'SYNC-V1-001/001 历史 Change 改 version_id 指向另一文件',
    failTests: [
      scenarioTest('stale-cursor-recovery'),
      T.blobSizeConsistency,
      T.cursorRecovery,
      T.envelopeSuccess,
      T.errorEnvelope,
      T.errorReused,
      T.fieldSource,
      T.hardcodedCursor,
      T.headerCase,
      T.histBaseRevision,
      T.histBlob,
      T.histGraph,
      T.histMetadata,
      T.histPath,
      T.histPointer,
      T.histRequestComplete,
      T.histRequestSet,
      T.histVersionComplete,
      T.histVersionSource,
      T.historyOperation,
      T.historyReplay,
      T.idempotentCrossCheck,
      T.idempotentLedger,
      T.initialFile,
      T.ledgerReplayClosedLoop,
      T.manifestBinding,
      T.methodJoint,
      T.postQuerySeparation,
      T.pullEnvelope,
      T.pullIdentifiers,
      T.requestIdRange,
      T.requestSequence,
      T.reservedOperation,
      T.revisionContinuity,
      T.revisionLinear,
      T.stateDeepCopy,
      T.stepEvidenceEffective,
      T.testAllScenarios,
      T.testMainLoop,
      T.trackRequestId,
      T.trackRequestIdStrict,
    ],
    apply(root) {
      const fixture = readJson(root, FIXTURE_STALE);
      const change = fixture.initial_state.changes.find((item) => item.change_id === 'chg_000005');
      change.version_id = 'ver_beta_01';
      writeJson(root, FIXTURE_STALE, fixture);
    },
  },
  {
    id: 'SYNC-V1-001 历史版本 content_hash 与 Change 脱节',
    failTests: [
      scenarioTest('stale-cursor-recovery'),
      T.blobSizeConsistency,
      T.cursorRecovery,
      T.envelopeSuccess,
      T.errorEnvelope,
      T.errorReused,
      T.fieldSource,
      T.hardcodedCursor,
      T.headerCase,
      T.histBaseRevision,
      T.histBlob,
      T.histGraph,
      T.histMetadata,
      T.histPath,
      T.histPointer,
      T.histRequestComplete,
      T.histRequestSet,
      T.histVersionComplete,
      T.histVersionSource,
      T.historyOperation,
      T.historyReplay,
      T.idempotentCrossCheck,
      T.idempotentLedger,
      T.initialFile,
      T.ledgerReplayClosedLoop,
      T.manifestBinding,
      T.methodJoint,
      T.postQuerySeparation,
      T.pullEnvelope,
      T.pullIdentifiers,
      T.requestIdRange,
      T.requestSequence,
      T.reservedOperation,
      T.revisionContinuity,
      T.revisionLinear,
      T.sampleMatch,
      T.stateDeepCopy,
      T.stepEvidenceEffective,
      T.testAllScenarios,
      T.testMainLoop,
      T.trackRequestId,
      T.trackRequestIdStrict,
    ],
    apply(root) {
      const fixture = readJson(root, FIXTURE_STALE);
      fixture.initial_state.versions.find((item) => item.version_id === 'ver_alpha_02').content_hash = `sha256:${'1'.repeat(64)}`;
      writeJson(root, FIXTURE_STALE, fixture);
    },
  },
  {
    id: 'SYNC-V1-001 首次请求 path 与历史 Change 脱节（并重算指纹）',
    failTests: [
      scenarioTest('stale-cursor-recovery'),
      T.blobSizeConsistency,
      T.cursorRecovery,
      T.envelopeSuccess,
      T.errorEnvelope,
      T.errorReused,
      T.fieldSource,
      T.hardcodedCursor,
      T.headerCase,
      T.histBaseRevision,
      T.histBlob,
      T.histGraph,
      T.histMetadata,
      T.histPath,
      T.histPointer,
      T.histRequestComplete,
      T.histRequestSet,
      T.histVersionComplete,
      T.histVersionSource,
      T.historyOperation,
      T.historyReplay,
      T.idempotentCrossCheck,
      T.idempotentLedger,
      T.initialFile,
      T.ledgerReplayClosedLoop,
      T.manifestBinding,
      T.methodJoint,
      T.postQuerySeparation,
      T.pullEnvelope,
      T.pullIdentifiers,
      T.requestIdRange,
      T.requestSequence,
      T.reservedOperation,
      T.revisionContinuity,
      T.revisionLinear,
      T.stateDeepCopy,
      T.stepEvidenceEffective,
      T.testAllScenarios,
      T.testMainLoop,
      T.trackRequestId,
      T.trackRequestIdStrict,
    ],
    expectError: '与历史 Change 不一致',
    apply(root) {
      const fixture = readJson(root, FIXTURE_STALE);
      fixture.initial_state.idempotency[0].request.body.path = 'projects/other.md';
      writeJson(root, FIXTURE_STALE, fixture);
    },
    afterApply(root) {
      // 用与模型一致的稳定指纹重算，确保失败原因只剩「请求与 Change 脱节」而不是指纹不自洽。
      const script = `
        import { readFileSync, writeFileSync } from 'node:fs';
        import { stableStringify, sha256Of } from './tests/protocol/sync-model.mjs';
        const path = '${FIXTURE_STALE}';
        const fixture = JSON.parse(readFileSync(path, 'utf8'));
        const entry = fixture.initial_state.idempotency[0];
        entry.fingerprint = sha256Of(Buffer.from(stableStringify(entry.request.body), 'utf8'));
        writeFileSync(path, JSON.stringify(fixture, null, 2) + '\\n');
      `;
      write(root, 'rehash.mjs', script);
      execFileSync(process.execPath, ['rehash.mjs'], { cwd: root, stdio: 'pipe' });
      rmSync(join(root, 'rehash.mjs'));
    },
  },
  {
    id: 'SYNC-V1-001 账本 result 与历史 Change 脱节',
    failTests: [
      scenarioTest('stale-cursor-recovery'),
      T.blobSizeConsistency,
      T.cursorRecovery,
      T.envelopeSuccess,
      T.errorEnvelope,
      T.errorReused,
      T.fieldSource,
      T.hardcodedCursor,
      T.headerCase,
      T.histBaseRevision,
      T.histBlob,
      T.histGraph,
      T.histMetadata,
      T.histPath,
      T.histPointer,
      T.histRequestComplete,
      T.histRequestSet,
      T.histVersionComplete,
      T.histVersionSource,
      T.historyOperation,
      T.historyReplay,
      T.idempotentCrossCheck,
      T.idempotentLedger,
      T.initialFile,
      T.ledgerReplayClosedLoop,
      T.manifestBinding,
      T.methodJoint,
      T.postQuerySeparation,
      T.pullEnvelope,
      T.pullIdentifiers,
      T.requestIdRange,
      T.requestSequence,
      T.reservedOperation,
      T.revisionContinuity,
      T.revisionLinear,
      T.stateDeepCopy,
      T.stepEvidenceEffective,
      T.testAllScenarios,
      T.testMainLoop,
      T.trackRequestId,
      T.trackRequestIdStrict,
    ],
    expectError: '与历史 Change 不一致',
    apply(root) {
      const fixture = readJson(root, FIXTURE_STALE);
      fixture.initial_state.idempotency[0].result.change_id = 'chg_000999';
      writeJson(root, FIXTURE_STALE, fixture);
    },
  },
  {
    id: 'SYNC-V1-008 历史 operation_id 不纳入占用账本（只为内容更新建账本）',
    failTests: [
      scenarioTest('stale-cursor-recovery'),
      T.cursorRecovery,
      T.errorReused,
      T.hardcodedCursor,
      T.historyOperation,
      T.snapshotCoverage,
      T.stepEvidenceEffective,
      T.testAllScenarios,
      T.testMainLoop,
    ],
    apply(root) {
      replaceOnce(
        root,
        MODEL,
        `  for (const change of sourceChanges) {
    usedOperations.set(change.operation_id, {`,
        `  for (const change of sourceChanges) {
    if (change.operation !== 'update_file_content') continue;
    usedOperations.set(change.operation_id, {`,
        '只登记内容更新的 operation_id',
      );
    },
  },
  {
    id: 'SYNC-V1-008 忽略已占用 operation_id（允许新增 Change）',
    failTests: [
      scenarioTest('stale-cursor-recovery'),
      T.cursorRecovery,
      T.errorReused,
      T.hardcodedCursor,
      T.historyOperation,
      T.stepEvidenceEffective,
      T.testAllScenarios,
      T.testMainLoop,
    ],
    apply(root) {
      replaceOnce(
        root,
        MODEL,
        `  const used = state.usedOperations.get(body.operation_id);
  if (used) {`,
        `  const used = state.usedOperations.get(body.operation_id);
  if (false && used) {`,
        '跳过已占用 operation_id 检查',
      );
    },
  },
  {
    id: 'SYNC-V1-011 允许 initial_state 缺失中间 revision',
    failTests: [
      scenarioTest('compressed-history-recovery'),
      scenarioTest('file-base-too-old'),
      scenarioTest('historical-single-hash-replay'),
      scenarioTest('historical-successor-version'),
      scenarioTest('other-file-advances-cursor'),
      scenarioTest('stale-cursor-recovery'),
      scenarioTest('update-deleted-file'),
      T.blobSizeConsistency,
      T.conflictDirections,
      T.conflictNoSideEffects,
      T.cursorRecovery,
      T.envelopeSuccess,
      T.errorEnvelope,
      T.errorReused,
      T.fieldSource,
      T.hardcodedCursor,
      T.headerCase,
      T.histBaseRevision,
      T.histBlob,
      T.histCompressedMeta,
      T.histCompression,
      T.histGraph,
      T.histLineEnding,
      T.histMetadata,
      T.histParentChain,
      T.histPath,
      T.histPointer,
      T.histRequestComplete,
      T.histRequestSet,
      T.histSingleHash,
      T.histUrlQuery,
      T.histVersionComplete,
      T.histVersionSource,
      T.historyOperation,
      T.historyReplay,
      T.idempotentCrossCheck,
      T.idempotentLedger,
      T.initialFile,
      T.ledgerReplayClosedLoop,
      T.manifestBinding,
      T.methodJoint,
      T.postQuerySeparation,
      T.pullEnvelope,
      T.pullIdentifiers,
      T.replayOptionalKey,
      T.requestIdRange,
      T.requestSequence,
      T.reservedOperation,
      T.revisionContinuity,
      T.revisionLinear,
      T.snapshotCoverage,
      T.stateDeepCopy,
      T.stepEvidenceEffective,
      T.testAllScenarios,
      T.testCrossFields,
      T.testMainLoop,
      T.trackRequestId,
      T.trackRequestIdStrict,
      T.writeDeleted,
    ],
    apply(root) {
      replaceOnce(
        root,
        MODEL,
        `        if (currentRevision === previousRevision + 1) continue;`,
        `        if (false && currentRevision === previousRevision + 1) continue;`,
        '跳过 revision 连续性校验',
      );
    },
  },
  {
    id: 'SYNC-V1-011 change_id 不检查唯一性',
    failTests: [T.revisionContinuity],
    apply(root) {
      replaceOnce(
        root,
        MODEL,
        `      if (changeIds.has(change.change_id)) problems.push(\`重复的 change_id: \${change.change_id}\`);`,
        `      if (false) problems.push(\`重复的 change_id: \${change.change_id}\`);`,
        '跳过 change_id 唯一性校验',
      );
    },
  },
  {
    id: 'SYNC-V1-011 新 change_id 直接复用历史标识',
    failTests: [T.revisionContinuity],
    expectError: '不得复用历史',
    apply(root) {
      replaceOnce(
        root,
        MODEL,
        `  const used = new Set(state.changes.map((change) => change.change_id));
  const base = baseChangeIdFor(revision);
  if (!used.has(base)) return base;`,
        `  const used = new Set(state.changes.map((change) => change.change_id));
  const base = baseChangeIdFor(revision);
  return base;
  if (!used.has(base)) return base;`,
        'change_id 无条件由 revision 派生',
      );
    },
  },
  {
    id: 'SYNC-V1-012 删除 request_sequence 后从 1 重新开始',
    failTests: [T.requestSequence, T.trackRequestIdStrict],
    apply(root) {
      replaceOnce(
        root,
        MODEL,
        `  const historyNumbers = usedRequestNumbers(initialState);
  const derivedSequence = (historyNumbers.length > 0 ? Math.max(...historyNumbers) : 0) + 1;`,
        `  const derivedSequence = 1;`,
        'request_sequence 不从历史推导',
      );
    },
  },
  {
    id: 'SYNC-V1-012 request_id 唯一性检查被移除',
    failTests: [T.requestSequence, T.trackRequestId],
    expectError: 'request_sequence 与历史冲突',
    apply(root) {
      replaceOnce(
        root,
        MODEL,
        `    } else if (initialState.request_sequence <= maxUsed) {`,
        `    } else if (false && initialState.request_sequence <= maxUsed) {`,
        '跳过 request_sequence 冲突校验',
      );
    },
  },
  {
    id: 'SYNC-V1-009 snapshotState 不含上传会话',
    failTests: [T.snapshotCoverage, T.stateDeepCopy],
    apply(root) {
      replaceOnce(
        root,
        MODEL,
        `    uploads: [...state.uploads].sort(byKey('blob_reference')).map((upload) => deepClone(upload)),`,
        `    uploads: [],`,
        '快照丢弃上传会话',
      );
    },
  },
  {
    id: 'SYNC-V1-009 snapshotState 不含已占用 operation_id',
    failTests: [T.rejectNoState, T.snapshotCoverage],
    apply(root) {
      replaceOnce(
        root,
        MODEL,
        `    used_operations: [...state.usedOperations.entries()]`,
        `    used_operations_unused: [...state.usedOperations.entries()]`,
        '快照改键名丢弃 used_operations',
      );
    },
  },
  {
    id: 'SYNC-V1-009 内容哈希失败分支推进 vault_revision',
    failTests: [
      T.rejectNoState,
      T.stableErrors,
      T.uploadBroken,
      T.uploadFingerprint,
    ],
    expectError: '哈希失败分支不得推进 vault_revision',
    apply(root) {
      replaceOnce(
        root,
        MODEL,
        `  if (actualHash !== body.content_hash || upload.content_hash !== body.content_hash || upload.content_hash !== actualHash) {
    return failWith(409, ERROR_CODES.CONTENT_HASH_MISMATCH,`,
        `  if (actualHash !== body.content_hash || upload.content_hash !== body.content_hash || upload.content_hash !== actualHash) {
    state.vault_revision += 1;
    return failWith(409, ERROR_CODES.CONTENT_HASH_MISMATCH,`,
        '哈希失败时推进 revision',
      );
    },
  },
  {
    id: 'SYNC-V1-009 上传会话被忽略（改坏会话仍放行）',
    failTests: [T.uploadBroken],
    apply(root) {
      replaceOnce(
        root,
        MODEL,
        `  if (!upload || upload.status !== 'completed') {`,
        `  if (!upload) {`,
        '忽略上传会话状态',
      );
    },
  },
  {
    id: 'SYNC-V1-005 错误响应不保留 endpoint/method/allowed_method',
    failTests: [
      scenarioTest('file-base-too-old'),
      scenarioTest('stale-cursor-recovery'),
      T.conflictNoSideEffects,
      T.cursorRecovery,
      T.errorEnvelope,
      T.hardcodedCursor,
      T.manifestBinding,
      T.methodJoint,
      T.stepEvidenceEffective,
      T.testAllScenarios,
      T.testMainLoop,
    ],
    apply(root) {
      replaceOnce(
        root,
        MODEL,
        `  const failWith = (status, code, message, fields = {}) => fail(requestId, status, code, message, fields, envelope);`,
        `  const failWith = (status, code, message, fields = {}) => fail(requestId, status, code, message, fields, {});`,
        '错误响应丢弃定位字段',
      );
    },
  },
  {
    id: 'SYNC-V1-005 请求头大小写敏感',
    failTests: [
      scenarioTest('compressed-history-recovery'),
      scenarioTest('stale-cursor-recovery'),
      scenarioTest('update-deleted-file'),
      T.cursorRecovery,
      T.fieldSource,
      T.hardcodedCursor,
      T.headerCase,
      T.histCompression,
      T.manifestBinding,
      T.methodJoint,
      T.rejectNoState,
      T.routeEncodedVault,
      T.stepEvidenceEffective,
      T.testAllScenarios,
      T.testMainLoop,
      T.writeDeleted,
      T.zeroCursor,
    ],
    apply(root) {
      replaceOnce(
        root,
        MODEL,
        `    if (key.toLowerCase() === target) return value;`,
        `    if (key === name) return value;`,
        '请求头精确匹配',
      );
    },
  },
  {
    id: 'SYNC-V1-005 查询串替代请求体字段',
    failTests: [T.postQuerySeparation],
    expectError: '查询串不得为请求体补字段',
    apply(root) {
      replaceOnce(
        root,
        MODEL,
        `  const identifiers = isManifest
    ? { vault_id: endpoint.vaultFromRoute, device_id: headerValue(headers, 'X-Device-Id') ?? lookup('device_id') }
    : body;`,
        `  const identifiers = isManifest
    ? { vault_id: endpoint.vaultFromRoute, device_id: headerValue(headers, 'X-Device-Id') ?? lookup('device_id') }
    : { ...body, vault_id: body.vault_id ?? lookup('vault_id'), device_id: body.device_id ?? lookup('device_id') };`,
        '查询串补请求体字段',
      );
    },
  },
  {
    id: 'SYNC-V1-007 executedSteps 在断言前登记（登记后继续）',
    failTests: [
      T.manifestBinding,
      T.pullEnvelope,
      T.recordTiming,
      T.submitBinding,
      T.testExpectedResult,
    ],
    expectError: '断言失败的步骤不得登记',
    apply(root) {
      replaceOnce(
        root,
        TEST,
        `    registration.requests.set(step.id, (registration.requests.get(step.id) ?? 0) + 1);`,
        `    registration.steps.add(step.id);
    registration.requests.set(step.id, (registration.requests.get(step.id) ?? 0) + 1);`,
        '提前登记执行记录',
      );
    },
  },
  {
    id: 'SYNC-V1-007 stepEvidenceProblems 接受只有 expect_error_fields 的步骤',
    failTests: [T.evidenceRequired, T.stepEvidenceEffective],
    apply(root) {
      replaceOnce(
        root,
        TEST,
        `    const hasStateEvidence = hasKeys(step.expected_state) || step.expect_state_unchanged === true;`,
        `    const hasStateEvidence = hasKeys(step.expected_state) || step.expect_state_unchanged === true || step.expect_error_fields !== undefined;`,
        '把错误字段当状态证据',
      );
    },
  },
  {
    id: 'SYNC-V1-010 适配层丢弃标准 Request 的 POST 正文',
    failTests: [
      scenarioTest('compressed-history-recovery'),
      scenarioTest('duplicate-request'),
      scenarioTest('file-base-too-old'),
      scenarioTest('historical-single-hash-replay'),
      scenarioTest('historical-successor-version'),
      scenarioTest('other-file-advances-cursor'),
      scenarioTest('request-id-exhausted'),
      scenarioTest('stale-cursor-recovery'),
      scenarioTest('submit-markdown'),
      scenarioTest('update-deleted-file'),
      T.blobReuseError,
      T.combinedInvalid,
      T.conflictDirections,
      T.conflictNoSideEffects,
      T.cursorRecovery,
      T.envelopeSuccess,
      T.errorEnvelope,
      T.errorReused,
      T.fieldSource,
      T.fingerprintSnapshot,
      T.hardcodedCursor,
      T.headerCase,
      T.histCompression,
      T.histMetadata,
      T.histRequestComplete,
      T.histSingleHash,
      T.histUrlQuery,
      T.historyOperation,
      T.idempotentLedger,
      T.ledgerReplayClosedLoop,
      T.manifestBinding,
      T.metadataRequired,
      T.methodJoint,
      T.modeRequired,
      T.postQuerySeparation,
      T.pullEnvelope,
      T.recordTiming,
      T.refIntegrity,
      T.rejectNoState,
      T.replayOptionalKey,
      T.requestIdRange,
      T.requestSequence,
      T.revisionContinuity,
      T.revisionExhausted,
      T.routeEncodedVault,
      T.standardRequest,
      T.stepEvidenceEffective,
      T.submitBinding,
      T.testAllScenarios,
      T.testAsync,
      T.testCrossFields,
      T.testEnvelope,
      T.testExpectedResult,
      T.testMainLoop,
      T.trackRequestId,
      T.uploadBroken,
      T.uploadFingerprint,
      T.writeDeleted,
      T.zeroCursor,
    ],
    expectError: '标准 Request POST 必须成功',
    apply(root) {
      replaceOnce(
        root,
        MODEL,
        `      const text = await input.clone().text();`,
        `      const text = '';`,
        '不读取标准 Request 正文',
      );
    },
  },
  {
    id: 'SYNC-V1-003 绑定游标用真值判断（boundCursor || undefined）',
    failTests: [T.zeroCursor],
    expectError: '执行器必须把 manifest 派生的游标注入请求',
    apply(root) {
      replaceOnce(
        root,
        TEST,
        `  const body = boundCursor !== undefined
    ? { ...(fixtureRequest.body ?? {}), last_server_revision: boundCursor }`,
        `  const body = (boundCursor || undefined) !== undefined
    ? { ...(fixtureRequest.body ?? {}), last_server_revision: boundCursor || undefined }`,
        '真值判断绑定游标',
      );
    },
  },
  {
    id: 'SYNC-V1-013 buildRequest 丢弃 query.vault_id（不再忠实传递夹具查询串）',
    failTests: [
      scenarioTest('stale-cursor-recovery'),
      T.cursorRecovery,
      T.fieldSource,
      T.hardcodedCursor,
      T.stepEvidenceEffective,
      T.testAllScenarios,
      T.testEnvelope,
      T.testMainLoop,
    ],
    expectError: 'query.vault_id 必须被保留',
    apply(root) {
      // buildRequest 必须忠实传递夹具 query；把 vault_id 过滤掉会让「同 Vault query.vault_id 允许」的证据消失。
      replaceOnce(
        root,
        TEST,
        `  for (const [key, value] of Object.entries(fixtureQuery)) url.searchParams.set(key, String(value));`,
        `  for (const [key, value] of Object.entries(fixtureQuery)) {
    if (key === 'vault_id') continue;
    url.searchParams.set(key, String(value));
  }`,
        '丢弃 query.vault_id',
      );
    },
  },
  {
    id: 'SYNC-V1-013 buildRequest 把 header device_id 复制进 query',
    failTests: [T.fieldSource],
    expectError: '请求头里的 device_id 不得被复制成查询参数',
    apply(root) {
      replaceOnce(
        root,
        TEST,
        `  const headers = { ...(fixtureRequest.headers ?? {}) };`,
        `  const headers = { ...(fixtureRequest.headers ?? {}) };
  const headerDevice = Object.entries(headers).find(([key]) => key.toLowerCase() === 'x-device-id')?.[1];
  if (headerDevice !== undefined) url.searchParams.set('device_id', String(headerDevice));`,
        '把 header device_id 复制进 query',
      );
    },
  },
  {
    id: 'SYNC-V1-005 POST 请求体 vault_id 错误但被查询串掩盖',
    failTests: [T.postQuerySeparation],
    expectError: '请求体 vault_id 错误必须返回 400',
    apply(root) {
      replaceOnce(
        root,
        MODEL,
        `  if (!isManifest && body.vault_id !== state.vault_id) {`,
        `  if (!isManifest && body.vault_id !== state.vault_id && queryVaultId === undefined) {`,
        '查询串掩盖请求体 Vault',
      );
    },
  },
  {
    id: '跳过去重（幂等账本查询）',
    failTests: [
      scenarioTest('duplicate-request'),
      scenarioTest('historical-single-hash-replay'),
      scenarioTest('historical-successor-version'),
      scenarioTest('stale-cursor-recovery'),
      T.cursorRecovery,
      T.envelopeSuccess,
      T.errorReused,
      T.fingerprintSnapshot,
      T.hardcodedCursor,
      T.histRequestComplete,
      T.histSingleHash,
      T.histUrlQuery,
      T.idempotentLedger,
      T.ledgerReplayClosedLoop,
      T.manifestBinding,
      T.replayOptionalKey,
      T.requestSequence,
      T.standardRequest,
      T.stepEvidenceEffective,
      T.testAllScenarios,
      T.testMainLoop,
    ],
    apply(root) {
      replaceOnce(
        root,
        MODEL,
        `  const recorded = state.idempotency.get(body.operation_id);
  if (recorded) {`,
        `  const recorded = state.idempotency.get(body.operation_id);
  if (false && recorded) {`,
        '跳过幂等账本',
      );
    },
  },
  {
    id: '改用 vault_revision 拒绝提交',
    failTests: [
      scenarioTest('file-base-too-old'),
      scenarioTest('other-file-advances-cursor'),
      T.conflictDirections,
      T.conflictNoSideEffects,
      T.rejectNoState,
      T.testAllScenarios,
      T.testMainLoop,
    ],
    apply(root) {
      replaceOnce(
        root,
        MODEL,
        `  const versionMatches = !providedVersion || body.base_version_id === file.current_version_id;
  const hashMatches = !providedHash || body.base_content_hash === file.current_content_hash;`,
        `  const versionMatches = body.base_revision === state.vault_revision;
  const hashMatches = true;`,
        '用 vault_revision 判断冲突',
      );
    },
  },
  {
    id: '只检查 base_version_id（去掉 hashMatches）',
    failTests: [
      scenarioTest('file-base-too-old'),
      T.conflictDirections,
      T.conflictNoSideEffects,
      T.testAllScenarios,
      T.testMainLoop,
    ],
    expectError: '版本匹配但哈希过旧',
    apply(root) {
      replaceOnce(
        root,
        MODEL,
        `  const hashMatches = !providedHash || body.base_content_hash === file.current_content_hash;`,
        `  const hashMatches = true;`,
        '去掉 hashMatches',
      );
    },
  },
  {
    id: '文档与夹具脱节：把某一步的状态证据删掉',
    failTests: [
      scenarioTest('stale-cursor-recovery'),
      T.cursorRecovery,
      T.evidenceRequired,
      T.fixtureLoaded,
      T.hardcodedCursor,
      T.manifestBinding,
      T.pullEnvelope,
      T.stepEvidenceEffective,
      T.testAllScenarios,
      T.testMainLoop,
    ],
    expectError: 'expect_error_fields 不能替代状态证据',
    apply(root) {
      const fixture = readJson(root, FIXTURE_STALE);
      const step = fixture.steps.find((item) => item.id === 'pull-below-lower-bound');
      delete step.expect_state_unchanged;
      writeJson(root, FIXTURE_STALE, fixture);
    },
  },
  {
    id: '模型新增未写入文档的错误码',
    failTests: [T.docErrorCodes],
    expectError: '协议文档必须记录错误码',
    apply(root) {
      replaceOnce(
        root,
        MODEL,
        `  CURSOR_TOO_OLD: 'CURSOR_TOO_OLD',`,
        `  CURSOR_TOO_OLD: 'CURSOR_TOO_OLD',
  UNDOCUMENTED_FAILURE: 'UNDOCUMENTED_FAILURE',`,
        '新增未记录的错误码',
      );
    },
  },
  {
    id: '夹具标题与文档清单脱节',
    failTests: [T.docFixtures],
    expectError: '必须出现在协议文档的清单里',
    apply(root) {
      const fixture = readJson(root, FIXTURE_STALE);
      fixture.title = '被改掉的标题';
      writeJson(root, FIXTURE_STALE, fixture);
    },
  },
  {
    id: '允许从过期游标续拉（判定改成 cursor < min - 1）',
    failTests: [
      scenarioTest('stale-cursor-recovery'),
      T.cursorRecovery,
      T.hardcodedCursor,
      T.manifestBinding,
      T.stepEvidenceEffective,
      T.testAllScenarios,
      T.testMainLoop,
    ],
    expectError: 'pull-two-below-lower-bound',
    apply(root) {
      replaceOnce(
        root,
        MODEL,
        `  if (cursor < state.min_available_revision) {`,
        `  if (cursor < state.min_available_revision - 1) {`,
        '游标下界判定偏移',
      );
    },
  },
  {
    id: 'RESP-ENVELOPE-001 成功响应丢弃 endpoint/method/allowed_method',
    failTests: [
      scenarioTest('compressed-history-recovery'),
      scenarioTest('duplicate-request'),
      scenarioTest('file-base-too-old'),
      scenarioTest('historical-single-hash-replay'),
      scenarioTest('historical-successor-version'),
      scenarioTest('other-file-advances-cursor'),
      scenarioTest('request-id-exhausted'),
      scenarioTest('stale-cursor-recovery'),
      scenarioTest('submit-markdown'),
      scenarioTest('update-deleted-file'),
      T.conflictNoSideEffects,
      T.cursorRecovery,
      T.envelopeSuccess,
      T.hardcodedCursor,
      T.histCompression,
      T.manifestBinding,
      T.pullEnvelope,
      T.recordTiming,
      T.replayOptionalKey,
      T.routeEncodedVault,
      T.stepEvidenceEffective,
      T.submitBinding,
      T.testAllScenarios,
      T.testAsync,
      T.testEnvelope,
      T.testExpectedResult,
      T.testMainLoop,
      T.writeDeleted,
      T.zeroCursor,
    ],
    expectError: '响应必须包含 endpoint 字段',
    apply(root) {
      replaceOnce(
        root,
        MODEL,
        `const ok = (requestId, fields, envelope) => ({
  status: 200,
  body: {
    protocol_version: PROTOCOL_VERSION,
    request_id: requestId,
    ...fields,
    // 定位字段最后展开：即使业务字段意外同名，回显的也一定是真实请求的路径 / 方法 / 允许方法。
    ...envelope,
  },
});`,
        `const ok = (requestId, fields) => ({
  status: 200,
  body: {
    protocol_version: PROTOCOL_VERSION,
    request_id: requestId,
    ...fields,
  },
});`,
        '成功响应丢弃定位字段',
      );
    },
  },
  {
    id: 'RESP-ENVELOPE-001 成功响应的 allowed_method 恒为 null',
    failTests: [
      scenarioTest('compressed-history-recovery'),
      scenarioTest('duplicate-request'),
      scenarioTest('file-base-too-old'),
      scenarioTest('historical-single-hash-replay'),
      scenarioTest('historical-successor-version'),
      scenarioTest('other-file-advances-cursor'),
      scenarioTest('request-id-exhausted'),
      scenarioTest('stale-cursor-recovery'),
      scenarioTest('submit-markdown'),
      scenarioTest('update-deleted-file'),
      T.conflictNoSideEffects,
      T.cursorRecovery,
      T.envelopeSuccess,
      T.hardcodedCursor,
      T.histCompression,
      T.manifestBinding,
      T.pullEnvelope,
      T.recordTiming,
      T.replayOptionalKey,
      T.stepEvidenceEffective,
      T.submitBinding,
      T.testAllScenarios,
      T.testAsync,
      T.testEnvelope,
      T.testExpectedResult,
      T.testMainLoop,
      T.writeDeleted,
      T.zeroCursor,
    ],
    expectError: 'allowed_method 必须是该端点唯一合法的方法',
    apply(root) {
      replaceOnce(
        root,
        MODEL,
        `  const okWith = (fields) => ok(requestId, fields, envelope);`,
        `  const okWith = (fields) => ok(requestId, fields, { ...envelope, allowed_method: null });`,
        '成功响应 allowed_method 恒为 null',
      );
    },
  },
  {
    id: 'HIST-REQUEST-001 首次请求只做存在性比对、不校验字段类型与值域',
    failTests: [T.histRequestComplete],
    apply(root) {
      replaceOnce(
        root,
        MODEL,
        `    if (!isNonEmptyString(requestBody[field])) {`,
        `    if (false && !isNonEmptyString(requestBody[field])) {`,
        '跳过首次请求的字段类型校验',
      );
    },
  },
  {
    id: 'HIST-REQUEST-001 首次请求不校验 metadata.line_ending 值域',
    failTests: [T.histRequestComplete],
    apply(root) {
      replaceOnce(
        root,
        MODEL,
        // 三处枚举校验全部去掉：请求侧、共享比对的 actual 侧与对照侧。
        // 只去掉请求侧不够——共享比对仍会报出包含同一段文字的诊断，掩盖校验缺失。
        `    if (Object.hasOwn(metadata, 'line_ending') && !LINE_ENDINGS.includes(metadata.line_ending)) {`,
        `    if (false && Object.hasOwn(metadata, 'line_ending') && !LINE_ENDINGS.includes(metadata.line_ending)) {`,
        '跳过首次请求 line_ending 值域',
      );
      replaceOnce(
        root,
        MODEL,
        `  if (actualHas && !LINE_ENDINGS.includes(actual.line_ending)) {`,
        `  if (false && actualHas && !LINE_ENDINGS.includes(actual.line_ending)) {`,
        '跳过共享比对的 actual 侧值域',
      );
      replaceOnce(
        root,
        MODEL,
        `  if (expectedHas && !LINE_ENDINGS.includes(expected.line_ending)) {`,
        `  if (false && expectedHas && !LINE_ENDINGS.includes(expected.line_ending)) {`,
        '跳过共享比对的对照侧值域',
      );
    },
  },
  {
    id: 'HIST-PATH-001 Change.path 不再与 file.path 绑定',
    failTests: [T.histPath],
    expectError: 'Change.path 与 file.path 脱节',
    apply(root) {
      replaceOnce(
        root,
        MODEL,
        `  } else if (file && file.path !== change.path) {`,
        `  } else if (false && file && file.path !== change.path) {`,
        '跳过 Change.path 与 file.path 绑定',
      );
    },
  },
  {
    id: 'HIST-POINTER-001 文件当前指针不按历史最终版本校验',
    failTests: [T.histPointer],
    expectError: '历史最终版本',
    apply(root) {
      replaceOnce(
        root,
        MODEL,
        `    if ((file.current_version_id ?? null) !== expectedVersion.version_id) {`,
        `    if (false && (file.current_version_id ?? null) !== expectedVersion.version_id) {`,
        '跳过当前指针派生校验',
      );
    },
  },
  {
    id: 'HIST-POINTER-001 is_deleted 不按最后一个 Change 推导',
    failTests: [T.histPointer, T.writeDeleted],
    apply(root) {
      replaceOnce(
        root,
        MODEL,
        `    if (actualDeleted !== expectedDeleted) {`,
        `    if (false && actualDeleted !== expectedDeleted) {`,
        '跳过 is_deleted 派生校验',
      );
    },
  },
  {
    id: 'HIST-VERSION-001 版本来源字段回到「存在才比较」',
    failTests: [T.histVersionComplete, T.histVersionSource],
    apply(root) {
      replaceOnce(
        root,
        MODEL,
        `    if (!isNonEmptyString(version.created_by_device_id)) {`,
        `    if (false) {`,
        '版本创建设备缺失时不报错',
      );
    },
  },
  {
    id: 'HIST-VERSION-001 created_at 缺失时不报错',
    failTests: [T.histVersionSource],
    apply(root) {
      replaceOnce(
        root,
        MODEL,
        `    if (!isRfc3339Utc(version.created_at)) {`,
        `    if (false) {`,
        '版本创建时间缺失时不报错',
      );
    },
  },
  {
    id: 'OP-ID-RESERVED-001 reserved_operation_ids 允许与历史 Change 重复',
    failTests: [T.reservedOperation],
    expectError: 'reserved_operation_ids 与历史 Change 重复必须在加载阶段被发现',
    apply(root) {
      replaceOnce(
        root,
        MODEL,
        `    if (changeOperations.has(operationId)) {`,
        `    if (false && changeOperations.has(operationId)) {`,
        '跳过 reserved 与历史 Change 的重复校验',
      );
    },
  },
  {
    id: 'REQUEST-ID-001 request_sequence 不校验六位上界',
    failTests: [T.requestIdRange],
    expectError: 'request_sequence=1000000',
    apply(root) {
      replaceOnce(
        root,
        MODEL,
        `    } else if (initialState.request_sequence > MAX_REQUEST_SEQUENCE) {`,
        `    } else if (false) {`,
        '跳过 request_sequence 上界校验',
      );
    },
  },
  {
    id: 'REQUEST-ID-001 nextRequestId 静默生成七位标识',
    failTests: [
      scenarioTest('request-id-exhausted'),
      T.requestIdRange,
      T.revisionExhausted,
      T.testAllScenarios,
      T.testEnvelope,
      T.trackRequestId,
    ],
    expectError: '序号用尽必须返回 503',
    apply(root) {
      replaceOnce(
        root,
        MODEL,
        `    if (state.request_sequence < 1 || state.request_sequence > MAX_REQUEST_SEQUENCE) {`,
        `    if (false) {`,
        'nextRequestId 不检查序号上界',
      );
    },
  },
  {
    id: 'INITIAL-FILE-001 文件 path 不校验规范化',
    failTests: [T.initialFile],
    expectError: '必须由文件级校验拒绝',
    apply(root) {
      replaceOnce(
        root,
        MODEL,
        `    if (!isNormalizedPath(file.path)) {`,
        `    if (false) {`,
        '跳过文件 path 规范化校验',
      );
    },
  },
  {
    id: 'INITIAL-FILE-001 文件 format 不校验取值域',
    failTests: [T.initialFile],
    expectError: '必须由文件级取值域校验拒绝',
    apply(root) {
      replaceOnce(
        root,
        MODEL,
        `    if (!METADATA_FORMATS.includes(file.format)) {`,
        `    if (false) {`,
        '跳过文件 format 取值域校验',
      );
    },
  },
  {
    id: 'DOC-MUTATION-001 协议文档把变异数量写回 29',
    failTests: [T.docMutation],
    expectError: '协议文档声明的变异数量',
    apply(root) {
      replaceOnce(
        root,
        DOC,
        /然后逐个应用 (\d+) 个变异/g,
        '然后逐个应用 29 个变异',
        '文档变异数量写错',
      );
    },
  },
  {
    id: 'FIXTURE-SHAPE-001 夹具顶层多出一个未消费的 request_sequence',
    failTests: [T.fixtureShape],
    expectError: 'request_sequence 不得出现在顶层',
    apply(root) {
      const fixture = readJson(root, FIXTURE_STALE);
      fixture.request_sequence = fixture.initial_state.request_sequence;
      writeJson(root, FIXTURE_STALE, fixture);
    },
  },

  /* ---- 最终评审新增：历史基准 / 版本图 / 压缩 / 写入 / 错误 / 状态 / 边界 ---- */
  {
    id: 'HIST-01 历史基准硬编码要求 base_version_id（拒绝单哈希基准）',
    failTests: [
      scenarioTest('historical-single-hash-replay'),
      T.histSingleHash,
      T.histUrlQuery,
      T.testAllScenarios,
    ],
    expectError: 'base_version_id',
    apply(root) {
      replaceOnce(
        root,
        MODEL,
        `  if (providedVersion) {
    mismatches.push(['base_version_id', requestBody.base_version_id, version.base_version_id ?? null]);
  }`,
        `  if (!providedVersion) {
    problems.push('首次请求必须提供 base_version_id');
  }
  if (providedVersion) {
    mismatches.push(['base_version_id', requestBody.base_version_id, version.base_version_id ?? null]);
  }`,
        '单哈希历史请求被判为基准缺失',
      );
    },
  },
  {
    id: 'HIST-02 账本允许不可重放的历史操作进入首次结果',
    failTests: [T.histRequestSet],
    expectError: '不可重放的历史首次结果必须被拒绝',
    apply(root) {
      replaceOnce(
        root,
        MODEL,
        `  } else if (!EXECUTABLE.has(requestBody.operation)) {`,
        `  } else if (false) {`,
        '允许未来操作进入可重放请求校验',
      );
    },
    afterApply(root) {
      replaceOnce(
        root,
        MODEL,
        `    if (!EXECUTABLE.has(change.operation)) {`,
        `    if (false) {`,
        '允许未来操作进入可重放账本校验',
      );
    },
  },
  {
    id: 'HIST-02 历史请求的 query.vault_id 不参与校验',
    failTests: [T.histRequestSet, T.histUrlQuery],
    apply(root) {
      replaceOnce(
        root,
        MODEL,
        `        if (queryVault !== undefined && queryVault !== initialState.vault_id) {`,
        `        if (false && queryVault !== undefined && queryVault !== initialState.vault_id) {`,
        '跳过历史 query vault 校验',
      );
    },
  },
  {
    id: 'HIST-03 blob_reference 不与上传样本内容绑定',
    failTests: [T.histBlob],
    expectError: '上传样本',
    apply(root) {
      replaceOnce(
        root,
        MODEL,
        `      if (!isSha256(upload.content_hash) || upload.content_hash !== requestBody.content_hash) {`,
        `      if (false) {`,
        '跳过上传样本哈希绑定',
      );
    },
  },
  {
    id: 'HIST-04 父版本不校验同一 file_id',
    failTests: [T.histGraph],
    apply(root) {
      replaceOnce(
        root,
        MODEL,
        `    if (parent.file_id !== version.file_id) {`,
        `    if (false) {`,
        '跳过父版本同文件校验',
      );
    },
  },
  {
    id: 'HIST-04 父版本不校验先后顺序，也不检测环',
    failTests: [T.histCompression, T.histGraph],
    apply(root) {
      // 同时移除「父必须早于子」与环检测：只靠父子链扫描本身不再拦下成环初态。
      replaceOnce(
        root,
        MODEL,
        `    if (!(parent.vault_revision < version.vault_revision)) {`,
        `    if (false) {`,
        '跳过父版本先后校验',
      );
    },
    afterApply(root) {
      replaceOnce(
        root,
        MODEL,
        `      if (seen.has(parent.version_id)) {`,
        `      if (false) {`,
        '跳过环检测',
      );
    },
  },
  {
    id: 'HIST-05 缺少保留 Change 时强制 current_version_id = null',
    failTests: [T.histCompression, T.histGraph],
    apply(root) {
      replaceOnce(
        root,
        MODEL,
        `      if (!pointer) {
        problems.push(
          \`文件 \${file.file_id} 没有保留的 Change，current_version_id 必须指向该文件在压缩下界内的最终版本（当前为 \${JSON.stringify(file.current_version_id)}）\`,
        );
        continue;
      }`,
        `      if (!pointer) {
        continue;
      }`,
        '缺少保留 Change 时不再要求可证明指针',
      );
    },
  },
  {
    id: 'HIST-05 缺少保留 Change 时拒绝任何非 null 指针',
    failTests: [
      scenarioTest('compressed-history-recovery'),
      T.histCompressedMeta,
      T.histCompression,
      T.histGraph,
      T.histVersionComplete,
      T.testAllScenarios,
    ],
    expectError: '最终版本',
    apply(root) {
      replaceOnce(
        root,
        MODEL,
        `      const fileVersions = versions.filter((version) => version?.file_id === file.file_id);`,
        `      if ((file.current_version_id ?? null) !== null) {
        problems.push(\`文件 \${file.file_id} 没有保留的 Change，current_version_id 必须为 null（历史最终版本）\`);
        continue;
      }
      const fileVersions = versions.filter((version) => version?.file_id === file.file_id);`,
        '旧语义：没有 Change 就强制 null',
      );
    },
  },
  {
    id: 'HIST-06 base_revision 边界退回 <= N',
    failTests: [T.histBaseRevision],
    expectError: 'base_revision',
    apply(root) {
      replaceOnce(
        root,
        MODEL,
        `  if (isNonNegativeInt(requestBody.base_revision) && requestBody.base_revision > change.vault_revision - 1) {`,
        `  if (isNonNegativeInt(requestBody.base_revision) && requestBody.base_revision > change.vault_revision) {`,
        '把写入前 revision 边界放回 N',
      );
    },
  },
  {
    id: 'HIST-07 新版本不保存 metadata',
    failTests: [
      scenarioTest('compressed-history-recovery'),
      scenarioTest('duplicate-request'),
      scenarioTest('file-base-too-old'),
      scenarioTest('other-file-advances-cursor'),
      scenarioTest('stale-cursor-recovery'),
      scenarioTest('submit-markdown'),
      scenarioTest('update-deleted-file'),
      T.conflictNoSideEffects,
      T.cursorRecovery,
      T.hardcodedCursor,
      T.histCompression,
      T.histMetadata,
      T.manifestBinding,
      T.recordTiming,
      T.stepEvidenceEffective,
      T.submitBinding,
      T.testAllScenarios,
      T.testAsync,
      T.testExpectedResult,
      T.testMainLoop,
      T.writeDeleted,
    ],
    apply(root) {
      replaceOnce(
        root,
        MODEL,
        `    metadata: {
      format: body.metadata.format,
      ...(body.metadata.line_ending !== undefined ? { line_ending: body.metadata.line_ending } : {}),
    },`,
        `    metadata: {},`,
        '新版本丢失 metadata',
      );
    },
  },
  {
    id: 'HIST-07 line_ending 只在存在时才比较',
    failTests: [T.histVersionComplete],
    expectError: 'line_ending',
    apply(root) {
      // 两处都必须放宽才能让「单方删除 line_ending」漏过：版本自身的来源核对
      // （historicalChangeProblems）与首次请求的逐项核对（historicalRequestProblems）。
      // 只放宽其中一处仍会失败，因此这里一次性改掉两处，覆盖完整的存在性语义。
      // 两处核对共用 `lineEndingPresenceProblems`：把「存在性比较」退化成
      // 「字段存在时才比较取值」，单方缺失就会被静默放过。
      replaceOnce(
        root,
        MODEL,
        `  if (actualHas !== expectedHas) {`,
        `  if (false && actualHas !== expectedHas) {`,
        'line_ending 存在性比较退化',
      );
    },
  },
  {
    id: 'WRITE-01 成功更新已删除文件后不恢复 is_deleted',
    failTests: [
      scenarioTest('update-deleted-file'),
      T.testAllScenarios,
      T.writeDeleted,
    ],
    apply(root) {
      replaceOnce(
        root,
        MODEL,
        `  file.is_deleted = false;`,
        `  file.is_deleted = file.is_deleted === true;`,
        '内容更新不恢复 is_deleted',
      );
    },
  },
  {
    id: 'ERROR-01 IDEMPOTENCY_KEY_REUSED 不返回 change_id / replayable',
    failTests: [
      scenarioTest('stale-cursor-recovery'),
      T.cursorRecovery,
      T.errorReused,
      T.hardcodedCursor,
      T.manifestBinding,
      T.stepEvidenceEffective,
      T.testAllScenarios,
      T.testMainLoop,
    ],
    apply(root) {
      replaceOnce(
        root,
        MODEL,
        `        change_id: recordedChangeId,
        original_request_id: recorded.request_id,
        replayable: true,`,
        `        original_request_id: recorded.request_id,`,
        '复用错误缺少 change_id / replayable',
      );
    },
  },
  {
    id: 'TRACK-01 接受 req_000000',
    failTests: [T.trackRequestId, T.trackRequestIdStrict],
    apply(root) {
      replaceOnce(
        root,
        MODEL,
        `  if (!Number.isSafeInteger(number) || number < 1 || number > MAX_REQUEST_SEQUENCE) return null;`,
        `  if (!Number.isSafeInteger(number) || number > MAX_REQUEST_SEQUENCE) return null;`,
        '接受 req_000000',
      );
    },
  },
  {
    id: 'STATE-01 snapshotState 浅拷贝版本 metadata',
    failTests: [T.stateDeepCopy],
    apply(root) {
      replaceOnce(
        root,
        MODEL,
        `    versions: [...state.versions].sort(byKey('version_id')).map((version) => deepClone(version)),`,
        `    versions: [...state.versions].sort(byKey('version_id')).map((version) => ({ ...version })),`,
        '快照浅拷贝版本',
      );
    },
  },
  {
    id: 'STATE-01 createVaultState 浅拷贝版本 metadata',
    failTests: [
      T.blobSizeConsistency,
      T.manifestBinding,
      T.revisionLinear,
      T.stateDeepCopy,
      T.trackRequestIdStrict,
    ],
    apply(root) {
      replaceOnce(
        root,
        MODEL,
        `  const versions = sourceVersions.map((version) => deepClone(version));`,
        `  const versions = sourceVersions.map((version) => ({ ...version }));`,
        '建库浅拷贝版本',
      );
    },
  },
  {
    id: 'REV-01 移除 revision 耗尽检测',
    failTests: [T.revisionExhausted],
    apply(root) {
      replaceOnce(
        root,
        MODEL,
        `  if (state.vault_revision >= MAX_SAFE_REVISION) {`,
        `  if (false) {`,
        'revision 加一前不检测耗尽',
      );
    },
  },
  {
    id: 'TEST-01 删除 expected_result 深子集断言分支',
    failTests: [T.pullEnvelope, T.testExpectedResult],
    apply(root) {
      replaceOnce(
        root,
        TEST,
        `    if (step.expected_result) {
      assertSubset(response.body, step.expected_result, \`步骤 \${step.id} 响应\`);
    }`,
        `    if (false && step.expected_result) {
      assertSubset(response.body, step.expected_result, \`步骤 \${step.id} 响应\`);
    }`,
        '删除 expected_result 断言',
      );
    },
  },
  {
    id: 'TEST-02 Change.operation_id 不取自请求',
    failTests: [
      scenarioTest('compressed-history-recovery'),
      scenarioTest('duplicate-request'),
      scenarioTest('file-base-too-old'),
      scenarioTest('other-file-advances-cursor'),
      scenarioTest('stale-cursor-recovery'),
      scenarioTest('submit-markdown'),
      scenarioTest('update-deleted-file'),
      T.conflictNoSideEffects,
      T.cursorRecovery,
      T.hardcodedCursor,
      T.histCompression,
      T.manifestBinding,
      T.recordTiming,
      T.stepEvidenceEffective,
      T.submitBinding,
      T.testAllScenarios,
      T.testAsync,
      T.testCrossFields,
      T.testExpectedResult,
      T.testMainLoop,
      T.writeDeleted,
    ],
    apply(root) {
      replaceOnce(
        root,
        MODEL,
        `    operation_id: body.operation_id,
    device_id: body.device_id,
    client_timestamp: body.client_timestamp,
    created_at: body.client_timestamp,
  });
  state.vault_revision = revision;`,
        `    operation_id: 'op_wrong_operation_id',
    device_id: body.device_id,
    client_timestamp: body.client_timestamp,
    created_at: body.client_timestamp,
  });
  state.vault_revision = revision;`,
        'Change.operation_id 写错',
      );
    },
  },
  {
    id: 'TEST-02 pull 返回的 Change 改错 device_id',
    failTests: [
      scenarioTest('compressed-history-recovery'),
      scenarioTest('file-base-too-old'),
      scenarioTest('other-file-advances-cursor'),
      scenarioTest('stale-cursor-recovery'),
      scenarioTest('submit-markdown'),
      T.conflictNoSideEffects,
      T.cursorRecovery,
      T.hardcodedCursor,
      T.histCompression,
      T.manifestBinding,
      T.pullEnvelope,
      T.recordTiming,
      T.stepEvidenceEffective,
      T.submitBinding,
      T.testAllScenarios,
      T.testAsync,
      T.testCrossFields,
      T.testExpectedResult,
      T.testMainLoop,
    ],
    apply(root) {
      replaceOnce(
        root,
        MODEL,
        `    .map((change) => deepClone(change));`,
        `    .map((change) => ({ ...deepClone(change), device_id: 'device_wrong' }));`,
        'pull 篡改 device_id',
      );
    },
  },
  {
    id: 'TEST-03 主循环跳过一个必需具名场景',
    failTests: [
      T.testAllScenarios,
      T.testAsync,
      T.testMainLoop,
    ],
    apply(root) {
      replaceOnce(
        root,
        TEST,
        `for (const { scenario, name } of SCENARIOS) {
  test(\`场景：\${scenario.scenario}（\${name}）\`, async () => {`,
        `for (const { scenario, name } of SCENARIOS.filter((entry) => entry.name !== 'submit-markdown.json')) {
  test(\`场景：\${scenario.scenario}（\${name}）\`, async () => {`,
        '主循环漏掉必需场景',
      );
    },
  },
  {
    id: 'TEST-04 模型不 await 异步上传解析',
    failTests: [
      scenarioTest('submit-markdown'),
      T.recordTiming,
      T.submitBinding,
      T.testAllScenarios,
      T.testAsync,
      T.testExpectedResult,
      T.testMainLoop,
    ],
    apply(root) {
      replaceOnce(
        root,
        MODEL,
        `  const bytes = await ctx.resolveUpload(body.blob_reference);`,
        `  const bytes = ctx.resolveUpload(body.blob_reference);`,
        '去掉 resolveUpload 的 await',
      );
    },
  },
  {
    id: 'TEST-05 buildRequest 提前拦截 query.vault_id 不匹配',
    failTests: [
      scenarioTest('stale-cursor-recovery'),
      T.cursorRecovery,
      T.hardcodedCursor,
      T.stepEvidenceEffective,
      T.testAllScenarios,
      T.testEnvelope,
      T.testMainLoop,
    ],
    apply(root) {
      replaceOnce(
        root,
        TEST,
        `  for (const [key, value] of Object.entries(fixtureQuery)) url.searchParams.set(key, String(value));`,
        `  assert.ok(
    fixtureQuery.vault_id === undefined || fixtureQuery.vault_id === routeVault,
    \`步骤 \${step.id}: 查询参数的 vault_id 必须与路由一致\`,
  );
  for (const [key, value] of Object.entries(fixtureQuery)) url.searchParams.set(key, String(value));`,
        '执行器提前拦截 query vault',
      );
    },
  },
  {
    id: '快照后使用旧游标续拉（游标写死为 6）',
    failTests: [
      scenarioTest('stale-cursor-recovery'),
      T.cursorRecovery,
      T.hardcodedCursor,
      T.stepEvidenceEffective,
      T.testAllScenarios,
      T.testMainLoop,
      T.zeroCursor,
    ],
    apply(root) {
      replaceOnce(
        root,
        TEST,
        `      boundCursor = source.body[sourceField];`,
        `      boundCursor = 6;`,
        '续拉游标写死为 6',
      );
    },
  },

  /* ---- 最终 Codex 评审（SYNC-V1-REVIEW-001..005）新增 ---- */
  {
    id: 'REVIEW-001 非当前历史版本的 metadata.format 不再与文件格式绑定',
    failTests: [T.histCompressedMeta, T.histVersionComplete],
    expectError: 'metadata.format',
    apply(root) {
      replaceOnce(
        root,
        MODEL,
        `        version.metadata.format !== owningFile.format`,
        `        false && version.metadata.format !== owningFile.format`,
        '版本 metadata.format 不再与文件格式比对',
      );
      // 同一语义在「有对应版本创建 Change」的逐项核对里还有一处：
      // 必须同时去掉，才真正表达「metadata.format 不再与文件格式绑定」。
      replaceOnce(
        root,
        MODEL,
        `        if (version.metadata.format !== fileFormat) {`,
        `        if (false) {`,
        '历史 Change 侧不再比对版本 format',
      );
    },
  },
  {
    id: 'REVIEW-001 非当前历史版本不再核对首次请求 metadata.line_ending',
    failTests: [T.histVersionComplete],
    expectError: 'line_ending',
    apply(root) {
      // line_ending 只存在于「首次请求 metadata ↔ 版本 metadata」之间（文件 format 里没有该字段），
      // 因此去掉这段逐版本比对后，单方删除或改值的非当前历史版本就不再被发现。
      replaceOnce(
        root,
        MODEL,
        `        problems.push(...lineEndingPresenceProblems(version.metadata, firstRequestMetadata, \`版本 \${version.version_id}\`));`,
        `        void lineEndingPresenceProblems;`,
        '版本 metadata.line_ending 不再与首次请求比对',
      );
    },
  },
  {
    id: 'REVIEW-001 版本来源字段只在当前指针版本上核对（逐版本核对退化）',
    failTests: [T.histCompressedMeta, T.histVersionComplete],
    expectError: '必须被发现',
    apply(root) {
      // 只为「文件当前指针指向的版本」保留来源核对：非当前历史版本因此失去来源绑定。
      replaceOnce(
        root,
        MODEL,
        `  // 「有对应 Change 的历史版本必须记录创建设备与创建时间」同样只适用于产生新版本的操作。
  if (VERSION_CREATING.has(change.operation)) {`,
        `  // 「有对应 Change 的历史版本必须记录创建设备与创建时间」同样只适用于产生新版本的操作。
  if (VERSION_CREATING.has(change.operation) && [...filesById.values()].some((entry) => entry.current_version_id === version.version_id)) {`,
        '来源字段只核对当前指针版本',
      );
    },
  },
  {
    id: 'REVIEW-002 提交不核对 completed 上传会话的 content_hash',
    failTests: [T.uploadFingerprint],
    expectError: '必须被拒绝',
    apply(root) {
      replaceOnce(
        root,
        MODEL,
        `  if (actualHash !== body.content_hash || upload.content_hash !== body.content_hash || upload.content_hash !== actualHash) {`,
        `  if (actualHash !== body.content_hash) {`,
        '会话哈希不参与核对',
      );
    },
  },
  {
    id: 'REVIEW-002 提交不核对 completed 上传会话的 content_size',
    failTests: [T.uploadFingerprint],
    expectError: '必须被拒绝',
    apply(root) {
      replaceOnce(
        root,
        MODEL,
        `  if (actualSize !== body.content_size || upload.content_size !== body.content_size || upload.content_size !== actualSize) {`,
        `  if (actualSize !== body.content_size) {`,
        '会话大小不参与核对',
      );
    },
  },
  {
    id: 'REVIEW-002 会话指纹不符时仍推进 vault_revision',
    failTests: [
      T.rejectNoState,
      T.stableErrors,
      T.uploadBroken,
      T.uploadFingerprint,
    ],
    expectError: '不得推进 vault_revision',
    apply(root) {
      replaceOnce(
        root,
        MODEL,
        `  if (actualHash !== body.content_hash || upload.content_hash !== body.content_hash || upload.content_hash !== actualHash) {
    return failWith(409, ERROR_CODES.CONTENT_HASH_MISMATCH,`,
        `  if (actualHash !== body.content_hash || upload.content_hash !== body.content_hash || upload.content_hash !== actualHash) {
    state.vault_revision += 1;
    return failWith(409, ERROR_CODES.CONTENT_HASH_MISMATCH,`,
        '会话指纹失败时推进 revision',
      );
    },
  },
  {
    id: 'REVIEW-003 显式 null 的 min_available_revision 被当成缺省 0',
    failTests: [T.minAvailableNull],
    expectError: 'min_available_revision',
    apply(root) {
      replaceOnce(
        root,
        MODEL,
        `  const hasMinAvailable = initialState !== null && initialState !== undefined && Object.hasOwn(initialState, 'min_available_revision');
  const minAvailable = hasMinAvailable ? initialState.min_available_revision : 0;
  if (hasMinAvailable && initialState.min_available_revision === null) {
    problems.push('initial_state.min_available_revision 不能显式为 null（缺省才默认 0）');
  } else if (!isNonNegativeInt(minAvailable)) {`,
        `  const minAvailable = initialState?.min_available_revision ?? 0;
  if (!isNonNegativeInt(minAvailable)) {`,
        'null 被 ?? 0 静默吸收',
      );
    },
  },
  {
    id: 'REVIEW-004 统一执行器不再校验 pull 响应的 vault_id / device_id',
    failTests: [T.pullEnvelope],
    expectError: 'vault_id',
    apply(root) {
      replaceOnce(
        root,
        TEST,
        `  assert.equal(body.vault_id, vaultId, \`\${label}: pull 响应的 vault_id 必须等于请求 Vault\`);`,
        `  assert.ok(true, \`\${label}: pull 响应 vault_id 不再核对\`);`,
        '去掉 pull 响应的 vault_id 断言',
      );
      replaceOnce(
        root,
        TEST,
        `  assert.equal(body.device_id, requestBody.device_id, \`\${label}: pull 响应的 device_id 必须回显请求体 device_id\`);`,
        `  assert.ok(true, \`\${label}: pull 响应 device_id 不再核对\`);`,
        '去掉 pull 响应的 device_id 断言',
      );
    },
  },
  {
    id: 'REVIEW-004 统一执行器不再校验 pull 响应的 to_revision / has_more',
    failTests: [T.pullEnvelope],
    expectError: 'to_revision',
    apply(root) {
      replaceOnce(
        root,
        TEST,
        `  assert.ok(Number.isInteger(body.to_revision), \`\${label}: to_revision 必须是整数\`);
  assert.equal(body.to_revision, state.vault_revision, \`\${label}: to_revision 必须等于服务端 vault_revision\`);`,
        `  assert.ok(true, \`\${label}: to_revision 不再校验\`);`,
        '去掉 pull 响应的 to_revision 断言',
      );
      replaceOnce(
        root,
        TEST,
        `  assert.equal(body.has_more, false, \`\${label}: has_more 必须在单次响应内为 false\`);`,
        `  assert.ok(true, \`\${label}: has_more 不再校验\`);`,
        '去掉 pull 响应的 has_more 断言',
      );
    },
  },
  {
    id: 'REVIEW-005 judge 允许出现未声明的额外顶层失败',
    failTests: [T.mutationJudge],
    expectError: '额外顶层失败',
    apply(root) {
      replaceOnce(
        root,
        'tests/protocol/mutation-check.mjs',
        `  const unexpected = [...failedNames].filter((name) => !expected.has(name));
  if (unexpected.length > 0) {
    return { ok: false, reason: \`出现未声明的额外顶层失败: \${JSON.stringify(unexpected)}\` };
  }`,
        `  const unexpected = [];
  if (unexpected.length > 0) {
    return { ok: false, reason: \`出现未声明的额外顶层失败: \${JSON.stringify(unexpected)}\` };
  }`,
        '集合相等退化成「包含即可」',
      );
    },
  },
  {
    id: 'REVIEW-005 judge 不再拒绝非顶层失败',
    failTests: [T.mutationJudge],
    expectError: '非顶层失败',
    apply(root) {
      replaceOnce(
        root,
        'tests/protocol/mutation-check.mjs',
        `  if (nested.length > 0) {
    return { ok: false, reason: \`出现非顶层失败: \${JSON.stringify([...new Set(nested)])}\` };
  }`,
        `  if (false) {
    return { ok: false, reason: \`出现非顶层失败: \${JSON.stringify([...new Set(nested)])}\` };
  }`,
        '不再拒绝非顶层失败',
      );
    },
  },
  /* ---- 最终复审（HIST-01..04 / TRACK-01 / BLOB-01 / ROUTE-01 / PULL-01..02 / */
  /* SUBMIT-01 / MANIFEST-01 / REPLAY-01 / FIXTURE-01 / STATE-01 / REV-01 /     */
  /* MUTATION-01）新增 ---- */
  {
    id: 'HIST-01 line_ending 存在性比较退化（缺失与显式 null 被抹平）',
    failTests: [T.histVersionComplete],
    expectError: 'line_ending',
    apply(root) {
      replaceOnce(
        root,
        MODEL,
        `  if (actualHas !== expectedHas) {`,
        `  if (false && actualHas !== expectedHas) {`,
        'line_ending 存在性不再比较',
      );
    },
  },
  {
    id: 'HIST-02 复用版本的版本也被强制要求 metadata 与来源字段',
    failTests: [
      scenarioTest('historical-successor-version'),
      scenarioTest('update-deleted-file'),
      T.histCompressedMeta,
      T.histLineEnding,
      T.histParentChain,
      T.manifestBinding,
      T.replayOptionalKey,
      T.testAllScenarios,
      T.writeDeleted,
    ],
    expectError: 'metadata',
    apply(root) {
      // 去掉 VERSION_CREATING 守卫：delete_file 等复用版本也被要求 created_by_device_id /
      // created_at / metadata 与首次请求一致，压缩后只剩删除 Change 的合法状态因此被误拒。
      replaceOnce(
        root,
        MODEL,
        `  if (VERSION_CREATING.has(change.operation)) {
    // 有对应 Change 的历史版本必须记录创建设备与创建时间，且与 Change 逐项相等。`,
        `  if (true) {
    // 有对应 Change 的历史版本必须记录创建设备与创建时间，且与 Change 逐项相等。`,
        '复用版本也被强制要求 metadata',
      );
    },
  },
  {
    id: 'HIST-02 压缩版本的 metadata.format 不再与所属文件绑定',
    failTests: [T.histCompressedMeta],
    expectError: 'format 漂移必须被发现',
    apply(root) {
      replaceOnce(
        root,
        MODEL,
        `      const owningFile = filesById.get(version.file_id);`,
        `      const owningFile = null;`,
        '压缩版本 format 不再与文件绑定',
      );
    },
  },
  {
    id: 'HIST-03 不再重建可证明的当前指针（父引用可回退）',
    failTests: [T.histParentChain],
    expectError: '父引用回退必须由指针重建发现',
    apply(root) {
      replaceOnce(
        root,
        MODEL,
        `        } else if (parentId !== proven) {`,
        `        } else if (false) {`,
        '父引用不再与可证明指针比对',
      );
    },
  },
  {
    id: 'HIST-03 Change 可引用未来版本',
    failTests: [T.histParentChain],
    expectError: '未来版本',
    apply(root) {
      replaceOnce(
        root,
        MODEL,
        `  if (isNonNegativeInt(version.vault_revision) && isNonNegativeInt(change.vault_revision) && version.vault_revision > change.vault_revision) {`,
        `  if (false) {`,
        '删除/复用版本可指向未来版本',
      );
    },
  },
  {
    id: 'HIST-04 request.url 中的 query.vault_id 不参与加载校验',
    failTests: [T.histUrlQuery],
    expectError: 'URL 查询串中的错误 vault_id 必须被发现',
    apply(root) {
      replaceOnce(
        root,
        MODEL,
        `      if (typeof request.url === 'string') {
        querySources.push((key) => queryLookup({ url: request.url })(key));
      }`,
        `      if (false) {
        querySources.push((key) => queryLookup({ url: request.url })(key));
      }`,
        'URL 查询串不参与校验',
      );
    },
  },
  {
    id: 'TRACK-01 request_id 只做正则匹配、不校验类型',
    failTests: [T.trackRequestIdStrict],
    expectError: '必须因类型被拒绝',
    apply(root) {
      // 去掉类型守卫并让后续切分也走隐式字符串转换：
      // `['req_000001']` 会被正则与 `String()` 一起接受，加载校验因此放过数组类型。
      replaceOnce(
        root,
        MODEL,
        `  if (typeof value !== 'string' || !REQUEST_ID_RE.test(value)) return null;
  const number = Number(value.slice('req_'.length));`,
        `  if (!REQUEST_ID_RE.test(value)) return null;
  const number = Number(String(value).slice('req_'.length));`,
        '数组类型靠隐式转换通过',
      );
    },
  },
  {
    id: 'BLOB-01 completed 上传会话与 Blob 的大小一致性不再校验',
    failTests: [T.blobSizeConsistency],
    expectError: 'content_size',
    apply(root) {
      replaceOnce(
        root,
        MODEL,
        `          if (isNonNegativeInt(upload.content_size) && isNonNegativeInt(blob.content_size) && blob.content_size !== upload.content_size) {`,
        `          if (false) {`,
        '会话与 Blob 大小不再核对',
      );
    },
  },
  {
    id: 'BLOB-01 复用 Blob 的错误缺少 upload_content_size',
    failTests: [T.blobReuseError],
    expectError: 'upload_content_size',
    apply(root) {
      replaceOnce(
        root,
        MODEL,
        `        upload_content_size: upload.content_size ?? null,
        blob_content_size: existingBlob.content_size,`,
        `        blob_content_size: existingBlob.content_size,`,
        '复用错误缺少 upload_content_size',
      );
    },
  },
  {
    id: 'ROUTE-01 路由 Vault 段不做百分号解码',
    failTests: [T.routeEncodedVault],
    expectError: '编码后的 manifest 必须成功',
    apply(root) {
      replaceOnce(
        root,
        MODEL,
        `    vaultFromRoute = decodeURIComponent(match[1]);`,
        `    vaultFromRoute = match[1];`,
        '不解码路径段',
      );
    },
  },
  {
    id: 'ROUTE-01 非法百分号编码抛出未捕获异常',
    failTests: [T.routeEncodedVault],
    expectError: 'URI malformed',
    apply(root) {
      replaceOnce(
        root,
        MODEL,
        `  let vaultFromRoute;
  try {
    vaultFromRoute = decodeURIComponent(match[1]);
  } catch {
    // 非法百分号编码不是任何协议的端点：返回 null → ENDPOINT_NOT_FOUND。
    return null;
  }`,
        `  const vaultFromRoute = decodeURIComponent(match[1]);`,
        '非法编码不再被捕获',
      );
    },
  },
  {
    id: 'PULL-01 统一执行器不再调用 assertPullResponse',
    failTests: [T.pullEnvelope],
    expectError: 'pull',
    apply(root) {
      replaceOnce(
        root,
        TEST,
        `      assertPullResponse(response.body, {
        vaultId: scenario.initial_state.vault_id,
        requestBody,
        state,
        label: \`步骤 \${step.id}\`,
      });`,
        `      void assertPullResponse;`,
        '执行器不再调用 assertPullResponse',
      );
    },
  },
  {
    id: 'PULL-02 pull Change 白名单漏掉 vault_id 与 created_at',
    failTests: [T.pullEnvelope],
    expectError: 'vault_id',
    apply(root) {
      replaceOnce(
        root,
        TEST,
        `  'change_id',
  'vault_id',
  'vault_revision',`,
        `  'change_id',
  'vault_revision',`,
        '白名单漏掉 vault_id',
      );
      replaceOnce(
        root,
        TEST,
        `  'client_timestamp',
  'created_at',
];`,
        `  'client_timestamp',
];`,
        '白名单漏掉 created_at',
      );
    },
  },
  {
    id: 'PULL-02 pull Change 字段缺失被 ?? null 伪装成显式 null',
    failTests: [T.pullEnvelope],
    expectError: 'parent_version_id',
    apply(root) {
      replaceOnce(
        root,
        TEST,
        `      assert.ok(Object.hasOwn(change, field), \`\${label}: 拉取的 changes[\${index}] 必须显式包含 \${field}\`);`,
        `      void field;`,
        '不再要求字段显式出现',
      );
      replaceOnce(
        root,
        TEST,
        `      assert.deepEqual(
        change[field],
        expected[field],
        \`\${label}: 拉取的 changes[\${index}].\${field} 必须与 state.changes 完整一致\`,
      );`,
        `      assert.deepEqual(
        change[field] ?? null,
        expected[field] ?? null,
        \`\${label}: 拉取的 changes[\${index}].\${field} 必须与 state.changes 完整一致\`,
      );`,
        '缺失与显式 null 被抹平',
      );
    },
  },
  {
    id: 'SUBMIT-01 成功结果不再绑定请求 vault_id / path / blob_id',
    failTests: [T.submitBinding],
    expectError: 'vault_id',
    apply(root) {
      replaceOnce(
        root,
        TEST,
        `      assert.equal(result.vault_id, scenario.initial_state.vault_id, \`步骤 \${step.id}: 结果 vault_id 必须等于请求 Vault\`);`,
        `      void result.vault_id;`,
        '结果 vault_id 不再绑定请求',
      );
      replaceOnce(
        root,
        TEST,
        `      assert.equal(result.path, requestCommand.path, \`步骤 \${step.id}: 结果 path 必须等于请求\`);`,
        `      void result.path;`,
        '结果 path 不再绑定请求',
      );
      replaceOnce(
        root,
        TEST,
        `      assert.equal(result.blob_id, blob.blob_id, \`步骤 \${step.id}: 结果 blob_id 必须等于新 Blob\`);`,
        `      void result.blob_id;`,
        '结果 blob_id 不再绑定 Blob',
      );
    },
  },
  {
    id: 'MANIFEST-01 统一执行器不再校验 manifest 完整字段',
    failTests: [T.manifestBinding],
    expectError: 'manifest',
    apply(root) {
      replaceOnce(
        root,
        TEST,
        `      assertManifestResponse(response.body, {
        vaultId: scenario.initial_state.vault_id,
        deviceId: manifestDeviceId,
        state,
        label: \`步骤 \${step.id}\`,
      });`,
        `      void assertManifestResponse;`,
        'manifest 不再完整校验',
      );
    },
  },
  {
    id: 'MANIFEST-01 manifest 条目不再核对 blob_id',
    failTests: [T.manifestBinding],
    expectError: '条目指向错误 Blob 必须被完整校验拦下',
    apply(root) {
      replaceOnce(
        root,
        TEST,
        `  'content_size',
  'blob_id',
  'is_deleted',
];`,
        `  'content_size',
  'is_deleted',
];`,
        'manifest 白名单漏掉 blob_id',
      );
    },
  },
  {
    id: 'REPLAY-01 执行器把可选 Idempotency-Key 当必填',
    failTests: [
      scenarioTest('historical-successor-version'),
      T.replayOptionalKey,
      T.testAllScenarios,
    ],
    expectError: 'Idempotency-Key',
    apply(root) {
      replaceOnce(
        root,
        TEST,
        `      if (replayKey !== undefined) {
        assert.equal(replayKey, ledger.operation_id, \`步骤 \${step.id}: 历史重放的 Idempotency-Key 必须等于 operation_id\`);
      }`,
        `      assert.equal(replayKey, ledger.operation_id, \`步骤 \${step.id}: 历史重放的 Idempotency-Key 必须等于 operation_id\`);`,
        'Idempotency-Key 被当成必填',
      );
    },
  },
  {
    id: 'FIXTURE-01 错误步骤可以省略 expected_result.code',
    failTests: [T.evidenceRequired, T.fixtureErrorCode],
    expectError: 'expected_result.code',
    apply(root) {
      replaceOnce(
        root,
        TEST,
        `    if (typeof step.expected_status === 'number' && step.expected_status >= 400) {`,
        `    if (false) {`,
        '错误步骤不再要求 code',
      );
    },
  },
  {
    id: 'STATE-01 验证器接受非数组集合，建库随后 TypeError',
    failTests: [T.stateCollections],
    expectError: '必须被拒绝',
    apply(root) {
      replaceOnce(
        root,
        MODEL,
        `  if (!Array.isArray(value)) {
    return { value: [], problems: [\`initial_state.\${key} 必须是数组（缺省才视为空集合）\`] };
  }`,
        `  if (!Array.isArray(value)) {
    return { value: [], problems: [] };
  }`,
        '非数组集合被静默接受',
      );
    },
  },
  {
    id: 'REV-01 revision 连续性退回按数值逐个循环',
    failTests: [T.revisionLinear],
    expectError: '不得按 revision 数值逐个枚举',
    apply(root) {
      replaceOnce(
        root,
        MODEL,
        `    const expectedFloor = Math.max(minAvailable + 1, 1);`,
        `    const expectedFloor = Math.max(minAvailable + 1, 1);
    for (let revision = expectedFloor; revision <= vaultRevision; revision += 1) {
      if (!revisions.has(revision)) {
        problems.push(\`initial_state 缺少 revision \${revision} 的 Change（min_available_revision=\${minAvailable}, vault_revision=\${vaultRevision}）\`);
      }
    }`,
        '按数值逐个循环',
      );
    },
  },
  {
    id: 'MUTATION-01 临时 runner 收集失败但进程仍返回 0',
    failTests: [T.mutationRunner],
    expectError: 'process.exitCode',
    apply(root) {
      // 锚点必须带上 runner 独有的前后文：变异定义本身也包含同一行，
      // 只用单行锚点会命中两次（一次是变异定义里的字面量）。
      // 锚点用拼接构造：这段文本本身也会出现在变异定义里，直接写字面量会命中两次
      // （一次是 runner 模板、一次是变异源码），无法精确单点替换。
      const target = 'process.exit' + 'Code = failures.length === 0 ? 0 : 1;';
      const replacement = 'process.exit' + 'Code = 0;';
      replaceOnce(
        root,
        'tests/protocol/mutation-check.mjs',
        `    ${target}\n    process.stdout.write(JSON.stringify({ failures }));`,
        `    ${replacement}\n    process.stdout.write(JSON.stringify({ failures }));`,
        'runner 不设置失败退出码',
      );
    },
  },
];

/**
 * 在子进程里用 node:test 的编程式 run() 收集结构化结果，与 reporter 无关。
 *
 * 注意：`node:test` 的 `run()` 只是**收集**结果，并不会让进程返回非零退出码。
 * 因此临时 runner 必须在有失败时设置 `process.exitCode = 1`（基线无失败时为 0），
 * 这样「测试失败」与「进程成功」不一致的问题才不会把整套变异判定架空。
 * 主进程同时核对两件事：子进程的**实际退出状态**，以及结构化失败集合。
 */
function runTests(root) {
  const runner = `
    import { run } from 'node:test';
    import { resolve } from 'node:path';
    const stream = run({ files: [resolve('${TEST}')], concurrency: 1 });
    const failures = [];
    for await (const event of stream) {
      if (event.type === 'test:fail') {
        failures.push({
          name: event.data.name,
          nesting: event.data.nesting ?? 0,
          message: event.data.details?.error?.message ?? '',
        });
      }
    }
    // 收集失败但进程仍返回 0，会让「退出码非零」这条判定彻底失效。
    process.exitCode = failures.length === 0 ? 0 : 1;
    process.stdout.write(JSON.stringify({ failures }));
  `;
  write(root, RUNNER, runner);
  try {
    // 关键：剥掉 `NODE_TEST_CONTEXT`。若本脚本本身在 `node --test` 下被启动，子进程会继承
    // 该变量，`node:test` 的嵌套 `run()` 会**直接跳过文件收集**（失败集合恒为空、退出码 0），
    // 基线与全部变异都会「假通过」。清除它后子进程每次都真正执行测试文件。
    const { NODE_TEST_CONTEXT, ...childEnv } = process.env;
    void NODE_TEST_CONTEXT;
    const output = execFileSync(process.execPath, [RUNNER], {
      cwd: root,
      stdio: 'pipe',
      encoding: 'utf8',
      env: childEnv,
    });
    const parsed = JSON.parse(output);
    // 退出码为 0 却报告失败：runner 的退出状态不可信，直接判定为异常而不是「通过」。
    if (parsed.failures.length > 0) {
      return {
        ok: false,
        failures: parsed.failures,
        exitMismatch: `退出码为 0 但报告了 ${parsed.failures.length} 个失败：runner 必须设置 process.exitCode=1`,
      };
    }
    return { ok: true, failures: [], exitCode: 0 };
  } catch (error) {
    const stdout = `${error.stdout ?? ''}`;
    const stderr = `${error.stderr ?? ''}`;
    const exitCode = typeof error.status === 'number' ? error.status : null;
    for (const raw of [stdout, `${stdout}${stderr}`, stderr]) {
      try {
        const parsed = JSON.parse(raw);
        if (!Array.isArray(parsed.failures)) break;
        if (exitCode === 0) {
          return {
            ok: false,
            failures: parsed.failures,
            exitMismatch: '子进程退出码为 0，但测试报告了失败：runner 必须设置 process.exitCode=1',
          };
        }
        return {
          ok: parsed.failures.length === 0 && exitCode === 0,
          failures: parsed.failures,
          exitCode,
        };
      } catch {
        // 尝试下一种输出组合。
      }
    }
    return {
      ok: false,
      failures: [],
      crashed: `${stdout}${stderr}`.split('\n').slice(-30).join('\n'),
    };
  } finally {
    rmSync(join(root, RUNNER), { force: true });
  }
}

/**
 * 判定一个变异是否被「精确命中」。
 *
 * 判定口径是**顶层失败集合与 `failTests` 完全相等**：
 *   - 指定的失败测试必须全部出现（不能缺失，否则说明该变异没被目标断言发现）；
 *   - 也不能出现任何**额外**的顶层失败（否则说明这次破坏顺带打挂了无关测试，
 *     「精确命中」就退化成「只要挂了就算通过」，无法证明覆盖到了某条具体规则）。
 * 若一个变异合理地允许多个失败测试，必须在 `failTests` 里显式列全，判断仍是集合相等。
 * 只要出现非顶层失败（子测试），同样视为不精确：结构化失败记录里一律按名字比较，
 * 不做任何子串猜测。
 */
function judge(mutation, result) {
  if (result.crashed) return { ok: false, reason: `测试进程崩溃: ${result.crashed}` };
  if (result.exitMismatch) return { ok: false, reason: result.exitMismatch };
  if (result.ok) return { ok: false, reason: '未失败（破坏未被发现）' };
  const expected = new Set(mutation.failTests);
  const nested = result.failures.filter((item) => item.nesting !== 0).map((item) => item.name);
  if (nested.length > 0) {
    return { ok: false, reason: `出现非顶层失败: ${JSON.stringify([...new Set(nested)])}` };
  }
  const failedNames = new Set(result.failures.map((item) => item.name));
  const missing = [...expected].filter((name) => !failedNames.has(name));
  if (missing.length > 0) {
    return { ok: false, reason: `以下指定测试未失败: ${JSON.stringify(missing)}` };
  }
  const unexpected = [...failedNames].filter((name) => !expected.has(name));
  if (unexpected.length > 0) {
    return { ok: false, reason: `出现未声明的额外顶层失败: ${JSON.stringify(unexpected)}` };
  }
  if (mutation.expectError) {
    const hit = result.failures.some(
      (item) => mutation.failTests.includes(item.name) && item.message.includes(mutation.expectError),
    );
    if (!hit) {
      return { ok: false, reason: `命中测试的失败消息未包含 ${JSON.stringify(mutation.expectError)}` };
    }
  }
  return { ok: true, reason: `精确命中 ${mutation.failTests.length} 个指定测试（失败集合完全相等）` };
}

function copyProject(target) {
  for (const entry of ['docs', 'tests']) {
    cpSync(join(REPO_ROOT, entry), join(target, entry), { recursive: true });
  }
}

function main() {
  // 基线：未修改的副本必须通过。
  const baselineDir = mkdtempSync(join(tmpdir(), 'sync-baseline-'));
  copyProject(baselineDir);
  const baseline = runTests(baselineDir);
  rmSync(baselineDir, { recursive: true, force: true });
  if (!baseline.ok) {
    console.error('基线运行失败，破坏性验证无意义。');
    console.error(JSON.stringify(baseline.failures.slice(0, 20), null, 2));
    process.exit(1);
  }
  console.log('基线：全部通过（退出码 0）\n');

  let failed = 0;
  const results = [];
  for (const mutation of MUTATIONS) {
    const dir = mkdtempSync(join(tmpdir(), 'sync-mutation-'));
    copyProject(dir);
    try {
      mutation.apply(dir);
      if (mutation.afterApply) mutation.afterApply(dir);
      const verdict = judge(mutation, runTests(dir));
      if (!verdict.ok) failed += 1;
      results.push({ id: mutation.id, ...verdict });
    } catch (error) {
      failed += 1;
      results.push({ id: mutation.id, ok: false, reason: `变异应用失败: ${error.message}` });
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  }

  for (const [index, result] of results.entries()) {
    const mark = result.ok ? 'PASS' : 'FAIL';
    console.log(`${mark} [${String(index + 1).padStart(2, '0')}] ${result.id} — ${result.reason}`);
  }
  console.log(`\n共 ${MUTATIONS.length} 个变异，未被精确击穿 ${failed} 个。`);
  process.exit(failed === 0 ? 0 : 1);
}

// 只有直接执行脚本时才跑全部变异；被测试文件 import 时只导出结构化工具，
// 这样 judge 的「集合完全相等」语义可以由契约测试直接反向验证。
const invokedDirectly = process.argv[1] !== undefined && resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (invokedDirectly) main();

export { MUTATIONS, judge };
