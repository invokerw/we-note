# Phase 0 任务书：同步操作协议 v1 与可执行契约样例

## 目标与范围

冻结三个会影响跨端一致性的行为：同一 `operation_id` 重试时返回首次处理结果，内容提交按目标文件的基准版本判断冲突，增量游标过旧时通过 manifest 快照恢复。交付后，后续服务端和客户端可以用同一组请求、初始状态和预期结果验证各自实现。

仓库目前只有 `docs/产品与技术设计.md` 和 `docs/设计评审记录.md`。以主设计第 6、7、9、10.4、20、21、22、25 节及评审记录为依据。本轮交付中文协议文档、机读夹具和内存中的契约检查。数据库、Blob 存储适配器、网络服务、客户端、三方合并和第 25 节的端到端闭环均留给后续任务。日志保留时长与配额不影响本轮判断，夹具直接给出 `min_available_revision`。

## 交付文件与接口

| 路径 | 内容 |
| --- | --- |
| `docs/同步操作协议-v1.md` | 中文字段表、操作类型、成功与错误结构、提交判定顺序、增量与快照恢复规则。文档示例指向对应夹具。 |
| `tests/sync-fixtures/` | JSON 场景文件，每个场景包含 `initial_state` 和有序 `steps`。每一步给出 `request`、`expected_result` 及可比较的 `expected_state` 或状态增量。目录内提供实际的 `.md`、`.txt`、`.json` 内容样本，由场景引用。 |
| `tests/protocol/sync-v1.test.mjs` | 使用 `node:test`、`node:assert/strict` 运行全部场景，使用 `node:fs` 读取夹具、`node:crypto` 校验正文。内存状态转换逻辑可放在同目录独立模块。 |

沿用第 10.4 节的 `POST /api/v1/vaults/{vault_id}/sync/changes` 和 `GET /api/v1/vaults/{vault_id}/sync/manifest`。主设计没有细分增量拉取的请求体，本任务约定在 `sync/changes` 中用 `mode: "submit"` 和 `mode: "pull"` 区分单操作提交与按游标拉取。上传会话在夹具中以已准备好的 `blob_reference` 表示，WebSocket 只承担通知职责。

## 需要冻结的协议

字段表应逐项注明类型、必填或可空条件、取值及含义。列全第 9.3 节的操作名，以下可执行写入场景聚焦 `update_file_content`。

| 字段 | v1 含义与约束 |
| --- | --- |
| `vault_id`、`device_id`、`operation_id` | 分别标识所属 Vault、发起设备和一次逻辑操作。请求体与路由的 Vault 一致。同一 Vault 内重试复用原操作 ID。单操作提交若带 `Idempotency-Key`，其值与 `operation_id` 一致。 |
| `file_id`、`operation`、`path` | 稳定的文件身份、操作类型、规范化的 Vault 相对路径。按 `vault_id` 和 `file_id` 定位文件；移动或重命名保留 `file_id`。 |
| `base_revision`、`last_server_revision` | 前者是提交方已应用的 Vault 游标，后者是拉取增量的起点。两者均为非负整数。文件提交能否接受取决于目标文件的基准。 |
| `base_version_id`、`base_content_hash` | 更新已有内容时至少提供一项，分别与目标文件的 `current_version_id`、当前版本的完整内容 SHA-256 比对。本任务约定两项都提供时须同时匹配。 |
| `blob_reference`、`content_hash`、`content_size` | 分别是待提交内容的引用、完整原始字节的 `sha256:<小写十六进制>`、字节数。哈希和大小校验通过后，版本才可引用对应 Blob。 |
| `client_timestamp`、`metadata` | 客户端时间和格式信息，例如 `format`、`line_ending`。变更顺序由服务端分配的 `vault_revision` 确定。 |
| `vault_revision`、`min_available_revision` | Vault 的当前变更序号和仍可用于增量拉取的最早游标。拉取游标等于下界时仍可增量，只返回严格晚于请求游标的 Change，按 revision 递增排列。 |

提交成功结果至少包含 `request_id`、`operation_id`、`file_id`、新 `version_id`、`change_id` 及本次提交的 `vault_revision`。一次有效内容更新产生一个新版本和一条 Change，更新文件的当前版本引用；新版本记录父版本和 Blob 引用。重复请求先查首次结果，再做文件基准判断。重试返回原版本、原 Change 和原 revision，Blob、版本与变更记录均无新增。`request_id` 用于请求跟踪，文档应说明其在重放时的取值规则。

错误响应包含 `request_id`、稳定的 `code`、可读 `message` 和恢复所需字段。本任务采用 `FILE_VERSION_CONFLICT` 表示目标文件基准过旧，返回 `file_id`、请求基准及服务端当前版本和哈希，供后续合并定位两侧内容。冲突提交保留远端当前版本和本地候选内容。采用 `CURSOR_TOO_OLD` 表示拉取游标严格小于 `min_available_revision`，返回下界和 manifest 获取入口。manifest 标明 `vault_id`、快照 revision，以及重建映射所需的 `file_id`、路径、当前版本和哈希。恢复方应用同一份快照后，从该快照的 revision 续拉。

## 可验证的验收条件

| 场景 | 输入与必须通过的断言 |
| --- | --- |
| 正常提交 Markdown | 读取实际 `.md` 字节，核对请求大小与 SHA-256。以匹配的 `base_version_id` 提交，验证父版本、Blob 引用、文件当前指针、新 Change 及返回 revision 相互对应。 |
| 重复请求 | 在首次成功后的状态中原样重放请求，此时旧基准已经落后。断言两次业务结果相同，并逐项比较重放前后的 Blob、版本、Change、当前指针及 Vault revision。 |
| 其他文件推进游标 | 从同一初始状态先成功更新文件 B，再用旧 `base_revision` 更新文件 A。A 使用仍匹配的 `base_content_hash` 和实际 `.txt` 内容。断言 A 成功、B 的结果保留、两条 Change 顺序正确。 |
| 同一文件基准过旧 | 先推进目标 JSON 文件，再以新的 `operation_id` 提交基于旧版本的本地 JSON。断言返回 `FILE_VERSION_CONFLICT`，错误中的当前版本能定位远端内容，远端指针、版本数、Change 数及 Vault revision 均保持冲突前的值。JSON 样本应可解析，哈希按文件原始字节计算。 |
| 过期游标恢复 | 以低于下界的游标拉取，断言返回 `CURSOR_TOO_OLD`。随后获取 manifest，按其中条目重建文件映射；在快照后再产生一条变更，从快照 revision 拉取并断言该变更恰好出现一次。另测游标恰好等于下界时可正常增量。 |

测试必须从初始状态逐步执行请求，把每一步的实际状态传给下一步。状态转换只能读取请求、样本和当前状态；预期结果仅供断言使用。测试入口还应检查五个必需场景及三种正文样本均已加载，防止夹具缺失导致空跑通过。

## 实现步骤

1. 编写协议文档，固定请求、响应、错误码和边界条件。用同一组字段名贯穿字段表、示例与夹具。
2. 建立三种内容样本和五类 JSON 场景。为文件、版本、Blob、Change 和快照提供可交叉核对的标识，明确每步执行前后的状态。
3. 编写最小内存契约模型与测试入口。按首次结果查询、目标文件基准校验、内容校验、提交状态变化的顺序执行写入；按日志下界执行增量拉取或进入快照恢复。
4. 完成正向运行和破坏性验证。在临时副本中分别跳过去重、改用 Vault 游标拒绝提交、放行过期文件基准、改用旧游标从快照续拉。每次只改一项并运行同一测试命令，验收对应场景因行为断言失败。恢复正确逻辑后全套通过。

## 测试命令

在仓库根目录运行，无需安装第三方依赖。

```sh
node --version
node --test tests/protocol/sync-v1.test.mjs
```

正常实现的退出码应为 `0`，测试输出能辨认五个场景。四次独立破坏验证的退出码均应非零，并能从失败断言定位到被破坏的协议行为。
