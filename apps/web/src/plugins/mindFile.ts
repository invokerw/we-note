import type MindElixir from "mind-elixir";

export type MindData = ReturnType<MindElixir["getData"]>;
export const mindSuffix = ".mind.json";
export function isMindMap(path: string) {
  return path.toLowerCase().endsWith(mindSuffix);
}

export function readMindMap(source: string): MindData {
  const data = JSON.parse(source.replace(/^\uFEFF/, ""), (key, value) => {
    if (
      ["dangerouslySetInnerHTML", "__proto__"].includes(key) ||
      (key === "parent" && typeof value !== "string")
    )
      throw Error("导图包含不支持的字段");
    if (
      key === "hyperLink" &&
      value &&
      !/^(https?:\/\/|mailto:|#)/i.test(value)
    )
      throw Error("导图链接地址无效");
    return value;
  });
  const seen = new Set<string>();
  function check(node: MindData["nodeData"], depth: number) {
    if (
      !node ||
      typeof node.topic !== "string" ||
      typeof node.id !== "string" ||
      !node.id ||
      seen.has(node.id) ||
      depth > 128 ||
      seen.size >= 10000
    )
      throw Error("导图节点无效或超过大小限制");
    seen.add(node.id);
    node.children?.forEach((child) => check(child, depth + 1));
  }
  check(data?.nodeData, 0);
  return data;
}
