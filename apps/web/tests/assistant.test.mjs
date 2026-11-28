import test from "node:test";
import assert from "node:assert/strict";
import {
  checkedConfig,
  prepareWrite,
  prepareCreateArguments,
  checkReference,
} from "../src/assistant/policy.ts";

import { parseCall } from "../src/mcp/tools.ts";

test("note create arguments keep the selected note kind and validate the resulting tool call", () => {
  const base = { operation_id: "test", path: "note.md", kind: "markdown", text: "", root_topic: "extra" };
  const parse = (args) => parseCall("create_note", prepareCreateArguments(args)).args;
  assert.throws(() => parseCall("create_note", base));
  assert.equal(parse(base).text, "");
  assert.equal(parse({ ...base, kind: "text" }).root_topic, undefined);
  const map = { ...base, path: "map.mind.json", kind: "mindmap", text: null };
  assert.equal(parse(map).root_topic, "extra");
  assert.equal(parse(map).text, undefined);
  assert.throws(() => parse({ ...map, text: "retain substantive text" }));
  assert.throws(() => parse({ ...base, text: null }));
  assert.throws(() => parse({ ...base, unexpected: true }));
});

test("custom model address is bound to its protocol and excludes credentials in URL", () => {
  const config = {
    api: "openai-responses",
    baseUrl: "https://example.test/v1/",
    model: " local ",
  };
  assert.equal(checkedConfig(config).baseUrl, "https://example.test/v1");
  assert.throws(() =>
    checkedConfig({ ...config, baseUrl: "https://u:p@example.test/v1" }),
  );
  assert.throws(() => checkedConfig({ ...config, api: "unknown" }));
  assert.throws(
    () => checkedConfig({ ...config, api: "openai-completions", webSearch: true }),
    /网络搜索需要使用 OpenAI Responses 协议/,
  );
  assert.deepEqual(
    checkedConfig({
      ...config,
      webSearch: true,
      webSearchModel: " search-model ",
    }),
    {
      ...config,
      baseUrl: "https://example.test/v1",
      model: "local",
      webSearch: true,
      webSearchModel: "search-model",
    },
  );
  assert.deepEqual(
    checkedConfig({ ...config, webSearch: false }),
    {
      ...config,
      baseUrl: "https://example.test/v1",
      model: "local",
      webSearch: false,
    },
  );
});
test("a write preview freezes host-generated operation and read version", () => {
  const call = {
    name: "edit_note",
    args: {
      file_id: "id",
      base_path: "a.md",
      base_version_id: "v",
      operation_id: "model",
      edit: { mode: "replace_text", old_text: "周三", new_text: "周五" },
    },
  };
  const note = {
    file_id: "id",
    path: "a.md",
    version_id: "v",
    text: "联调周三。",
  };
  const preview = prepareWrite(call, note);
  assert.notEqual(preview.call.args.operation_id, "model");
  assert.match(preview.summary, /周五/);
  assert.equal(note.text, "联调周三。");
  assert.throws(() => prepareWrite(call, { ...note, version_id: "new" }));
});
test("references constrain searches and all file-bound tools", () => {
  assert.throws(() => checkReference("search_notes", {}, false, new Set()));
  assert.throws(() =>
    checkReference(
      "edit_note",
      { file_id: "elsewhere" },
      false,
      new Set(["mine"]),
    ),
  );
  checkReference("read_note", { file_id: "mine" }, false, new Set(["mine"]));
});
