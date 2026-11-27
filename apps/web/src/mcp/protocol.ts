import { parseCall, readOnly, tools, type Call } from "./tools";

export type Grant = {
  id: string;
  hash: string;
  write: boolean;
  name: string;
  port?: number;
  browserTools?: boolean;
  internal?: boolean;
};
export type Dispatch = (call: Call) => Promise<Record<string, unknown>>;
function record(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === "object" && !Array.isArray(value);
}
export async function dispatch(
  message: unknown,
  grant: Grant,
  active: () => boolean,
  run: Dispatch,
) {
  const id =
    record(message) &&
    (typeof message.id === "string" || typeof message.id === "number")
      ? message.id
      : null;
  const error = (code: number, message: string) => ({
    jsonrpc: "2.0",
    id,
    error: { code, message },
  });
  if (!active()) return error(-32001, "连接已撤销");
  if (
    !record(message) ||
    message.jsonrpc !== "2.0" ||
    typeof message.method !== "string"
  )
    return error(-32600, "Invalid Request");
  if (id === null) {
    if (message.id === undefined && message.method.startsWith("notifications/"))
      return null;
    return error(-32600, "Invalid Request");
  }
  const success = (result: unknown) => ({ jsonrpc: "2.0", id, result });
  switch (message.method) {
    case "initialize":
      return success({
        protocolVersion: "2025-11-25",
        capabilities: { tools: {} },
        serverInfo: { name: "wenote", version: "1.0.0" },
      });
    case "ping":
      return success({});
    case "tools/list":
      return success({
        tools: tools.filter((t) => grant.write || readOnly(t.name)),
      });
    case "tools/call": {
      const params = message.params;
      if (
        !record(params) ||
        typeof params.name !== "string" ||
        !tools.some((t) => t.name === params.name)
      )
        return error(-32602, "Unknown tool");
      try {
        const call = parseCall(params.name, params.arguments ?? {});
        if (!grant.write && !readOnly(call.name))
          throw Object.assign(Error("此连接只允许读取"), {
            code: "ACCESS_DENIED",
          });
        const result = await run(call);
        if (!active()) return error(-32001, "连接已撤销");
        return success({
          structuredContent: result,
          content: [{ type: "text", text: JSON.stringify(result) }],
        });
      } catch (err) {
        const detail = {
          code: (err as { code?: string }).code ?? "TOOL_ERROR",
          message: err instanceof Error ? err.message : String(err),
        };
        return success({
          isError: true,
          structuredContent: detail,
          content: [{ type: "text", text: JSON.stringify(detail) }],
        });
      }
    }
    default:
      return error(-32601, "Method not found");
  }
}
