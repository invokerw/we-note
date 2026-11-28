import test from "node:test";
import assert from "node:assert/strict";
import {
  createWebSearchService,
  createWebSearchTools,
  extractWebSources,
  parseResponsesResult,
  responseEndpoint,
  WebSearchError,
  webSearchToolNames,
} from "../src/assistant/webSearch.ts";

const config = {
  api: "openai-responses",
  baseUrl: "https://example.com/v1",
  model: "chat-model",
  webSearch: true,
  webSearchModel: "search-model",
};

test("build the Responses endpoint from the configured base URL", () => {
  assert.equal(responseEndpoint("https://example.com/v1"), "https://example.com/v1/responses");
  assert.equal(responseEndpoint("https://example.com/v1/responses"), "https://example.com/v1/responses");
});

test("parse Responses text and URL citation annotations", () => {
  assert.deepEqual(
    parseResponsesResult({
      output: [
        {
          type: "message",
          content: [
            {
              type: "output_text",
              text: "OpenAI 提供 Responses API。",
              annotations: [
                {
                  type: "url_citation",
                  title: "Responses API",
                  url: "https://platform.openai.com/docs/overview",
                },
              ],
            },
          ],
        },
      ],
    }),
    {
      text: "OpenAI 提供 Responses API。",
      sources: [
        {
          title: "Responses API",
          url: "https://platform.openai.com/docs/overview",
        },
      ],
    },
  );
});

test("extract fallback web sources from response text", () => {
  assert.deepEqual(
    extractWebSources(
      "OpenAI 文档\nhttps://platform.openai.com/docs/overview\n\n搜索首页\nhttps://openai.com/",
    ),
    [
      {
        title: "OpenAI 文档",
        url: "https://platform.openai.com/docs/overview",
      },
      {
        title: "搜索首页",
        url: "https://openai.com/",
      },
    ],
  );
});

test("disable internal web tools unless the search switch is enabled", () => {
  assert.equal(
    createWebSearchService({ ...config, webSearch: false }, "secret"),
    undefined,
  );
  assert.deepEqual(webSearchToolNames, [
    "web_search",
    "get_search_content",
    "fetch_content",
    "source_check",
  ]);
});

test("call OpenAI Responses web_search with the current model credential", async () => {
  const originalFetch = globalThis.fetch;
  const requests = [];
  globalThis.fetch = async (url, init) => {
    requests.push({ url, init });
    return new Response(
      JSON.stringify({
        output_text: "搜索结果摘要",
        output: [
          {
            type: "message",
            content: [
              {
                type: "output_text",
                text: "搜索结果摘要",
                annotations: [
                  {
                    type: "url_citation",
                    title: "来源",
                    url: "https://example.com/source",
                  },
                ],
              },
            ],
          },
        ],
      }),
      { status: 200, headers: { "Content-Type": "application/json" } },
    );
  };
  try {
    const service = createWebSearchService(config, "secret");
    const result = await service.search({ query: "测试搜索" });
    assert.equal(requests[0].url, "https://example.com/v1/responses");
    assert.equal(requests[0].init.headers.Authorization, "Bearer secret");
    assert.deepEqual(JSON.parse(requests[0].init.body), {
      model: "search-model",
      input: "测试搜索",
      tools: [{ type: "web_search" }],
    });
    assert.equal(result.text, "搜索结果摘要");
    assert.deepEqual(result.sources, [
      { title: "来源", url: "https://example.com/source" },
    ]);
    assert.match(result.searchId, /^[0-9a-f-]{36}$/);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("cache search content and expose internal AgentTools", async () => {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async () =>
    new Response(JSON.stringify({ output_text: "缓存结果", output: [] }), {
      status: 200,
      headers: { "Content-Type": "application/json" },
    });
  try {
    const service = createWebSearchService(config, "secret");
    const statuses = [];
    const lines = [];
    const tools = createWebSearchTools(
      service,
      new AbortController().signal,
      (value) => statuses.push(value),
      (line) => lines.push(line),
    );
    assert.deepEqual(tools.map((tool) => tool.name), [
      "web_search",
      "get_search_content",
      "fetch_content",
      "source_check",
    ]);
    const search = await tools[0].execute("call-1", { query: "缓存测试" });
    const payload = JSON.parse(search.content[0].text);
    assert.equal(payload.text, "缓存结果");
    const cached = await tools[1].execute("call-2", {
      search_id: payload.searchId,
    });
    assert.equal(JSON.parse(cached.content[0].text).text, "缓存结果");
    assert.deepEqual(statuses.slice(0, 2), ["正在搜索网络…", "正在读取搜索结果…"]);
    assert.deepEqual(lines[0].sources, []);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("read text web content and block private addresses", async () => {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async () =>
    new Response(
      "<html><head><title>标题</title></head><body><script>ignore()</script><main>正文内容</main></body></html>",
      {
        status: 200,
        headers: { "Content-Type": "text/html; charset=utf-8" },
      },
    );
  try {
    const service = createWebSearchService(config, "secret");
    const content = await service.fetchContent({ url: "https://example.com/article" });
    assert.equal(content.text, "正文内容");
    assert.equal(content.sources[0].title, "标题");
    await assert.rejects(
      service.fetchContent({ url: "http://127.0.0.1/private" }),
      /安全原因/,
    );
    await assert.rejects(
      service.fetchContent({ url: "http://[::1]/private" }),
      /安全原因/,
    );
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("return stable provider error codes without exposing response bodies", async () => {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async () =>
    new Response(JSON.stringify({ error: { message: "secret provider detail" } }), {
      status: 401,
      headers: { "Content-Type": "application/json" },
    });
  try {
    const service = createWebSearchService(config, "secret");
    await assert.rejects(
      service.search({ query: "权限测试" }),
      (error) =>
        error instanceof WebSearchError &&
        error.code === "SEARCH_AUTH_FAILED" &&
        error.message === "网络搜索请求失败（HTTP 401）" &&
        !error.message.includes("secret provider detail"),
    );
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("validate search arguments at the service boundary", async () => {
  const service = createWebSearchService(config, "secret");
  await assert.rejects(
    service.search({ query: "", domains: ["bad domain"] }),
    (error) =>
      error instanceof WebSearchError && error.code === "SEARCH_INVALID_ARGUMENT",
  );
});

test("fall back to provider sources when direct source reading is blocked", async () => {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async (url) => {
    if (String(url).endsWith("/responses"))
      return new Response(
        JSON.stringify({
          output_text: "交叉核验摘要",
          output: [
            {
              type: "message",
              content: [
                {
                  type: "output_text",
                  text: "交叉核验摘要",
                  annotations: [
                    {
                      type: "url_citation",
                      title: "搜索来源",
                      url: "https://example.com/search-source",
                    },
                  ],
                },
              ],
            },
          ],
        }),
        { status: 200, headers: { "Content-Type": "application/json" } },
      );
    throw new TypeError("CORS blocked");
  };
  try {
    const service = createWebSearchService(config, "secret");
    const result = await service.checkSource({
      url: "https://example.com/source",
      claim: "需要核验的判断",
    });
    assert.equal(result.text, "交叉核验摘要");
    assert.deepEqual(result.sources, [
      { title: "搜索来源", url: "https://example.com/search-source" },
    ]);
  } finally {
    globalThis.fetch = originalFetch;
  }
});
