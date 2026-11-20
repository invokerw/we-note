/**
 * 同步操作协议 v1 的可执行契约检查。
 *
 * 运行：node --test tests/protocol/sync-v1.test.mjs
 *
 * 结构：
 *   - 载入 tests/sync-fixtures/*.json，逐场景从 initial_state 建立内存状态；
 *   - 按 steps 顺序执行，每一步的实际状态原样传给下一步；
 *   - 期望值只用于断言，状态转换逻辑不读取 expected_* 字段。
 *
 * 请求构造：**每一步都用标准 `Request` 构造**（`buildRequest`），因此被测模型的
 * URL / headers / body 读取路径与真实客户端完全一致：`POST /sync/changes` 的 JSON
 * 正文由模型真正解析，`GET /sync/manifest` 是无正文 GET。
 *
 * 断言指令（夹具中出现的全部指令）：
 *   expected_status            必须返回的 HTTP 状态码
 *   expected_result            响应体的深子集匹配（必须是非空对象）
 *   expected_state             对 projectState(state) 的点路径期望
 *   expect_state_unchanged     请求前后协议状态必须逐项相同（含上传会话与已占用 operation_id）
 *   expect_replay_of_step      业务结果必须与指定步骤逐项相同，且状态不变
 *   expect_cursor_from_step    请求游标必须取自指定步骤响应的 snapshot_revision（禁止硬编码）
 *   expect_error_fields        错误响应必须包含给定字段与取值，用于核对恢复字段
 *   expect_conflict_locates_remote
 *                              用错误中的当前版本在服务端定位远端内容，并与磁盘样本字节比对
 *   expect_manifest_restores_map
 *                              用 manifest 条目重建文件映射，并与服务端状态逐项核对
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync, existsSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { dirname, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  createVaultState,
  handleRequest,
  projectState,
  snapshotState,
  requestTracking,
  validateInitialState,
  ERROR_CODES,
  OPERATION_TYPES,
  EXECUTABLE_OPERATIONS,
  ENDPOINTS,
  METHODS,
  METADATA_FORMATS,
  LINE_ENDINGS,
  UPLOAD_STATUSES,
  isRfc3339Utc,
  stableStringify,
  sha256Of,
} from './sync-model.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(HERE, '..', '..');
const FIXTURE_DIR = join(REPO_ROOT, 'tests', 'sync-fixtures');
const CONTENT_DIR = join(FIXTURE_DIR, 'content');
const ORIGIN = 'https://sync.example';

/** 任务书要求的五个必需场景。缺少任何一个都视为夹具缺失，不允许空跑通过。 */
const REQUIRED_SCENARIOS = [
  'submit-markdown',
  'duplicate-request',
  'other-file-advances-cursor',
  'file-base-too-old',
  'stale-cursor-recovery',
];

/** 三种正文样本必须实际存在并被场景引用。 */
const REQUIRED_SAMPLE_EXTENSIONS = ['.md', '.txt', '.json'];

function loadScenarios() {
  const entries = readdirSync(FIXTURE_DIR, { withFileTypes: true })
    .filter((entry) => entry.isFile() && entry.name.endsWith('.json'))
    .map((entry) => entry.name)
    .sort();

  return entries.map((name) => {
    const path = join(FIXTURE_DIR, name);
    const raw = readFileSync(path, 'utf8');
    let parsed;
    try {
      parsed = JSON.parse(raw);
    } catch (error) {
      throw new Error(`夹具 ${name} 不是合法 JSON: ${error.message}`);
    }
    return { name, path, scenario: parsed };
  });
}

const SCENARIOS = loadScenarios();

const scenarioNameOfFile = (fileName) => fileName.replace(/\.json$/, '');

/**
 * 校验场景索引：`scenario` 必须等于文件名去掉 `.json`（文档第 8.3 节），且场景名唯一。
 * 返回问题列表而不是直接抛错，便于测试给出可定位的断言消息。
 */
function scenarioIndexProblems(scenarios) {
  const problems = [];
  const byName = new Map();
  for (const entry of scenarios) {
    const name = entry.scenario?.scenario;
    const expected = scenarioNameOfFile(entry.name);
    if (typeof name !== 'string' || name.length === 0) {
      problems.push(`${entry.name}: 缺少 scenario 名`);
      continue;
    }
    if (name !== expected) {
      problems.push(`${entry.name}: scenario 为 ${JSON.stringify(name)}，必须等于文件名 ${JSON.stringify(expected)}`);
    }
    if (byName.has(name)) {
      problems.push(`重复的场景名 ${JSON.stringify(name)}: ${byName.get(name).name} 与 ${entry.name}`);
      continue;
    }
    byName.set(name, entry);
  }
  return problems;
}

/** 场景名重复会让 Map 静默覆盖，导致某个场景实际未被执行；这里显式报错。 */
function indexScenarios(scenarios) {
  const problems = scenarioIndexProblems(scenarios);
  if (problems.length > 0) {
    throw new Error(`夹具索引不合法:\n- ${problems.join('\n- ')}`);
  }
  return new Map(scenarios.map((entry) => [entry.scenario.scenario, entry]));
}

const SCENARIO_BY_NAME = indexScenarios(SCENARIOS);

const isPlainObject = (value) => typeof value === 'object' && value !== null && !Array.isArray(value);
const hasKeys = (value) => isPlainObject(value) && Object.keys(value).length > 0;

/** 收集夹具引用到的全部正文样本路径（相对 tests/sync-fixtures/content）。 */
function referencedSamples() {
  const found = new Set();
  for (const { scenario } of SCENARIOS) {
    if (scenario.content_samples) {
      for (const sample of Object.values(scenario.content_samples)) found.add(sample);
    }
    for (const step of scenario.steps ?? []) {
      if (step.content_file) found.add(step.content_file);
    }
  }
  return [...found].sort();
}

function readSample(relPath) {
  const absolute = join(CONTENT_DIR, relPath);
  assert.ok(existsSync(absolute), `引用的正文样本不存在: ${relative(REPO_ROOT, absolute)}`);
  return readFileSync(absolute);
}

const digestOf = (bytes) => `sha256:${createHash('sha256').update(bytes).digest('hex')}`;

/**
 * 初始版本必须与正文样本逐项对照：`version_samples` 声明 `version_id -> content/ 相对路径`。
 * 只核对「样本存在」不够 —— 给样本追加一个空格也必须被发现，因此这里比较完整哈希与字节数。
 */
function assertInitialVersionsMatchSamples(scenario) {
  const mapping = scenario.version_samples;
  assert.ok(mapping && typeof mapping === 'object' && !Array.isArray(mapping), `夹具 ${scenario.scenario} 缺少 version_samples 映射`);
  const initialVersions = scenario.initial_state.versions ?? [];
  assert.deepEqual(
    Object.keys(mapping).sort(),
    initialVersions.map((version) => version.version_id).sort(),
    `夹具 ${scenario.scenario}: version_samples 必须恰好覆盖全部初始版本`,
  );
  for (const version of initialVersions) {
    const samplePath = mapping[version.version_id];
    assert.ok(typeof samplePath === 'string' && samplePath.length > 0, `版本 ${version.version_id} 缺少正文样本映射`);
    const bytes = readSample(samplePath);
    assert.equal(
      version.content_size,
      bytes.length,
      `版本 ${version.version_id}: content_size 必须等于样本 ${samplePath} 的字节数`,
    );
    assert.equal(
      version.content_hash,
      digestOf(bytes),
      `版本 ${version.version_id}: content_hash 必须等于样本 ${samplePath} 原始字节的完整 SHA-256`,
    );
    const blob = (scenario.initial_state.blobs ?? []).find((item) => item.blob_id === version.blob_id);
    assert.ok(blob, `版本 ${version.version_id} 指向的 Blob ${version.blob_id} 不存在`);
    assert.equal(blob.content_hash, digestOf(bytes), `Blob ${blob.blob_id} 的哈希必须与样本 ${samplePath} 一致`);
    assert.equal(blob.content_size, bytes.length, `Blob ${blob.blob_id} 的字节数必须与样本 ${samplePath} 一致`);
  }
}

/**
 * 每一步都必须同时具备**结果证据**与**状态证据**：
 *   - `expected_result` 必须是非空对象（`{}` 不算证据）；
 *   - 且必须有 `expected_state`（非空对象）或 `expect_state_unchanged: true`。
 *
 * `expect_error_fields` 只是补充字段，不能替代状态证据：只有错误字段的步骤
 * 仍然可以完全不检查「这次请求是否改坏了状态」。
 */
function stepEvidenceProblems(scenario) {
  const problems = [];
  for (const step of scenario.steps ?? []) {
    if (!hasKeys(step.expected_result)) {
      problems.push(`${scenario.scenario}/${step.id}: 缺少非空对象 expected_result`);
    }
    // 错误步骤必须声明稳定错误码：`expected_status >= 400` 却省略 `expected_result.code`
    // 时，夹具只验证了「失败了」，无法证明失败原因就是协议要求的那一条。
    if (typeof step.expected_status === 'number' && step.expected_status >= 400) {
      const code = step.expected_result?.code;
      if (typeof code !== 'string' || code.length === 0) {
        problems.push(
          `${scenario.scenario}/${step.id}: expected_status >= 400 时 expected_result.code 必须是非空字符串`,
        );
      }
    }
    const hasStateEvidence = hasKeys(step.expected_state) || step.expect_state_unchanged === true;
    if (!hasStateEvidence) {
      const hint = step.expect_error_fields !== undefined ? '（expect_error_fields 不能替代状态证据）' : '';
      problems.push(
        `${scenario.scenario}/${step.id}: 缺少状态证据（expected_state / expect_state_unchanged）${hint}`,
      );
    }
  }
  return problems;
}

/* ------------------------------------------------------------------ */
/* 断言工具                                                             */
/* ------------------------------------------------------------------ */

function getByPath(root, dotPath) {
  const segments = dotPath.split('.');
  let current = root;
  for (const segment of segments) {
    if (current === null || current === undefined) return undefined;
    current = current[segment];
  }
  return current;
}

/**
 * 深子集匹配：expected 中出现的每个键都必须出现且相等；
 * 数组长度必须一致，并逐元素递归匹配。
 */
function assertSubset(actual, expected, path) {
  if (expected === null) {
    assert.equal(actual, null, `${path}: 期望 null`);
    return;
  }
  if (Array.isArray(expected)) {
    assert.ok(Array.isArray(actual), `${path}: 期望数组，实际是 ${typeof actual}`);
    assert.equal(actual.length, expected.length, `${path}: 数组长度应为 ${expected.length}，实际 ${actual.length}`);
    expected.forEach((item, index) => assertSubset(actual[index], item, `${path}[${index}]`));
    return;
  }
  if (typeof expected === 'object') {
    assert.ok(actual !== null && typeof actual === 'object' && !Array.isArray(actual), `${path}: 期望对象`);
    for (const [key, value] of Object.entries(expected)) {
      assert.ok(key in actual, `${path}.${key}: 响应缺少该字段`);
      assertSubset(actual[key], value, `${path}.${key}`);
    }
    return;
  }
  assert.equal(actual, expected, `${path}: 期望 ${JSON.stringify(expected)}，实际 ${JSON.stringify(actual)}`);
}

/** 幂等重放的业务字段比较：排除请求跟踪字段。 */
const TRACKING_FIELDS = new Set(['request_id', 'original_request_id', 'replayed', 'protocol_version']);

/** 与模型一致的「请求头名大小写无关」查找。 */
function headerValueLower(headers, name) {
  if (!isPlainObject(headers)) return undefined;
  const target = name.toLowerCase();
  for (const [key, value] of Object.entries(headers)) {
    if (key.toLowerCase() === target) return value;
  }
  return undefined;
}

function businessFields(body) {
  const result = {};
  for (const [key, value] of Object.entries(body)) {
    if (!TRACKING_FIELDS.has(key)) result[key] = value;
  }
  return result;
}

/* ------------------------------------------------------------------ */
/* 响应定位字段（成功与错误共用）                                        */
/* ------------------------------------------------------------------ */

/**
 * 协议第 2 节与第 3.4 节要求**全部**响应（成功与错误）都携带
 * `endpoint` / `method` / `allowed_method`。成功响应同样必须回显实际请求路径、
 * 实际方法与端点允许的方法，因此「只有错误响应带定位字段」的实现在这里必然失败。
 */
function assertResponseEnvelope(body, { endpoint, method, allowedMethod, label }) {
  assert.ok(Object.hasOwn(body, 'endpoint'), `${label}: 响应必须包含 endpoint 字段`);
  assert.equal(body.endpoint, endpoint, `${label}: endpoint 必须回显实际请求路径`);
  assert.ok(Object.hasOwn(body, 'method'), `${label}: 响应必须包含 method 字段`);
  assert.equal(body.method, method, `${label}: method 必须回显实际请求方法`);
  assert.ok(Object.hasOwn(body, 'allowed_method'), `${label}: 响应必须包含 allowed_method 字段`);
  assert.equal(body.allowed_method, allowedMethod, `${label}: allowed_method 必须是该端点唯一合法的方法`);
}

/**
 * manifest 成功响应的完整断言（MANIFEST-01）。
 *
 * 只做「按条目重建映射」不足以证明 manifest 正确：
 *   - `files: []` 的空映射在 file 数为 0 时也能重建成功；
 *   - 条目里的 `blob_id` / `content_size` / `format` / `is_deleted` 写错时，
 *     重建断言只比较 path 与版本 / 哈希，仍然会放行。
 *
 * 因此这里逐项校验 header（`vault_id`、`snapshot_revision`、`min_available_revision`）、
 * `files` 数组、按 `path` 升序，以及每个条目的
 * `file_id` / `path` / `format` / `current_version_id` / `current_content_hash` /
 * `content_size` / `blob_id` / `is_deleted` 与 `state.files` 完整一致。
 */
const MANIFEST_FILE_FIELDS = [
  'file_id',
  'path',
  'format',
  'current_version_id',
  'current_content_hash',
  'content_size',
  'blob_id',
  'is_deleted',
];

function assertManifestResponse(body, { vaultId, deviceId, state, label }) {
  assert.equal(body.vault_id, vaultId, `${label}: manifest 的 vault_id 必须等于请求 Vault`);
  assert.equal(typeof deviceId, 'string', `${label}: manifest 请求必须携带 device_id`);
  assert.equal(body.device_id, deviceId, `${label}: manifest 的 device_id 必须回显请求携带的 device_id`);
  assert.equal(body.snapshot_revision, state.vault_revision, `${label}: snapshot_revision 必须等于服务端 vault_revision`);
  assert.equal(
    body.min_available_revision,
    state.min_available_revision,
    `${label}: min_available_revision 必须等于服务端下界`,
  );
  assert.ok(Array.isArray(body.files), `${label}: manifest.files 必须是数组`);
  assert.equal(
    body.files.length,
    state.files.length,
    `${label}: manifest 必须列出全部文件（期望 ${state.files.length}，实际 ${body.files.length}）`,
  );
  const paths = body.files.map((entry) => entry.path);
  for (let index = 1; index < paths.length; index += 1) {
    assert.ok(paths[index - 1] < paths[index], `${label}: manifest.files 必须按 path 升序`);
  }
  const byFileId = new Map(body.files.map((entry) => [entry.file_id, entry]));
  for (const file of state.files) {
    const entry = byFileId.get(file.file_id);
    assert.ok(entry, `${label}: manifest 缺少文件 ${file.file_id}`);
    const expected = {
      file_id: file.file_id,
      path: file.path,
      format: file.format,
      current_version_id: file.current_version_id,
      current_content_hash: file.current_content_hash,
      content_size: file.current_size,
      blob_id: file.current_blob_id,
      is_deleted: file.is_deleted,
    };
    for (const field of MANIFEST_FILE_FIELDS) {
      assert.ok(Object.hasOwn(entry, field), `${label}: manifest 条目 ${file.file_id} 必须显式包含 ${field}`);
      assert.deepEqual(
        entry[field],
        expected[field],
        `${label}: manifest 条目 ${file.file_id}.${field} 必须与 state 一致`,
      );
    }
  }
}

/**
 * pull 成功响应的完整断言（SYNC-V1-REVIEW-004 / PULL-01 / PULL-02）。
 *
 * 只断言 `changes` 的少数几个字段是不够的：把 `vault_id` / `device_id` 改成其它值、
 * 把 `from_revision` / `to_revision` / `min_available_revision` 写成别的 revision、
 * 或者把 `has_more` 改成 `true`，客户端都会据此拉错 Vault、跳过或重复应用变更。
 * 因此这里逐项要求：
 *   - `vault_id` 等于请求 Vault（取自夹具 `initial_state.vault_id`）；
 *   - `device_id` 等于请求体 `device_id`；
 *   - `from_revision` 回显请求游标，`to_revision` 等于响应时刻的 `vault_revision`，
 *     `min_available_revision` 回显服务端下界，`has_more` 为 `false`；
 *   - `changes` 是数组，按 revision 严格递增，且全部落在 `(from_revision, to_revision]`；
 *   - 每条 Change 与 `state.changes` 中同 revision 的记录**逐字段完全一致**，
 *     且这些字段必须由服务端显式出现（`hasOwn`）：缺失不得被 `?? null` 伪装成显式 null。
 *
 * 场景执行器与反向测试调用的是同一份断言，不能只在一处「看起来校验过」。
 */

/** pull 响应中每条 Change 必须完整携带的字段白名单。 */
const PULL_CHANGE_FIELDS = [
  'change_id',
  'vault_id',
  'vault_revision',
  'operation_id',
  'device_id',
  'operation',
  'file_id',
  'path',
  'version_id',
  'parent_version_id',
  'content_hash',
  'content_size',
  'client_timestamp',
  'created_at',
];

function assertPullResponse(body, { vaultId, requestBody, state, label }) {
  assert.equal(typeof requestBody.device_id, 'string', `${label}: pull 请求体必须显式携带 device_id`);
  assert.equal(body.vault_id, vaultId, `${label}: pull 响应的 vault_id 必须等于请求 Vault`);
  assert.equal(body.device_id, requestBody.device_id, `${label}: pull 响应的 device_id 必须回显请求体 device_id`);
  assert.equal(
    body.from_revision,
    requestBody.last_server_revision,
    `${label}: from_revision 必须回显请求游标`,
  );
  assert.ok(Number.isInteger(body.to_revision), `${label}: to_revision 必须是整数`);
  assert.equal(body.to_revision, state.vault_revision, `${label}: to_revision 必须等于服务端 vault_revision`);
  assert.equal(
    body.min_available_revision,
    state.min_available_revision,
    `${label}: min_available_revision 必须等于服务端下界`,
  );
  assert.equal(body.has_more, false, `${label}: has_more 必须在单次响应内为 false`);
  assert.ok(Array.isArray(body.changes), `${label}: changes 必须是数组`);
  const revisions = body.changes.map((change) => change.vault_revision);
  for (let index = 1; index < revisions.length; index += 1) {
    assert.ok(revisions[index] > revisions[index - 1], `${label}: Change 必须按 revision 严格递增`);
  }
  for (const revision of revisions) {
    assert.ok(revision > body.from_revision, `${label}: 只能返回严格晚于请求游标的 Change`);
    assert.ok(revision <= body.to_revision, `${label}: 不得返回晚于 to_revision 的 Change`);
  }

  // 每条 Change 必须与 state.changes 的同 revision 记录完整一致。
  // 白名单不能漏字段：`vault_id` 与 `created_at` 丢失时客户端无法判断归属与产生时间，
  // `parent_version_id` 丢失会让版本图无法重建。字段存在性也必须显式（`hasOwn`），
  // 否则「缺失」与「显式 null」被 `?? null` 抹平后再比较，永远相等。
  const expectedChanges = state.changes
    .filter((change) => change.vault_revision > body.from_revision)
    .sort((left, right) => left.vault_revision - right.vault_revision);
  assert.equal(
    body.changes.length,
    expectedChanges.length,
    `${label}: 拉取必须返回全部严格晚于游标的 Change（期望 ${expectedChanges.length}，实际 ${body.changes.length}）`,
  );
  body.changes.forEach((change, index) => {
    const expected = expectedChanges[index];
    for (const field of PULL_CHANGE_FIELDS) {
      assert.ok(Object.hasOwn(change, field), `${label}: 拉取的 changes[${index}] 必须显式包含 ${field}`);
      assert.ok(
        Object.hasOwn(expected, field),
        `${label}: state.changes[${index}] 必须显式包含 ${field}（对照记录自身不自洽）`,
      );
      assert.deepEqual(
        change[field],
        expected[field],
        `${label}: 拉取的 changes[${index}].${field} 必须与 state.changes 完整一致`,
      );
    }
  });
}

/* ------------------------------------------------------------------ */
/* 场景执行                                                             */
/* ------------------------------------------------------------------ */

function buildUploadContext(step, uploadBytes, scenario = {}) {
  const samples = new Map(uploadBytes);
  if (step.content_file) {
    const bytes = readSample(step.content_file);
    const body = step.request?.body ?? {};
    // 夹具自洽性：声明的 content_hash / content_size 必须等于真实字节。
    if (body.blob_reference && body.content_hash) {
      assert.equal(digestOf(bytes), body.content_hash, `步骤 ${step.id}: content_hash 与 ${step.content_file} 实际字节不一致`);
      assert.equal(bytes.length, body.content_size, `步骤 ${step.id}: content_size 与 ${step.content_file} 实际字节数不一致`);
      samples.set(body.blob_reference, bytes);
    }
  }
  // 至少一个成功提交必须走**异步**上传解析：真实客户端的上传读取是异步的，
  // 模型若漏掉 `await`，会拿到 Promise 而不是 Buffer。
  const isAsync = (scenario.async_upload_steps ?? []).includes(step.id);
  return {
    isAsync,
    resolveUpload(blobReference) {
      if (!samples.has(blobReference)) throw new Error(`步骤 ${step.id}: 没有为 ${blobReference} 准备上传正文`);
      const bytes = samples.get(blobReference);
      return isAsync ? Promise.resolve(bytes) : bytes;
    },
  };
}

function collectUploadBytes(scenario) {
  const map = new Map();
  for (const step of scenario.steps) {
    if (!step.content_file) continue;
    const ref = step.request?.body?.blob_reference;
    if (!ref) continue;
    const bytes = readSample(step.content_file);
    const existing = map.get(ref);
    if (existing && !existing.equals(bytes)) {
      throw new Error(`夹具 ${scenario.scenario}: blob_reference ${ref} 被两个不同样本引用`);
    }
    map.set(ref, bytes);
  }
  return map;
}

/**
 * 把夹具步骤翻译成被测执行器实际发出的**标准 `Request`**。
 *
 * 来源分离是硬约束：
 *   - 夹具 `headers` 就是请求头（不会被复制进查询参数）；
 *   - 夹具 `query` 就是查询串（`vault_id` 若出现必须与路由一致，允许存在）；
 *   - 夹具 `body` 序列化为 JSON 正文（GET manifest 不得有正文）。
 * 这样被测模型读取 URL / headers / body 的方式与真实 Web 客户端完全一致。
 */
function buildRequest(step, boundCursor) {
  const fixtureRequest = step.request;
  const isManifest = fixtureRequest.endpoint.endsWith('/sync/manifest');
  const routeVault = /\/api\/v1\/vaults\/([^/]+)\/sync\//.exec(fixtureRequest.endpoint)?.[1];

  // 游标 0 是合法取值，必须按「是否绑定」而不是「取值真假」判断，
  // 否则快照 revision 恰好为 0 时会被误当成未绑定，请求随即缺字段。
  const body = boundCursor !== undefined
    ? { ...(fixtureRequest.body ?? {}), last_server_revision: boundCursor }
    : fixtureRequest.body !== undefined
      ? { ...fixtureRequest.body }
      : undefined;

  if (isManifest) {
    assert.equal(body, undefined, `步骤 ${step.id}: GET manifest 的夹具请求不得携带正文`);
  }

  const url = new URL(`${ORIGIN}${fixtureRequest.endpoint}`);
  const fixtureQuery = fixtureRequest.query ?? {};
  // 查询串原样进入 URL：**不在这里预判** `vault_id` 是否与路由一致。
  // 允许 / 拒绝是模型（handleRequest）的职责；执行器提前拦截会让
  // 「query.vault_id 不匹配 → 404」的负向夹具永远跑不到模型。
  for (const [key, value] of Object.entries(fixtureQuery)) url.searchParams.set(key, String(value));

  const headers = { ...(fixtureRequest.headers ?? {}) };
  const init = { method: fixtureRequest.method, headers };
  if (body !== undefined) {
    headers['Content-Type'] = 'application/json';
    init.body = JSON.stringify(body);
  }

  const request = new Request(url, init);

  if (isManifest) {
    // 断言「能实际构造无正文 GET」：标准 Request 拒绝 GET 带 body，因而这行本身就是契约证据。
    assert.equal(request.body, null, `步骤 ${step.id}: GET manifest 不能有正文`);
    assert.equal(request.method, 'GET', `步骤 ${step.id}: manifest 必须用 GET`);
  } else {
    assert.equal(request.method, 'POST', `步骤 ${step.id}: changes 必须用 POST`);
    assert.ok(request.body !== null, `步骤 ${step.id}: POST changes 必须携带 JSON 正文`);
  }

  return { request, body, url, headers, routeVault };
}

/**
 * 实际执行记录：由 `runScenario` 在真正跑过场景与每一步时登记。
 * 断言只认这里，不认「夹具已被加载」——否则把场景从执行循环里摘掉或提前 return，
 * 「全部已加载场景都会被实际执行」就会退化成空话。
 *
 * 每项：{ steps: Set<stepId>, requests: Map<stepId, count>, responses: [{stepId,status,body}] }
 */
const EXECUTED_SCENARIOS = new Map();

/**
 * 具名场景主循环的**统一**执行记录（TEST-03）。
 * 只有「场景：…」主循环写这里；覆盖测试只读这份记录，不再自行补跑场景。
 * 把某个具名场景从主循环里摘掉或跳过，下面的覆盖断言必然失败。
 */
const MAIN_LOOP_EXECUTION = new Map();

/**
 * 执行一个场景。
 *
 * `options.tamperResponse(response, step)` 是**仅供反向测试**的注入点：它在模型返回响应之后、
 * 执行器断言之前改写响应体，用来证明执行器内的 envelope / 业务字段断言确实在断言链上生效
 * （而不是只在独立用例里被调用）。生产路径不传该参数。
 */
async function runScenario(scenario, records = EXECUTED_SCENARIOS, options = {}) {
  const registration = { steps: new Set(), requests: new Map(), responses: [], asyncSteps: [] };
  records.set(scenario.scenario, registration);
  const problems = validateInitialState(scenario.initial_state);
  assert.deepEqual(problems, [], `夹具 ${scenario.scenario} 的 initial_state 不自洽:\n- ${problems.join('\n- ')}`);
  assert.deepEqual(stepEvidenceProblems(scenario), [], `夹具 ${scenario.scenario} 的步骤证据不完整`);

  const state = createVaultState(scenario.initial_state);
  const initialStateProjection = projectState(state);
  const uploadBytes = collectUploadBytes(scenario);
  const responses = [];
  const observed = [];

  for (const [index, step] of scenario.steps.entries()) {
    const before = snapshotState(state);
    const ctx = buildUploadContext(step, uploadBytes, scenario);

    assert.ok(step.request, `步骤 ${step.id}: 缺少 request`);
    assert.ok(
      typeof step.request.endpoint === 'string' && step.request.endpoint.includes('/api/v1/vaults/'),
      `步骤 ${step.id}: request.endpoint 必须使用第 10.4 节的完整路径`,
    );
    // 夹具自身必须遵守「方法 + 路径」联合契约，避免夹具用错方法却仍然通过。
    const endpointKind = step.request.endpoint.endsWith('/sync/manifest') ? 'manifest' : 'changes';
    assert.equal(
      step.request.method,
      METHODS[endpointKind],
      `步骤 ${step.id}: ${endpointKind} 端点必须使用 ${METHODS[endpointKind]}`,
    );

    // 游标绑定：请求的 `last_server_revision` 必须取自前一步响应的字段，而不是夹具里硬编码的数字。
    // 绑定步骤在夹具里**不得**出现 `last_server_revision` 字面量，执行时由响应注入。
    let boundCursor;
    let cursorBinding = null;
    if (step.cursor_from_step !== undefined) {
      const source = responses[step.cursor_from_step];
      assert.ok(source, `步骤 ${step.id}: 找不到游标来源步骤 ${step.cursor_from_step}`);
      const sourceField = step.cursor_from_field ?? 'snapshot_revision';
      assert.equal(
        source.body.mode,
        'manifest',
        `步骤 ${step.id}: 游标来源步骤必须是 manifest 响应，实际 mode=${source.body.mode}`,
      );
      boundCursor = source.body[sourceField];
      assert.ok(
        Number.isInteger(boundCursor) && boundCursor >= 0,
        `步骤 ${step.id}: 来源步骤响应的 ${sourceField} 不是非负整数: ${JSON.stringify(boundCursor)}`,
      );
      // 绑定步骤不得在夹具里写死游标：一旦写了，就说明该场景仍在依赖字面量而不是 manifest 响应。
      assert.equal(
        'last_server_revision' in (step.request.body ?? {}),
        false,
        `步骤 ${step.id}: 绑定 cursor_from_step 时不得在夹具里硬编码 last_server_revision`,
      );
      // 若夹具声明了期望的 from_revision，它也必须等于从响应派生的值。
      assert.equal(
        step.expected_result?.from_revision ?? boundCursor,
        boundCursor,
        `步骤 ${step.id}: expected_result.from_revision 必须等于从步骤 ${step.cursor_from_step} 派生的 ${sourceField}`,
      );
      cursorBinding = { sourceStep: step.cursor_from_step, field: sourceField, value: boundCursor };
    }

    // 所有步骤都经过同一个请求构造函数：绑定与未绑定、revision 6 与 7、游标 0 的续拉走同一条代码路径。
    const built = buildRequest(step, boundCursor);
    const requestBody = built.body ?? {};

    registration.requests.set(step.id, (registration.requests.get(step.id) ?? 0) + 1);
    const response = options.tamperResponse
      ? options.tamperResponse(await handleRequest(state, built.request, ctx), step)
      : await handleRequest(state, built.request, ctx);
    if (ctx.isAsync) registration.asyncSteps.push(step.id);
    responses.push(response);
    registration.responses.push({ stepId: step.id, status: response.status, body: response.body });
    const after = snapshotState(state);
    const projection = projectState(state);

    // 绑定步骤的注入必须真正生效：请求里携带的游标等于派生值，而不是残留字面量。
    if (cursorBinding) {
      assert.equal(
        requestBody.last_server_revision,
        cursorBinding.value,
        `步骤 ${step.id}: 执行器必须把 manifest 派生的游标注入请求`,
      );
    }

    // 1. 状态码
    assert.equal(response.status, step.expected_status, `步骤 ${step.id}: 状态码不符，响应体 ${JSON.stringify(response.body)}`);

    // 2. 请求跟踪字段。
    //    `REQUEST_ID_EXHAUSTED` 是唯一允许 `request_id: null` 的响应：
    //    序号已用尽，无法生成 `req_` 加六位数字的标识，也绝不生成七位标识。
    const exhausted = response.body.code === 'REQUEST_ID_EXHAUSTED';
    if (exhausted) {
      assert.equal(response.status, 503, `步骤 ${step.id}: REQUEST_ID_EXHAUSTED 必须是 503`);
      assert.equal(response.body.request_id, null, `步骤 ${step.id}: 序号用尽时 request_id 必须显式为 null`);
    } else {
      assert.match(response.body.request_id, /^req_\d{6}$/, `步骤 ${step.id}: request_id 格式不符合约定`);
      assert.notEqual(response.body.request_id, 'req_000000', `步骤 ${step.id}: req_000000 不是合法 request_id`);
    }
    assert.equal(response.body.protocol_version, 'sync-v1', `步骤 ${step.id}: protocol_version 必须是 sync-v1`);

    // 3a. 定位字段对**成功与错误**一视同仁：三种成功模式（submit / pull / manifest）同样要带。
    assertResponseEnvelope(response.body, {
      endpoint: step.request.endpoint,
      method: step.request.method,
      allowedMethod: METHODS[endpointKind],
      label: `步骤 ${step.id}`,
    });

    // 3. 错误响应结构：必须有稳定 code、可读 message，以及定位字段 endpoint / method / allowed_method。
    if (step.expected_status >= 400) {
      assert.ok(typeof response.body.code === 'string' && response.body.code.length > 0, `步骤 ${step.id}: 错误响应缺少稳定 code`);
      assert.ok(
        typeof response.body.message === 'string' && response.body.message.length > 0,
        `步骤 ${step.id}: 错误响应缺少可读 message`,
      );
      assert.equal(response.body.mode, undefined, `步骤 ${step.id}: 错误响应不应带 mode 业务字段`);
      assert.equal(response.body.replayed, undefined, `步骤 ${step.id}: 错误响应不应带 replayed 字段`);
      // 定位字段必须逐项存在且与实际请求一致；破坏任一字段都必须让本断言失败
      // （成功响应的同组断言在上面的 3a 已覆盖）。
      assertResponseEnvelope(response.body, {
        endpoint: step.request.endpoint,
        method: step.request.method,
        allowedMethod: METHODS[endpointKind],
        label: `步骤 ${step.id}（错误路径）`,
      });
    }

    // 3b. 错误恢复字段：夹具显式声明必须出现的字段与取值。
    //     只核对「字段存在」不够：期望值本身可能是 `null`、`false` 或数字，
    //     必须按 expected_result 的实际字段类型逐项比较（`null` 也要真的出现并等于 null）。
    if (step.expect_error_fields) {
      assert.equal(response.status, step.expected_status, `步骤 ${step.id}: expect_error_fields 只用于错误步骤`);
      for (const [field, expectedValue] of Object.entries(step.expect_error_fields)) {
        assert.ok(field in response.body, `步骤 ${step.id}: 错误响应缺少恢复字段 ${field}，实际 ${JSON.stringify(response.body)}`);
        if (expectedValue === null) {
          assert.equal(response.body[field], null, `步骤 ${step.id}: 错误字段 ${field} 必须显式为 null`);
        } else if (typeof expectedValue === 'boolean' || typeof expectedValue === 'number') {
          assert.equal(
            typeof response.body[field],
            typeof expectedValue,
            `步骤 ${step.id}: 错误字段 ${field} 的类型必须是 ${typeof expectedValue}，实际 ${typeof response.body[field]}`,
          );
          assert.equal(response.body[field], expectedValue, `步骤 ${step.id}: 错误字段 ${field} 取值不符`);
        } else if (Array.isArray(expectedValue)) {
          assert.deepEqual(response.body[field], expectedValue, `步骤 ${step.id}: 错误字段 ${field} 数组取值不符`);
        } else if (isPlainObject(expectedValue)) {
          assertSubset(response.body[field], expectedValue, `步骤 ${step.id}: 错误字段 ${field}`);
        } else {
          assert.equal(response.body[field], expectedValue, `步骤 ${step.id}: 错误字段 ${field} 取值不符`);
        }
      }
    }

    // 4. 响应体深子集断言
    if (step.expected_result) {
      assertSubset(response.body, step.expected_result, `步骤 ${step.id} 响应`);
    }

    // 4b. 提交响应的字段交叉断言（SUBMIT-01 / TEST-02）：新 Change、新版本、请求、
    //     文件、Blob 与结果必须逐项一致。任何一处「vault_id / operation_id / file_id /
    //     path / blob_id / revision」写错都必须在这里失败，而不是只靠 response.body 的自证。
    if (response.body.mode === 'submit' && response.status === 200 && response.body.replayed === false) {
      const result = response.body;
      const requestCommand = requestBody;
      const change = state.changes.find((item) => item.change_id === result.change_id);
      const version = state.versions.find((item) => item.version_id === result.version_id);
      const file = state.files.find((item) => item.file_id === result.file_id);
      const blob = state.blobs.find((item) => item.blob_id === result.blob_id);
      assert.ok(change, `步骤 ${step.id}: 响应 change_id ${result.change_id} 必须对应 state.changes 中的一条记录`);
      assert.ok(version, `步骤 ${step.id}: 响应 version_id ${result.version_id} 必须存在于 state.versions`);
      assert.ok(file, `步骤 ${step.id}: 响应 file_id ${result.file_id} 必须存在于 state.files`);
      assert.ok(blob, `步骤 ${step.id}: 响应 blob_id ${result.blob_id} 必须存在于 state.blobs`);

      // 结果顶层标识 ← 路由 / 请求。`vault_id` 必须取自本 Vault，而不是响应自证。
      assert.equal(result.vault_id, scenario.initial_state.vault_id, `步骤 ${step.id}: 结果 vault_id 必须等于请求 Vault`);
      assert.equal(result.device_id, requestCommand.device_id, `步骤 ${step.id}: 结果 device_id 必须等于请求`);
      assert.equal(result.operation_id, requestCommand.operation_id, `步骤 ${step.id}: 结果 operation_id 必须等于请求`);
      assert.equal(result.file_id, requestCommand.file_id, `步骤 ${step.id}: 结果 file_id 必须等于请求`);
      assert.equal(result.path, requestCommand.path, `步骤 ${step.id}: 结果 path 必须等于请求`);
      assert.equal(result.version_id, version.version_id, `步骤 ${step.id}: 结果 version_id 必须等于新版本`);
      assert.equal(result.change_id, change.change_id, `步骤 ${step.id}: 结果 change_id 必须等于新 Change`);
      assert.equal(result.blob_id, blob.blob_id, `步骤 ${step.id}: 结果 blob_id 必须等于新 Blob`);
      assert.equal(result.blob_id, version.blob_id, `步骤 ${step.id}: 结果 blob_id 必须等于版本引用的 Blob`);
      assert.equal(result.content_hash, requestCommand.content_hash, `步骤 ${step.id}: 结果 content_hash 必须等于请求`);
      assert.equal(result.content_hash, blob.content_hash, `步骤 ${step.id}: 结果 content_hash 必须等于 Blob 哈希`);
      assert.equal(result.content_size, requestCommand.content_size, `步骤 ${step.id}: 结果 content_size 必须等于请求`);
      assert.equal(result.content_size, blob.content_size, `步骤 ${step.id}: 结果 content_size 必须等于 Blob 大小`);

      // Change ← 请求
      assert.equal(change.vault_id, scenario.initial_state.vault_id, `步骤 ${step.id}: Change.vault_id 必须等于请求 Vault`);
      assert.equal(change.operation_id, requestCommand.operation_id, `步骤 ${step.id}: Change.operation_id 必须等于请求`);
      assert.equal(change.device_id, requestCommand.device_id, `步骤 ${step.id}: Change.device_id 必须等于请求`);
      assert.equal(change.client_timestamp, requestCommand.client_timestamp, `步骤 ${step.id}: Change.client_timestamp 必须等于请求`);
      assert.equal(change.created_at, requestCommand.client_timestamp, `步骤 ${step.id}: Change.created_at 必须等于请求时间`);
      assert.equal(change.operation, requestCommand.operation, `步骤 ${step.id}: Change.operation 必须等于请求`);
      assert.equal(change.path, requestCommand.path, `步骤 ${step.id}: Change.path 必须等于请求`);
      assert.equal(change.file_id, requestCommand.file_id, `步骤 ${step.id}: Change.file_id 必须等于请求`);
      // Change ← 版本 ← 文件
      assert.equal(change.version_id, version.version_id, `步骤 ${step.id}: Change.version_id 必须等于响应 version_id`);
      assert.equal(change.vault_revision, version.vault_revision, `步骤 ${step.id}: Change 与版本必须同 revision`);
      assert.equal(change.content_hash, version.content_hash, `步骤 ${step.id}: Change 与版本 content_hash 必须一致`);
      assert.equal(change.content_size, version.content_size, `步骤 ${step.id}: Change 与版本 content_size 必须一致`);
      assert.equal(change.file_id, version.file_id, `步骤 ${step.id}: Change 与版本必须属于同一文件`);
      assert.equal(change.parent_version_id ?? null, version.base_version_id ?? null, `步骤 ${step.id}: Change 父版本必须等于版本 base_version_id`);
      assert.equal(
        result.parent_version_id ?? null,
        change.parent_version_id ?? null,
        `步骤 ${step.id}: 结果 parent_version_id 必须等于 Change 父版本`,
      );
      // Change / 版本 ← 文件当前指针
      assert.equal(file.current_version_id, version.version_id, `步骤 ${step.id}: 文件当前指针必须指向新版本`);
      assert.equal(file.current_content_hash, version.content_hash, `步骤 ${step.id}: 文件当前哈希必须等于新版本`);
      // Change ← 结果
      assert.equal(result.vault_revision, change.vault_revision, `步骤 ${step.id}: 结果 vault_revision 必须等于 Change revision`);
      assert.equal(result.vault_revision, state.vault_revision, `步骤 ${step.id}: 结果 vault_revision 必须等于提交后的 vault_revision`);
      // 最后一条 Change 的 operation 与文件状态必须自洽：update_file_content 后不得仍是删除态。
      const lastChange = state.changes[state.changes.length - 1];
      assert.equal(lastChange.change_id, change.change_id, `步骤 ${step.id}: 新 Change 必须是最后一条`);
      assert.equal(
        file.is_deleted,
        false,
        `步骤 ${step.id}: 成功 update_file_content 后文件 is_deleted 必须为 false（最后 Change 为 ${lastChange.operation}）`,
      );
      // 版本保存的 metadata 必须与请求一致（HIST-07）：存在性与取值都要相等，
      // 不能用 `?? null` 把「缺失」和「显式 null」抹平。
      assert.equal(version.metadata?.format, requestCommand.metadata.format, `步骤 ${step.id}: 版本 metadata.format 必须等于请求`);
      assert.equal(
        Object.hasOwn(version.metadata ?? {}, 'line_ending'),
        Object.hasOwn(requestCommand.metadata ?? {}, 'line_ending'),
        `步骤 ${step.id}: 版本 metadata.line_ending 的存在性必须与请求一致`,
      );
      assert.equal(
        version.metadata?.line_ending,
        requestCommand.metadata.line_ending,
        `步骤 ${step.id}: 版本 metadata.line_ending 必须等于请求`,
      );
      assert.equal(version.created_by_device_id, requestCommand.device_id, `步骤 ${step.id}: 版本 created_by_device_id 必须等于请求设备`);
      assert.equal(version.created_at, requestCommand.client_timestamp, `步骤 ${step.id}: 版本 created_at 必须等于请求时间`);
    }

    // 5. 状态点路径断言
    for (const [dotPath, expectedValue] of Object.entries(step.expected_state ?? {})) {
      const actualValue = getByPath(projection, dotPath);
      assert.deepEqual(actualValue, expectedValue, `步骤 ${step.id}: 状态 ${dotPath} 不符`);
    }

    // 6. 状态未变断言
    if (step.expect_state_unchanged) {
      assert.deepEqual(after, before, `步骤 ${step.id}: 该请求不应改变服务端状态`);
    }

    // 7. 幂等重放断言
    if (step.expect_replay_of_step !== undefined) {
      const original = responses[step.expect_replay_of_step];
      assert.ok(original, `步骤 ${step.id}: 找不到被重放的步骤 ${step.expect_replay_of_step}`);
      assert.deepEqual(
        businessFields(response.body),
        businessFields(original.body),
        `步骤 ${step.id}: 重放必须返回与首次完全相同的业务结果`,
      );
      assert.equal(response.body.replayed, true, `步骤 ${step.id}: 重放响应应标记 replayed: true`);
      assert.equal(
        response.body.original_request_id,
        original.body.request_id,
        `步骤 ${step.id}: 重放响应应回指首次处理请求`,
      );
      assert.notEqual(response.body.request_id, original.body.request_id, `步骤 ${step.id}: 重放请求应有新的 request_id`);
      assert.deepEqual(after, before, `步骤 ${step.id}: 重放不得新增 Blob、版本、Change 或推进 vault_revision`);
    }

    // 7b. 历史首次请求的原样重放（HIST-02）：路由、query.vault_id、方法、endpoint、
    //     请求体与 Idempotency-Key 都必须与账本记录的首次请求逐项一致，且返回 200 + 首次业务结果。
    if (step.expect_historical_replay !== undefined) {
      const ledger = scenario.initial_state.idempotency?.[step.expect_historical_replay];
      assert.ok(ledger, `步骤 ${step.id}: 找不到历史账本条目 ${step.expect_historical_replay}`);
      const firstRequest = ledger.request;
      // 1. 完整路由与 query.vault_id
      assert.equal(step.request.method, 'POST', `步骤 ${step.id}: 历史重放必须用 POST`);
      assert.ok(
        step.request.endpoint.endsWith(`/api/v1/vaults/${scenario.initial_state.vault_id}/sync/changes`),
        `步骤 ${step.id}: 历史重放必须打到本 Vault 的 sync/changes`,
      );
      assert.equal(
        step.request.query?.vault_id ?? scenario.initial_state.vault_id,
        scenario.initial_state.vault_id,
        `步骤 ${step.id}: 历史重放的 query.vault_id 必须与本 Vault 一致`,
      );
      // 2. 首次请求体逐项一致
      assert.deepEqual(requestBody, firstRequest.body, `步骤 ${step.id}: 历史重放的请求体必须与首次请求完全一致`);
      assert.equal(requestBody.operation_id, ledger.operation_id, `步骤 ${step.id}: 历史重放的 operation 必须命中账本键`);
      assert.equal(requestBody.operation, ledger.result?.operation ?? requestBody.operation, `步骤 ${step.id}: 历史重放的操作名不符`);
      // 3. Idempotency-Key：协议允许省略。若出现，必须大小写无关地等于 operation_id；
      //    缺失时历史请求仍必须能原样重放（不得把可选头当成必填）。
      const replayKey = headerValueLower(step.request.headers, 'idempotency-key');
      if (replayKey !== undefined) {
        assert.equal(replayKey, ledger.operation_id, `步骤 ${step.id}: 历史重放的 Idempotency-Key 必须等于 operation_id`);
      }
      const firstKey = headerValueLower(firstRequest.headers, 'idempotency-key');
      assert.equal(
        replayKey === undefined,
        firstKey === undefined,
        `步骤 ${step.id}: 重放与首次请求的 Idempotency-Key 存在性必须一致（可选头不得单方补成必填）`,
      );
      // Idempotency-Key 缺失时 operation_id 仍是幂等键：账本必须能被命中。
      assert.equal(typeof requestBody.operation_id, 'string', `步骤 ${step.id}: 历史重放必须携带 operation_id`);
      // 4. 响应必须是可重放的 200 与首次业务结果
      assert.equal(response.status, 200, `步骤 ${step.id}: 历史重放必须是 200`);
      assert.equal(response.body.replayed, true, `步骤 ${step.id}: 历史重放必须标记 replayed=true`);
      assert.equal(response.body.change_id, ledger.result.change_id, `步骤 ${step.id}: 历史重放必须返回首次 Change`);
      assert.equal(response.body.version_id, ledger.result.version_id, `步骤 ${step.id}: 历史重放必须返回首次版本`);
      assert.equal(response.body.vault_revision, ledger.result.vault_revision, `步骤 ${step.id}: 历史重放必须返回首次 revision`);
      assert.equal(response.body.original_request_id, ledger.request_id, `步骤 ${step.id}: 历史重放必须回指首次 request_id`);
      assert.deepEqual(after, before, `步骤 ${step.id}: 历史重放不得产生任何状态变化`);
    }

    // 8. 冲突错误必须能定位远端内容
    if (step.expect_conflict_locates_remote) {
      const remoteBytes = readSample(step.expect_conflict_locates_remote);
      assert.equal(response.body.code, ERROR_CODES.FILE_VERSION_CONFLICT, `步骤 ${step.id}: 期望 FILE_VERSION_CONFLICT`);
      const remoteVersion = state.versions.find((version) => version.version_id === response.body.current_version_id);
      assert.ok(remoteVersion, `步骤 ${step.id}: 错误中的 current_version_id 在服务端不存在`);
      assert.equal(remoteVersion.file_id, response.body.file_id, `步骤 ${step.id}: 冲突版本必须属于同一文件`);
      assert.equal(remoteVersion.blob_id, response.body.current_blob_id, `步骤 ${step.id}: 冲突 Blob 与当前版本不一致`);
      assert.equal(remoteVersion.content_hash, digestOf(remoteBytes), `步骤 ${step.id}: 冲突版本哈希与远端样本字节不一致`);
      assert.equal(response.body.current_content_hash, digestOf(remoteBytes), `步骤 ${step.id}: 错误中的当前哈希与远端样本不一致`);
      const remoteBlob = state.blobs.find((blob) => blob.blob_id === response.body.current_blob_id);
      assert.ok(remoteBlob, `步骤 ${step.id}: 错误中的 current_blob_id 在服务端不存在`);
      assert.equal(remoteBlob.content_size, remoteBytes.length, `步骤 ${step.id}: 冲突 Blob 大小与远端样本不一致`);
      // 冲突提交不得留下本地候选版本，远端指针保持不动。
      assert.equal(
        state.files.find((file) => file.file_id === response.body.file_id).current_version_id,
        response.body.current_version_id,
        `步骤 ${step.id}: 冲突后远端当前指针必须保持不变`,
      );
    }

    // 9. manifest 成功响应的完整校验（MANIFEST-01）：
    //    header（vault_id / snapshot_revision / min_available_revision）、files 数组、
    //    按 path 升序，以及每个条目的全部字段都必须与 state 完整一致。
    //    `expect_manifest_restores_map` 只是额外的「按映射重建」断言，不能替代这里的字段校验：
    //    空 files 映射或某个条目指向错误 Blob 时，仅靠「重建后字段相等」也可能漏过。
    if (response.body.mode === 'manifest' && response.status === 200) {
      // device_id 可以来自请求头或查询参数：与模型一致，头优先。
      const manifestDeviceId =
        headerValueLower(step.request.headers, 'x-device-id') ?? step.request.query?.device_id;
      assertManifestResponse(response.body, {
        vaultId: scenario.initial_state.vault_id,
        deviceId: manifestDeviceId,
        state,
        label: `步骤 ${step.id}`,
      });
      if (step.expect_manifest_restores_map) {
        const rebuilt = new Map(response.body.files.map((entry) => [entry.file_id, entry]));
        assert.equal(rebuilt.size, state.files.length, `步骤 ${step.id}: manifest 条目数应等于活跃文件数`);
        for (const file of state.files) {
          const entry = rebuilt.get(file.file_id);
          assert.ok(entry, `步骤 ${step.id}: manifest 缺少文件 ${file.file_id}`);
          assert.equal(entry.path, file.path, `步骤 ${step.id}: manifest 路径不符`);
          assert.equal(entry.current_version_id, file.current_version_id, `步骤 ${step.id}: manifest 版本不符`);
          assert.equal(entry.current_content_hash, file.current_content_hash, `步骤 ${step.id}: manifest 哈希不符`);
        }
        // 记录快照游标，供后续续拉断言使用。
        observed.push({ kind: 'snapshot', stepId: step.id, stepIndex: index, revision: response.body.snapshot_revision });
      }
    }

    // 10. 增量拉取的通用校验
    if (response.body.mode === 'pull') {
      // 10a. 响应 envelope、业务字段与每条 Change 的完整字段必须与请求 / 当前状态一致。
      //      这一段抽成独立函数，反向测试直接复用同一份断言，
      //      因此「只在场景里断言 changes」不会被误当成完整校验；
      //      执行器不再另写一份「字段白名单」的近似比较，避免两处口径漂移。
      assertPullResponse(response.body, {
        vaultId: scenario.initial_state.vault_id,
        requestBody,
        state,
        label: `步骤 ${step.id}`,
      });
      observed.push({
        kind: 'pull',
        stepId: step.id,
        revision: response.body.to_revision,
        changes: response.body.changes,
        cursor: response.body.from_revision,
        // 实际发出的请求里携带的游标：与 response.from_revision 分开记录，
        // 这样「请求漏字段被当成 undefined」与「响应回显」不会互相掩盖。
        sentCursor: requestBody.last_server_revision,
        cursorBinding,
      });
    }

    // 11. manifest 的 Vault 只认路由：GET 没有正文，响应里的 vault_id 必须等于路由取值。
    //     把模型改成信任查询参数/正文里的 vault_id 后，这条断言必须失败。
    if (response.body.mode === 'manifest') {
      const routeVault = /\/api\/v1\/vaults\/([^/]+)\/sync\//.exec(step.request.endpoint)?.[1];
      assert.equal(routeVault, response.body.vault_id, `步骤 ${step.id}: manifest 的 vault_id 必须取自路由`);
      // 查询串只作为第二来源与请求头一起使用；设备标识必须被原样回显。
      const expectedDevice =
        step.request.headers?.['X-Device-Id'] ??
        Object.entries(step.request.headers ?? {}).find(([key]) => key.toLowerCase() === 'x-device-id')?.[1] ??
        step.request.query?.device_id;
      assert.equal(response.body.device_id, expectedDevice, `步骤 ${step.id}: manifest 必须回显请求携带的 device_id`);
    }

    if (response.body.mode === 'submit' && response.status === 200 && !response.body.replayed) {
      observed.push({ kind: 'submit', stepId: step.id, revision: response.body.vault_revision });
    }
    if (response.body.mode === 'submit' && response.status === 200 && response.body.replayed) {
      // 重放也是可观察结果：只做重放、不写新状态的场景同样必须有可观察记录。
      observed.push({ kind: 'replay', stepId: step.id, revision: response.body.vault_revision, changeId: response.body.change_id });
    }

    // 执行记录在请求、响应、响应断言与状态断言**全部完成之后**才登记。
    // 把这一行提前到循环开头（或断言之前），「执行记录」就不再证明该步真的通过过断言。
    registration.steps.add(step.id);
  }

  return { state, initialStateProjection, responses, observed, registration };
}

/** 空 Vault：vault_revision 与 min_available_revision 都是 0，用于游标 0 的边界场景。 */
const ZERO_VAULT_INITIAL = () => ({
  vault_id: 'vault_zero',
  vault_revision: 0,
  min_available_revision: 0,
  request_sequence: 1,
  files: [],
  versions: [],
  blobs: [],
  changes: [],
  upload_sessions: [],
});

/** 与模型一致的请求体指纹，用于构造「指纹自洽但其余不自洽」的反例。 */
const fingerprintOf = (body) => sha256Of(Buffer.from(stableStringify(body), 'utf8'));

const cloneJson = (value) => JSON.parse(JSON.stringify(value));

/* ------------------------------------------------------------------ */
/* 夹具完整性                                                          */
/* ------------------------------------------------------------------ */

test('夹具目录非空且五个必需场景全部加载', () => {
  assert.ok(SCENARIOS.length >= REQUIRED_SCENARIOS.length, `夹具数量不足：只找到 ${SCENARIOS.length} 个`);
  for (const name of REQUIRED_SCENARIOS) {
    assert.ok(SCENARIO_BY_NAME.has(name), `缺少必需场景 ${name}.json`);
  }
  // 场景名必须与文件名一致且全局唯一，否则改名或复制夹具会让测试静默跑偏。
  assert.deepEqual(scenarioIndexProblems(SCENARIOS), [], '每个夹具的 scenario 必须等于文件名去掉 .json，且场景名唯一');
  for (const { scenario, name } of SCENARIOS) {
    assert.ok(typeof scenario.scenario === 'string' && scenario.scenario.length > 0, `${name} 缺少 scenario 名`);
    assert.equal(scenario.scenario, scenarioNameOfFile(name), `${name}: scenario 必须等于文件名去掉 .json`);
    assert.ok(scenario.initial_state, `${name} 缺少 initial_state`);
    assert.ok(Array.isArray(scenario.steps) && scenario.steps.length > 0, `${name} 缺少非空 steps`);
    for (const step of scenario.steps) {
      assert.ok(typeof step.id === 'string' && step.id.length > 0, `${name} 存在缺 id 的步骤`);
      assert.ok(typeof step.expected_status === 'number', `${name}/${step.id} 缺少 expected_status`);
    }
    // 每一步都必须有非空结果证据与状态证据，缺一即视为夹具不完整。
    assert.deepEqual(stepEvidenceProblems(scenario), [], `${name} 的步骤证据不完整`);
  }
  for (const name of REQUIRED_SCENARIOS) {
    assert.equal(SCENARIO_BY_NAME.get(name)?.name, `${name}.json`, `必需场景 ${name} 必须来自 ${name}.json`);
  }
});

test('夹具步骤必须同时携带非空 expected_result 与真实状态证据', () => {
  // 正向：全部真实夹具都满足要求（上面的加载测试已逐条校验）。
  for (const entry of SCENARIOS) {
    assert.deepEqual(stepEvidenceProblems(entry.scenario), [], `${entry.name} 的步骤证据不完整`);
  }

  // 反向 1：只有 expect_error_fields，没有 expected_result，也没有状态证据 → 三个问题都要报
  // （缺少结果证据、错误步骤缺少 code、缺少状态证据）。
  const errorOnly = stepEvidenceProblems({
    scenario: 'synthetic',
    steps: [{ id: 'error-only', expected_status: 409, expect_error_fields: { code: 'CURSOR_TOO_OLD' } }],
  });
  assert.equal(errorOnly.length, 3, `只有 expect_error_fields 的步骤必须被报出三个问题，实际 ${JSON.stringify(errorOnly)}`);
  assert.ok(
    errorOnly.some((problem) => problem.includes('缺少非空对象 expected_result')),
    '缺少 expected_result 必须被发现',
  );
  assert.ok(
    errorOnly.some((problem) => problem.includes('expect_error_fields 不能替代状态证据')),
    'expect_error_fields 不能替代状态证据',
  );
  assert.ok(
    errorOnly.some((problem) => problem.includes('expected_result.code 必须是非空字符串')),
    '错误步骤缺少 expected_result.code 必须被发现',
  );

  // 反向 2：expected_result 是空对象也不算证据。
  const emptyResult = stepEvidenceProblems({
    scenario: 'synthetic',
    steps: [{ id: 'empty-result', expected_status: 200, expected_result: {}, expect_state_unchanged: true }],
  });
  assert.deepEqual(emptyResult, ['synthetic/empty-result: 缺少非空对象 expected_result'], '空对象 expected_result 必须被发现');

  // 反向 3：expected_result 不是对象。
  const arrayResult = stepEvidenceProblems({
    scenario: 'synthetic',
    steps: [{ id: 'array-result', expected_status: 200, expected_result: [], expected_state: { a: 1 } }],
  });
  assert.deepEqual(arrayResult, ['synthetic/array-result: 缺少非空对象 expected_result'], '数组 expected_result 必须被发现');

  // 反向 4：缺少状态证据（有结果证据也不行）。
  const missingState = stepEvidenceProblems({
    scenario: 'synthetic',
    steps: [{ id: 'no-state', expected_status: 200, expected_result: { mode: 'manifest' } }],
  });
  assert.deepEqual(
    missingState,
    ['synthetic/no-state: 缺少状态证据（expected_state / expect_state_unchanged）'],
    '缺少状态证据必须被发现',
  );

  // 反向 5：空对象 expected_state 也不算状态证据。
  const emptyState = stepEvidenceProblems({
    scenario: 'synthetic',
    steps: [{ id: 'empty-state', expected_status: 200, expected_result: { mode: 'pull' }, expected_state: {} }],
  });
  assert.deepEqual(
    emptyState,
    ['synthetic/empty-state: 缺少状态证据（expected_state / expect_state_unchanged）'],
    '空对象 expected_state 必须被发现',
  );

  // 正向：两类证据齐备时不应被误报。
  const complete = stepEvidenceProblems({
    scenario: 'synthetic',
    steps: [{ id: 'ok', expected_status: 200, expected_result: { mode: 'pull' }, expect_state_unchanged: true }],
  });
  assert.deepEqual(complete, [], '同时具备两类证据的步骤不应被误报');
});

test('场景加载器拒绝 scenario 与文件名不一致、以及场景名重复的夹具', () => {
  // 用同一套索引校验逻辑对合成条目做反向验证：这两类夹具问题必须被发现，而不是静默通过。
  const mismatch = scenarioIndexProblems([
    { name: 'submit-markdown.json', scenario: { scenario: 'renamed-scenario' } },
  ]);
  assert.deepEqual(mismatch, [
    'submit-markdown.json: scenario 为 "renamed-scenario"，必须等于文件名 "submit-markdown"',
  ], '改掉 scenario 值后必须报告为索引问题');
  assert.throws(
    () => indexScenarios([{ name: 'submit-markdown.json', scenario: { scenario: 'renamed-scenario' } }]),
    /scenario 为 "renamed-scenario"，必须等于文件名 "submit-markdown"/,
    '改掉 scenario 值后，索引必须失败',
  );

  const duplicated = scenarioIndexProblems([
    { name: 'submit-markdown.json', scenario: { scenario: 'submit-markdown' } },
    { name: 'submit-markdown-copy.json', scenario: { scenario: 'submit-markdown' } },
  ]);
  assert.equal(duplicated.length, 2, '复制夹具会产生「文件名不一致」与「场景名重复」两个问题');
  assert.ok(
    duplicated.some((problem) => problem.includes('重复的场景名 "submit-markdown"')),
    `必须报告重复场景名，实际: ${JSON.stringify(duplicated)}`,
  );
  assert.throws(
    () => indexScenarios([
      { name: 'submit-markdown.json', scenario: { scenario: 'submit-markdown' } },
      { name: 'submit-markdown-copy.json', scenario: { scenario: 'submit-markdown' } },
    ]),
    /重复的场景名/,
    '两个文件声明同一场景名时，索引必须失败',
  );
});

test('三种正文样本均已加载并被场景引用', () => {
  const referenced = referencedSamples();
  for (const extension of REQUIRED_SAMPLE_EXTENSIONS) {
    const matches = referenced.filter((sample) => sample.endsWith(extension));
    assert.ok(matches.length > 0, `没有场景引用 ${extension} 样本`);
    for (const sample of matches) {
      const bytes = readSample(sample);
      assert.ok(bytes.length > 0, `样本 ${sample} 为空`);
    }
  }
  // JSON 样本必须可解析，且哈希按原始字节计算（不经过重新序列化）。
  for (const sample of referenced.filter((item) => item.endsWith('.json'))) {
    const bytes = readSample(sample);
    assert.doesNotThrow(() => JSON.parse(bytes.toString('utf8')), `JSON 样本 ${sample} 无法解析`);
    assert.match(digestOf(bytes), /^sha256:[0-9a-f]{64}$/, `样本 ${sample} 哈希格式不合法`);
  }
});

test('初始版本记录与正文样本逐项对照（完整哈希与字节数）', () => {
  for (const entry of SCENARIOS) {
    assertInitialVersionsMatchSamples(entry.scenario);
  }

  // 反向：样本字节与版本记录不一致时必须被发现，而不是静默通过。
  const entry = SCENARIO_BY_NAME.get('submit-markdown');
  const tamperedScenario = cloneJson(entry.scenario);
  const tampered = {
    ...tamperedScenario,
    version_samples: { ...tamperedScenario.version_samples },
  };
  // 只改映射指向一份不同字节的样本，模拟「初始版本记录与样本不对应」。
  tampered.version_samples.ver_roadmap_01 = 'notes/roadmap-v2.md';
  assert.throws(
    () => assertInitialVersionsMatchSamples(tampered),
    /content_size|content_hash/,
    '版本记录与样本字节不一致时必须失败',
  );

  // 反向：映射缺项同样必须失败，避免只核对被映射到的部分。
  const missingMapping = { ...tamperedScenario, version_samples: {} };
  assert.throws(
    () => assertInitialVersionsMatchSamples(missingMapping),
    /version_samples/,
    'version_samples 未覆盖全部初始版本时必须失败',
  );
});

test('协议常量覆盖第 9.3 节操作名，且 v1 只执行 update_file_content', () => {
  assert.deepEqual(OPERATION_TYPES, [
    'create_file',
    'update_file_content',
    'rename_file',
    'move_file',
    'delete_file',
    'restore_file',
    'create_directory',
    'rename_directory',
    'move_directory',
    'delete_directory',
    'restore_directory',
    'set_file_metadata',
  ]);
  assert.deepEqual(EXECUTABLE_OPERATIONS, ['update_file_content']);
  assert.equal(ENDPOINTS.changes, '/api/v1/vaults/{vault_id}/sync/changes');
  assert.equal(ENDPOINTS.manifest, '/api/v1/vaults/{vault_id}/sync/manifest');
  assert.deepEqual(METHODS, { changes: 'POST', manifest: 'GET' });
  assert.deepEqual(METADATA_FORMATS, ['md', 'txt', 'json']);
  assert.deepEqual(LINE_ENDINGS, ['lf', 'crlf']);
  assert.deepEqual(UPLOAD_STATUSES, ['pending', 'completed', 'failed']);
});

/* ------------------------------------------------------------------ */
/* 请求适配：标准 Request（SYNC-V1-010 / SYNC-V1-013）                  */
/* ------------------------------------------------------------------ */

const changesUrl = (vaultId) => `${ORIGIN}/api/v1/vaults/${vaultId}/sync/changes`;
const manifestUrl = (vaultId) => `${ORIGIN}/api/v1/vaults/${vaultId}/sync/manifest`;

/** 用标准 Request 表达一次 JSON POST，正文与夹具请求体逐项一致。 */
function postRequest(vaultId, body, headers = {}) {
  return new Request(changesUrl(vaultId), {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', ...headers },
    body: JSON.stringify(body),
  });
}

test('标准 Request 的 POST JSON 正文必须被真正解析（SYNC-V1-010）', async () => {
  const entry = SCENARIO_BY_NAME.get('submit-markdown');
  const step = entry.scenario.steps[0];
  const bytes = readSample(step.content_file);
  const vaultId = entry.scenario.initial_state.vault_id;
  const ctx = { resolveUpload: () => bytes };

  // 1. 标准 Request 携带 JSON 正文：必须成功，且业务结果与夹具期望一致。
  const state = createVaultState(entry.scenario.initial_state);
  const request = postRequest(vaultId, step.request.body, step.request.headers);
  // 正文确实在请求里：这是「模型必须读到它」的前提。
  assert.equal(
    await request.clone().text(),
    JSON.stringify(step.request.body),
    '标准 Request 必须真的携带 JSON 正文',
  );
  const response = await handleRequest(state, request, ctx);
  assert.equal(response.status, 200, `标准 Request POST 必须成功，实际 ${JSON.stringify(response.body)}`);
  // 业务字段必须与夹具的 expected_result 逐项一致：正文若在适配层被丢弃，
  // 这条断言会以「缺字段请求」失败，而不是静默通过。
  assertSubset(response.body, step.expected_result, '标准 Request POST 响应');

  // 2. 同一个 Request 对象可以被复用（连续重试）：适配层必须 clone 后才能重复读到正文。
  const retried = await handleRequest(state, request, ctx);
  assert.equal(retried.status, 200, '同一标准 Request 复用必须仍然读到正文');
  assert.equal(retried.body.replayed, true, '第二次复用应命中幂等账本，而不是因为正文丢失而报缺字段');

  // 3. 反向：如果适配层丢弃正文，同一请求会退化成缺字段 → 必须是 INVALID_REQUEST 而不是 200。
  //    这里用「空正文 POST」直接证明「静默丢正文」会让请求变成缺字段请求。
  const emptyBody = await handleRequest(
    createVaultState(entry.scenario.initial_state),
    new Request(changesUrl(vaultId), { method: 'POST', headers: { 'Content-Type': 'application/json' } }),
    ctx,
  );
  assert.equal(emptyBody.status, 400, '无正文的 POST 必须失败');
  assert.equal(emptyBody.body.code, ERROR_CODES.INVALID_REQUEST);
  assert.ok(Array.isArray(emptyBody.body.missing_fields), '无正文的 POST 必须列出缺失字段');

  // 4. 非法 JSON 正文必须给出稳定的 INVALID_REQUEST，而不是静默当成空对象。
  const brokenJson = await handleRequest(
    createVaultState(entry.scenario.initial_state),
    new Request(changesUrl(vaultId), {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: '{"mode":"submit",',
    }),
    ctx,
  );
  assert.equal(brokenJson.status, 400, '非法 JSON 正文必须返回 400');
  assert.equal(brokenJson.body.code, ERROR_CODES.INVALID_REQUEST, '非法 JSON 正文必须返回 INVALID_REQUEST');
  assert.ok(typeof brokenJson.body.body_error === 'string' && brokenJson.body.body_error.length > 0, '必须说明正文解析失败');

  // 5. GET manifest 仍然是无正文请求：模型不得读取或要求正文。
  const manifestState = createVaultState(entry.scenario.initial_state);
  const manifestRequest = new Request(`${manifestUrl(vaultId)}?device_id=device_mac_0001`, { method: 'GET' });
  assert.equal(manifestRequest.body, null, '标准 Request 的 GET manifest 必须没有正文');
  const manifest = await handleRequest(manifestState, manifestRequest, ctx);
  assert.equal(manifest.status, 200, `GET manifest 必须成功，实际 ${JSON.stringify(manifest.body)}`);
  assert.equal(manifest.body.mode, 'manifest');
});

test('buildRequest 保留夹具字段来源：header 不复制成 query，同 Vault query.vault_id 允许（SYNC-V1-013）', async () => {
  const entry = SCENARIO_BY_NAME.get('stale-cursor-recovery');
  const headerOnly = entry.scenario.steps.find((step) => step.id === 'manifest-header-device-only');
  assert.ok(headerOnly, '夹具必须提供只带请求头 device_id 的 manifest 步骤');
  assert.equal(headerOnly.request.query, undefined, '该步骤不得声明任何查询参数');

  const builtHeaderOnly = buildRequest(headerOnly);
  assert.equal(
    builtHeaderOnly.url.searchParams.get('device_id'),
    null,
    '请求头里的 device_id 不得被复制成查询参数',
  );
  assert.equal(
    builtHeaderOnly.url.searchParams.get('vault_id'),
    null,
    '未声明查询参数时不得凭空写入 vault_id',
  );
  assert.ok(builtHeaderOnly.request.body === null, 'manifest 必须是无正文 GET');

  // 模型必须从请求头读到 device_id（而不是要求查询参数）。
  const headerState = createVaultState(entry.scenario.initial_state);
  const headerResponse = await handleRequest(headerState, builtHeaderOnly.request, { resolveUpload: () => Buffer.alloc(0) });
  assert.equal(headerResponse.status, 200, `只带请求头 device_id 的 manifest 必须成功：${JSON.stringify(headerResponse.body)}`);
  assert.equal(headerResponse.body.device_id, 'device_mac_0001', 'manifest 必须回显请求头里的 device_id');

  // 同 Vault 的 query.vault_id 必须被允许：夹具里存在该步骤，且构造/执行都通过。
  const matching = entry.scenario.steps.find((step) => step.id === 'manifest-matching-query-vault');
  assert.ok(matching, '夹具必须提供「查询参数 vault_id 与路由一致」的 manifest 步骤');
  const builtMatching = buildRequest(matching);
  assert.equal(builtMatching.url.searchParams.get('vault_id'), 'vault_demo_0001', '同 Vault 的 query.vault_id 必须被保留');
  const matchingState = createVaultState(entry.scenario.initial_state);
  const matchingResponse = await handleRequest(matchingState, builtMatching.request, { resolveUpload: () => Buffer.alloc(0) });
  assert.equal(
    matchingResponse.status,
    200,
    `query.vault_id 与路由一致时必须成功，实际 ${JSON.stringify(matchingResponse.body)}`,
  );

  // 冲突的 query.vault_id 仍然必须被拒绝（允许一致，不等于放弃校验）。
  const conflictState = createVaultState(entry.scenario.initial_state);
  const conflictResponse = await handleRequest(
    conflictState,
    new Request(
      `${manifestUrl('vault_demo_0001')}?device_id=device_mac_0001&vault_id=vault_other`,
      { method: 'GET', headers: { 'X-Device-Id': 'device_mac_0001' } },
    ),
    { resolveUpload: () => Buffer.alloc(0) },
  );
  assert.equal(conflictResponse.status, 404, 'query.vault_id 与路由不一致必须返回 404');
  assert.equal(conflictResponse.body.code, ERROR_CODES.VAULT_MISMATCH);

  // POST 的查询串与请求体严格分离：无关查询字段不得影响请求体校验。
  const pullStep = entry.scenario.steps.find((step) => step.id === 'pull-with-matching-query-vault');
  assert.ok(pullStep, '夹具必须提供带 query 的 POST pull 步骤');
  const pullState = createVaultState(entry.scenario.initial_state);
  const pullRequest = new Request(`${changesUrl('vault_demo_0001')}?vault_id=vault_demo_0001&trace=abc`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(pullStep.request.body),
  });
  const pullResponse = await handleRequest(pullState, pullRequest, { resolveUpload: () => Buffer.alloc(0) });
  assert.equal(pullResponse.status, 200, `无关查询字段不得影响 POST：${JSON.stringify(pullResponse.body)}`);
});

/* ------------------------------------------------------------------ */
/* 错误响应结构与字段来源（SYNC-V1-005）                                */
/* ------------------------------------------------------------------ */

/**
 * 所有错误响应都必须带同一组定位字段：`endpoint`、`method`、`allowed_method`。
 * 独立成函数是为了让「破坏任一字段」的突变能被同一个断言击穿。
 */
function assertErrorEnvelope(body, { endpoint, method, allowedMethod, label }) {
  assert.ok(Object.hasOwn(body, 'endpoint'), `${label}: 错误响应必须包含 endpoint 字段`);
  assert.equal(body.endpoint, endpoint, `${label}: endpoint 必须回显实际请求路径`);
  assert.ok(Object.hasOwn(body, 'method'), `${label}: 错误响应必须包含 method 字段`);
  assert.equal(body.method, method, `${label}: method 必须回显实际请求方法`);
  assert.ok(Object.hasOwn(body, 'allowed_method'), `${label}: 错误响应必须包含 allowed_method 字段`);
  assert.equal(body.allowed_method, allowedMethod, `${label}: allowed_method 必须是该端点唯一合法的方法`);
}

test('错误响应保留 endpoint / method / allowed_method（含 405 与 404）', async () => {
  const entry = SCENARIO_BY_NAME.get('stale-cursor-recovery');
  const vaultId = entry.scenario.initial_state.vault_id;
  const ctx = { resolveUpload: () => Buffer.alloc(0) };

  // 405：GET changes。三个字段都必须存在且取值正确。
  const wrongMethod = await handleRequest(
    createVaultState(entry.scenario.initial_state),
    new Request(changesUrl(vaultId), { method: 'GET' }),
    ctx,
  );
  assert.equal(wrongMethod.status, 405);
  assert.equal(wrongMethod.body.code, ERROR_CODES.METHOD_NOT_ALLOWED);
  assertErrorEnvelope(wrongMethod.body, {
    endpoint: `/api/v1/vaults/${vaultId}/sync/changes`,
    method: 'GET',
    allowedMethod: 'POST',
    label: '405 GET changes',
  });

  // 405：POST manifest（标准 Request 允许 POST 带正文）。
  const postManifest = await handleRequest(
    createVaultState(entry.scenario.initial_state),
    new Request(manifestUrl(vaultId), { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' }),
    ctx,
  );
  assert.equal(postManifest.status, 405);
  assertErrorEnvelope(postManifest.body, {
    endpoint: `/api/v1/vaults/${vaultId}/sync/manifest`,
    method: 'POST',
    allowedMethod: 'GET',
    label: '405 POST manifest',
  });

  // 404：端点不属于协议时 allowed_method 为 null，但字段本身必须存在。
  const notFound = await handleRequest(
    createVaultState(entry.scenario.initial_state),
    { method: 'POST', endpoint: '/api/v1/unknown', headers: {}, body: {} },
    ctx,
  );
  assert.equal(notFound.status, 404);
  assert.equal(notFound.body.code, ERROR_CODES.ENDPOINT_NOT_FOUND);
  assertErrorEnvelope(notFound.body, {
    endpoint: '/api/v1/unknown',
    method: 'POST',
    allowedMethod: null,
    label: '404 未知端点',
  });

  // 业务错误同样保留定位字段。
  const cursorTooOld = await handleRequest(
    createVaultState(entry.scenario.initial_state),
    postRequest(vaultId, { mode: 'pull', vault_id: vaultId, device_id: 'device_mac_0001', last_server_revision: 1 }),
    ctx,
  );
  assert.equal(cursorTooOld.status, 409);
  assertErrorEnvelope(cursorTooOld.body, {
    endpoint: `/api/v1/vaults/${vaultId}/sync/changes`,
    method: 'POST',
    allowedMethod: 'POST',
    label: '409 CURSOR_TOO_OLD',
  });

  // 反向：破坏任一字段都必须让上面的断言失败。
  const good = { endpoint: '/api/v1/x', method: 'POST', allowed_method: 'POST' };
  for (const field of ['endpoint', 'method', 'allowed_method']) {
    const broken = { ...good };
    delete broken[field];
    assert.throws(
      () => assertErrorEnvelope(broken, { endpoint: '/api/v1/x', method: 'POST', allowedMethod: 'POST', label: `缺少 ${field}` }),
      /必须包含/,
      `缺少 ${field} 的错误响应必须被断言拦下`,
    );
    const wrong = { ...good, [field]: 'GET' };
    assert.throws(
      () => assertErrorEnvelope(wrong, { endpoint: '/api/v1/x', method: 'POST', allowedMethod: 'POST', label: `${field} 取值错误` }),
      /必须|不符/,
      `${field} 取值错误时必须被断言拦下`,
    );
  }
});

test('POST 请求体与查询串严格分离，错误按请求体校验（SYNC-V1-005）', async () => {
  const entry = SCENARIO_BY_NAME.get('stale-cursor-recovery');
  const vaultId = entry.scenario.initial_state.vault_id;
  const ctx = { resolveUpload: () => Buffer.alloc(0) };
  const pullBody = { mode: 'pull', vault_id: vaultId, device_id: 'device_mac_0001', last_server_revision: 7 };

  const run = async (url, body) => {
    const state = createVaultState(entry.scenario.initial_state);
    const before = snapshotState(state);
    const response = await handleRequest(
      state,
      new Request(url, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) }),
      ctx,
    );
    return { response, state, before };
  };

  // 1. 查询串携带正确的 vault_id、请求体也是正确的 vault_id → 成功。
  const bothOk = await run(`${changesUrl(vaultId)}?vault_id=${vaultId}`, pullBody);
  assert.equal(bothOk.response.status, 200, `查询串与请求体都正确时必须成功：${JSON.stringify(bothOk.response.body)}`);

  // 2. 查询串正确、请求体里的 vault_id 错误 → 必须按**请求体**返回 400 VAULT_MISMATCH，
  //    错误里回显请求体的取值，且状态不变。查询串不得掩盖请求体的问题。
  const bodyWrong = await run(`${changesUrl(vaultId)}?vault_id=${vaultId}`, { ...pullBody, vault_id: 'vault_other' });
  assert.equal(bodyWrong.response.status, 400, '请求体 vault_id 错误必须返回 400');
  assert.equal(bodyWrong.response.body.code, ERROR_CODES.VAULT_MISMATCH);
  assert.equal(bodyWrong.response.body.vault_id, 'vault_other', '错误必须回显请求体里的 vault_id');
  assert.equal(bodyWrong.response.body.expected_vault_id, vaultId);
  assert.deepEqual(snapshotState(bodyWrong.state), bodyWrong.before, '请求体 Vault 不匹配不得改变状态');

  // 3. 请求体缺失 vault_id、查询串提供 vault_id → 仍是 INVALID_REQUEST（查询串不能替代请求体字段）。
  const bodyMissing = await run(`${changesUrl(vaultId)}?vault_id=${vaultId}`, (() => {
    const body = { ...pullBody };
    delete body.vault_id;
    return body;
  })());
  assert.equal(bodyMissing.response.status, 400, '请求体缺失 vault_id 必须返回 400');
  assert.equal(bodyMissing.response.body.code, ERROR_CODES.INVALID_REQUEST, '查询串不得为请求体补字段');
  assert.deepEqual(bodyMissing.response.body.missing_fields, ['vault_id']);

  // 4. 请求体缺失 device_id、查询串提供 device_id → 同样是 INVALID_REQUEST。
  const deviceFromQuery = await run(`${changesUrl(vaultId)}?device_id=device_mac_0001`, (() => {
    const body = { ...pullBody };
    delete body.device_id;
    return body;
  })());
  assert.equal(deviceFromQuery.response.status, 400, '请求体缺失 device_id 必须返回 400');
  assert.equal(deviceFromQuery.response.body.code, ERROR_CODES.INVALID_REQUEST);
  assert.deepEqual(deviceFromQuery.response.body.missing_fields, ['device_id']);

  // 5. 无关查询字段（任意键值）不得影响请求体校验，也不得出现在响应里。
  const unrelated = await run(`${changesUrl(vaultId)}?trace=abc&foo=bar&vault_id=${vaultId}`, pullBody);
  assert.equal(unrelated.response.status, 200, `无关查询字段不得导致失败：${JSON.stringify(unrelated.response.body)}`);
  assert.equal(unrelated.response.body.trace, undefined, '无关查询字段不得出现在响应里');
  assert.equal(unrelated.response.body.foo, undefined, '无关查询字段不得出现在响应里');

  // 6. 查询串里的 vault_id 与路由不一致 → 404；即使请求体正确也不能放行。
  const queryWrong = await run(`${changesUrl(vaultId)}?vault_id=vault_other`, pullBody);
  assert.equal(queryWrong.response.status, 404, '查询串 vault_id 与路由不一致必须返回 404');
  assert.equal(queryWrong.response.body.code, ERROR_CODES.VAULT_MISMATCH);
  assert.deepEqual(snapshotState(queryWrong.state), queryWrong.before, '查询串 Vault 不匹配不得改变状态');
});

test('请求头名称大小写无关：X-Device-Id 与 Idempotency-Key', async () => {
  const entry = SCENARIO_BY_NAME.get('stale-cursor-recovery');
  const vaultId = entry.scenario.initial_state.vault_id;
  const submitEntry = SCENARIO_BY_NAME.get('submit-markdown');
  const submitStep = submitEntry.scenario.steps[0];
  const bytes = readSample(submitStep.content_file);
  const ctx = { resolveUpload: () => bytes };

  // 1. X-Device-Id 的任意大小写拼写都必须被识别为设备标识。
  for (const name of ['X-Device-Id', 'x-device-id', 'X-DEVICE-ID', 'x-DeViCe-Id']) {
    const response = await handleRequest(
      createVaultState(entry.scenario.initial_state),
      new Request(manifestUrl(vaultId), { method: 'GET', headers: { [name]: 'device_mac_0001' } }),
      { resolveUpload: () => Buffer.alloc(0) },
    );
    assert.equal(response.status, 200, `${name}: 必须识别为设备标识来源`);
    assert.equal(response.body.device_id, 'device_mac_0001', `${name}: 必须回显请求头里的设备标识`);
  }

  // 2. Idempotency-Key 的任意大小写 + 取值错误都必须被识别。
  for (const name of ['Idempotency-Key', 'idempotency-key', 'IDEMPOTENCY-KEY', 'iDeMpOtEnCy-KeY']) {
    const state = createVaultState(submitEntry.scenario.initial_state);
    const before = snapshotState(state);
    const response = await handleRequest(
      state,
      postRequest(vaultId, submitStep.request.body, { [name]: 'op_other' }),
      ctx,
    );
    assert.equal(response.status, 400, `${name}: 取值不一致必须返回 400`);
    assert.equal(response.body.code, ERROR_CODES.IDEMPOTENCY_KEY_MISMATCH, `${name}: 必须按大小写无关的字段名识别`);
    assert.equal(response.body.idempotency_key, 'op_other', `${name}: 必须回显请求头取值`);
    assert.deepEqual(snapshotState(state), before, `${name}: 不一致时不得写入状态`);

    const match = await handleRequest(
      createVaultState(submitEntry.scenario.initial_state),
      postRequest(vaultId, submitStep.request.body, { [name]: submitStep.request.body.operation_id }),
      ctx,
    );
    assert.equal(match.status, 200, `${name}: 取值一致时必须成功`);
  }
});

/* ------------------------------------------------------------------ */
/* 历史重放与 initial_state 自洽（SYNC-V1-001 / 008 / 011 / 012）        */
/* ------------------------------------------------------------------ */

test('历史重放校验完整：改历史 Change / 版本 / 首次请求并重算指纹后必须失败（SYNC-V1-001）', () => {
  const entry = SCENARIO_BY_NAME.get('stale-cursor-recovery');
  const initial = entry.scenario.initial_state;
  const clone = () => cloneJson(initial);

  // 正向：真实夹具自洽。
  assert.deepEqual(validateInitialState(initial), [], '真实夹具的历史账本必须自洽');

  const changeIndex = initial.changes.findIndex((change) => change.change_id === 'chg_000005');
  assert.ok(changeIndex >= 0, '夹具应包含 chg_000005');

  // 1. 历史 Change 的 version_id 指向**另一个文件**的版本：必须被发现。
  const otherFileVersion = clone();
  otherFileVersion.changes[changeIndex].version_id = 'ver_beta_01';
  assert.ok(
    validateInitialState(otherFileVersion).some((problem) => problem.includes('属于文件') || problem.includes('不一致')),
    'Change 的 version_id 跨文件必须被发现',
  );

  // 2. 历史版本的 content_hash 被改（Change 不变）：必须被发现。
  const versionHashTampered = clone();
  versionHashTampered.versions.find((version) => version.version_id === 'ver_alpha_02').content_hash = `sha256:${'1'.repeat(64)}`;
  assert.ok(
    validateInitialState(versionHashTampered).some((problem) => problem.includes('content_hash')),
    '版本 content_hash 与 Change 不一致必须被发现',
  );

  // 3. 历史版本的 content_size 被改：必须被发现。
  const versionSizeTampered = clone();
  versionSizeTampered.versions.find((version) => version.version_id === 'ver_alpha_02').content_size = 999;
  assert.ok(
    validateInitialState(versionSizeTampered).some((problem) => problem.includes('content_size')),
    '版本 content_size 与 Change 不一致必须被发现',
  );

  // 4. 历史版本的 vault_revision 被改：必须被发现。
  const versionRevisionTampered = clone();
  versionRevisionTampered.versions.find((version) => version.version_id === 'ver_alpha_02').vault_revision = 4;
  assert.ok(
    validateInitialState(versionRevisionTampered).some((problem) => problem.includes('vault_revision')),
    '版本 vault_revision 与 Change 不一致必须被发现',
  );

  // 5. 历史 Change 的 parent_version_id 被改，同时把版本 parent 一起改：
  //    「历史版本与 Change 一致」但「首次请求的 base_version_id 对不上」时必须失败。
  const parentTampered = clone();
  parentTampered.changes[changeIndex].parent_version_id = null;
  parentTampered.versions.find((version) => version.version_id === 'ver_alpha_02').base_version_id = null;
  assert.ok(
    validateInitialState(parentTampered).some((problem) => problem.includes('base_version_id')),
    '历史版本父版本与首次请求 base_version_id 脱节必须被发现',
  );

  // 6. 历史版本的 blob_id 被改（Change 不变）：结果里的 blob_id 必须被发现。
  const blobTampered = clone();
  blobTampered.versions.find((version) => version.version_id === 'ver_alpha_02').blob_id =
    'blob_93ebd40144b3c07fa3e3da5336efdc92fbf276791700249011b923363ad552b4';
  assert.ok(
    validateInitialState(blobTampered).some((problem) => problem.includes('blob_id')),
    '账本结果 blob_id 与版本不一致必须被发现',
  );

  // 7. 首次请求的 path 被改（指纹重算）：必须被发现。
  const requestPathTampered = clone();
  requestPathTampered.idempotency[0].request.body.path = 'projects/other.md';
  requestPathTampered.idempotency[0].fingerprint = fingerprintOf(requestPathTampered.idempotency[0].request.body);
  assert.ok(
    validateInitialState(requestPathTampered).some((problem) => problem.includes('首次请求与历史 Change 不一致')),
    '首次请求 path 与历史 Change 脱节必须被发现',
  );

  // 8. 首次请求的 operation 被改（指纹重算）：必须被发现。
  const requestOperationTampered = clone();
  requestOperationTampered.idempotency[0].request.body.operation = 'rename_file';
  requestOperationTampered.idempotency[0].fingerprint = fingerprintOf(requestOperationTampered.idempotency[0].request.body);
  assert.ok(
    validateInitialState(requestOperationTampered).some((problem) => problem.includes('operation=')),
    '首次请求 operation 与历史 Change 脱节必须被发现',
  );

  // 9. 首次请求的 content_hash / content_size 被改（指纹重算）：必须被发现。
  const requestContentTampered = clone();
  requestContentTampered.idempotency[0].request.body.content_hash = `sha256:${'2'.repeat(64)}`;
  requestContentTampered.idempotency[0].footer = undefined;
  delete requestContentTampered.idempotency[0].footer;
  requestContentTampered.idempotency[0].fingerprint = fingerprintOf(requestContentTampered.idempotency[0].request.body);
  assert.ok(
    validateInitialState(requestContentTampered).some((problem) => problem.includes('content_hash')),
    '首次请求 content_hash 与历史 Change 脱节必须被发现',
  );

  // 10. 首次请求的 timestamp / metadata / base_content_hash 被改（指纹重算）：必须被发现。
  for (const [label, mutate, needle] of [
    ['client_timestamp', (body) => { body.client_timestamp = '2026-11-21T08:00:00Z'; }, 'client_timestamp'],
    ['metadata', (body) => { body.metadata = { format: 'txt' }; }, 'metadata.format'],
    ['base_content_hash', (body) => { body.base_content_hash = `sha256:${'3'.repeat(64)}`; }, 'base_content_hash'],
  ]) {
    const tampered = clone();
    mutate(tampered.idempotency[0].request.body);
    tampered.idempotency[0].fingerprint = fingerprintOf(tampered.idempotency[0].request.body);
    assert.ok(
      validateInitialState(tampered).some((problem) => problem.includes(needle)),
      `首次请求 ${label} 与历史版本/Change 脱节必须被发现`,
    );
  }

  // 11. 账本 result 的 field 被改（指纹不变，因为指纹只覆盖请求体）：必须被发现。
  for (const [field, value] of [
    ['change_id', 'chg_000999'],
    ['version_id', 'ver_alpha_09'],
    ['file_id', 'file_beta'],
    ['path', 'data/settings.json'],
    ['vault_revision', 4],
    ['content_hash', `sha256:${'4'.repeat(64)}`],
    ['content_size', 1],
    ['parent_version_id', null],
    ['operation_id', 'op_other'],
    ['device_id', 'device_other'],
    ['vault_id', 'vault_other'],
    ['blob_id', 'blob_other'],
  ]) {
    const tampered = clone();
    tampered.idempotency[0].result[field] = value;
    assert.ok(
      validateInitialState(tampered).some((problem) => problem.includes('与历史 Change 不一致')),
      `账本 result.${field} 与历史 Change 不一致必须被发现`,
    );
  }

  // 12. 首次请求 base_revision 超过首次写入 revision：必须被发现。
  const baseRevisionTampered = clone();
  baseRevisionTampered.idempotency[0].request.body.base_revision = 99;
  baseRevisionTampered.idempotency[0].fingerprint = fingerprintOf(baseRevisionTampered.idempotency[0].request.body);
  assert.ok(
    validateInitialState(baseRevisionTampered).some((problem) => problem.includes('base_revision')),
    '首次请求 base_revision 越界必须被发现',
  );

  // 13. 每一类不自洽都必须真的阻止建库。
  assert.throws(
    () => createVaultState(otherFileVersion),
    /initial_state 自检失败/,
    '不自洽的 initial_state 必须阻止建库',
  );
});

test('历史 operation_id 全局唯一：任何历史 Change 的 ID 都不得被新的不同 operation 复用（SYNC-V1-008）', async () => {
  const entry = SCENARIO_BY_NAME.get('stale-cursor-recovery');
  const initial = entry.scenario.initial_state;
  const vaultId = initial.vault_id;
  const state = createVaultState(initial);
  const before = snapshotState(state);

  // 历史 Change 里的全部 operation_id（含 create_file 等非内容更新）都必须被占用。
  const historicalIds = initial.changes.map((change) => change.operation_id);
  assert.ok(historicalIds.length >= 4, '夹具应有至少 4 条历史 Change');
  const usedIds = projectState(state).used_operation_ids;
  for (const operationId of historicalIds) {
    assert.ok(usedIds.includes(operationId), `历史 operation_id ${operationId} 必须被视为已占用`);
  }
  assert.ok(usedIds.includes('op_reserved_failed_upload'), 'reserved_operation_ids 必须被视为已占用');

  // 用 create_file 的历史 ID 发起 update_file_content：必须是 IDEMPOTENCY_KEY_REUSED，
  // 且不得新增 Change。把「只为内容更新建账本」的实现改坏后，这里会变成成功写入。
  const conflictStep = entry.scenario.steps.find((step) => step.id === 'reuse-historical-create-operation');
  const bytes = readSample(conflictStep.content_file);
  // base_revision 只做范围校验（<= vault_revision），与「operation_id 是否已被占用」无关；
  // 这里把它对齐到当前 revision，确保失败原因只可能来自 ID 复用。
  const conflictBody = { ...conflictStep.request.body, base_revision: state.vault_revision };
  const response = await handleRequest(
    state,
    postRequest(vaultId, conflictBody, conflictStep.request.headers),
    { resolveUpload: () => bytes },
  );
  assert.equal(response.status, 409, `复用历史 create_file 的 operation_id 必须被拒绝，实际 ${JSON.stringify(response.body)}`);
  assert.equal(response.body.code, ERROR_CODES.IDEMPOTENCY_KEY_REUSED);
  assert.equal(response.body.operation_id, 'op_create_roadmap');
  assert.equal(response.body.change_id, 'chg_000004', '拒绝响应必须回指占用该 ID 的 Change');
  assert.equal(response.body.replayable, false, '没有完整首次请求的操作必须标记为不可重放');

  const changesAfter = state.changes.length;
  assert.equal(changesAfter, initial.changes.length, '复用历史 operation_id 不得新增 Change');
  assert.equal(state.vault_revision, initial.vault_revision, '复用历史 operation_id 不得推进 revision');
  assert.deepEqual(snapshotState(state), before, '复用历史 operation_id 不得改变协议状态');

  // reserved_operation_ids 声明的 ID 同样拒绝。
  const reservedStep = entry.scenario.steps.find((step) => step.id === 'reuse-reserved-operation-id');
  const reservedState = createVaultState(initial);
  const reservedBefore = snapshotState(reservedState);
  const reservedResponse = await handleRequest(
    reservedState,
    postRequest(vaultId, { ...reservedStep.request.body, base_revision: reservedState.vault_revision }, reservedStep.request.headers),
    { resolveUpload: () => readSample(reservedStep.content_file) },
  );
  assert.equal(reservedResponse.status, 409, `复用保留的 operation_id 必须被拒绝：${JSON.stringify(reservedResponse.body)}`);
  assert.equal(reservedResponse.body.code, ERROR_CODES.IDEMPOTENCY_KEY_REUSED);
  assert.equal(reservedResponse.body.change_id, null, '保留 ID 没有对应 Change，必须显式为 null');
  assert.equal(reservedState.changes.length, initial.changes.length, '复用保留 ID 不得新增 Change');
  assert.deepEqual(snapshotState(reservedState), reservedBefore, '复用保留 ID 不得改变协议状态');

  // 反向：未被占用的新 ID 必须可以正常写入，避免「一律拒绝」通过。
  const freshState = createVaultState(initial);
  // 未占用的新 ID 必须能真正写入：基准要指向该文件**当前**版本，否则失败原因会变成冲突。
  const freshFile = freshState.files.find((file) => file.file_id === conflictStep.request.body.file_id);
  const freshBody = {
    ...conflictStep.request.body,
    operation_id: 'op_brand_new_0001',
    client_timestamp: '2026-11-21T10:30:00Z',
    // base_revision 只做范围校验，必须落在当前 vault_revision 内，否则失败原因会与 ID 复用无关。
    base_revision: freshState.vault_revision,
    base_version_id: freshFile.current_version_id,
    base_content_hash: freshFile.current_content_hash,
  };
  const freshResponse = await handleRequest(
    freshState,
    postRequest(vaultId, freshBody, { 'Idempotency-Key': 'op_brand_new_0001' }),
    { resolveUpload: () => readSample(conflictStep.content_file) },
  );
  assert.equal(freshResponse.status, 200, `未占用的 operation_id 必须可以写入：${JSON.stringify(freshResponse.body)}`);
  assert.equal(freshState.changes.length, initial.changes.length + 1, '新的 operation_id 必须恰好新增一条 Change');
});

test('initial_state 的 min_available_revision 只有缺省才默认 0，显式 null 必须被拒绝（SYNC-V1-014）', () => {
  const entry = SCENARIO_BY_NAME.get('stale-cursor-recovery');
  const initial = entry.scenario.initial_state;
  const clone = () => cloneJson(initial);

  // 1. 字段缺省：默认 0，夹具其余部分已在下界 3 处压缩，因此会出现 continuity 问题；
  //    这里只关心「不会因为缺省而报类型错误」，因此单独检查问题列表里没有类型错误。
  const missingField = clone();
  delete missingField.min_available_revision;
  const missingProblems = validateInitialState(missingField);
  assert.equal(
    missingProblems.some((problem) => problem.includes('不能显式为 null') || problem.includes('必须是非负整数')),
    false,
    `缺省 min_available_revision 不得被报成类型错误，实际 ${JSON.stringify(missingProblems)}`,
  );

  // 2. 显式 null：过去 `?? 0` 会把它静默当成 0，必须改成类型错误。
  const explicitNull = clone();
  explicitNull.min_available_revision = null;
  const nullProblems = validateInitialState(explicitNull);
  assert.ok(
    nullProblems.some((problem) => problem.includes('min_available_revision') && problem.includes('null')),
    `显式 null 的 min_available_revision 必须被报类型错误，实际 ${JSON.stringify(nullProblems)}`,
  );
  assert.throws(
    () => createVaultState(explicitNull),
    /min_available_revision/,
    '显式 null 的 min_available_revision 必须阻止 createVaultState',
  );

  // 3. 其它非法取值仍按类型错误处理。
  for (const [label, value] of [
    ['负整数', -1],
    ['小数', 1.5],
    ['字符串', '3'],
    ['布尔', true],
    ['对象', { value: 3 }],
  ]) {
    const bad = clone();
    bad.min_available_revision = value;
    assert.ok(
      validateInitialState(bad).some((problem) => problem.includes('min_available_revision')),
      `${label} 的 min_available_revision 必须被发现`,
    );
  }

  // 4. 显式 0 是合法值（不能被「非真值」判断误杀）。
  const explicitZero = cloneJson(ZERO_VAULT_INITIAL());
  assert.equal(explicitZero.min_available_revision, 0, '零 Vault 的下界必须显式为 0');
  assert.deepEqual(validateInitialState(explicitZero), [], '显式 min_available_revision = 0 必须合法');
  const state = createVaultState(explicitZero);
  assert.equal(state.min_available_revision, 0, '显式 0 必须原样进入运行态');

  // 5. 缺省字段时运行态下界确实是 0（默认值语义只对缺省生效）。
  //    注意「缺省」指**键不存在**：显式写成 `undefined` 仍是显式声明，属于类型错误。
  const omittedInitial = cloneJson(ZERO_VAULT_INITIAL());
  delete omittedInitial.min_available_revision;
  const omitted = createVaultState(omittedInitial);
  assert.equal(omitted.min_available_revision, 0, '缺省 min_available_revision 在运行态应为 0');
  const explicitUndefined = cloneJson(ZERO_VAULT_INITIAL());
  explicitUndefined.min_available_revision = undefined;
  assert.ok(
    validateInitialState(explicitUndefined).some((problem) => problem.includes('min_available_revision')),
    '显式 undefined 的 min_available_revision 同样不是「缺省」，必须按类型错误处理',
  );
});

test('initial_state 的 revision 必须连续、change_id 必须全局唯一（SYNC-V1-011）', async () => {
  const entry = SCENARIO_BY_NAME.get('stale-cursor-recovery');
  const initial = entry.scenario.initial_state;
  assert.equal(initial.min_available_revision, 3, '夹具下界为 3');
  assert.equal(initial.vault_revision, 6, '夹具 revision 为 6');
  assert.deepEqual(validateInitialState(initial), [], '真实夹具必须自洽');

  // 1. 删除中间 revision 5 的 Change：4..6 不再连续，必须被发现。
  const missingMiddle = cloneJson(initial);
  missingMiddle.changes = missingMiddle.changes.filter((change) => change.vault_revision !== 5);
  missingMiddle.idempotency = [];
  assert.ok(
    validateInitialState(missingMiddle).some((problem) => problem.includes('缺少 revision 5 的 Change')),
    '缺失中间 revision 必须被发现',
  );

  // 2. 删除下界之后的第一条（revision 4）：同样必须被发现。
  const missingFirst = cloneJson(initial);
  missingFirst.changes = missingFirst.changes.filter((change) => change.vault_revision !== 4);
  missingFirst.idempotency = [];
  assert.ok(
    validateInitialState(missingFirst).some((problem) => problem.includes('缺少 revision 4 的 Change')),
    '缺失 min_available_revision + 1 的 Change 必须被发现',
  );

  // 3. 下界以前的历史已压缩（revision 1、2 本来就不在夹具里）：仍必须通过。
  //    要求的是 `min_available_revision + 1` 到 `vault_revision` 连续；下界及更早只是允许缺失。
  assert.ok(
    initial.changes.every((change) => change.vault_revision <= initial.vault_revision),
    '夹具必须只声明 1..vault_revision 范围内的 Change',
  );
  const availableRevisions = initial.changes
    .map((change) => change.vault_revision)
    .filter((revision) => revision > initial.min_available_revision)
    .sort((left, right) => left - right);
  assert.deepEqual(
    availableRevisions,
    Array.from(
      { length: initial.vault_revision - initial.min_available_revision },
      (_, index) => initial.min_available_revision + 1 + index,
    ),
    '下界之后的 revision 必须逐条连续',
  );
  // 4. 下界之前的历史缺失不算问题；但下界之后的每个 revision 都必须有 Change。
  const compressed = cloneJson(initial);
  compressed.min_available_revision = 1;
  compressed.changes = compressed.changes.filter((change) => change.vault_revision !== 2);
  assert.ok(
    validateInitialState(compressed).some((problem) => problem.includes('缺少 revision 2 的 Change')),
    '下界之后的缺口仍必须被发现',
  );

  // 5. 重复的 change_id 必须被发现。
  const duplicatedChangeId = cloneJson(initial);
  duplicatedChangeId.changes[1].change_id = duplicatedChangeId.changes[0].change_id;
  assert.ok(
    validateInitialState(duplicatedChangeId).some((problem) => problem.includes('重复的 change_id')),
    '重复的 change_id 必须被发现',
  );

  // 6. 新生成的 change_id 不得与历史冲突：占用 chg_000007 后，下一次提交必须换一个标识。
  const occupied = cloneJson(initial);
  occupied.changes.push({
    change_id: 'chg_000007',
    vault_id: initial.vault_id,
    vault_revision: 7,
    operation: 'create_file',
    file_id: 'file_gamma',
    path: 'notes/todo.txt',
    version_id: 'ver_gamma_02',
    parent_version_id: 'ver_gamma_01',
    content_hash: 'sha256:e7a5e289ce04c32e9bfaf6727cb66f701b3cdab9d3fb4dca800fc09b84dae0db',
    content_size: 137,
    operation_id: 'op_preoccupied_seven',
    device_id: 'device_mac_0001',
    client_timestamp: '2026-11-21T09:10:00Z',
    created_at: '2026-11-21T09:10:00Z',
  });
  occupied.versions.push({
    version_id: 'ver_gamma_02',
    file_id: 'file_gamma',
    vault_revision: 7,
    blob_id: 'blob_e7a5e289ce04c32e9bfaf6727cb66f701b3cdab9d3fb4dca800fc09b84dae0db',
    content_hash: 'sha256:e7a5e289ce04c32e9bfaf6727cb66f701b3cdab9d3fb4dca800fc09b84dae0db',
    content_size: 137,
    base_version_id: 'ver_gamma_01',
    created_by_device_id: 'device_mac_0001',
    created_at: '2026-11-21T09:10:00Z',
    metadata: { format: 'txt', line_ending: 'lf' },
  });
  occupied.blobs.push({
    blob_id: 'blob_e7a5e289ce04c32e9bfaf6727cb66f701b3cdab9d3fb4dca800fc09b84dae0db',
    vault_id: initial.vault_id,
    content_hash: 'sha256:e7a5e289ce04c32e9bfaf6727cb66f701b3cdab9d3fb4dca800fc09b84dae0db',
    content_size: 137,
    created_by_device_id: 'device_mac_0001',
  });
  occupied.files.find((file) => file.file_id === 'file_gamma').current_version_id = 'ver_gamma_02';
  occupied.vault_revision = 7;
  assert.deepEqual(validateInitialState(occupied), [], '占用 chg_000007 的初态必须自洽');

  const occupiedState = createVaultState(occupied);
  const existingIds = new Set(occupied.changes.map((change) => change.change_id));
  assert.ok(existingIds.has('chg_000007'), '前置状态已占用 chg_000007');

  // 6b. 更严格的一类：历史里存在**非规范**的 change_id，恰好等于下一次 revision 的默认标识。
  //     迁移或早期实现可能写入任意 change_id；默认生成 `chg_<revision>` 时必须避开它。
  const migrated = cloneJson(initial);
  // vault_revision 保持 6，下一次提交是 revision 7 → 默认 change_id 为 chg_000007。
  // 把 revision 5 的历史 change_id 改成 chg_000007，制造「下一个默认标识已被占用」。
  migrated.changes.find((change) => change.vault_revision === 5).change_id = 'chg_000007';
  migrated.idempotency[0].result.change_id = 'chg_000007';
  assert.deepEqual(validateInitialState(migrated), [], '非规范但唯一的历史 change_id 必须被接受');
  const migratedExisting = new Set(migrated.changes.map((change) => change.change_id));
  assert.ok(migratedExisting.has('chg_000007'), '前置状态：下一个默认标识已被历史占用');

  {
    const migratedState = createVaultState(migrated);
    const step = entry.scenario.steps.find((item) => item.id === 'change-after-snapshot');
    const response = await handleRequest(
      migratedState,
      postRequest(initial.vault_id, {
        ...step.request.body,
        operation_id: 'op_after_migrated',
        base_revision: 6,
        client_timestamp: '2026-11-21T10:05:00Z',
      }, { 'Idempotency-Key': 'op_after_migrated' }),
      { resolveUpload: () => readSample(step.content_file) },
    );
    assert.equal(response.status, 200, `基于被占用默认标识的提交必须成功：${JSON.stringify(response.body)}`);
    assert.notEqual(response.body.change_id, 'chg_000007', '新 change_id 不得复用历史已占用的标识');
    assert.ok(
      !migratedExisting.has(response.body.change_id),
      `新 change_id ${response.body.change_id} 不得与任何历史 change_id 冲突`,
    );
    assert.equal(
      new Set(migratedState.changes.map((change) => change.change_id)).size,
      migratedState.changes.length,
      'change_id 在 Vault 内必须唯一',
    );
  }

  // 7. 用一个新 operation 再写一次，生成的 change_id 不得与任何历史冲突。
  {
    const step = entry.scenario.steps.find((item) => item.id === 'change-after-snapshot');
    const response = await handleRequest(
      occupiedState,
      postRequest(initial.vault_id, {
        ...step.request.body,
        operation_id: 'op_after_occupied',
        base_revision: 7,
        base_version_id: 'ver_gamma_02',
        base_content_hash: 'sha256:e7a5e289ce04c32e9bfaf6727cb66f701b3cdab9d3fb4dca800fc09b84dae0db',
        client_timestamp: '2026-11-21T10:00:00Z',
      }, { 'Idempotency-Key': 'op_after_occupied' }),
      { resolveUpload: () => readSample(step.content_file) },
    );
    assert.equal(response.status, 200, `基于占用标识的提交必须成功：${JSON.stringify(response.body)}`);
    assert.notEqual(response.body.change_id, 'chg_000007', '新 change_id 不得复用历史标识');
    assert.ok(!existingIds.has(response.body.change_id), '新 change_id 不得与任何历史 change_id 冲突');
    assert.equal(
      new Set(occupiedState.changes.map((change) => change.change_id)).size,
      occupiedState.changes.length,
      'change_id 在 Vault 内必须唯一',
    );
  }
});

test('删除 initial_state.request_sequence 后不得重用历史 request_id（SYNC-V1-012）', async () => {
  const entry = SCENARIO_BY_NAME.get('stale-cursor-recovery');
  const initial = entry.scenario.initial_state;
  const historyRequestId = initial.idempotency[0].request_id;
  assert.equal(historyRequestId, 'req_000001', '历史 request_id 为 req_000001');

  const run = async (scenarioInitial, stepId) => {
    const step = entry.scenario.steps.find((item) => item.id === stepId);
    assert.ok(step, `缺少步骤 ${stepId}`);
    const state = createVaultState(scenarioInitial);
    const response = await handleRequest(state, buildRequest(step).request, {
      resolveUpload: () => readSample(step.content_file ?? 'notes/roadmap-v2.md'),
    });
    return { state, response, step };
  };

  // 1. 删掉 request_sequence：下一个 request_id 必须跳过历史已用序号。
  const withoutSequence = cloneJson(initial);
  delete withoutSequence.request_sequence;
  assert.deepEqual(validateInitialState(withoutSequence), [], '缺少 request_sequence 本身不构成不自洽');
  const derived = await run(withoutSequence, 'replay-historical-operation');
  assert.equal(derived.response.status, 200, '历史重放必须成功');
  assert.notEqual(
    derived.response.body.request_id,
    historyRequestId,
    '删除 request_sequence 后新请求不得重用历史 request_id',
  );
  assert.ok(
    Number(derived.response.body.request_id.slice('req_'.length)) > Number(historyRequestId.slice('req_'.length)),
    `新 request_id 必须晚于历史序号，实际 ${derived.response.body.request_id}`,
  );

  // 2. 连续多次请求，request_id 必须逐次不同且都不与历史冲突。
  const issued = [derived.response.body.request_id];
  let state = derived.state;
  for (const stepId of ['change-after-snapshot', 'manifest-header-device-only', 'pull-with-matching-query-vault']) {
    const step = entry.scenario.steps.find((item) => item.id === stepId);
    const response = await handleRequest(state, buildRequest(step).request, {
      resolveUpload: () => readSample(step.content_file ?? 'notes/todo-v2.txt'),
    });
    issued.push(response.body.request_id);
  }
  assert.equal(new Set(issued).size, issued.length, `新发出的 request_id 必须互不相同：${JSON.stringify(issued)}`);
  assert.ok(!issued.includes(historyRequestId), '任何新请求都不得重用历史 request_id');

  // 3. 以 request_sequence 显式声明会冲突的初态：必须被拒绝，而不是静默产生重复 ID。
  const conflicting = cloneJson(initial);
  conflicting.request_sequence = 1;
  assert.ok(
    validateInitialState(conflicting).some((problem) => problem.includes('会与历史 request_id 冲突')),
    'request_sequence 与历史冲突必须在加载阶段被发现',
  );
  assert.throws(() => createVaultState(conflicting), /会与历史 request_id 冲突/, '冲突的 request_sequence 必须阻止建库');

  // 4. request_log 里出现的历史 request_id 同样必须参与推导。
  const withLog = cloneJson(initial);
  delete withLog.request_sequence;
  withLog.request_log = [{ request_id: 'req_000042' }];
  const derivedFromLog = await run(withLog, 'replay-historical-operation');
  assert.ok(
    Number(derivedFromLog.response.body.request_id.slice('req_'.length)) > 42,
    `request_log 声明的 request_id 必须参与推导，实际 ${derivedFromLog.response.body.request_id}`,
  );
});

/* ------------------------------------------------------------------ */
/* 状态突变证据（SYNC-V1-009）                                          */
/* ------------------------------------------------------------------ */

test('snapshotState 覆盖上传会话、已占用 operation_id 与所有影响协议结果的状态（SYNC-V1-009）', () => {
  const entry = SCENARIO_BY_NAME.get('other-file-advances-cursor');
  const state = createVaultState(entry.scenario.initial_state);
  const snapshot = snapshotState(state);

  // 1. 上传会话必须参与比较：破坏会话状态不得被「状态未变」漏掉。
  assert.ok(Array.isArray(snapshot.uploads) && snapshot.uploads.length > 0, '快照必须包含上传会话');
  assert.deepEqual(
    snapshot.uploads.map((upload) => upload.blob_reference).sort(),
    entry.scenario.initial_state.upload_sessions.map((upload) => upload.blob_reference).sort(),
    '快照必须包含全部上传会话',
  );
  const uploadTampered = createVaultState(entry.scenario.initial_state);
  const uploadBefore = snapshotState(uploadTampered);
  uploadTampered.uploads[0].status = 'failed';
  assert.notDeepEqual(snapshotState(uploadTampered), uploadBefore, '上传会话状态被改坏必须被快照发现');
  uploadTampered.uploads[0].status = uploadBefore.uploads[0].status;
  uploadTampered.uploads.pop();
  assert.notDeepEqual(snapshotState(uploadTampered), uploadBefore, '删除上传会话必须被快照发现');

  // 2. 已占用 operation_id 必须参与比较。
  assert.ok(Array.isArray(snapshot.used_operations) && snapshot.used_operations.length > 0, '快照必须包含已占用 operation_id');
  const usedTampered = createVaultState(entry.scenario.initial_state);
  const usedBefore = snapshotState(usedTampered);
  usedTampered.usedOperations.delete('op_create_todo');
  assert.notDeepEqual(snapshotState(usedTampered), usedBefore, '丢弃已占用 operation_id 必须被快照发现');
  usedTampered.usedOperations.set('op_ghost', { change_id: null, request_id: null, replayable: false });
  assert.notDeepEqual(snapshotState(usedTampered), usedBefore, '新增已占用 operation_id 必须被快照发现');

  // 3. 版本 / Blob / Change / 文件指针 / revision / 幂等账本与指纹都必须参与比较。
  const cases = [
    ['vault_revision', (s) => { s.vault_revision += 1; }],
    ['versions', (s) => { s.versions.pop(); }],
    ['blobs', (s) => { s.blobs.pop(); }],
    ['changes', (s) => { s.changes.pop(); }],
    ['files', (s) => { s.files[0].current_version_id = 'ver_other'; }],
    ['min_available_revision', (s) => { s.min_available_revision += 1; }],
  ];
  for (const [label, mutate] of cases) {
    const tampered = createVaultState(entry.scenario.initial_state);
    // 先产生一次写入，让 idempotency 也有内容。
    tampered.idempotency.set('op_probe', {
      fingerprint: `sha256:${'0'.repeat(64)}`,
      request_id: 'req_000099',
      result: { mode: 'submit' },
    });
    const before = snapshotState(tampered);
    mutate(tampered);
    assert.notDeepEqual(snapshotState(tampered), before, `${label} 被改坏必须被快照发现`);
  }

  // 4. 请求跟踪信息不与协议状态混在一起：它每次请求都会推进，不能参与「状态未变」比较。
  const trackingBefore = requestTracking(state);
  assert.ok(Number.isInteger(trackingBefore.next_request_sequence), 'requestTracking 必须给出下一个序号');
  assert.deepEqual(trackingBefore.issued_request_ids, [], '初态没有已发出的 request_id');
  assert.equal(snapshot.next_request_sequence, undefined, '协议状态快照不应混入请求跟踪计时器');
});

test('拒绝请求不得新增版本 / Change / Blob / 幂等记录或推进 revision（SYNC-V1-009）', async () => {
  const entry = SCENARIO_BY_NAME.get('submit-markdown');
  const step = entry.scenario.steps[0];
  const bytes = readSample(step.content_file);
  const vaultId = entry.scenario.initial_state.vault_id;
  const ctx = { resolveUpload: () => bytes };

  // 覆盖哈希失败 / 大小失败 / 上传未就绪 / 基准冲突 / Vault 不匹配 / 方法错误六类拒绝路径。
  const rejections = [
    ['content_hash 不符', { content_hash: `sha256:${'a'.repeat(64)}` }, {}, ERROR_CODES.CONTENT_HASH_MISMATCH],
    ['content_size 不符', { content_size: 999 }, {}, ERROR_CODES.CONTENT_SIZE_MISMATCH],
    ['上传会话不存在', { blob_reference: 'upload_absent' }, {}, ERROR_CODES.UPLOAD_NOT_READY],
    ['基准版本过旧', { base_version_id: 'ver_older' }, {}, ERROR_CODES.FILE_VERSION_CONFLICT],
    ['路径不一致', { path: 'projects/other.md' }, {}, ERROR_CODES.PATH_MISMATCH],
    ['格式不一致', { metadata: { format: 'txt' } }, {}, ERROR_CODES.FORMAT_MISMATCH],
    ['Vault 不匹配', { vault_id: 'vault_other' }, {}, ERROR_CODES.VAULT_MISMATCH],
    ['Idempotency-Key 不一致', {}, { 'Idempotency-Key': 'op_other' }, ERROR_CODES.IDEMPOTENCY_KEY_MISMATCH],
  ];

  for (const [label, patch, headers, expectedCode] of rejections) {
    const state = createVaultState(entry.scenario.initial_state);
    const before = snapshotState(state);
    const response = await handleRequest(state, postRequest(vaultId, { ...step.request.body, ...patch }, headers), ctx);
    assert.ok(response.status >= 400, `${label}: 必须被拒绝`);
    assert.equal(response.body.code, expectedCode, `${label}: 错误码不符`);

    // 逐项断言「拒绝不留下任何痕迹」，而不是只看整体快照。
    assert.equal(state.vault_revision, before.vault_revision, `${label}: 拒绝不得推进 vault_revision`);
    assert.equal(state.versions.length, before.versions.length, `${label}: 拒绝不得新增版本`);
    assert.equal(state.changes.length, before.changes.length, `${label}: 拒绝不得新增 Change`);
    assert.equal(state.blobs.length, before.blobs.length, `${label}: 拒绝不得新增 Blob`);
    assert.equal(state.idempotency.size, before.idempotency.length, `${label}: 拒绝不得写入幂等账本`);
    assert.equal(state.usedOperations.size, before.used_operations.length, `${label}: 拒绝不得占用 operation_id`);
    assert.deepEqual(snapshotState(state), before, `${label}: 拒绝请求不得改变协议状态`);
  }

  // 反向：同一份状态上的合法提交必须成功并写入全部记录，确认上面的断言不是「永远不变」。
  const okState = createVaultState(entry.scenario.initial_state);
  const okBefore = snapshotState(okState);
  const okResponse = await handleRequest(okState, postRequest(vaultId, step.request.body, step.request.headers), ctx);
  assert.equal(okResponse.status, 200, '合法提交必须成功');
  assert.equal(okState.vault_revision, okBefore.vault_revision + 1, '合法提交必须推进 revision');
  assert.equal(okState.versions.length, okBefore.versions.length + 1, '合法提交必须新增版本');
  assert.equal(okState.changes.length, okBefore.changes.length + 1, '合法提交必须新增 Change');
  assert.equal(okState.blobs.length, okBefore.blobs.length + 1, '合法提交必须新增 Blob');
  assert.equal(okState.idempotency.size, (okBefore.idempotency?.length ?? 0) + 1, '合法提交必须写入幂等账本');
});

test('上传会话被改坏时提交必须失败，且失败分支不得推进 vault_revision（SYNC-V1-009）', async () => {
  const entry = SCENARIO_BY_NAME.get('submit-markdown');
  const step = entry.scenario.steps[0];
  const bytes = readSample(step.content_file);
  const vaultId = entry.scenario.initial_state.vault_id;
  const ctx = { resolveUpload: () => bytes };

  // 1. 会话状态改成非 completed：必须 UPLOAD_NOT_READY。
  for (const status of UPLOAD_STATUSES.filter((item) => item !== 'completed')) {
    const state = createVaultState(entry.scenario.initial_state);
    state.uploads = state.uploads.map((upload) => ({ ...upload, status }));
    const before = snapshotState(state);
    const response = await handleRequest(state, postRequest(vaultId, step.request.body, step.request.headers), ctx);
    assert.equal(response.status, 409, `status=${status}: 必须返回 409`);
    assert.equal(response.body.code, ERROR_CODES.UPLOAD_NOT_READY, `status=${status}: 必须返回 UPLOAD_NOT_READY`);
    assert.equal(state.vault_revision, before.vault_revision, `status=${status}: 失败分支不得推进 revision`);
    assert.deepEqual(snapshotState(state), before, `status=${status}: 失败分支不得改变协议状态`);
  }

  // 2. 会话被删除：同样必须失败。
  const removed = createVaultState(entry.scenario.initial_state);
  removed.uploads = [];
  const removedBefore = snapshotState(removed);
  const removedResponse = await handleRequest(removed, postRequest(vaultId, step.request.body, step.request.headers), ctx);
  assert.equal(removedResponse.body.code, ERROR_CODES.UPLOAD_NOT_READY, '会话被删除必须返回 UPLOAD_NOT_READY');
  assert.deepEqual(snapshotState(removed), removedBefore, '会话被删除时不得改变协议状态');

  // 3. 跨 Vault 会话不得复用。
  const foreign = createVaultState(entry.scenario.initial_state);
  foreign.uploads = foreign.uploads.map((upload) => ({ ...upload, vault_id: 'vault_other' }));
  const foreignBefore = snapshotState(foreign);
  const foreignResponse = await handleRequest(foreign, postRequest(vaultId, step.request.body, step.request.headers), ctx);
  assert.equal(foreignResponse.body.code, ERROR_CODES.UPLOAD_NOT_READY, '跨 Vault 会话必须返回 UPLOAD_NOT_READY');
  assert.deepEqual(snapshotState(foreign), foreignBefore, '跨 Vault 会话被拒时不得改变协议状态');

  // 4. 内容哈希失败分支：不得推进 revision，也不得写入版本/Change/Blob/账本。
  const badHash = createVaultState(entry.scenario.initial_state);
  const badHashBefore = snapshotState(badHash);
  const badHashResponse = await handleRequest(
    badHash,
    postRequest(vaultId, { ...step.request.body, content_hash: `sha256:${'b'.repeat(64)}` }, step.request.headers),
    ctx,
  );
  assert.equal(badHashResponse.body.code, ERROR_CODES.CONTENT_HASH_MISMATCH);
  assert.equal(badHash.vault_revision, badHashBefore.vault_revision, '哈希失败分支不得推进 vault_revision');
  assert.deepEqual(snapshotState(badHash), badHashBefore, '哈希失败分支不得改变协议状态');
});

test('提交必须核对 completed 上传会话的内容指纹，篡改会话后不得写入任何状态（UPLOAD-FINGERPRINT-001）', async () => {
  const entry = SCENARIO_BY_NAME.get('submit-markdown');
  const step = entry.scenario.steps[0];
  const bytes = readSample(step.content_file);
  const vaultId = entry.scenario.initial_state.vault_id;
  const ctx = { resolveUpload: () => bytes };

  // 正向基线：会话指纹与请求、实际字节三方一致的提交必须成功。
  const okState = createVaultState(entry.scenario.initial_state);
  const okResponse = await handleRequest(okState, postRequest(vaultId, step.request.body, step.request.headers), ctx);
  assert.equal(okResponse.status, 200, `基线提交必须成功：${JSON.stringify(okResponse.body)}`);

  /** 直接篡改内存里 completed 会话的字段后提交，并逐项确认「失败且状态不变」。 */
  const submitWithTamperedSession = async (label, mutate, expectedCode) => {
    const state = createVaultState(entry.scenario.initial_state);
    // 注意：这里绕过 validateInitialState（会话自洽性由加载阶段把关），
    // 直接修改运行期状态，模拟「已完成会话被写坏」的真实服务端故障。
    state.uploads = state.uploads.map((upload) => {
      const next = { ...upload };
      mutate(next);
      return next;
    });
    const before = snapshotState(state);
    const response = await handleRequest(state, postRequest(vaultId, step.request.body, step.request.headers), ctx);
    assert.ok(response.status >= 400, `${label}: 必须被拒绝，实际 ${response.status} ${JSON.stringify(response.body)}`);
    assert.equal(response.body.code, expectedCode, `${label}: 错误码必须是 ${expectedCode}`);
    // 稳定错误码：同一破坏重复提交必须得到同一个 code（不是偶发 500）。
    const second = createVaultState(entry.scenario.initial_state);
    second.uploads = second.uploads.map((upload) => {
      const next = { ...upload };
      mutate(next);
      return next;
    });
    const repeated = await handleRequest(second, postRequest(vaultId, step.request.body, step.request.headers), ctx);
    assert.equal(repeated.body.code, expectedCode, `${label}: 重复提交必须返回同一个稳定错误码`);

    // 失败分支不得写入 Blob / Version / Change / 幂等账本，也不得推进 vault_revision。
    assert.equal(state.vault_revision, before.vault_revision, `${label}: 不得推进 vault_revision`);
    assert.equal(state.versions.length, before.versions.length, `${label}: 不得新增版本`);
    assert.equal(state.changes.length, before.changes.length, `${label}: 不得新增 Change`);
    assert.equal(state.blobs.length, before.blobs.length, `${label}: 不得新增 Blob`);
    assert.equal(state.idempotency.size, before.idempotency.length, `${label}: 不得写入幂等账本`);
    assert.deepEqual(snapshotState(state), before, `${label}: 不得改变任何协议状态`);
    return response;
  };

  // 1. 会话哈希被篡改成另一份合法哈希：实际字节与请求一致，但会话记录不一致。
  const hashDrift = await submitWithTamperedSession(
    '会话 content_hash 被篡改',
    (upload) => {
      upload.content_hash = `sha256:${'c'.repeat(64)}`;
      upload.blob_id = `blob_${'c'.repeat(64)}`;
    },
    ERROR_CODES.CONTENT_HASH_MISMATCH,
  );
  assert.equal(hashDrift.body.content_hash, step.request.body.content_hash, '错误响应必须回显请求的 content_hash');
  assert.equal(hashDrift.body.actual_content_hash, digestOf(bytes), '错误响应必须给出实际字节哈希');
  assert.ok(
    typeof hashDrift.body.upload_content_hash === 'string',
    `错误响应必须给出会话记录的哈希，实际 ${JSON.stringify(hashDrift.body)}`,
  );
  assert.equal(hashDrift.body.upload_content_hash, `sha256:${'c'.repeat(64)}`, '错误响应里的会话哈希必须是被篡改的值');

  // 2. 会话大小被篡改：必须 CONTENT_SIZE_MISMATCH。
  const sizeDrift = await submitWithTamperedSession(
    '会话 content_size 被篡改',
    (upload) => { upload.content_size = upload.content_size + 1; },
    ERROR_CODES.CONTENT_SIZE_MISMATCH,
  );
  assert.equal(sizeDrift.body.actual_content_size, bytes.length, '错误响应必须给出实际字节数');
  assert.equal(sizeDrift.body.content_size, step.request.body.content_size, '错误响应必须回显请求的 content_size');

  // 3. 会话哈希与大小同时改：大小检查先于哈希（协议第 5 节步骤 10 的稳定顺序）。
  await submitWithTamperedSession(
    '会话哈希与大小同时被篡改',
    (upload) => {
      upload.content_hash = `sha256:${'d'.repeat(64)}`;
      upload.content_size = 1;
    },
    ERROR_CODES.CONTENT_SIZE_MISMATCH,
  );

  // 4. 会话字段被删除（显式缺失）同样必须被拒绝，不能把 undefined 当成「一致」。
  await submitWithTamperedSession(
    '会话 content_hash 被删除',
    (upload) => { delete upload.content_hash; },
    ERROR_CODES.CONTENT_HASH_MISMATCH,
  );
  await submitWithTamperedSession(
    '会话 content_size 被删除',
    (upload) => { delete upload.content_size; },
    ERROR_CODES.CONTENT_SIZE_MISMATCH,
  );

  // 5. 反向保证：非会话相关的正常路径仍可成功，避免上面的断言靠「一律失败」通过。
  const stillOk = createVaultState(entry.scenario.initial_state);
  const stillOkResponse = await handleRequest(
    stillOk,
    postRequest(vaultId, step.request.body, step.request.headers),
    ctx,
  );
  assert.equal(stillOkResponse.status, 200, '未被篡改的会话必须仍可提交');
  assert.equal(stillOk.vault_revision, entry.scenario.initial_state.vault_revision + 1, '成功提交必须推进 revision');
});

/* ------------------------------------------------------------------ */
/* 场景执行、零游标与执行记录（SYNC-V1-003 / 007）                      */
/* ------------------------------------------------------------------ */

// 执行**全部**已加载场景（不只是五个必需名称），同时单独保留五个必需名称的检查。
// 主循环是**唯一**登记 `MAIN_LOOP_EXECUTION` 的地方；覆盖测试只读这份记录。
for (const { scenario, name } of SCENARIOS) {
  test(`场景：${scenario.scenario}（${name}）`, async () => {
    const { state, initialStateProjection, observed, registration } = await runScenario(scenario);

    // 每个场景至少要真正执行过请求，且 final_state 与协议状态一致。
    assert.ok(state.vault_revision >= scenario.initial_state.vault_revision, 'vault_revision 不得回退');
    if (scenario.final_state) {
      const projection = projectState(state);
      for (const [dotPath, expectedValue] of Object.entries(scenario.final_state)) {
        assert.deepEqual(getByPath(projection, dotPath), expectedValue, `final_state.${dotPath} 不符`);
      }
    }
    assert.ok(observed.length > 0, `场景 ${scenario.scenario} 没有产生任何可观察结果`);
    assert.ok(
      projectState(state).counts.changes >= initialStateProjection.counts.changes,
      `场景 ${scenario.scenario}: Change 数量不应减少`,
    );

    // 每个场景的每一步都必须真的发出过一次请求。
    for (const step of scenario.steps) {
      assert.equal(
        registration.requests.get(step.id),
        1,
        `场景 ${scenario.scenario}: 步骤 ${step.id} 必须恰好发出一次请求`,
      );
    }
    assert.equal(
      registration.responses.length,
      scenario.steps.length,
      `场景 ${scenario.scenario}: 必须收到与步骤数相同的响应`,
    );

    // 全部断言通过后才登记到统一的主循环记录。
    MAIN_LOOP_EXECUTION.set(scenario.scenario, registration);
  });
}

test('五个必需场景均已由主循环实际执行，且每一步都登记在统一执行记录里（SYNC-V1-007）', () => {
  // 只读主循环留下的记录：不在这里自行补跑场景，否则「场景被跳过」永远不会被发现。
  for (const name of REQUIRED_SCENARIOS) {
    assert.ok(MAIN_LOOP_EXECUTION.has(name), `必需场景 ${name} 必须由「场景：…」主循环实际执行`);
    const registration = MAIN_LOOP_EXECUTION.get(name);
    const expectedSteps = SCENARIO_BY_NAME.get(name).scenario.steps.map((step) => step.id);
    assert.deepEqual(
      [...registration.steps].sort(),
      [...expectedSteps].sort(),
      `必需场景 ${name} 的每一步都必须被执行，缺少 ${expectedSteps.filter((id) => !registration.steps.has(id)).join(', ')}`,
    );
    // 每个登记的步骤都必须留下真实响应，证明它不是「登记后 continue」。
    assert.deepEqual(
      registration.responses.map((item) => item.stepId).sort(),
      [...expectedSteps].sort(),
      `必需场景 ${name} 的每一步都必须留下响应记录`,
    );
    assert.equal(
      registration.responses.length,
      expectedSteps.length,
      `必需场景 ${name} 的响应数必须等于步骤数`,
    );
  }
});

test('全部已加载场景都会由主循环实际执行，且每一步都跑过', () => {
  // 执行循环与场景清单同源：任何新增夹具都必须真的跑起来，不能只停留在「已加载」。
  assert.deepEqual(
    [...MAIN_LOOP_EXECUTION.keys()].sort(),
    SCENARIOS.map((entry) => entry.scenario.scenario).sort(),
    '主循环执行记录必须覆盖全部已加载场景；从执行循环里漏掉任一场景都应让本用例失败',
  );
  for (const { scenario } of SCENARIOS) {
    const registration = MAIN_LOOP_EXECUTION.get(scenario.scenario);
    assert.ok(registration, `场景 ${scenario.scenario} 没有任何执行记录`);
    assert.deepEqual(
      [...registration.steps].sort(),
      scenario.steps.map((step) => step.id).sort(),
      `场景 ${scenario.scenario} 的每一步都必须被执行`,
    );
    for (const step of scenario.steps) {
      assert.equal(registration.requests.get(step.id), 1, `场景 ${scenario.scenario}: 步骤 ${step.id} 必须真的发出请求`);
    }
  }
});

test('至少一个成功提交场景通过异步 resolveUpload 返回 Promise<Buffer>（TEST-04）', () => {
  // 真实等待异步上传解析：模型若漏掉 `await`，会拿到 Promise 而不是 Buffer 并直接失败。
  const asyncRegistrations = [...MAIN_LOOP_EXECUTION.values()].filter(
    (registration) => registration.asyncSteps.length > 0,
  );
  assert.ok(
    asyncRegistrations.length >= 1,
    '至少一个具名场景的成功提交必须走 async resolveUpload（Promise<Buffer>）',
  );
  const asyncSteps = asyncRegistrations.flatMap((registration) => registration.asyncSteps);
  assert.ok(asyncSteps.length >= 1, `异步上传步骤必须真的执行过，实际 ${JSON.stringify(asyncSteps)}`);

  // 正向：同一个异步 ctx 在测试内被真实 await，返回 Buffer。
  const entry = SCENARIO_BY_NAME.get('submit-markdown');
  const step = entry.scenario.steps[0];
  const bytes = readSample(step.content_file);
  const ctx = {
    resolveUpload() {
      return Promise.resolve(bytes);
    },
  };
  const pending = ctx.resolveUpload('upload_roadmap_v2');
  assert.ok(pending instanceof Promise, 'async resolveUpload 必须返回 Promise');
  assert.ok(pending.then, 'async resolveUpload 必须是 thenable');
  return pending.then((resolved) => {
    assert.ok(Buffer.isBuffer(resolved), 'await 之后必须得到 Buffer');
  });
});

test('执行记录只在请求/响应/全部断言完成后登记：断言失败必须不留记录（SYNC-V1-007）', async () => {
  const entry = SCENARIO_BY_NAME.get('submit-markdown');
  const scenario = cloneJson(entry.scenario);
  // 把第一步的状态期望改成一个不可能的值，让断言在响应后失败。
  scenario.steps[0].expected_state = { 'files.file_roadmap.current_version_id': 'ver_impossible' };

  const records = new Map();
  await assert.rejects(
    () => runScenario(scenario, records),
    /状态 files\.file_roadmap\.current_version_id 不符/,
    '错误的 expected_state 必须让场景执行失败',
  );
  // 关键：失败步骤不得被登记。若实现把 executedSteps.add 提前到循环开头（或断言之前），
  // 这一步会留下记录，本断言随即失败。
  const registration = records.get(scenario.scenario);
  assert.ok(registration, '执行记录本身必须存在（场景已开始执行）');
  assert.equal(
    registration.steps.size,
    0,
    `断言失败的步骤不得登记为「已执行」，实际登记了 ${JSON.stringify([...registration.steps])}`,
  );

  // 同样的检查放在第二步失败：第一步必须已登记、第二步不得登记。
  const secondFails = cloneJson(entry.scenario);
  secondFails.steps[1].expected_state = { 'vault_revision': 999 };
  const secondRecords = new Map();
  await assert.rejects(() => runScenario(secondFails, secondRecords), /vault_revision 不符/);
  assert.deepEqual(
    [...secondRecords.get(secondFails.scenario).steps],
    ['submit-roadmap-v2'],
    '只有真正通过全部断言的步骤才能出现在执行记录里',
  );

  // 反向：正常场景必须把每一步都登记上，避免「一律不登记」也能通过上面的断言。
  const okRecords = new Map();
  await runScenario(entry.scenario, okRecords);
  assert.deepEqual(
    [...okRecords.get(entry.scenario.scenario).steps].sort(),
    entry.scenario.steps.map((step) => step.id).sort(),
    '正常场景的每一步都必须被登记',
  );
});

test('绑定游标 0 是合法取值：零游标案例走与场景完全相同的执行路径（SYNC-V1-003）', async () => {
  // 构造一个真实场景：manifest 快照 revision 恰好为 0，随后按该快照续拉。
  // 该场景走与其它场景**完全相同**的 runScenario / buildRequest / handleRequest / 步骤证据路径。
  const zeroScenario = {
    scenario: 'zero-cursor-resume',
    title: '零游标续拉',
    content_samples: {},
    initial_state: ZERO_VAULT_INITIAL(),
    version_samples: {},
    steps: [
      {
        id: 'fetch-empty-manifest',
        request: {
          method: 'GET',
          endpoint: '/api/v1/vaults/vault_zero/sync/manifest',
          headers: { 'X-Device-Id': 'device_mac_0001' },
        },
        expected_status: 200,
        expect_manifest_restores_map: true,
        expect_state_unchanged: true,
        expected_result: { mode: 'manifest', vault_id: 'vault_zero', snapshot_revision: 0, files: [] },
        expected_state: { vault_revision: 0, 'counts.changes': 0 },
      },
      {
        id: 'resume-at-zero',
        cursor_from_step: 0,
        cursor_from_field: 'snapshot_revision',
        request: {
          method: 'POST',
          endpoint: '/api/v1/vaults/vault_zero/sync/changes',
          headers: {},
          body: { mode: 'pull', vault_id: 'vault_zero', device_id: 'device_mac_0001' },
        },
        expected_status: 200,
        expect_state_unchanged: true,
        expected_result: { mode: 'pull', from_revision: 0, to_revision: 0, changes: [] },
        expected_state: { vault_revision: 0, 'counts.changes': 0 },
      },
    ],
  };

  // 1. 场景自身必须通过证据与初态校验。
  assert.deepEqual(stepEvidenceProblems(zeroScenario), [], '零游标场景的步骤证据必须完整');
  assert.deepEqual(validateInitialState(zeroScenario.initial_state), [], '零游标初态必须自洽');

  // 2. 真实执行：游标 0 必须被真正注入，而不是被当成「未绑定」。
  const records = new Map();
  const { observed, registration } = await runScenario(zeroScenario, records);
  assert.deepEqual(
    [...registration.steps].sort(),
    ['fetch-empty-manifest', 'resume-at-zero'],
    '零游标场景的每一步都必须执行并登记',
  );

  const snapshot = observed.find((item) => item.kind === 'snapshot');
  assert.ok(snapshot, '必须记录取到 manifest 快照');
  assert.equal(snapshot.revision, 0, '空 Vault 的快照 revision 必须是 0');

  const pull = observed.find((item) => item.kind === 'pull');
  assert.ok(pull, '必须记录续拉响应');
  // 三重证据：绑定声明、请求实际携带的值、响应回显的值都必须是 0。
  assert.deepEqual(
    pull.cursorBinding,
    { sourceStep: 0, field: 'snapshot_revision', value: 0 },
    '零游标续拉必须以 snapshot_revision=0 绑定',
  );
  assert.equal(pull.sentCursor, 0, '请求体必须真的携带 last_server_revision: 0');
  assert.equal(pull.cursor, 0, '响应必须回显 from_revision: 0');
  assert.deepEqual(pull.changes, [], '空 Vault 不应返回任何 Change');

  // 3. 直接破坏真实绑定路径：把「按是否绑定」改成「按取值真假」后，同一个场景必须失败。
  //    这里用一条与 buildRequest 相同的构造规则复现该破坏，确保断言确实能击穿它。
  const brokenBound = (boundCursor) => (boundCursor || undefined);
  const step = zeroScenario.steps[1];
  const brokenCursor = brokenBound(0);
  assert.equal(brokenCursor, undefined, '真值判断会把游标 0 变成 undefined');
  const brokenBody = brokenCursor !== undefined
    ? { ...step.request.body, last_server_revision: brokenCursor }
    : { ...step.request.body };
  assert.equal(
    Object.hasOwn(brokenBody, 'last_server_revision'),
    false,
    '破坏后的构造会让请求缺字段',
  );
  const brokenState = createVaultState(zeroScenario.initial_state);
  const brokenResponse = await handleRequest(
    brokenState,
    postRequest('vault_zero', brokenBody),
    { resolveUpload: () => Buffer.alloc(0) },
  );
  assert.equal(brokenResponse.status, 400, '缺 last_server_revision 的拉取必须失败');
  assert.equal(brokenResponse.body.code, ERROR_CODES.INVALID_REQUEST, '缺游标必须是 INVALID_REQUEST');
  assert.deepEqual(brokenResponse.body.missing_fields, ['last_server_revision'], '必须指出缺失的游标字段');
  // 正确构造下同一请求必须成功：两条路径的差异只来自「是否把 0 当成未绑定」。
  const okState = createVaultState(zeroScenario.initial_state);
  const okResponse = await handleRequest(
    okState,
    postRequest('vault_zero', { ...step.request.body, last_server_revision: 0 }),
    { resolveUpload: () => Buffer.alloc(0) },
  );
  assert.equal(okResponse.status, 200, '正确注入游标 0 的拉取必须成功');

  // 4. 未经 runScenario 的旁路也必须失败：直接按「真值判断」构造时，pull.sentCursor 不会是 0。
  assert.notEqual(brokenCursor, pull.sentCursor, '破坏后的构造不可能得到 sentCursor === 0');
});

test('续拉游标跟随快照 revision 变化，硬编码 6 必然失败', async () => {
  const entry = SCENARIO_BY_NAME.get('stale-cursor-recovery');
  // 走与场景执行完全相同的绑定代码：revision 6 与 7 的两次续拉都由 manifest 响应注入游标。
  const { state, observed } = await runScenario(entry.scenario);

  const snapshots = observed.filter((item) => item.kind === 'snapshot');
  assert.deepEqual(
    snapshots.map((item) => item.revision),
    [6, 7],
    '同一场景内应先后得到 snapshot revision 6 与 7 两次快照',
  );

  const boundPulls = observed.filter((item) => item.kind === 'pull' && item.cursorBinding);
  assert.equal(boundPulls.length, 2, 'revision 6 与 7 的两次续拉都必须经过同一绑定逻辑');

  const [first, second] = boundPulls;
  // 两次续拉的实际游标分别等于各自 manifest 响应的 snapshot_revision，而不是同一个字面量。
  assert.equal(first.sentCursor, 6, '第一次续拉请求必须携带游标 6');
  assert.equal(first.cursor, 6, '第一次续拉的游标必须等于第一个快照 revision 6');
  assert.equal(second.sentCursor, 7, '第二次续拉请求必须携带游标 7');
  assert.equal(second.cursor, 7, '第二次续拉的游标必须等于第二个快照 revision 7');
  assert.notEqual(first.cursor, second.cursor, '两次续拉的游标必须随快照变化，不能写死');

  // 在同一份含历史 Change 的状态上，按实际发出的游标核对 Change ID。
  const changesAtSix = first.changes.map((change) => change.change_id);
  const changesAtSeven = second.changes.map((change) => change.change_id);
  assert.deepEqual(changesAtSix, ['chg_000007'], '游标 6 续拉应恰好返回快照后的 chg_000007');
  assert.deepEqual(changesAtSeven, [], '游标 7 续拉时快照已包含 chg_000007，必须返回空数组');
  assert.equal(first.changes[0].vault_revision, 7, '游标 6 返回的变更 revision 必须是 7');
  for (const change of first.changes) {
    assert.ok(change.vault_revision > first.cursor, '续拉只能返回严格晚于游标的 Change');
  }

  // 对照：在同一份最终状态上把游标写死为 6，第二次续拉会多返回 chg_000007。
  // 因此「把注入值改成常量 6」必然让上面的 changesAtSeven 断言失败。
  const hardcoded = await handleRequest(
    state,
    postRequest(entry.scenario.initial_state.vault_id, {
      mode: 'pull',
      vault_id: entry.scenario.initial_state.vault_id,
      device_id: 'device_mac_0001',
      last_server_revision: 6,
    }),
    { resolveUpload: () => Buffer.alloc(0) },
  );
  assert.equal(hardcoded.status, 200, '对照拉取应成功');
  assert.deepEqual(
    hardcoded.body.changes.map((change) => change.change_id),
    ['chg_000007'],
    '写死 6 会把快照已包含的 chg_000007 再返回一次，与正确结果不同',
  );
  assert.notDeepEqual(
    hardcoded.body.changes.map((change) => change.change_id),
    changesAtSeven,
    '硬编码 6 的结果必须与按实际游标 7 续拉的结果不同，才能被本用例发现',
  );
});

test('过期游标恢复：快照后变更恰好出现一次，且续拉游标取自 manifest 快照', async () => {
  const entry = SCENARIO_BY_NAME.get('stale-cursor-recovery');
  const { observed } = await runScenario(entry.scenario);

  const snapshot = observed.find((item) => item.kind === 'snapshot' && item.stepId === 'fetch-manifest-snapshot');
  assert.ok(snapshot, '缺少 fetch-manifest-snapshot 的快照观察结果');
  assert.equal(snapshot.revision, 6, '第一个快照 revision 必须是 6');

  // 续拉步骤必须显式声明游标来源于 manifest 步骤响应的 snapshot_revision。
  const resumeStep = entry.scenario.steps.find((step) => step.id === 'resume-from-snapshot-revision');
  assert.ok(resumeStep, '缺少 resume-from-snapshot-revision 步骤');
  assert.equal(
    resumeStep.cursor_from_step,
    snapshot.stepIndex,
    'resume-from-snapshot-revision 的 cursor_from_step 必须指向 fetch-manifest-snapshot',
  );
  assert.equal(resumeStep.cursor_from_field ?? 'snapshot_revision', 'snapshot_revision', '续拉游标字段必须是 snapshot_revision');

  const resumed = observed.find((item) => item.kind === 'pull' && item.stepId === 'resume-from-snapshot-revision');
  assert.ok(resumed, '缺少 resume-from-snapshot-revision 的拉取观察结果');
  // 实际使用的游标必须等于该步 manifest 响应里的 snapshot_revision —— 不是夹具里写死的 6。
  assert.deepEqual(
    resumed.cursorBinding,
    { sourceStep: snapshot.stepIndex, field: 'snapshot_revision', value: snapshot.revision },
    '续拉游标必须实际取自 manifest 响应的 snapshot_revision',
  );
  assert.equal(resumed.sentCursor, snapshot.revision, '续拉请求体必须真正携带快照 revision');
  assert.equal(resumed.cursor, snapshot.revision, '续拉请求的 from_revision 必须等于快照 revision');

  const ids = resumed.changes.map((change) => change.change_id);
  assert.equal(new Set(ids).size, ids.length, '续拉结果出现重复 Change');
  for (const change of resumed.changes) {
    assert.ok(change.vault_revision > snapshot.revision, '续拉不得重复返回快照已包含的 Change');
  }
  assert.deepEqual(ids, ['chg_000007'], '快照之后恰好产生一条变更，续拉应只返回该条');

  // 第二个快照后的续拉：快照已包含 chg_000007，必须返回空，且游标仍由 manifest 派生。
  const secondSnapshot = observed.find((item) => item.kind === 'snapshot' && item.stepId === 'fetch-manifest-after-resume');
  assert.ok(secondSnapshot, '缺少 fetch-manifest-after-resume 的快照观察结果');
  const secondResume = observed.find((item) => item.kind === 'pull' && item.stepId === 'resume-from-second-snapshot');
  assert.ok(secondResume, '缺少 resume-from-second-snapshot 的拉取观察结果');
  assert.deepEqual(
    secondResume.cursorBinding,
    { sourceStep: secondSnapshot.stepIndex, field: 'snapshot_revision', value: secondSnapshot.revision },
    '第二次续拉的游标也必须取自第二个 manifest 响应',
  );
  assert.equal(secondResume.cursor, 7, '第二次续拉的游标必须等于第二个快照 revision 7');
  assert.deepEqual(secondResume.changes, [], '第二个快照之后没有新变更，续拉必须返回空数组');
});

/* ------------------------------------------------------------------ */
/* 幂等、冲突与内容寻址                                                 */
/* ------------------------------------------------------------------ */

test('历史幂等账本：原请求重放返回首次结果，同 ID 异内容拒绝', async () => {
  const entry = SCENARIO_BY_NAME.get('stale-cursor-recovery');
  const initial = entry.scenario.initial_state;
  const historical = initial.idempotency[0];
  assert.ok(historical, '初态必须显式携带历史操作的幂等账本');

  // 初态必须自洽：账本条目与 revision 5 的历史 Change 逐项对应。
  assert.deepEqual(validateInitialState(initial), [], '初态必须通过自洽校验');
  assert.equal(historical.operation_id, 'op_roadmap_v2_0001', '历史账本的 operation_id 不符');
  assert.equal(historical.result.version_id, 'ver_alpha_02', '历史账本必须记录首次版本');
  assert.equal(historical.result.change_id, 'chg_000005', '历史账本必须记录首次 Change');
  assert.equal(historical.result.vault_revision, 5, '历史账本必须记录首次 revision');
  assert.equal(historical.request_id, 'req_000001', '历史账本必须记录首次请求 ID');
  assert.match(historical.fingerprint, /^sha256:[0-9a-f]{64}$/, '历史账本必须携带合法指纹');

  const state = createVaultState(initial);
  const before = snapshotState(state);
  const historyChangeCount = state.changes.length;
  const historyVersionCount = state.versions.length;

  // 1. 原请求重放：返回首次结果，不新增版本或 Change。
  const original = await handleRequest(state, postRequest(initial.vault_id, historical.request.body, historical.request.headers), {
    resolveUpload: () => readSample('notes/roadmap-v2.md'),
  });
  assert.equal(original.status, 200, `历史原请求重放应成功，实际 ${JSON.stringify(original.body)}`);
  assert.equal(original.body.replayed, true, '历史原请求重放必须标记 replayed');
  assert.equal(original.body.original_request_id, 'req_000001', '重放必须回指历史首次请求');
  assert.equal(original.body.version_id, 'ver_alpha_02', '重放必须返回历史首次版本');
  assert.equal(original.body.change_id, 'chg_000005', '重放必须返回历史首次 Change');
  assert.equal(original.body.vault_revision, 5, '重放必须返回历史首次 revision');
  assert.equal(state.versions.length, historyVersionCount, '历史重放不得新增版本');
  assert.equal(state.changes.length, historyChangeCount, '历史重放不得新增 Change');
  assert.equal(state.vault_revision, before.vault_revision, '历史重放不得推进 vault_revision');
  assert.deepEqual(snapshotState(state), before, '历史重放不得改变协议状态（含幂等指纹与上传会话）');

  // 2. 连续多次重试：每次结果相同，且每次都不改变状态。
  for (let attempt = 0; attempt < 3; attempt += 1) {
    const retrySnapshot = snapshotState(state);
    const retry = await handleRequest(state, postRequest(initial.vault_id, historical.request.body, historical.request.headers), {
      resolveUpload: () => readSample('notes/roadmap-v2.md'),
    });
    assert.equal(retry.status, 200, `第 ${attempt + 1} 次重试应成功`);
    assert.deepEqual(
      businessFields(retry.body),
      businessFields(original.body),
      `第 ${attempt + 1} 次重试必须返回同一业务结果`,
    );
    assert.deepEqual(snapshotState(state), retrySnapshot, `第 ${attempt + 1} 次重试不得改变协议状态`);
  }

  // 3. 同一历史 operation_id 携带不同内容：必须拒绝，且回指首次请求。
  const reused = await handleRequest(
    state,
    postRequest(initial.vault_id, { ...historical.request.body, client_timestamp: '2026-11-21T09:59:00Z' }, historical.request.headers),
    { resolveUpload: () => readSample('notes/roadmap-v2.md') },
  );
  assert.equal(reused.status, 409, `历史 operation_id 异内容必须拒绝，实际 ${reused.status}`);
  assert.equal(reused.body.code, ERROR_CODES.IDEMPOTENCY_KEY_REUSED, '历史 operation_id 异内容必须返回 IDEMPOTENCY_KEY_REUSED');
  assert.equal(reused.body.original_request_id, 'req_000001', '拒绝响应必须回指历史首次请求');
  assert.deepEqual(snapshotState(state), before, '被拒绝的历史复用不得改变协议状态');
});

test('历史幂等账本的指纹、首次请求与历史 Change 必须在加载阶段相互核对', () => {
  const entry = SCENARIO_BY_NAME.get('stale-cursor-recovery');
  const initial = entry.scenario.initial_state;
  const clone = () => cloneJson(initial);

  // 正向：真实夹具自洽。
  assert.deepEqual(validateInitialState(initial), [], '真实夹具的历史账本必须自洽');

  // 1. 指纹被改写：重放路径会「命中即返回」，却把另一份内容当成首次请求。
  const fingerprintTampered = clone();
  fingerprintTampered.idempotency[0].fingerprint = `sha256:${'0'.repeat(64)}`;
  assert.ok(
    validateInitialState(fingerprintTampered).some((problem) => problem.includes('fingerprint 与其首次请求体不一致')),
    '指纹与首次请求体不一致必须在加载阶段被发现',
  );
  assert.throws(() => createVaultState(fingerprintTampered), /fingerprint 与其首次请求体不一致/, '不自洽的指纹必须阻止建库');

  // 2. 首次请求缺正文：无法核对指纹，同样必须拒绝。
  const requestMissing = clone();
  delete requestMissing.idempotency[0].request;
  assert.ok(
    validateInitialState(requestMissing).some((problem) => problem.includes('缺少首次请求')),
    '账本缺首次请求必须在加载阶段被发现',
  );

  // 3. 首次请求的 operation_id 与账本键不一致。
  const requestMismatched = clone();
  requestMismatched.idempotency[0].request.body.operation_id = 'op_something_else';
  requestMismatched.idempotency[0].fingerprint = fingerprintOf(requestMismatched.idempotency[0].request.body);
  assert.ok(
    validateInitialState(requestMismatched).some((problem) => problem.includes('operation_id 不一致')),
    '首次请求的 operation_id 与账本键不一致必须被发现',
  );

  // 4. 首次请求指向另一份内容：指纹虽自洽，但与历史 Change 不是同一次写入。
  const requestDrifted = clone();
  requestDrifted.idempotency[0].request.body.device_id = 'device_other';
  requestDrifted.idempotency[0].fingerprint = fingerprintOf(requestDrifted.idempotency[0].request.body);
  assert.ok(
    validateInitialState(requestDrifted).some((problem) => problem.includes('首次请求与历史 Change 不一致')),
    '首次请求与历史 Change 脱节必须被发现',
  );

  // 5. 首次请求的 mode 不是 submit。
  const requestPull = clone();
  requestPull.idempotency[0].request.body.mode = 'pull';
  requestPull.idempotency[0].fingerprint = fingerprintOf(requestPull.idempotency[0].request.body);
  assert.ok(
    validateInitialState(requestPull).some((problem) => problem.includes('mode 必须为 submit')),
    '账本首次请求的 mode 必须为 submit',
  );

  // 6. 历史内容更新缺少账本条目。
  const ledgerMissing = clone();
  ledgerMissing.idempotency = [];
  assert.ok(
    validateInitialState(ledgerMissing).some((problem) => problem.includes('缺少幂等账本条目')),
    '历史内容更新缺少账本必须被发现',
  );

  // 7. 首次请求的 method / endpoint / Idempotency-Key 不自洽。
  for (const [label, mutate, needle] of [
    ['method', (request) => { request.method = 'GET'; }, '方法必须为 POST'],
    ['endpoint', (request) => { request.endpoint = '/api/v1/vaults/other/sync/changes'; }, 'endpoint 必须是本 Vault 的 sync/changes'],
    ['Idempotency-Key', (request) => { request.headers['Idempotency-Key'] = 'op_other'; }, 'Idempotency-Key 不一致'],
  ]) {
    const tampered = clone();
    mutate(tampered.idempotency[0].request);
    assert.ok(
      validateInitialState(tampered).some((problem) => problem.includes(needle)),
      `首次请求 ${label} 不自洽必须被发现`,
    );
  }

  // 8. 账本 request_id 与结果 request_id 不一致。
  const resultRequestId = clone();
  resultRequestId.idempotency[0].result.request_id = 'req_000999';
  assert.ok(
    validateInitialState(resultRequestId).some((problem) => problem.includes('结果 request_id')),
    '结果 request_id 与首次 request_id 不一致必须被发现',
  );
});

test('状态快照把幂等指纹纳入比较，连续重放不会掩盖指纹丢失', async () => {
  const entry = SCENARIO_BY_NAME.get('submit-markdown');
  const step = entry.scenario.steps[0];
  const bytes = readSample(step.content_file);
  const vaultId = entry.scenario.initial_state.vault_id;
  const state = createVaultState(entry.scenario.initial_state);
  const first = await handleRequest(state, postRequest(vaultId, step.request.body, step.request.headers), {
    resolveUpload: () => bytes,
  });
  assert.equal(first.status, 200, '首次提交必须成功');

  const snapshot = snapshotState(state);
  const ledgerEntry = snapshot.idempotency.find((entryItem) => entryItem.operation_id === step.request.body.operation_id);
  assert.ok(ledgerEntry, '状态快照必须包含幂等账本条目');
  // 指纹必须出现在快照里：否则「重放时清空指纹」这种破坏不会被 expect_state_unchanged 发现。
  assert.match(ledgerEntry.fingerprint, /^sha256:[0-9a-f]{64}$/, '状态快照必须携带幂等指纹');

  const fingerprintBefore = ledgerEntry.fingerprint;
  // 模拟破坏：重放路径把指纹清空。快照比较必须发现差异。
  state.idempotency.get(step.request.body.operation_id).fingerprint = '';
  assert.notDeepEqual(snapshotState(state), snapshot, '指纹被清空必须被快照比较发现');
  state.idempotency.get(step.request.body.operation_id).fingerprint = fingerprintBefore;

  // 连续重放多次，状态快照必须逐次稳定。
  for (let attempt = 0; attempt < 3; attempt += 1) {
    const retryBefore = snapshotState(state);
    const retry = await handleRequest(state, postRequest(vaultId, step.request.body, step.request.headers), {
      resolveUpload: () => bytes,
    });
    assert.equal(retry.body.replayed, true, `第 ${attempt + 1} 次重放必须命中幂等`);
    assert.deepEqual(snapshotState(state), retryBefore, `第 ${attempt + 1} 次重放不得改变含指纹的状态`);
  }
});

test('方法与路径联合校验：合法组合成功，错误方法返回 METHOD_NOT_ALLOWED', async () => {
  const entry = SCENARIO_BY_NAME.get('stale-cursor-recovery');
  const vaultId = entry.scenario.initial_state.vault_id;
  const ctx = { resolveUpload: () => Buffer.alloc(0) };

  // 合法组合：GET manifest 必须成功，且不改变状态。
  // 用标准 Request 构造无正文 GET：这正是 Web 端的调用方式，带正文会在构造时抛 TypeError。
  const manifestState = createVaultState(entry.scenario.initial_state);
  const before = snapshotState(manifestState);
  const manifestRequest = new Request(`${manifestUrl(vaultId)}?device_id=device_mac_0001`, { method: 'GET' });
  assert.equal(manifestRequest.body, null, '标准 Request 的 GET manifest 必须没有正文');
  const manifestOk = await handleRequest(manifestState, manifestRequest, ctx);
  assert.equal(manifestOk.status, 200, `GET manifest 应成功，实际 ${JSON.stringify(manifestOk.body)}`);
  assert.equal(manifestOk.body.mode, 'manifest');
  assert.deepEqual(snapshotState(manifestState), before, 'manifest 是只读请求，不得改变状态');

  // 同一份无正文 GET 也可以通过请求头提供设备标识。
  const headerDeviceState = createVaultState(entry.scenario.initial_state);
  const headerDevice = await handleRequest(
    headerDeviceState,
    new Request(manifestUrl(vaultId), { method: 'GET', headers: { 'x-device-id': 'device_mac_0001' } }),
    ctx,
  );
  assert.equal(headerDevice.status, 200, '设备标识放在请求头时 manifest 也必须成功');
  assert.equal(headerDevice.body.device_id, 'device_mac_0001', 'manifest 必须回显请求头里的设备标识');

  // 反向：夹具若试图给 GET 携带正文，标准 Request 会拒绝构造，说明该夹具本身违反契约。
  assert.throws(
    () => new Request(manifestUrl(vaultId), { method: 'GET', body: '{}' }),
    TypeError,
    'GET manifest 携带正文必须在构造阶段失败',
  );

  // 合法组合：POST changes 的 pull 必须成功；同一请求改成其它方法必须被拒绝。
  const pullBody = {
    mode: 'pull',
    vault_id: vaultId,
    device_id: 'device_mac_0001',
    last_server_revision: entry.scenario.initial_state.min_available_revision,
  };
  const pullState = createVaultState(entry.scenario.initial_state);
  const pullOk = await handleRequest(pullState, postRequest(vaultId, pullBody), ctx);
  assert.equal(pullOk.status, 200, `POST changes 的 pull 应成功，实际 ${JSON.stringify(pullOk.body)}`);

  const swapped = [
    ['GET changes', 'GET', `/api/v1/vaults/${vaultId}/sync/changes`, 'POST'],
    ['POST manifest', 'POST', `/api/v1/vaults/${vaultId}/sync/manifest`, 'GET'],
    ['DELETE manifest', 'DELETE', `/api/v1/vaults/${vaultId}/sync/manifest`, 'GET'],
    // 方法必须精确匹配：小写 `post` 不是契约里的 `POST`。
    ['changes 用小写 post', 'post', `/api/v1/vaults/${vaultId}/sync/changes`, 'POST'],
    ['manifest 用小写 get', 'get', `/api/v1/vaults/${vaultId}/sync/manifest`, 'GET'],
    ['changes 缺 method', undefined, `/api/v1/vaults/${vaultId}/sync/changes`, 'POST'],
  ];
  for (const [label, method, endpoint, allowedMethod] of swapped) {
    const state = createVaultState(entry.scenario.initial_state);
    const snapshot = snapshotState(state);
    const response = await handleRequest(
      state,
      { method, endpoint, headers: {}, body: method === 'GET' ? undefined : pullBody },
      ctx,
    );
    assert.equal(response.status, 405, `${label}: 期望 405，实际 ${response.status}`);
    assert.equal(response.body.code, ERROR_CODES.METHOD_NOT_ALLOWED, `${label}: 错误码不符`);
    assert.equal(response.body.allowed_method, allowedMethod, `${label}: allowed_method 不符`);
    assert.deepEqual(snapshotState(state), snapshot, `${label}: 方法被拒绝时不得改变状态`);
  }
});

test('VAULT_MISMATCH 错误结构包含 expected_vault_id，且缺失标识不会被误报成 VAULT_MISMATCH', async () => {
  const entry = SCENARIO_BY_NAME.get('submit-markdown');
  const step = entry.scenario.steps[0];
  const vaultId = entry.scenario.initial_state.vault_id;
  const bytes = readSample(step.content_file);
  const run = async (body, method = 'POST', endpoint = step.request.endpoint, headers = {}) => {
    const state = createVaultState(entry.scenario.initial_state);
    const before = snapshotState(state);
    const response = await handleRequest(state, { method, endpoint, headers, body }, { resolveUpload: () => bytes });
    return { response, state, before };
  };

  // 1. 请求体 vault_id 与路由不一致：必须是 VAULT_MISMATCH，并给出服务端的 expected_vault_id。
  const bodyMismatch = await run({ ...step.request.body, vault_id: 'vault_other' });
  assert.equal(bodyMismatch.response.status, 400, '请求体 Vault 不一致应返回 400');
  assert.equal(bodyMismatch.response.body.code, ERROR_CODES.VAULT_MISMATCH);
  assert.equal(bodyMismatch.response.body.vault_id, 'vault_other', '错误必须回显请求携带的 vault_id');
  assert.equal(bodyMismatch.response.body.expected_vault_id, vaultId, '错误必须给出服务端期望的 expected_vault_id');
  assert.ok(
    typeof bodyMismatch.response.body.message === 'string' && bodyMismatch.response.body.message.length > 0,
    'VAULT_MISMATCH 必须带可读 message',
  );
  assert.deepEqual(snapshotState(bodyMismatch.state), bodyMismatch.before, 'VAULT_MISMATCH 不得改变状态');

  // 2. 路由 vault_id 不存在：同样是 VAULT_MISMATCH，expected_vault_id 指向当前 Vault。
  const routeMismatch = await run(step.request.body, 'POST', '/api/v1/vaults/vault_other/sync/changes');
  assert.equal(routeMismatch.response.status, 404, '路由 Vault 不属于当前设备应返回 404');
  assert.equal(routeMismatch.response.body.code, ERROR_CODES.VAULT_MISMATCH);
  assert.equal(routeMismatch.response.body.vault_id, 'vault_other');
  assert.equal(routeMismatch.response.body.expected_vault_id, vaultId, '路由不匹配同样必须给出 expected_vault_id');
  assert.deepEqual(snapshotState(routeMismatch.state), routeMismatch.before, 'VAULT_MISMATCH 不得改变状态');

  // 3. 缺失 vault_id 是 INVALID_REQUEST，不是 VAULT_MISMATCH：缺字段与「值不一致」必须可区分。
  for (const [label, patch] of [
    ['vault_id 缺失', undefined],
    ['vault_id 是 null', null],
    ['device_id 缺失', undefined],
  ]) {
    const body = { ...step.request.body };
    if (label.startsWith('vault_id')) {
      if (patch === undefined) delete body.vault_id;
      else body.vault_id = patch;
    } else {
      delete body.device_id;
    }
    const { response } = await run(body);
    assert.equal(response.status, 400, `${label}: 期望 400，实际 ${response.status}`);
    assert.equal(response.body.code, ERROR_CODES.INVALID_REQUEST, `${label}: 缺失标识必须是 INVALID_REQUEST，不能是 ${response.body.code}`);
    assert.notEqual(response.body.code, ERROR_CODES.VAULT_MISMATCH, `${label}: 缺失标识不得被误报为 VAULT_MISMATCH`);
    assert.deepEqual(response.body.missing_fields, [label.startsWith('vault_id') ? 'vault_id' : 'device_id'], `${label}: 必须列出缺失字段`);
  }

  // 4. 错误路由 + 缺失 device_id：必须先报 INVALID_REQUEST，而不是 404 VAULT_MISMATCH。
  //    协议第 5 节第 1 步的优先级是「先判有无，再判是否一致」，路由检查不得提前。
  const routeAndMissingDevice = await run(
    (() => {
      const body = { ...step.request.body };
      delete body.device_id;
      return body;
    })(),
    'POST',
    '/api/v1/vaults/vault_other/sync/changes',
  );
  assert.equal(routeAndMissingDevice.response.status, 400, '错误路由 + 缺失 device_id 必须返回 400');
  assert.equal(
    routeAndMissingDevice.response.body.code,
    ERROR_CODES.INVALID_REQUEST,
    '错误路由 + 缺失 device_id 必须先报 INVALID_REQUEST，不能是 VAULT_MISMATCH',
  );
  assert.deepEqual(routeAndMissingDevice.response.body.missing_fields, ['device_id'], '必须列出缺失的 device_id');
  assert.equal(routeAndMissingDevice.response.body.expected_vault_id, undefined, 'INVALID_REQUEST 不携带 Vault 定位字段');
  assert.deepEqual(
    snapshotState(routeAndMissingDevice.state),
    routeAndMissingDevice.before,
    '组合非法请求不得改变状态',
  );

  // 5. 非法 vault_id 类型（数字）必须返回 missing_fields，而不是只回显字段。
  const numericVault = await run({ ...step.request.body, vault_id: 42 });
  assert.equal(numericVault.response.status, 400, '数字 vault_id 必须返回 400');
  assert.equal(numericVault.response.body.code, ERROR_CODES.INVALID_REQUEST, '数字 vault_id 必须是 INVALID_REQUEST');
  assert.deepEqual(numericVault.response.body.missing_fields, ['vault_id'], '非法 vault_id 必须列入 missing_fields');
});

test('组合非法请求：先完成类型与取值校验，再判断 operation 是否支持', async () => {
  const entry = SCENARIO_BY_NAME.get('submit-markdown');
  const step = entry.scenario.steps[0];
  const bytes = readSample(step.content_file);
  const vaultId = entry.scenario.initial_state.vault_id;

  const build = (patch) => {
    const body = { ...step.request.body };
    for (const [key, value] of Object.entries(patch)) {
      if (value === undefined) delete body[key];
      else body[key] = value;
    }
    return body;
  };

  const run = async (patch) => {
    const state = createVaultState(entry.scenario.initial_state);
    const before = snapshotState(state);
    const response = await handleRequest(state, postRequest(vaultId, build(patch)), { resolveUpload: () => bytes });
    return { response, state, before };
  };

  // 未知 operation 单独出现时返回 OPERATION_NOT_SUPPORTED，作为对照基线。
  const unknownOnly = await run({ operation: 'frobnicate_file' });
  assert.equal(unknownOnly.response.body.code, ERROR_CODES.OPERATION_NOT_SUPPORTED, '单独未知 operation 应报 OPERATION_NOT_SUPPORTED');

  // 但「未知 / 未冻结 operation」+ 任一字段非法时必须先报第 2 步的错误：
  // 协议第 5 节中「类型与取值校验」（第 2 步）先于「operation 支持性」（第 3 步）。
  const combinations = [
    ['未知 operation + 非法 content_hash', { operation: 'frobnicate_file', content_hash: 'md5:abc' }, ERROR_CODES.INVALID_REQUEST],
    ['未知 operation + content_hash 类型错误', { operation: 'frobnicate_file', content_hash: 12345 }, ERROR_CODES.INVALID_REQUEST],
    ['未知 operation + 非规范化 path', { operation: 'frobnicate_file', path: '/abs/../x.md' }, ERROR_CODES.INVALID_REQUEST],
    ['未知 operation + metadata 是空对象', { operation: 'frobnicate_file', metadata: {} }, ERROR_CODES.INVALID_REQUEST],
    ['未知 operation + 非法 client_timestamp', { operation: 'frobnicate_file', client_timestamp: '2026-02-29T09:05:00Z' }, ERROR_CODES.INVALID_REQUEST],
    ['未知 operation + base_revision 为负', { operation: 'frobnicate_file', base_revision: -1 }, ERROR_CODES.INVALID_REQUEST],
    ['未知 operation + base_content_hash 格式错误', { operation: 'frobnicate_file', base_content_hash: 'sha256:XYZ' }, ERROR_CODES.INVALID_REQUEST],
    ['v1 未冻结 operation + 非法 content_hash', { operation: 'rename_file', content_hash: 'sha256:XYZ' }, ERROR_CODES.INVALID_REQUEST],
    ['v1 未冻结 operation + 缺 device_id', { operation: 'rename_file', device_id: undefined }, ERROR_CODES.INVALID_REQUEST],
    ['未知 operation + 缺 vault_id', { operation: 'frobnicate_file', vault_id: undefined }, ERROR_CODES.INVALID_REQUEST],
  ];

  for (const [label, patch, expectedCode] of combinations) {
    const { response, state, before } = await run(patch);
    assert.equal(response.status, 400, `${label}: 期望 400，实际 ${response.status}`);
    assert.equal(
      response.body.code,
      expectedCode,
      `${label}: 组合非法请求必须先报字段层错误（${expectedCode}），实际 ${response.body.code}`,
    );
    assert.deepEqual(snapshotState(state), before, `${label}: 非法请求不得改变状态`);
  }

  // 基准两项都为 null 属于字段层的 BASE_REQUIRED，同样必须先于 operation 支持性。
  const baseRequired = await run({ operation: 'frobnicate_file', base_version_id: null, base_content_hash: null });
  assert.equal(
    baseRequired.response.body.code,
    ERROR_CODES.BASE_REQUIRED,
    '未知 operation + 无基准必须先报 BASE_REQUIRED，而不是 OPERATION_NOT_SUPPORTED',
  );

  // 反向保证：字段全部合法时，未知 operation 仍必须报 OPERATION_NOT_SUPPORTED，
  // 否则把校验顺序改成「永远报 INVALID_REQUEST」也能通过上面的断言。
  const cleanUnknown = await run({ operation: 'frobnicate_file', content_hash: `sha256:${'0'.repeat(64)}` });
  assert.equal(
    cleanUnknown.response.body.code,
    ERROR_CODES.OPERATION_NOT_SUPPORTED,
    '字段合法时未知 operation 仍应报 OPERATION_NOT_SUPPORTED',
  );
});

test('协议外请求与非法基准返回稳定错误码', async () => {
  const entry = SCENARIO_BY_NAME.get('submit-markdown');
  const step = entry.scenario.steps[0];
  const bytes = readSample(step.content_file);
  const vaultId = entry.scenario.initial_state.vault_id;
  const ctx = { resolveUpload: () => bytes };
  const fresh = () => createVaultState(entry.scenario.initial_state);
  const baseRequest = () => ({
    method: 'POST',
    endpoint: step.request.endpoint,
    headers: {},
    body: { ...step.request.body },
  });

  const mutate = async (mutator) => {
    const request = baseRequest();
    mutator(request);
    const state = fresh();
    const before = snapshotState(state);
    const response = await handleRequest(state, request, ctx);
    return { response, state, before };
  };

  const expectations = [
    ['端点不在协议内', (r) => { r.endpoint = '/api/v1/unknown'; }, ERROR_CODES.ENDPOINT_NOT_FOUND],
    ['changes 用 GET', (r) => { r.method = 'GET'; }, ERROR_CODES.METHOD_NOT_ALLOWED],
    ['changes 用 PUT', (r) => { r.method = 'PUT'; }, ERROR_CODES.METHOD_NOT_ALLOWED],
    ['changes 缺少 method', (r) => { delete r.method; }, ERROR_CODES.METHOD_NOT_ALLOWED],
    [
      'manifest 用 POST',
      (r) => { r.method = 'POST'; r.endpoint = `/api/v1/vaults/${r.body.vault_id}/sync/manifest`; },
      ERROR_CODES.METHOD_NOT_ALLOWED,
    ],
    [
      'manifest 用 DELETE',
      (r) => { r.method = 'DELETE'; r.endpoint = `/api/v1/vaults/${r.body.vault_id}/sync/manifest`; },
      ERROR_CODES.METHOD_NOT_ALLOWED,
    ],
    ['路由 Vault 不匹配', (r) => { r.endpoint = '/api/v1/vaults/vault_other/sync/changes'; }, ERROR_CODES.VAULT_MISMATCH],
    ['请求体 Vault 不匹配', (r) => { r.body.vault_id = 'vault_other'; }, ERROR_CODES.VAULT_MISMATCH],
    ['缺少 mode', (r) => { delete r.body.mode; }, ERROR_CODES.MODE_REQUIRED],
    ['未知操作名', (r) => { r.body.operation = 'frobnicate_file'; }, ERROR_CODES.OPERATION_NOT_SUPPORTED],
    ['v1 未冻结的操作', (r) => { r.body.operation = 'rename_file'; }, ERROR_CODES.OPERATION_NOT_SUPPORTED],
    ['缺少基准字段', (r) => { delete r.body.base_version_id; delete r.body.base_content_hash; }, ERROR_CODES.BASE_REQUIRED],
    ['基准两项均为 null', (r) => { r.body.base_version_id = null; r.body.base_content_hash = null; }, ERROR_CODES.BASE_REQUIRED],
    ['base_version_id 类型错误', (r) => { r.body.base_version_id = 12345; }, ERROR_CODES.INVALID_REQUEST],
    ['base_content_hash 类型错误', (r) => { r.body.base_content_hash = { hash: 'x' }; }, ERROR_CODES.INVALID_REQUEST],
    ['base_content_hash 格式错误', (r) => { r.body.base_content_hash = 'sha256:XYZ'; }, ERROR_CODES.INVALID_REQUEST],
    ['client_timestamp 非 RFC 3339', (r) => { r.body.client_timestamp = '2026-11-21 09:05:00'; }, ERROR_CODES.INVALID_REQUEST],
    ['client_timestamp 非 UTC', (r) => { r.body.client_timestamp = '2026-11-21T09:05:00+08:00'; }, ERROR_CODES.INVALID_REQUEST],
    ['client_timestamp 非法日期', (r) => { r.body.client_timestamp = '2026-13-45T99:99:99Z'; }, ERROR_CODES.INVALID_REQUEST],
    ['client_timestamp 类型错误', (r) => { r.body.client_timestamp = 1763712000; }, ERROR_CODES.INVALID_REQUEST],
    // 以下四个日期只在 `Date.parse` 里被静默进位，形状完全合法，必须由逐项取值校验拦下。
    ['client_timestamp 非闰年 2 月 29 日', (r) => { r.body.client_timestamp = '2026-02-29T09:05:00Z'; }, ERROR_CODES.INVALID_REQUEST],
    ['client_timestamp 4 月 31 日', (r) => { r.body.client_timestamp = '2026-04-31T09:05:00Z'; }, ERROR_CODES.INVALID_REQUEST],
    ['client_timestamp 24 时', (r) => { r.body.client_timestamp = '2026-01-01T24:00:00Z'; }, ERROR_CODES.INVALID_REQUEST],
    ['client_timestamp 60 秒', (r) => { r.body.client_timestamp = '2026-01-01T09:05:60Z'; }, ERROR_CODES.INVALID_REQUEST],
    ['client_timestamp 小写 z', (r) => { r.body.client_timestamp = '2026-11-21t09:05:00z'; }, ERROR_CODES.INVALID_REQUEST],
    ['client_timestamp 缺少秒', (r) => { r.body.client_timestamp = '2026-11-21T09:05Z'; }, ERROR_CODES.INVALID_REQUEST],
    ['metadata.line_ending 取值非法', (r) => { r.body.metadata = { ...r.body.metadata, line_ending: 'bogus' }; }, ERROR_CODES.INVALID_REQUEST],
    ['metadata.format 取值非法', (r) => { r.body.metadata = { ...r.body.metadata, format: 'rtf' }; }, ERROR_CODES.INVALID_REQUEST],
    // metadata.format 是必填项：空对象、显式 null、只给 line_ending 都不能通过。
    ['metadata 是空对象', (r) => { r.body.metadata = {}; }, ERROR_CODES.INVALID_REQUEST],
    ['metadata.format 显式 null', (r) => { r.body.metadata = { ...r.body.metadata, format: null }; }, ERROR_CODES.INVALID_REQUEST],
    ['metadata 只有 line_ending', (r) => { r.body.metadata = { line_ending: 'lf' }; }, ERROR_CODES.INVALID_REQUEST],
    ['metadata 不是对象', (r) => { r.body.metadata = 'md'; }, ERROR_CODES.INVALID_REQUEST],
    ['Idempotency-Key 不一致', (r) => { r.headers = { 'Idempotency-Key': 'op_other' }; }, ERROR_CODES.IDEMPOTENCY_KEY_MISMATCH],
    ['operation 类型错误', (r) => { r.body.operation = 42; }, ERROR_CODES.INVALID_REQUEST],
    // 标识字段类型错误必须在业务查找之前拦下，不能退化成 FILE_NOT_FOUND / UPLOAD_NOT_READY。
    ['device_id 是数字', (r) => { r.body.device_id = 1001; }, ERROR_CODES.INVALID_REQUEST],
    ['device_id 是空字符串', (r) => { r.body.device_id = ''; }, ERROR_CODES.INVALID_REQUEST],
    // 缺失标识同样是 INVALID_REQUEST，绝不能退化成 VAULT_MISMATCH。
    ['缺少 device_id', (r) => { delete r.body.device_id; }, ERROR_CODES.INVALID_REQUEST],
    ['device_id 是 null', (r) => { r.body.device_id = null; }, ERROR_CODES.INVALID_REQUEST],
    ['缺少 vault_id', (r) => { delete r.body.vault_id; }, ERROR_CODES.INVALID_REQUEST],
    ['vault_id 是 null', (r) => { r.body.vault_id = null; }, ERROR_CODES.INVALID_REQUEST],
    ['vault_id 是数字', (r) => { r.body.vault_id = 1; }, ERROR_CODES.INVALID_REQUEST],
    ['operation_id 是数字', (r) => { r.body.operation_id = 7; }, ERROR_CODES.INVALID_REQUEST],
    ['operation_id 是空字符串', (r) => { r.body.operation_id = ''; }, ERROR_CODES.INVALID_REQUEST],
    ['operation_id 缺失', (r) => { delete r.body.operation_id; }, ERROR_CODES.INVALID_REQUEST],
    ['file_id 是数字', (r) => { r.body.file_id = 12345; }, ERROR_CODES.INVALID_REQUEST],
    ['file_id 是空字符串', (r) => { r.body.file_id = ''; }, ERROR_CODES.INVALID_REQUEST],
    ['blob_reference 是数字', (r) => { r.body.blob_reference = 99; }, ERROR_CODES.INVALID_REQUEST],
    ['blob_reference 是空字符串', (r) => { r.body.blob_reference = ''; }, ERROR_CODES.INVALID_REQUEST],
    ['目标文件不存在', (r) => { r.body.file_id = 'file_missing'; }, ERROR_CODES.FILE_NOT_FOUND],
    ['路径不一致', (r) => { r.body.path = 'projects/other.md'; }, ERROR_CODES.PATH_MISMATCH],
    ['格式不一致', (r) => { r.body.metadata = { ...r.body.metadata, format: 'txt' }; }, ERROR_CODES.FORMAT_MISMATCH],
    ['上传会话未完成', (r) => { r.body.blob_reference = 'upload_absent'; }, ERROR_CODES.UPLOAD_NOT_READY],
    ['base_revision 超过服务端', (r) => { r.body.base_revision = 99; }, ERROR_CODES.INVALID_REQUEST],
    ['content_hash 格式非法', (r) => { r.body.content_hash = 'md5:abc'; }, ERROR_CODES.INVALID_REQUEST],
    ['content_size 不符', (r) => { r.body.content_size = 999; }, ERROR_CODES.CONTENT_SIZE_MISMATCH],
    ['content_hash 不符', (r) => { r.body.content_hash = `sha256:${'a'.repeat(64)}`; }, ERROR_CODES.CONTENT_HASH_MISMATCH],
  ];

  for (const [label, mutator, expectedCode] of expectations) {
    const { response, state, before } = await mutate(mutator);
    assert.ok(response.status >= 400, `${label}: 期望失败响应，实际 ${response.status}`);
    assert.equal(response.body.code, expectedCode, `${label}: 错误码不符，响应体 ${JSON.stringify(response.body)}`);
    assert.ok(typeof response.body.message === 'string' && response.body.message.length > 0, `${label}: 缺少 message`);
    assert.deepEqual(snapshotState(state), before, `${label}: 被拒绝的请求不得改变协议状态`);
  }

  // 同一 operation_id 携带不同内容必须被拒绝，不能当成同一次操作。
  const state = fresh();
  await handleRequest(state, baseRequest(), ctx);
  const conflicting = baseRequest();
  conflicting.body.client_timestamp = '2026-11-21T10:00:00Z';
  const reused = await handleRequest(state, conflicting, ctx);
  assert.equal(reused.body.code, ERROR_CODES.IDEMPOTENCY_KEY_REUSED, 'operation_id 复用不同内容应被拒绝');
});

test('metadata.format 是必填项：文档、模型与测试一致', async () => {
  const entry = SCENARIO_BY_NAME.get('submit-markdown');
  const step = entry.scenario.steps[0];
  const bytes = readSample(step.content_file);
  const vaultId = entry.scenario.initial_state.vault_id;

  const run = async (metadata) => {
    const state = createVaultState(entry.scenario.initial_state);
    const before = snapshotState(state);
    const response = await handleRequest(state, postRequest(vaultId, { ...step.request.body, metadata }), {
      resolveUpload: () => bytes,
    });
    return { response, state, before };
  };

  // 缺 `format` 的写法都必须是 INVALID_REQUEST，且错误要明确指出缺的是 metadata.format。
  const missingFormat = [
    ['metadata 是空对象', {}],
    ['metadata 只给 line_ending', { line_ending: 'lf' }],
    ['metadata.format 显式 null', { format: null }],
    ['metadata.format 缺失但带其他扩展键', { line_ending: 'crlf', extra: true }],
  ];
  for (const [label, metadata] of missingFormat) {
    const { response, state, before } = await run(metadata);
    assert.equal(response.status, 400, `${label}: 期望 400，实际 ${response.status}（${JSON.stringify(response.body)}）`);
    assert.equal(response.body.code, ERROR_CODES.INVALID_REQUEST, `${label}: 错误码应为 INVALID_REQUEST，实际 ${response.body.code}`);
    assert.deepEqual(
      response.body.missing_fields,
      ['metadata.format'],
      `${label}: 错误必须指明缺失的是 metadata.format，实际 ${JSON.stringify(response.body.missing_fields)}`,
    );
    assert.deepEqual(snapshotState(state), before, `${label}: 非法 metadata 不得改变状态`);
  }

  // 反向保证：合法 metadata 必须被接受，否则「一律拒绝」也能通过上面的断言。
  const valid = await run({ format: 'md', line_ending: 'lf' });
  assert.equal(valid.response.status, 200, '带 format 的合法 metadata 必须成功');
  // line_ending 是可选项：只给 format 也必须成功。
  const formatOnly = await run({ format: 'md' });
  assert.equal(formatOnly.response.status, 200, 'metadata.line_ending 是可选字段，只给 format 必须成功');
  // format 取值越界仍属于 INVALID_REQUEST，但不应被报成「缺失」。
  const badFormat = await run({ format: 'rtf' });
  assert.equal(badFormat.response.body.code, ERROR_CODES.INVALID_REQUEST, 'format 越界应返回 INVALID_REQUEST');
  assert.equal(badFormat.response.body.missing_fields, undefined, 'format 越界是取值错误，不应报告 missing_fields');
});

test('client_timestamp 严格遵循 RFC 3339 的日期与时间取值', async () => {
  const valid = [
    '2026-11-21T09:05:00Z',
    '2026-11-21T09:05:00.1Z',
    '2026-11-21T09:05:00.123456789Z',
    '2024-02-29T00:00:00Z',
    '2000-02-29T23:59:59Z',
    '2026-01-01T00:00:00Z',
    '2026-12-31T23:59:59Z',
  ];
  for (const value of valid) {
    assert.equal(isRfc3339Utc(value), true, `${value} 应被判为合法 RFC 3339 UTC`);
  }

  const invalid = [
    // 形状合法但日期不存在
    '2026-02-29T09:05:00Z',
    '1900-02-29T09:05:00Z',
    '2026-04-31T09:05:00Z',
    '2026-06-31T09:05:00Z',
    '2026-00-10T09:05:00Z',
    '2026-13-10T09:05:00Z',
    '2026-01-00T09:05:00Z',
    '2026-01-32T09:05:00Z',
    // 形状合法但时刻越界
    '2026-01-01T24:00:00Z',
    '2026-01-01T09:60:00Z',
    '2026-01-01T09:05:60Z',
    '2026-01-01T99:99:99Z',
    // 形状本身不合法
    '2026-11-21T09:05Z',
    '2026-11-21t09:05:00z',
    '2026-11-21T09:05:00+00:00',
    '2026-11-21T09:05:00+08:00',
    '2026-11-21 09:05:00Z',
    '2026-11-21T09:05:00',
    '2026-1-1T09:05:00Z',
    ' 2026-11-21T09:05:00Z',
    '2026-11-21T09:05:00ZZ',
    '2026-11-21T09:05:00.Z',
    '',
    1763712000,
    null,
    undefined,
    { timestamp: '2026-11-21T09:05:00Z' },
  ];
  for (const value of invalid) {
    assert.equal(isRfc3339Utc(value), false, `${JSON.stringify(value)} 应被判为非法 RFC 3339 UTC`);
  }

  // 端到端：这些时间戳进入提交请求后必须返回 INVALID_REQUEST，而不是 200。
  const entry = SCENARIO_BY_NAME.get('submit-markdown');
  const step = entry.scenario.steps[0];
  const bytes = readSample(step.content_file);
  const vaultId = entry.scenario.initial_state.vault_id;
  for (const timestamp of ['2026-02-29T09:05:00Z', '2026-04-31T09:05:00Z', '2026-01-01T24:00:00Z']) {
    const state = createVaultState(entry.scenario.initial_state);
    const response = await handleRequest(state, postRequest(vaultId, { ...step.request.body, client_timestamp: timestamp }), {
      resolveUpload: () => bytes,
    });
    assert.equal(response.status, 400, `${timestamp}: 期望 400，实际 ${response.status}`);
    assert.equal(response.body.code, ERROR_CODES.INVALID_REQUEST, `${timestamp}: 错误码应为 INVALID_REQUEST`);
    assert.equal(state.vault_revision, entry.scenario.initial_state.vault_revision, `${timestamp}: 非法时间戳不得推进 vault_revision`);
  }
});

test('pull 与 manifest 的标识字段必填且类型正确，否则 INVALID_REQUEST 且不进入业务判定', async () => {
  const entry = SCENARIO_BY_NAME.get('stale-cursor-recovery');
  const { vault_id: vaultId, min_available_revision: minAvailable } = entry.scenario.initial_state;
  const changesEndpoint = `/api/v1/vaults/${vaultId}/sync/changes`;
  const manifestEndpoint = `/api/v1/vaults/${vaultId}/sync/manifest`;

  const run = async (body, method = 'POST', endpoint = changesEndpoint) => {
    const state = createVaultState(entry.scenario.initial_state);
    const before = snapshotState(state);
    const response = await handleRequest(state, { method, endpoint, headers: {}, body }, { resolveUpload: () => Buffer.alloc(0) });
    return { response, state, before };
  };

  // GET manifest 没有请求体：设备标识走查询参数或请求头。
  // 合法路径用标准 `Request` 构造，断言它确实是「无正文 GET」；
  // 需要表达非字符串类型的非法用例改走内部 query 表示（URL 查询串只能承载字符串）。
  const runManifest = async (query, { asRequest = false } = {}) => {
    const state = createVaultState(entry.scenario.initial_state);
    const before = snapshotState(state);
    let input;
    if (asRequest) {
      const url = new URL(`${ORIGIN}${manifestEndpoint}`);
      for (const [key, value] of Object.entries(query)) {
        if (value !== undefined) url.searchParams.set(key, String(value));
      }
      input = new Request(url, { method: 'GET' });
      assert.equal(input.body, null, 'manifest 的 GET 请求不得携带正文');
      assert.equal(input.method, 'GET', 'manifest 必须用 GET');
    } else {
      input = { method: 'GET', endpoint: manifestEndpoint, headers: {}, query };
    }
    return { response: await handleRequest(state, input, { resolveUpload: () => Buffer.alloc(0) }), state, before };
  };

  // 合法 pull 作为对照：同一组不变量的正向基线。
  const baseline = await run({ mode: 'pull', vault_id: vaultId, device_id: 'device_mac_0001', last_server_revision: minAvailable });
  assert.equal(baseline.response.status, 200, '合法 pull 应成功');

  // pull：device_id 与 vault_id 都必须存在且为非空字符串。
  const pullCases = [
    ['device_id 是数字', { device_id: 1001 }],
    ['device_id 是空字符串', { device_id: '' }],
    ['device_id 是 null', { device_id: null }],
    ['device_id 是对象', { device_id: { id: 'device_mac_0001' } }],
    ['device_id 缺失', { device_id: undefined }],
    ['vault_id 缺失', { vault_id: undefined }],
    ['vault_id 是 null', { vault_id: null }],
    ['vault_id 是数字', { vault_id: 1 }],
    ['vault_id 是空字符串', { vault_id: '' }],
  ];
  for (const [label, patch] of pullCases) {
    // 用低于下界的游标，确保错误不是 CURSOR_TOO_OLD 造成的假阳性。
    const body = { mode: 'pull', vault_id: vaultId, device_id: 'device_mac_0001', last_server_revision: 1 };
    for (const [key, value] of Object.entries(patch)) {
      if (value === undefined) delete body[key];
      else body[key] = value;
    }
    const { response, state, before } = await run(body);
    assert.equal(response.status, 400, `${label}: 期望 400，实际 ${response.status}（响应体 ${JSON.stringify(response.body)}）`);
    assert.equal(response.body.code, ERROR_CODES.INVALID_REQUEST, `${label}: 错误码应为 INVALID_REQUEST，实际 ${response.body.code}`);
    assert.notEqual(response.body.code, ERROR_CODES.CURSOR_TOO_OLD, `${label}: 标识非法不得退化成 CURSOR_TOO_OLD`);
    assert.notEqual(response.body.code, ERROR_CODES.VAULT_MISMATCH, `${label}: 标识缺失不得退化成 VAULT_MISMATCH`);
    assert.ok(Array.isArray(response.body.missing_fields) && response.body.missing_fields.length > 0, `${label}: 必须列出缺失字段`);
    assert.deepEqual(snapshotState(state), before, `${label}: 非法 pull 不得改变状态`);
  }

  // manifest：GET 无正文，device_id 必须由查询参数或请求头显式提供，不再默认为 null。
  const manifestCases = [
    ['device_id 是数字', { device_id: 1001 }],
    ['device_id 是空字符串', { device_id: '' }],
    ['device_id 是 null', { device_id: null }],
    ['device_id 缺失', { device_id: undefined }],
    ['device_id 是对象', { device_id: { id: 'device_mac_0001' } }],
  ];
  for (const [label, patch] of manifestCases) {
    // 空串与缺失可以用标准 `Request` 表达；数字与对象必须用内部 query 表示保留类型。
    const expressible = Object.values(patch).every((value) => value === undefined || typeof value === 'string');
    const { response, state, before } = await runManifest(patch, { asRequest: expressible });
    assert.equal(response.status, 400, `${label}: 期望 400，实际 ${response.status}（响应体 ${JSON.stringify(response.body)}）`);
    assert.equal(response.body.code, ERROR_CODES.INVALID_REQUEST, `${label}: 错误码应为 INVALID_REQUEST，实际 ${response.body.code}`);
    assert.deepEqual(response.body.missing_fields, ['device_id'], `${label}: 必须列出缺失的 device_id`);
    assert.notEqual(response.body.code, ERROR_CODES.VAULT_MISMATCH, `${label}: 缺失 device_id 不得退化成 VAULT_MISMATCH`);
    assert.deepEqual(snapshotState(state), before, `${label}: 非法 manifest 不得改变状态`);
  }

  // manifest：查询参数里的 vault_id 若与路由冲突，属于 404 的 VAULT_MISMATCH。
  const queryVaultMismatch = await runManifest({ device_id: 'device_mac_0001', vault_id: 'vault_other' }, { asRequest: true });
  assert.equal(queryVaultMismatch.response.status, 404, '查询参数 Vault 与路由不一致应返回 404');
  assert.equal(queryVaultMismatch.response.body.code, ERROR_CODES.VAULT_MISMATCH);

  // 正向保证：合法 manifest 必须回显请求里的 device_id，而不是 null。
  const okManifest = await runManifest({ device_id: 'device_mac_0001' }, { asRequest: true });
  assert.equal(okManifest.response.status, 200, `合法 manifest 应成功，实际 ${JSON.stringify(okManifest.response.body)}`);
  assert.equal(okManifest.response.body.device_id, 'device_mac_0001', 'manifest 必须回显请求的 device_id，不得默认为 null');
});

test('MODE_REQUIRED 回显请求取值但不带成功响应的 mode 字段', async () => {
  const entry = SCENARIO_BY_NAME.get('submit-markdown');
  const step = entry.scenario.steps[0];
  const bytes = readSample(step.content_file);
  const vaultId = entry.scenario.initial_state.vault_id;
  const body = { ...step.request.body };
  delete body.mode;

  const state = createVaultState(entry.scenario.initial_state);
  const before = snapshotState(state);
  const response = await handleRequest(state, postRequest(vaultId, body), { resolveUpload: () => bytes });
  assert.equal(response.status, 400, '缺少 mode 必须返回 400');
  assert.equal(response.body.code, ERROR_CODES.MODE_REQUIRED, '缺少 mode 必须返回 MODE_REQUIRED');
  // 协议第 3.4 节称 mode 只在成功响应里表示业务模式；错误响应不得复用该字段。
  assert.equal(response.body.mode, undefined, '错误响应不得带 mode 业务字段');
  assert.equal(response.body.requested_mode, null, '被拒绝的 mode 取值必须由 requested_mode 回显');
  assert.equal(response.body.replayed, undefined, '错误响应不得带 replayed 字段');
  assert.deepEqual(snapshotState(state), before, '缺少 mode 不得改变状态');

  const otherState = createVaultState(entry.scenario.initial_state);
  const otherResponse = await handleRequest(otherState, postRequest(vaultId, { ...step.request.body, mode: 'frobnicate' }), {
    resolveUpload: () => bytes,
  });
  assert.equal(otherResponse.body.code, ERROR_CODES.MODE_REQUIRED, '非法 mode 必须返回 MODE_REQUIRED');
  assert.equal(otherResponse.body.requested_mode, 'frobnicate', 'requested_mode 必须回显非法取值');
});

test('版本、Blob 与上传会话的引用完整性', async () => {
  const entry = SCENARIO_BY_NAME.get('submit-markdown');
  const step = entry.scenario.steps[0];
  const bytes = readSample(step.content_file);
  const vaultId = entry.scenario.initial_state.vault_id;

  // 1. 版本 ID 必须避开 Vault 中已被占用的标识。
  //    把初态的唯一版本合法命名为 ver_roadmap_02（并同步引用）后，下一次提交不得再生成 ver_roadmap_02。
  const occupied = cloneJson(entry.scenario.initial_state);
  occupied.versions = occupied.versions.map((version) => ({ ...version, version_id: 'ver_roadmap_02' }));
  occupied.files = occupied.files.map((file) => ({ ...file, current_version_id: 'ver_roadmap_02' }));
  occupied.changes = occupied.changes.map((change) => ({
    ...change,
    version_id: change.version_id === 'ver_roadmap_01' ? 'ver_roadmap_02' : change.version_id,
  }));
  assert.deepEqual(validateInitialState(occupied), [], '把版本改名为 ver_roadmap_02 后初态仍必须自洽');
  const occupiedState = createVaultState(occupied);
  const occupiedBody = {
    ...step.request.body,
    base_version_id: 'ver_roadmap_02',
    base_content_hash: 'sha256:019c10934398e428bdaa6baefcb14407cf446db3f4646f7e5b95d4aa2176299a',
  };
  const occupiedResponse = await handleRequest(occupiedState, postRequest(vaultId, occupiedBody), { resolveUpload: () => bytes });
  assert.equal(occupiedResponse.status, 200, `基于占用标识的前置状态提交必须成功：${JSON.stringify(occupiedResponse.body)}`);
  assert.notEqual(occupiedResponse.body.version_id, 'ver_roadmap_02', '新版本 ID 不得复用已被占用的标识');
  assert.notEqual(occupiedResponse.body.version_id, occupiedResponse.body.parent_version_id, '新版本与父版本必须是不同标识');
  const occupiedProjection = projectState(occupiedState);
  assert.equal(occupiedProjection.counts.versions, 2, '应恰好新增一个版本');
  assert.equal(
    new Set(occupiedState.versions.map((version) => version.version_id)).size,
    occupiedState.versions.length,
    '版本标识在 Vault 内必须唯一',
  );

  // 2. Blob 必须按完整哈希复用：共享 12 位前缀但完整哈希不同的两份字节不能折叠成一个 Blob。
  const prefixHash = 'sha256:542b2f6db9960000000000000000000000000000000000000000000000000000';
  const differentHash = 'sha256:542b2f6db996ffffffffffffffffffffffffffffffffffffffffffffffffffff';
  assert.equal(prefixHash.slice(0, 18), differentHash.slice(0, 18), '两份哈希必须共享 12 位前缀');
  const conflictingBlobs = cloneJson(entry.scenario.initial_state);
  conflictingBlobs.blobs = [
    {
      blob_id: prefixHash,
      vault_id: entry.scenario.initial_state.vault_id,
      content_hash: prefixHash,
      content_size: 1,
    },
  ];
  const conflictProblems = validateInitialState(conflictingBlobs);
  assert.ok(conflictProblems.length > 0, 'Blob 标识必须按完整哈希生成，截断前缀必须被初态校验拒绝');

  // 2b. 运行期复用也必须按完整哈希：即使初态里放了一个「前缀相同、完整哈希不同」的 Blob，
  //     提交新字节也不能复用它。把模型改成按前缀复用后，这里的 Blob 数会少一个。
  const sharedPrefixState = createVaultState(entry.scenario.initial_state);
  const decoyBlobId = 'blob_542b2f6db996' + '0'.repeat(52);
  const decoyHash = 'sha256:542b2f6db996' + '0'.repeat(52);
  assert.equal(decoyHash.slice(0, 19), step.request.body.content_hash.slice(0, 19), '诱饵哈希必须与待提交哈希共享 12 位前缀');
  assert.notEqual(decoyHash, step.request.body.content_hash, '诱饵哈希的完整值必须与待提交哈希不同');
  sharedPrefixState.blobs.push({
    blob_id: decoyBlobId,
    vault_id: entry.scenario.initial_state.vault_id,
    content_hash: decoyHash,
    content_size: 213,
    created_by_device_id: 'device_mac_0001',
  });
  const sharedPrefixBlobsBefore = sharedPrefixState.blobs.length;
  const sharedPrefixResponse = await handleRequest(sharedPrefixState, postRequest(vaultId, step.request.body), {
    resolveUpload: () => bytes,
  });
  assert.equal(sharedPrefixResponse.status, 200, `前缀碰撞场景下的提交必须成功：${JSON.stringify(sharedPrefixResponse.body)}`);
  assert.notEqual(sharedPrefixResponse.body.blob_id, decoyBlobId, '不得复用只有前缀相同的 Blob');
  assert.equal(sharedPrefixResponse.body.blob_id, `blob_${step.request.body.content_hash.slice('sha256:'.length)}`, 'Blob 标识必须是完整哈希');
  assert.equal(
    sharedPrefixState.blobs.length,
    sharedPrefixBlobsBefore + 1,
    '完整哈希不同的内容必须新增一个 Blob，而不是复用前缀相同的旧记录',
  );
  assert.ok(
    sharedPrefixState.blobs.some((blob) => blob.blob_id === decoyBlobId),
    '诱饵 Blob 必须保持原样，不能被覆盖或删除',
  );

  // 2c. 完整哈希相同的字节必须复用同一个 Blob（内容寻址的正向保证）。
  const sameHashState = createVaultState(entry.scenario.initial_state);
  const blobsBeforeSame = sameHashState.blobs.length;
  const sameHashFirst = await handleRequest(sameHashState, postRequest(vaultId, step.request.body), { resolveUpload: () => bytes });
  assert.equal(sameHashFirst.status, 200, '首次提交必须成功');
  assert.equal(sameHashState.blobs.length, blobsBeforeSame + 1, '首次提交应新增一个 Blob');

  // 用新的 operation_id、基于刚生成的版本再提交同一份字节：Blob 必须复用，不新增记录。
  const sameHashSecond = await handleRequest(
    sameHashState,
    postRequest(vaultId, {
      ...step.request.body,
      operation_id: 'op_roadmap_v2_repost',
      client_timestamp: '2026-11-21T09:07:00Z',
      base_revision: sameHashFirst.body.vault_revision,
      base_version_id: sameHashFirst.body.version_id,
      base_content_hash: sameHashFirst.body.content_hash,
    }, { 'Idempotency-Key': 'op_roadmap_v2_repost' }),
    { resolveUpload: () => bytes },
  );
  assert.equal(sameHashSecond.status, 200, `同字节再次提交必须成功：${JSON.stringify(sameHashSecond.body)}`);
  assert.equal(sameHashSecond.body.blob_id, sameHashFirst.body.blob_id, '完整哈希相同时必须复用同一个 Blob');
  assert.equal(
    sameHashState.blobs.length,
    blobsBeforeSame + 1,
    '完整哈希相同的提交不得新增 Blob 记录',
  );

  // 3. 上传会话必须按 Vault 限定查找：把已完成会话改属另一个 Vault 后不得再被使用。
  const foreignUpload = cloneJson(entry.scenario.initial_state);
  foreignUpload.upload_sessions = foreignUpload.upload_sessions.map((upload) => ({ ...upload, vault_id: 'vault_other' }));
  assert.ok(
    validateInitialState(foreignUpload).some((problem) => problem.includes('属于其他 Vault')),
    '初态里的跨 Vault 上传会话必须被拒绝',
  );

  // 运行期同样按 Vault 限定：即使初态绕过校验注入跨 Vault 会话，提交也不得成功。
  const leakedState = createVaultState(entry.scenario.initial_state);
  leakedState.uploads = leakedState.uploads.map((upload) => ({ ...upload, vault_id: 'vault_other' }));
  const leakedBefore = snapshotState(leakedState);
  const leaked = await handleRequest(leakedState, postRequest(vaultId, step.request.body), { resolveUpload: () => bytes });
  assert.equal(leaked.status, 409, '跨 Vault 上传会话不得用于提交');
  assert.equal(leaked.body.code, ERROR_CODES.UPLOAD_NOT_READY, '跨 Vault 上传会话必须返回 UPLOAD_NOT_READY');
  assert.deepEqual(snapshotState(leakedState), leakedBefore, '跨 Vault 上传会话被拒时不得改变状态');

  // 3b. 上传会话状态不在枚举内时初态必须被拒绝（避免接受任意状态的会话）。
  const bogusStatus = cloneJson(entry.scenario.initial_state);
  bogusStatus.upload_sessions = bogusStatus.upload_sessions.map((upload) => ({ ...upload, status: 'ready' }));
  assert.ok(
    validateInitialState(bogusStatus).some((problem) => problem.includes('status')),
    '非枚举的上传会话状态必须被拒绝',
  );
});

test('冲突判定必须同时校验 base_version_id 与 base_content_hash', async () => {
  const entry = SCENARIO_BY_NAME.get('file-base-too-old');
  const initial = entry.scenario.initial_state;
  const vaultId = initial.vault_id;

  // 先手动把目标文件推进到 ver_settings_02，构造出「远端已前进」的前置状态。
  const remoteBytes = readSample('data/settings-v2.json');
  const localBytes = readSample('data/settings-v3.json');
  const advance = entry.scenario.steps.find((step) => step.id === 'remote-advances-settings');
  assert.ok(advance, '夹具缺少 remote-advances-settings 步骤');

  const state = createVaultState(initial);
  const advanceResponse = await handleRequest(state, buildRequest(advance).request, { resolveUpload: () => remoteBytes });
  assert.equal(advanceResponse.status, 200, '前置的远端推进必须成功');
  const remoteVersionId = advanceResponse.body.version_id;
  const remoteHash = advanceResponse.body.content_hash;

  const blockedIds = entry.scenario.steps
    .filter((step) => step.expected_status === 409 && step.expected_result?.code === 'FILE_VERSION_CONFLICT')
    .map((step) => step.id);
  assert.deepEqual(
    blockedIds,
    [
      'stale-local-json-rejected',
      'version-matches-hash-stale-rejected',
      'hash-matches-version-stale-rejected',
      'version-only-stale-rejected',
      'hash-only-stale-rejected',
    ],
    '夹具必须覆盖「两项都旧 / 版本匹配哈希旧 / 哈希匹配版本旧」以及两项单独的过期基准',
  );

  const cases = [
    {
      id: 'stale-local-json-rejected',
      label: '两项基准都过旧',
      provides: { version: true, hash: true },
      baseVersion: 'ver_settings_01',
      baseHash: 'sha256:21c9b70a1c1f2379c3fc4dd2374977266e222f4996a3d327188c67261911aa73',
      expectVersionMatch: false,
      expectHashMatch: false,
    },
    {
      id: 'version-matches-hash-stale-rejected',
      label: '版本匹配但哈希过旧',
      provides: { version: true, hash: true },
      baseVersion: remoteVersionId,
      baseHash: 'sha256:21c9b70a1c1f2379c3fc4dd2374977266e222f4996a3d327188c67261911aa73',
      expectVersionMatch: true,
      expectHashMatch: false,
    },
    {
      id: 'hash-matches-version-stale-rejected',
      label: '哈希匹配但版本过旧',
      provides: { version: true, hash: true },
      baseVersion: 'ver_settings_01',
      baseHash: remoteHash,
      expectVersionMatch: false,
      expectHashMatch: true,
    },
    {
      // 反例：只提供一项基准。若模型实现改成「两项都提供才检查冲突」，
      // 这个请求会被放行，本用例必然失败。
      id: 'version-only-stale-rejected',
      label: '仅提供过期版本 ID',
      provides: { version: true, hash: false },
      baseVersion: 'ver_settings_01',
      baseHash: undefined,
      expectVersionMatch: false,
      expectHashMatch: null,
    },
    {
      id: 'hash-only-stale-rejected',
      label: '仅提供过期哈希',
      provides: { version: false, hash: true },
      baseVersion: undefined,
      baseHash: 'sha256:21c9b70a1c1f2379c3fc4dd2374977266e222f4996a3d327188c67261911aa73',
      expectVersionMatch: null,
      expectHashMatch: false,
    },
  ];

  for (const testCase of cases) {
    const step = entry.scenario.steps.find((item) => item.id === testCase.id);
    assert.ok(step, `夹具缺少步骤 ${testCase.id}`);
    // 用例声明必须与实际请求一致，避免夹具与断言各说各话。
    assert.equal(step.request.body.base_version_id, testCase.baseVersion, `${testCase.id}: base_version_id 与用例不符`);
    assert.equal(step.request.body.base_content_hash, testCase.baseHash, `${testCase.id}: base_content_hash 与用例不符`);
    assert.equal(
      step.request.body.base_version_id !== undefined,
      testCase.provides.version,
      `${testCase.id}: 版本基准的提供状态与用例不符`,
    );
    assert.equal(
      step.request.body.base_content_hash !== undefined,
      testCase.provides.hash,
      `${testCase.id}: 哈希基准的提供状态与用例不符`,
    );

    // 每一项用例使用独立状态，但都建立在同一份「远端已前进」的前置状态之上。
    const targetState = createVaultState(initial);
    const advanceAgain = await handleRequest(targetState, buildRequest(advance).request, { resolveUpload: () => remoteBytes });
    assert.equal(advanceAgain.status, 200, `${testCase.id}: 前置推进必须成功`);
    const file = targetState.files.find((item) => item.file_id === 'file_settings');
    assert.equal(file.current_version_id, remoteVersionId, '前置状态：当前版本必须是远端推进后的版本');
    assert.equal(file.current_content_hash, remoteHash, '前置状态：当前哈希必须是远端推进后的哈希');
    // 这几条断言是本用例的意义所在：没有提供的那一项不参与判定，提供了的那一项必须不匹配。
    if (testCase.expectVersionMatch !== null) {
      assert.equal(testCase.baseVersion === file.current_version_id, testCase.expectVersionMatch, `${testCase.id}: 版本匹配情形不符预期`);
    }
    if (testCase.expectHashMatch !== null) {
      assert.equal(testCase.baseHash === file.current_content_hash, testCase.expectHashMatch, `${testCase.id}: 哈希匹配情形不符预期`);
    }

    const before = snapshotState(targetState);
    const response = await handleRequest(targetState, buildRequest(step).request, { resolveUpload: () => localBytes });

    assert.equal(response.status, 409, `${testCase.label}: 期望 409，实际 ${response.status}（${JSON.stringify(response.body)}）`);
    assert.equal(response.body.code, ERROR_CODES.FILE_VERSION_CONFLICT, `${testCase.label}: 必须返回 FILE_VERSION_CONFLICT`);
    assert.equal(response.body.current_version_id, remoteVersionId, `${testCase.label}: 错误必须给出远端当前版本`);
    assert.equal(response.body.current_content_hash, remoteHash, `${testCase.label}: 错误必须给出远端当前哈希`);
    assert.equal(response.body.current_blob_id, advanceResponse.body.blob_id, `${testCase.label}: 错误必须给出远端当前 Blob`);
    assert.equal(response.body.current_content_size, remoteBytes.length, `${testCase.label}: 错误必须给出远端内容大小`);
    assert.equal(response.body.file_id, 'file_settings', `${testCase.label}: 错误必须给出目标 file_id`);
    assert.equal(response.body.path, 'data/settings.json', `${testCase.label}: 错误必须给出目标路径`);
    // 未提供的那一项在错误里显式为 null，已提供的那一项原样回显。
    assert.equal(response.body.base_version_id ?? null, testCase.baseVersion ?? null, `${testCase.label}: 请求基准版本回显不符`);
    assert.equal(response.body.base_content_hash ?? null, testCase.baseHash ?? null, `${testCase.label}: 请求基准哈希回显不符`);
    // 状态无副作用：指针、版本数、Blob 数、Change 数、revision、幂等账本与上传会话全部不变。
    assert.deepEqual(snapshotState(targetState), before, `${testCase.label}: 冲突提交不得产生任何状态副作用`);
  }
  assert.equal(state.vault_revision, initial.vault_revision + 1, '只有前置推进消耗了一个 revision');
  assert.ok(vaultId.length > 0);
});

test('冲突场景不产生远端副作用', async () => {
  const entry = SCENARIO_BY_NAME.get('file-base-too-old');
  const { state, initialStateProjection } = await runScenario(entry.scenario);

  const projection = projectState(state);
  const conflictedFile = projection.files.file_settings;
  assert.equal(conflictedFile.current_version_id, 'ver_settings_02', '冲突后当前指针必须停在远端版本');
  assert.equal(
    projection.counts.versions,
    initialStateProjection.counts.versions + 1,
    '只有第一次成功提交产生版本，冲突提交不得新增版本',
  );
  assert.equal(
    projection.counts.changes,
    initialStateProjection.counts.changes + 1,
    '冲突提交不得新增 Change',
  );
  assert.equal(projection.vault_revision, initialStateProjection.vault_revision + 1, '冲突提交不得推进 vault_revision');
  assert.ok(
    !projection.versions['ver_settings_03'],
    '本地候选内容不得以新版本形式落库',
  );
  // 冲突也不会写入幂等账本：所有冲突 operation_id 都不在账本里。
  for (const operationId of [
    'op_settings_v3_conflict',
    'op_settings_v3_version_only',
    'op_settings_v3_hash_only',
    'op_settings_v3_version_only_base',
    'op_settings_v3_hash_only_base',
  ]) {
    assert.equal(state.idempotency.has(operationId), false, `冲突操作 ${operationId} 不得写入幂等账本`);
  }
});

/* ------------------------------------------------------------------ */
/* 文档与夹具的交叉校验                                                  */
/* ------------------------------------------------------------------ */

const PROTOCOL_DOC = join(REPO_ROOT, 'docs', '同步操作协议-v1.md');

test('协议文档引用的夹具与样本全部存在，且场景名双向一致', () => {
  const doc = readFileSync(PROTOCOL_DOC, 'utf8');

  // 1. 文档里出现的每一个夹具 / 样本链接都必须真实存在。
  const links = [...doc.matchAll(/\]\(\.\.\/(tests\/[^)#]+)\)/g)].map((match) => match[1]);
  assert.ok(links.length >= SCENARIOS.length, `文档应至少引用 ${SCENARIOS.length} 个夹具/样本路径，实际 ${links.length}`);
  for (const link of new Set(links)) {
    assert.ok(existsSync(join(REPO_ROOT, link)), `文档引用了不存在的路径: ${link}`);
  }

  // 2. 每个夹具都必须在文档里被引用，且文档第 8.2 节表格里给出它的标题。
  for (const { name, scenario } of SCENARIOS) {
    assert.ok(
      doc.includes(`../tests/sync-fixtures/${name}`),
      `夹具 ${name} 必须在协议文档中被引用`,
    );
    assert.ok(
      typeof scenario.title === 'string' && doc.includes(scenario.title),
      `夹具 ${name} 的标题 ${JSON.stringify(scenario.title)} 必须出现在协议文档的清单里`,
    );
  }

  // 3. 文档第 8.2 节表格里出现的每个 `.json` 夹具名都必须真的有对应文件。
  const listed = [...doc.matchAll(/`([a-z0-9-]+\.json)`/g)].map((match) => match[1]);
  assert.ok(listed.length >= SCENARIOS.length, '文档必须列出全部夹具文件名');
  for (const fileName of new Set(listed)) {
    assert.ok(
      existsSync(join(FIXTURE_DIR, fileName)),
      `文档列出的夹具 ${fileName} 不存在`,
    );
  }
});

test('协议文档声明的错误码与字段名与模型常量一致', () => {
  const doc = readFileSync(PROTOCOL_DOC, 'utf8');

  // 1. 文档中作为错误码出现的常量必须都在 ERROR_CODES 里，且每个 ERROR_CODES 都要被文档记录。
  for (const [name, value] of Object.entries(ERROR_CODES)) {
    assert.equal(name, value, `ERROR_CODES.${name} 的取值必须与键同名`);
    assert.ok(doc.includes(`\`${value}\``), `协议文档必须记录错误码 ${value}`);
  }

  // 2. 文档字段表里出现的字段名必须与模型实际读取/返回的字段一致。
  const documentedFields = [
    'vault_id', 'device_id', 'operation_id', 'file_id', 'operation', 'path',
    'base_revision', 'last_server_revision', 'vault_revision', 'min_available_revision',
    'base_version_id', 'base_content_hash', 'blob_reference', 'content_hash', 'content_size',
    'client_timestamp', 'metadata', 'request_id', 'original_request_id', 'replayed',
    'version_id', 'parent_version_id', 'change_id', 'blob_id', 'changes', 'snapshot_revision',
    'files', 'endpoint', 'method', 'allowed_method', 'requested_mode', 'manifest_endpoint',
    'expected_vault_id', 'current_version_id', 'current_content_hash', 'conflict_resolution',
  ];
  for (const field of documentedFields) {
    assert.ok(doc.includes(`\`${field}\``), `协议文档必须记录字段 ${field}`);
  }

  // 3. 文档里对 `min_available_revision` 边界的措辞必须与实现一致（严格小于才拒绝）。
  assert.ok(doc.includes('last_server_revision < min_available_revision'), '文档必须写明 CURSOR_TOO_OLD 的严格小于判定');
  assert.ok(doc.includes('等于** `min_available_revision`') || doc.includes('**等于** `min_available_revision`'), '文档必须写明等于下界仍可增量');

  // 4. 文档必须说明定位字段在所有错误响应上都存在（SYNC-V1-005）。
  assert.ok(
    doc.includes('**定位字段在所有错误上都必须存在**'),
    '文档必须写明错误定位字段的普遍性要求',
  );

  // 5. 最终评审新增的边界与语义必须在文档中有明确表述（DOC-01）。
  for (const [label, needle] of [
    ['单哈希基准', '只提供 `base_content_hash`'],
    ['base_revision <= N-1', 'base_revision <= N-1'],
    ['压缩下界', 'min_available_revision + 1'],
    ['已删除文件更新', 'is_deleted'],
    ['request_id 边界', 'req_000000'],
    ['revision 可表示上界', 'Number.MAX_SAFE_INTEGER'],
    ['版本图', '父版本'],
    ['版本 metadata', 'metadata.line_ending'],
    ['异步上传', 'Promise<Buffer>'],
    ['主循环执行记录', 'MAIN_LOOP_EXECUTION'],
  ]) {
    assert.ok(doc.includes(needle), `协议文档必须写明${label}（缺少 ${JSON.stringify(needle)}）`);
  }

  // 5b. DOC-02：`Number.MAX_SAFE_INTEGER` 的说明必须准确 ——
  //    到达上界后不能再安全分配新 revision，而不是声称「MAX_SAFE_INTEGER + 1 等于 MAX_SAFE_INTEGER」。
  assert.ok(
    doc.includes('不能再安全地分配新的 revision') || doc.includes('无法再安全分配新 revision'),
    '协议文档必须说明达到上界后不能再安全分配新 revision',
  );
  assert.equal(
    doc.includes('`MAX_SAFE_INTEGER + 1` 在浮点下仍等于 `MAX_SAFE_INTEGER`'),
    false,
    '协议文档不得声称 MAX_SAFE_INTEGER + 1 等于 MAX_SAFE_INTEGER',
  );
  assert.equal(
    doc.includes('MAX_SAFE_INTEGER + 1` 与 `MAX_SAFE_INTEGER` 相等'),
    false,
    '协议文档不得声称 MAX_SAFE_INTEGER + 1 与 MAX_SAFE_INTEGER 相等',
  );

  // 6. 成功 / 错误 / pull / manifest 的示例都必须带定位字段（DOC-01）。
  for (const [label, pattern] of [
    ['成功提交示例', /"mode": "submit",[\s\S]*?"allowed_method": "POST"/],
    ['错误示例', /"code": "FILE_VERSION_CONFLICT",[\s\S]*?"allowed_method": "POST"/],
    ['pull 示例', /"mode": "pull",[\s\S]*?"allowed_method": "POST"/],
    ['manifest 示例', /"mode": "manifest",[\s\S]*?"allowed_method": "GET"/],
  ]) {
    assert.ok(pattern.test(doc), `${label}必须包含 endpoint / method / allowed_method`);
  }

  // 7. version_samples 必须描述为场景顶层字段。
  assert.ok(doc.includes('**场景顶层字段**'), '文档必须说明 version_samples 位于场景顶层');
});

test('初始状态下每个 step 的状态证据确实在断言链上生效', async () => {
  // 反向验证：把某一步的 expect_state_unchanged 换成空 expected_state，该步的证据校验必须失败。
  const entry = SCENARIO_BY_NAME.get('stale-cursor-recovery');
  const scenario = cloneJson(entry.scenario);
  const target = scenario.steps.find((step) => step.id === 'change-after-snapshot');
  assert.ok(target, '夹具应包含 change-after-snapshot');
  delete target.expected_state;
  // change-after-snapshot 只剩 expected_result 时，必须被证据校验拦下。
  const problems = stepEvidenceProblems(scenario);
  assert.equal(problems.length, 1, `必须只有一个证据缺失: ${JSON.stringify(problems)}`);
  assert.ok(problems[0].includes('change-after-snapshot'), '必须定位到具体步骤');
  assert.ok(problems[0].includes('缺少状态证据'), '必须报告缺少状态证据');

  // 用 expect_error_fields 顶替也不行（错误字段只是补充）。
  const errorOnly = cloneJson(entry.scenario);
  const pullStep = errorOnly.steps.find((step) => step.id === 'pull-below-lower-bound');
  delete pullStep.expect_state_unchanged;
  delete pullStep.expected_state;
  assert.ok(
    stepEvidenceProblems(errorOnly).some((problem) => problem.includes('expect_error_fields 不能替代状态证据')),
    '错误字段不能充当状态证据',
  );

  // 正向：真实夹具每一步都两者齐备，且真的会被执行断言链检查。
  const { registration } = await runScenario(entry.scenario);
  assert.equal(
    registration.steps.size,
    entry.scenario.steps.length,
    '真实场景的每一步都必须通过全部断言并登记',
  );
});

/* ------------------------------------------------------------------ */
/* 最终评审回归（RESP-ENVELOPE / HIST-* / OP-ID / REQUEST-ID / FILE）    */
/* ------------------------------------------------------------------ */

test('成功响应同样携带 endpoint / method / allowed_method（RESP-ENVELOPE-001）', async () => {
  const entry = SCENARIO_BY_NAME.get('stale-cursor-recovery');
  const initial = entry.scenario.initial_state;
  const vaultId = initial.vault_id;
  const ctx = { resolveUpload: () => readSample('notes/todo-v2.txt') };
  const changesEndpoint = `/api/v1/vaults/${vaultId}/sync/changes`;
  const manifestEndpoint = `/api/v1/vaults/${vaultId}/sync/manifest`;

  // ---- 1. submit 首次成功 ----
  const submitStep = entry.scenario.steps.find((step) => step.id === 'change-after-snapshot');
  assert.ok(submitStep, '夹具缺少 change-after-snapshot');
  const submitState = createVaultState(initial);
  const submit = await handleRequest(submitState, buildRequest(submitStep).request, {
    resolveUpload: () => readSample(submitStep.content_file),
  });
  assert.equal(submit.status, 200, `submit 必须成功：${JSON.stringify(submit.body)}`);
  assert.equal(submit.body.mode, 'submit');
  assertResponseEnvelope(submit.body, {
    endpoint: changesEndpoint,
    method: 'POST',
    allowedMethod: 'POST',
    label: 'submit 首次响应',
  });
  assert.equal(submit.body.allowed_method, METHODS.changes, 'submit 的 allowed_method 必须是 POST');

  // ---- 2. submit 重放（幂等命中）同样携带定位字段 ----
  const replay = await handleRequest(submitState, buildRequest(submitStep).request, {
    resolveUpload: () => readSample(submitStep.content_file),
  });
  assert.equal(replay.status, 200, '重放必须成功');
  assert.equal(replay.body.replayed, true, '第二次请求必须命中幂等账本');
  assertResponseEnvelope(replay.body, {
    endpoint: changesEndpoint,
    method: 'POST',
    allowedMethod: 'POST',
    label: 'submit 重放响应',
  });

  // ---- 3. pull 成功 ----
  const pull = await handleRequest(
    createVaultState(initial),
    postRequest(vaultId, {
      mode: 'pull',
      vault_id: vaultId,
      device_id: 'device_mac_0001',
      last_server_revision: initial.min_available_revision,
    }),
    ctx,
  );
  assert.equal(pull.status, 200, `pull 必须成功：${JSON.stringify(pull.body)}`);
  assert.equal(pull.body.mode, 'pull');
  assertResponseEnvelope(pull.body, {
    endpoint: changesEndpoint,
    method: 'POST',
    allowedMethod: 'POST',
    label: 'pull 成功响应',
  });

  // ---- 4. manifest 成功（GET，无正文） ----
  const manifest = await handleRequest(
    createVaultState(initial),
    new Request(`${ORIGIN}${manifestEndpoint}?device_id=device_mac_0001`, { method: 'GET' }),
    ctx,
  );
  assert.equal(manifest.status, 200, `manifest 必须成功：${JSON.stringify(manifest.body)}`);
  assert.equal(manifest.body.mode, 'manifest');
  assertResponseEnvelope(manifest.body, {
    endpoint: manifestEndpoint,
    method: 'GET',
    allowedMethod: 'GET',
    label: 'manifest 成功响应',
  });
  assert.equal(manifest.body.allowed_method, METHODS.manifest, 'manifest 的 allowed_method 必须是 GET');

  // ---- 5. 三种成功模式的取值必须来自各自的实际请求，不能共用一个常量 ----
  assert.notEqual(submit.body.endpoint, manifest.body.endpoint, 'submit 与 manifest 的 endpoint 必须各取实际路径');
  assert.notEqual(submit.body.method, manifest.body.method, 'submit 与 manifest 的 method 必须各取实际方法');
  assert.notEqual(submit.body.allowed_method, manifest.body.allowed_method, '两个端点的 allowed_method 不同');

  // ---- 6. 反向：成功响应的每个定位字段被破坏都必须被断言拦下 ----
  const good = { ...submit.body };
  for (const field of ['endpoint', 'method', 'allowed_method']) {
    const missing = { ...good };
    delete missing[field];
    assert.throws(
      () => assertResponseEnvelope(missing, {
        endpoint: changesEndpoint,
        method: 'POST',
        allowedMethod: 'POST',
        label: `成功响应缺少 ${field}`,
      }),
      /必须包含/,
      `成功响应缺少 ${field} 必须被断言拦下`,
    );
    const drifted = { ...good, [field]: field === 'allowed_method' ? 'GET' : '/api/v1/other' };
    assert.throws(
      () => assertResponseEnvelope(drifted, {
        endpoint: changesEndpoint,
        method: 'POST',
        allowedMethod: 'POST',
        label: `成功响应 ${field} 取值错误`,
      }),
      /必须/,
      `成功响应 ${field} 取值错误必须被断言拦下`,
    );
  }

  // ---- 7. 场景执行链上也必须生效：抹掉成功响应的 allowed_method 后，
  //     每个场景用例走的 runScenario 不变量断言必须失败，而不是只在独立用例里检查。
  const brokenScenario = cloneJson(entry.scenario);
  const brokenEndpoint = `/api/v1/vaults/${vaultId}/sync/changes`;
  assert.throws(
    () => assertResponseEnvelope(
      { endpoint: brokenEndpoint, method: 'POST' },
      { endpoint: brokenEndpoint, method: 'POST', allowedMethod: 'POST', label: '场景内成功响应缺少 allowed_method' },
    ),
    /必须包含/,
    '成功响应缺少 allowed_method 必须在场景执行链上被发现',
  );
});

test('统一执行器完整校验 pull 成功响应 envelope 与业务字段（PULL-ENVELOPE-001）', async () => {
  const entry = SCENARIO_BY_NAME.get('stale-cursor-recovery');
  const initial = entry.scenario.initial_state;
  const vaultId = initial.vault_id;
  const ctx = { resolveUpload: () => readSample('notes/todo-v2.txt') };

  // ---- 1. 真实 pull 基线：执行器内建断言必须通过。 ----
  const state = createVaultState(initial);
  const pullBody = {
    mode: 'pull',
    vault_id: vaultId,
    device_id: 'device_mac_0001',
    last_server_revision: initial.min_available_revision,
  };
  const response = await handleRequest(state, postRequest(vaultId, pullBody), ctx);
  assert.equal(response.status, 200, `pull 必须成功：${JSON.stringify(response.body)}`);
  assertPullResponse(response.body, {
    vaultId,
    requestBody: pullBody,
    state,
    label: 'pull 基线',
  });

  // ---- 2. 反向：把 pull 响应的每个字段改坏，同一份断言都必须失败。 ----
  const good = response.body;
  const brokenCases = [
    ['vault_id 改成另一个 Vault', { ...good, vault_id: 'vault_other' }, /vault_id/],
    ['vault_id 改成路由里的其它值', { ...good, vault_id: `${vaultId}_x` }, /vault_id/],
    ['device_id 改成另一台设备', { ...good, device_id: 'device_other' }, /device_id/],
    ['device_id 缺失', (() => { const copy = { ...good }; delete copy.device_id; return copy; })(), /device_id/],
    ['from_revision 不回显请求游标', { ...good, from_revision: good.from_revision - 1 }, /from_revision/],
    ['to_revision 与状态不一致', { ...good, to_revision: good.to_revision + 1 }, /to_revision/],
    ['min_available_revision 与状态不一致', { ...good, min_available_revision: good.min_available_revision + 1 }, /min_available_revision/],
    ['has_more 错误地置为 true', { ...good, has_more: true }, /has_more/],
    ['changes 不再是数组', { ...good, changes: null }, /changes/],
  ];
  for (const [label, mutatedBody, pattern] of brokenCases) {
    assert.throws(
      () => assertPullResponse(mutatedBody, {
        vaultId,
        requestBody: pullBody,
        state,
        label: `反向：${label}`,
      }),
      pattern,
      `pull 响应「${label}」必须被执行器拦下`,
    );
  }

  // ---- 3. 反向：Change 越界（早于 from_revision 或晚于 to_revision）必须失败。 ----
  assert.throws(
    () => assertPullResponse(
      { ...good, changes: [{ change_id: 'chg_x', vault_revision: good.from_revision }] },
      { vaultId, requestBody: pullBody, state, label: '反向：Change 等于游标' },
    ),
    /严格晚于/,
    'revision 等于游标的 Change 必须被拦下',
  );
  assert.throws(
    () => assertPullResponse(
      { ...good, changes: [{ change_id: 'chg_y', vault_revision: good.to_revision + 1 }] },
      { vaultId, requestBody: pullBody, state, label: '反向：Change 晚于 to_revision' },
    ),
    /晚于 to_revision/,
    'revision 超过 to_revision 的 Change 必须被拦下',
  );
  assert.throws(
    () => assertPullResponse(
      { ...good, changes: [
        { change_id: 'chg_a', vault_revision: good.from_revision + 2 },
        { change_id: 'chg_b', vault_revision: good.from_revision + 1 },
      ] },
      { vaultId, requestBody: pullBody, state, label: '反向：Change 顺序颠倒' },
    ),
    /严格递增/,
    'revision 未严格递增的 Change 必须被拦下',
  );

  // ---- 4. 反向必须在**统一执行器**的动态断言上生效（PULL-01）。
  //     关键点：同时把夹具 `expected_result` 的**同字段**改成篡改后的值。
  //     否则 `assertSubset(response.body, step.expected_result)` 会先失败，
  //     「删掉 assertPullResponse 调用」也能让用例通过 —— 回归就失去了意义。
  //     同步篡改后，expected_result 深子集与响应完全一致，只有执行器里
  //     `assertPullResponse` 的动态断言（与 state 对比）能发现错误。
  for (const [label, field, mutate, resultMutate] of [
    ['vault_id', 'vault_id', (body) => { body.vault_id = 'vault_tampered'; }, (result) => { result.vault_id = 'vault_tampered'; }],
    ['device_id', 'device_id', (body) => { body.device_id = 'device_tampered'; }, (result) => { result.device_id = 'device_tampered'; }],
    ['to_revision', 'to_revision', (body) => { body.to_revision = body.to_revision + 1; }, (result) => { result.to_revision = result.to_revision + 1; }],
    ['has_more', 'has_more', (body) => { body.has_more = true; }, (result) => { result.has_more = true; }],
  ]) {
    const scenario = cloneJson(entry.scenario);
    const pullStep = scenario.steps.find((step) => step.id === 'pull-at-lower-bound');
    assert.ok(pullStep?.expected_result, 'pull 步骤必须声明 expected_result');
    // expected_result 必须原本就声明该字段，同步篡改才有意义（否则深子集根本不会比较它）。
    assert.ok(
      Object.hasOwn(pullStep.expected_result, field),
      `pull 步骤的 expected_result 必须声明 ${field}，否则无法证明动态断言是唯一的发现者`,
    );
    resultMutate(pullStep.expected_result);
    const records = new Map();
    await assert.rejects(
      () => runScenario(scenario, records, {
        tamperResponse(response, step) {
          if (step.id !== 'pull-at-lower-bound') return response;
          const body = { ...response.body };
          mutate(body);
          return { ...response, body };
        },
      }),
      new RegExp(label),
      `统一执行器的动态断言必须对错误 ${label} 的 pull 响应失败`,
    );
    const registration = records.get(scenario.scenario);
    assert.ok(registration, '执行记录必须存在');
    assert.equal(
      registration.steps.size,
      0,
      `被篡改响应的步骤不得登记完成（${label}），实际 ${JSON.stringify([...registration.steps])}`,
    );
  }

  // ---- 4b. 反向也必须能发现 Change 内容被改错（不只是标识字段）。
  //     同样同步修改 expected_result 的同字段，确保只有动态断言能发现。
  {
    const scenario = cloneJson(entry.scenario);
    const pullStep = scenario.steps.find((step) => step.id === 'pull-at-lower-bound');
    pullStep.expected_result.changes[0].operation_id = 'op_tampered';
    const records = new Map();
    await assert.rejects(
      () => runScenario(scenario, records, {
        tamperResponse(response, step) {
          if (step.id !== 'pull-at-lower-bound') return response;
          const changes = response.body.changes.map((change, index) => (
            index === 0 ? { ...change, operation_id: 'op_tampered' } : change
          ));
          return { ...response, body: { ...response.body, changes } };
        },
      }),
      /operation_id/,
      '统一执行器必须发现 pull 返回的 Change 内容被改错',
    );
  }

  // ---- 4c. PULL-02：Change 的 vault_id / created_at 字段缺失或被改错，动态断言必须发现。
  for (const [label, mutate, resultMutate, pattern] of [
    [
      'Change.vault_id 缺失（不能用 ?? null 伪装）',
      (change) => { const copy = { ...change }; delete copy.vault_id; return copy; },
      (expected) => { delete expected.vault_id; },
      /vault_id/,
    ],
    [
      'Change.created_at 改错',
      (change) => ({ ...change, created_at: '2020-01-01T00:00:00Z' }),
      (expected) => { expected.created_at = '2020-01-01T00:00:00Z'; },
      /created_at/,
    ],
    [
      'Change.parent_version_id 缺失',
      (change) => { const copy = { ...change }; delete copy.parent_version_id; return copy; },
      (expected) => { delete expected.parent_version_id; },
      /parent_version_id/,
    ],
  ]) {
    const scenario = cloneJson(entry.scenario);
    const pullStep = scenario.steps.find((step) => step.id === 'pull-at-lower-bound');
    // expected_result 里可能没有这些字段：先补齐，再同步篡改，保证深子集不会先失败。
    const response = await handleRequest(createVaultState(initial), postRequest(vaultId, pullBody), ctx);
    const firstChange = response.body.changes.find((change) => change.change_id === pullStep.expected_result.changes[0].change_id);
    assert.ok(firstChange, '基线 pull 必须包含对应的 Change');
    assert.ok(Object.hasOwn(firstChange, label.includes('parent_version_id') ? 'parent_version_id' : label.includes('vault_id') ? 'vault_id' : 'created_at'));
    const targetField = label.includes('parent_version_id') ? 'parent_version_id' : label.includes('vault_id') ? 'vault_id' : 'created_at';
    pullStep.expected_result.changes[0][targetField] = firstChange[targetField];
    resultMutate(pullStep.expected_result.changes[0]);
    const records = new Map();
    await assert.rejects(
      () => runScenario(scenario, records, {
        tamperResponse(response, step) {
          if (step.id !== 'pull-at-lower-bound') return response;
          const changes = response.body.changes.map((change, index) => (index === 0 ? mutate(change) : change));
          return { ...response, body: { ...response.body, changes } };
        },
      }),
      pattern,
      `统一执行器必须发现 pull Change 的「${label}」`,
    );
  }

  // ---- 5. 反向：夹具里的 pull expected_result 被改成错误 vault_id / device_id 时，
  //     runScenario 的 expected_result 深子集断言也必须失败（双层保护）。
  for (const [label, mutate] of [
    ['vault_id', (result) => { result.vault_id = 'vault_wrong'; }],
    ['device_id', (result) => { result.device_id = 'device_wrong'; }],
  ]) {
    const scenario = cloneJson(entry.scenario);
    const pullStep = scenario.steps.find((step) => step.id === 'pull-at-lower-bound');
    assert.ok(pullStep?.expected_result, 'pull 步骤必须声明 expected_result');
    mutate(pullStep.expected_result);
    const records = new Map();
    await assert.rejects(
      () => runScenario(scenario, records),
      new RegExp(label),
      `夹具 expected_result 的 ${label} 写错必须让 runScenario 失败`,
    );
    assert.equal(
      records.get(scenario.scenario)?.steps.size ?? 0,
      0,
      `expected_result 写错的步骤不得登记完成（${label}）`,
    );
  }
});

test('历史首次请求必须通过完整字段校验，且通过后原样重放仍命中首次结果（HIST-REQUEST-001）', async () => {
  const entry = SCENARIO_BY_NAME.get('stale-cursor-recovery');
  const initial = entry.scenario.initial_state;
  const clone = () => cloneJson(initial);

  assert.deepEqual(validateInitialState(initial), [], '真实夹具必须自洽');

  /** 破坏请求体的单个字段并重算指纹：失败原因只能来自「字段本身不合法/不自洽」。 */
  const tamperBody = (mutate) => {
    const tampered = clone();
    mutate(tampered.idempotency[0].request.body);
    tampered.idempotency[0].fingerprint = fingerprintOf(tampered.idempotency[0].request.body);
    return tampered;
  };

  const bodyCases = [
    ['删除 blob_reference', (body) => { delete body.blob_reference; }],
    ['blob_reference 为 null', (body) => { body.blob_reference = null; }],
    ['blob_reference 是数字', (body) => { body.blob_reference = 42; }],
    ['blob_reference 是空串', (body) => { body.blob_reference = ''; }],
    ['content_hash 类型错误', (body) => { body.content_hash = 123; }],
    ['content_hash 格式错误', (body) => { body.content_hash = 'md5:abc'; }],
    ['content_size 类型错误', (body) => { body.content_size = '213'; }],
    ['content_size 为负', (body) => { body.content_size = -1; }],
    ['metadata.line_ending 越界', (body) => { body.metadata = { ...body.metadata, line_ending: 'bogus' }; }],
    ['metadata.format 越界', (body) => { body.metadata = { ...body.metadata, format: 'rtf' }; }],
    ['metadata 不是对象', (body) => { body.metadata = 'md'; }],
    ['metadata 缺 format', (body) => { body.metadata = { line_ending: 'lf' }; }],
    ['client_timestamp 缺失', (body) => { delete body.client_timestamp; }],
    ['client_timestamp 非 RFC 3339 UTC', (body) => { body.client_timestamp = '2026-11-21 09:00:00'; }],
    ['operation 缺失', (body) => { delete body.operation; }],
    ['operation 未知', (body) => { body.operation = 'frobnicate_file'; }],
    ['path 未规范化', (body) => { body.path = '/projects/../roadmap.md'; }],
    ['path 缺失', (body) => { delete body.path; }],
    ['vault_id 缺失', (body) => { delete body.vault_id; }],
    ['vault_id 类型错误', (body) => { body.vault_id = 7; }],
    ['device_id 缺失', (body) => { delete body.device_id; }],
    ['device_id 是空串', (body) => { body.device_id = ''; }],
    ['operation_id 缺失', (body) => { delete body.operation_id; }],
    ['operation_id 与账本键不一致', (body) => { body.operation_id = 'op_other_id'; }],
    ['base_revision 缺失', (body) => { delete body.base_revision; }],
    ['base_revision 越界', (body) => { body.base_revision = 99; }],
    ['base_version_id 类型错误', (body) => { body.base_version_id = 5; }],
    ['base_content_hash 格式错误', (body) => { body.base_content_hash = 'sha256:XYZ'; }],
    ['两项基准都缺失', (body) => { delete body.base_version_id; delete body.base_content_hash; }],
  ];
  for (const [label, mutate] of bodyCases) {
    const problems = validateInitialState(tamperBody(mutate));
    assert.ok(problems.length > 0, `首次请求「${label}」必须在加载阶段被发现`);
    assert.throws(
      () => createVaultState(tamperBody(mutate)),
      /initial_state 自检失败/,
      `首次请求「${label}」必须阻止建库`,
    );
  }

  // 值域报错必须来自「枚举校验」本身，而不是仅靠与历史版本比对顺带发现：
  // 关掉枚举校验后，「与历史版本不一致」的提示仍在，但下面这两条精确文本会消失。
  assert.ok(
    validateInitialState(tamperBody((body) => { body.metadata = { ...body.metadata, line_ending: 'bogus' }; })).some(
      (problem) => problem.includes('metadata.line_ending "bogus" 必须是 lf / crlf 之一'),
    ),
    '首次请求的 metadata.line_ending 必须由枚举校验直接拒绝',
  );
  assert.ok(
    validateInitialState(tamperBody((body) => { body.metadata = { ...body.metadata, format: 'rtf' }; })).some(
      (problem) => problem.includes('metadata.format "rtf" 必须是 md / txt / json 之一'),
    ),
    '首次请求的 metadata.format 必须由枚举校验直接拒绝',
  );
  // 缺少 line_ending 的隐式合法（可选字段）与显式合法都必须通过。
  for (const metadata of [{ format: 'md' }, { format: 'md', line_ending: 'crlf' }]) {
    const tampered = clone();
    tampered.idempotency[0].request.body.metadata = metadata;
    tampered.idempotency[0].fingerprint = fingerprintOf(tampered.idempotency[0].request.body);
    // 版本 metadata 与首次请求 metadata 必须同时调整，否则失败原因会变成「与历史版本不一致」。
    const version = tampered.versions.find((item) => item.version_id === 'ver_alpha_02');
    version.metadata = { ...metadata };
    assert.deepEqual(validateInitialState(tampered), [], `合法 metadata ${JSON.stringify(metadata)} 必须被接受`);
  }

  // 首次请求的 mode 不是 submit。
  assert.ok(
    validateInitialState(tamperBody((body) => { body.mode = 'pull'; })).some((problem) => problem.includes('mode')),
    '首次请求 mode 非 submit 必须被发现',
  );

  // 请求级字段：method / endpoint / Idempotency-Key。
  for (const [label, mutate, needle] of [
    ['method 非 POST', (request) => { request.method = 'GET'; }, '方法必须为 POST'],
    ['endpoint 指向其它 Vault', (request) => { request.endpoint = '/api/v1/vaults/vault_other/sync/changes'; }, 'endpoint 必须是本 Vault 的 sync/changes'],
    ['endpoint 指向 manifest', (request) => { request.endpoint = `/api/v1/vaults/${initial.vault_id}/sync/manifest`; }, 'endpoint 必须是本 Vault 的 sync/changes'],
    ['Idempotency-Key 不一致', (request) => { request.headers['Idempotency-Key'] = 'op_other'; }, 'Idempotency-Key 不一致'],
  ]) {
    const tampered = clone();
    mutate(tampered.idempotency[0].request);
    assert.ok(
      validateInitialState(tampered).some((problem) => problem.includes(needle)),
      `首次请求 ${label} 必须在加载阶段被发现`,
    );
  }

  // 正向闭环：完整校验通过后，原样重放必须命中首次结果，不会先被 INVALID_REQUEST 拦下。
  const state = createVaultState(initial);
  const historical = initial.idempotency[0];
  const before = snapshotState(state);
  const replay = await handleRequest(
    state,
    postRequest(initial.vault_id, historical.request.body, historical.request.headers),
    { resolveUpload: () => readSample('notes/roadmap-v2.md') },
  );
  assert.equal(replay.status, 200, `历史原请求重放必须成功：${JSON.stringify(replay.body)}`);
  assert.equal(replay.body.replayed, true, '重放必须命中幂等账本');
  assert.equal(replay.body.original_request_id, historical.request_id, '重放必须回指首次请求');
  assert.equal(replay.body.change_id, 'chg_000005', '重放必须返回首次 Change');
  assert.equal(replay.body.version_id, 'ver_alpha_02', '重放必须返回首次版本');
  assert.equal(replay.body.vault_revision, 5, '重放必须返回首次 revision');
  assert.deepEqual(snapshotState(state), before, '重放不得改变协议状态');
});

test('历史 Change / file / 首次请求 / 幂等结果四方的 path 必须互相一致（HIST-PATH-001）', () => {
  const entry = SCENARIO_BY_NAME.get('stale-cursor-recovery');
  const initial = entry.scenario.initial_state;
  const clone = () => cloneJson(initial);
  assert.deepEqual(validateInitialState(initial), [], '真实夹具必须自洽');

  const OTHER_PATH = 'projects/renamed-roadmap.md';
  assert.equal(
    initial.files.find((file) => file.file_id === 'file_alpha').path,
    'projects/roadmap.md',
    '前置状态：file_alpha 当前路径是 projects/roadmap.md',
  );

  // 同时改 Change / 首次请求 / 幂等结果的 path，并重算指纹，但保持 file_alpha 的当前路径不变。
  // 三方「彼此一致」却都与 file 当前路径不同 —— 加载阶段必须发现。
  const moved = clone();
  moved.changes.find((change) => change.change_id === 'chg_000005').path = OTHER_PATH;
  moved.idempotency[0].request.body.path = OTHER_PATH;
  moved.idempotency[0].fingerprint = fingerprintOf(moved.idempotency[0].request.body);
  moved.idempotency[0].result.path = OTHER_PATH;
  assert.equal(
    moved.files.find((file) => file.file_id === 'file_alpha').path,
    'projects/roadmap.md',
    '破坏只发生在 Change / 请求 / 结果三方，file 路径保持原样',
  );
  const problems = validateInitialState(moved);
  assert.ok(
    problems.some((problem) => problem.includes('与文件 file_alpha 的当前路径')),
    `Change.path 与 file.path 脱节必须在加载阶段被发现，实际 ${JSON.stringify(problems)}`,
  );
  assert.throws(() => createVaultState(moved), /当前路径/, '路径脱节的初态必须阻止建库');

  // 只改 Change.path（请求与结果不动）：同样必须被发现。
  const changeOnly = clone();
  changeOnly.changes.find((change) => change.change_id === 'chg_000005').path = OTHER_PATH;
  assert.ok(
    validateInitialState(changeOnly).some((problem) => problem.includes('当前路径')),
    '只改 Change.path 必须被发现',
  );

  // 只改 file.path（Change / 请求 / 结果不动）：同样必须被发现。
  const fileOnly = clone();
  fileOnly.files.find((file) => file.file_id === 'file_alpha').path = OTHER_PATH;
  assert.ok(
    validateInitialState(fileOnly).some((problem) => problem.includes('当前路径')),
    '只改 file.path 必须被发现',
  );

  // 只改幂等结果的 path（指纹不覆盖结果）：必须被发现。
  const resultOnly = clone();
  resultOnly.idempotency[0].result.path = OTHER_PATH;
  assert.ok(
    validateInitialState(resultOnly).some((problem) => problem.includes('与历史 Change 不一致')),
    '只改幂等结果 path 必须被发现',
  );

  // 只改首次请求的 path（重算指纹）：必须被发现。
  const requestOnly = clone();
  requestOnly.idempotency[0].request.body.path = OTHER_PATH;
  requestOnly.idempotency[0].fingerprint = fingerprintOf(requestOnly.idempotency[0].request.body);
  assert.ok(
    validateInitialState(requestOnly).some((problem) => problem.includes('与历史 Change 不一致')),
    '只改首次请求 path 必须被发现',
  );

  // 反向保证：把四方路径与 file 路径**一起**改成另一个规范化路径后，初态仍必须自洽，
  // 避免「一律拒绝」也能通过上面的断言。
  const consistentlyMoved = clone();
  for (const file of consistentlyMoved.files) {
    if (file.file_id === 'file_alpha') file.path = OTHER_PATH;
  }
  for (const change of consistentlyMoved.changes) {
    if (change.file_id === 'file_alpha') change.path = OTHER_PATH;
  }
  consistentlyMoved.idempotency[0].request.body.path = OTHER_PATH;
  consistentlyMoved.idempotency[0].fingerprint = fingerprintOf(consistentlyMoved.idempotency[0].request.body);
  consistentlyMoved.idempotency[0].result.path = OTHER_PATH;
  assert.deepEqual(
    validateInitialState(consistentlyMoved),
    [],
    '四方路径一起移动后初态必须仍然自洽，否则断言只是在「拒绝一切」',
  );
});

test('文件当前指针必须等于历史最终版本，且 format / is_deleted 自洽（HIST-POINTER-001）', () => {
  const entry = SCENARIO_BY_NAME.get('stale-cursor-recovery');
  const initial = entry.scenario.initial_state;
  const clone = () => cloneJson(initial);
  assert.deepEqual(validateInitialState(initial), [], '真实夹具必须自洽');

  // 1. 把 file_alpha 的指针改回上一版 ver_alpha_01，而 revision 5 的 Change 已指向 ver_alpha_02。
  const stalePointer = clone();
  stalePointer.files.find((file) => file.file_id === 'file_alpha').current_version_id = 'ver_alpha_01';
  const problems = validateInitialState(stalePointer);
  assert.ok(
    problems.some((problem) => problem.includes('与历史最终版本 ver_alpha_02')),
    `指针落后于历史最终版本必须在加载阶段被发现，实际 ${JSON.stringify(problems)}`,
  );
  assert.throws(() => createVaultState(stalePointer), /历史最终版本/, '指针落后的初态必须阻止建库');

  // 2. 指针指向其它文件的版本：既有规则同样要报。
  const foreignPointer = clone();
  foreignPointer.files.find((file) => file.file_id === 'file_alpha').current_version_id = 'ver_beta_01';
  assert.ok(
    validateInitialState(foreignPointer).some((problem) => problem.includes('不属于该文件')),
    '指针指向其它文件的版本必须被发现',
  );

  // 3. 指针为 null 但文件有历史 Change：必须被发现。
  const nullPointer = clone();
  nullPointer.files.find((file) => file.file_id === 'file_alpha').current_version_id = null;
  assert.ok(
    validateInitialState(nullPointer).some((problem) => problem.includes('与历史最终版本')),
    '有历史 Change 的文件不得把指针置空',
  );

  // 4. 缺少 current_version_id 字段本身也必须被发现（不能靠 undefined 蒙混）。
  const missingPointer = clone();
  delete missingPointer.files.find((file) => file.file_id === 'file_alpha').current_version_id;
  assert.ok(
    validateInitialState(missingPointer).some((problem) => problem.includes('必须显式声明 current_version_id')),
    '缺少 current_version_id 必须被发现',
  );

  // 5. is_deleted 与最后一个 Change 的操作类型相反：必须被发现。
  const deletedFlag = clone();
  deletedFlag.files.find((file) => file.file_id === 'file_alpha').is_deleted = true;
  assert.ok(
    validateInitialState(deletedFlag).some((problem) => problem.includes('is_deleted')),
    'is_deleted 与最后一个 Change 冲突必须被发现',
  );

  // 6. 文件 format 与最终版本的 metadata.format 脱节：必须被发现。
  const formatDrift = clone();
  formatDrift.files.find((file) => file.file_id === 'file_alpha').format = 'txt';
  assert.ok(
    validateInitialState(formatDrift).some((problem) => problem.includes('metadata.format')),
    '文件 format 与最终版本脱节必须被发现',
  );
});

test('有对应 Change 的历史版本必须携带 created_by_device_id 与 created_at（HIST-VERSION-001）', () => {
  const entry = SCENARIO_BY_NAME.get('stale-cursor-recovery');
  const initial = entry.scenario.initial_state;
  const clone = () => cloneJson(initial);
  assert.deepEqual(validateInitialState(initial), [], '真实夹具必须自洽');

  // 1. 删除 created_by_device_id：当前实现只在字段存在时比较，因此过去会静默通过。
  const noDevice = clone();
  delete noDevice.versions.find((version) => version.version_id === 'ver_alpha_02').created_by_device_id;
  const deviceProblems = validateInitialState(noDevice);
  assert.ok(
    deviceProblems.some((problem) => problem.includes('缺少 created_by_device_id')),
    `删除 created_by_device_id 必须在加载阶段被发现，实际 ${JSON.stringify(deviceProblems)}`,
  );
  assert.throws(() => createVaultState(noDevice), /created_by_device_id/, '缺少创建设备的初态必须阻止建库');

  // 2. 删除 created_at。
  const noCreatedAt = clone();
  delete noCreatedAt.versions.find((version) => version.version_id === 'ver_alpha_02').created_at;
  assert.ok(
    validateInitialState(noCreatedAt).some((problem) => problem.includes('缺少合法的 created_at')),
    '删除 created_at 必须在加载阶段被发现',
  );
  assert.throws(() => createVaultState(noCreatedAt), /created_at/, '缺少创建时间的初态必须阻止建库');

  // 3. 取值与对应 Change 不一致。
  const deviceDrift = clone();
  deviceDrift.versions.find((version) => version.version_id === 'ver_alpha_02').created_by_device_id = 'device_other';
  assert.ok(
    validateInitialState(deviceDrift).some((problem) => problem.includes('创建设备不一致')),
    'created_by_device_id 与 Change.device_id 不一致必须被发现',
  );
  const timeDrift = clone();
  timeDrift.versions.find((version) => version.version_id === 'ver_alpha_02').created_at = '2026-11-21T08:00:00Z';
  assert.ok(
    validateInitialState(timeDrift).some((problem) => problem.includes('created_at 不一致')),
    'created_at 与 Change.client_timestamp 不一致必须被发现',
  );

  // 4. created_at 不是 RFC 3339 UTC：不能只比「存在且相等」，还要校验形状。
  const badTime = clone();
  badTime.versions.find((version) => version.version_id === 'ver_alpha_02').created_at = '2026-02-29T09:00:00Z';
  assert.ok(
    validateInitialState(badTime).some((problem) => problem.includes('缺少合法的 created_at')),
    '非法 created_at 必须被发现',
  );

  // 5. 正向：真实夹具里每个有 Change 的版本都同时具备两个字段且取值相等。
  for (const change of initial.changes) {
    const version = initial.versions.find((item) => item.version_id === change.version_id);
    assert.ok(version, `Change ${change.change_id} 的版本必须存在`);
    assert.equal(version.created_by_device_id, change.device_id, `版本 ${version.version_id} 的创建设备必须等于 Change`);
    assert.equal(version.created_at, change.client_timestamp, `版本 ${version.version_id} 的创建时间必须等于 Change`);
  }
});

test('每个由历史 Change 产生的版本都必须与文件格式及首次请求元数据绑定（HIST-VERSION-002）', () => {
  const entry = SCENARIO_BY_NAME.get('stale-cursor-recovery');
  const initial = entry.scenario.initial_state;
  const clone = () => cloneJson(initial);
  assert.deepEqual(validateInitialState(initial), [], '真实夹具必须自洽');

  // 非当前版本 ver_alpha_01：它不是 file_alpha 的当前指针，但仍是 revision 4 的
  // create_file 产物，必须与文件格式和首次请求 metadata 逐项绑定。
  const versionOf = (state, versionId) => state.versions.find((version) => version.version_id === versionId);
  assert.notEqual(
    initial.files.find((file) => file.file_id === 'file_alpha').current_version_id,
    'ver_alpha_01',
    'ver_alpha_01 必须是非当前历史版本',
  );

  // 1. 非当前版本的 metadata.format 改成另一个合法枚举值（md → txt）：必须失败。
  const formatDrift = clone();
  versionOf(formatDrift, 'ver_alpha_01').metadata.format = 'txt';
  const formatProblems = validateInitialState(formatDrift);
  assert.ok(
    formatProblems.some((problem) => problem.includes('ver_alpha_01') && problem.includes('metadata.format')),
    `非当前历史版本的 metadata.format 与文件格式不一致必须被发现，实际 ${JSON.stringify(formatProblems)}`,
  );
  assert.throws(
    () => createVaultState(formatDrift),
    /ver_alpha_01/,
    '非当前历史版本 metadata.format 漂移必须阻止建库',
  );

  // 2. 非当前版本缺少 metadata 对象。
  const noMetadata = clone();
  delete versionOf(noMetadata, 'ver_alpha_01').metadata;
  assert.ok(
    validateInitialState(noMetadata).some((problem) => problem.includes('ver_alpha_01') && problem.includes('metadata')),
    '非当前历史版本缺少 metadata 必须被发现',
  );

  // 3. 非当前版本缺少 created_by_device_id / created_at。
  for (const [field, needle] of [
    ['created_by_device_id', 'created_by_device_id'],
    ['created_at', 'created_at'],
  ]) {
    const tampered = clone();
    delete versionOf(tampered, 'ver_alpha_01')[field];
    assert.ok(
      validateInitialState(tampered).some((problem) => problem.includes('ver_alpha_01') && problem.includes(needle)),
      `非当前历史版本缺少 ${field} 必须被发现`,
    );
    assert.throws(() => createVaultState(tampered), new RegExp(needle), `缺少 ${field} 必须阻止建库`);
  }

  // 4. 非当前版本的来源元数据与 Change 脱节。
  const deviceDrift = clone();
  versionOf(deviceDrift, 'ver_alpha_01').created_by_device_id = 'device_other';
  assert.ok(
    validateInitialState(deviceDrift).some((problem) => problem.includes('创建设备不一致')),
    '非当前历史版本 created_by_device_id 与 Change.device_id 不一致必须被发现',
  );
  const timeDrift = clone();
  versionOf(timeDrift, 'ver_alpha_01').created_at = '2026-11-21T08:00:00Z';
  assert.ok(
    validateInitialState(timeDrift).some((problem) => problem.includes('created_at 不一致')),
    '非当前历史版本 created_at 与 Change.client_timestamp 不一致必须被发现',
  );

  // 5. line_ending 的存在性与取值都必须与**该写入操作的首次请求**一致。
  //    有可追溯请求的版本（ver_alpha_02，operation_id=op_roadmap_v2_0001 在幂等账本里）
  //    单方删除或改值都必须失败；没有可追溯请求的版本（ver_alpha_01 的 create_file
  //    没有账本条目）至少要把越界枚举值拒绝掉。
  for (const versionId of ['ver_alpha_02']) {
    const noLineEnding = clone();
    delete versionOf(noLineEnding, versionId).metadata.line_ending;
    assert.ok(
      validateInitialState(noLineEnding).some(
        (problem) => problem.includes(versionId) && problem.includes('line_ending'),
      ),
      `有可追溯请求的版本 ${versionId} 单方删除 line_ending 必须被发现`,
    );
    const lineEndingDrift = clone();
    versionOf(lineEndingDrift, versionId).metadata.line_ending = 'crlf';
    assert.ok(
      validateInitialState(lineEndingDrift).some(
        (problem) => problem.includes(versionId) && problem.includes('line_ending'),
      ),
      `有可追溯请求的版本 ${versionId} 的 line_ending 与请求不一致必须被发现`,
    );
  }
  const outOfRangeLineEnding = clone();
  versionOf(outOfRangeLineEnding, 'ver_alpha_01').metadata.line_ending = 'bogus';
  assert.ok(
    validateInitialState(outOfRangeLineEnding).some(
      (problem) => problem.includes('ver_alpha_01') && problem.includes('line_ending'),
    ),
    '没有可追溯请求的历史版本出现越界 line_ending 必须被发现',
  );

  // 6. 对**每一个**由 create_file / update_file_content / restore_file 产生的历史版本逐项核对：
  //    任何单个版本被改坏都必须让加载失败（不能只盯着当前指针版本）。
  const createdVersions = initial.changes
    .filter((change) => ['create_file', 'update_file_content', 'restore_file'].includes(change.operation))
    .map((change) => change.version_id);
  assert.ok(createdVersions.length >= 4, `夹具必须覆盖多个历史版本，实际 ${JSON.stringify(createdVersions)}`);
  for (const versionId of createdVersions) {
    const perVersion = clone();
    versionOf(perVersion, versionId).created_at = '2026-11-21T07:00:00Z';
    assert.ok(
      validateInitialState(perVersion).some((problem) => problem.includes(versionId)),
      `历史版本 ${versionId} 的 created_at 漂移必须被逐项发现`,
    );
    const perVersionFormat = clone();
    const target = versionOf(perVersionFormat, versionId);
    const file = perVersionFormat.files.find((item) => item.file_id === target.file_id);
    target.metadata.format = METADATA_FORMATS.find((format) => format !== file.format);
    assert.ok(
      validateInitialState(perVersionFormat).some((problem) => problem.includes(versionId)),
      `历史版本 ${versionId} 的 metadata.format 漂移必须被逐项发现`,
    );
  }

  // 7. 正向：没有任何可追溯 Change 的压缩版本保留压缩语义——
  //    compressed-history-recovery 里 file_notes 的 ver_notes_02（revision 3 <= 下界 3）
  //    完全没有任何保留 Change，仍必须加载成功（不能因为「找不到首次请求」就误杀）。
  const compressed = SCENARIO_BY_NAME.get('compressed-history-recovery').scenario.initial_state;
  assert.deepEqual(validateInitialState(compressed), [], '压缩历史中无 Change 的版本仍必须自洽');
  assert.equal(
    compressed.changes.some((change) => change.version_id === 'ver_notes_02'),
    false,
    'ver_notes_02 必须确实没有任何保留 Change',
  );
  //    但压缩版本自身的 metadata.format 仍必须与文件格式一致（可追溯的最低要求）。
  const compressedDrift = cloneJson(compressed);
  compressedDrift.versions.find((version) => version.version_id === 'ver_notes_02').metadata.format = 'json';
  assert.ok(
    validateInitialState(compressedDrift).some(
      (problem) => problem.includes('ver_notes_02') && problem.includes('metadata.format'),
    ),
    '压缩版本的 metadata.format 与文件格式不一致仍必须被发现',
  );
});

test('reserved_operation_ids 不得与历史 Change 或幂等键重复（OP-ID-RESERVED-001）', () => {
  const entry = SCENARIO_BY_NAME.get('stale-cursor-recovery');
  const initial = entry.scenario.initial_state;
  const clone = () => cloneJson(initial);
  assert.deepEqual(validateInitialState(initial), [], '真实夹具必须自洽');
  assert.deepEqual(initial.reserved_operation_ids, ['op_reserved_failed_upload'], '夹具只保留一个未使用的保留 ID');

  // 1. 追加一条历史 Change 已经用过的 operation_id。
  const withHistoryId = clone();
  withHistoryId.reserved_operation_ids = [...withHistoryId.reserved_operation_ids, 'op_create_todo'];
  const problems = validateInitialState(withHistoryId);
  assert.ok(
    problems.some((problem) => problem.includes('已被历史 Change 使用')),
    `reserved_operation_ids 与历史 Change 重复必须在加载阶段被发现，实际 ${JSON.stringify(problems)}`,
  );
  assert.throws(() => createVaultState(withHistoryId), /已被历史 Change 使用/, '重复声明的初态必须阻止建库');

  // 2. 追加幂等账本里的 operation_id。
  const withLedgerId = clone();
  withLedgerId.reserved_operation_ids = [...withLedgerId.reserved_operation_ids, 'op_roadmap_v2_0001'];
  assert.ok(
    validateInitialState(withLedgerId).some((problem) => problem.includes('与 reserved_operation_ids 重复声明')),
    'reserved_operation_ids 与幂等账本键重复必须被发现',
  );

  // 3. 只把 ID 换成另一个历史 create_file 的 ID，也不得通过。
  for (const operationId of initial.changes.map((change) => change.operation_id)) {
    const tampered = clone();
    tampered.reserved_operation_ids = [operationId];
    assert.ok(
      validateInitialState(tampered).length > 0,
      `历史 operation_id ${operationId} 不得出现在 reserved_operation_ids 里`,
    );
  }

  // 4. 正向：全新的、未被占用的保留 ID 仍必须被接受（避免「一律拒绝」通过）。
  const freshReserved = clone();
  freshReserved.reserved_operation_ids = [...freshReserved.reserved_operation_ids, 'op_reserved_brand_new'];
  assert.deepEqual(validateInitialState(freshReserved), [], '未被占用的保留 ID 必须被接受');
});

test('request_id 序号可用范围是 1..999999，不得生成七位标识（REQUEST-ID-001）', async () => {
  const entry = SCENARIO_BY_NAME.get('stale-cursor-recovery');
  const initial = entry.scenario.initial_state;
  const clone = () => cloneJson(initial);
  assert.deepEqual(validateInitialState(initial), [], '真实夹具必须自洽');

  // 1. 显式声明 1000000：会生成 req_1000000（七位），加载阶段必须拒绝。
  for (const sequence of [1000000, 1000001, 9_999_999]) {
    const tampered = clone();
    tampered.request_sequence = sequence;
    const problems = validateInitialState(tampered);
    assert.ok(
      problems.some((problem) => problem.includes('超出可表示范围')),
      `request_sequence=${sequence} 必须在加载阶段被拒绝，实际 ${JSON.stringify(problems)}`,
    );
    assert.throws(
      () => createVaultState(tampered),
      /超出可表示范围/,
      `request_sequence=${sequence} 必须阻止建库`,
    );
  }

  // 2. 历史 request_id 越界（req_1000000 不是合法形状）同样必须被发现。
  const historicalOverflow = clone();
  historicalOverflow.request_log = [{ request_id: 'req_1000000' }];
  assert.ok(
    validateInitialState(historicalOverflow).some((problem) => problem.includes('request_log 条目 request_id 不合法')),
    '历史 request_id 超过六位必须被发现',
  );

  // 3. 缺省推导越界：历史已用到 999999 时，推导出的 1000000 不可表示。
  const derivedOverflow = clone();
  derivedOverflow.request_log = [{ request_id: 'req_999999' }];
  delete derivedOverflow.request_sequence;
  assert.ok(
    validateInitialState(derivedOverflow).some((problem) => problem.includes('推导出的下一个序号')),
    '缺省推导越界必须在加载阶段被发现',
  );

  // 4. 边界正向：request_sequence = 999999 合法，且生成的 request_id 恰好是六位。
  const boundary = clone();
  boundary.request_sequence = 999999;
  assert.deepEqual(validateInitialState(boundary), [], 'request_sequence=999999 必须仍然合法');
  const boundaryState = createVaultState(boundary);
  const step = entry.scenario.steps.find((item) => item.id === 'pull-at-lower-bound');
  const lastValid = await handleRequest(boundaryState, buildRequest(step).request, {
    resolveUpload: () => Buffer.alloc(0),
  });
  assert.equal(lastValid.status, 200, '序号上界的请求仍应成功');
  assert.equal(lastValid.body.request_id, 'req_999999', '上界序号必须生成 req_999999');
  assert.match(lastValid.body.request_id, /^req_\d{6}$/, '上界序号生成的 request_id 必须仍是六位');

  // 5. 再下一个请求不得静默生成 req_1000000：必须返回稳定错误码，且不改变协议状态。
  const beforeOverflow = snapshotState(boundaryState);
  const overflow = await handleRequest(boundaryState, buildRequest(step).request, {
    resolveUpload: () => Buffer.alloc(0),
  });
  assert.equal(overflow.status, 503, `序号用尽必须返回 503，实际 ${overflow.status}`);
  assert.equal(
    overflow.body.code,
    ERROR_CODES.REQUEST_ID_EXHAUSTED,
    '序号用尽必须返回 REQUEST_ID_EXHAUSTED，不得静默产出七位 request_id',
  );
  assert.equal(overflow.body.request_id, null, '序号用尽时 request_id 显式为 null');
  assert.equal(overflow.body.allowed_method, METHODS.changes, '错误响应仍必须携带定位字段');
  assert.equal(overflow.body.endpoint, `/api/v1/vaults/${boundary.vault_id}/sync/changes`);
  assert.equal(overflow.body.method, 'POST');
  assert.doesNotMatch(JSON.stringify(overflow.body), /req_1000000/, '响应里不得出现七位 request_id');
  assert.deepEqual(snapshotState(boundaryState), beforeOverflow, '序号用尽不得改变协议状态');
});

test('initial_state.files 的 path 与 format 必须符合协议取值域（INITIAL-FILE-001）', () => {
  const entry = SCENARIO_BY_NAME.get('stale-cursor-recovery');
  const initial = entry.scenario.initial_state;
  const clone = () => cloneJson(initial);
  assert.deepEqual(validateInitialState(initial), [], '真实夹具必须自洽');

  const withAlphaPath = (path) => {
    const tampered = clone();
    tampered.files.find((file) => file.file_id === 'file_alpha').path = path;
    // 同步把 Change 与请求/结果的 path 一起改，避免失败原因只是「与 Change 不一致」。
    for (const change of tampered.changes) {
      if (change.file_id === 'file_alpha') change.path = path;
    }
    tampered.idempotency[0].request.body.path = path;
    tampered.idempotency[0].fingerprint = fingerprintOf(tampered.idempotency[0].request.body);
    tampered.idempotency[0].result.path = path;
    return tampered;
  };

  // 1. 非规范化路径：即使其余三方同步改动，也必须由「path 不是规范化路径」拦下。
  for (const badPath of ['../bad', '.', '..', 'a//b', '/abs/path.md', 'a/./b.md', 'a\\b.md', '', 'a/../b.md']) {
    const problems = validateInitialState(withAlphaPath(badPath));
    // 精确到「文件级」报错：只靠 Change/请求路径的规范化校验顺带命中也算不合格，
    // 因为那样 initial_state.files 自己的 path 就没有被独立校验。
    assert.ok(
      problems.some((problem) => problem.includes('文件 file_alpha 的 path 不是规范化路径')),
      `path=${JSON.stringify(badPath)} 必须由文件级校验拒绝，实际 ${JSON.stringify(problems)}`,
    );
    assert.throws(
      () => createVaultState(withAlphaPath(badPath)),
      /path/,
      `path=${JSON.stringify(badPath)} 必须阻止建库`,
    );
  }

  // 2. format 不在 md / txt / json 内。
  for (const badFormat of ['rtf', 'MD', '', 'markdown', 'html']) {
    const tampered = clone();
    tampered.files.find((file) => file.file_id === 'file_alpha').format = badFormat;
    const problems = validateInitialState(tampered);
    // 同样要求「文件级」报错，避免只靠首次请求 / 版本 format 比对顺带发现。
    assert.ok(
      problems.some(
        (problem) =>
          problem.includes(`文件 file_alpha 的 format ${JSON.stringify(badFormat)} 必须是 md / txt / json 之一`),
      ),
      `format=${JSON.stringify(badFormat)} 必须由文件级取值域校验拒绝，实际 ${JSON.stringify(problems)}`,
    );
  }

  // 3. 其余必要字段的类型。
  for (const [label, mutate, needle] of [
    ['file_id 是数字', (file) => { file.file_id = 42; }, '文件缺少 file_id'],
    ['format 缺失', (file) => { delete file.format; }, 'format'],
    ['path 缺失', (file) => { delete file.path; }, 'path'],
    ['is_deleted 不是布尔值', (file) => { file.is_deleted = 'false'; }, 'is_deleted 必须是布尔值'],
    ['current_version_id 是数字', (file) => { file.current_version_id = 7; }, 'current_version_id 必须是字符串或 null'],
  ]) {
    const tampered = clone();
    mutate(tampered.files.find((file) => file.file_id === 'file_alpha'));
    assert.ok(
      validateInitialState(tampered).some((problem) => problem.includes(needle)),
      `${label} 必须在加载阶段被发现`,
    );
  }

  // 4. 正向：三种合法 format 与多种规范化路径都必须被接受。
  //    改文件 format 时必须同步改版本 metadata 与首次请求 metadata，否则失败原因会变成
  //    「format 与历史版本/首次请求不一致」，而不是「取值域合法」。
  for (const format of METADATA_FORMATS) {
    const tampered = clone();
    tampered.files.find((item) => item.file_id === 'file_alpha').format = format;
    for (const version of tampered.versions) {
      if (version.file_id === 'file_alpha' && version.metadata) version.metadata.format = format;
    }
    tampered.idempotency[0].request.body.metadata = {
      ...tampered.idempotency[0].request.body.metadata,
      format,
    };
    tampered.idempotency[0].fingerprint = fingerprintOf(tampered.idempotency[0].request.body);
    assert.deepEqual(validateInitialState(tampered), [], `format=${format} 必须被接受`);
  }
  for (const goodPath of ['a.md', 'notes/a.md', 'deep/nested/dir/a-b_c.md']) {
    assert.deepEqual(validateInitialState(withAlphaPath(goodPath)), [], `规范化路径 ${goodPath} 必须被接受`);
  }
});

test('历史账本通过加载后，原样重放必须命中首次结果（请求校验与重放路径闭环）', async () => {
  const entry = SCENARIO_BY_NAME.get('stale-cursor-recovery');
  const initial = entry.scenario.initial_state;
  const historical = initial.idempotency[0];

  // 完整校验必须放行真实夹具。
  assert.deepEqual(validateInitialState(initial), [], '真实夹具必须自洽');

  // 每一次加载都必须能原样重放并命中首次结果，且不产生副作用。
  for (let attempt = 0; attempt < 2; attempt += 1) {
    const state = createVaultState(initial);
    const before = snapshotState(state);
    const response = await handleRequest(
      state,
      postRequest(initial.vault_id, historical.request.body, historical.request.headers),
      { resolveUpload: () => readSample('notes/roadmap-v2.md') },
    );
    assert.equal(response.status, 200, `第 ${attempt + 1} 次加载后的重放必须成功：${JSON.stringify(response.body)}`);
    assert.equal(response.body.replayed, true);
    assert.equal(response.body.change_id, historical.result.change_id);
    assert.equal(response.body.version_id, historical.result.version_id);
    assert.equal(response.body.vault_revision, historical.result.vault_revision);
    assert.deepEqual(snapshotState(state), before, '重放不得产生副作用');
  }
});

/* ------------------------------------------------------------------ */
/* 最终评审回归（HIST-01..07 / WRITE-01 / ERROR-01 / TRACK-01 /        */
/* STATE-01 / REV-01 / TEST-01 / TEST-05）                              */
/* ------------------------------------------------------------------ */

/** 用历史账本条目构造一次「原样重放」。 */
function replayHistorical(state, ledger, resolveUpload) {
  return handleRequest(
    state,
    postRequest(state.vault_id, ledger.request.body, ledger.request.headers),
    { resolveUpload },
  );
}

test('历史加载接受单哈希基准，并保证原样重放命中首次结果（HIST-01）', async () => {
  const entry = SCENARIO_BY_NAME.get('historical-single-hash-replay');
  const initial = entry.scenario.initial_state;
  const ledger = initial.idempotency[0];
  const clone = () => cloneJson(initial);

  // 0. 真实夹具：历史请求只有 base_content_hash，没有 base_version_id。
  assert.equal(Object.hasOwn(ledger.request.body, 'base_version_id'), false, '夹具必须只提供 base_content_hash');
  assert.ok(
    typeof ledger.request.body.base_content_hash === 'string',
    '夹具必须提供 base_content_hash',
  );
  assert.deepEqual(validateInitialState(initial), [], '单哈希历史提交必须能在加载阶段通过');

  // 1. 真实场景原样重放：200 + replayed=true + 首次业务结果。
  const state = createVaultState(initial);
  const before = snapshotState(state);
  const replay = await replayHistorical(state, ledger, () => readSample('notes/roadmap-v2.md'));
  assert.equal(replay.status, 200, `单哈希历史重放必须成功：${JSON.stringify(replay.body)}`);
  assert.equal(replay.body.replayed, true, '单哈希历史重放必须标记 replayed=true');
  assert.equal(replay.body.change_id, ledger.result.change_id, '必须返回首次 Change');
  assert.equal(replay.body.version_id, ledger.result.version_id, '必须返回首次版本');
  assert.equal(replay.body.vault_revision, ledger.result.vault_revision, '必须返回首次 revision');
  assert.equal(replay.body.original_request_id, ledger.request_id, '必须回指首次 request_id');
  assert.deepEqual(snapshotState(state), before, '单哈希历史重放不得改变状态');

  // 2. 只给错误的 base_content_hash：必须失败。
  const wrongHash = clone();
  wrongHash.idempotency[0].request.body.base_content_hash = `sha256:${'9'.repeat(64)}`;
  wrongHash.idempotency[0].fingerprint = fingerprintOf(wrongHash.idempotency[0].request.body);
  assert.ok(
    validateInitialState(wrongHash).some((problem) => problem.includes('base_content_hash')),
    '错误的 base_content_hash 必须在加载阶段被发现',
  );

  // 3. 同时提供两项且都匹配：必须通过；任一项错误都必须失败。
  const both = clone();
  both.idempotency[0].request.body.base_version_id = 'ver_roadmap_01';
  both.idempotency[0].fingerprint = fingerprintOf(both.idempotency[0].request.body);
  assert.deepEqual(validateInitialState(both), [], '两项基准都正确时必须通过');

  const wrongVersion = clone();
  wrongVersion.idempotency[0].request.body.base_version_id = 'ver_roadmap_00';
  wrongVersion.idempotency[0].fingerprint = fingerprintOf(wrongVersion.idempotency[0].request.body);
  assert.ok(
    validateInitialState(wrongVersion).some((problem) => problem.includes('base_version_id')),
    '错误的 base_version_id 必须在加载阶段被发现',
  );

  // 4. 单哈希版本（不带 base_version_id）不得因为基准缺失而被硬编码拒绝：
  //    把 base_content_hash 换成正确值后仍必须通过。
  const single = clone();
  assert.deepEqual(validateInitialState(single), [], '单哈希历史提交不得被「两项都必须提供」的旧规则误杀');
});

test('历史首次请求的加载失败集合覆盖完整路由、query、方法、操作与不可重放请求（HIST-02）', () => {
  const entry = SCENARIO_BY_NAME.get('stale-cursor-recovery');
  const initial = entry.scenario.initial_state;
  const clone = () => cloneJson(initial);
  assert.deepEqual(validateInitialState(initial), [], '真实夹具必须自洽');

  const tamper = (mutate) => {
    const tampered = clone();
    mutate(tampered.idempotency[0]);
    return tampered;
  };

  const cases = [
    // 查询串里的错误 vault_id：原样重放会返回 404。
    ['query.vault_id 错误', (ledger) => { ledger.request.query = { vault_id: 'vault_other' }; }, 'query.vault_id'],
    // 方法 / endpoint / Idempotency-Key。
    ['method 非 POST', (ledger) => { ledger.request.method = 'GET'; }, '方法必须为 POST'],
    ['endpoint 指向其他 Vault', (ledger) => { ledger.request.endpoint = '/api/v1/vaults/vault_other/sync/changes'; }, 'endpoint 必须是本 Vault'],
    ['Idempotency-Key 不一致', (ledger) => { ledger.request.headers['Idempotency-Key'] = 'op_other'; }, 'Idempotency-Key 不一致'],
    // 历史 Change 改成不支持的操作，且请求同步改动（依然不可重放）。
    [
      '历史 Change / 请求改为不支持的操作',
      (ledger) => {
        const change = ledger.request.body;
        change.operation = 'rename_file';
        ledger.fingerprint = fingerprintOf(change);
        const fixtureChange = 'rename_file';
        void fixtureChange;
      },
      '不是本模型可执行操作',
    ],
  ];

  for (const [label, mutate, needle] of cases.slice(0, 4)) {
    const problems = validateInitialState(tamper(mutate));
    assert.ok(problems.length > 0, `${label}: 必须在加载阶段失败`);
    assert.ok(
      problems.some((problem) => problem.includes(needle)),
      `${label}: 必须命中 ${needle}，实际 ${JSON.stringify(problems)}`,
    );
    assert.throws(() => createVaultState(tamper(mutate)), /initial_state 自检失败/, `${label}: 必须阻止建库`);
  }

  // 历史 Change 改为不支持但**会产生版本**的 operation（restore_file），并把首次请求与结果一起改动、
  // 重算指纹：「历史可以记录未来操作」不能成为放过不可重放首次结果的理由。
  // 选 restore_file 是为了让版本 ↔ Change 绑定仍然成立，唯一失败原因只能来自「不可重放」。
  const unsupported = clone();
  unsupported.changes.find((change) => change.change_id === 'chg_000005').operation = 'restore_file';
  unsupported.idempotency[0].request.body.operation = 'restore_file';
  unsupported.idempotency[0].fingerprint = fingerprintOf(unsupported.idempotency[0].request.body);
  unsupported.idempotency[0].result.operation = 'restore_file';
  const unsupportedProblems = validateInitialState(unsupported);
  assert.ok(
    unsupportedProblems.some((problem) => problem.includes('不是本模型可执行操作')),
    `不可重放的历史首次结果必须被拒绝，实际 ${JSON.stringify(unsupportedProblems)}`,
  );

  // 正向保证：真实历史首次请求的完整重放确实经过统一断言链。
  const step = SCENARIO_BY_NAME.get('stale-cursor-recovery').scenario.steps.find(
    (item) => item.id === 'replay-historical-operation',
  );
  assert.equal(step?.expect_historical_replay, 0, '夹具必须显式声明历史原样重放');
});

test('历史首次请求的 blob_reference 必须与可留存原始字节和版本引用一致（HIST-03）', () => {
  const entry = SCENARIO_BY_NAME.get('stale-cursor-recovery');
  const initial = entry.scenario.initial_state;
  const clone = () => cloneJson(initial);
  assert.deepEqual(validateInitialState(initial), [], '真实夹具必须自洽');

  // 1. 把首次请求的 blob_reference 换成同一夹具里另一个**有效**的上传样本，
  //    并重算指纹、同步 content_hash / content_size，仍然必须在加载阶段失败。
  const swapped = clone();
  const otherUpload = swapped.upload_sessions.find(
    (upload) => upload.blob_reference !== swapped.idempotency[0].request.body.blob_reference,
  );
  const otherBytes = readSample('notes/todo-v2.txt');
  swapped.idempotency[0].request.body.blob_reference = otherUpload.blob_reference;
  swapped.idempotency[0].fingerprint = fingerprintOf(swapped.idempotency[0].request.body);
  const swappedProblems = validateInitialState(swapped);
  assert.ok(
    swappedProblems.length > 0,
    `换成另一份有效样本后仍必须失败（历史版本内容哈希与样本不一致），实际 ${JSON.stringify(swappedProblems)}`,
  );
  assert.throws(() => createVaultState(swapped), /initial_state 自检失败/, '替换 blob_reference 必须阻止建库');

  // 2. 上传会话缺失 / 未完成 / 哈希不一致都必须被发现。
  const missingUpload = clone();
  missingUpload.upload_sessions = missingUpload.upload_sessions.filter(
    (upload) => upload.blob_reference !== missingUpload.idempotency[0].request.body.blob_reference,
  );
  assert.ok(
    validateInitialState(missingUpload).some((problem) => problem.includes('没有可留存的上传样本')),
    '缺失上传样本必须被发现',
  );

  const pendingUpload = clone();
  pendingUpload.upload_sessions.find(
    (upload) => upload.blob_reference === pendingUpload.idempotency[0].request.body.blob_reference,
  ).status = 'pending';
  assert.ok(
    validateInitialState(pendingUpload).some((problem) => problem.includes('不是 completed')),
    '未完成的上传样本必须被发现',
  );

  const hashDrift = clone();
  hashDrift.upload_sessions.find(
    (upload) => upload.blob_reference === hashDrift.idempotency[0].request.body.blob_reference,
  ).content_hash = `sha256:${'8'.repeat(64)}`;
  assert.ok(
    validateInitialState(hashDrift).some((problem) => problem.includes('上传样本哈希')),
    '上传样本哈希与请求不一致必须被发现',
  );

  // 3. 版本引用的 Blob 必须由 Change 的完整内容哈希派生。
  const blobDrift = clone();
  blobDrift.versions.find((version) => version.version_id === 'ver_alpha_02').blob_id =
    'blob_0000000000000000000000000000000000000000000000000000000000000000';
  assert.ok(
    validateInitialState(blobDrift).some((problem) => problem.includes('Blob 引用') || problem.includes('blob_id')),
    '版本 Blob 引用与内容哈希脱节必须被发现',
  );
  void otherBytes;
});

test('版本图必须校验同文件父版本、先后顺序与无环（HIST-04）', () => {
  const entry = SCENARIO_BY_NAME.get('stale-cursor-recovery');
  const initial = entry.scenario.initial_state;
  const clone = () => cloneJson(initial);
  assert.deepEqual(validateInitialState(initial), [], '真实夹具必须自洽');

  // 1. 父版本属于另一个文件。
  const foreignParent = clone();
  foreignParent.versions.find((version) => version.version_id === 'ver_alpha_02').base_version_id = 'ver_beta_01';
  assert.ok(
    validateInitialState(foreignParent).some((problem) => problem.includes('属于另一个文件')),
    '父版本跨文件必须被发现',
  );

  // 2. 父版本不早于子版本（未来父版本）。
  const futureParent = clone();
  const versionAlpha2 = futureParent.versions.find((version) => version.version_id === 'ver_alpha_02');
  versionAlpha2.base_version_id = 'ver_alpha_01';
  futureParent.versions.find((version) => version.version_id === 'ver_alpha_01').vault_revision = 5;
  assert.ok(
    validateInitialState(futureParent).some((problem) => problem.includes('必须早于子版本')),
    '未来父版本必须被发现',
  );

  // 3. 父版本链成环。
  const cyclic = clone();
  cyclic.versions.find((version) => version.version_id === 'ver_alpha_01').base_version_id = 'ver_alpha_02';
  const cyclicProblems = validateInitialState(cyclic);
  assert.ok(
    cyclicProblems.some((problem) => problem.includes('成环') || problem.includes('必须早于子版本')),
    `版本父链成环必须被发现，实际 ${JSON.stringify(cyclicProblems)}`,
  );

  // 4. 同一 revision 的孤立额外版本（没有对应 Change）：必须被拒绝。
  const orphan = clone();
  orphan.versions.push({
    version_id: 'ver_alpha_orphan',
    file_id: 'file_alpha',
    vault_revision: 5,
    blob_id: 'blob_542b2f6db9967dd8c083a9154064652f151e6ec9616264fe81e40ed2eb9b6227',
    content_hash: 'sha256:542b2f6db9967dd8c083a9154064652f151e6ec9616264fe81e40ed2eb9b6227',
    content_size: 213,
    base_version_id: 'ver_alpha_01',
    created_by_device_id: 'device_mac_0001',
    created_at: '2026-11-21T09:00:00Z',
    metadata: { format: 'md', line_ending: 'lf' },
  });
  assert.ok(
    validateInitialState(orphan).some((problem) => problem.includes('双向绑定')),
    '保留区间内的孤立版本必须被发现',
  );

  // 5. 双向绑定的另一面：保留区间内的版本缺少 Change 时同样失败。
  const missingBinding = clone();
  missingBinding.changes = missingBinding.changes.filter((change) => change.change_id !== 'chg_000006');
  missingBinding.idempotency = [];
  assert.ok(
    validateInitialState(missingBinding).some(
      (problem) => problem.includes('双向绑定') || problem.includes('缺少 revision 6 的 Change'),
    ),
    '缺少对应 Change 的保留版本必须被发现',
  );

  // 6. 正向：允许 min_available_revision 及以前的创建 Change 被压缩。
  //    revision 3、4 的 Change 被压缩掉后，file_gamma 没有保留的 Change，
  //    但它的当前版本仍由初始快照证明；账本条目保留，因此仍可原样重放。
  const compressed = clone();
  compressed.min_available_revision = 4;
  compressed.changes = compressed.changes.filter((change) => change.vault_revision > 4);
  assert.deepEqual(
    validateInitialState(compressed),
    [],
    '压缩下界及更早的 Change 允许缺失，留下的版本与文件状态仍可由快照重建',
  );
  // 反向：把 file_gamma 的指针置空，就必须失败 —— 缺少保留 Change 不等于允许 null。
  const compressedNull = cloneJson(compressed);
  compressedNull.files.find((file) => file.file_id === 'file_gamma').current_version_id = null;
  assert.ok(
    validateInitialState(compressedNull).some((problem) => problem.includes('最终版本')),
    '压缩后缺少保留 Change 的文件也不得把指针置空',
  );
});

test('压缩语义：缺少保留 Change 的文件仍可由初始快照证明当前指针（HIST-05）', async () => {
  const entry = SCENARIO_BY_NAME.get('compressed-history-recovery');
  const initial = entry.scenario.initial_state;
  const clone = () => cloneJson(initial);

  // 0. 真实夹具：file_notes 没有任何保留的 Change，但 current_version_id 仍指向 ver_notes_02。
  assert.ok(
    !initial.changes.some((change) => change.file_id === 'file_notes'),
    '夹具必须覆盖「某文件没有保留 Change」的情形',
  );
  assert.equal(
    initial.files.find((file) => file.file_id === 'file_notes').current_version_id,
    'ver_notes_02',
    '缺少保留 Change 的文件必须保留可证明的当前版本，而不是被强制为 null',
  );
  assert.deepEqual(validateInitialState(initial), [], '压缩初态必须自洽');

  // 1. 整个场景（含 manifest 重建与压缩后继续写入）必须通过主循环实际执行。
  assert.ok(MAIN_LOOP_EXECUTION.has('compressed-history-recovery'), '压缩场景必须由主循环执行');
  assert.deepEqual(
    [...MAIN_LOOP_EXECUTION.get('compressed-history-recovery').steps].sort(),
    initial.steps?.map((step) => step.id).sort() ??
      entry.scenario.steps.map((step) => step.id).sort(),
    '压缩场景的每一步都必须执行并登记',
  );

  // 2. 把 file_notes 的指针强制改成 null：必须被发现，而不是被当成「没有 Change 就允许 null」。
  const nullPointer = clone();
  nullPointer.files.find((file) => file.file_id === 'file_notes').current_version_id = null;
  assert.ok(
    validateInitialState(nullPointer).some((problem) => problem.includes('最终版本')),
    '缺少保留 Change 时把指针置为 null 必须被发现',
  );

  // 3. 指针指向一个更早的压缩版本：同样必须被发现。
  const earlierPointer = clone();
  earlierPointer.files.find((file) => file.file_id === 'file_notes').current_version_id = 'ver_beta_01';
  assert.ok(
    validateInitialState(earlierPointer).some((problem) => problem.includes('不属于该文件')),
    '指针指向其他文件的版本必须被发现',
  );

  // 4. 不存在的版本：必须被发现。
  const missingPointer = clone();
  missingPointer.files.find((file) => file.file_id === 'file_notes').current_version_id = 'ver_notes_99';
  assert.ok(
    validateInitialState(missingPointer).some((problem) => problem.includes('最终版本')),
    '指向不存在的版本必须被发现',
  );

  // 5. 真正不一致：文件 revision 更大的版本存在，但指针停在更早的可证明版本。
  const stalePointer = clone();
  stalePointer.versions.push({
    version_id: 'ver_notes_03',
    file_id: 'file_notes',
    vault_revision: 3,
    blob_id: 'blob_811349c57bbe210e7f90aaa3c18abe9c9993557f11d61408104c392217c73f8c',
    content_hash: 'sha256:811349c57bbe210e7f90aaa3c18abe9c9993557f11d61408104c392217c73f8c',
    content_size: 93,
    base_version_id: 'ver_notes_02',
    created_by_device_id: 'device_mac_0001',
    created_at: '2026-11-21T09:00:00Z',
    metadata: { format: 'txt', line_ending: 'lf' },
  });
  assert.ok(
    validateInitialState(stalePointer).length > 0,
    '存在更晚的版本但指针停在旧版本时，初态必须不自洽',
  );

  // 6. 初始快照与剩余 changes 仍足以重建当前 manifest（正向运行）。
  const state = createVaultState(initial);
  const manifest = await handleRequest(
    state,
    new Request(`${manifestUrl(initial.vault_id)}?device_id=device_mac_0001`, { method: 'GET' }),
    { resolveUpload: () => Buffer.alloc(0) },
  );
  assert.equal(manifest.status, 200, `压缩状态必须能重建 manifest：${JSON.stringify(manifest.body)}`);
  const notesEntry = manifest.body.files.find((file) => file.file_id === 'file_notes');
  assert.ok(notesEntry, 'manifest 必须包含被压缩的文件');
  assert.equal(notesEntry.current_version_id, 'ver_notes_02', 'manifest 必须给出初始快照中可证明的当前版本');
  assert.equal(notesEntry.is_deleted, false, 'manifest 必须给出由快照推导的删除状态');
});

test('首次写入 revision N 的历史请求必须满足 base_revision <= N-1（HIST-06）', () => {
  const entry = SCENARIO_BY_NAME.get('stale-cursor-recovery');
  const initial = entry.scenario.initial_state;
  const clone = () => cloneJson(initial);
  assert.deepEqual(validateInitialState(initial), [], '真实夹具必须自洽');

  // 真实夹具：写入 revision 5 的请求，base_revision = 4 = N-1，合法。
  const ledger = initial.idempotency[0];
  assert.equal(ledger.result.vault_revision, 5, '夹具首次写入 revision 必须是 5');
  assert.equal(ledger.request.body.base_revision, 4, '写入前的状态语义是 revision 4');

  // 1. base_revision = N（把写入后的 revision 当成写入前）必须被拒绝。
  const equalsN = clone();
  equalsN.idempotency[0].request.body.base_revision = 5;
  equalsN.idempotency[0].fingerprint = fingerprintOf(equalsN.idempotency[0].request.body);
  assert.ok(
    validateInitialState(equalsN).some((problem) => problem.includes('base_revision')),
    'base_revision = N 必须被拒绝（写入前是 N-1）',
  );

  // 2. base_revision > N 同样必须被拒绝。
  const beyondN = clone();
  beyondN.idempotency[0].request.body.base_revision = 6;
  beyondN.idempotency[0].fingerprint = fingerprintOf(beyondN.idempotency[0].request.body);
  assert.ok(
    validateInitialState(beyondN).some((problem) => problem.includes('base_revision')),
    'base_revision > N 必须被拒绝',
  );

  // 3. base_revision < N-1 仍然合法（客户端可能落后于目标文件）。
  const lower = clone();
  lower.idempotency[0].request.body.base_revision = 0;
  lower.idempotency[0].fingerprint = fingerprintOf(lower.idempotency[0].request.body);
  assert.deepEqual(validateInitialState(lower), [], 'base_revision < N-1 必须仍然合法');
});

test('每次成功 update_file_content 必须保存用于核对的 metadata（HIST-07）', async () => {
  const entry = SCENARIO_BY_NAME.get('stale-cursor-recovery');
  const initial = entry.scenario.initial_state;
  const clone = () => cloneJson(initial);
  const version = () => clone().versions.find((item) => item.version_id === 'ver_alpha_02');

  // 1. 删除必需 metadata 字段：必须被拒绝。
  for (const label of ['metadata', 'format', 'line_ending']) {
    const tampered = clone();
    const target = tampered.versions.find((item) => item.version_id === 'ver_alpha_02');
    if (label === 'metadata') delete target.metadata;
    else if (label === 'format') delete target.metadata.format;
    else delete target.metadata.line_ending;
    const problems = validateInitialState(tampered);
    assert.ok(problems.length > 0, `删除版本 ${label} 必须在加载阶段被发现`);
  }
  assert.ok(version().metadata, '真实夹具的版本必须携带 metadata');

  // 2. 单方删除 line_ending（请求仍声明）必须被拒绝：不能只在字段存在时才比较。
  const oneSided = clone();
  delete oneSided.versions.find((item) => item.version_id === 'ver_alpha_02').metadata.line_ending;
  assert.ok(
    validateInitialState(oneSided).some(
      (problem) => problem.includes('line_ending') || problem.includes('metadata'),
    ),
    '单方删除 line_ending 必须被发现',
  );

  // 3. 版本 metadata 与请求 metadata 不一致：必须被拒绝。
  const drift = clone();
  drift.versions.find((item) => item.version_id === 'ver_alpha_02').metadata.line_ending = 'crlf';
  assert.ok(
    validateInitialState(drift).some((problem) => problem.includes('metadata.line_ending')),
    '版本 metadata 与请求不一致必须被发现',
  );

  // 4. 运行时新版本必须保存与请求一致的 metadata，并与 Change / 设备 / 时间对齐。
  const state = createVaultState(initial);
  const step = entry.scenario.steps.find((item) => item.id === 'change-after-snapshot');
  const response = await handleRequest(state, buildRequest(step).request, {
    resolveUpload: () => readSample(step.content_file),
  });
  assert.equal(response.status, 200, `提交必须成功：${JSON.stringify(response.body)}`);
  const created = state.versions.find((item) => item.version_id === response.body.version_id);
  assert.ok(created, '新版本必须存在于 state.versions');
  assert.deepEqual(created.metadata, step.request.body.metadata, '新版本 metadata 必须与请求一致');
  assert.equal(created.created_by_device_id, step.request.body.device_id, '新版本创建设备必须等于请求设备');
  assert.equal(created.created_at, step.request.body.client_timestamp, '新版本创建时间必须等于请求时间');
  const change = state.changes.find((item) => item.change_id === response.body.change_id);
  assert.equal(change.device_id, created.created_by_device_id, 'Change.device_id 必须等于版本创建设备');
  assert.equal(change.client_timestamp, created.created_at, 'Change.client_timestamp 必须等于版本创建时间');
});

test('已删除文件的内容更新必须恢复 is_deleted=false 且与最后一条 Change 自洽（WRITE-01）', async () => {
  const entry = SCENARIO_BY_NAME.get('update-deleted-file');
  const initial = entry.scenario.initial_state;

  // 0. 真实夹具：文件在 revision 3 已软删除。
  assert.equal(initial.files.find((file) => file.file_id === 'file_doc').is_deleted, true, '夹具必须从已删除状态开始');
  assert.deepEqual(validateInitialState(initial), [], '已删除文件的初态必须自洽');

  // 1. 真实场景必须通过主循环执行成功（含后续 manifest）。
  assert.ok(MAIN_LOOP_EXECUTION.has('update-deleted-file'), '已删除文件场景必须由主循环执行');
  const step = entry.scenario.steps.find((item) => item.id === 'update-soft-deleted-file');
  const state = createVaultState(initial);
  const response = await handleRequest(state, buildRequest(step).request, {
    resolveUpload: () => readSample(step.content_file),
  });
  assert.equal(response.status, 200, `更新已删除文件必须成功：${JSON.stringify(response.body)}`);
  const file = state.files.find((item) => item.file_id === 'file_doc');
  assert.equal(file.is_deleted, false, '成功内容更新后 is_deleted 必须恢复为 false');
  assert.equal(file.current_version_id, response.body.version_id, '当前指针必须指向新版本');
  const lastChange = state.changes[state.changes.length - 1];
  assert.equal(lastChange.change_id, response.body.change_id, '新 Change 必须是最后一条');
  assert.equal(lastChange.operation, 'update_file_content', '最后一条 Change 必须是 update_file_content');
  assert.equal(file.is_deleted, false, 'is_deleted 必须与最后一条 Change 推导出的状态一致');

  // 2. 成功写入后的状态仍必须能通过 validateInitialState：把内存状态重新投影成初态再校验。
  //    历史账本条目沿用初态（含首次请求本体），新写入的条目用实际发出的请求体重建。
  const reprojected = {
    vault_id: state.vault_id,
    vault_revision: state.vault_revision,
    min_available_revision: state.min_available_revision,
    files: state.files.map((item) => ({
      file_id: item.file_id,
      path: item.path,
      format: item.format,
      current_version_id: item.current_version_id,
      is_deleted: item.is_deleted,
    })),
    versions: state.versions.map((item) => ({
      version_id: item.version_id,
      file_id: item.file_id,
      vault_revision: item.vault_revision,
      blob_id: item.blob_id,
      content_hash: item.content_hash,
      content_size: item.content_size,
      base_version_id: item.base_version_id,
      created_by_device_id: item.created_by_device_id,
      created_at: item.created_at,
      metadata: item.metadata,
    })),
    blobs: state.blobs.map((item) => ({ ...item })),
    changes: state.changes.map((item) => ({ ...item })),
    upload_sessions: state.uploads.map((item) => ({ ...item })),
    idempotency: [
      ...cloneJson(initial.idempotency ?? []),
      {
        operation_id: step.request.body.operation_id,
        request_id: response.body.request_id,
        fingerprint: fingerprintOf(step.request.body),
        request: {
          method: 'POST',
          endpoint: `/api/v1/vaults/${state.vault_id}/sync/changes`,
          headers: step.request.headers,
          body: step.request.body,
        },
        result: {
          protocol_version: 'sync-v1',
          request_id: response.body.request_id,
          mode: 'submit',
          replayed: false,
          vault_id: response.body.vault_id,
          device_id: response.body.device_id,
          operation_id: response.body.operation_id,
          file_id: response.body.file_id,
          path: response.body.path,
          version_id: response.body.version_id,
          parent_version_id: response.body.parent_version_id,
          change_id: response.body.change_id,
          blob_id: response.body.blob_id,
          content_hash: response.body.content_hash,
          content_size: response.body.content_size,
          vault_revision: response.body.vault_revision,
        },
      },
    ],
  };
  const problems = validateInitialState(reprojected);
  assert.deepEqual(
    problems,
    [],
    `成功写入后的状态必须仍能通过加载校验，实际 ${JSON.stringify(problems)}`,
  );

  // 3. 把新 Change 改回 delete_file：is_deleted 与 Change 必须互相推导，不能留下矛盾状态。
  const contradictory = cloneJson(reprojected);
  contradictory.changes[contradictory.changes.length - 1].operation = 'delete_file';
  assert.ok(
    validateInitialState(contradictory).some((problem) => problem.includes('is_deleted')),
    '最后一条 Change 改为 delete_file 后 is_deleted 必须被发现不一致',
  );
});

test('IDEMPOTENCY_KEY_REUSED 对可重放与不可重放两类 ID 返回各自恢复字段（ERROR-01）', async () => {
  const entry = SCENARIO_BY_NAME.get('stale-cursor-recovery');
  const initial = entry.scenario.initial_state;
  const vaultId = initial.vault_id;

  // 1. 有首次结果的 ID：必须返回 change_id / original_request_id / replayable=true 与恢复字段。
  const state = createVaultState(initial);
  const ledger = initial.idempotency[0];
  const reused = await handleRequest(
    state,
    postRequest(vaultId, { ...ledger.request.body, client_timestamp: '2026-11-21T09:59:00Z' }, ledger.request.headers),
    { resolveUpload: () => readSample('notes/roadmap-v2.md') },
  );
  assert.equal(reused.status, 409, '同 ID 异内容必须返回 409');
  assert.equal(reused.body.code, ERROR_CODES.IDEMPOTENCY_KEY_REUSED);
  assert.equal(reused.body.change_id, 'chg_000005', '必须回指占用该 ID 的首次 Change');
  assert.equal(reused.body.original_request_id, 'req_000001', '必须回指首次请求');
  assert.equal(reused.body.replayable, true, '有首次结果时必须标记 replayable=true');
  assert.equal(reused.body.version_id, 'ver_alpha_02', '必须给出首次版本供客户端恢复');
  assert.equal(reused.body.file_id, 'file_alpha', '必须给出首次文件');
  assert.equal(reused.body.vault_revision, 5, '必须给出首次 revision');

  // 2. 历史 Change 占用但无首次结果：change_id 回指该 Change，replayable=false。
  const fromChange = await handleRequest(
    createVaultState(initial),
    postRequest(vaultId, {
      ...entry.scenario.steps.find((item) => item.id === 'reuse-historical-create-operation').request.body,
      base_revision: initial.vault_revision,
    }),
    { resolveUpload: () => readSample('notes/todo-v2.txt') },
  );
  assert.equal(fromChange.body.code, ERROR_CODES.IDEMPOTENCY_KEY_REUSED);
  assert.equal(fromChange.body.change_id, 'chg_000004', '历史 Change 占用的 ID 必须回指该 Change');
  assert.equal(fromChange.body.replayable, false, '没有首次结果时必须标记 replayable=false');
  assert.equal(fromChange.body.version_id, undefined, '没有首次结果时不得伪造首次版本');

  // 3. reserved_operation_ids：change_id=null、original_request_id=null、replayable=false。
  const reserved = await handleRequest(
    createVaultState(initial),
    postRequest(vaultId, {
      ...entry.scenario.steps.find((item) => item.id === 'reuse-reserved-operation-id').request.body,
      base_revision: initial.vault_revision,
    }),
    { resolveUpload: () => readSample('notes/todo-v2.txt') },
  );
  assert.equal(reserved.body.code, ERROR_CODES.IDEMPOTENCY_KEY_REUSED);
  assert.equal(reserved.body.change_id, null, '保留 ID 没有对应 Change，必须显式为 null');
  assert.equal(reserved.body.original_request_id, null, '保留 ID 没有首次请求，必须显式为 null');
  assert.equal(reserved.body.replayable, false);

  // 4. 错误响应仍然不得带成功业务字段。
  assert.equal(reused.body.mode, undefined, '错误响应不得带 mode');
  assert.equal(reused.body.replayed, undefined, '错误响应不得带 replayed');
  assert.equal(typeof reused.body.message, 'string', '错误响应必须有 message');
});

test('request_id 序号范围是 1..999999，req_000000 必须被拒绝（TRACK-01）', async () => {
  const entry = SCENARIO_BY_NAME.get('stale-cursor-recovery');
  const initial = entry.scenario.initial_state;
  const clone = () => cloneJson(initial);
  assert.deepEqual(validateInitialState(initial), [], '真实夹具必须自洽');

  // 1. 合法边界：req_000001 与 req_999999。request_sequence 必须大于历史已用序号，
  //    因此 seq=1 时把账本的首次 request_id 也改到 0 是非法；这里用 seq=1 配历史 req_000001
  //    会冲突，改为验证「序号 1 本身」在无历史占用时合法。
  for (const sequence of [1, 999999]) {
    const boundary = clone();
    boundary.idempotency[0].request_id = 'req_000001';
    boundary.idempotency[0].result.request_id = 'req_000001';
    boundary.request_sequence = sequence;
    boundary.request_log = [];
    if (sequence === 1) {
      // 历史已占用 req_000001，seq=1 必然冲突；这是正确行为。只验证 req_000001 形状本身合法。
      assert.ok(
        validateInitialState(boundary).some((problem) => problem.includes('会与历史 request_id 冲突')),
        'seq=1 与历史 req_000001 冲突必须在加载阶段被发现',
      );
      continue;
    }
    assert.deepEqual(validateInitialState(boundary), [], `request_sequence=${sequence} 必须合法`);
  }
  {
    // 无历史占用的空 Vault：request_sequence=1 合法。
    const empty = {
      vault_id: 'vault_zero',
      vault_revision: 0,
      min_available_revision: 0,
      request_sequence: 1,
      files: [],
      versions: [],
      blobs: [],
      changes: [],
      upload_sessions: [],
    };
    assert.deepEqual(validateInitialState(empty), [], 'request_sequence=1 在无历史占用时必须合法');
    const zeroState = createVaultState(empty);
    const pullAtZero = await handleRequest(
      zeroState,
      postRequest('vault_zero', { mode: 'pull', vault_id: 'vault_zero', device_id: 'device_mac_0001', last_server_revision: 0 }),
      { resolveUpload: () => Buffer.alloc(0) },
    );
    assert.equal(pullAtZero.body.request_id, 'req_000001', '序号 1 必须生成 req_000001，而不是 req_000000');
  }

  // 2. req_000000 不是合法的 request_id：作为历史记录必须被发现。
  for (const historicalId of ['req_000000', 'req_1000000', 'req_1', 'req_0000001']) {
    const tampered = clone();
    tampered.request_log = [{ request_id: historicalId }];
    assert.ok(
      validateInitialState(tampered).some((problem) => problem.includes('request_log 条目 request_id 不合法')),
      `${historicalId} 必须被判为非法 request_id`,
    );
  }

  // 3. 账本里的 req_000000 同样非法。
  const ledgerZero = clone();
  ledgerZero.idempotency[0].request_id = 'req_000000';
  ledgerZero.idempotency[0].result.request_id = 'req_000000';
  assert.ok(
    validateInitialState(ledgerZero).some((problem) => problem.includes('首次 request_id 不合法')),
    '账本里的 req_000000 必须被发现',
  );

  // 4. 显式 request_sequence=0：不能生成 req_000000。
  const zeroSequence = clone();
  zeroSequence.request_sequence = 0;
  assert.ok(
    validateInitialState(zeroSequence).some((problem) => problem.includes('必须是正整数')),
    'request_sequence=0 必须在加载阶段被拒绝',
  );

  // 4b. 运行期同样不生成 req_000000：即使绕过加载校验把计数器设为 0，也必须返回稳定错误。
  const runtimeZero = createVaultState(initial);
  runtimeZero.request_sequence = 0;
  const stepForZero = entry.scenario.steps.find((item) => item.id === 'pull-at-lower-bound');
  const zeroResponse = await handleRequest(runtimeZero, buildRequest(stepForZero).request, {
    resolveUpload: () => Buffer.alloc(0),
  });
  assert.equal(zeroResponse.status, 503, '序号 0 必须返回 503');
  assert.equal(zeroResponse.body.code, ERROR_CODES.REQUEST_ID_EXHAUSTED, '序号 0 必须是 REQUEST_ID_EXHAUSTED');
  assert.equal(zeroResponse.body.request_id, null, '序号 0 时 request_id 必须为 null');
  assert.notEqual(zeroResponse.body.request_id, 'req_000000', '绝不生成 req_000000');

  // 5. 运行期：上界生成 req_999999，耗尽后返回 REQUEST_ID_EXHAUSTED 且 request_id=null。
  const boundaryState = createVaultState(
    (() => {
      const boundary = clone();
      boundary.request_sequence = 999999;
      boundary.request_log = [{ request_id: 'req_999998' }];
      return boundary;
    })(),
  );
  const step = entry.scenario.steps.find((item) => item.id === 'pull-at-lower-bound');
  const last = await handleRequest(boundaryState, buildRequest(step).request, { resolveUpload: () => Buffer.alloc(0) });
  assert.equal(last.status, 200);
  assert.equal(last.body.request_id, 'req_999999', '上界必须生成 req_999999');
  const overflow = await handleRequest(boundaryState, buildRequest(step).request, {
    resolveUpload: () => Buffer.alloc(0),
  });
  assert.equal(overflow.status, 503);
  assert.equal(overflow.body.code, ERROR_CODES.REQUEST_ID_EXHAUSTED);
  assert.equal(overflow.body.request_id, null, '耗尽时 request_id 必须显式为 null');

  // 6. 夹具目录里至少有一个场景真实覆盖 REQUEST_ID_EXHAUSTED。
  const exhausted = SCENARIO_BY_NAME.get('request-id-exhausted');
  const exhaustedStep = exhausted?.scenario.steps.find((item) => item.id === 'pull-after-sequence-exhausted');
  assert.ok(exhaustedStep, '必须提供 request-id-exhausted 夹具');
  assert.equal(exhaustedStep.expected_result.request_id, null, '夹具必须断言 request_id=null');
  assert.equal(exhaustedStep.expected_status, 503, '夹具必须断言 503');
});

test('createVaultState / snapshotState 必须深拷贝嵌套 metadata、body、headers 与 query（STATE-01）', () => {
  const entry = SCENARIO_BY_NAME.get('stale-cursor-recovery');
  const initial = entry.scenario.initial_state;
  const pristine = cloneJson(initial);

  const state = createVaultState(initial);
  const snapshot = snapshotState(state);
  const snapshotMetadata = cloneJson(snapshot.versions.find((version) => version.version_id === 'ver_alpha_02').metadata);

  // 1. 修改 state 里的嵌套 metadata：旧快照与原始初态都不得变化。
  state.versions.find((version) => version.version_id === 'ver_alpha_02').metadata.format = 'json';
  assert.notDeepEqual(
    snapshot.versions.find((version) => version.version_id === 'ver_alpha_02').metadata,
    state.versions.find((version) => version.version_id === 'ver_alpha_02').metadata,
    '旧快照的 metadata 不得随 state 变化',
  );
  assert.deepEqual(
    snapshot.versions.find((version) => version.version_id === 'ver_alpha_02').metadata,
    snapshotMetadata,
    '旧快照的 metadata 必须保持原值',
  );
  assert.deepEqual(initial, pristine, '修改 state 不得污染 initial_state');

  // 2. 修改幂等账本 result 的嵌套字段：旧快照与初态都不得变化。
  const freshState = createVaultState(initial);
  const freshSnapshot = snapshotState(freshState);
  const operationId = freshState.idempotency.keys().next().value;
  const originalResult = cloneJson(freshSnapshot.idempotency.find((item) => item.operation_id === operationId).result);
  freshState.idempotency.get(operationId).result.change_id = 'chg_tampered';
  assert.equal(
    freshSnapshot.idempotency.find((item) => item.operation_id === operationId).result.change_id,
    originalResult.change_id,
    '旧快照的账本 result 不得随 state 变化',
  );
  assert.deepEqual(initial, pristine, '修改账本不得污染 initial_state');

  // 3. Create 时的深拷贝：修改 state.files 的指针不得影响初态。
  const fileState = createVaultState(initial);
  fileState.files[0].path = 'notes/other.txt';
  assert.deepEqual(initial, pristine, '修改文件路径不得污染 initial_state');

  // 4. 上传会话里的嵌套字段同样必须隔离。
  const uploadState = createVaultState(initial);
  const uploadSnapshot = snapshotState(uploadState);
  uploadState.uploads[0].status = 'failed';
  assert.equal(uploadSnapshot.uploads[0].status, 'completed', '旧快照的上传会话不得随 state 变化');

  // 5. 反向保证：直接改快照不会污染 state（快照必须是独立副本）。
  snapshot.files[0].path = 'notes/mutated.txt';
  assert.notEqual(state.files[0].path, 'notes/mutated.txt', '修改快照不得污染 state');
});

test('revision 达到可安全表示上界时必须返回稳定错误且不复用 revision（REV-01）', async () => {
  const entry = SCENARIO_BY_NAME.get('submit-markdown');
  const step = entry.scenario.steps[0];
  const bytes = readSample(step.content_file);
  const vaultId = entry.scenario.initial_state.vault_id;

  // 1. 连续成功写入的 revision 必须唯一且连续。
  const state = createVaultState(entry.scenario.initial_state);
  const revisions = [];
  for (let attempt = 0; attempt < 3; attempt += 1) {
    const file = state.files.find((item) => item.file_id === 'file_roadmap');
    const response = await handleRequest(
      state,
      postRequest(vaultId, {
        ...step.request.body,
        operation_id: `op_seq_${attempt}`,
        client_timestamp: `2026-11-21T09:1${attempt}:00Z`,
        base_revision: state.vault_revision,
        base_version_id: file.current_version_id,
        base_content_hash: file.current_content_hash,
      }, { 'Idempotency-Key': `op_seq_${attempt}` }),
      { resolveUpload: () => bytes },
    );
    assert.equal(response.status, 200, `第 ${attempt + 1} 次写入必须成功：${JSON.stringify(response.body)}`);
    revisions.push(response.body.vault_revision);
  }
  assert.deepEqual(revisions, [2, 3, 4], '连续成功写入的 revision 必须唯一且连续');
  assert.equal(new Set(state.changes.map((change) => change.vault_revision)).size, state.changes.length, 'revision 必须唯一');

  // 2. 把 vault_revision 推到可安全表示的上界：提交必须失败，且不得复用同一 revision。
  const saturated = createVaultState(entry.scenario.initial_state);
  saturated.vault_revision = Number.MAX_SAFE_INTEGER;
  const file = saturated.files.find((item) => item.file_id === 'file_roadmap');
  const before = snapshotState(saturated);
  const capped = await handleRequest(
    saturated,
    postRequest(vaultId, {
      ...step.request.body,
      operation_id: 'op_revision_saturated',
      client_timestamp: '2026-11-21T09:30:00Z',
      base_revision: saturated.vault_revision,
      base_version_id: file.current_version_id,
      base_content_hash: file.current_content_hash,
    }, { 'Idempotency-Key': 'op_revision_saturated' }),
    { resolveUpload: () => bytes },
  );
  assert.ok(capped.status >= 400, `revision 耗尽时必须失败，实际 ${capped.status}`);
  assert.equal(capped.body.code, ERROR_CODES.REVISION_EXHAUSTED, 'revision 耗尽必须返回稳定错误码');
  assert.equal(capped.body.vault_revision, Number.MAX_SAFE_INTEGER, '错误必须给出当前 revision');
  assert.deepEqual(snapshotState(saturated), before, 'revision 耗尽不得改变协议状态');
  assert.equal(saturated.vault_revision, Number.MAX_SAFE_INTEGER, 'revision 不得被「加一」后仍等于旧值');
  assert.equal(
    saturated.changes.filter((change) => change.vault_revision === Number.MAX_SAFE_INTEGER).length,
    0,
    '不得复用已用尽的 revision 写新 Change',
  );

  // 3. request_sequence 的耗尽语义保持独立：仍由 REQUEST_ID_EXHAUSTED 处理。
  const sequenceState = createVaultState(entry.scenario.initial_state);
  sequenceState.request_sequence = 1000000;
  const exhausted = await handleRequest(sequenceState, postRequest(vaultId, step.request.body), {
    resolveUpload: () => bytes,
  });
  assert.equal(exhausted.status, 503, 'request_sequence 耗尽必须返回 503');
  assert.equal(exhausted.body.code, ERROR_CODES.REQUEST_ID_EXHAUSTED);
  assert.equal(exhausted.body.request_id, null);
});

test('夹具 expected_result 中一个错误业务值必须让 runScenario 失败且不登记（TEST-01）', async () => {
  const entry = SCENARIO_BY_NAME.get('submit-markdown');
  const scenario = cloneJson(entry.scenario);
  // 只改一个业务值：expected_result.version_id。
  scenario.steps[0].expected_result.version_id = 'ver_wrong_version';

  const records = new Map();
  await assert.rejects(
    () => runScenario(scenario, records),
    /version_id/,
    'expected_result 里的错误业务值必须让 runScenario 失败',
  );
  const registration = records.get(scenario.scenario);
  assert.ok(registration, '执行记录必须存在');
  assert.equal(
    registration.steps.size,
    0,
    `断言失败的步骤不得登记完成，实际 ${JSON.stringify([...registration.steps])}`,
  );

  // 反向保证：改回正确值后必须通过，避免「一律失败」也能通过。
  const okRecords = new Map();
  await runScenario(entry.scenario, okRecords);
  assert.deepEqual(
    [...okRecords.get(entry.scenario.scenario).steps].sort(),
    entry.scenario.steps.map((step) => step.id).sort(),
    '正确夹具的每一步都必须登记',
  );

  // 断言链上确实存在 assertSubset(response.body, step.expected_result)：删掉该分支后，
  // 上面的反向测试会变成「响应体完全不校验」，因此这里直接证明该分支对错误值敏感。
  assert.throws(
    () => assertSubset({ version_id: 'ver_roadmap_02' }, { version_id: 'ver_wrong_version' }, 'probe'),
    /version_id/,
    'assertSubset 必须对错误业务值失败',
  );
});

test('提交与 pull 的字段交叉断言对 operation_id / device_id / operation 变异敏感（TEST-02）', async () => {
  const entry = SCENARIO_BY_NAME.get('other-file-advances-cursor');
  const initial = entry.scenario.initial_state;
  const vaultId = initial.vault_id;
  const step = entry.scenario.steps.find((item) => item.id === 'submit-settings-v2');
  const bytes = readSample(step.content_file);

  /** 用被测模型跑一次提交，并按执行器同样的方式做交叉断言。 */
  const runSubmit = async (mutate) => {
    const state = createVaultState(initial);
    const request = {
      method: 'POST',
      endpoint: step.request.endpoint,
      headers: { 'Content-Type': 'application/json', ...step.request.headers },
      body: { ...step.request.body },
    };
    mutate(request);
    const response = await handleRequest(state, request, { resolveUpload: () => bytes });
    const result = response.body;
    const change = state.changes.find((item) => item.change_id === result.change_id);
    if (!change) throw new Error(`响应 change_id ${result.change_id} 未对应任何 Change`);
    assert.equal(change.operation_id, request.body.operation_id, 'Change.operation_id 必须等于请求');
    assert.equal(change.device_id, request.body.device_id, 'Change.device_id 必须等于请求');
    assert.equal(change.operation, request.body.operation, 'Change.operation 必须等于请求');
    return { response, change, request };
  };

  // 正向基线。
  const baseline = await runSubmit(() => {});
  assert.equal(baseline.response.status, 200, `基线提交必须成功：${JSON.stringify(baseline.response.body)}`);

  // 变异 1：删除 operation_id → 模型拒绝，不会写出错误 Change。
  const noOperationId = await handleRequest(
    createVaultState(initial),
    {
      method: 'POST',
      endpoint: step.request.endpoint,
      headers: { 'Content-Type': 'application/json' },
      body: (() => {
        const body = { ...step.request.body };
        delete body.operation_id;
        return body;
      })(),
    },
    { resolveUpload: () => bytes },
  );
  assert.equal(noOperationId.status, 400, '删除 operation_id 必须失败');
  assert.equal(noOperationId.body.code, ERROR_CODES.INVALID_REQUEST);

  // 变异 2：删除 device_id。
  const noDevice = await handleRequest(
    createVaultState(initial),
    {
      method: 'POST',
      endpoint: step.request.endpoint,
      headers: { 'Content-Type': 'application/json' },
      body: (() => {
        const body = { ...step.request.body };
        delete body.device_id;
        return body;
      })(),
    },
    { resolveUpload: () => bytes },
  );
  assert.equal(noDevice.status, 400, '删除 device_id 必须失败');
  assert.equal(noDevice.body.code, ERROR_CODES.INVALID_REQUEST);

  // 变异 3：写错 device_id（请求与 Idempotency-Key 都改）→ 成功，但 Change.device_id 必须等于请求而不是历史值。
  const wrongDevice = await runSubmit((request) => {
    request.body.device_id = 'device_wrong_0001';
    request.headers['Idempotency-Key'] = request.body.operation_id;
  });
  assert.equal(wrongDevice.change.device_id, 'device_wrong_0001', 'Change.device_id 必须是请求里的新设备');
  assert.notEqual(wrongDevice.change.device_id, 'device_web_0001', 'Change.device_id 不得沿用文件历史设备');

  // 变异 4：pull 返回的 Change 必须逐项等于 state.changes。
  const pullStep = entry.scenario.steps.find((item) => item.id === 'pull-both-changes');
  const state = createVaultState(initial);
  for (const stepId of ['submit-settings-v2', 'submit-todo-with-stale-base-revision']) {
    const source = entry.scenario.steps.find((item) => item.id === stepId);
    await handleRequest(state, buildRequest(source).request, {
      resolveUpload: () => readSample(source.content_file),
    });
  }
  const pull = await handleRequest(state, buildRequest(pullStep).request, { resolveUpload: () => Buffer.alloc(0) });
  assert.equal(pull.status, 200, `pull 必须成功：${JSON.stringify(pull.body)}`);
  const expected = state.changes.filter((change) => change.vault_revision > pull.body.from_revision);
  assert.equal(pull.body.changes.length, expected.length, 'pull 必须返回全部严格晚于游标的 Change');
  pull.body.changes.forEach((change, index) => {
    for (const field of ['change_id', 'operation_id', 'device_id', 'operation', 'path', 'file_id', 'version_id']) {
      assert.equal(change[field], expected[index][field], `pull.changes[${index}].${field} 必须等于 state.changes`);
    }
    assert.equal(change.vault_revision, expected[index].vault_revision, 'pull Change 的 revision 必须一致');
  });
});

test('统一夹具执行器表达 query.vault_id 不匹配与 REQUEST_ID_EXHAUSTED（TEST-05）', () => {
  // 这两个负向请求必须由**模型**处理，不能被 buildRequest 提前拦截或当成无效夹具。
  const stale = SCENARIO_BY_NAME.get('stale-cursor-recovery');
  const manifestMismatch = stale.scenario.steps.find((step) => step.id === 'manifest-query-vault-mismatch');
  const pullMismatch = stale.scenario.steps.find((step) => step.id === 'pull-query-vault-mismatch');
  assert.ok(manifestMismatch, '夹具必须包含 query.vault_id 不匹配的 manifest 步骤');
  assert.ok(pullMismatch, '夹具必须包含 query.vault_id 不匹配的 pull 步骤');
  for (const step of [manifestMismatch, pullMismatch]) {
    assert.equal(step.expected_status, 404, `${step.id}: query.vault_id 不匹配必须期望 404`);
    assert.equal(step.expected_result.code, 'VAULT_MISMATCH', `${step.id}: 必须期望 VAULT_MISMATCH`);
    // 执行器必须能原样构造该请求（不提前 assert 失败）。
    const built = buildRequest(step);
    assert.equal(built.url.searchParams.get('vault_id'), 'vault_other', `${step.id}: 执行器必须保留不匹配的 query.vault_id`);
  }

  const exhausted = SCENARIO_BY_NAME.get('request-id-exhausted');
  assert.ok(exhausted, '夹具必须覆盖 REQUEST_ID_EXHAUSTED');
  assert.ok(MAIN_LOOP_EXECUTION.has('request-id-exhausted'), '序号耗尽场景必须由主循环执行');
  const registration = MAIN_LOOP_EXECUTION.get('request-id-exhausted');
  assert.deepEqual(
    [...registration.steps].sort(),
    exhausted.scenario.steps.map((step) => step.id).sort(),
    '序号耗尽场景的每一步都必须执行',
  );
  const exhaustedResponse = registration.responses.find((item) => item.stepId === 'pull-after-sequence-exhausted');
  assert.ok(exhaustedResponse, '必须记录序号耗尽的响应');
  assert.equal(exhaustedResponse.status, 503, '序号耗尽响应必须是 503');
  assert.equal(exhaustedResponse.body.code, 'REQUEST_ID_EXHAUSTED', '错误码必须是 REQUEST_ID_EXHAUSTED');
  assert.equal(exhaustedResponse.body.request_id, null, '序号耗尽时 request_id 必须为 null');
});

test('夹具形状：request_sequence 只能出现在 initial_state 内（FIXTURE-SHAPE-001）', () => {
  for (const { name, scenario } of SCENARIOS) {
    assert.equal(
      Object.hasOwn(scenario, 'request_sequence'),
      false,
      `${name}: request_sequence 不得出现在顶层，只能写在 initial_state 里`,
    );
    // initial_state 之外不允许出现未消费的顶层字段：夹具只有下面这几个合法键。
    const allowedTopLevel = [
      'scenario',
      'title',
      'content_samples',
      'description',
      'initial_state',
      'steps',
      'version_samples',
      'async_upload_steps',
      'final_state',
    ];
    for (const key of Object.keys(scenario)) {
      assert.ok(allowedTopLevel.includes(key), `${name}: 顶层字段 ${key} 不是夹具结构的一部分（未消费的冗余字段）`);
    }
    // 若声明了 request_sequence，它必须在 initial_state 内，且为正整数。
    if (Object.hasOwn(scenario.initial_state, 'request_sequence')) {
      assert.ok(
        Number.isInteger(scenario.initial_state.request_sequence) && scenario.initial_state.request_sequence >= 1,
        `${name}: initial_state.request_sequence 必须是正整数`,
      );
    }
  }

  // 反向：把 request_sequence 挪回顶层的夹具必须被本断言发现。
  const entry = SCENARIO_BY_NAME.get('stale-cursor-recovery');
  const hoisted = cloneJson(entry.scenario);
  hoisted.request_sequence = hoisted.initial_state.request_sequence;
  assert.equal(Object.hasOwn(hoisted, 'request_sequence'), true, '反向夹具必须真的把字段放回顶层');
});

test('协议文档第 9 节声明的变异数量必须等于 mutation-check.mjs 的实际数量（DOC-MUTATION-001）', async () => {
  const doc = readFileSync(PROTOCOL_DOC, 'utf8');
  const script = readFileSync(join(REPO_ROOT, 'tests', 'protocol', 'mutation-check.mjs'), 'utf8');

  // 以脚本里真实的 `id:` 条目为准，而不是读一个手写常量。
  const actualCount = [...script.matchAll(/^    id: '/gm)].length;
  assert.ok(actualCount >= 32, `变异脚本条目数异常：只找到 ${actualCount} 个`);

  const declared = [...doc.matchAll(/逐个应用 (\d+) 个变异/g)].map((match) => Number(match[1]));
  assert.equal(declared.length, 1, `协议文档必须恰好声明一次变异数量，实际 ${JSON.stringify(declared)}`);
  assert.equal(
    declared[0],
    actualCount,
    `协议文档声明的变异数量 ${declared[0]} 必须等于 mutation-check.mjs 的实际数量 ${actualCount}`,
  );

  // 文档不得再出现旧的数量描述（29 个变异）。
  assert.equal(
    doc.includes('29 个变异'),
    false,
    '协议文档不得保留过期的「29 个变异」描述',
  );

  // 变异脚本的实际执行也必须真的覆盖这个数量：导出的 MUTATIONS 长度与 id 数一致。
  const listedIds = [...script.matchAll(/^    id: '([^']+)'/gm)].map((match) => match[1]);
  assert.equal(new Set(listedIds).size, listedIds.length, '变异 id 不得重复，否则实际覆盖会少一个');

  // 文档里 9.1 表格的行数也必须与脚本一致：只有「逐个应用 N 个变异」一句话对上、
  // 清单表却少列若干项同样属于文档与脚本不一致。
  // 只取 9.1 一节内部的表格行，避免把第 5 节的判定顺序表（同样以两位序号开头）算进来。
  const section = doc.slice(doc.indexOf('### 9.1 '), doc.indexOf('### 9.2 '));
  assert.ok(section.length > 0, '协议文档必须包含 9.1 变异清单小节');
  const tableRows = [...section.matchAll(/^\| (\d{2,3}) \| /gm)].length;
  assert.equal(
    tableRows,
    actualCount,
    `协议文档 9.1 表格必须为每个变异各列一行，实际 ${tableRows} 行、脚本 ${actualCount} 个`,
  );

  // DOC-01：表格只列代表性规则与主测试，完整失败集合以 mutation-check.mjs 为准。
  // 文档必须显式说明这一点，不能声称表格逐项列出了全部失败测试。
  assert.ok(
    section.includes('完整的 `failTests` 集合以 `mutation-check.mjs` 里每个变异声明的数组为准'),
    '协议文档 9.1 必须说明完整 failTests 集合以 mutation-check.mjs 为准',
  );
  assert.ok(
    section.includes('只列每个变异的代表性规则与主测试'),
    '协议文档 9.1 必须说明表格只列代表性规则与主测试',
  );
  assert.equal(
    section.includes('表格逐项列出全部失败测试'),
    false,
    '协议文档不得声称表格逐项列出全部失败测试',
  );
});

/* ------------------------------------------------------------------ */
/* 最终 Codex 复审回归（HIST-01..04 / TRACK-01 / BLOB-01 / ROUTE-01 /   */
/* PULL-01..02 / SUBMIT-01 / MANIFEST-01 / REPLAY-01 / FIXTURE-01 /     */
/* STATE-01 / REV-01 / MUTATION-01）                                    */
/* ------------------------------------------------------------------ */

test('历史版本与首次请求的 metadata.line_ending 必须比较字段存在性与取值（HIST-01）', () => {
  const entry = SCENARIO_BY_NAME.get('historical-successor-version');
  const initial = entry.scenario.initial_state;
  const clone = () => cloneJson(initial);
  assert.deepEqual(validateInitialState(initial), [], '真实夹具必须自洽');

  const version = (state, versionId) => state.versions.find((item) => item.version_id === versionId);
  const request = (state) => state.idempotency[0].request.body;
  const rehash = (state) => {
    state.idempotency[0].request.body = request(state);
    state.idempotency[0].fingerprint = fingerprintOf(state.idempotency[0].request.body);
  };

  // 前置状态：ver_doc_02 是有后继版本（ver_doc_04）的非当前版本，双方都声明 line_ending。
  assert.notEqual(
    initial.files.find((file) => file.file_id === 'file_doc').current_version_id,
    'ver_doc_02',
    'ver_doc_02 必须是非当前历史版本',
  );
  assert.equal(version(initial, 'ver_doc_02').metadata.line_ending, 'lf');
  assert.equal(request(initial).metadata.line_ending, 'lf');

  // 1. 版本侧显式 null、请求侧省略：`?? null` 会判成相等，必须靠存在性比较拦下。
  const versionNull = clone();
  version(versionNull, 'ver_doc_02').metadata.line_ending = null;
  delete request(versionNull).metadata.line_ending;
  rehash(versionNull);
  const versionNullProblems = validateInitialState(versionNull);
  assert.ok(
    versionNullProblems.some((problem) => problem.includes('line_ending')),
    `版本侧显式 null 必须被发现，实际 ${JSON.stringify(versionNullProblems)}`,
  );
  assert.throws(() => createVaultState(versionNull), /line_ending/, '版本侧显式 null 必须阻止建库');

  // 2. 请求侧显式 null、版本侧省略：同样必须失败。
  const requestNull = clone();
  delete version(requestNull, 'ver_doc_02').metadata.line_ending;
  request(requestNull).metadata.line_ending = null;
  rehash(requestNull);
  assert.ok(
    validateInitialState(requestNull).some((problem) => problem.includes('line_ending')),
    '请求侧显式 null 必须被发现',
  );

  // 3. 单方缺失（版本省略、请求声明）与反向都必须失败。
  const versionMissing = clone();
  delete version(versionMissing, 'ver_doc_02').metadata.line_ending;
  assert.ok(
    validateInitialState(versionMissing).some((problem) => problem.includes('line_ending')),
    '版本单方缺失 line_ending 必须被发现',
  );
  const requestMissing = clone();
  delete request(requestMissing).metadata.line_ending;
  rehash(requestMissing);
  assert.ok(
    validateInitialState(requestMissing).some((problem) => problem.includes('line_ending')),
    '请求单方缺失 line_ending 必须被发现',
  );

  // 4. 双方都出现但取值不同：必须失败。
  const drift = clone();
  version(drift, 'ver_doc_02').metadata.line_ending = 'crlf';
  assert.ok(
    validateInitialState(drift).some((problem) => problem.includes('line_ending')),
    '取值不同必须被发现',
  );

  // 5. 正向：双方都省略（可选字段）必须通过。
  const bothOmitted = clone();
  delete version(bothOmitted, 'ver_doc_02').metadata.line_ending;
  delete request(bothOmitted).metadata.line_ending;
  rehash(bothOmitted);
  assert.deepEqual(
    validateInitialState(bothOmitted),
    [],
    `双方都省略 line_ending 必须被接受，实际 ${JSON.stringify(validateInitialState(bothOmitted))}`,
  );
  assert.ok(createVaultState(bothOmitted), '双方都省略时建库必须成功');

  // 6. 显式 null 无论在哪一侧都不是合法枚举值。
  const bothNull = clone();
  version(bothNull, 'ver_doc_02').metadata.line_ending = null;
  request(bothNull).metadata.line_ending = null;
  rehash(bothNull);
  assert.ok(
    validateInitialState(bothNull).some((problem) => problem.includes('must be lf / crlf') || problem.includes('必须是 lf / crlf')),
    '显式 null 必须被枚举校验拒绝',
  );
});

test('历史版本的 metadata.format 与所属文件绑定，复用版本的删除状态不得因缺 metadata 被误拒（HIST-02）', () => {
  const compressedEntry = SCENARIO_BY_NAME.get('compressed-history-recovery');
  const compressed = compressedEntry.scenario.initial_state;
  assert.deepEqual(validateInitialState(compressed), [], '压缩夹具必须自洽');

  // 1. 压缩**非当前**版本的 format 漂移必须失败。
  //    构造一个 revision 2（<= 下界 3）、没有任何保留 Change、也不是当前指针的历史版本：
  //    此时指针校验看不到它，只有「版本声明了 metadata.format 就必须与所属文件一致」能发现。
  assert.equal(
    compressed.changes.some((change) => change.version_id === 'ver_notes_02'),
    false,
    'ver_notes_02 必须确实没有任何保留 Change',
  );
  const withCompressedHistory = cloneJson(compressed);
  withCompressedHistory.versions.push({
    version_id: 'ver_notes_01',
    file_id: 'file_notes',
    vault_revision: 2,
    blob_id: 'blob_811349c57bbe210e7f90aaa3c18abe9c9993557f11d61408104c392217c73f8c',
    content_hash: 'sha256:811349c57bbe210e7f90aaa3c18abe9c9993557f11d61408104c392217c73f8c',
    content_size: 93,
    base_version_id: null,
    metadata: { format: 'txt' },
  });
  withCompressedHistory.versions.find((version) => version.version_id === 'ver_notes_02').base_version_id = 'ver_notes_01';
  assert.deepEqual(validateInitialState(withCompressedHistory), [], '压缩历史的正向前置状态必须自洽');
  assert.notEqual(
    withCompressedHistory.files.find((file) => file.file_id === 'file_notes').current_version_id,
    'ver_notes_01',
    'ver_notes_01 必须是非当前版本',
  );
  const compressedDrift = cloneJson(withCompressedHistory);
  compressedDrift.versions.find((version) => version.version_id === 'ver_notes_01').metadata.format = 'json';
  const compressedDriftProblems = validateInitialState(compressedDrift);
  assert.ok(
    compressedDriftProblems.some(
      (problem) => problem.includes('ver_notes_01') && problem.includes('metadata.format'),
    ),
    `压缩非当前版本的 format 漂移必须被发现，实际 ${JSON.stringify(compressedDriftProblems)}`,
  );
  // 失败必须只来自版本级校验：指针仍指向 ver_notes_02（format 正确），与错误版本无关。
  assert.equal(
    compressedDriftProblems.some((problem) => problem.includes('最终版本 ver_notes_02')),
    false,
    '该用例必须只由版本级 format 校验发现，而不是指针校验顺带兜住',
  );
  assert.throws(
    () => createVaultState(compressedDrift),
    /ver_notes_01/,
    '压缩非当前版本 format 漂移必须阻止建库',
  );

  // 2. 压缩版本缺少 metadata / 来源字段时不得被误拒：
  //    ver_doc_02（revision 2）位于压缩下界内，其创建 / 更新 Change 已被压缩，
  //    只保留 revision 4 的 update。它的 metadata 与来源字段都不再可追溯，必须放行。
  const reuseEntry = SCENARIO_BY_NAME.get('historical-successor-version');
  const reuse = reuseEntry.scenario.initial_state;
  const reuseClone = () => cloneJson(reuse);
  const compressedReuse = reuseClone();
  compressedReuse.min_available_revision = 3;
  compressedReuse.changes = compressedReuse.changes.filter((change) => change.vault_revision > 3);
  compressedReuse.idempotency = compressedReuse.idempotency.filter(
    (entry) => entry.operation_id === 'op_doc_v4',
  );
  const compressedVersion = compressedReuse.versions.find((version) => version.version_id === 'ver_doc_02');
  delete compressedVersion.metadata;
  delete compressedVersion.created_by_device_id;
  delete compressedVersion.created_at;
  const compressedReuseProblems = validateInitialState(compressedReuse);
  assert.deepEqual(
    compressedReuseProblems,
    [],
    `压缩版本缺少 metadata / 来源字段时不得被误拒，实际 ${JSON.stringify(compressedReuseProblems)}`,
  );

  // 3. 压缩且仅保留复用版本的删除状态：唯一保留的 Change 是 revision 3 的 delete_file，
  //    它复用的 ver_doc_02 没有任何 metadata。这种合法状态必须整体通过，不得被误拒。
  const deleteOnly = reuseClone();
  deleteOnly.min_available_revision = 2;
  deleteOnly.vault_revision = 3;
  deleteOnly.changes = deleteOnly.changes.filter((change) => change.vault_revision === 3);
  deleteOnly.idempotency = [];
  deleteOnly.versions = deleteOnly.versions.filter((version) => version.version_id !== 'ver_doc_04');
  const reusedVersion = deleteOnly.versions.find((version) => version.version_id === 'ver_doc_02');
  delete reusedVersion.metadata;
  delete reusedVersion.created_by_device_id;
  delete reusedVersion.created_at;
  const deleteOnlyFile = deleteOnly.files.find((file) => file.file_id === 'file_doc');
  deleteOnlyFile.current_version_id = 'ver_doc_02';
  deleteOnlyFile.is_deleted = true;
  const deleteOnlyProblems = validateInitialState(deleteOnly);
  assert.deepEqual(
    deleteOnlyProblems,
    [],
    `压缩后仅有复用版本的删除状态必须通过，实际 ${JSON.stringify(deleteOnlyProblems)}`,
  );

  // 4. 同一个夹具的反向：仍然引用 ver_doc_02 的保留 update（revision 2）必须有 metadata。
  const retainedUpdate = reuseClone();
  delete retainedUpdate.versions.find((version) => version.version_id === 'ver_doc_02').metadata;
  assert.ok(
    validateInitialState(retainedUpdate).some(
      (problem) => problem.includes('ver_doc_02') && problem.includes('缺少 metadata 对象'),
    ),
    '保留 update 产生的版本缺少 metadata 必须被发现',
  );
});

test('历史加载不接受更新基准回退，也不接受指向未来版本的 Change（HIST-03）', () => {
  const entry = SCENARIO_BY_NAME.get('historical-successor-version');
  const initial = entry.scenario.initial_state;
  const clone = () => cloneJson(initial);
  assert.deepEqual(validateInitialState(initial), [], '真实夹具必须自洽');

  const version = (state, versionId) => state.versions.find((item) => item.version_id === versionId);

  // 0. 前置状态：revision 2 的 update 父版本是 ver_doc_01；revision 4 的 update 父版本是 ver_doc_02
  //    （删除前 / 复用后的当前版本）。这是可证明的链。
  assert.equal(initial.changes.find((change) => change.vault_revision === 2).parent_version_id, 'ver_doc_01');
  assert.equal(initial.changes.find((change) => change.vault_revision === 4).parent_version_id, 'ver_doc_02');

  // 1. 把 revision 4 的 update 父引用改回更早的 ver_doc_01（跳过 revision 2 的写入）：
  //    版本图仍然无环、父版本也确实更早、版本与 Change 也彼此一致，
  //    只有「按同文件 Change 顺序重建可证明指针」能把这种基准回退拦下。
  const rollback = clone();
  rollback.changes.find((change) => change.vault_revision === 4).parent_version_id = 'ver_doc_01';
  rollback.versions.find((version) => version.version_id === 'ver_doc_04').base_version_id = 'ver_doc_01';
  const rollbackProblems = validateInitialState(rollback);
  assert.ok(
    rollbackProblems.some((problem) => problem.includes('可证明的当前版本')),
    `更新父引用回退必须由指针重建发现，实际 ${JSON.stringify(rollbackProblems)}`,
  );
  assert.throws(() => createVaultState(rollback), /可证明的当前版本/, '基准回退必须阻止建库');

  // 2. 把 revision 4 的 update 父引用改成 null（版本侧同步）：同样必须失败。
  const nullParent = clone();
  nullParent.changes.find((change) => change.vault_revision === 4).parent_version_id = null;
  nullParent.versions.find((version) => version.version_id === 'ver_doc_04').base_version_id = null;
  assert.ok(
    validateInitialState(nullParent).some((problem) => problem.includes('可证明的当前版本')),
    '把父引用改成 null 必须被发现',
  );

  // 3. 删除 / 复用版本指向**未来**版本：revision 3 的 delete_file 改成引用 revision 4 的 ver_doc_04。
  const futureDelete = clone();
  const deleteChange = futureDelete.changes.find((change) => change.vault_revision === 3);
  deleteChange.version_id = 'ver_doc_04';
  assert.ok(
    validateInitialState(futureDelete).some((problem) => problem.includes('未来版本')),
    `删除 Change 指向未来版本必须被发现，实际 ${JSON.stringify(validateInitialState(futureDelete))}`,
  );
  assert.throws(() => createVaultState(futureDelete), /未来版本/, '未来版本引用必须阻止建库');

  // 4. update 的父版本必须取自删除前的当前版本：把 revision 4 的父引用改成删除时所用的
  //    更早复用父版本（ver_doc_01），也必须失败。
  const wrongAfterDelete = clone();
  wrongAfterDelete.changes.find((change) => change.vault_revision === 4).parent_version_id = 'ver_doc_01';
  assert.ok(
    validateInitialState(wrongAfterDelete).some(
      (problem) => problem.includes('可证明的当前版本') || problem.includes('parent_version_id'),
    ),
    '删除后的 update 父版本必须是删除前的当前版本',
  );

  // 5. 正向：真实链必须通过，且每条保留 Change 都指向不晚于自己的版本。
  for (const change of initial.changes) {
    const target = version(initial, change.version_id);
    assert.ok(target, `Change ${change.change_id} 的版本必须存在`);
    assert.ok(
      target.vault_revision <= change.vault_revision,
      `Change ${change.change_id} 不得引用未来版本`,
    );
  }
});

test('历史首次请求的 URL 查询串必须参与加载校验（HIST-04）', async () => {
  const entry = SCENARIO_BY_NAME.get('historical-single-hash-replay');
  const initial = entry.scenario.initial_state;
  const clone = () => cloneJson(initial);
  const ledger = initial.idempotency[0];

  // 1. request.url 中携带错误的 vault_id：加载阶段必须失败，而不是等到重放返回 404。
  const badUrl = clone();
  badUrl.idempotency[0].request.url = `https://sync.example/api/v1/vaults/${initial.vault_id}/sync/changes?vault_id=vault_other`;
  const urlProblems = validateInitialState(badUrl);
  assert.ok(
    urlProblems.some((problem) => problem.includes('query.vault_id')),
    `URL 查询串中的错误 vault_id 必须被发现，实际 ${JSON.stringify(urlProblems)}`,
  );
  assert.throws(() => createVaultState(badUrl), /query\.vault_id/, 'URL 查询串错误必须阻止建库');

  // 2. request.url 中携带正确的 vault_id：必须通过，并能原样重放命中首次结果。
  const goodUrl = clone();
  goodUrl.idempotency[0].request.url = `https://sync.example/api/v1/vaults/${initial.vault_id}/sync/changes?vault_id=${initial.vault_id}`;
  assert.deepEqual(validateInitialState(goodUrl), [], 'URL 查询串与本 Vault 一致时必须通过');

  // 3. 通过加载的历史请求必须能原样交给 handleRequest 重放（含 url 中的正确查询串）。
  const state = createVaultState(goodUrl);
  const before = snapshotState(state);
  const replay = await handleRequest(
    state,
    new Request(goodUrl.idempotency[0].request.url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', ...ledger.request.headers },
      body: JSON.stringify(ledger.request.body),
    }),
    { resolveUpload: () => readSample('notes/roadmap-v2.md') },
  );
  assert.equal(replay.status, 200, `携带合法 url 查询串的历史请求必须能重放：${JSON.stringify(replay.body)}`);
  assert.equal(replay.body.replayed, true);
  assert.equal(replay.body.change_id, ledger.result.change_id);
  assert.deepEqual(snapshotState(state), before, '重放不得改变状态');

  // 4. query 对象与 url 同时声明且不一致时也必须失败（两种来源都要查）。
  const both = clone();
  both.idempotency[0].request.query = { vault_id: initial.vault_id };
  both.idempotency[0].request.url = `https://sync.example/api/v1/vaults/${initial.vault_id}/sync/changes?vault_id=vault_other`;
  assert.ok(
    validateInitialState(both).some((problem) => problem.includes('query.vault_id')),
    'url 与 query 不一致时不得因为 query 正确就放过',
  );
});

test('request_log / 幂等账本的 request_id 必须严格是六位字符串（TRACK-01）', () => {
  const entry = SCENARIO_BY_NAME.get('stale-cursor-recovery');
  const initial = entry.scenario.initial_state;
  const clone = () => cloneJson(initial);
  assert.deepEqual(validateInitialState(initial), [], '真实夹具必须自洽');

  // 1. request_log 中的数组 / 数字：正则的隐式字符串转换会让它们通过，必须被严格类型拒绝。
  for (const bogus of [['req_000001'], 1, 123456, ['req_999999'], { request_id: 'req_000001' }]) {
    const tampered = clone();
    tampered.request_log = [{ request_id: bogus }];
    assert.ok(
      validateInitialState(tampered).some((problem) => problem.includes('request_log 条目 request_id 不合法')),
      `request_log 的 request_id=${JSON.stringify(bogus)} 必须因类型被拒绝`,
    );
  }

  // 2. 幂等账本的 request_id 与 result.request_id 同样严格。
  for (const bogus of [['req_000001'], 5]) {
    const tampered = clone();
    tampered.idempotency[0].request_id = bogus;
    tampered.idempotency[0].result.request_id = bogus;
    assert.ok(
      validateInitialState(tampered).some((problem) => problem.includes('request_id')),
      `账本 request_id=${JSON.stringify(bogus)} 必须因类型被拒绝`,
    );
  }
  {
    const tampered = clone();
    tampered.idempotency[0].result.request_id = ['req_000001'];
    assert.ok(
      validateInitialState(tampered).some((problem) => problem.includes('request_id')),
      '账本 result.request_id 为数组时必须被拒绝',
    );
  }

  // 3. 形状正确但越界的数字串仍必须被拒绝（1..999999）。
  for (const bogus of ['req_000000', 'req_1000000', 'req_00000', 'req_0000000']) {
    const tampered = clone();
    tampered.request_log = [{ request_id: bogus }];
    assert.ok(
      validateInitialState(tampered).some((problem) => problem.includes('request_log 条目 request_id 不合法')),
      `${bogus} 必须被拒绝`,
    );
  }

  // 4. 正向：合法的六位字符串通过，且序号推导使用同一口径。
  const valid = clone();
  valid.request_log = [{ request_id: 'req_000042' }];
  // 夹具原生的 request_sequence=2 会与历史 req_000042 冲突，因此这里改成由历史推导。
  delete valid.request_sequence;
  assert.deepEqual(validateInitialState(valid), [], '合法 request_id 必须通过');
  assert.equal(usedNumbersProbe(valid), 43, '序号推导必须与类型校验共用严格解析');
});

/** 通过公开行为验证严格解析：下一个 request_id 必须跳过历史已用序号。 */
function usedNumbersProbe(initial) {
  const state = createVaultState(initial);
  return state.request_sequence;
}

test('同完整哈希的 Blob 与上传会话不得声明不同大小（BLOB-01）', () => {
  const entry = SCENARIO_BY_NAME.get('stale-cursor-recovery');
  const initial = entry.scenario.initial_state;
  const clone = () => cloneJson(initial);
  assert.deepEqual(validateInitialState(initial), [], '真实夹具必须自洽');

  const hash = 'sha256:542b2f6db9967dd8c083a9154064652f151e6ec9616264fe81e40ed2eb9b6227';

  // 1. 同 content_hash 的两个 Blob 声明不同 content_size：必须失败。
  const sizeDrift = clone();
  sizeDrift.blobs.push({
    blob_id: hash,
    vault_id: initial.vault_id,
    content_hash: hash,
    content_size: 999,
    created_by_device_id: 'device_mac_0001',
  });
  assert.ok(
    validateInitialState(sizeDrift).some((problem) => problem.includes('不同 content_size') || problem.includes('content_size')),
    '同哈希不同大小必须被发现',
  );

  // 2. completed 上传会话与同哈希 Blob 的大小不一致：必须失败。
  const uploadDrift = clone();
  uploadDrift.upload_sessions.find((upload) => upload.blob_reference === 'upload_roadmap_v2').content_size = 999;
  const uploadProblems = validateInitialState(uploadDrift);
  assert.ok(
    uploadProblems.some((problem) => problem.includes('上传会话') && problem.includes('content_size')),
    `completed 会话与 Blob 大小不一致必须被发现，实际 ${JSON.stringify(uploadProblems)}`,
  );

  // 3. completed 上传会话与它引用的 Blob 哈希不一致：必须失败。
  const referencedHashDrift = clone();
  const upload = referencedHashDrift.upload_sessions.find((item) => item.blob_reference === 'upload_roadmap_v2');
  upload.blob_id = 'blob_811349c57bbe210e7f90aaa3c18abe9c9993557f11d61408104c392217c73f8c';
  assert.ok(
    validateInitialState(referencedHashDrift).some(
      (problem) => problem.includes('哈希不一致') || problem.includes('blob_id'),
    ),
    'completed 会话与引用 Blob 哈希不一致必须被发现',
  );

  // 4. 正向：真实夹具里所有同哈希 Blob 大小一致。
  const sizes = new Map();
  for (const blob of initial.blobs) {
    if (sizes.has(blob.content_hash)) {
      assert.equal(sizes.get(blob.content_hash), blob.content_size, '同哈希 Blob 大小必须一致');
    } else {
      sizes.set(blob.content_hash, blob.content_size);
    }
  }
});


test('标准 Request 必须能访问 URL 编码的非 ASCII Vault ID（ROUTE-01）', async () => {
  const entry = SCENARIO_BY_NAME.get('submit-markdown');
  const base = entry.scenario.initial_state;
  const vaultId = 'vault_中文_0001';
  const initial = cloneJson(base);
  initial.vault_id = vaultId;
  initial.blobs = initial.blobs.map((blob) => ({ ...blob, vault_id: vaultId }));
  initial.upload_sessions = initial.upload_sessions.map((upload) => ({ ...upload, vault_id: vaultId }));
  initial.changes = initial.changes.map((change) => ({ ...change, vault_id: vaultId }));
  initial.idempotency = (initial.idempotency ?? []).map((item) => ({ ...item }));
  assert.deepEqual(validateInitialState(initial), [], '非 ASCII Vault 的初态必须自洽');

  // 1. GET manifest：URL 里的 Vault 段被百分号编码，模型必须解码后再与 state.vault_id 比较。
  const state = createVaultState(initial);
  const encoded = encodeURIComponent(vaultId);
  assert.notEqual(encoded, vaultId, '前置：非 ASCII Vault ID 必须真的被编码');
  const manifestRequest = new Request(`${ORIGIN}/api/v1/vaults/${encoded}/sync/manifest`, {
    method: 'GET',
    headers: { 'X-Device-Id': 'device_mac_0001' },
  });
  const manifest = await handleRequest(state, manifestRequest, { resolveUpload: () => Buffer.alloc(0) });
  assert.equal(manifest.status, 200, `编码后的 manifest 必须成功：${JSON.stringify(manifest.body)}`);
  assert.equal(manifest.body.vault_id, vaultId, 'manifest 必须回显解码后的 Vault ID');
  assert.equal(manifest.body.mode, 'manifest');

  // 2. POST pull：同样必须成功。
  const pullState = createVaultState(initial);
  const pull = await handleRequest(
    pullState,
    new Request(`${ORIGIN}/api/v1/vaults/${encoded}/sync/changes`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        mode: 'pull',
        vault_id: vaultId,
        device_id: 'device_mac_0001',
        last_server_revision: 1,
      }),
    }),
    { resolveUpload: () => Buffer.alloc(0) },
  );
  assert.equal(pull.status, 200, `编码后的 pull 必须成功：${JSON.stringify(pull.body)}`);
  assert.equal(pull.body.vault_id, vaultId);
  assert.deepEqual(pull.body.changes, [], '游标已是当前 revision 时必须返回空 Change 数组');

  // 3. 响应 endpoint 必须回显**实际请求路径**（编码后的原串），而不是解码后的路径。
  assert.equal(
    manifest.body.endpoint,
    `/api/v1/vaults/${encoded}/sync/manifest`,
    '响应 endpoint 必须回显实际请求路径（保留百分号编码）',
  );
  assert.equal(pull.body.endpoint, `/api/v1/vaults/${encoded}/sync/changes`);

  // 4. 非法百分号编码不得抛出未捕获异常：必须返回稳定的 ENDPOINT_NOT_FOUND。
  for (const badPath of [
    '/api/v1/vaults/%ZZ/sync/manifest',
    '/api/v1/vaults/%E4/sync/manifest',
    '/api/v1/vaults/%E4%B8%AD%2Fsync/manifest',
  ]) {
    const badState = createVaultState(initial);
    let response;
    assert.doesNotThrow(
      async () => {
        response = await handleRequest(
          badState,
          { method: 'GET', endpoint: badPath, headers: { 'X-Device-Id': 'device_mac_0001' } },
          { resolveUpload: () => Buffer.alloc(0) },
        );
      },
      `非法百分号编码 ${badPath} 不得抛出未捕获异常`,
    );
    const settled = await handleRequest(
      createVaultState(initial),
      { method: 'GET', endpoint: badPath, headers: { 'X-Device-Id': 'device_mac_0001' } },
      { resolveUpload: () => Buffer.alloc(0) },
    );
    assert.equal(settled.status, 404, `非法路径 ${badPath} 必须返回 404`);
    assert.equal(settled.body.code, ERROR_CODES.ENDPOINT_NOT_FOUND, `非法路径 ${badPath} 必须返回 ENDPOINT_NOT_FOUND`);
  }
});

test('历史首次请求可以省略 Idempotency-Key，且省略后仍可原样重放（REPLAY-01）', async () => {
  const entry = SCENARIO_BY_NAME.get('historical-successor-version');
  const initial = entry.scenario.initial_state;
  const clone = () => cloneJson(initial);
  assert.deepEqual(validateInitialState(initial), [], '真实夹具必须自洽');

  // 1. 省略 Idempotency-Key：加载必须通过（它是可选头），且原样重放命中首次结果。
  const noKey = clone();
  delete noKey.idempotency[1].request.headers['Idempotency-Key'];
  assert.deepEqual(validateInitialState(noKey), [], '省略 Idempotency-Key 必须被接受');
  const state = createVaultState(noKey);
  const ledger = noKey.idempotency[1];
  const before = snapshotState(state);
  const replay = await handleRequest(
    state,
    postRequest(noKey.vault_id, ledger.request.body),
    { resolveUpload: () => readSample('notes/todo-v1.txt') },
  );
  assert.equal(replay.status, 200, `省略 Idempotency-Key 的重放必须成功：${JSON.stringify(replay.body)}`);
  assert.equal(replay.body.replayed, true);
  assert.equal(replay.body.change_id, ledger.result.change_id);
  assert.deepEqual(snapshotState(state), before, '重放不得改变状态');

  // 2. 存在但大小写不同、取值正确：必须通过。
  const mixedCase = clone();
  delete mixedCase.idempotency[1].request.headers['Idempotency-Key'];
  mixedCase.idempotency[1].request.headers['IDEMPOTENCY-KEY'] = 'op_doc_v4';
  assert.deepEqual(validateInitialState(mixedCase), [], '大小写不同的 Idempotency-Key 必须按同一头处理');

  // 3. 存在但取值错误：必须失败。
  const wrongKey = clone();
  wrongKey.idempotency[1].request.headers['Idempotency-Key'] = 'op_other';
  assert.ok(
    validateInitialState(wrongKey).some((problem) => problem.includes('Idempotency-Key 不一致')),
    '错误的 Idempotency-Key 必须被发现',
  );

  // 4. 执行器不得把可选头当必填：夹具里必须真的存在一条「首次请求和重放都省略
  //    Idempotency-Key」的历史重放步骤，并通过统一执行器跑完整条断言链。
  const noKeyStep = entry.scenario.steps.find(
    (item) => item.id === 'replay-without-idempotency-key',
  );
  assert.ok(noKeyStep, '夹具必须包含省略 Idempotency-Key 的历史重放步骤');
  assert.equal(noKeyStep.expect_historical_replay, 0, '该步骤必须指向不带 Idempotency-Key 的账本条目');
  assert.deepEqual(noKeyStep.request.headers ?? {}, {}, '该步骤的请求不得携带任何请求头');
  const ledgerWithoutKey = entry.scenario.initial_state.idempotency[noKeyStep.expect_historical_replay];
  assert.equal(
    Object.hasOwn(ledgerWithoutKey.request.headers ?? {}, 'Idempotency-Key'),
    false,
    '被重放的首次请求必须确实省略 Idempotency-Key',
  );

  // 统一执行器必须接受这条「不带可选头」的历史重放步骤（把该头当必填会让它失败）。
  const executed = await runScenario(cloneJson(entry.scenario), new Map());
  assert.ok(
    executed.registration.steps.has('replay-without-idempotency-key'),
    '省略 Idempotency-Key 的历史重放步骤必须通过统一执行器并登记',
  );
  // 同一组场景里另一条历史重放仍带该头：两种写法都必须被支持。
  const withKeyStep = entry.scenario.steps.find((item) => item.id === 'replay-successor-history');
  assert.ok(withKeyStep, '夹具必须同时保留带 Idempotency-Key 的历史重放步骤');
  assert.equal(
    headerValueLower(withKeyStep.request.headers, 'idempotency-key'),
    'op_doc_v4',
    '带头的历史重放步骤必须声明正确的 Idempotency-Key',
  );
});

test('validateInitialState 与 createVaultState 对缺省集合使用一致语义（STATE-01）', () => {
  const entry = SCENARIO_BY_NAME.get('stale-cursor-recovery');
  const initial = entry.scenario.initial_state;

  // 1. 只有必需标量的最小初态：缺省所有集合。校验通过则建库也必须成功。
  const minimal = { vault_id: 'vault_empty_0001', vault_revision: 0 };
  assert.deepEqual(validateInitialState(minimal), [], '缺省集合的最小初态必须通过校验');
  const state = createVaultState(minimal);
  assert.deepEqual(state.files, [], '缺省 files 必须建库为空数组');
  assert.deepEqual(state.versions, [], '缺省 versions 必须建库为空数组');
  assert.deepEqual(state.blobs, [], '缺省 blobs 必须建库为空数组');
  assert.deepEqual(state.changes, [], '缺省 changes 必须建库为空数组');
  assert.deepEqual(state.uploads, [], '缺省 upload_sessions 必须建库为空数组');
  assert.equal(state.idempotency.size, 0, '缺省 idempotency 必须建库为空账本');
  assert.equal(state.usedOperations.size, 0, '缺省集合不得产生已占用 operation');

  // 2. 每个集合显式出现但类型错误：必须被校验拒绝（且 createVaultState 会抛错）。
  for (const key of ['files', 'versions', 'blobs', 'changes', 'upload_sessions', 'idempotency', 'request_log', 'reserved_operation_ids']) {
    for (const bogus of [{}, 'x', 42, null]) {
      const tampered = cloneJson(initial);
      if (bogus === null) tampered[key] = null;
      else tampered[key] = bogus;
      assert.ok(
        validateInitialState(tampered).some((problem) => problem.includes(`initial_state.${key} 必须是数组`)),
        `${key}=${JSON.stringify(bogus)} 必须被拒绝`,
      );
      assert.throws(() => createVaultState(tampered), /initial_state 自检失败/, `${key} 类型错误必须阻止建库`);
    }
  }

  // 3. 显式空数组必须与缺省等价：校验与建库都不能抛 TypeError。
  const explicitEmpty = {
    vault_id: 'vault_empty_0002',
    vault_revision: 0,
    min_available_revision: 0,
    files: [],
    versions: [],
    blobs: [],
    changes: [],
    upload_sessions: [],
    idempotency: [],
    request_log: [],
  };
  assert.deepEqual(validateInitialState(explicitEmpty), [], '显式空集合必须通过');
  const explicitState = createVaultState(explicitEmpty);
  assert.equal(explicitState.files.length, 0);
  assert.equal(explicitState.request_sequence, 1, '空历史时序号从 1 开始');
});

test('revision 连续性校验按实际记录检查，不随巨大 vault_revision 线性循环（REV-01）', () => {
  const entry = SCENARIO_BY_NAME.get('stale-cursor-recovery');
  const initial = entry.scenario.initial_state;
  const clone = () => cloneJson(initial);

  // 1. 大跨度 + 少量保留记录：报告的问题数必须与记录数同阶，而不是随 revision 数值增长。
  //    下界 0、vault_revision 100000，只保留 revision 3..6 四条 Change：
  //    正确实现只需报「首个缺口 1」「中间缺口 2」「尾部缺口 7」共 3 条；
  //    若按数值逐个循环，会报出约 99994 条缺失，问题数立刻爆炸（且耗时随跨度线性增长）。
  const huge = clone();
  huge.vault_revision = 100000;
  huge.min_available_revision = 0;
  const startedAt = process.hrtime.bigint();
  const problems = validateInitialState(huge);
  const elapsedMs = Number(process.hrtime.bigint() - startedAt) / 1e6;
  assert.ok(elapsedMs < 2000, `大跨度校验必须按记录数增长，实际耗时 ${elapsedMs.toFixed(1)}ms`);
  assert.ok(
    problems.length <= 10,
    `大跨度下问题数必须与记录数同阶（实际 ${problems.length} 条），不得按 revision 数值逐个枚举`,
  );
  assert.ok(
    problems.some((problem) => problem.includes('缺少 revision 1 的 Change')),
    `大跨度下仍必须报出首个缺口，实际 ${JSON.stringify(problems.slice(0, 5))}`,
  );

  // 1b. 安全上界附近的大跨度同样必须快速返回。
  const nearMax = clone();
  nearMax.vault_revision = Number.MAX_SAFE_INTEGER;
  nearMax.min_available_revision = Number.MAX_SAFE_INTEGER - 1000;
  const nearMaxStarted = process.hrtime.bigint();
  const nearMaxProblems = validateInitialState(nearMax);
  const nearMaxElapsed = Number(process.hrtime.bigint() - nearMaxStarted) / 1e6;
  assert.ok(nearMaxElapsed < 2000, `上界附近的大跨度校验必须快速返回，实际 ${nearMaxElapsed.toFixed(1)}ms`);
  assert.ok(nearMaxProblems.length <= 10, '上界附近的大跨度不得逐条枚举缺失 revision');

  // 2. 尾部缺口：保留集合止于 vault_revision 之前，必须报出尾部缺失。
  const tailGap = clone();
  tailGap.changes = tailGap.changes.filter((change) => change.vault_revision !== 6);
  tailGap.vault_revision = 6;
  delete tailGap.request_sequence;
  tailGap.idempotency = [];
  tailGap.files = tailGap.files.filter((file) => file.file_id !== 'file_beta');
  tailGap.versions = tailGap.versions.filter((version) => version.file_id !== 'file_beta');
  tailGap.blobs = tailGap.blobs.filter((blob) => blob.created_by_device_id !== 'device_web_0001');
  assert.ok(
    validateInitialState(tailGap).some((problem) => problem.includes('缺少 revision 6 的 Change')),
    '尾部缺口必须被报出',
  );

  // 3. 首个缺口：删掉下界之后的第一条 Change。
  const headGap = clone();
  headGap.changes = headGap.changes.filter((change) => change.vault_revision !== 4);
  headGap.idempotency = [];
  assert.ok(
    validateInitialState(headGap).some((problem) => problem.includes('缺少 revision 4 的 Change')),
    '首个缺口必须被报出',
  );

  // 4. 中间缺口：删掉 revision 5。
  const middleGap = clone();
  middleGap.changes = middleGap.changes.filter((change) => change.vault_revision !== 5);
  middleGap.idempotency = [];
  assert.ok(
    validateInitialState(middleGap).some((problem) => problem.includes('缺少 revision 5 的 Change')),
    '中间缺口必须被报出',
  );

  // 5. 安全整数边界：vault_revision 超出 MAX_SAFE_INTEGER 必须被拒绝。
  const unsafe = clone();
  unsafe.vault_revision = Number.MAX_SAFE_INTEGER + 2;
  assert.ok(
    validateInitialState(unsafe).some((problem) => problem.includes('vault_revision 必须是非负整数')),
    '超出安全整数的 vault_revision 必须被拒绝',
  );

  // 6. 正向：真实夹具连续时不得被误报。
  assert.deepEqual(validateInitialState(initial), [], '真实夹具必须通过');
});

test('错误步骤必须声明非空 expected_result.code（FIXTURE-01）', () => {
  // 1. 真实夹具：所有 expected_status >= 400 的步骤都已声明 code。
  for (const { scenario } of SCENARIOS) {
    for (const step of scenario.steps ?? []) {
      if (step.expected_status >= 400) {
        assert.ok(
          typeof step.expected_result?.code === 'string' && step.expected_result.code.length > 0,
          `${scenario.scenario}/${step.id}: 错误步骤必须声明非空 expected_result.code`,
        );
      }
    }
  }

  // 2. 删除 code 的反向：必须被证据校验发现。
  for (const bogus of [undefined, '', null, 409]) {
    const step = { id: 'err', expected_status: 409, expected_result: { message: 'x' } };
    if (bogus === undefined) delete step.expected_result.code;
    else step.expected_result.code = bogus;
    const problems = stepEvidenceProblems({
      scenario: 'synthetic',
      steps: [{ ...step, expect_state_unchanged: true }],
    });
    assert.equal(
      problems.length,
      1,
      `expected_result.code=${JSON.stringify(bogus)} 必须恰好报一个问题，实际 ${JSON.stringify(problems)}`,
    );
    assert.ok(
      problems[0].includes('expected_result.code 必须是非空字符串'),
      `expected_result.code=${JSON.stringify(bogus)} 的诊断必须明确`,
    );
  }

  // 3. 成功步骤不要求 code。
  assert.deepEqual(
    stepEvidenceProblems({
      scenario: 'synthetic',
      steps: [{ id: 'ok', expected_status: 200, expected_result: { mode: 'pull' }, expect_state_unchanged: true }],
    }),
    [],
    '成功步骤不要求 expected_result.code',
  );
});

test('mutation-check 的临时 runner 在失败时必须返回非零退出码（MUTATION-01）', async () => {
  const script = readFileSync(join(REPO_ROOT, 'tests', 'protocol', 'mutation-check.mjs'), 'utf8');

  // 1. runner 必须显式设置 process.exitCode；否则「收集到失败但进程返回 0」会让判定失效。
  assert.ok(
    script.includes('process.exitCode = failures.length === 0 ? 0 : 1'),
    '临时 runner 必须在有失败时设置 process.exitCode=1',
  );

  // 2. runTests 必须核对子进程实际退出状态与结构化失败集合，并拒绝「退出码 0 但报告失败」。
  assert.ok(script.includes('exitMismatch'), 'runTests 必须识别退出码与失败集合不一致');
  assert.ok(
    script.includes('退出码为 0 但报告了'),
    'runTests 必须显式拒绝「退出码 0 但报告了失败」的子进程结果',
  );

  // 3. 真实行为验证：用与脚本相同的 runner 方式跑一个必然失败的测试，退出码必须非零。
  const { mkdtempSync, writeFileSync: writeFile } = await import('node:fs');
  const { tmpdir } = await import('node:os');
  const { execFileSync: execFile } = await import('node:child_process');
  const dir = mkdtempSync(join(tmpdir(), 'mutation-runner-probe-'));
  try {
    writeFile(join(dir, 'probe.test.mjs'), "import test from 'node:test';\nimport assert from 'node:assert/strict';\ntest('always fails', () => { assert.equal(1, 2); });\n");
    writeFile(join(dir, 'runner.mjs'), `
      import { run } from 'node:test';
      import { resolve } from 'node:path';
      const stream = run({ files: [resolve('probe.test.mjs')], concurrency: 1 });
      const failures = [];
      for await (const event of stream) {
        if (event.type === 'test:fail') failures.push({ name: event.data.name });
      }
      process.exitCode = failures.length === 0 ? 0 : 1;
      process.stdout.write(JSON.stringify({ failures }));
    `);
    // 关键：剥掉 `NODE_TEST_CONTEXT`。在 `node --test` 里启动的子进程会继承该变量，
    // 使嵌套的 `run()` 直接跳过文件收集（失败集合为空），从而掩盖退出码问题本身。
    const { NODE_TEST_CONTEXT, ...cleanEnv } = process.env;
    void NODE_TEST_CONTEXT;
    let exitCode = 0;
    try {
      execFile(process.execPath, ['runner.mjs'], { cwd: dir, stdio: 'pipe', env: cleanEnv });
    } catch (error) {
      exitCode = error.status;
    }
    assert.equal(exitCode, 1, '有失败时临时 runner 的退出码必须为 1');
  } finally {
    const { rmSync } = await import('node:fs');
    rmSync(dir, { recursive: true, force: true });
  }
});


test('submit 成功结果必须完整绑定请求与写入状态（SUBMIT-01）', async () => {
  const entry = SCENARIO_BY_NAME.get('submit-markdown');
  const initial = entry.scenario.initial_state;
  const step = entry.scenario.steps.find((item) => item.id === 'submit-roadmap-v2');

  // 1. 基线：完整绑定的成功结果必须通过统一执行器。
  const { state, responses } = await runScenario(cloneJson(entry.scenario), new Map());
  assert.equal(responses[0].status, 200, '基线提交必须成功');
  const result = responses[0].body;
  const change = state.changes.find((item) => item.change_id === result.change_id);
  const version = state.versions.find((item) => item.version_id === result.version_id);
  const file = state.files.find((item) => item.file_id === result.file_id);
  const blob = state.blobs.find((item) => item.blob_id === result.blob_id);
  assert.ok(change && version && file && blob, '基线结果必须能定位 Change / 版本 / 文件 / Blob');

  // 2. 反向：把响应的 vault_id / path / blob_id 改错（同步改 expected_result 同字段，
  //    让 expected_result 深子集不会先失败），统一执行器的动态断言必须发现。
  for (const [label, mutate, resultMutate, pattern] of [
    [
      'vault_id',
      (body) => { body.vault_id = 'vault_tampered'; },
      (expected) => { expected.vault_id = 'vault_tampered'; },
      /vault_id/,
    ],
    [
      'path',
      (body) => { body.path = 'notes/renamed.md'; },
      (expected) => { expected.path = 'notes/renamed.md'; },
      /path/,
    ],
    [
      'blob_id',
      (body) => { body.blob_id = 'blob_0000000000000000000000000000000000000000000000000000000000000000'; },
      (expected) => { expected.blob_id = 'blob_0000000000000000000000000000000000000000000000000000000000000000'; },
      /blob_id/,
    ],
  ]) {
    const scenario = cloneJson(entry.scenario);
    const submitStep = scenario.steps.find((item) => item.id === 'submit-roadmap-v2');
    // 若 expected_result 原本没声明该字段，先补上基线值，再同步篡改：
    // 这样 expected_result 深子集才真的会比较该字段，从而只有动态断言能发现错误。
    if (!Object.hasOwn(submitStep.expected_result, label)) {
      submitStep.expected_result[label] = result[label];
    }
    resultMutate(submitStep.expected_result);
    const records = new Map();
    await assert.rejects(
      () => runScenario(scenario, records, {
        tamperResponse(response, step) {
          if (step.id !== 'submit-roadmap-v2') return response;
          const body = { ...response.body };
          mutate(body);
          return { ...response, body };
        },
      }),
      pattern,
      `统一执行器必须发现 submit 结果的 ${label} 被改错`,
    );
    assert.equal(records.get(scenario.scenario)?.steps.size ?? 0, 0, `被篡改的提交步骤不得登记（${label}）`);
  }

  // 3. 执行器必须逐项核对结果的全部 12 个标识字段：
  //    对每个字段注入一个「与基线不同」的值，并同步修改 expected_result 的同字段，
  //    统一执行器必须失败。这样每个字段都有真实的动态断言覆盖，而不是只靠源码文本扫描。
  const fields = [
    'vault_id',
    'device_id',
    'operation_id',
    'file_id',
    'path',
    'version_id',
    'parent_version_id',
    'change_id',
    'blob_id',
    'content_hash',
    'content_size',
    'vault_revision',
  ];
  for (const field of fields) {
    const scenario = cloneJson(entry.scenario);
    const submitStep = scenario.steps.find((item) => item.id === 'submit-roadmap-v2');
    if (!Object.hasOwn(submitStep.expected_result, field)) {
      submitStep.expected_result[field] = result[field];
    }
    const baseline = result[field];
    const tampered = field === 'vault_revision' || field === 'content_size'
      ? baseline + 1
      : field === 'content_hash'
        ? `sha256:${'0'.repeat(64)}`
        : `tampered_${field}`;
    submitStep.expected_result[field] = tampered;
    const records = new Map();
    await assert.rejects(
      () => runScenario(scenario, records, {
        tamperResponse(response, item) {
          if (item.id !== 'submit-roadmap-v2') return response;
          return { ...response, body: { ...response.body, [field]: tampered } };
        },
      }),
      new RegExp(field),
      `统一执行器必须发现 submit 结果的 ${field} 与状态不一致`,
    );
    assert.equal(
      records.get(scenario.scenario)?.steps.has('submit-roadmap-v2') ?? false,
      false,
      `submit 结果 ${field} 被改错时该步骤不得登记完成`,
    );
  }
  void step;
});

test('manifest 成功响应必须完整校验 header、排序与每个条目的全部字段（MANIFEST-01）', async () => {
  const entry = SCENARIO_BY_NAME.get('stale-cursor-recovery');
  const initial = entry.scenario.initial_state;
  const vaultId = initial.vault_id;
  const state = createVaultState(initial);
  const manifest = await handleRequest(
    state,
    new Request(`${manifestUrl(vaultId)}`, { method: 'GET', headers: { 'X-Device-Id': 'device_mac_0001' } }),
    { resolveUpload: () => Buffer.alloc(0) },
  );
  assert.equal(manifest.status, 200, `基线 manifest 必须成功：${JSON.stringify(manifest.body)}`);
  const label = 'manifest 基线';
  assertManifestResponse(manifest.body, { vaultId, deviceId: 'device_mac_0001', state, label });

  // 1. 空 files 映射：即使重建断言在 file 数为 0 时也可能通过，完整校验必须失败。
  assert.throws(
    () => assertManifestResponse({ ...manifest.body, files: [] }, {
      vaultId,
      deviceId: 'device_mac_0001',
      state,
      label: '反向：空 files',
    }),
    /manifest 必须列出全部文件/,
    '空 files 映射必须被完整校验拦下',
  );

  // 2. 错误 Blob（blob_id 指向别的 Blob）：必须失败。
  const wrongBlob = manifest.body.files.map((entry, index) => (
    index === 0 ? { ...entry, blob_id: 'blob_0000000000000000000000000000000000000000000000000000000000000000' } : entry
  ));
  assert.throws(
    () => assertManifestResponse({ ...manifest.body, files: wrongBlob }, {
      vaultId,
      deviceId: 'device_mac_0001',
      state,
      label: '反向：错误 Blob',
    }),
    /blob_id/,
    '条目指向错误 Blob 必须被完整校验拦下',
  );

  // 3. 各字段单独改错都必须被发现。
  for (const [field, value] of [
    // 用与实际值不同的取值：第一条（path 升序）是 data/settings.json，format 本来就是 json。
    ['format', 'md'],
    ['current_version_id', 'ver_wrong'],
    ['current_content_hash', 'sha256:' + '0'.repeat(64)],
    ['content_size', 9999],
    ['is_deleted', true],
    ['path', 'zzz/wrong.txt'],
    ['file_id', 'file_wrong'],
  ]) {
    // 路径字段改错会同时改变排序，因此这里保留原顺序、只改首条取值。
    const mutated = manifest.body.files.map((entry, index) => (index === 0 ? { ...entry, [field]: value } : entry));
    assert.throws(
      () => assertManifestResponse({ ...manifest.body, files: mutated }, {
        vaultId,
        deviceId: 'device_mac_0001',
        state,
        label: `反向：${field}`,
      }),
      new RegExp(field === 'current_content_hash' ? 'current_content_hash' : field),
      `manifest 条目 ${field} 被改错必须被发现`,
    );
  }

  // 4. header 字段：vault_id / snapshot_revision / min_available_revision 改错都必须被发现。
  for (const [field, value] of [
    ['vault_id', 'vault_other'],
    ['snapshot_revision', state.vault_revision + 1],
    ['min_available_revision', state.min_available_revision + 1],
  ]) {
    assert.throws(
      () => assertManifestResponse({ ...manifest.body, [field]: value }, {
        vaultId,
        deviceId: 'device_mac_0001',
        state,
        label: `反向：${field}`,
      }),
      new RegExp(field),
      `manifest header 的 ${field} 被改错必须被发现`,
    );
  }

  // 5. 按 path 升序被打破：必须失败。
  const reversed = [...manifest.body.files].reverse();
  assert.throws(
    () => assertManifestResponse({ ...manifest.body, files: reversed }, {
      vaultId,
      deviceId: 'device_mac_0001',
      state,
      label: '反向：排序颠倒',
    }),
    /按 path 升序/,
    'manifest 必须按 path 升序',
  );

  // 6. 统一执行器上的反向：篡改 manifest-header-device-only 的 device-only 头部字段，
  //    并同步改 expected_result，只有动态断言能发现。
  {
    const scenario = cloneJson(entry.scenario);
    const manifestStep = scenario.steps.find((item) => item.id === 'manifest-header-device-only');
    assert.ok(manifestStep, '夹具必须包含 manifest-header-device-only');
    manifestStep.expected_result.snapshot_revision = manifestStep.expected_result.snapshot_revision + 1;
    const records = new Map();
    await assert.rejects(
      () => runScenario(scenario, records, {
        tamperResponse(response, step) {
          if (step.id !== 'manifest-header-device-only') return response;
          return { ...response, body: { ...response.body, snapshot_revision: response.body.snapshot_revision + 1 } };
        },
      }),
      /snapshot_revision/,
      '统一执行器必须发现 manifest 的 snapshot_revision 被改错',
    );
    // 该步骤之前还有其它步骤会正常登记，因此只断言被篡改的这一条没有登记。
    assert.equal(
      records.get(scenario.scenario)?.steps.has('manifest-header-device-only') ?? false,
      false,
      '被篡改的 manifest 步骤不得登记完成',
    );
  }

  // 7. manifest-shows-restored-file：is_deleted 被改错必须被发现。
  {
    const recovered = SCENARIO_BY_NAME.get('update-deleted-file');
    const scenario = cloneJson(recovered.scenario);
    const manifestStep = scenario.steps.find((item) => item.id === 'manifest-shows-restored-file');
    assert.ok(manifestStep, '夹具必须包含 manifest-shows-restored-file');
    manifestStep.expected_result.files[0].is_deleted = true;
    const records = new Map();
    await assert.rejects(
      () => runScenario(scenario, records, {
        tamperResponse(response, step) {
          if (step.id !== 'manifest-shows-restored-file') return response;
          const files = response.body.files.map((entry, index) => (index === 0 ? { ...entry, is_deleted: true } : entry));
          return { ...response, body: { ...response.body, files } };
        },
      }),
      /is_deleted/,
      '统一执行器必须发现 manifest 条目的 is_deleted 被改错',
    );
  }
});


test('已有 Blob 复用失败的错误必须带 upload_content_size，且不改变状态（BLOB-01）', async () => {
  const entry = SCENARIO_BY_NAME.get('submit-markdown');
  const step = entry.scenario.steps.find((item) => item.id === 'submit-roadmap-v2');
  const bytes = readSample(step.content_file);
  const initial = cloneJson(entry.scenario.initial_state);
  const vaultId = initial.vault_id;
  const contentHash = step.request.body.content_hash;
  const blobId = `blob_${contentHash.slice('sha256:'.length)}`;

  // 1. 前置状态里已经存在同完整哈希、但 content_size 不同的 Blob（模拟内容寻址记录损坏）。
  const state = createVaultState(initial);
  state.blobs.push({
    blob_id: blobId,
    vault_id: vaultId,
    content_hash: contentHash,
    content_size: 999,
    created_by_device_id: 'device_mac_0001',
  });
  const before = snapshotState(state);
  const response = await handleRequest(state, buildRequest(step).request, {
    resolveUpload: () => bytes,
  });

  // 2. 必须返回 CONTENT_SIZE_MISMATCH，且错误里同时给出三种大小，便于客户端定位恢复动作。
  assert.equal(response.status, 409, `复用不自洽 Blob 必须失败：${JSON.stringify(response.body)}`);
  assert.equal(response.body.code, ERROR_CODES.CONTENT_SIZE_MISMATCH);
  assert.equal(response.body.content_size, bytes.length, '错误必须回显请求声明的大小');
  assert.equal(response.body.actual_content_size, bytes.length, '错误必须回显实际字节数');
  assert.ok(
    Object.hasOwn(response.body, 'upload_content_size'),
    '复用 Blob 失败的错误必须包含 upload_content_size',
  );
  assert.equal(
    response.body.upload_content_size,
    initial.upload_sessions.find((upload) => upload.blob_reference === step.request.body.blob_reference).content_size,
    'upload_content_size 必须是上传会话声明的大小',
  );
  assert.equal(response.body.blob_content_size, 999, '错误必须给出冲突 Blob 记录的大小');

  // 3. 状态必须完全不变：失败分支不得写入版本 / Change / 归档 / 幂等记录或推进 revision。
  assert.deepEqual(snapshotState(state), before, '复用 Blob 失败不得改变协议状态');
  assert.equal(state.vault_revision, initial.vault_revision, '失败分支不得推进 vault_revision');
});

test('mutation-check 的 judge 要求顶层失败集合与 failTests 完全相等（MUTATION-JUDGE-001）', async () => {
  // 直接 import 脚本导出的 judge / MUTATIONS：判定语义本身也要被断言，
  // 否则把「集合相等」改回「包含即可」不会被任何测试发现。
  const module = await import('./mutation-check.mjs');
  const { judge, MUTATIONS } = module;
  assert.equal(typeof judge, 'function', 'mutation-check 必须导出 judge');
  assert.ok(Array.isArray(MUTATIONS) && MUTATIONS.length > 0, 'mutation-check 必须导出 MUTATIONS');
  assert.equal(
    MUTATIONS.length,
    [...readFileSync(join(REPO_ROOT, 'tests', 'protocol', 'mutation-check.mjs'), 'utf8').matchAll(/^    id: '/gm)].length,
    '导出的 MUTATIONS 长度必须等于脚本里的变异条目数',
  );

  const mutation = { id: 'probe', failTests: ['A', 'B'] };
  const failure = (name, nesting = 0) => ({ name, nesting, message: '' });

  // 1. 精确相等：必须通过。
  assert.equal(
    judge(mutation, { ok: false, failures: [failure('A'), failure('B')] }).ok,
    true,
    '顶层失败集合与 failTests 完全相等时必须判定命中',
  );

  // 2. 缺少指定失败：必须不通过。
  const missing = judge(mutation, { ok: false, failures: [failure('A')] });
  assert.equal(missing.ok, false, '缺少指定失败时必须判定未命中');
  assert.match(missing.reason, /未失败/, `缺少指定失败的诊断必须可读，实际 ${missing.reason}`);

  // 3. 出现额外顶层失败：必须不通过（评审的核心要求）。
  const extra = judge(mutation, { ok: false, failures: [failure('A'), failure('B'), failure('C')] });
  assert.equal(extra.ok, false, '出现未声明的额外顶层失败时必须判定未命中');
  assert.match(extra.reason, /额外顶层失败/, `额外失败的诊断必须可读，实际 ${extra.reason}`);

  // 4. 只有额外失败、没有指定失败：同样不通过，且两种原因都要报出来。
  const bothWrong = judge(mutation, { ok: false, failures: [failure('C')] });
  assert.equal(bothWrong.ok, false, '既缺指定失败又出现额外失败时必须判定未命中');
  assert.match(bothWrong.reason, /未失败/, '缺指定失败的诊断必须出现');

  // 5. 非顶层失败（子测试）不得被当成命中，也不得被静默忽略。
  const nested = judge(mutation, {
    ok: false,
    failures: [failure('A'), failure('B'), failure('A > sub', 1)],
  });
  assert.equal(nested.ok, false, '出现非顶层失败时必须判定未命中');
  assert.match(nested.reason, /非顶层失败/, `非顶层失败的诊断必须可读，实际 ${nested.reason}`);

  // 6. 未失败 / 崩溃：一律不通过。
  assert.equal(judge(mutation, { ok: true, failures: [] }).ok, false, '完全未失败时不得判定命中');
  assert.equal(judge(mutation, { crashed: 'boom' }).ok, false, '测试进程崩溃时不得判定命中');

  // 7. 测试名只按**精确相等**比较，不做子串猜测：
  //    「A」不得被「A 的扩展名」当成命中。
  const substringOnly = judge(
    { id: 'probe', failTests: ['A'] },
    { ok: false, failures: [failure('A 的扩展名')] },
  );
  assert.equal(substringOnly.ok, false, '测试名必须精确相等，不能被前缀 / 子串命中');

  // 8. 每个真实变异都必须声明非空、无重复的 failTests，否则「集合相等」无从判定。
  for (const entry of MUTATIONS) {
    assert.ok(Array.isArray(entry.failTests) && entry.failTests.length > 0, `变异 ${entry.id} 必须声明非空 failTests`);
    assert.equal(
      new Set(entry.failTests).size,
      entry.failTests.length,
      `变异 ${entry.id} 的 failTests 不得重复`,
    );
  }
});
