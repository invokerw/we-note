/**
 * 同步操作协议 v1 的最小内存契约模型。
 *
 * 该模块只做三件事：持有内存状态、按协议顺序做判定、返回响应。
 * 它不读取任何夹具文件、不读取 `expected_result` / `expected_state`，
 * 也不做网络、数据库或文件系统 I/O：待提交正文由调用方通过
 * `ctx.resolveUpload(blob_reference)` 以 Buffer 形式注入。
 *
 * 请求适配层支持两种入参：
 *   1. 内部对象 `{ method, endpoint, headers, body, query }`（保留原始类型，便于验证类型错误分支）；
 *   2. 标准 `Request`（浏览器 / Node 内置）。`handleRequest` 是 async 函数，会真正读取标准
 *      `Request` 的 URL、headers 与**请求体文本**，因此 `POST /sync/changes` 用标准 `Request`
 *      携带 JSON 正文时不会静默退化成「缺字段请求」。`GET /sync/manifest` 仍然是无正文请求，
 *      模型不会为它读取或要求正文。
 *
 * 判定顺序遵循设计文档第 20.1 节与任务书：
 *   1. 端点、HTTP 方法与路由 Vault 校验；三种模式都必须先通过必填标识校验
 *      （vault_id、device_id 缺一即 INVALID_REQUEST，缺失不得退化成 VAULT_MISMATCH）
 *   2. 字段类型与取值校验（含 operation 的类型）；之后才判断 operation 是否受支持
 *   3. Idempotency-Key 一致性
 *   4. 幂等账本查询（先返回首次结果，再谈文件基准）
 *   5. 目标文件基准校验（base_version_id / base_content_hash）
 *   6. 内容校验（大小与完整字节 SHA-256）
 *   7. 提交状态变化（Blob → 版本 → 文件指针 → Change → vault_revision）
 *   8. 拉取：按 min_available_revision 判定增量或 CURSOR_TOO_OLD
 *
 * 所有响应（**成功与错误**）都携带 `endpoint`、`method` 与 `allowed_method`，便于调用方定位
 * 「请求打到了哪里、用了什么方法、该端点允许什么方法」；`allowed_method` 在端点不属于
 * 协议时为 `null`。`submit`（首次与重放）、`pull`、`manifest` 三种成功响应同样如此。
 *
 * `request_id` 格式是 `req_` + 恰好六位数字，可用序号范围 1..999999。序号用尽时返回
 * `REQUEST_ID_EXHAUSTED`，绝不静默生成七位的 `req_1000000`。
 */

import { createHash } from 'node:crypto';

export const PROTOCOL_VERSION = 'sync-v1';

export const ENDPOINTS = {
  manifest: '/api/v1/vaults/{vault_id}/sync/manifest',
  changes: '/api/v1/vaults/{vault_id}/sync/changes',
};

/** 方法与路径是联合契约：changes 只接受 POST，manifest 只接受 GET。 */
export const METHODS = {
  changes: 'POST',
  manifest: 'GET',
};

export const ERROR_CODES = {
  INVALID_REQUEST: 'INVALID_REQUEST',
  VAULT_MISMATCH: 'VAULT_MISMATCH',
  ENDPOINT_NOT_FOUND: 'ENDPOINT_NOT_FOUND',
  METHOD_NOT_ALLOWED: 'METHOD_NOT_ALLOWED',
  MODE_REQUIRED: 'MODE_REQUIRED',
  FILE_NOT_FOUND: 'FILE_NOT_FOUND',
  PATH_MISMATCH: 'PATH_MISMATCH',
  FORMAT_MISMATCH: 'FORMAT_MISMATCH',
  OPERATION_NOT_SUPPORTED: 'OPERATION_NOT_SUPPORTED',
  BASE_REQUIRED: 'BASE_REQUIRED',
  IDEMPOTENCY_KEY_MISMATCH: 'IDEMPOTENCY_KEY_MISMATCH',
  IDEMPOTENCY_KEY_REUSED: 'IDEMPOTENCY_KEY_REUSED',
  FILE_VERSION_CONFLICT: 'FILE_VERSION_CONFLICT',
  CONTENT_HASH_MISMATCH: 'CONTENT_HASH_MISMATCH',
  CONTENT_SIZE_MISMATCH: 'CONTENT_SIZE_MISMATCH',
  UPLOAD_NOT_READY: 'UPLOAD_NOT_READY',
  CURSOR_TOO_OLD: 'CURSOR_TOO_OLD',
  REQUEST_ID_EXHAUSTED: 'REQUEST_ID_EXHAUSTED',
  REVISION_EXHAUSTED: 'REVISION_EXHAUSTED',
};

/** 主设计第 9.3 节列出的全部操作名。v1 只冻结 update_file_content 的写入行为。 */
export const OPERATION_TYPES = [
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
];

export const EXECUTABLE_OPERATIONS = ['update_file_content'];

/**
 * 会「产生一个新版本」的操作。只有这些操作的 Change 必须与版本同 revision
 * 一一对应；删除 / 移动 / 重命名等操作复用已有版本，Change 指向的版本可以更早。
 */
export const VERSION_CREATING_OPERATIONS = ['create_file', 'update_file_content', 'restore_file'];

/** 上传会话在夹具中的合法状态；只有 `completed` 可以用于提交。 */
export const UPLOAD_STATUSES = ['pending', 'completed', 'failed'];

const KNOWN_OPERATIONS = new Set(OPERATION_TYPES);
const EXECUTABLE = new Set(EXECUTABLE_OPERATIONS);
const VERSION_CREATING = new Set(VERSION_CREATING_OPERATIONS);

const SHA256_RE = /^sha256:[0-9a-f]{64}$/;
/** `request_id` 是 `req_` + **恰好**六位数字，因此可用序号只能落在 1..999999。 */
const REQUEST_ID_DIGITS = 6;
const MAX_REQUEST_SEQUENCE = 10 ** REQUEST_ID_DIGITS - 1;
/** `req_000000` 不是合法的追踪标识：序号从 1 开始。 */
const REQUEST_ID_RE = /^req_[0-9]{6}$/;

/**
 * 严格解析 `request_id`：**先**要求 `typeof === 'string'`，再用正则与数值范围判定。
 * 若只做 `REQUEST_ID_RE.test(value)`，数组或数字会被正则隐式转换成字符串
 * （`['req_000001'] -> 'req_000001'`、`123456 -> '123456'`），
 * 于是 `["req_000001"]` 这类明显错误的类型也能通过加载校验。
 */
const parseRequestId = (value) => {
  if (typeof value !== 'string' || !REQUEST_ID_RE.test(value)) return null;
  const number = Number(value.slice('req_'.length));
  if (!Number.isSafeInteger(number) || number < 1 || number > MAX_REQUEST_SEQUENCE) return null;
  return number;
};

/**
 * revision 也必须落在可安全表示的整数范围内。
 * `Number.MAX_SAFE_INTEGER` 是能安全表示的最大整数；一旦到达上界，
 * `MAX_SAFE_INTEGER + 1` 已经是 2^53，超出安全整数范围，
 * 继续加一会因浮点舍入停在同一个值上，等于「加一后复用同一个 revision」。
 * 因此达到上界后不能再安全分配新 revision，提交前必须检测耗尽。
 */
const MAX_SAFE_REVISION = Number.MAX_SAFE_INTEGER;

/**
 * `client_timestamp` 只接受 RFC 3339 的 UTC 形式，必须以 `Z` 结尾。
 * 正则只负责形状，年月日与时分秒的取值必须逐项校验：
 * `Date.parse` 会把 `2026-02-29T09:05:00Z` 之类的非法日期静默进位，不能作为判定依据。
 */
const RFC3339_UTC_RE = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})(?:\.\d{1,9})?Z$/;

const daysInMonth = (year, month) => {
  if (month === 2) {
    const isLeapYear = (year % 4 === 0 && year % 100 !== 0) || year % 400 === 0;
    return isLeapYear ? 29 : 28;
  }
  return [31, 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31][month - 1] ?? 0;
};

/** `metadata.format` 的 v1 取值，后续可扩展；`metadata.line_ending` 的取值是封闭枚举。 */
export const METADATA_FORMATS = ['md', 'txt', 'json', 'xmind'];
export const LINE_ENDINGS = ['lf', 'crlf'];

const isNonEmptyString = (value) => typeof value === 'string' && value.length > 0;
const isNonNegativeInt = (value) => Number.isSafeInteger(value) && value >= 0;
const isSha256 = (value) => typeof value === 'string' && SHA256_RE.test(value);
const isPlainObject = (value) => typeof value === 'object' && value !== null && !Array.isArray(value);

/**
 * 状态与夹具之间必须**深拷贝**：metadata / body / headers / result 都是可变的嵌套对象。
 * 只做一层展开会让「修改 state.versions[i].metadata」同时改坏旧快照与夹具原文。
 */
const deepClone = (value) => (value === undefined ? undefined : structuredClone(value));
const isRfc3339Utc = (value) => {
  if (typeof value !== 'string') return false;
  const match = RFC3339_UTC_RE.exec(value);
  if (!match) return false;
  const [, yearText, monthText, dayText, hourText, minuteText, secondText] = match;
  const year = Number(yearText);
  const month = Number(monthText);
  const day = Number(dayText);
  const hour = Number(hourText);
  const minute = Number(minuteText);
  const second = Number(secondText);
  if (month < 1 || month > 12) return false;
  if (day < 1 || day > daysInMonth(year, month)) return false;
  // RFC 3339 的 `time-second` 取值范围是 00–59；闰秒 60 需要额外约定，v1 不接受。
  if (hour > 23 || minute > 59 || second > 59) return false;
  return true;
};
const pad = (value, width) => String(value).padStart(width, '0');
const requestNumber = (value) => parseRequestId(value);

export const sha256Of = (bytes) => `sha256:${createHash('sha256').update(bytes).digest('hex')}`;

/**
 * 内容寻址：同一份字节在同一个 Vault 内复用同一个 Blob。
 * Blob 标识使用**完整** SHA-256，而不是截断前缀：
 * 不同完整哈希可能共享同一段前缀，按前缀命名会把两份不同字节折叠成同一个 Blob。
 */
export const blobIdForHash = (contentHash) => {
  if (!isSha256(contentHash)) throw new Error(`invalid content hash: ${String(contentHash)}`);
  return `blob_${contentHash.slice('sha256:'.length)}`;
};

/**
 * 版本标识必须在 Vault 内尚未占用。不能只用「该文件已有版本数 + 1」，
 * 否则初态里合法出现 `ver_roadmap_02` 时，下一次提交会生成同名版本，
 * 新版本与父版本指向同一个标识。
 */
const versionIdFor = (state, fileId) => {
  const slug = fileId.startsWith('file_') ? fileId.slice('file_'.length) : fileId;
  const used = new Set(state.versions.map((version) => version.version_id));
  let ordinal = state.versions.filter((version) => version.file_id === fileId).length + 1;
  let candidate = `ver_${slug}_${pad(ordinal, 2)}`;
  while (used.has(candidate)) {
    ordinal += 1;
    candidate = `ver_${slug}_${pad(ordinal, 2)}`;
  }
  return candidate;
};

const baseChangeIdFor = (revision) => `chg_${pad(revision, 6)}`;

/**
 * `change_id` 在 Vault 内必须**全局唯一**：默认由 revision 派生，
 * 若历史里已经占用同名标识（例如被迁移或导入的旧数据），追加后缀而不是直接复用。
 */
const changeIdFor = (state, revision) => {
  const used = new Set(state.changes.map((change) => change.change_id));
  const base = baseChangeIdFor(revision);
  if (!used.has(base)) return base;
  let suffix = 2;
  while (used.has(`${base}_${suffix}`)) suffix += 1;
  return `${base}_${suffix}`;
};

const normalizePath = (value) => (typeof value === 'string' ? value.normalize('NFC') : value);

const isNormalizedPath = (value) =>
  isNonEmptyString(value) &&
  !value.startsWith('/') &&
  !value.includes('\\') &&
  !value.includes('\u0000') &&
  value.split('/').every((segment) => segment !== '' && segment !== '.' && segment !== '..');

export const stableStringify = (value) => {
  if (value === null || typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(',')}]`;
  const keys = Object.keys(value).sort();
  return `{${keys.map((key) => `${JSON.stringify(key)}:${stableStringify(value[key])}`).join(',')}}`;
};

/** 幂等指纹只覆盖请求内容，不含路由与追踪信息。 */
const payloadFingerprint = (body) => sha256Of(Buffer.from(stableStringify(body), 'utf8'));

const fail = (requestId, status, code, message, fields, envelope) => ({
  status,
  body: {
    protocol_version: PROTOCOL_VERSION,
    request_id: requestId,
    ...envelope,
    code,
    message,
    ...fields,
  },
});

/**
 * 成功响应与错误响应共用同一组定位字段：`endpoint` / `method` / `allowed_method`。
 * 展开顺序是「业务字段 → 定位字段」，因此定位字段始终回显真实请求；
 * 端点不属于协议时 `allowed_method` 为 `null`，但字段本身始终存在。
 */
const ok = (requestId, fields, envelope) => ({
  status: 200,
  body: {
    protocol_version: PROTOCOL_VERSION,
    request_id: requestId,
    ...fields,
    // 定位字段最后展开：即使业务字段意外同名，回显的也一定是真实请求的路径 / 方法 / 允许方法。
    ...envelope,
  },
});

const missingFields = (body, fields) => fields.filter((field) => body[field] === undefined || body[field] === null);

/** 请求头名大小写无关：HTTP 字段名不区分大小写，不能只识别两种拼写。 */
const headerValue = (headers, name) => {
  if (!isPlainObject(headers)) return undefined;
  const target = name.toLowerCase();
  for (const [key, value] of Object.entries(headers)) {
    if (key.toLowerCase() === target) return value;
  }
  return undefined;
};

/**
 * GET 请求没有正文，标识从 request.query 或 request.url 读取。
 * 内部 `query` 对象保留原始类型（用于验证「类型错误」分支）；
 * 标准 `Request` / URL 解析出的查询串天然都是字符串。
 *
 * 注意：查询串只用于 manifest 的 `device_id` 以及「与路由一致的 vault_id」校验，
 * 绝不会被当成 `submit` / `pull` 的请求体字段来源。
 */
const queryLookup = (request) => {
  if (request?.query instanceof URLSearchParams) {
    return (key) => request.query.get(key) ?? undefined;
  }
  if (isPlainObject(request?.query)) {
    return (key) => (Object.hasOwn(request.query, key) ? request.query[key] : undefined);
  }
  if (typeof request?.url === 'string') {
    const queryIndex = request.url.indexOf('?');
    const params = new URLSearchParams(queryIndex >= 0 ? request.url.slice(queryIndex + 1) : '');
    return (key) => params.get(key) ?? undefined;
  }
  return () => undefined;
};

/**
 * 标识字段的「有且合法」判定。缺失、null、空串与类型错误统一归入 INVALID_REQUEST，
 * 并在 missing_fields 中列出问题字段；协议文档与实现共用这一条规则。
 */
const invalidIdentifierFields = (body, fields) =>
  fields.filter((field) => !isNonEmptyString(body?.[field]));

/**
 * 解析协议路由。
 *
 * 路径里的 Vault 段在标准 `Request` 的 `url.pathname` 中是**百分号编码**的
 * （非 ASCII 的 Vault ID 例如 `vault_中文` 会变成 `vault_%E4%B8%AD%E6%96%87`）。
 * 因此必须解码路径段后再与 `state.vault_id` 比较，否则标准 Request 永远无法
 * 访问非 ASCII Vault。非法百分号编码（例如 `%ZZ`、被截断的 `%E4`）解码会抛
 * `URIError`：这里捕获后返回 `null`，由调用方转成稳定的 `ENDPOINT_NOT_FOUND`，
 * 绝不能让未捕获异常穿透到请求处理之外。
 *
 * 响应里的 `endpoint` 仍回显**实际请求路径**（编码后的原串），本函数只用于识别路由。
 */
const parseEndpoint = (endpoint) => {
  if (typeof endpoint !== 'string') return null;
  const match = /^\/api\/v1\/vaults\/([^/]+)\/sync\/(changes|manifest)$/.exec(endpoint);
  if (!match) return null;
  let vaultFromRoute;
  try {
    vaultFromRoute = decodeURIComponent(match[1]);
  } catch {
    // 非法百分号编码不是任何协议的端点：返回 null → ENDPOINT_NOT_FOUND。
    return null;
  }
  // 解码后仍必须是一个完整的路径段：`%2F` 解码成 `/` 会跨越段边界，不能当成 Vault 标识。
  if (vaultFromRoute.length === 0 || vaultFromRoute.includes('/')) return null;
  return { kind: match[2], vaultFromRoute };
};

/**
 * `metadata.line_ending` 的跨记录比对必须同时比较**字段存在性**与取值。
 *
 * `(a ?? null) !== (b ?? null)` 会把「字段缺失」和「字段显式为 null」抹平成同一个值：
 * 一侧省略、另一侧显式写 `null` 时会被当成相等而静默通过。协议只允许两种写法：
 * 双方都省略（可选字段），或双方都出现且取值相同。任一方显式 `null`、任一方缺失、
 * 或取值不同都必须失败；出现该字段时取值必须是 `lf` / `crlf`。
 */
const lineEndingPresenceProblems = (actual, expected, label) => {
  const problems = [];
  const actualHas = isPlainObject(actual) && Object.hasOwn(actual, 'line_ending');
  const expectedHas = isPlainObject(expected) && Object.hasOwn(expected, 'line_ending');
  if (actualHas && !LINE_ENDINGS.includes(actual.line_ending)) {
    problems.push(`${label} 的 metadata.line_ending ${JSON.stringify(actual.line_ending)} 必须是 ${LINE_ENDINGS.join(' / ')} 之一`);
  }
  if (expectedHas && !LINE_ENDINGS.includes(expected.line_ending)) {
    problems.push(`${label} 的对照 metadata.line_ending ${JSON.stringify(expected.line_ending)} 必须是 ${LINE_ENDINGS.join(' / ')} 之一`);
  }
  if (actualHas !== expectedHas) {
    problems.push(
      `${label} 的 metadata.line_ending 字段存在性不一致（实际${actualHas ? '出现' : '缺失'}，对照${expectedHas ? '出现' : '缺失'}）`,
    );
  } else if (actualHas && actual.line_ending !== expected.line_ending) {
    problems.push(`${label} 的 metadata.line_ending ${JSON.stringify(actual.line_ending)} 与对照 ${JSON.stringify(expected.line_ending)} 不一致`);
  }
  return problems;
};

/**
 * 历史 Change 与它指向的版本必须逐项自洽：
 * 版本属于同一 file_id、revision 一致、blob/哈希/大小一致、父版本一致，
 * 且设备与时间戳一致。任一项不符都说明夹具自相矛盾，不能用来证明任何协议行为。
 *
 * 历史 Change 的必填字段按「存在 + 类型 + 值域」逐项校验：`created_at`、
 * `parent_version_id` 这类可空字段也必须显式出现（父版本可为 `null`）。
 * `change.path` 还必须等于对应文件的当前路径：历史 Change、file 与首次结果
 * 三方路径必须互相绑定，否则「同一条 Change 指向另一条路径」也能通过加载。
 *
 * 只有**由保留的 create_file / update_file_content / restore_file Change 产生**的版本
 * 才强制 created_by_device_id、created_at、metadata 对象与首次请求逐项一致。
 * delete_file / delete_directory 等「复用已有版本」的 Change 不能因为该版本缺少
 * metadata 而被误拒：压缩后只保留删除 Change 的合法状态必须仍能通过加载。
 */
const historicalChangeProblems = (change, version, filesById, firstRequestMetadata) => {
  const problems = [];
  const changeId = change?.change_id;
  if (!isNonEmptyString(changeId)) problems.push('Change 缺少 change_id');
  if (!isNonEmptyString(change.operation_id)) problems.push(`Change ${changeId} 缺少 operation_id`);
  if (!isNonEmptyString(change.device_id)) problems.push(`Change ${changeId} 缺少 device_id`);
  if (!isRfc3339Utc(change.client_timestamp)) problems.push(`Change ${changeId} 的 client_timestamp 不是 RFC 3339 UTC`);
  if (!isRfc3339Utc(change.created_at)) problems.push(`Change ${changeId} 的 created_at 不是 RFC 3339 UTC`);
  if (!isNonEmptyString(change.vault_id)) problems.push(`Change ${changeId} 缺少 vault_id`);
  if (!isNonEmptyString(change.version_id)) problems.push(`Change ${changeId} 缺少 version_id`);
  if (!Object.hasOwn(change, 'parent_version_id')) {
    problems.push(`Change ${changeId} 必须显式声明 parent_version_id（无父版本时为 null）`);
  } else if (change.parent_version_id !== null && !isNonEmptyString(change.parent_version_id)) {
    problems.push(`Change ${changeId} 的 parent_version_id 必须是字符串或 null`);
  }
  if (!isSha256(change.content_hash)) problems.push(`Change ${changeId} 的 content_hash 不合法`);
  if (!isNonNegativeInt(change.content_size)) problems.push(`Change ${changeId} 的 content_size 不合法`);
  const file = isNonEmptyString(change.file_id) ? filesById.get(change.file_id) : undefined;
  if (!isNonEmptyString(change.file_id)) {
    problems.push(`Change ${changeId} 缺少 file_id`);
  } else if (!file) {
    problems.push(`Change ${changeId} 指向未知文件 ${change.file_id}`);
  }
  if (!isNormalizedPath(change.path) || normalizePath(change.path) !== change.path) {
    problems.push(`Change ${changeId} 的 path 未规范化: ${JSON.stringify(change.path)}`);
  } else if (file && file.path !== change.path) {
    // 历史 Change 与文件的当前路径必须一致：内容更新不改路径，移动/重命名不在 v1 内。
    problems.push(
      `Change ${changeId} 的 path ${JSON.stringify(change.path)} 与文件 ${change.file_id} 的当前路径 ${JSON.stringify(file.path)} 不一致`,
    );
  }
  if (!KNOWN_OPERATIONS.has(change.operation)) {
    problems.push(`Change ${changeId} 的 operation ${JSON.stringify(change.operation)} 不在第 9.3 节操作名内`);
  }
  if (!version) {
    problems.push(`Change ${changeId} 的 version_id ${JSON.stringify(change.version_id)} 不存在`);
    return problems;
  }
  if (version.file_id !== change.file_id) {
    problems.push(`Change ${changeId} 的版本 ${version.version_id} 属于文件 ${version.file_id}，与该 Change 的 file_id 不一致`);
  }
  // 任何 Change 都不能引用未来的版本：删除 / 复用版本同样受此约束。
  if (isNonNegativeInt(version.vault_revision) && isNonNegativeInt(change.vault_revision) && version.vault_revision > change.vault_revision) {
    problems.push(
      `Change ${changeId}（revision ${change.vault_revision}）引用了未来版本 ${version.version_id}（revision ${version.vault_revision}）`,
    );
  }
  if (version.vault_revision !== change.vault_revision) {
    // 「版本与 Change 同 revision」只对产生新版本的操作成立：删除 / 移动 / 重命名
    // 等操作复用已有版本，Change 指向的版本可以更早。
    if (VERSION_CREATING.has(change.operation)) {
      problems.push(
        `Change ${changeId} 的 vault_revision ${change.vault_revision} 与版本 ${version.version_id} 的 ${version.vault_revision} 不一致`,
      );
    }
  }
  if (version.content_hash !== change.content_hash) {
    problems.push(`Change ${changeId} 的 content_hash 与版本 ${version.version_id} 不一致`);
  }
  if (version.content_size !== change.content_size) {
    problems.push(`Change ${changeId} 的 content_size 与版本 ${version.version_id} 不一致`);
  }
  // 只有「产生新版本」的操作才要求版本与 Change 的父版本一致；
  // delete_file / rename_file 等复用已有版本，它们的 parent_version_id 表示别的语义。
  if (VERSION_CREATING.has(change.operation) && (version.base_version_id ?? null) !== (change.parent_version_id ?? null)) {
    problems.push(`Change ${changeId} 的 parent_version_id 与版本 ${version.version_id} 的 base_version_id 不一致`);
  }
  // 「有对应 Change 的历史版本必须记录创建设备与创建时间」同样只适用于产生新版本的操作。
  if (VERSION_CREATING.has(change.operation)) {
    // 有对应 Change 的历史版本必须记录创建设备与创建时间，且与 Change 逐项相等。
    // 「只在字段存在时比较」会让删除字段的初态静默通过，历史版本因此失去时间与设备来源。
    if (!isNonEmptyString(version.created_by_device_id)) {
      problems.push(`版本 ${version.version_id}（对应 Change ${changeId}）缺少 created_by_device_id`);
    } else if (version.created_by_device_id !== change.device_id) {
      problems.push(`Change ${changeId} 的 device_id 与版本 ${version.version_id} 的创建设备不一致`);
    }
    if (!isRfc3339Utc(version.created_at)) {
      problems.push(`版本 ${version.version_id}（对应 Change ${changeId}）缺少合法的 created_at`);
    } else if (version.created_at !== change.client_timestamp) {
      problems.push(`Change ${changeId} 的 client_timestamp 与版本 ${version.version_id} 的 created_at 不一致`);
    }
    // 有对应版本创建 Change 的历史版本必须保存提交时用于核对的 metadata（format 与 line_ending）。
    // 「只在字段存在时比较」会让删除字段或单方删除 line_ending 的初态静默通过：
    // 版本因此失去可追溯的写入格式，重放得到的结果也无法与请求核对。
    //
    // 这一条对**每一个**由 `create_file` / `update_file_content` / `restore_file` 产生的版本
    // 都成立，而不只是文件当前指针指向的那个版本：历史中间版本同样是可追溯的写入结果。
    if (!isPlainObject(version.metadata)) {
      problems.push(`版本 ${version.version_id}（对应 Change ${changeId}）缺少 metadata 对象`);
    } else {
      if (!METADATA_FORMATS.includes(version.metadata.format)) {
        problems.push(
          `版本 ${version.version_id} 的 metadata.format ${JSON.stringify(version.metadata.format)} 必须是 ${METADATA_FORMATS.join(' / ')} 之一`,
        );
      }
      // 版本格式必须等于所属文件的格式：同一文件的内容更新不能改变格式。
      const fileForVersion = filesById.get(version.file_id);
      const fileFormat = fileForVersion?.format;
      if (METADATA_FORMATS.includes(version.metadata.format) && METADATA_FORMATS.includes(fileFormat)) {
        if (version.metadata.format !== fileFormat) {
          problems.push(
            `版本 ${version.version_id} 的 metadata.format ${JSON.stringify(version.metadata.format)} 与文件 ${version.file_id} 的 format ${JSON.stringify(fileFormat)} 不一致`,
          );
        }
      }
      // 若该写入操作有可追溯的首次请求（幂等账本），版本 metadata 必须与请求逐项相同：
      // format 必填且相等，line_ending 的**存在性**与取值都要相等（单方增删也算不一致）。
      if (isPlainObject(firstRequestMetadata)) {
        if (version.metadata.format !== firstRequestMetadata.format) {
          problems.push(
            `版本 ${version.version_id} 的 metadata.format 与首次请求的 metadata.format 不一致`,
          );
        }
        problems.push(...lineEndingPresenceProblems(version.metadata, firstRequestMetadata, `版本 ${version.version_id}`));
      } else if (Object.hasOwn(version.metadata, 'line_ending') && !LINE_ENDINGS.includes(version.metadata.line_ending)) {
        // 没有可追溯首次请求时（例如只保留了创建事件的压缩历史），至少要拒绝越界的枚举值。
        problems.push(
          `版本 ${version.version_id} 的 metadata.line_ending ${JSON.stringify(version.metadata.line_ending)} 必须是 ${LINE_ENDINGS.join(' / ')} 之一`,
        );
      }
    }
  }
  return problems;
};

/**
 * 首次请求体与历史版本 / Change / 父版本必须逐项一致。
 *
 * 这里做的是**完整**校验，而不只是比对少数几个字段：
 *   - 每个提交字段都必须存在、类型正确、取值落在协议允许的范围内
 *     （`blob_reference`、`content_hash`、`content_size`、`metadata.format` /
 *     `metadata.line_ending`、`client_timestamp`、`operation`、`path`、`vault_id`、
 *     `device_id`、`operation_id`、`base_revision`、`mode`、基准字段），
 *   - 再与历史 Change / 版本逐项比对取值。
 * 只有这样才能保证「账本通过加载 ⇒ 原样重放一定命中首次结果」，而不是等到重放时
 * 才因为字段缺失返回 `INVALID_REQUEST`。
 */
const historicalRequestProblems = (requestBody, context) => {
  const { change, version, parentVersion, file, vaultId, uploads } = context;
  const problems = [];

  // ---- 1. 存在性与类型 / 值域 ----
  if (requestBody.mode !== 'submit') problems.push('首次请求 mode 必须为 submit');
  for (const field of [
    'vault_id',
    'device_id',
    'operation_id',
    'file_id',
    'operation',
    'path',
    'blob_reference',
    'content_hash',
  ]) {
    if (!isNonEmptyString(requestBody[field])) {
      problems.push(`首次请求的 ${field} 必须是非空字符串`);
    }
  }
  if (requestBody.content_hash !== undefined && !isSha256(requestBody.content_hash)) {
    problems.push(`首次请求的 content_hash 不是 sha256:<小写十六进制>`);
  }
  if (!isNonNegativeInt(requestBody.content_size)) {
    problems.push('首次请求的 content_size 必须是非负整数');
  }
  if (!isRfc3339Utc(requestBody.client_timestamp)) {
    problems.push('首次请求的 client_timestamp 不是 RFC 3339 UTC 时间');
  }
  if (!KNOWN_OPERATIONS.has(requestBody.operation)) {
    problems.push(`首次请求的 operation ${JSON.stringify(requestBody.operation)} 不在第 9.3 节操作名内`);
  } else if (!EXECUTABLE.has(requestBody.operation)) {
    // 可重放的首次请求必须是本模型可执行的操作；否则重放会先撞上 OPERATION_NOT_SUPPORTED。
    problems.push(
      `首次请求的 operation ${JSON.stringify(requestBody.operation)} 不是本模型可执行操作，重放无法命中首次结果`,
    );
  }
  if (!isNormalizedPath(requestBody.path) || normalizePath(requestBody.path) !== requestBody.path) {
    problems.push(`首次请求的 path 未规范化: ${JSON.stringify(requestBody.path)}`);
  }
  if (!isNonNegativeInt(requestBody.base_revision)) {
    problems.push('首次请求缺少合法的 base_revision');
  }

  const metadata = requestBody.metadata;
  if (!isPlainObject(metadata)) {
    problems.push('首次请求缺少 metadata 对象');
  } else {
    if (!METADATA_FORMATS.includes(metadata.format)) {
      problems.push(`首次请求的 metadata.format ${JSON.stringify(metadata.format)} 必须是 ${METADATA_FORMATS.join(' / ')} 之一`);
    }
    if (Object.hasOwn(metadata, 'line_ending') && !LINE_ENDINGS.includes(metadata.line_ending)) {
      problems.push(
        `首次请求的 metadata.line_ending ${JSON.stringify(metadata.line_ending)} 必须是 ${LINE_ENDINGS.join(' / ')} 之一`,
      );
    }
  }

  // 基准字段：至少提供一项；已提供的必须类型正确。
  const providedVersion = requestBody.base_version_id !== undefined && requestBody.base_version_id !== null;
  const providedHash = requestBody.base_content_hash !== undefined && requestBody.base_content_hash !== null;
  if (!providedVersion && !providedHash) {
    problems.push('首次请求必须提供 base_version_id 或 base_content_hash');
  }
  if (providedVersion && !isNonEmptyString(requestBody.base_version_id)) {
    problems.push('首次请求的 base_version_id 必须是非空字符串');
  }
  if (providedHash && !isSha256(requestBody.base_content_hash)) {
    problems.push('首次请求的 base_content_hash 不是 sha256:<小写十六进制>');
  }

  // ---- 2. 与历史 Change / 版本 / 文件逐项比对 ----
  const mismatches = [
    ['vault_id', requestBody.vault_id, vaultId],
    ['file_id', requestBody.file_id, change.file_id],
    ['path', requestBody.path, change.path],
    ['operation', requestBody.operation, change.operation],
    ['operation_id', requestBody.operation_id, change.operation_id],
    ['content_hash', requestBody.content_hash, change.content_hash],
    ['content_size', requestBody.content_size, change.content_size],
    ['device_id', requestBody.device_id, change.device_id],
    ['client_timestamp', requestBody.client_timestamp, change.client_timestamp],
  ];
  // 基准是「至少一项」：只有提供了的那一项才参与与历史父版本的比对。
  // 单哈希提交（只有 base_content_hash）必须能通过加载并原样重放。
  if (providedVersion) {
    mismatches.push(['base_version_id', requestBody.base_version_id, version.base_version_id ?? null]);
  }
  const filtered = mismatches.filter(([, actual, expected]) => actual !== expected);
  if (filtered.length > 0) {
    problems.push(
      `首次请求与历史 Change 不一致: ${filtered
        .map(([field, actual, expected]) => `${field}=${JSON.stringify(actual)} 期望 ${JSON.stringify(expected)}`)
        .join(', ')}`,
    );
  }
  if (isPlainObject(metadata) && file && metadata.format !== file.format) {
    problems.push(
      `首次请求的 metadata.format ${JSON.stringify(metadata.format)} 与目标文件格式 ${JSON.stringify(file.format)} 不一致`,
    );
  }
  // 版本自身保存的 metadata 必须与首次请求**逐项相同**：format 必填，line_ending 单方增删都算不一致。
  // 这里同样不能把「字段缺失」与「显式 null」用 `?? null` 抹平：请求与版本双方都省略
  // （可选字段）才允许，任一方出现就必须逐项相等且取值在 `lf` / `crlf` 内。
  if (isPlainObject(metadata) && isPlainObject(version.metadata)) {
    if (version.metadata.format !== metadata.format) {
      problems.push(`首次请求的 metadata.format 与历史版本的 metadata.format 不一致`);
    }
    problems.push(...lineEndingPresenceProblems(metadata, version.metadata, '首次请求与历史版本'));
  }
  // 基准哈希必须等于父版本的完整哈希：否则「首次请求」与它声明的父版本不是同一份内容。
  if (providedHash) {
    const expectedBaseHash = parentVersion ? parentVersion.content_hash : null;
    if (requestBody.base_content_hash !== expectedBaseHash) {
      problems.push(
        `首次请求的 base_content_hash ${JSON.stringify(requestBody.base_content_hash)} 与父版本的 content_hash ${JSON.stringify(expectedBaseHash)} 不一致`,
      );
    }
  }
  // 写入前应用的是 revision N-1；首次写入占用 revision N，因此 base_revision <= N-1。
  if (isNonNegativeInt(requestBody.base_revision) && requestBody.base_revision > change.vault_revision - 1) {
    problems.push(
      `首次请求的 base_revision ${requestBody.base_revision} 不能超过首次写入 revision ${change.vault_revision} 之前的 revision ${change.vault_revision - 1}`,
    );
  }

  // ---- 3. blob_reference 必须与可留存的原始内容、历史版本 / Blob 三方一致 ----
  // 只核对引用字符串会把「换成同一夹具里另一个有效样本」当成合法首次请求。
  if (isNonEmptyString(requestBody.blob_reference)) {
    const upload = (uploads ?? []).find(
      (entry) => entry.blob_reference === requestBody.blob_reference && entry.vault_id === vaultId,
    );
    if (!upload) {
      problems.push(`首次请求的 blob_reference ${requestBody.blob_reference} 没有可留存的上传样本`);
    } else {
      if (upload.status !== 'completed') {
        problems.push(`首次请求的 blob_reference ${requestBody.blob_reference} 的上传会话不是 completed`);
      }
      if (!isSha256(upload.content_hash) || upload.content_hash !== requestBody.content_hash) {
        problems.push(
          `首次请求的 blob_reference ${requestBody.blob_reference} 的上传样本哈希与请求 content_hash 不一致`,
        );
      }
      if (upload.content_size !== requestBody.content_size) {
        problems.push(
          `首次请求的 blob_reference ${requestBody.blob_reference} 的上传样本大小与请求 content_size 不一致`,
        );
      }
    }
    if (isPlainObject(version) && version.blob_id && blobIdForHash(change.content_hash) !== version.blob_id) {
      problems.push(`历史版本 ${version.version_id} 的 Blob 引用与 Change 的完整内容哈希不一致`);
    }
  }
  return problems;
};

/** 账本结果必须与历史 Change / 版本逐项一致（含 vault_id、device_id、blob 与内容）。 */
const historicalResultProblems = (result, context) => {
  const { change, version, operationId } = context;
  const mismatches = [
    ['change_id', result.change_id, change.change_id],
    ['version_id', result.version_id, change.version_id],
    ['file_id', result.file_id, change.file_id],
    ['path', result.path, change.path],
    ['vault_revision', result.vault_revision, change.vault_revision],
    ['content_hash', result.content_hash, change.content_hash],
    ['content_size', result.content_size, change.content_size],
    ['parent_version_id', result.parent_version_id ?? null, change.parent_version_id ?? null],
    ['operation_id', result.operation_id, operationId],
    ['device_id', result.device_id, change.device_id],
    ['vault_id', result.vault_id, change.vault_id],
    ['blob_id', result.blob_id, version.blob_id],
  ].filter(([, actual, expected]) => actual !== expected);
  const problems = [];
  if (mismatches.length > 0) {
    problems.push(
      `幂等账本 ${operationId} 与历史 Change 不一致: ${mismatches
        .map(([field, actual, expected]) => `${field}=${JSON.stringify(actual)} 期望 ${JSON.stringify(expected)}`)
        .join(', ')}`,
    );
  }
  if (result.mode !== 'submit') problems.push(`幂等账本 ${operationId} 的结果 mode 必须为 submit`);
  if (result.replayed !== false) problems.push(`幂等账本 ${operationId} 的结果 replayed 必须为 false`);
  if (result.protocol_version !== PROTOCOL_VERSION) {
    problems.push(`幂等账本 ${operationId} 的结果 protocol_version 必须为 ${PROTOCOL_VERSION}`);
  }
  return problems;
};

/**
 * 从历史幂等账本与 `request_log` 推导已经用过的 `request_id` 序号。
 * 请求跟踪标识不能与历史冲突：删掉 `initial_state.request_sequence` 后
 * 必须仍能推出安全的下一个值。
 */
const usedRequestNumbers = (initialState) => {
  const numbers = [];
  for (const entry of collectionOf(initialState, 'idempotency').value) {
    // `entry.request_id` 与 `entry.result.request_id` 指向**同一次**首次请求，
    // 因此这里只取一次；两者是否一致由账本交叉校验单独负责。
    const number = requestNumber(entry?.request_id);
    if (number !== null) numbers.push(number);
  }
  for (const entry of collectionOf(initialState, 'request_log').value) {
    const number = requestNumber(entry?.request_id);
    if (number !== null) numbers.push(number);
  }
  return numbers;
};

/**
 * 读取 `initial_state` 的集合字段，并对**验证器与建库函数**共用同一套语义。
 *
 * 允许缺省（视作空集合），但显式出现时必须是数组：`files: {}`、`changes: "x"`
 * 之类必须被拒绝。这样「`validateInitialState` 通过 ⇒ `createVaultState` 能建库」
 * 才成立——否则缺省 `versions` 的初态会通过校验，随后在建库时 `TypeError`。
 * 返回 `{ value, problems }`。
 */
const collectionOf = (initialState, key) => {
  const source = initialState ?? {};
  if (!Object.hasOwn(source, key)) return { value: [], problems: [] };
  const value = source[key];
  if (!Array.isArray(value)) {
    return { value: [], problems: [`initial_state.${key} 必须是数组（缺省才视为空集合）`] };
  }
  return { value, problems: [] };
};

/**
 * 校验 initial_state 自身是否自洽。返回问题列表，空数组表示通过。
 * 测试入口用它防止夹具自相矛盾导致空跑。
 *
 * 这里不只检查字段形状：历史 Change、版本、Blob、幂等账本与首次请求
 * 必须**相互**对得上，历史 revision 必须连续（下界以前允许已压缩），
 * `change_id` / `operation_id` / `request_id` 必须全局唯一。
 */
export function validateInitialState(initialState) {
  const problems = [];
  if (!isNonEmptyString(initialState?.vault_id)) problems.push('initial_state.vault_id 必须是非空字符串');
  const vaultRevision = initialState?.vault_revision;
  if (!isNonNegativeInt(vaultRevision)) problems.push('initial_state.vault_revision 必须是非负整数');

  // 只有**字段缺省**时才默认 0。显式写 `min_available_revision: null` 是类型错误，
  // 不能被 `?? 0` 静默当成「下界为 0」——那会让一个把下界写成 null 的夹具
  // 以虚假的「无压缩历史」语义通过加载，把过期游标当成可增量拉取。
  const hasMinAvailable = initialState !== null && initialState !== undefined && Object.hasOwn(initialState, 'min_available_revision');
  const minAvailable = hasMinAvailable ? initialState.min_available_revision : 0;
  if (hasMinAvailable && initialState.min_available_revision === null) {
    problems.push('initial_state.min_available_revision 不能显式为 null（缺省才默认 0）');
  } else if (!isNonNegativeInt(minAvailable)) {
    problems.push('initial_state.min_available_revision 必须是非负整数');
  } else if (isNonNegativeInt(vaultRevision) && minAvailable > vaultRevision) {
    problems.push('min_available_revision 不能大于 vault_revision');
  }

  // 集合字段：验证器与 createVaultState 使用同一套「缺省为空数组、出现必须是数组」的语义。
  const collections = {};
  for (const key of [
    'files',
    'versions',
    'blobs',
    'changes',
    'upload_sessions',
    'idempotency',
    'request_log',
    'reserved_operation_ids',
  ]) {
    const { value, problems: collectionProblems } = collectionOf(initialState, key);
    collections[key] = value;
    problems.push(...collectionProblems);
  }
  const files = collections.files;
  const versions = collections.versions;
  const blobs = collections.blobs;
  const changes = collections.changes;

  const fileIds = new Set();
  const filesById = new Map();
  const paths = new Set();
  for (const file of files) {
    if (!isNonEmptyString(file?.file_id)) {
      problems.push('文件缺少 file_id');
      continue;
    }
    if (fileIds.has(file.file_id)) problems.push(`重复的 file_id: ${file.file_id}`);
    fileIds.add(file.file_id);
    filesById.set(file.file_id, file);
    // 路径必须是协议口径下的规范化 Vault 相对路径：`../bad`、`.`、`a//b` 都不是。
    if (!isNormalizedPath(file.path)) {
      problems.push(`文件 ${file.file_id} 的 path 不是规范化路径: ${JSON.stringify(file.path)}`);
    } else if (normalizePath(file.path) !== file.path) {
      problems.push(`文件 ${file.file_id} 的 path 未规范化: ${JSON.stringify(file.path)}`);
    }
    if (paths.has(file.path)) problems.push(`同一 Vault 出现重复路径: ${file.path}`);
    paths.add(file.path);
    if (!METADATA_FORMATS.includes(file.format)) {
      problems.push(
        `文件 ${file.file_id} 的 format ${JSON.stringify(file.format)} 必须是 ${METADATA_FORMATS.join(' / ')} 之一`,
      );
    }
    if (!Object.hasOwn(file, 'current_version_id')) {
      problems.push(`文件 ${file.file_id} 必须显式声明 current_version_id（无版本时为 null）`);
    } else if (file.current_version_id !== null && !isNonEmptyString(file.current_version_id)) {
      problems.push(`文件 ${file.file_id} 的 current_version_id 必须是字符串或 null`);
    }
    if (Object.hasOwn(file, 'is_deleted') && typeof file.is_deleted !== 'boolean') {
      problems.push(`文件 ${file.file_id} 的 is_deleted 必须是布尔值`);
    }
    if (file.current_revision !== undefined && !isNonNegativeInt(file.current_revision)) {
      problems.push(`文件 ${file.file_id} 的 current_revision 不合法`);
    }
  }

  const versionIds = new Set();
  const versionsById = new Map();
  const blobById = new Map(blobs.map((blob) => [blob.blob_id, blob]));
  for (const version of versions) {
    if (!isNonEmptyString(version?.version_id)) {
      problems.push('版本缺少 version_id');
      continue;
    }
    if (versionIds.has(version.version_id)) problems.push(`重复的 version_id: ${version.version_id}`);
    versionIds.add(version.version_id);
    versionsById.set(version.version_id, version);
    if (!fileIds.has(version.file_id)) problems.push(`版本 ${version.version_id} 指向未知文件 ${version.file_id}`);
    if (!blobById.has(version.blob_id)) problems.push(`版本 ${version.version_id} 指向未知 Blob ${version.blob_id}`);
    const blob = blobById.get(version.blob_id);
    if (blob && blob.content_hash !== version.content_hash) {
      problems.push(`版本 ${version.version_id} 的 content_hash 与 Blob ${version.blob_id} 不一致`);
    }
    if (blob && blob.content_size !== version.content_size) {
      problems.push(`版本 ${version.version_id} 的 content_size 与 Blob ${version.blob_id} 不一致`);
    }
    if (!isSha256(version.content_hash)) problems.push(`版本 ${version.version_id} 的 content_hash 不合法`);
    if (!isNonNegativeInt(version.content_size)) problems.push(`版本 ${version.version_id} 的 content_size 不合法`);
    if (!isNonNegativeInt(version.vault_revision)) {
      problems.push(`版本 ${version.version_id} 缺少 vault_revision`);
    } else if (isNonNegativeInt(vaultRevision) && version.vault_revision > vaultRevision) {
      problems.push(`版本 ${version.version_id} 的 vault_revision 超过 vault_revision`);
    }
    // 只要版本**声明了** `metadata.format`，就必须核对它所属文件的 format，
    // 即使创建该版本的 Change 已被压缩、或根本没有保留的 Change。
    // 这一条独立于「有对应 Change」的逐项绑定：压缩历史里的版本同样不能声称
    // 另一种格式，否则 manifest / 快照恢复会把文件格式与内容来源割裂。
    if (isPlainObject(version.metadata) && version.metadata.format !== undefined) {
      if (!METADATA_FORMATS.includes(version.metadata.format)) {
        problems.push(
          `版本 ${version.version_id} 的 metadata.format ${JSON.stringify(version.metadata.format)} 必须是 ${METADATA_FORMATS.join(' / ')} 之一`,
        );
      }
      const owningFile = filesById.get(version.file_id);
      if (
        METADATA_FORMATS.includes(version.metadata.format) &&
        owningFile &&
        METADATA_FORMATS.includes(owningFile.format) &&
        version.metadata.format !== owningFile.format
      ) {
        problems.push(
          `版本 ${version.version_id} 的 metadata.format ${JSON.stringify(version.metadata.format)} 与文件 ${version.file_id} 的 format ${JSON.stringify(owningFile.format)} 不一致`,
        );
      }
    }
    // 出现 `metadata.line_ending` 就必须是合法枚举：没有可追溯请求时也要拒绝越界值。
    if (isPlainObject(version.metadata) && Object.hasOwn(version.metadata, 'line_ending') && !LINE_ENDINGS.includes(version.metadata.line_ending)) {
      problems.push(
        `版本 ${version.version_id} 的 metadata.line_ending ${JSON.stringify(version.metadata.line_ending)} 必须是 ${LINE_ENDINGS.join(' / ')} 之一`,
      );
    }
    if (version.base_version_id !== null && version.base_version_id !== undefined && !isNonEmptyString(version.base_version_id)) {
      problems.push(`版本 ${version.version_id} 的 base_version_id 必须是字符串或 null`);
    }
  }

  // 版本图：父版本必须属于同一 file_id、必须**早于**子版本，且不得成环。
  // 顺序无关的扫描放在第二遍：夹具里的版本声明顺序不应影响父版本是否存在。
  for (const version of versions) {
    if (!isNonEmptyString(version?.version_id) || !version.base_version_id) continue;
    const parent = versionsById.get(version.base_version_id);
    if (!parent) {
      problems.push(`版本 ${version.version_id} 的父版本 ${version.base_version_id} 不存在`);
      continue;
    }
    if (parent.file_id !== version.file_id) {
      problems.push(`版本 ${version.version_id} 的父版本 ${version.base_version_id} 属于另一个文件`);
      continue;
    }
    if (!isNonNegativeInt(parent.vault_revision) || !isNonNegativeInt(version.vault_revision)) continue;
    // 同一文件内，父版本必须严格早于子版本：相等或更晚都是「未来父版本」。
    if (!(parent.vault_revision < version.vault_revision)) {
      problems.push(
        `版本 ${version.version_id} 的父版本 ${parent.version_id} 必须早于子版本（父 revision ${parent.vault_revision}，子 revision ${version.vault_revision}）`,
      );
    }
  }
  // 环检测：沿 base_version_id 前进，若回到起点或重复经过同一版本即成环。
  for (const version of versions) {
    if (!isNonEmptyString(version?.version_id)) continue;
    const seen = new Set([version.version_id]);
    let cursor = version;
    while (isNonEmptyString(cursor?.base_version_id)) {
      const parent = versionsById.get(cursor.base_version_id);
      if (!parent) break;
      if (seen.has(parent.version_id)) {
        problems.push(`版本 ${version.version_id} 的父版本链成环（重复经过 ${parent.version_id}）`);
        break;
      }
      seen.add(parent.version_id);
      cursor = parent;
    }
  }

  // 保留区间内「版本 ↔ Change」必须双向一一绑定：
  //   - 每个 revision >= min_available_revision + 1 的版本必须恰好有一条同 revision 的 Change 指向它；
  //   - 孤立的多余版本（同 revision 但没有对应 Change）即不自洽。
  // min_available_revision 及更早的 Change 允许已压缩，对应版本不要求再绑定。
  const retainedFloor = isNonNegativeInt(minAvailable) ? minAvailable + 1 : 1;
  if (isNonNegativeInt(retainedFloor)) {
    const changesForVersion = new Map();
    for (const change of changes) {
      if (!isNonEmptyString(change?.version_id)) continue;
      if (!changesForVersion.has(change.version_id)) changesForVersion.set(change.version_id, []);
      changesForVersion.get(change.version_id).push(change);
    }
    for (const version of versions) {
      if (!isNonEmptyString(version?.version_id)) continue;
      if (!isNonNegativeInt(version.vault_revision) || version.vault_revision < retainedFloor) continue;
      const bound = (changesForVersion.get(version.version_id) ?? []).filter(
        (change) => change.vault_revision === version.vault_revision && VERSION_CREATING.has(change.operation),
      );
      if (bound.length === 0) {
        problems.push(
          `保留区间内的版本 ${version.version_id}（revision ${version.vault_revision}）必须与同 revision 的一条 Change 双向绑定`,
        );
      } else if (bound.length > 1) {
        problems.push(`版本 ${version.version_id} 被多条同 revision 的 Change 重复绑定`);
      }
    }
  }

  for (const file of files) {
    if (!isNonEmptyString(file?.file_id)) continue;
    if (file.current_version_id && !versions.some((version) => version.version_id === file.current_version_id && version.file_id === file.file_id)) {
      problems.push(`文件 ${file.file_id} 的 current_version_id ${file.current_version_id} 不属于该文件`);
    }
  }

  // 历史 Change：revision 唯一、递增、不超过 vault_revision，且与版本逐项自洽。
  const revisions = new Set();
  const changeIds = new Set();
  const changeOperations = new Map();
  // operation_id -> 首次请求的 metadata（只取可追溯的幂等账本条目）。
  // 版本 metadata 的核对基准就是该写入操作的请求，而不是「当前指针版本」的请求。
  const firstRequestMetadataByOperation = new Map();
  for (const entry of collections.idempotency) {
    if (!isNonEmptyString(entry?.operation_id)) continue;
    const requestMetadata = entry?.request?.body?.metadata;
    if (isPlainObject(requestMetadata)) {
      firstRequestMetadataByOperation.set(entry.operation_id, requestMetadata);
    }
  }
  let previous = -1;
  for (const change of changes) {
    if (!isNonNegativeInt(change?.vault_revision)) {
      problems.push(`Change ${change?.change_id} 缺少 vault_revision`);
      continue;
    }
    if (change.change_id !== undefined) {
      if (changeIds.has(change.change_id)) problems.push(`重复的 change_id: ${change.change_id}`);
      changeIds.add(change.change_id);
    }
    if (revisions.has(change.vault_revision)) problems.push(`重复的 Change revision: ${change.vault_revision}`);
    revisions.add(change.vault_revision);
    if (change.vault_revision <= previous) problems.push('Change 必须按 revision 严格递增排列');
    previous = change.vault_revision;
    if (isNonNegativeInt(vaultRevision) && change.vault_revision > vaultRevision) {
      problems.push(`Change revision ${change.vault_revision} 超过 vault_revision`);
    }
    if (change.vault_revision < 1) problems.push(`Change revision ${change.vault_revision} 必须为正整数`);
    if (change.vault_id !== undefined && change.vault_id !== initialState.vault_id) {
      problems.push(`Change ${change.change_id} 属于其他 Vault ${change.vault_id}`);
    }
    if (isNonEmptyString(change.operation_id)) {
      if (changeOperations.has(change.operation_id)) {
        problems.push(`历史 Change 重复使用 operation_id ${change.operation_id}`);
      } else {
        changeOperations.set(change.operation_id, change);
      }
    }
    problems.push(
      ...historicalChangeProblems(
        change,
        versionsById.get(change.version_id),
        filesById,
        // 该写入操作的首次请求（若可追溯）用于核对版本 metadata 的存在性与取值。
        // 没有账本条目的历史操作（例如只保留了压缩前的创建事件）仍要与所属文件格式一致。
        firstRequestMetadataByOperation.get(change.operation_id),
      ),
    );
  }

  // 用同一文件的保留 Change 按 revision 顺序重建「可证明的当前指针」，
  // 并要求每个产生版本的 Change 的父引用就是当时可证明的当前版本。
  //
  // 只校验「父版本同文件且更早」还不够：把 revision 5 的 update 父引用从 ver_alpha_01
  // 改成更早的 ver_alpha_00（或 null），版本图仍然无环、父版本也确实更早，
  // 但历史因此变成「在一个更早的基准上覆盖写入」，重放会得到与服务端不同的结果。
  // 首个保留 Change 之前的历史可能已被压缩，此时父版本允许落在压缩边界（<= 下界）之内；
  // 边界之后则必须等于上一条保留 Change 留下的当前版本。
  const retainedChangesByFile = new Map();
  for (const change of changes) {
    if (!isNonEmptyString(change?.file_id) || !isNonNegativeInt(change?.vault_revision)) continue;
    if (!retainedChangesByFile.has(change.file_id)) retainedChangesByFile.set(change.file_id, []);
    retainedChangesByFile.get(change.file_id).push(change);
  }
  for (const [fileId, fileChanges] of retainedChangesByFile) {
    const ordered = [...fileChanges].sort((left, right) => left.vault_revision - right.vault_revision);
    let proven = undefined;
    for (const change of ordered) {
      const version = versionsById.get(change.version_id);
      if (!version) continue; // 缺少版本已由 Change 校验单独报出
      if (VERSION_CREATING.has(change.operation)) {
        const parentId = change.parent_version_id ?? null;
        if (proven === undefined) {
          // 首条保留 Change：父版本可能位于压缩边界之前。
          if (parentId !== null) {
            const parent = versionsById.get(parentId);
            if (!parent) {
              problems.push(`Change ${change.change_id} 的父版本 ${parentId} 不存在`);
            } else if (
              isNonNegativeInt(parent.vault_revision) &&
              isNonNegativeInt(minAvailable) &&
              parent.vault_revision > minAvailable
            ) {
              problems.push(
                `Change ${change.change_id} 的父版本 ${parentId}（revision ${parent.vault_revision}）晚于压缩下界 ${minAvailable}，必须等于此前同文件保留 Change 留下的当前版本`,
              );
            }
          }
        } else if (parentId !== proven) {
          problems.push(
            `Change ${change.change_id} 的 parent_version_id ${JSON.stringify(parentId)} 必须等于此前同文件可证明的当前版本 ${JSON.stringify(proven)}`,
          );
        }
      }
      // 任何 Change（含删除 / 复用版本）之后，文件当前指针都落到该 Change 指向的版本。
      proven = version.version_id;
    }
  }

  // 文件当前指针必须等于该文件历史中最后一个 Change 指向的版本。
  // 只看「current_version_id 属于该文件」是不够的：把指针换回更早的版本也能通过，
  // 而 revision 5 的 Change 已经指向新版本 —— 这种初态自相矛盾，不能用来验证协议行为。
  const DELETION_OPERATIONS = new Set(['delete_file', 'delete_directory']);
  const finalChangeByFile = new Map();
  for (const change of changes) {
    if (!isNonEmptyString(change?.file_id) || !isNonNegativeInt(change?.vault_revision)) continue;
    const current = finalChangeByFile.get(change.file_id);
    if (!current || change.vault_revision > current.vault_revision) {
      finalChangeByFile.set(change.file_id, change);
    }
  }
  for (const file of files) {
    if (!isNonEmptyString(file?.file_id)) continue;
    const finalChange = finalChangeByFile.get(file.file_id);
    if (!finalChange) {
      // 该文件的 Change 已全部被压缩（revision <= min_available_revision）：
      // 当前指针必须由**初始快照中可证明的最终版本**给出，而不是强制为 null。
      // 可证明性：当前版本属于该文件、其 revision 不晚于压缩下界，且是该文件 revision 最大的版本；
      // 没有任何保留的删除 Change，因此 is_deleted 必须为 false。
      const fileVersions = versions.filter((version) => version?.file_id === file.file_id);
      const pointer = (file.current_version_id ?? null) === null ? null : versionsById.get(file.current_version_id);
      if (!pointer) {
        problems.push(
          `文件 ${file.file_id} 没有保留的 Change，current_version_id 必须指向该文件在压缩下界内的最终版本（当前为 ${JSON.stringify(file.current_version_id)}）`,
        );
        continue;
      }
      if (pointer.file_id !== file.file_id) {
        problems.push(`文件 ${file.file_id} 的 current_version_id ${pointer.version_id} 不属于该文件`);
        continue;
      }
      if (!isNonNegativeInt(pointer.vault_revision) || !isNonNegativeInt(minAvailable)) continue;
      if (pointer.vault_revision > minAvailable) {
        problems.push(
          `文件 ${file.file_id} 当前版本 ${pointer.version_id}（revision ${pointer.vault_revision}）晚于压缩下界 ${minAvailable}，必须保留对应 Change`,
        );
      }
      const latestFileRevision = Math.max(
        ...fileVersions
          .filter((version) => isNonNegativeInt(version.vault_revision))
          .map((version) => version.vault_revision),
      );
      if (pointer.vault_revision !== latestFileRevision) {
        problems.push(
          `文件 ${file.file_id} 的 current_version_id ${pointer.version_id}（revision ${pointer.vault_revision}）不是初始快照中该文件的最终版本（revision ${latestFileRevision}）`,
        );
      }
      if (file.is_deleted === true) {
        problems.push(`文件 ${file.file_id} 没有保留的删除 Change，is_deleted 不能为 true`);
      }
      if (isPlainObject(pointer.metadata) && pointer.metadata.format !== undefined && pointer.metadata.format !== file.format) {
        problems.push(
          `文件 ${file.file_id} 的 format ${JSON.stringify(file.format)} 与最终版本 ${pointer.version_id} 的 metadata.format ${JSON.stringify(pointer.metadata.format)} 不一致`,
        );
      }
      continue;
    }
    const expectedVersion = versionsById.get(finalChange.version_id);
    if (!expectedVersion) continue; // 缺少版本已由 Change 校验报出
    if ((file.current_version_id ?? null) !== expectedVersion.version_id) {
      problems.push(
        `文件 ${file.file_id} 的 current_version_id ${JSON.stringify(file.current_version_id)} 与历史最终版本 ${expectedVersion.version_id}（revision ${finalChange.vault_revision}）不一致`,
      );
    }
    // 版本自身的 metadata.format 若存在，必须与文件格式一致。
    if (isPlainObject(expectedVersion.metadata) && expectedVersion.metadata.format !== undefined) {
      if (expectedVersion.metadata.format !== file.format) {
        problems.push(
          `文件 ${file.file_id} 的 format ${JSON.stringify(file.format)} 与最终版本 ${expectedVersion.version_id} 的 metadata.format ${JSON.stringify(expectedVersion.metadata.format)} 不一致`,
        );
      }
    }
    // is_deleted 必须能从最后一个 Change 的操作类型推导出来。
    const expectedDeleted = DELETION_OPERATIONS.has(finalChange.operation);
    const actualDeleted = file.is_deleted === true;
    if (actualDeleted !== expectedDeleted) {
      problems.push(
        `文件 ${file.file_id} 的 is_deleted ${actualDeleted} 与最后一个 Change（${finalChange.operation}）推导出的 ${expectedDeleted} 不一致`,
      );
    }
  }

  // revision 连续性：min_available_revision + 1 .. vault_revision 之间必须每个 revision 都有 Change。
  // 下界及更早的历史允许已压缩而不出现在夹具中。
  //
  // 判定必须按**实际保留的 revision 排序**检查首个缺口与尾部缺口，而不是从
  // min_available_revision 逐个 +1 循环到 vault_revision：后者会让复杂度由攻击者给出的
  // 巨大 `vault_revision`（例如 1e15）决定，加载校验被一个数字拖死。
  // 现在的代价只与 Change 记录数线性相关，同时保留原有错误语义（逐条报出缺失的 revision）。
  if (isNonNegativeInt(vaultRevision) && isNonNegativeInt(minAvailable)) {
    const expectedFloor = Math.max(minAvailable + 1, 1);
    const retained = [...revisions].filter((revision) => revision >= expectedFloor && revision <= vaultRevision).sort((a, b) => a - b);
    if (vaultRevision >= expectedFloor) {
      const firstGap = retained.length > 0 ? retained[0] : expectedFloor;
      if (firstGap !== expectedFloor) {
        // 首个保留 revision 之前的所有 revision 都必须由压缩下界覆盖：报第一个缺口即可定位。
        problems.push(
          `initial_state 缺少 revision ${expectedFloor} 的 Change（min_available_revision=${minAvailable}, vault_revision=${vaultRevision}）`,
        );
      }
      // 只在保留记录之间找缺口：跨度最大为记录数，不随 revision 数值大小增长。
      for (let index = 1; index < retained.length; index += 1) {
        const previousRevision = retained[index - 1];
        const currentRevision = retained[index];
        if (currentRevision === previousRevision + 1) continue;
        if (currentRevision <= previousRevision) continue;
        // 缺口可能很大：只报缺口起点，不逐项枚举（枚举本身就是被攻击面）。
        problems.push(
          `initial_state 缺少 revision ${previousRevision + 1} 的 Change（min_available_revision=${minAvailable}, vault_revision=${vaultRevision}）`,
        );
      }
      const lastRetained = retained.length > 0 ? retained[retained.length - 1] : expectedFloor - 1;
      if (lastRetained !== vaultRevision) {
        problems.push(
          `initial_state 缺少 revision ${lastRetained + 1} 的 Change（min_available_revision=${minAvailable}, vault_revision=${vaultRevision}）`,
        );
      }
    }
    for (const revision of revisions) {
      if (revision < 1 || revision > vaultRevision) {
        problems.push(`Change revision ${revision} 不在 1..${vaultRevision} 范围内`);
      }
    }
  }

  const blobIds = new Set();
  // 同一完整内容哈希在内容寻址下只能对应一份字节，因此其 content_size 必须唯一。
  const sizeByContentHash = new Map();
  for (const blob of blobs) {
    if (!isNonEmptyString(blob?.blob_id)) {
      problems.push('Blob 缺少 blob_id');
      continue;
    }
    if (blobIds.has(blob.blob_id)) problems.push(`重复的 blob_id: ${blob.blob_id}`);
    blobIds.add(blob.blob_id);
    if (!isSha256(blob.content_hash)) {
      problems.push(`Blob ${blob.blob_id} 的 content_hash 不合法`);
    } else if (blobIdForHash(blob.content_hash) !== blob.blob_id) {
      // Blob 标识按**完整** SHA-256 生成；截断前缀会让不同字节折叠到同一个 Blob。
      problems.push(`Blob ${blob.blob_id} 的标识与内容哈希不自洽`);
    }
    if (!isNonNegativeInt(blob.content_size)) problems.push(`Blob ${blob.blob_id} 的 content_size 不合法`);
    if (blob.vault_id !== initialState.vault_id) {
      problems.push(`Blob ${blob.blob_id} 属于其他 Vault ${blob.vault_id}`);
    }
    // 相同完整哈希不得声明不同大小：否则复用 Blob 时「哪一份大小才算数」无从判定。
    if (isSha256(blob.content_hash) && isNonNegativeInt(blob.content_size)) {
      if (sizeByContentHash.has(blob.content_hash) && sizeByContentHash.get(blob.content_hash) !== blob.content_size) {
        problems.push(
          `Blob ${blob.blob_id} 与同内容哈希的其他 Blob 声明了不同 content_size（${sizeByContentHash.get(blob.content_hash)} / ${blob.content_size}）`,
        );
      } else {
        sizeByContentHash.set(blob.content_hash, blob.content_size);
      }
    }
  }

  // 上传会话必须属于当前 Vault，否则「已完成」状态可能被跨 Vault 复用。
  // 上传会话还必须保存**可留存的原始内容指纹**：只声明 blob_reference 无法证明
  // 首次请求引用的就是那份字节，换成同一夹具里另一个有效样本也不会被发现。
  const uploadRefs = new Set();
  for (const upload of collections.upload_sessions) {
    if (!isNonEmptyString(upload?.blob_reference)) problems.push('上传会话缺少 blob_reference');
    else if (uploadRefs.has(upload.blob_reference)) problems.push(`重复的 blob_reference: ${upload.blob_reference}`);
    uploadRefs.add(upload.blob_reference);
    if (upload?.vault_id !== initialState.vault_id) {
      problems.push(`上传会话 ${upload?.blob_reference} 属于其他 Vault ${upload?.vault_id}`);
    }
    if (!UPLOAD_STATUSES.includes(upload?.status)) {
      problems.push(`上传会话 ${upload?.blob_reference} 的 status ${JSON.stringify(upload?.status)} 不在 ${UPLOAD_STATUSES.join(' / ')} 内`);
    }
    if (!isSha256(upload?.content_hash)) {
      problems.push(`上传会话 ${upload?.blob_reference} 缺少完整的 content_hash`);
    }
    if (!isNonNegativeInt(upload?.content_size)) {
      problems.push(`上传会话 ${upload?.blob_reference} 缺少合法的 content_size`);
    }
    if (isSha256(upload?.content_hash) && upload.content_hash !== undefined) {
      const expectedBlobId = blobIdForHash(upload.content_hash);
      if (upload.blob_id !== undefined && upload.blob_id !== expectedBlobId) {
        problems.push(`上传会话 ${upload.blob_reference} 的 blob_id 与完整内容哈希不自洽`);
      }
      // 已完成的上传会话就是「这份字节即将成为版本内容」的声明：
      // 对应的 Blob（若已存在）必须与它哈希相同、大小相同；
      // 同内容哈希的所有 Blob 也必须共享同一个大小。
      if (upload.status === 'completed') {
        const sameHashBlobs = blobs.filter((blob) => isSha256(blob?.content_hash) && blob.content_hash === upload.content_hash);
        for (const blob of sameHashBlobs) {
          if (isNonNegativeInt(upload.content_size) && isNonNegativeInt(blob.content_size) && blob.content_size !== upload.content_size) {
            problems.push(
              `已完成的上传会话 ${upload.blob_reference}（content_size ${upload.content_size}）与 Blob ${blob.blob_id} 的 content_size ${blob.content_size} 不一致`,
            );
          }
        }
        const referencedBlob = upload.blob_id !== undefined ? blobById.get(upload.blob_id) : null;
        if (referencedBlob) {
          if (isSha256(referencedBlob.content_hash) && referencedBlob.content_hash !== upload.content_hash) {
            problems.push(`已完成的上传会话 ${upload.blob_reference} 与它引用的 Blob ${upload.blob_id} 哈希不一致`);
          }
          if (isNonNegativeInt(upload.content_size) && isNonNegativeInt(referencedBlob.content_size) && referencedBlob.content_size !== upload.content_size) {
            problems.push(
              `已完成的上传会话 ${upload.blob_reference} 与它引用的 Blob ${upload.blob_id} 大小不一致`,
            );
          }
        }
      }
    }
  }

  // 显式声明的已占用（但无完整历史请求）operation_id 账本。
  // 这些 ID 表达「服务端确实用过、但没有可重放的首次结果」，因此必须与历史 Change
  // 以及幂等账本的键互不重复：重复声明等于同时主张「有首次结果」和「没有首次结果」。
  const reservedOperations = new Set();
  for (const operationId of collections.reserved_operation_ids) {
    if (!isNonEmptyString(operationId)) {
      problems.push('reserved_operation_ids 只能包含非空字符串');
      continue;
    }
    if (reservedOperations.has(operationId)) problems.push(`reserved_operation_ids 重复声明 ${operationId}`);
    reservedOperations.add(operationId);
    if (changeOperations.has(operationId)) {
      problems.push(`reserved_operation_ids 中的 ${operationId} 已被历史 Change 使用`);
    }
  }

  // 幂等历史：账本条目必须与历史 Change / 版本 / 首次请求 / 结果四方自洽。
  const ledgerOperations = new Set();
  const ledgerRequestIds = new Set();
  for (const entry of collections.idempotency) {
    const operationId = entry?.operation_id;
    if (!isNonEmptyString(operationId)) {
      problems.push('幂等账本条目缺少 operation_id');
      continue;
    }
    if (ledgerOperations.has(operationId)) problems.push(`幂等账本重复记录 operation_id ${operationId}`);
    ledgerOperations.add(operationId);
    if (reservedOperations.has(operationId)) {
      problems.push(`幂等账本 ${operationId} 与 reserved_operation_ids 重复声明`);
    }
    if (!isSha256(entry.fingerprint)) problems.push(`幂等账本 ${operationId} 的 fingerprint 不合法`);
    // `request_id` 必须严格是 `req_` 加六位数字的**字符串**：数组 / 数字被正则隐式
    // 转成字符串后会一起通过，这会让「序号推导」与「类型校验」使用两套口径。
    if (parseRequestId(entry.request_id) === null) {
      problems.push(`幂等账本 ${operationId} 的首次 request_id 不合法`);
    } else if (ledgerRequestIds.has(entry.request_id)) {
      problems.push(`幂等账本重复使用 request_id ${entry.request_id}`);
    }
    ledgerRequestIds.add(entry.request_id);

    // 指纹必须与账本携带的首次请求体自洽：否则重放路径可以「命中即返回」，
    // 却把另一份内容当成首次请求，同 ID 异内容拒绝也就形同虚设。
    const request = entry.request;
    const requestBody = isPlainObject(request?.body) ? request.body : null;
    if (!isPlainObject(request)) {
      problems.push(`幂等账本 ${operationId} 缺少首次请求，无法核对指纹`);
    } else if (!requestBody) {
      problems.push(`幂等账本 ${operationId} 的首次请求缺少请求体`);
    } else {
      if (request.method !== 'POST') problems.push(`幂等账本 ${operationId} 的首次请求方法必须为 POST`);
      const parsed = parseEndpoint(request.endpoint);
      if (!parsed || parsed.kind !== 'changes' || parsed.vaultFromRoute !== initialState.vault_id) {
        problems.push(`幂等账本 ${operationId} 的首次请求 endpoint 必须是本 Vault 的 sync/changes`);
      }
      // 首次请求的 query 也必须能被原样重放：其中若携带 vault_id，必须与路由 / 请求体一致。
      // 历史请求可能把查询串保存在 `query` 对象里，也可能只保存完整 `url`（或相对 URL）。
      // 后者必须用与运行时**相同**的 `URLSearchParams` 解析，否则 `request.url` 里的
      // `?vault_id=vault_other` 可以绕过加载校验，直到重放时才变成 404。
      // 两种来源都要查：同时声明时必须都一致。
      const querySources = [];
      if (request.query instanceof URLSearchParams || isPlainObject(request.query)) {
        querySources.push((key) => queryLookup({ query: request.query })(key));
      }
      if (typeof request.url === 'string') {
        querySources.push((key) => queryLookup({ url: request.url })(key));
      }
      for (const queryLookupForInitial of querySources) {
        const queryVault = queryLookupForInitial('vault_id');
        if (queryVault !== undefined && queryVault !== initialState.vault_id) {
          problems.push(`幂等账本 ${operationId} 的首次请求 query.vault_id 与 Vault 不一致，重放会返回 404`);
          break;
        }
      }
      if (isSha256(entry.fingerprint) && payloadFingerprint(requestBody) !== entry.fingerprint) {
        problems.push(`幂等账本 ${operationId} 的 fingerprint 与其首次请求体不一致`);
      }
      if (requestBody.operation_id !== operationId) {
        problems.push(`幂等账本 ${operationId} 的首次请求 operation_id 不一致`);
      }
      const key = headerValue(request.headers, 'Idempotency-Key');
      if (key !== undefined && key !== operationId) {
        problems.push(`幂等账本 ${operationId} 的首次请求 Idempotency-Key 不一致`);
      }
    }

    if (!isPlainObject(entry.result)) {
      problems.push(`幂等账本 ${operationId} 缺少首次结果`);
      continue;
    }
    const change = changeOperations.get(operationId);
    if (!change) {
      problems.push(`幂等账本 ${operationId} 没有对应的历史 Change`);
      continue;
    }
    if (entry.result.request_id !== entry.request_id) {
      problems.push(`幂等账本 ${operationId} 的结果 request_id 与首次 request_id 不一致`);
    }
    // 结果的 request_id 与首次 request_id 使用同一套严格解析：数组 / 数字不得靠
    // 正则的隐式字符串转换通过。两者相等性上面已单独核对，这里只补类型与被占用的严格性。
    if (parseRequestId(entry.result.request_id) === null) {
      problems.push(`幂等账本 ${operationId} 的结果 request_id 不合法`);
    }
    const version = versionsById.get(change.version_id);
    if (!version) {
      problems.push(`幂等账本 ${operationId} 对应的版本 ${change.version_id} 不存在`);
    } else {
      problems.push(...historicalResultProblems(entry.result, { change, version, operationId }));
    }
    if (requestBody) {
      const parentVersion = version?.base_version_id ? versionsById.get(version.base_version_id) : null;
      problems.push(
        ...historicalRequestProblems(requestBody, {
          change,
          version: version ?? {},
          parentVersion,
          file: filesById.get(change.file_id),
          vaultId: initialState.vault_id,
          uploads: collections.upload_sessions,
        }),
      );
    }
    // 账本声明的首次结果必须能原样重放：Change 本身必须是本模型可执行操作。
    // 历史记录可以包含未来操作，但这样的记录不能作为「可重放的历史请求」进入账本。
    if (!EXECUTABLE.has(change.operation)) {
      problems.push(
        `幂等账本 ${operationId} 对应的 Change 操作 ${JSON.stringify(change.operation)} 不是本模型可执行操作，无法原样重放`,
      );
    }
  }

  // 历史内容更新必须能在账本中找到，否则重放会重复写入。
  for (const change of changes) {
    if (change?.operation !== 'update_file_content') continue;
    if (!ledgerOperations.has(change.operation_id)) {
      problems.push(`历史内容更新 ${change.change_id}（${change.operation_id}）缺少幂等账本条目`);
    }
  }

  // request_id 与 request_sequence：请求跟踪标识必须全局唯一，且下一个序号不能与历史冲突。
  const numbers = usedRequestNumbers(initialState);
  if (new Set(numbers).size !== numbers.length) {
    problems.push('历史 request_id 序号重复');
  }
  for (const entry of collections.request_log) {
    // 与幂等账本共用同一套严格解析：数组 / 数字不得靠正则的隐式字符串转换通过。
    if (parseRequestId(entry?.request_id) === null) {
      problems.push(`request_log 条目 request_id 不合法: ${JSON.stringify(entry?.request_id)}`);
    }
  }
  const maxUsed = numbers.length > 0 ? Math.max(...numbers) : 0;
  if (maxUsed > MAX_REQUEST_SEQUENCE) {
    problems.push(
      `历史 request_id 序号 ${maxUsed} 超出可表示范围 1..${MAX_REQUEST_SEQUENCE}（request_id 只能是 req_ 加六位数字）`,
    );
  }
  if (initialState?.request_sequence !== undefined) {
    if (!Number.isInteger(initialState.request_sequence) || initialState.request_sequence < 1) {
      problems.push('initial_state.request_sequence 必须是正整数');
    } else if (initialState.request_sequence > MAX_REQUEST_SEQUENCE) {
      // 超出六位的序号会生成 req_1000000，直接违反 req_ 加六位数字的格式约定。
      problems.push(
        `initial_state.request_sequence ${initialState.request_sequence} 超出可表示范围 1..${MAX_REQUEST_SEQUENCE}（request_id 只能是 req_ 加六位数字）`,
      );
    } else if (initialState.request_sequence <= maxUsed) {
      problems.push(
        `initial_state.request_sequence ${initialState.request_sequence} 会与历史 request_id 冲突（已用到 ${maxUsed}）`,
      );
    }
  } else if (maxUsed >= MAX_REQUEST_SEQUENCE) {
    // 缺省时下一个序号由历史推导为 maxUsed + 1，同样不能越界。
    problems.push(
      `历史 request_id 已用到 ${maxUsed}，推导出的下一个序号会超出可表示范围 1..${MAX_REQUEST_SEQUENCE}`,
    );
  }

  return problems;
}

/**
 * 由场景的 initial_state 建立内存状态。
 * File 只声明确切身份与 current_version_id，其余当前指针由版本派生，避免夹具重复声明。
 */
export function createVaultState(initialState) {
  const problems = validateInitialState(initialState);
  if (problems.length > 0) {
    throw new Error(`initial_state 自检失败:\n- ${problems.join('\n- ')}`);
  }

  // 与 validateInitialState 共用 collectionOf：缺省集合在这里同样是空数组，
  // 因此「校验通过」的初态一定能建库，不会在校验之后才 TypeError。
  const sourceFiles = collectionOf(initialState, 'files').value;
  const sourceVersions = collectionOf(initialState, 'versions').value;
  const sourceBlobs = collectionOf(initialState, 'blobs').value;
  const sourceChanges = collectionOf(initialState, 'changes').value;
  const sourceUploads = collectionOf(initialState, 'upload_sessions').value;
  const sourceLedger = collectionOf(initialState, 'idempotency').value;
  const sourceRequestLog = collectionOf(initialState, 'request_log').value;
  const sourceReserved = collectionOf(initialState, 'reserved_operation_ids').value;

  const versions = sourceVersions.map((version) => deepClone(version));
  const versionById = new Map(versions.map((version) => [version.version_id, version]));

  // 幂等账本由初态显式携带历史操作的指纹、首次请求 ID 与结果。
  // 绝不能从空账本开始：否则历史 operation_id 会被当成新操作重复写入。
  // 深拷贝是必须的：账本里的 result 是嵌套对象，浅拷贝会让运行时改写
  // 反向污染初态与旧快照。
  const idempotency = new Map();
  for (const entry of sourceLedger) {
    idempotency.set(entry.operation_id, {
      fingerprint: entry.fingerprint,
      request_id: entry.request_id,
      result: deepClone(entry.result),
    });
  }

  // 所有历史 Change 的 operation_id 都已被占用：即便没有完整的首次请求可以重放，
  // 也不允许换一个 operation 类型复用同一个 ID。`reserved_operation_ids` 补充
  // 那些从未成功写入、但仍必须视为已使用的 ID。
  const usedOperations = new Map();
  for (const change of sourceChanges) {
    usedOperations.set(change.operation_id, {
      change_id: change.change_id,
      request_id: idempotency.get(change.operation_id)?.request_id ?? null,
      replayable: idempotency.has(change.operation_id),
    });
  }
  for (const operationId of sourceReserved) {
    if (!usedOperations.has(operationId)) {
      usedOperations.set(operationId, { change_id: null, request_id: null, replayable: false });
    }
  }

  // 删除 `request_sequence` 时不能从 1 重新开始：历史 request_id 可能已经被占用，
  // 尤其是历史 replay 会分配新的 request_id，必须跳过所有已用序号。
  const historyNumbers = usedRequestNumbers(initialState);
  const derivedSequence = (historyNumbers.length > 0 ? Math.max(...historyNumbers) : 0) + 1;

  return {
    protocol_version: PROTOCOL_VERSION,
    vault_id: initialState.vault_id,
    vault_revision: initialState.vault_revision,
    min_available_revision: initialState.min_available_revision ?? 0,
    request_sequence: initialState.request_sequence ?? derivedSequence,
    files: sourceFiles.map((file) => {
      const current = file.current_version_id ? versionById.get(file.current_version_id) ?? null : null;
      return {
        file_id: file.file_id,
        path: normalizePath(file.path),
        format: file.format,
        is_deleted: file.is_deleted === true,
        current_version_id: current ? current.version_id : null,
        current_content_hash: current ? current.content_hash : null,
        current_size: current ? current.content_size : null,
        current_blob_id: current ? current.blob_id : null,
        updated_at: current?.created_at ?? null,
        updated_by_device_id: current?.created_by_device_id ?? null,
      };
    }),
    versions,
    blobs: sourceBlobs.map((blob) => deepClone(blob)),
    changes: sourceChanges.map((change) => deepClone(change)),
    uploads: sourceUploads.map((upload) => deepClone(upload)),
    // operation_id -> { fingerprint, request_id, result }
    idempotency,
    // operation_id -> { change_id, request_id, replayable }
    usedOperations,
    // 已分配出去的请求跟踪标识（只用于唯一性检查，不影响协议状态比较）。
    issuedRequestIds: sourceRequestLog.map((entry) => entry.request_id),
  };
}

/**
 * 分配下一个 `request_id`。
 *
 * 格式契约是 `req_` + **恰好**六位数字，所以序号只能落在 1..999999。
 * 超出范围时不能静默生成 `req_1000000`（七位）——那会直接违反格式，
 * 而且 `REQUEST_ID_RE` 会让后续校验把合法响应误判为非法。这里抛错、
 * 由调用方转成稳定的 `REQUEST_ID_EXHAUSTED`，绝不生成七位标识。
 */
const nextRequestId = (state) => {
  const issued = new Set(state.issuedRequestIds ?? []);
  let candidate;
  do {
    // 下界与上界共用同一条规则：序号必须落在 1..999999，`req_000000` 永远不是合法标识。
    if (state.request_sequence < 1 || state.request_sequence > MAX_REQUEST_SEQUENCE) {
      throw new RequestIdExhaustedError(
        `request_id 序号不可用：下一个序号 ${state.request_sequence} 不在 1..${MAX_REQUEST_SEQUENCE} 内，无法生成 req_ 加六位数字的标识`,
      );
    }
    candidate = `req_${pad(state.request_sequence, REQUEST_ID_DIGITS)}`;
    state.request_sequence += 1;
  } while (issued.has(candidate));
  state.issuedRequestIds = [...issued, candidate];
  return candidate;
};

class RequestIdExhaustedError extends Error {}

export const findFile = (state, fileId) => state.files.find((file) => file.file_id === fileId) ?? null;
export const findVersion = (state, versionId) => state.versions.find((version) => version.version_id === versionId) ?? null;
export const findBlob = (state, blobId) => state.blobs.find((blob) => blob.blob_id === blobId) ?? null;

/**
 * 接受两种请求表示：内部 `{ method, endpoint, headers, body, query }`，
 * 或浏览器/Node 的标准 `Request`。
 *
 * 标准 `Request` 的正文必须真正读取：`POST /sync/changes` 的 JSON 体是该端点唯一的
 * 业务输入，静默丢弃会把它变成「缺字段请求」。`GET /sync/manifest` 按契约没有正文，
 * 这里也不读取、不要求正文。
 *
 * 读取正文时用 `clone()`，避免调用方复用同一个 `Request` 对象（例如连续重试）时
 * 第二次拿到已被消费的空 body。
 */
const normalizeRequest = async (input) => {
  if (typeof Request !== 'undefined' && input instanceof Request) {
    const url = new URL(input.url);
    const headers = Object.fromEntries(input.headers);
    let body;
    let bodyError = null;
    const hasBodyMethod = input.method !== 'GET' && input.method !== 'HEAD';
    if (hasBodyMethod) {
      const text = await input.clone().text();
      if (text.length > 0) {
        try {
          body = JSON.parse(text);
        } catch {
          bodyError = '请求体不是合法 JSON';
        }
      }
    }
    return {
      request: { method: input.method, endpoint: url.pathname, headers, query: url.searchParams, body },
      bodyError,
    };
  }
  return { request: input ?? {}, bodyError: null };
};

/**
 * 处理一次请求。`ctx.resolveUpload(blob_reference)` 返回已上传正文的 Buffer（可为 Promise）。
 * 返回 Promise<{ status, body }>，并就地更新 state。
 */
export async function handleRequest(state, input, ctx) {
  const { request, bodyError } = await normalizeRequest(input);
  const endpoint = parseEndpoint(request.endpoint);
  // 定位字段由请求本身推导：成功与错误响应共用同一条规则，
  // 端点不属于协议时 `allowed_method` 为 `null`（字段本身仍然存在）。
  const envelopeFor = (value) => {
    const parsed = parseEndpoint(value?.endpoint);
    return {
      endpoint: typeof value?.endpoint === 'string' ? value.endpoint : null,
      method: typeof value?.method === 'string' ? value.method : null,
      allowed_method: parsed ? METHODS[parsed.kind] : null,
    };
  };
  let requestId;
  try {
    requestId = nextRequestId(state);
  } catch (error) {
    // 序号用尽时绝不静默生成七位 `req_1000000`：返回稳定错误码，且不改变协议状态。
    if (error instanceof RequestIdExhaustedError) {
      return fail(null, 503, ERROR_CODES.REQUEST_ID_EXHAUSTED, error.message, {}, envelopeFor(request));
    }
    throw error;
  }

  // 所有错误响应都带同一组定位字段：endpoint / method / allowed_method。
  // 端点不属于协议时 allowed_method 为 null，仍然保留字段本身。
  const envelope = envelopeFor(request);
  const failWith = (status, code, message, fields = {}) => fail(requestId, status, code, message, fields, envelope);
  // 成功响应必须携带与错误响应相同的定位字段：submit / pull / manifest 三种模式共用。
  const okWith = (fields) => ok(requestId, fields, envelope);

  if (!endpoint) {
    return failWith(404, ERROR_CODES.ENDPOINT_NOT_FOUND, '未知的同步接口路径。');
  }

  // 方法与路径联合校验：路径存在但方法不符属于 METHOD_NOT_ALLOWED，不是 404。
  // HTTP 方法区分大小写，必须与契约精确一致；`post` 不等于 `POST`。
  const expectedMethod = METHODS[endpoint.kind];
  const actualMethod = request?.method;
  if (actualMethod !== expectedMethod) {
    return failWith(405, ERROR_CODES.METHOD_NOT_ALLOWED, `${endpoint.kind} 端点只接受 ${expectedMethod}。`);
  }

  const headers = isPlainObject(request.headers) ? request.headers : {};
  const lookup = queryLookup(request);
  const queryVaultId = lookup('vault_id');
  const isManifest = endpoint.kind === 'manifest';
  const body = isPlainObject(request.body) ? request.body : {};

  // GET 请求没有正文：manifest 的 vault_id 取自路由，device_id 取自请求头或查询参数。
  // 查询串里的 vault_id 只用于「与路由一致性」校验，绝不会成为 vault_id 的来源。
  const identifiers = isManifest
    ? { vault_id: endpoint.vaultFromRoute, device_id: headerValue(headers, 'X-Device-Id') ?? lookup('device_id') }
    : body;

  // 第 1 步（续）：三种模式共用的必填标识校验。
  // `vault_id` 与 `device_id` 缺省、为 null、空串或类型不对都是 INVALID_REQUEST；
  // 「缺失」绝不能退化成 VAULT_MISMATCH —— 校验顺序本身是协议的一部分。
  // manifest 的 vault_id 来自路由；device_id 必须显式提供，不再补 null。
  const identifierFields = isManifest ? ['device_id'] : ['vault_id', 'device_id'];
  const invalidIdentifiers = invalidIdentifierFields(identifiers, identifierFields);
  if (invalidIdentifiers.length > 0) {
    // 请求体无法解析时同样落到这里：缺的是整个合法请求体。
    return failWith(400, ERROR_CODES.INVALID_REQUEST, 'vault_id 与 device_id 是必填的非空字符串。', {
      missing_fields: invalidIdentifiers,
      ...(bodyError ? { body_error: bodyError } : {}),
    });
  }

  // 必填与类型校验通过后才比较 Vault：此时不一致才真的是「Vault 不匹配」。
  // 路由 Vault 不属于当前 Vault 返回 404 分支。
  if (endpoint.vaultFromRoute !== state.vault_id) {
    return failWith(404, ERROR_CODES.VAULT_MISMATCH, '路由中的 vault_id 不存在或不属于当前设备。', {
      vault_id: endpoint.vaultFromRoute,
      expected_vault_id: state.vault_id,
    });
  }
  // 查询参数若显式携带 vault_id，必须与路由一致；一致时允许存在，不构成错误。
  if (queryVaultId !== undefined && queryVaultId !== state.vault_id) {
    return failWith(404, ERROR_CODES.VAULT_MISMATCH, '查询参数的 vault_id 与路由不一致。', {
      vault_id: queryVaultId,
      expected_vault_id: state.vault_id,
    });
  }
  // 请求体 vault_id 与路由比较：查询参数不参与，保持「正文校验正文」。
  if (!isManifest && body.vault_id !== state.vault_id) {
    return failWith(400, ERROR_CODES.VAULT_MISMATCH, '请求体 vault_id 与路由不一致。', {
      vault_id: body.vault_id,
      expected_vault_id: state.vault_id,
    });
  }

  if (bodyError) {
    return failWith(400, ERROR_CODES.INVALID_REQUEST, '请求体不是合法 JSON。', {
      body_error: bodyError,
    });
  }

  if (isManifest) {
    return handleManifest(state, okWith, { vault_id: endpoint.vaultFromRoute, device_id: identifiers.device_id });
  }

  if (body.mode === 'submit') {
    return handleSubmit(state, requestId, body, headers, ctx, failWith, okWith);
  }
  if (body.mode === 'pull') {
    return handlePull(state, body, failWith, okWith);
  }
  return failWith(400, ERROR_CODES.MODE_REQUIRED, 'sync/changes 需要 mode 为 submit 或 pull。', {
    // `mode` 是成功响应的业务字段；错误响应不携带它。
    // 被拒绝的取值用独立的恢复字段 `requested_mode` 回显，避免破坏「错误响应无 mode」。
    requested_mode: body.mode ?? null,
  });
}

async function handleSubmit(state, requestId, body, headers, ctx, failWith, okWith) {
  // `vault_id` 与 `device_id` 已在 handleRequest 完成必填与类型校验，这里不再重复。
  const missing = missingFields(body, [
    'operation_id',
    'file_id',
    'operation',
    'path',
    'base_revision',
    'blob_reference',
    'content_hash',
    'content_size',
    'client_timestamp',
    'metadata',
  ]);
  if (missing.length > 0) {
    return failWith(400, ERROR_CODES.INVALID_REQUEST, '提交缺少必需字段。', { missing_fields: missing });
  }

  // ---- 字段类型与取值校验 ----
  // 按协议第 5 节，第 2 步要把全部字段的类型与取值查完，第 3 步才判断 operation 是否受支持。
  // 因此「未知 operation + 非法 content_hash」这类组合请求必须报 INVALID_REQUEST，
  // 而不是因为先撞上 operation 分支就报 OPERATION_NOT_SUPPORTED。
  const operation = body.operation;
  // 类型先于取值：`operation` 不是字符串属于类型错误，不能落进「未知操作名」。
  if (!isNonEmptyString(operation)) {
    return failWith(400, ERROR_CODES.INVALID_REQUEST, 'operation 必须是非空字符串。', {
      operation: operation ?? null,
    });
  }
  if (!isNonNegativeInt(body.base_revision)) {
    return failWith(400, ERROR_CODES.INVALID_REQUEST, 'base_revision 必须是非负整数。', {
      base_revision: body.base_revision,
    });
  }
  if (body.base_revision > state.vault_revision) {
    return failWith(400, ERROR_CODES.INVALID_REQUEST, 'base_revision 不能超过服务端当前 vault_revision。', {
      base_revision: body.base_revision,
      vault_revision: state.vault_revision,
    });
  }
  if (!isNonEmptyString(body.operation_id)) {
    return failWith(400, ERROR_CODES.INVALID_REQUEST, 'operation_id 必须是非空字符串。', {
      operation_id: body.operation_id ?? null,
    });
  }
  // 标识字段必须在任何业务查找之前完成类型校验，否则 `file_id: 123` 会被误报成 FILE_NOT_FOUND。
  if (!isNonEmptyString(body.file_id)) {
    return failWith(400, ERROR_CODES.INVALID_REQUEST, 'file_id 必须是非空字符串。', {
      file_id: body.file_id ?? null,
    });
  }
  if (!isNonEmptyString(body.blob_reference)) {
    return failWith(400, ERROR_CODES.INVALID_REQUEST, 'blob_reference 必须是非空字符串。', {
      blob_reference: body.blob_reference ?? null,
    });
  }
  if (!isSha256(body.content_hash)) {
    return failWith(400, ERROR_CODES.INVALID_REQUEST, 'content_hash 必须是 sha256:<小写十六进制>。', {
      content_hash: body.content_hash,
    });
  }
  if (!isNonNegativeInt(body.content_size)) {
    return failWith(400, ERROR_CODES.INVALID_REQUEST, 'content_size 必须是非负整数。', {
      content_size: body.content_size,
    });
  }
  if (!isNormalizedPath(body.path) || normalizePath(body.path) !== body.path) {
    return failWith(400, ERROR_CODES.INVALID_REQUEST, 'path 必须是规范化后的 Vault 相对路径。', {
      path: body.path,
    });
  }
  if (!isPlainObject(body.metadata)) {
    return failWith(400, ERROR_CODES.INVALID_REQUEST, 'metadata 必须是对象，且必须包含 format。', {
      metadata: body.metadata ?? null,
    });
  }
  // `format` 是 metadata 的必填项：空对象 `{}` 或显式 `format: null` 都是 INVALID_REQUEST。
  // 文档、模型与测试必须一致，不能出现「文档说至少包含 format，空对象却能提交」。
  if (!Object.hasOwn(body.metadata, 'format') || body.metadata.format === null) {
    return failWith(400, ERROR_CODES.INVALID_REQUEST, 'metadata.format 是必填字段。', {
      metadata: body.metadata,
      missing_fields: ['metadata.format'],
    });
  }
  if (!METADATA_FORMATS.includes(body.metadata.format)) {
    return failWith(400, ERROR_CODES.INVALID_REQUEST, `metadata.format 必须是 ${METADATA_FORMATS.join(' / ')} 之一。`, {
      metadata: body.metadata,
      allowed_formats: METADATA_FORMATS,
    });
  }
  if (body.metadata.line_ending !== undefined && !LINE_ENDINGS.includes(body.metadata.line_ending)) {
    return failWith(400, ERROR_CODES.INVALID_REQUEST, `metadata.line_ending 必须是 ${LINE_ENDINGS.join(' / ')} 之一。`, {
      metadata: body.metadata,
      allowed_line_endings: LINE_ENDINGS,
    });
  }
  if (!isRfc3339Utc(body.client_timestamp)) {
    return failWith(400, ERROR_CODES.INVALID_REQUEST, 'client_timestamp 必须是 RFC 3339 UTC 时间，例如 2026-11-21T09:05:00Z。', {
      client_timestamp: body.client_timestamp ?? null,
    });
  }

  // 基准至少提供一项：null 与缺省一样视为未提供，不能靠两个 null 绕过冲突判定。
  const providedVersion = body.base_version_id !== undefined && body.base_version_id !== null;
  const providedHash = body.base_content_hash !== undefined && body.base_content_hash !== null;
  if (!providedVersion && !providedHash) {
    return failWith(400, ERROR_CODES.BASE_REQUIRED, '更新已有内容必须提供 base_version_id 或 base_content_hash。', {
      file_id: body.file_id,
    });
  }
  if (providedVersion && !isNonEmptyString(body.base_version_id)) {
    return failWith(400, ERROR_CODES.INVALID_REQUEST, 'base_version_id 必须是非空字符串。', {
      base_version_id: body.base_version_id,
    });
  }
  if (providedHash && !isSha256(body.base_content_hash)) {
    return failWith(400, ERROR_CODES.INVALID_REQUEST, 'base_content_hash 必须是 sha256:<小写十六进制>。', {
      base_content_hash: body.base_content_hash,
    });
  }

  // ---- 第 3 步：operation 是否受支持 ----
  // 只有全部字段都通过类型与取值校验后才走到这里，因此组合非法请求稳定返回 INVALID_REQUEST。
  if (!KNOWN_OPERATIONS.has(operation)) {
    return failWith(400, ERROR_CODES.OPERATION_NOT_SUPPORTED, '未知的操作类型。', {
      operation,
      supported_operations: OPERATION_TYPES,
    });
  }
  if (!EXECUTABLE.has(operation)) {
    return failWith(400, ERROR_CODES.OPERATION_NOT_SUPPORTED, 'v1 契约样例只冻结 update_file_content 的写入行为。', {
      operation,
      executable_operations: EXECUTABLE_OPERATIONS,
    });
  }

  // 请求头字段名大小写无关：`Idempotency-Key`、`idempotency-key`、`IDEMPOTENCY-KEY`
  // 是同一个头；只按两种拼写精确查表会让混合大小写带着错误值也能写库。
  const idempotencyKey = headerValue(headers, 'Idempotency-Key');
  if (idempotencyKey !== undefined && idempotencyKey !== body.operation_id) {
    return failWith(400, ERROR_CODES.IDEMPOTENCY_KEY_MISMATCH, 'Idempotency-Key 必须与 operation_id 一致。', {
      idempotency_key: idempotencyKey,
      operation_id: body.operation_id,
    });
  }

  // 步骤 2：幂等账本。命中即原样返回首次业务结果，不再做基准判断。
  const recorded = state.idempotency.get(body.operation_id);
  if (recorded) {
    if (recorded.fingerprint !== payloadFingerprint(body)) {
      // 首次结果**存在**：冲突响应必须仍能让客户端恢复该首次结果。
      // 因此回指占用该 ID 的 Change、首次请求与首次业务字段，并标记 replayable=true。
      const recordedChangeId = recorded.result?.change_id ?? state.usedOperations.get(body.operation_id)?.change_id ?? null;
      return failWith(409, ERROR_CODES.IDEMPOTENCY_KEY_REUSED, 'operation_id 已用于另一份请求内容。', {
        operation_id: body.operation_id,
        change_id: recordedChangeId,
        original_request_id: recorded.request_id,
        replayable: true,
        // 首次结果允许的恢复字段：客户端据此定位首次版本，而不是只能看到错误码。
        version_id: recorded.result?.version_id ?? null,
        file_id: recorded.result?.file_id ?? null,
        vault_revision: recorded.result?.vault_revision ?? null,
      });
    }
    // 重放同样是成功响应：必须携带与首次响应一致的定位字段。
    return okWith({
      ...recorded.result,
      request_id: requestId,
      original_request_id: recorded.request_id,
      replayed: true,
    });
  }

  // 历史 operation_id 已占用但无完整首次请求可重放：仍然必须拒绝，
  // 不能因为「没有账本条目」就允许换一个 operation 类型再写一条 Change。
  const used = state.usedOperations.get(body.operation_id);
  if (used) {
    return failWith(409, ERROR_CODES.IDEMPOTENCY_KEY_REUSED, 'operation_id 已被历史操作占用，不能用于新的操作。', {
      operation_id: body.operation_id,
      change_id: used.change_id ?? null,
      original_request_id: used.request_id ?? null,
      // 该 ID 来自历史 Change 或显式保留账本，没有可重放的首次结果。
      replayable: used.replayable,
    });
  }

  // 步骤 3：目标文件基准校验。只看目标文件当前版本，不看 Vault 游标。
  const file = findFile(state, body.file_id);
  if (!file) {
    return failWith(404, ERROR_CODES.FILE_NOT_FOUND, '目标文件不存在。', { file_id: body.file_id });
  }
  if (normalizePath(body.path) !== file.path) {
    return failWith(400, ERROR_CODES.PATH_MISMATCH, '内容更新必须沿用目标文件当前路径；路径变化属于移动或重命名操作。', {
      file_id: body.file_id,
      path: body.path,
      current_path: file.path,
    });
  }
  // `metadata.format` 已在字段校验阶段确认存在且属枚举，这里直接与目标文件格式比对。
  if (body.metadata.format !== file.format) {
    return failWith(400, ERROR_CODES.FORMAT_MISMATCH, 'metadata.format 与目标文件格式不一致。', {
      file_id: body.file_id,
      format: body.metadata.format,
      current_format: file.format,
    });
  }

  const versionMatches = !providedVersion || body.base_version_id === file.current_version_id;
  const hashMatches = !providedHash || body.base_content_hash === file.current_content_hash;

  if (!versionMatches || !hashMatches) {
    return failWith(409, ERROR_CODES.FILE_VERSION_CONFLICT, '目标文件已被修改，提交基准落后于服务端当前版本。', {
      file_id: file.file_id,
      path: file.path,
      base_version_id: providedVersion ? body.base_version_id : null,
      base_content_hash: providedHash ? body.base_content_hash : null,
      current_version_id: file.current_version_id,
      current_content_hash: file.current_content_hash,
      current_content_size: file.current_size,
      current_blob_id: file.current_blob_id,
      conflict_resolution: 'fetch_current_version_then_three_way_merge',
    });
  }

  // 步骤 4：内容校验。Blob 已上传，服务端按完整原始字节复核大小与 SHA-256。
  // 上传会话按 `vault_id` + `blob_reference` 查找：只核对引用会让其他 Vault 的会话跨界复用。
  const upload = state.uploads.find(
    (entry) => entry.blob_reference === body.blob_reference && entry.vault_id === state.vault_id,
  );
  if (!upload || upload.status !== 'completed') {
    return failWith(409, ERROR_CODES.UPLOAD_NOT_READY, 'blob_reference 没有对应的已完成上传会话。', {
      file_id: file.file_id,
      blob_reference: body.blob_reference,
    });
  }

  const bytes = await ctx.resolveUpload(body.blob_reference);
  if (!Buffer.isBuffer(bytes)) {
    throw new Error(`resolveUpload 必须为 ${body.blob_reference} 返回 Buffer`);
  }
  const actualHash = sha256Of(bytes);
  const actualSize = bytes.length;

  // 上传会话本身就是一份「内容指纹声明」：完成态记录的哈希与大小必须与请求、
  // 以及实际取回的字节三方一致。只比对请求与实际字节是不够的——会话被篡改成
  // 另一份内容（或另一份大小）后，提交仍会被放行，账本里就会留下无法追责的首次结果。
  if (actualSize !== body.content_size || upload.content_size !== body.content_size || upload.content_size !== actualSize) {
    return failWith(409, ERROR_CODES.CONTENT_SIZE_MISMATCH, 'content_size 与实际上传字节数或上传会话记录不一致。', {
      file_id: file.file_id,
      blob_reference: body.blob_reference,
      content_size: body.content_size,
      actual_content_size: actualSize,
      upload_content_size: upload.content_size ?? null,
    });
  }
  if (actualHash !== body.content_hash || upload.content_hash !== body.content_hash || upload.content_hash !== actualHash) {
    return failWith(409, ERROR_CODES.CONTENT_HASH_MISMATCH, 'content_hash 与实际上传字节的 SHA-256 或上传会话记录不一致。', {
      file_id: file.file_id,
      blob_reference: body.blob_reference,
      content_hash: body.content_hash,
      actual_content_hash: actualHash,
      upload_content_hash: upload.content_hash ?? null,
    });
  }

  // 步骤 5：提交状态变化。
  // revision 必须落在可安全表示的整数范围内：`MAX_SAFE_INTEGER + 1` 在浮点下会等于
  // `MAX_SAFE_INTEGER`，继续写入就会「加一后复用同一个 revision」。因此提交前先检测耗尽，
  // 返回稳定错误且不改变任何状态。
  if (state.vault_revision >= MAX_SAFE_REVISION) {
    return failWith(503, ERROR_CODES.REVISION_EXHAUSTED, 'vault_revision 已到达可安全表示的上界，无法再分配唯一 revision。', {
      vault_revision: state.vault_revision,
      max_safe_revision: MAX_SAFE_REVISION,
    });
  }
  const revision = state.vault_revision + 1;
  const versionId = versionIdFor(state, file.file_id);
  const changeId = changeIdFor(state, revision);
  const blobId = blobIdForHash(actualHash);
  const parentVersionId = file.current_version_id;

  // 内容寻址按**完整哈希**复用；命中已有记录时必须核对哈希与大小，不能静默复用不自洽的 Blob。
  const existingBlob = state.blobs.find((blob) => blob.content_hash === actualHash);
  if (existingBlob) {
    if (existingBlob.blob_id !== blobId) {
      throw new Error(`Blob ${existingBlob.blob_id} 的标识与完整哈希 ${actualHash} 不一致`);
    }
    if (existingBlob.content_size !== actualSize) {
      // 错误必须同时给出「上传会话声明的大小」，否则客户端无法判断是会话记录损坏
      // 还是实际字节不符合预期（两者需要不同的恢复动作）。
      return failWith(409, ERROR_CODES.CONTENT_SIZE_MISMATCH, '复用 Blob 时记录大小与实际字节数不一致。', {
        file_id: file.file_id,
        blob_reference: body.blob_reference,
        content_size: body.content_size,
        actual_content_size: actualSize,
        upload_content_size: upload.content_size ?? null,
        blob_content_size: existingBlob.content_size,
        blob_id: existingBlob.blob_id,
      });
    }
  } else if (!findBlob(state, blobId)) {
    state.blobs.push({
      blob_id: blobId,
      vault_id: state.vault_id,
      content_hash: actualHash,
      content_size: actualSize,
      created_by_device_id: body.device_id,
    });
  }

  state.versions.push({
    version_id: versionId,
    file_id: file.file_id,
    vault_revision: revision,
    blob_id: blobId,
    content_hash: actualHash,
    content_size: actualSize,
    base_version_id: parentVersionId,
    created_by_device_id: body.device_id,
    created_at: body.client_timestamp,
    // 版本必须保存用于核对的 metadata：format 必填，line_ending 与请求一致（缺省则不写）。
    // 只写顶层版本字段会让「版本 metadata ↔ 请求 metadata」无法在加载阶段核对。
    metadata: {
      format: body.metadata.format,
      ...(body.metadata.line_ending !== undefined ? { line_ending: body.metadata.line_ending } : {}),
    },
  });

  file.current_version_id = versionId;
  file.current_content_hash = actualHash;
  file.current_size = actualSize;
  file.current_blob_id = blobId;
  // 内容更新写入成功即恢复软删除：最后一条 Change 是 update_file_content，
  // 文件状态必须与之一致（IS_DELETED=false），不能留下「200 后仍删除」的自相矛盾状态。
  file.is_deleted = false;
  file.updated_at = body.client_timestamp;
  file.updated_by_device_id = body.device_id;

  state.changes.push({
    change_id: changeId,
    vault_id: state.vault_id,
    vault_revision: revision,
    operation: 'update_file_content',
    file_id: file.file_id,
    path: file.path,
    version_id: versionId,
    parent_version_id: parentVersionId,
    content_hash: actualHash,
    content_size: actualSize,
    operation_id: body.operation_id,
    device_id: body.device_id,
    client_timestamp: body.client_timestamp,
    created_at: body.client_timestamp,
  });
  state.vault_revision = revision;

  const result = {
    mode: 'submit',
    replayed: false,
    vault_id: state.vault_id,
    device_id: body.device_id,
    operation_id: body.operation_id,
    file_id: file.file_id,
    path: file.path,
    version_id: versionId,
    parent_version_id: parentVersionId,
    change_id: changeId,
    blob_id: blobId,
    content_hash: actualHash,
    content_size: actualSize,
    vault_revision: revision,
  };

  state.idempotency.set(body.operation_id, {
    fingerprint: payloadFingerprint(body),
    request_id: requestId,
    result: { ...result, request_id: requestId, protocol_version: PROTOCOL_VERSION },
  });
  state.usedOperations.set(body.operation_id, {
    change_id: changeId,
    request_id: requestId,
    replayable: true,
  });

  return okWith(result);
}

function handlePull(state, body, failWith, okWith) {
  // `vault_id` 与 `device_id` 已在 handleRequest 统一完成必填与类型校验。
  const missing = missingFields(body, ['last_server_revision']);
  if (missing.length > 0) {
    return failWith(400, ERROR_CODES.INVALID_REQUEST, '拉取缺少必需字段。', { missing_fields: missing });
  }
  if (!isNonNegativeInt(body.last_server_revision)) {
    return failWith(400, ERROR_CODES.INVALID_REQUEST, 'last_server_revision 必须是非负整数。', {
      last_server_revision: body.last_server_revision,
    });
  }

  const cursor = body.last_server_revision;

  // 游标严格小于下界才需要快照恢复；等于下界仍可增量。
  if (cursor < state.min_available_revision) {
    return failWith(409, ERROR_CODES.CURSOR_TOO_OLD, '拉取游标早于服务端仍可增量提供的下界，需要先获取 manifest 快照。', {
      vault_id: state.vault_id,
      device_id: body.device_id,
      requested_revision: cursor,
      min_available_revision: state.min_available_revision,
      current_vault_revision: state.vault_revision,
      manifest_endpoint: ENDPOINTS.manifest.replace('{vault_id}', state.vault_id),
    });
  }

  const changes = state.changes
    .filter((change) => change.vault_revision > cursor)
    .sort((left, right) => left.vault_revision - right.vault_revision)
    .map((change) => deepClone(change));

  return okWith({
    mode: 'pull',
    vault_id: state.vault_id,
    device_id: body.device_id,
    from_revision: cursor,
    to_revision: state.vault_revision,
    min_available_revision: state.min_available_revision,
    has_more: false,
    changes,
  });
}

function handleManifest(state, okWith, body) {
  // `vault_id` 与 `device_id` 已在 handleRequest 统一完成必填与类型校验，
  // 因此 manifest 不再把缺失的 device_id 默认为 null，响应直接回显该必填标识。
  const files = state.files
    .map((file) => ({
      file_id: file.file_id,
      path: file.path,
      format: file.format,
      current_version_id: file.current_version_id,
      current_content_hash: file.current_content_hash,
      content_size: file.current_size,
      blob_id: file.current_blob_id,
      is_deleted: file.is_deleted,
    }))
    .sort((left, right) => (left.path < right.path ? -1 : left.path > right.path ? 1 : 0));

  return okWith({
    mode: 'manifest',
    vault_id: state.vault_id,
    device_id: body.device_id,
    snapshot_revision: state.vault_revision,
    min_available_revision: state.min_available_revision,
    files,
  });
}

export { isSha256, isNormalizedPath, isRfc3339Utc };

/** 断言用视图：把状态压平成可以用点路径比较的结构。 */
export function projectState(state) {
  const files = {};
  for (const file of [...state.files].sort((left, right) => (left.file_id < right.file_id ? -1 : 1))) {
    files[file.file_id] = {
      path: file.path,
      format: file.format,
      is_deleted: file.is_deleted,
      current_version_id: file.current_version_id,
      current_content_hash: file.current_content_hash,
      current_size: file.current_size,
      current_blob_id: file.current_blob_id,
    };
  }

  const versions = {};
  for (const version of [...state.versions].sort((left, right) => (left.version_id < right.version_id ? -1 : 1))) {
    versions[version.version_id] = {
      file_id: version.file_id,
      vault_revision: version.vault_revision,
      blob_id: version.blob_id,
      content_hash: version.content_hash,
      content_size: version.content_size,
      base_version_id: version.base_version_id,
      created_by_device_id: version.created_by_device_id ?? null,
      created_at: version.created_at ?? null,
      metadata: deepClone(version.metadata ?? null),
    };
  }

  const blobs = {};
  for (const blob of [...state.blobs].sort((left, right) => (left.blob_id < right.blob_id ? -1 : 1))) {
    blobs[blob.blob_id] = { content_hash: blob.content_hash, content_size: blob.content_size };
  }

  return {
    vault_id: state.vault_id,
    vault_revision: state.vault_revision,
    min_available_revision: state.min_available_revision,
    counts: {
      files: state.files.length,
      versions: state.versions.length,
      blobs: state.blobs.length,
      changes: state.changes.length,
      operations: state.idempotency.size,
      uploads: state.uploads.length,
      used_operations: state.usedOperations.size,
    },
    files,
    versions,
    blobs,
    changes: state.changes.map((change) => ({
      change_id: change.change_id,
      vault_revision: change.vault_revision,
      operation: change.operation,
      file_id: change.file_id,
      path: change.path,
      version_id: change.version_id ?? null,
    })),
    change_ids: state.changes.map((change) => change.change_id),
    last_change: state.changes.length > 0 ? deepClone(state.changes[state.changes.length - 1]) : null,
    // 已占用但不可重放的 operation_id（历史 Change 与显式保留账本）。
    used_operation_ids: [...state.usedOperations.keys()].sort(),
    reserved_operation_ids: [...state.usedOperations.keys()]
      .filter((operationId) => !state.idempotency.has(operationId))
      .sort(),
  };
}

/**
 * 协议状态快照，用于比较「某次请求前后状态没有变化」。
 *
 * 覆盖所有影响协议结果的状态：files / versions / blobs / changes / uploads
 * （上传会话被改坏会让提交被错误放行或拒绝）、幂等账本（含指纹）与已占用 operation_id。
 * 请求跟踪计数器（`request_sequence` / 已发出的 request_id）不参与比较：它按设计在
 * **每一次**请求后都会推进，包括被拒绝的请求；其唯一性由 `requestTracking` 与
 * 独立的「request_id 全局唯一」断言负责。
 */
export function snapshotState(state) {
  const byKey = (key) => (left, right) => (left[key] < right[key] ? -1 : left[key] > right[key] ? 1 : 0);
  return {
    vault_id: state.vault_id,
    vault_revision: state.vault_revision,
    min_available_revision: state.min_available_revision,
    // 深拷贝：嵌套的 metadata / result 是可变的，浅拷贝会让旧快照随运行期改动一起漂移。
    files: [...state.files].sort(byKey('file_id')).map((file) => deepClone(file)),
    versions: [...state.versions].sort(byKey('version_id')).map((version) => deepClone(version)),
    blobs: [...state.blobs].sort(byKey('blob_id')).map((blob) => deepClone(blob)),
    changes: state.changes.map((change) => deepClone(change)),
    uploads: [...state.uploads].sort(byKey('blob_reference')).map((upload) => deepClone(upload)),
    idempotency: [...state.idempotency.entries()]
      .sort((left, right) => (left[0] < right[0] ? -1 : 1))
      .map(([operationId, entry]) => ({
        operation_id: operationId,
        // 指纹必须参与比较：只清空重放路径的指纹不会被「状态未变」发现。
        fingerprint: entry.fingerprint,
        request_id: entry.request_id,
        result: deepClone(entry.result),
      })),
    used_operations: [...state.usedOperations.entries()]
      .sort((left, right) => (left[0] < right[0] ? -1 : 1))
      .map(([operationId, entry]) => ({ operation_id: operationId, ...deepClone(entry) })),
  };
}

/**
 * 请求跟踪信息：下一个序号与已发出的 request_id。
 * 跟踪标识不属于 `snapshotState` 的比较范围（每次请求都会推进），但必须全局唯一。
 */
export function requestTracking(state) {
  return {
    next_request_sequence: state.request_sequence,
    issued_request_ids: [...(state.issuedRequestIds ?? [])],
  };
}
