import { normalizeMarkdownMode, markdownWritingMode } from "../src/markdown/modes.ts";
import test from "node:test";
import assert from "node:assert/strict";
import { isMindMap, readMindMap } from "../src/plugins/mindFile.ts";
import { patchBlocks } from "../src/markdown/crepeSource.ts";

test("maps use a compound extension and reopen native diagrams", () => {
  assert.equal(isMindMap("目录/图.MIND.JSON"), true);
  assert.equal(isMindMap("dir.mind.json/普通.json"), false);
  const data = {
    nodeData: { id: "abc", topic: "根" },
    direction: 2,
    arrows: [],
  };
  assert.deepEqual(readMindMap(JSON.stringify(data)), data);
  assert.throws(() => readMindMap("{}"));
});

test("a local edit keeps untouched source blocks and their blank lines", () => {
  const source = "##  A\n\n\nfirst\n\n_tail_\n";
  assert.equal(
    patchBlocks(
      source,
      [
        [0, 5],
        [8, 13],
        [15, 21],
      ],
      1,
      2,
      "next",
    ),
    "##  A\n\n\nnext\n\n_tail_\n",
  );
});

test("retired Markdown modes resolve for older preferences and remembered notes", () => {
  for (const [old, current] of [["live", "crepe"], ["edit", "split"], ["map", "read"]]) {
    assert.equal(normalizeMarkdownMode(old), current);
    assert.equal(normalizeMarkdownMode(current), current);
  }
  assert.equal(normalizeMarkdownMode("unknown"), undefined);
  assert.equal(markdownWritingMode("split", "crepe"), "split");
  assert.equal(markdownWritingMode("read", "split"), "split");
  assert.equal(markdownWritingMode(undefined, "read"), "crepe");
});
