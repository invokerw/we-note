import { defaultEditorId, handler, invoke } from "../plugins/registry";
import { decodeText } from "../plugins/archive";
import { fail } from "./content";

export type Kind = "markdown" | "text" | "mindmap";
export function format(path: string): { kind: Kind; key: string } | undefined {
  const plugin = handler(path),
    name = path.toLowerCase(),
    id = plugin.manifest.id;
  if (plugin.wasm && plugin.manifest.mcp_model)
    return { kind: plugin.manifest.mcp_model, key: id + ":" + plugin.hash };
  if (id === "com.wenote.md" && name.endsWith(".md"))
    return { kind: "markdown", key: id };
  if (id === "com.wenote.mind.json" && name.endsWith(".mind.json"))
    return { kind: "mindmap", key: id };
  if (id === defaultEditorId && name.endsWith(".txt"))
    return { kind: "text", key: id };
}
export async function convert(
  path: string,
  operation: "open" | "serialize",
  value: string,
) {
  const plugin = handler(path);
  if (!plugin.wasm) return value;
  if (!plugin.manifest.mcp_model)
    fail("UNSUPPORTED_FORMAT", "插件未声明 MCP 格式");
  try {
    return decodeText(
      await invoke(plugin, operation, new TextEncoder().encode(value)),
    );
  } catch {
    return fail("INVALID_FORMAT", "插件无法无损读取或保存此文件");
  }
}
