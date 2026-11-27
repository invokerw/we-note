import test from "node:test";
import assert from "node:assert/strict";
import {
  baseModels,
  withEfforts,
  reasoningPayload,
} from "../src/assistant/catalog.ts";

test("merge capabilities by exact slug, retaining base-only IDs and gateway-specific efforts", () => {
  const base = baseModels({
    data: [
      { id: "a", display_name: "Alpha" },
      { id: "b" },
      { id: "a" },
      { id: "  " },
    ],
  });
  const options = withEfforts(base, {
    models: [
      {
        slug: "a",
        default_reasoning_level: "low",
        supported_reasoning_levels: [
          { effort: "low" },
          { effort: "ultra" },
          { effort: "ultra" },
        ],
      },
      { slug: "other" },
    ],
  });
  assert.deepEqual(options, [
    { id: "a", label: "Alpha", levels: ["low", "ultra"], defaultLevel: "low" },
    { id: "b", label: "b", levels: [] },
  ]);
  assert.deepEqual(withEfforts(base, { data: [] }), base);
});
test("send explicit gateway effort unchanged and omit default on both protocols", () => {
  assert.deepEqual(
    reasoningPayload(
      { reasoning: { summary: "auto" } },
      "openai-responses",
      "ultra",
    ),
    { reasoning: { summary: "auto", effort: "ultra" } },
  );
  assert.deepEqual(reasoningPayload({}, "openai-completions", "max"), {
    reasoning_effort: "max",
  });
  assert.deepEqual(reasoningPayload({}, "openai-responses", ""), {});
});
