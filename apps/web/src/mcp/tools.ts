import { z } from "zod";

const id = z.string().min(1).max(256),
  text = z.string(),
  nonempty = text.min(1);
const path = z.string().min(1).max(2048);
const kind = z.enum(["markdown", "text", "mindmap"]);
const page = {
  cursor: z.string().max(8192).optional(),
  limit: z.int().positive().max(50).optional(),
};
const base = {
  file_id: id,
  base_path: path,
  base_version_id: id,
  operation_id: id,
};
const object = z.strictObject;
const edit = z.discriminatedUnion("mode", [
  object({
    mode: z.literal("replace_text"),
    old_text: nonempty,
    new_text: text,
  }),
  object({ mode: z.literal("append"), text: nonempty }),
  object({ mode: z.literal("replace_all"), text }),
]);
const position = { parent_id: id, before_id: id.optional() };
const mapOp = z.discriminatedUnion("op", [
  object({
    op: z.literal("add_node"),
    ...position,
    topic: nonempty,
    ref: z
      .string()
      .regex(/^\$[\w-]+$/)
      .optional(),
  }),
  object({
    op: z.literal("update_node"),
    node_id: id,
    topic: nonempty.optional(),
    note: text.optional(),
    tags: z.array(text).optional(),
  }).refine(
    (x) =>
      x.topic !== undefined || x.note !== undefined || x.tags !== undefined,
  ),
  object({ op: z.literal("move_node"), node_id: id, ...position }),
  object({
    op: z.literal("delete_node"),
    node_id: id,
    subtree: z.boolean().optional(),
  }),
]);
export const inputs = {
  search_notes: object({ query: text, kind: kind.optional(), ...page }),
  read_note: object({ file_id: id }),
  read_mindmap_nodes: object({
    file_id: id,
    node_id: id.optional(),
    query: text.optional(),
    ...page,
    limit: z.int().positive().max(200).optional(),
  }),
  create_note: object({
    path,
    kind,
    operation_id: id,
    text: text.optional(),
    root_topic: nonempty.optional(),
  }).refine((x) =>
    x.kind === "mindmap"
      ? x.root_topic !== undefined && x.text === undefined
      : x.text !== undefined && x.root_topic === undefined,
  ),
  edit_note: object({ ...base, edit }),
  move_note: object({ ...base, new_path: path }),
  delete_note: object(base),
  edit_mindmap: object({ ...base, operations: z.array(mapOp).min(1).max(500) }),
};
export type Tool = keyof typeof inputs;
export type Call = {
  [K in Tool]: { name: K; args: z.infer<(typeof inputs)[K]> };
}[Tool];
const descriptions: Record<Tool, string> = {
  search_notes: "按路径、正文或导图主题查找笔记。空查询浏览当前授权库。",
  read_note: "读取正文或导图摘要，取得编辑所需的文件 ID、路径和基准版本。",
  read_mindmap_nodes:
    "读取原生导图节点与父节点 ID，可按子树、主题、备注和标签检索。",
  create_note:
    "新建文件。文本传 text，导图传 root_topic。每次逻辑操作生成一个 operation_id，重试时复用。",
  edit_note:
    "按读取的路径与版本精确替换片段、追加或替换全文。版本冲突时重新读取。",
  move_note: "按读取的路径与版本移动文件或改名，保留文件 ID。",
  delete_note: "将指定版本的文件移入回收站。",
  edit_mindmap:
    "在一个版本内有序编辑节点。父子关系按 ID 指定，新增节点可提供 $ 开头的批内别名。",
};
export const readOnly = (n: Tool) =>
  n === "search_notes" || n === "read_note" || n === "read_mindmap_nodes";
export const tools = Object.keys(inputs).map((key) => {
  const name = key as Tool;
  const inputSchema = z.toJSONSchema(inputs[name], { target: "draft-7" });
  return {
    name,
    description: descriptions[name],
    inputSchema,
    annotations: {
      readOnlyHint: readOnly(name),
      destructiveHint:
        name === "delete_note" ||
        name === "edit_mindmap" ||
        name === "edit_note",
    },
  };
});
export function parseCall(name: string, args: unknown): Call {
  if (!Object.hasOwn(inputs, name)) throw Error("UNKNOWN_TOOL");
  const result = inputs[name as Tool].safeParse(args);
  if (!result.success)
    throw Object.assign(
      Error(
        result.error.issues
          .map((x) => `${x.path.join(".")}: ${x.message}`)
          .join(", "),
      ),
      { code: "INVALID_ARGUMENTS" },
    );
  return { name, args: result.data } as Call;
}
