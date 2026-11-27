# WeNote 文件插件 SDK v1

开发、打包及验收约定见[文件插件开发规范](../../../docs/插件开发规范.md)。

在 `apps/web` 运行 `npm ci` 和 `node plugin-sdk/pack.mjs plugin-sdk/example /tmp/prefixed-text.zip` 可生成示例插件。从「插件」选择 ZIP，核对来源文件名、SHA-256、扩展名和权限后授权安装。示例打开第一行为 `WN1` 的 TXT，编辑时隐藏标记，保存时写回标记。「英文转大写」按钮通过可选清单字段 `actions` 调用 `action_uppercase`，只改变当前草稿。

包根目录需要 `manifest.json` 和 `core.wasm`。清单示例见 `example/manifest.json`。`api_version` 为字符串 `1`，版本使用三段数字。扩展名使用小写，例如 `.csv`、`.log` 或专用导图后缀 `.mind.json`。本地安装的插件优先于同格式的内置编辑器，禁用或卸载后由匹配的内置专用插件或默认文本编辑器接手。相同 ID 的包经重新授权后替换旧版。包和启用状态保存在当前浏览器或客户端配置中。

## WASM 接口

每次调用使用独立 Worker 和实例。插件只导入 `env.memory`，宿主提供固定 512 页（32 MiB）的内存。输入位于地址 0，最大 16 MiB。函数返回 `i64`，高 32 位为无符号输出地址，低 32 位为输出字节数。输出可以复用输入缓冲。宿主检查输出边界，单次调用限时 2.5 秒。包的压缩和展开大小均限 512 KiB。

| 导出函数 | 输入 | 输出 |
| --- | --- | --- |
| `open(i32 ptr, i32 len) -> i64` | 当前文件的原始字节 | UTF-8 编辑文本 |
| `serialize(i32 ptr, i32 len) -> i64` | 当前编辑文本的 UTF-8 字节 | 保存到原文件的字节 |
| `action_<id>(i32 ptr, i32 len) -> i64` | 当前草稿（UTF-8、LF） | `edit` 返回替换草稿的文本，`message` 返回提示文本 |

`parse` 是必需权限。声明 `edit` 和 `serialize` 后宿主允许修改、保存。`export` 启用编辑结果导出。只读插件可以只声明 `parse`。清单 API 和导入、导出接口在安装前校验。渲染由宿主文本控件完成。网络、凭据、其他文件以及原生桥接均无对应的 WASM 导入。

## 内置编辑器

Markdown 与 Mind Elixir 分别处理 `.md` 与 `.mind.json`。默认文本编辑器读取 UTF-8 文本并保留 BOM 和换行。无法解码的文件可下载原件。

## 客户端 MCP

每种新增文件格式都须通过 MCP 的增删改查验收。新增可编辑格式须在 v1 清单中声明 `"mcp_model": "text"` 或 `"mcp_model": "mindmap"`，并声明 `parse`、`edit` 和 `serialize`。前者将 `open` 的 UTF-8 结果交给文本工具，后者返回符合内置 `.mind.json` 结构的 JSON，支持稳定节点 ID 和子树操作。`serialize` 将编辑结果还原为该格式的持久内容。自定义后缀仍须满足 WeNote 的 UTF-8 存储约束。工具以文件实际匹配的已启用插件为准；离线请求绑定插件包哈希。发布前请用旧样例验证创建、查询、局部修改、删除和未改字段的往返结果。
