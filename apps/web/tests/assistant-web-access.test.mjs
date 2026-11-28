import test from "node:test";
import assert from "node:assert/strict";
import {
  createWebAccessClient,
  extractWebSources,
  requestEnvelope,
  toAgentToolResult,
  webAccessToolNames,
} from "../src/assistant/webAccess.ts";

test("extract web sources from pi-web-access MCP text", () => {
  assert.deepEqual(
    extractWebSources(
      "1. OpenAI Responses API\n   https://platform.openai.com/docs/api-reference/responses\n\n2. OpenAI Search\n   https://openai.com/index/introducing-chatgpt-search/",
    ),
    [
      {
        title: "OpenAI Responses API",
        url: "https://platform.openai.com/docs/api-reference/responses",
      },
      {
        title: "OpenAI Search",
        url: "https://openai.com/index/introducing-chatgpt-search/",
      },
    ],
  );
});

test("convert MCP tool result to a Pi Agent tool result", () => {
  assert.deepEqual(
    toAgentToolResult({
      content: [{ type: "text", text: "已搜索网络" }],
    }),
    {
      content: [{ type: "text", text: "已搜索网络" }],
      details: null,
    },
  );
  assert.deepEqual(
    toAgentToolResult({
      content: [{ type: "text", text: "搜索失败" }],
      isError: true,
    }),
    {
      content: [{ type: "text", text: "搜索失败" }],
      details: null,
      isError: true,
    },
  );
});

test("expose only the supported pi-web-access tools", () => {
  assert.deepEqual(webAccessToolNames, [
    "web_search",
    "fetch_content",
    "get_search_content",
    "source_check",
  ]);
});

test("disable web access unless the search switch is enabled", () => {
  assert.equal(
    createWebAccessClient({
      api: "openai-responses",
      baseUrl: "https://example.com/v1",
      model: "model",
      webSearch: false,
    }, ""),
    undefined,
  );
});

test("report a missing gateway on browser and mobile transports", () => {
  assert.throws(
    () =>
      createWebAccessClient(
        {
          api: "openai-responses",
          baseUrl: "https://example.com/v1",
          model: "model",
          webSearch: true,
        },
        "",
      ),
    /Web Access MCP 网关地址/,
  );
});

test("encode MCP notifications without a JSON-RPC request id", () => {
  assert.deepEqual(requestEnvelope("notifications/initialized", {}), {
    jsonrpc: "2.0",
    method: "notifications/initialized",
    params: {},
  });
  assert.deepEqual(requestEnvelope("tools/list", {}), {
    jsonrpc: "2.0",
    id: 1,
    method: "tools/list",
    params: {},
  });
});

test("use the MCP HTTP session and optional bearer credential", async () => {
  const originalFetch = globalThis.fetch;
  const requests = [];
  globalThis.fetch = async (_url, init) => {
    const envelope = JSON.parse(init.body);
    requests.push({ envelope, authorization: init.headers.get("Authorization") });
    if (envelope.method === "initialize")
      return new Response(
        JSON.stringify({ jsonrpc: "2.0", id: envelope.id, result: {} }),
        {
          status: 200,
          headers: { "Content-Type": "application/json", "Mcp-Session-Id": "test" },
        },
      );
    if (envelope.method === "notifications/initialized")
      return new Response(null, { status: 202 });
    return new Response(
      JSON.stringify({
        jsonrpc: "2.0",
        id: envelope.id,
        result: { tools: [{ name: "web_search", inputSchema: { type: "object" } }] },
      }),
      { status: 200, headers: { "Content-Type": "application/json" } },
    );
  };
  try {
    const client = createWebAccessClient(
      {
        api: "openai-responses",
        baseUrl: "https://example.com/v1",
        model: "model",
        webSearch: true,
        webAccessUrl: "https://gateway.test/mcp",
      },
      "gateway-token",
    );
    assert.ok(client);
    assert.deepEqual(await client.listTools(), [
      { name: "web_search", inputSchema: { type: "object" } },
    ]);
    assert.deepEqual(requests.map(({ envelope }) => envelope.method), [
      "initialize",
      "notifications/initialized",
      "tools/list",
    ]);
    assert.equal(requests[0].authorization, "Bearer gateway-token");
    assert.equal(requests[1].envelope.id, undefined);
    assert.equal(requests[2].envelope.id, 1);
  } finally {
    globalThis.fetch = originalFetch;
  }
});
