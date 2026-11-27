import test from "node:test";
import assert from "node:assert/strict";
import { changeText, changeMap, nodes } from "../src/mcp/content.ts";

test("targeted changes preserve exact source bytes and reject ambiguous matches", () => {
  const before = "\uFEFF# 周报\r\n周三\r\n";
  assert.equal(
    changeText(before, {
      mode: "replace_text",
      old_text: "周三",
      new_text: "周五",
    }),
    before.replace("三", "五"),
  );
  assert.throws(
    () =>
      changeText("aaa", {
        mode: "replace_text",
        old_text: "aa",
        new_text: "x",
      }),
    /TEXT_AMBIGUOUS/,
  );
});
test("map edits resolve batch references, keep extension data and clean arrows", () => {
  const source = JSON.stringify({
    nodeData: {
      id: "r",
      topic: "根",
      children: [{ id: "a", topic: "A", style: { color: "red" } }],
    },
    arrows: [{ id: "e", from: "r", to: "a" }],
    theme: { name: "test" },
  });
  const result = changeMap(source, [
    { op: "add_node", parent_id: "r", topic: "新", ref: "$new" },
    { op: "move_node", node_id: "a", parent_id: "$new" },
  ]);
  const map = JSON.parse(result.text);
  assert.equal(map.theme.name, "test");
  assert.equal(nodes(result.text)[2].parent_id, result.refs.$new);
  assert.equal(map.nodeData.children[0].children[0].style.color, "red");
  assert.throws(
    () =>
      changeMap(result.text, [
        { op: "delete_node", node_id: result.refs.$new },
      ]),
    /HAS_CHILDREN/,
  );
  assert.equal(
    JSON.parse(
      changeMap(result.text, [
        { op: "delete_node", node_id: result.refs.$new, subtree: true },
      ]).text,
    ).arrows.length,
    0,
  );
});
test("summaries track surviving members across insertions and reject a split", () => {
  const map = JSON.stringify({
    nodeData: {
      id: "r",
      topic: "root",
      children: ["a", "b", "c"].map((id) => ({ id, topic: id })),
    },
    summaries: [{ id: "s", parent: "r", start: 1, end: 2, label: "keep" }],
  });
  const add = { op: "add_node", parent_id: "r", topic: "new" };
  const changed = changeMap(map, [
    { ...add, before_id: "a" },
    { op: "delete_node", node_id: "b" },
    { op: "move_node", node_id: "c", parent_id: "a" },
  ]);
  assert.deepEqual(JSON.parse(changed.text).summaries, [
    { id: "s", parent: "a", start: 0, end: 0, label: "keep" },
  ]);
  assert.throws(
    () => changeMap(map, [{ ...add, before_id: "c" }]),
    /SUMMARY_RANGE_CONFLICT/,
  );
  assert.throws(
    () => changeMap(map, [{ op: "delete_node", node_id: "r", subtree: true }]),
    /ROOT_NODE/,
  );
  assert.throws(
    () => changeMap(map, [{ op: "move_node", node_id: "r", parent_id: "b" }]),
    /INVALID_POSITION/,
  );
});
test("malformed notes and tags produce the documented format error", () => {
  for (const metadata of [{ tags: [null] }, { note: 17 }])
    assert.throws(
      () =>
        nodes(
          JSON.stringify({ nodeData: { id: "r", topic: "x", ...metadata } }),
        ),
      /INVALID_MINDMAP/,
    );
});
