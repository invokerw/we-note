import type { AgentTool, AgentToolResult } from "@earendil-works/pi-agent-core";
import type { Config } from "./policy";

const requestTimeoutMs = 60_000;
const maxQueryLength = 4_000;
const maxContentBytes = 1_500_000;
const maxContentCharacters = 120_000;

export const webSearchToolNames = [
  "web_search",
  "get_search_content",
  "fetch_content",
  "source_check",
] as const;

export type WebSearchToolName = (typeof webSearchToolNames)[number];
export type WebSource = {
  title: string;
  url: string;
  snippet?: string;
  publishedAt?: string;
};
export type WebSearchInput = {
  query: string;
  domains?: string[];
  recency?: "day" | "week" | "month" | "year";
  search_context_size?: "low" | "medium" | "high";
};
export type WebSearchResult = {
  searchId: string;
  text: string;
  sources: WebSource[];
};
export type WebContentResult = {
  url: string;
  text: string;
  contentType: string;
  truncated: boolean;
  sources: WebSource[];
};
export type SourceCheckResult = {
  url: string;
  claim: string;
  text: string;
  sources: WebSource[];
};
export type WebSearchErrorCode =
  | "SEARCH_INVALID_ARGUMENT"
  | "SEARCH_NOT_CONFIGURED"
  | "SEARCH_AUTH_FAILED"
  | "SEARCH_PROVIDER_ERROR"
  | "SEARCH_TIMEOUT"
  | "SEARCH_CONTENT_BLOCKED"
  | "SEARCH_RATE_LIMITED";

export class WebSearchError extends Error {
  readonly code: WebSearchErrorCode;

  constructor(
    code: WebSearchErrorCode,
    message: string,
  ) {
    super(message);
    this.code = code;
    this.name = "WebSearchError";
  }
}

type ResponsesResult = {
  text: string;
  sources: WebSource[];
};

type RecordValue = Record<string, unknown>;

export type WebSearchService = {
  search: (
    input: WebSearchInput,
    signal?: AbortSignal,
  ) => Promise<WebSearchResult>;
  getSearchContent: (
    input: { search_id: string },
    signal?: AbortSignal,
  ) => Promise<WebSearchResult>;
  fetchContent: (
    input: { url: string },
    signal?: AbortSignal,
  ) => Promise<WebContentResult>;
  checkSource: (
    input: { url: string; claim: string },
    signal?: AbortSignal,
  ) => Promise<SourceCheckResult>;
};

export type WebSearchLine = {
  role: "tool";
  text: string;
  sources?: WebSource[];
};

function asRecord(value: unknown): RecordValue {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as RecordValue)
    : {};
}

function asText(value: unknown) {
  return typeof value === "string" ? value : "";
}

export function responseEndpoint(baseUrl: string) {
  const url = new URL(baseUrl);
  const path = url.pathname.replace(/\/+$/, "");
  if (!path.endsWith("/responses")) url.pathname = `${path || "/v1"}/responses`;
  return url.toString();
}

function createRequestSignal(signal?: AbortSignal) {
  const timeout = AbortSignal.timeout(requestTimeoutMs);
  return {
    timeout,
    signal: signal ? AbortSignal.any([signal, timeout]) : timeout,
  };
}

function requestError(_error: unknown, timeout: AbortSignal, signal?: AbortSignal) {
  if (timeout.aborted && !signal?.aborted)
    return new WebSearchError("SEARCH_TIMEOUT", "网络搜索请求超时");
  if (signal?.aborted) return signal.reason ?? Error("本轮已停止");
  return new WebSearchError("SEARCH_PROVIDER_ERROR", "网络搜索请求失败");
}

function invalidArgument(message: string) {
  return new WebSearchError("SEARCH_INVALID_ARGUMENT", message);
}

function contentBlocked(message: string) {
  return new WebSearchError("SEARCH_CONTENT_BLOCKED", message);
}

async function requestResponses(
  endpoint: string,
  apiKey: string,
  model: string,
  input: string,
  signal?: AbortSignal,
) {
  const body = {
    model,
    input,
    tools: [{ type: "web_search" }],
  };
  const request = createRequestSignal(signal);
  let response: Response;
  try {
    response = await fetch(endpoint, {
      method: "POST",
      headers: {
        Accept: "application/json",
        "Content-Type": "application/json",
        ...(apiKey ? { Authorization: `Bearer ${apiKey}` } : {}),
      },
      body: JSON.stringify(body),
      signal: request.signal,
    });
  } catch (error) {
    throw requestError(error, request.timeout, signal);
  }
  if (!response.ok) {
    const code: WebSearchErrorCode =
      response.status === 401 || response.status === 403
        ? "SEARCH_AUTH_FAILED"
        : response.status === 429
          ? "SEARCH_RATE_LIMITED"
          : response.status >= 400 && response.status < 500
            ? "SEARCH_INVALID_ARGUMENT"
            : "SEARCH_PROVIDER_ERROR";
    throw new WebSearchError(code, `网络搜索请求失败（HTTP ${response.status}）`);
  }
  try {
    return (await response.json()) as unknown;
  } catch (error) {
    throw new WebSearchError(
      "SEARCH_PROVIDER_ERROR",
      `网络搜索返回无效 JSON：${error instanceof Error ? error.message : String(error)}`,
    );
  }
}

function collectText(value: unknown, output: string[]) {
  if (Array.isArray(value)) {
    for (const item of value) collectText(item, output);
    return;
  }
  const row = asRecord(value);
  if (row.type === "output_text" || row.type === "text") {
    const text = asText(row.text);
    if (text) output.push(text);
  }
  if (Array.isArray(row.content)) collectText(row.content, output);
  if (Array.isArray(row.output)) collectText(row.output, output);
}

function collectAnnotations(value: unknown, sources: WebSource[]) {
  if (Array.isArray(value)) {
    for (const item of value) collectAnnotations(item, sources);
    return;
  }
  const row = asRecord(value);
  const url = asText(row.url);
  if (url.startsWith("http://") || url.startsWith("https://")) {
    const title = asText(row.title) || "网络来源";
    const snippet = asText(row.snippet) || undefined;
    if (!sources.some((source) => source.url === url))
      sources.push({ title, url, ...(snippet ? { snippet } : {}) });
  }
  for (const key of ["annotations", "content", "output", "sources"])
    if (key in row) collectAnnotations(row[key], sources);
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

export function parseResponsesResult(value: unknown): ResponsesResult {
  const row = asRecord(value);
  const textParts: string[] = [];
  const outputText = asText(row.output_text);
  if (outputText) textParts.push(outputText);
  else collectText(row.output, textParts);
  const text = textParts.join("\n").trim();
  const sources: WebSource[] = [];
  collectAnnotations(row.output, sources);
  for (const source of extractWebSources(text))
    if (!sources.some((item) => item.url === source.url)) sources.push(source);
  return { text, sources };
}

function searchInput(input: WebSearchInput) {
  if (!input || typeof input !== "object" || Array.isArray(input))
    throw invalidArgument("搜索参数无效");
  const query = typeof input.query === "string" ? input.query.trim() : "";
  if (!query || query.length > maxQueryLength)
    throw invalidArgument("搜索问题不能为空且不能超过 4000 个字符");
  if (
    input.domains !== undefined &&
    (!Array.isArray(input.domains) ||
      input.domains.length > 20 ||
      input.domains.some(
        (domain) =>
          typeof domain !== "string" || !/^[a-z0-9.-]+$/i.test(domain),
      ))
  )
    throw invalidArgument("搜索域名格式无效");
  if (
    input.recency !== undefined &&
    !["day", "week", "month", "year"].includes(input.recency)
  )
    throw invalidArgument("搜索时间范围无效");
  if (
    input.search_context_size !== undefined &&
    !["low", "medium", "high"].includes(input.search_context_size)
  )
    throw invalidArgument("搜索上下文级别无效");
  const additions = [
    input.domains?.length ? `限定网站：${input.domains.join(", ")}` : "",
    input.recency ? `时间范围：${input.recency}` : "",
    input.search_context_size ? `搜索上下文：${input.search_context_size}` : "",
  ].filter(Boolean);
  return additions.length ? `${query}\n${additions.join("\n")}` : query;
}

function validUrl(value: string) {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw invalidArgument("网页地址无效");
  }
  if (!['http:', 'https:'].includes(url.protocol))
    throw contentBlocked("只允许读取 HTTP 或 HTTPS 网页");
  const hostname = url.hostname.toLowerCase();
  const normalizedHostname = hostname.replace(/^\[|\]$/g, "");
  const privateIpv6 =
    normalizedHostname === "::1" ||
    /^(?:fc|fd)/i.test(normalizedHostname) ||
    /^fe[89ab]/i.test(normalizedHostname) ||
    /^::ffff:(?:127\.|10\.|192\.168\.|172\.(?:1[6-9]|2\d|3[01])\.)/i.test(
      normalizedHostname,
    );
  if (
    hostname === "localhost" ||
    hostname.endsWith(".localhost") ||
    hostname.endsWith(".local") ||
    hostname === "0.0.0.0" ||
    hostname === "::1" ||
    hostname.startsWith("127.") ||
    hostname.startsWith("10.") ||
    hostname.startsWith("192.168.") ||
    /^172\.(1[6-9]|2\d|3[01])\./.test(hostname) ||
    hostname.startsWith("169.254.") ||
    privateIpv6
  )
    throw contentBlocked("出于安全原因无法读取该网页地址");
  return url;
}

async function readLimitedText(response: Response) {
  if (!response.body) {
    const text = await response.text();
    return { text: text.slice(0, maxContentBytes), truncated: text.length > maxContentBytes };
  }
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let bytes = 0;
  let text = "";
  let truncated = false;
  while (true) {
    const part = await reader.read();
    if (part.done) {
      text += decoder.decode();
      break;
    }
    bytes += part.value.byteLength;
    if (bytes > maxContentBytes) {
      const remaining = Math.max(0, maxContentBytes - (bytes - part.value.byteLength));
      text += decoder.decode(part.value.slice(0, remaining), { stream: true });
      truncated = true;
      await reader.cancel();
      break;
    }
    text += decoder.decode(part.value, { stream: true });
  }
  return { text, truncated };
}

function htmlText(html: string) {
  const title = html.match(/<title[^>]*>([\s\S]*?)<\/title>/i)?.[1] ?? "";
  const text = html
    .replace(/<!--[\s\S]*?-->/g, " ")
    .replace(/<head\b[^>]*>[\s\S]*?<\/head>/gi, " ")
    .replace(/<script\b[^>]*>[\s\S]*?<\/script>/gi, " ")
    .replace(/<style\b[^>]*>[\s\S]*?<\/style>/gi, " ")
    .replace(/<nav\b[^>]*>[\s\S]*?<\/nav>/gi, " ")
    .replace(/<[^>]+>/g, " ")
    .replace(/&nbsp;/gi, " ")
    .replace(/&amp;/gi, "&")
    .replace(/&lt;/gi, "<")
    .replace(/&gt;/gi, ">")
    .replace(/\s+/g, " ")
    .trim();
  return { title: title.replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").trim(), text };
}

function toolResult(value: unknown): AgentToolResult<null> {
  return {
    content: [{ type: "text", text: JSON.stringify(value) }],
    details: null,
  };
}

export function createWebSearchService(
  config: Config,
  apiKey: string,
): WebSearchService | undefined {
  if (config.webSearch !== true) return undefined;
  if (config.api !== "openai-responses")
    throw new WebSearchError(
      "SEARCH_NOT_CONFIGURED",
      "网络搜索需要使用 OpenAI Responses 协议",
    );
  const endpoint = responseEndpoint(config.baseUrl);
  const model = config.webSearchModel || config.model;
  const cache = new Map<string, WebSearchResult>();

  return {
    async search(input, signal) {
      const response = await requestResponses(
        endpoint,
        apiKey,
        model,
        searchInput(input),
        signal,
      );
      const parsed = parseResponsesResult(response);
      const result = { searchId: crypto.randomUUID(), ...parsed };
      cache.set(result.searchId, result);
      return result;
    },
    async getSearchContent(input, signal) {
      signal?.throwIfAborted();
      if (!input || typeof input.search_id !== "string" || !input.search_id)
        throw invalidArgument("搜索结果 ID 无效");
      const result = cache.get(input.search_id);
      if (!result)
        throw new WebSearchError(
          "SEARCH_PROVIDER_ERROR",
          "搜索结果已过期，请重新搜索",
        );
      return result;
    },
    async fetchContent(input, signal) {
      if (!input || typeof input.url !== "string" || !input.url)
        throw invalidArgument("网页地址无效");
      const url = validUrl(input.url);
      const request = createRequestSignal(signal);
      let response: Response;
      try {
        response = await fetch(url, {
          headers: { Accept: "text/html, text/plain, application/xhtml+xml" },
          signal: request.signal,
        });
      } catch (error) {
        if (request.timeout.aborted && !signal?.aborted)
          throw requestError(error, request.timeout, signal);
        if (signal?.aborted) throw requestError(error, request.timeout, signal);
        throw contentBlocked("网页读取失败，客户端无法访问该地址");
      }
      if (!response.ok)
        throw contentBlocked(`网页读取失败（HTTP ${response.status}）`);
      const contentType = response.headers.get("content-type") ?? "";
      if (!/(text\/html|text\/plain|application\/xhtml\+xml)/i.test(contentType))
        throw contentBlocked("网页返回的内容类型暂不支持");
      const body = await readLimitedText(response);
      const parsed = /html/i.test(contentType) ? htmlText(body.text) : { title: "", text: body.text.trim() };
      const text = parsed.text.slice(0, maxContentCharacters);
      return {
        url: url.toString(),
        text,
        contentType,
        truncated: body.truncated || parsed.text.length > maxContentCharacters,
        sources: [{ title: parsed.title || url.hostname, url: url.toString() }],
      };
    },
    async checkSource(input, signal) {
      if (!input || typeof input.url !== "string" || !input.url)
        throw invalidArgument("来源地址无效");
      if (typeof input.claim !== "string" || !input.claim.trim())
        throw invalidArgument("需要提供待核验的判断");
      const url = validUrl(input.url).toString();
      let content: WebContentResult | undefined;
      try {
        content = await this.fetchContent({ url }, signal);
      } catch (error) {
        if (
          !(error instanceof WebSearchError) ||
          error.code !== "SEARCH_CONTENT_BLOCKED"
        )
          throw error;
      }
      const result = await this.search(
        { query: `请核验以下判断是否得到来源支持。来源：${url}\n判断：${input.claim}` },
        signal,
      );
      return {
        url,
        claim: input.claim,
        text: [
          result.text,
          content ? `来源正文摘要：${content.text.slice(0, 4_000)}` : "",
        ]
          .filter(Boolean)
          .join("\n\n"),
        sources: [
          ...(content?.sources ?? []),
          ...result.sources.filter(
            (source) =>
              !(content?.sources ?? []).some((item) => item.url === source.url),
          ),
        ],
      };
    },
  };
}

export function createWebSearchTools(
  service: WebSearchService,
  signal: AbortSignal,
  status: (value: string) => void,
  append: (line: WebSearchLine) => void,
): AgentTool[] {
  const run = async (name: WebSearchToolName, args: RecordValue) => {
    signal.throwIfAborted();
    if (name === "web_search") {
      status("正在搜索网络…");
      return service.search(args as WebSearchInput, signal);
    }
    if (name === "get_search_content") {
      status("正在读取搜索结果…");
      return service.getSearchContent(args as { search_id: string }, signal);
    }
    if (name === "fetch_content") {
      status("正在读取网页…");
      return service.fetchContent(args as { url: string }, signal);
    }
    status("正在核验来源…");
    return service.checkSource(args as { url: string; claim: string }, signal);
  };

  return webSearchToolNames.map((name) => ({
    name,
    label: name,
    description:
      name === "web_search"
        ? "搜索互联网并返回摘要与来源"
        : name === "get_search_content"
          ? "读取当前轮次的搜索结果"
          : name === "fetch_content"
            ? "读取指定网页正文"
            : "核验来源是否支持指定判断",
    parameters:
      name === "web_search"
        ? {
            type: "object",
            additionalProperties: false,
            properties: {
              query: { type: "string", minLength: 1, maxLength: maxQueryLength },
              domains: { type: "array", items: { type: "string" }, maxItems: 20 },
              recency: { type: "string", enum: ["day", "week", "month", "year"] },
              search_context_size: { type: "string", enum: ["low", "medium", "high"] },
            },
            required: ["query"],
          }
        : name === "get_search_content"
          ? {
              type: "object",
              additionalProperties: false,
              properties: { search_id: { type: "string", minLength: 1 } },
              required: ["search_id"],
            }
          : name === "fetch_content"
            ? {
                type: "object",
                additionalProperties: false,
                properties: { url: { type: "string", minLength: 1 } },
                required: ["url"],
              }
            : {
                type: "object",
                additionalProperties: false,
                properties: {
                  url: { type: "string", minLength: 1 },
                  claim: { type: "string", minLength: 1, maxLength: maxQueryLength },
                },
                required: ["url", "claim"],
              },
    execute: async (_id, args) => {
      const result = await run(name, asRecord(args));
      const text = "text" in result ? asText(result.text) : JSON.stringify(result);
      append({
        role: "tool",
        text:
          name === "web_search"
            ? "已搜索网络"
            : name === "get_search_content"
              ? "已读取搜索结果"
              : name === "fetch_content"
                ? "已读取网页"
                : "已核验来源",
        sources: result.sources,
      });
      return toolResult({ ...result, text });
    },
  }));
}
