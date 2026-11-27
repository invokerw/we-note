import test from "node:test";
import assert from "node:assert/strict";
import { publicSummary } from "../src/assistant/summary.ts";

test("only public Responses summary parts are displayed", () => {
  const read = publicSummary();
  assert.equal(
    read({ type: "response.reasoning_summary_text.delta", delta: "摘要" }),
    "摘要",
  );
  for (const type of [
    "response.reasoning_text.delta",
    "thinking_delta",
    "response.output_text.delta",
  ])
    assert.equal(read({ type, delta: "private" }), undefined);
  assert.equal(
    read({
      type: "response.output_item.done",
      item: {
        type: "reasoning",
        content: [{ type: "reasoning_text", text: "private" }],
        encrypted_content: "signature",
      },
    }),
    undefined,
  );
});

test("final summaries fill missing deltas without duplicating streamed text or leaking reasoning content", () => {
  const read = publicSummary();
  const part = { item_id: "rs_1", summary_index: 0 };
  assert.equal(
    read({
      ...part,
      type: "response.reasoning_summary_text.delta",
      delta: "第",
    }),
    "第",
  );
  assert.equal(
    read({
      ...part,
      type: "response.reasoning_summary_text.done",
      text: "第一段",
    }),
    "第一段",
  );
  assert.equal(
    read({
      ...part,
      type: "response.reasoning_summary_part.done",
      part: { type: "summary_text", text: "第一段" },
    }),
    undefined,
  );
  assert.equal(
    read({
      type: "response.output_item.done",
      item: {
        id: "rs_1",
        type: "reasoning",
        summary: [
          { type: "summary_text", text: "第一段" },
          { type: "summary_text", text: "第二段" },
          { type: "reasoning_text", text: "private" },
        ],
      },
    }),
    "第一段\n\n第二段",
  );
});
