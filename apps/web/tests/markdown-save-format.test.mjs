import test from "node:test";
import assert from "node:assert/strict";
import { formatMarkdown } from "../src/markdown/saveFormat.ts";

const options = {
  cjkLatinSpacing: true,
  cjkDigitSpacing: true,
  latinDigitSpacing: true,
  trimTrailingWhitespace: true,
  normalizeBlankLines: true,
};

test("formats configured script boundaries and ordinary trailing whitespace", () => {
  const source = "你好world 共100个 Python3   \n下一行\n";
  assert.equal(
    formatMarkdown(source, options).text,
    "你好 world 共 100 个 Python 3  \n下一行\n",
  );
});

test("honors disabled formatting rules", () => {
  const source = "你好world 共100个 Python3   \n";
  assert.equal(
    formatMarkdown(source, {
      cjkLatinSpacing: false,
      cjkDigitSpacing: false,
      latinDigitSpacing: false,
      trimTrailingWhitespace: false,
      normalizeBlankLines: false,
    }).text,
    source,
  );
});

test("trims trailing whitespace after front matter", () => {
  const source = [
    "---",
    "title: 你好world",
    "---",
    "你好world   ",
    "",
  ].join("\n");
  assert.equal(
    formatMarkdown(source, options).text,
    [
      "---",
      "title: 你好world",
      "---",
      "你好 world  ",
      "",
    ].join("\n"),
  );
});

test("protects front matter, inline code, code blocks, math, and links", () => {
  const source = [
    "---",
    "title: 你好world",
    "count: 100",
    "---",
    "",
    "普通文本你好world 共100个",
    "",
    "`你好world` $你好world100$ [你好world](https://example.com/你好world100)",
    "",
    "```js",
    "const value = 你好world100",
    "```",
    "",
  ].join("\n");
  const result = formatMarkdown(source, options).text;
  assert.match(result, /title: 你好world/);
  assert.match(result, /普通文本你好 world 共 100 个/);
  assert.match(result, /`你好world` \$你好world100\$ \[你好world\]\(https:\/\/example\.com\/你好world100\)/);
  assert.match(result, /const value = 你好world100/);
});

test("collapses ordinary blank lines, preserves code block blank lines, and is idempotent", () => {
  const source = [
    "",
    "",
    "你好world",
    "",
    "",
    "",
    "```text",
    "第一行",
    "",
    "",
    "第二行",
    "```",
    "",
    "",
  ].join("\n");
  const once = formatMarkdown(source, options).text;
  assert.equal(
    once,
    [
      "你好 world",
      "",
      "```text",
      "第一行",
      "",
      "",
      "第二行",
      "```",
      "",
    ].join("\n"),
  );
  assert.equal(formatMarkdown(once, options).text, once);
});
