import type { AgentTool, AgentToolResult } from "@earendil-works/pi-agent-core";
import type { Config } from "./policy";

const webAccessTimeoutMs = 60_000;

export const webAccessToolNames = [
  "web_search",
  "fetch_content",
  "get_search_content",
  "source_check",
] as const;

export type WebAccessToolName = (typeof webAccessToolNames)[number];
export type WebSource = { title: string; url: string };
export type McpTextContent = { type: "text"; text: string };
type AgentContent =
  | { type: "text"; text: string }
  | { type: "image"; data: string; mimeType: string };
export type McpCallResult = {
  content?: Array<{ type: string; text?: string; [key: string]: unknown }>;
  isError?: boolean;
};
export type McpReply = {
  jsonrpc?: "2.0";
  id?: number;
  result?: unknown;
  error?: { code?: number; message?: string; data?: unknown };
};
export type WebAccessRequest = (
  method:
    | "initialize"
    | "notifications/initialized"
    | "tools/list"
    | "tools/call",
  params?: Record<string, unknown>,
  signal?: AbortSignal,
) => Promise<McpReply>;
export type WebAccessTool = {
  name: string;
  description?: string;
  inputSchema?: unknown;
};
export type WebAccessClient = {
  listTools: (signal?: AbortSignal) => Promise<WebAccessTool[]>;
  call: (
    name: string,
    args: Record<string, unknown>,
    signal?: AbortSignal,
  ) => Promise<McpCallResult>;
};

type TauriCore = {
  invoke: <T>(name: string, args: Record<string, unknown>) => Promise<T>;
};

type TauriWindow = Window & { __TAURI__?: { core?: TauriCore } };

function tauriCore() {
  return (globalThis as unknown as TauriWindow).__TAURI__?.core;
}

function asRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

function replyResult(reply: McpReply) {
  if (reply.error) throw Error(reply.error.message ?? "Web Access MCP 请求失败");
  return reply.result;
}

function resultCall(reply: McpReply): McpCallResult {
  const result = replyResult(reply);
  return asRecord(result) as McpCallResult;
}

function responseEndpoint(baseUrl: string) {
  const url = new URL(baseUrl);
  const path = url.pathname.replace(/\/+$/, "");
  if (!path.endsWith("/responses")) url.pathname = `${path || "/v1"}/responses`;
  return url.toString();
}

export function requestEnvelope(
  method:
    | "initialize"
    | "notifications/initialized"
    | "tools/list"
    | "tools/call",
  params?: Record<string, unknown>,
) {
  return {
    jsonrpc: "2.0" as const,
    ...(method === "notifications/initialized" ? {} : { id: 1 }),
    method,
    ...(params ? { params } : {}),
  };
}

function parseSse(text: string): McpReply | undefined {
  for (const line of text.split(/\r?\n/)) {
    if (!line.startsWith("data:")) continue;
    const value = line.slice(5).trim();
    if (!value || value === "[DONE]") continue;
    try {
      return JSON.parse(value) as McpReply;
    } catch {
      continue;
    }
  }
  return undefined;
}

async function httpRequest(
  endpoint: string,
  envelope: Record<string, unknown>,
  session: { id?: string },
  signal?: AbortSignal,
  bearer?: string,
) {
  const headers = new Headers({
    "Content-Type": "application/json",
    Accept: "application/json, text/event-stream",
    "MCP-Protocol-Version": "2025-06-18",
  });
  if (session.id) headers.set("Mcp-Session-Id", session.id);
  if (bearer) headers.set("Authorization", `Bearer ${bearer}`);
  const timeout = AbortSignal.timeout(webAccessTimeoutMs);
  const requestSignal = signal
    ? AbortSignal.any([signal, timeout])
    : timeout;
  let response: Response;
  try {
    response = await fetch(endpoint, {
      method: "POST",
      headers,
      body: JSON.stringify(envelope),
      signal: requestSignal,
    });
  } catch (error) {
    if (timeout.aborted && !signal?.aborted)
      throw Error("Web Access MCP 请求超时");
    throw error;
  }
  if (!response.ok)
    throw Error(`Web Access MCP 返回 HTTP ${response.status}`);
  const sessionId = response.headers.get("Mcp-Session-Id");
  if (sessionId) session.id = sessionId;
  const text = await response.text();
  if (!text.trim()) {
    if (envelope.method === "notifications/initialized")
      return { jsonrpc: "2.0" as const };
    throw Error("Web Access MCP 返回空响应");
  }
  const value = response.headers.get("content-type")?.includes("text/event-stream")
    ? parseSse(text)
    : (JSON.parse(text) as McpReply);
  if (!value) throw Error("无法解析 Web Access MCP 响应");
  return value;
}

function localClient(config: Config, key: string): WebAccessClient | undefined {
  const core = tauriCore();
  if (!core) return undefined;
  const responsesUrl = responseEndpoint(config.baseUrl);
  const request: WebAccessRequest = (method, params, signal) => {
    if (method === "notifications/initialized")
      return Promise.resolve({ jsonrpc: "2.0" as const });
    if (signal?.aborted)
      return Promise.reject(signal.reason ?? Error("本轮已停止"));
    const requestId = crypto.randomUUID();
    const promise = core.invoke<McpReply>("web_access_request", {
      requestId,
      responsesUrl,
      model: config.webSearchModel || config.model,
      apiKey: key,
      method,
      params,
    });
    if (!signal) return promise;
    const cancel = () => {
      void core
        .invoke("web_access_cancel", { requestId })
        .catch(() => {});
    };
    signal.addEventListener("abort", cancel, { once: true });
    return promise.finally(() => signal.removeEventListener("abort", cancel));
  };
  return clientFromRequest(request);
}

function httpClient(url: string, bearer: string): WebAccessClient {
  const session: { id?: string } = {};
  const request: WebAccessRequest = (method, params, signal) =>
    httpRequest(url, requestEnvelope(method, params), session, signal, bearer);
  return clientFromRequest(request);
}

function clientFromRequest(request: WebAccessRequest): WebAccessClient {
  let initialized = false;
  return {
    async listTools(signal) {
      if (!initialized) {
        const reply = await request(
          "initialize",
          {
            protocolVersion: "2025-06-18",
            capabilities: {},
            clientInfo: { name: "wenote", version: "0.1.0" },
          },
          signal,
        );
        replyResult(reply);
        initialized = true;
        await request("notifications/initialized", {}, signal).catch(() => {});
      }
      const result = asRecord(replyResult(await request("tools/list", {}, signal)));
      return Array.isArray(result.tools)
        ? result.tools.filter((tool): tool is WebAccessTool => {
            const row = asRecord(tool);
            return typeof row.name === "string";
          })
        : [];
    },
    async call(name, args, signal) {
      if (!initialized) await this.listTools(signal);
      return resultCall(
        await request("tools/call", { name, arguments: args }, signal),
      );
    },
  };
}

export function createWebAccessClient(
  config: Config,
  key: string,
  allowLocal = false,
) {
  if (config.webSearch !== true) return undefined;
  if (config.webAccessUrl?.trim())
    return httpClient(config.webAccessUrl.trim(), key);
  if (allowLocal) {
    const client = localClient(config, key);
    if (client) return client;
  }
  throw Error("当前端需要配置 Web Access MCP 网关地址");
}

export function extractWebSources(text: string): WebSource[] {
  const sources: WebSource[] = [];
  const seen = new Set<string>();
  const lines = text.split(/\r?\n/);
  for (let index = 0; index < lines.length; index++) {
    const line = lines[index];
    const match = line.match(/https?:\/\/[^\s<>"')\]]+/);
    if (!match) continue;
    const url = match[0].replace(/[.,;!?]+$/g, "");
    if (seen.has(url)) continue;
    seen.add(url);
    let title = "网络来源";
    for (let previous = index - 1; previous >= 0; previous--) {
      const candidate = lines[previous].trim();
      if (!candidate) continue;
      title = candidate.replace(/^\s*(?:[-*]\s+|\d+[.)]\s*)/, "");
      break;
    }
    sources.push({ title: title || url, url });
  }
  return sources;
}

export function mcpText(result: McpCallResult) {
  return (result.content ?? [])
    .filter((block): block is McpTextContent =>
      block.type === "text" && typeof block.text === "string",
    )
    .map((block) => block.text)
    .join("\n");
}

export function toAgentToolResult(
  result: McpCallResult,
): AgentToolResult<null> {
  const content: AgentContent[] = [];
  for (const block of result.content ?? []) {
    if (block.type === "text" && typeof block.text === "string")
      content.push({ type: "text", text: block.text });
    else if (
      block.type === "image" &&
      typeof block.data === "string" &&
      typeof block.mimeType === "string"
    )
      content.push({
        type: "image",
        data: block.data,
        mimeType: block.mimeType,
      });
  }
  return {
    content,
    details: null,
    ...(result.isError ? { isError: true } : {}),
  };
}

export function webAccessTools(
  tools: WebAccessTool[],
  client: WebAccessClient,
  signal: AbortSignal,
  status: (value: string) => void,
  append: (line: { role: "tool"; text: string; sources?: WebSource[] }) => void,
): AgentTool[] {
  const supported = new Set<string>(webAccessToolNames);
  return tools
    .filter((tool) => supported.has(tool.name))
    .map((tool) => ({
      name: tool.name,
      label: tool.description ?? tool.name,
      description: tool.description ?? tool.name,
      parameters: tool.inputSchema ?? { type: "object", properties: {} },
      execute: async (_id, args) => {
        signal.throwIfAborted();
        status(
          tool.name === "web_search"
            ? "正在搜索网络…"
            : tool.name === "fetch_content"
              ? "正在读取网页…"
              : tool.name === "source_check"
                ? "正在核验来源…"
                : "正在读取搜索结果…",
        );
        const result = await client.call(tool.name, asRecord(args), signal);
        const text = mcpText(result);
        append({
          role: "tool",
          text:
            tool.name === "web_search"
              ? "已搜索网络"
              : tool.name === "fetch_content"
                ? "已读取网页"
                : tool.name === "source_check"
                  ? "已核验来源"
                  : "已读取搜索结果",
          sources: extractWebSources(text),
        });
        return toAgentToolResult(result);
      },
    }));
}
