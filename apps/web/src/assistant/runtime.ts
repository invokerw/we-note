import { Agent, type AgentTool } from "@earendil-works/pi-agent-core";
import type { Model } from "@earendil-works/pi-ai";
import { streamSimple as completions } from "@earendil-works/pi-ai/api/openai-completions";
import { streamSimple as responses } from "@earendil-works/pi-ai/api/openai-responses";
import { publicSummary } from "./summary";
import { reasoningPayload } from "./catalog";
import { modelFetch } from "./modelFetch";
import type { Config } from "./policy";
export function createAgent(
  config: Config,
  key: string,
  systemPrompt: string,
  tools: AgentTool[],
  onSummary?: (summary: string) => void,
) {
  const model: Model<Config["api"]> = {
    id: config.model,
    name: config.model,
    api: config.api,
    provider: "wenote",
    baseUrl: config.baseUrl,
    input: ["text"],
    reasoning: false,
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    contextWindow: 64000,
    maxTokens: 8192,
  };
  return new Agent({
    initialState: { model, systemPrompt, tools },
    toolExecution: "sequential",
    identity: { attribution: null },
    streamFn: (_model, context, options) => {
      const collect =
        config.api === "openai-responses" && onSummary
          ? publicSummary()
          : undefined;
      const opts = {
        ...options,
        apiKey: key || "local",
        fetch: modelFetch(config.baseUrl, key),
        maxRetries: 0,
        onPayload: (body: unknown) => {
          const payload = reasoningPayload(body, config.api, config.effort);
          if (
            onSummary &&
            config.api === "openai-responses" &&
            config.effort &&
            config.effort !== "none" &&
            typeof payload === "object" &&
            payload &&
            "reasoning" in payload
          ) {
            return {
              ...payload,
              reasoning: { ...(payload.reasoning as object), summary: "auto" },
            };
          }
          return payload;
        },
        onProviderStreamEvent:
          collect && onSummary
            ? (event: unknown) => {
                const summary = collect(event);
                if (summary !== undefined) onSummary(summary);
              }
            : undefined,
      };
      return model.api === "openai-responses"
        ? responses({ ...model, api: "openai-responses" }, context, opts)
        : completions({ ...model, api: "openai-completions" }, context, opts);
    },
  });
}
export async function testModel(
  config: Config,
  key: string,
  signal: AbortSignal,
) {
  let called = false;
  const agent = createAgent(
    config,
    key,
    "Call check_connection once to test tool support.",
    [
      {
        name: "check_connection",
        label: "连接测试",
        description: "Check that this endpoint can call tools",
        parameters: { type: "object", properties: {} },
        execute: async () => {
          called = true;
          return {
            content: [{ type: "text", text: "ok" }],
            details: null,
            terminate: true,
          };
        },
      },
    ],
  );
  const abort = () => agent.abort();
  signal.throwIfAborted();
  signal.addEventListener("abort", abort, { once: true });
  try {
    await agent.prompt("请调用 check_connection。");
    signal.throwIfAborted();
    if (!called)
      throw Error(
        agent.state.errorMessage ||
          "连接未完成工具调用，请核对端点、模型和工具支持",
      );
  } finally {
    signal.removeEventListener("abort", abort);
  }
}
