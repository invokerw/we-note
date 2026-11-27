import { readMindMap, type MindData } from "../plugins/mindFile.ts";

export function fail(code: string, message: string): never {
  throw Object.assign(new Error(`${code}: ${message}`), { code });
}
export type TextEdit =
  | { mode: "replace_text"; old_text: string; new_text: string }
  | { mode: "append" | "replace_all"; text: string };
export function validText(text: string, limit = 65536) {
  if (new TextEncoder().encode(text).length > limit)
    fail("NOTE_TOO_LARGE", "文件超出工具大小限制");
  if (text.includes("\0") || /[\uD800-\uDFFF]/u.test(text))
    fail("INVALID_TEXT", "正文必须是有效 UTF-8 文本");
  return text;
}
export function changeText(source: string, edit: TextEdit) {
  validText(source);
  if (edit.mode === "replace_text") {
    const start = source.indexOf(edit.old_text);
    if (start < 0) fail("TEXT_NOT_FOUND", "请重新读取原文");
    if (source.indexOf(edit.old_text, start + 1) >= 0)
      fail("TEXT_AMBIGUOUS", "请提供更多上下文");
    return validText(
      source.slice(0, start) +
        edit.new_text +
        source.slice(start + edit.old_text.length),
    );
  }
  return validText(edit.mode === "append" ? source + edit.text : edit.text);
}

type Node = MindData["nodeData"];
export type MapEdit =
  | {
      op: "add_node";
      parent_id: string;
      topic: string;
      before_id?: string;
      ref?: string;
    }
  | {
      op: "update_node";
      node_id: string;
      topic?: string;
      note?: string;
      tags?: string[];
    }
  | { op: "move_node"; node_id: string; parent_id: string; before_id?: string }
  | { op: "delete_node"; node_id: string; subtree?: boolean };
function parse(source: string) {
  try {
    const data = readMindMap(source);
    const tree = index(data.nodeData);
    for (const { node } of tree.values()) {
      if (node.note !== undefined && typeof node.note !== "string")
        throw Error();
      if (
        node.tags !== undefined &&
        (!Array.isArray(node.tags) ||
          node.tags.some(
            (tag) => typeof tag !== "string" && typeof tag?.text !== "string",
          ))
      )
        throw Error();
    }
    for (const arrow of data.arrows ?? [])
      if (!tree.has(arrow.from) || !tree.has(arrow.to)) throw Error();
    for (const summary of data.summaries ?? []) {
      const siblings = tree.get(summary.parent)?.node.children;
      if (
        !siblings ||
        !Number.isInteger(summary.start) ||
        !Number.isInteger(summary.end) ||
        summary.start < 0 ||
        summary.start > summary.end ||
        summary.end >= siblings.length
      )
        throw Error();
    }
    return data;
  } catch {
    return fail("INVALID_MINDMAP", "文件无法按原生导图读取");
  }
}
function index(root: Node) {
  const rows = new Map<
    string,
    { node: Node; parent?: Node; ancestors: string[]; position: number }
  >();
  function visit(
    node: Node,
    ancestors: string[],
    position: number,
    parent?: Node,
  ) {
    if (ancestors.length > 128 || rows.size >= 10000 || rows.has(node.id))
      fail("INVALID_MINDMAP", "节点过多、过深或 ID 重复");
    rows.set(node.id, { node, parent, ancestors, position });
    node.children?.forEach((child, i) =>
      visit(child, [...ancestors, node.id], i, node),
    );
  }
  visit(root, [], 0);
  return rows;
}
export function nodes(source: string) {
  return Array.from(
    index(parse(source).nodeData).values(),
    ({ node, parent, ancestors, position }) => ({
      node_id: node.id,
      parent_id: parent?.id ?? null,
      ancestors,
      position,
      topic: node.topic,
      note: node.note ?? "",
      tags: (node.tags ?? []).map((t) => (typeof t === "string" ? t : t.text)),
      child_count: node.children?.length ?? 0,
    }),
  );
}
export function changeMap(source: string, operations: MapEdit[]) {
  const data = parse(source);
  const refs: Record<string, string> = Object.create(null);
  const created: string[] = [];
  let removedNodes = 0,
    removedArrows = 0,
    removedSummaries = 0;
  for (const [step, op] of operations.entries()) {
    const tree = index(data.nodeData);
    const lookup = (id: string) =>
      tree.get(refs[id] ?? id) ??
      fail("NODE_NOT_FOUND", `第 ${step + 1} 项找不到节点`);
    if (op.op === "update_node") {
      const { node } = lookup(op.node_id);
      if (op.topic !== undefined) node.topic = op.topic;
      if (op.note !== undefined) node.note = op.note;
      if (op.tags !== undefined) node.tags = op.tags;
      continue;
    }
    const groups = (data.summaries ?? []).map((summary) => {
      const siblings = lookup(summary.parent).node.children ?? [];
      return {
        summary,
        ids: siblings
          .slice(summary.start, summary.end + 1)
          .map((child) => child.id),
      };
    });
    if (op.op === "delete_node") {
      const { node, parent } = lookup(op.node_id);
      if (!parent) fail("ROOT_NODE", "根节点不可删除");
      if (node.children?.length && !op.subtree)
        fail("HAS_CHILDREN", `该节点有 ${index(node).size - 1} 个后代`);
      const deleted = index(node);
      removedNodes += deleted.size;
      parent.children = parent.children!.filter((child) => child !== node);
      if (data.arrows)
        data.arrows = data.arrows.filter((arrow) => {
          const drop = deleted.has(arrow.from) || deleted.has(arrow.to);
          if (drop) removedArrows++;
          return !drop;
        });
    } else {
      const dest = lookup(op.parent_id);
      const before =
        op.before_id === undefined ? undefined : lookup(op.before_id);
      if (before && before.parent !== dest.node)
        fail("INVALID_POSITION", "定位节点不在目标父节点下");
      let moved: Node;
      if (op.op === "add_node") {
        moved = { id: crypto.randomUUID(), topic: op.topic };
        created.push(moved.id);
        if (op.ref) {
          if (refs[op.ref] || tree.has(op.ref))
            fail("INVALID_REF", "节点别名重复");
          refs[op.ref] = moved.id;
        }
      } else {
        const { node, parent } = lookup(op.node_id);
        if (
          !parent ||
          dest.node === node ||
          dest.ancestors.includes(node.id) ||
          before?.node === node
        )
          fail("INVALID_POSITION", "无法移动到此位置");
        parent.children = parent.children!.filter((child) => child !== node);
        moved = node;
      }
      const children = (dest.node.children ??= []);
      children.splice(
        before ? children.indexOf(before.node) : children.length,
        0,
        moved,
      );
    }
    const after = index(data.nodeData);
    if (data.summaries)
      data.summaries = groups.flatMap(({ summary, ids }) => {
        const members = ids.filter((id) => after.has(id));
        if (!after.has(summary.parent) || !members.length) {
          removedSummaries++;
          return [];
        }
        const parent = after.get(members[0])!.parent!;
        const siblings = parent.children!;
        const positions = members
          .map((id) => siblings.findIndex((child) => child.id === id))
          .sort((a, b) => a - b);
        if (
          positions[0] < 0 ||
          positions.at(-1)! - positions[0] + 1 !== members.length
        )
          fail("SUMMARY_RANGE_CONFLICT", "操作会拆散摘要");
        return [
          {
            ...summary,
            parent: parent.id,
            start: positions[0],
            end: positions.at(-1)!,
          },
        ];
      });
  }
  const text = validText(JSON.stringify(data), 16 << 20);
  parse(text);
  return {
    text,
    refs,
    created_node_ids: created,
    removed_nodes: removedNodes,
    removed_arrows: removedArrows,
    removed_summaries: removedSummaries,
  };
}
