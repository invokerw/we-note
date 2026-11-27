import { changeText } from "../mcp/content.ts";
import type { Call, Tool } from "../mcp/tools";

export type Config = {
  api: "openai-completions" | "openai-responses";
  baseUrl: string;
  model: string;
  usesApiKey?: boolean;
};
export function checkedConfig(c: Config): Config {
  const url = new URL(c.baseUrl.trim());
  if (
    !["http:", "https:"].includes(url.protocol) ||
    url.username ||
    url.password ||
    url.search ||
    url.hash
  )
    throw Error("请输入 HTTP 或 HTTPS 服务地址，不含密钥、查询参数或片段");
  if (
    !["openai-completions", "openai-responses"].includes(c.api) ||
    !c.model.trim()
  )
    throw Error("请选择模型协议并填写模型 ID");
  return {
    api: c.api,
    baseUrl: url.href.replace(/\/+$/, ""),
    model: c.model.trim(),
    ...(c.usesApiKey === true ? { usesApiKey: true } : {}),
  };
}
// Some model gateways require every property of a strict tool, including the
// property reserved for the other note kind. Keep the MCP contract canonical.
export function prepareCreateArguments(args: unknown) {
  if (!args || typeof args !== "object" || Array.isArray(args)) return args;
  const fields = args as Record<string, unknown>;
  if ((fields.kind === "markdown" || fields.kind === "text") && typeof fields.text === "string") {
    const { root_topic: _unused, ...note } = fields;
    return note;
  }
  if (fields.kind === "mindmap" && (fields.text == null || fields.text === "")) {
    const { text: _unused, ...map } = fields;
    return map;
  }
  return args;
}
export function checkReference(
  name: Tool,
  args: Record<string, unknown>,
  all: boolean,
  ids: Set<string>,
) {
  if (
    !all &&
    (name === "search_notes" ||
      ("file_id" in args && !ids.has(String(args.file_id))))
  )
    throw Error("请先引用目标笔记，或开启搜索本库");
}
export function prepareWrite(
  raw: Call,
  note?: Record<string, unknown>,
  branches: Map<string, string> = new Map(),
) {
  const call = structuredClone(raw);
  if (!("operation_id" in call.args)) throw Error("请选择写入工具");
  call.args.operation_id = crypto.randomUUID();
  if (
    "base_path" in call.args &&
    (call.args.base_path !== note?.path ||
      call.args.base_version_id !== note?.version_id ||
      call.args.file_id !== note?.file_id)
  )
    throw Error("FILE_VERSION_CONFLICT：请重新读取当前笔记");
  let summary: string;
  switch (call.name) {
    case "create_note":
      summary = call.args.text ?? `中心主题：${call.args.root_topic}`;
      break;
    case "edit_note": {
      const edit = call.args.edit,
        original = String(note?.text ?? "");
      changeText(original, edit);
      summary =
        edit.mode === "replace_text"
          ? `原文\n${edit.old_text}\n改为\n${edit.new_text || "（删除该段）"}`
          : edit.mode === "append"
            ? `追加\n${edit.text}`
            : `全文替换\n${original}\n改为\n${edit.text || "（清空正文）"}`;
      break;
    }
    case "move_note":
      summary = `移动到 ${call.args.new_path}`;
      break;
    case "delete_note":
      summary = "将这篇笔记移入回收站";
      break;
    case "edit_mindmap":
      summary = call.args.operations
        .map((op) => {
          const name = (id: string) => branches.get(id) ?? id;
          switch (op.op) {
            case "add_node":
              return `在 ${name(op.parent_id)} 下添加 ${op.topic}${op.ref ? " " + op.ref : ""}`;
            case "update_node":
              return `修改 ${name(op.node_id)}\n${[op.topic, op.note, op.tags?.join("、")].filter((x) => x !== undefined).join("\n")}`;
            case "delete_node":
              return `删除 ${name(op.node_id)}${op.subtree ? " 及全部后代" : ""}`;
            case "move_node":
              return `移动 ${name(op.node_id)} 到 ${name(op.parent_id)}${op.before_id ? "，放在 " + name(op.before_id) + " 之前" : ""}`;
          }
        })
        .join("\n");
      break;
    default:
      throw Error("未知写入工具");
  }
  return {
    call,
    summary,
    path: "path" in call.args ? call.args.path : call.args.base_path,
  };
}
