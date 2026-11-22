import { useMemo, useState } from "react";
import {
  applyEdits,
  createScanner,
  format,
  parseTree,
  printParseErrorCode,
  type Node,
  type ParseError,
  SyntaxKind,
} from "jsonc-parser";
import Source from "../markdown/Source";
export function jsonTree(text: string) {
  const errors: ParseError[] = [];
  const root = parseTree(text, errors, {
    allowTrailingComma: false,
    disallowComments: true,
  });
  if (!root || errors.length) {
    const e = errors[0];
    throw Error(
      e
        ? `${printParseErrorCode(e.error)} · 第 ${text.slice(0, e.offset).split("\n").length} 行，第 ${e.offset - text.lastIndexOf("\n", e.offset - 1)} 列`
        : "请输入 JSON 值",
    );
  }
  return root;
}
function locate(root: Node, pointer: string) {
  if (!pointer) return root;
  if (!pointer.startsWith("/") || /~(?![01])/.test(pointer))
    throw Error("JSON Pointer 应以 / 开头，转义使用 ~0 和 ~1");
  let n: Node | undefined = root;
  for (const part of pointer.slice(1).split("/")) {
    const key = part.replace(/~1/g, "/").replace(/~0/g, "~");
    if (n?.type === "object")
      n = n.children?.find((prop) => prop.children?.[0].value === key)
        ?.children?.[1];
    else if (n?.type === "array" && /^(?:0|[1-9]\d*)$/.test(key))
      n = n.children?.[Number(key)];
    else n = undefined;
    if (!n) throw Error("找不到该 JSON Pointer");
  }
  return n;
}
export function JsonEditor({
  text,
  edit,
}: {
  text: string;
  edit: (s: string) => void;
}) {
  const [pointer, point] = useState(""),
    [replacement, setReplacement] = useState(""),
    [issue, report] = useState("");
  const parsed = useMemo(() => {
    try {
      return { root: jsonTree(text) };
    } catch (e) {
      return { error: String(e) };
    }
  }, [text]);
  function run(fn: () => void) {
    try {
      fn();
      report("");
    } catch (e) {
      report(String(e));
    }
  }
  return (
    <>
      <div className="toolbar">
        <button
          disabled={!parsed.root}
          onClick={() =>
            run(() =>
              edit(
                applyEdits(
                  text,
                  format(text, undefined, {
                    tabSize: 2,
                    insertSpaces: true,
                    eol: "\n",
                  }),
                ),
              ),
            )
          }
        >
          格式化
        </button>
        <button
          disabled={!parsed.root}
          onClick={() =>
            run(() => {
              const scanner = createScanner(text, true),
                out: string[] = [];
              while (scanner.scan() !== SyntaxKind.EOF)
                out.push(
                  text.slice(scanner.getTokenOffset(), scanner.getPosition()),
                );
              edit(out.join(""));
            })
          }
        >
          压缩
        </button>
      </div>
      <Source label="JSON 源码" language="json" text={text} onChange={edit} />
      {parsed.error && <p role="alert">{parsed.error}</p>}
      <fieldset disabled={!parsed.root}>
        <legend>按 JSON Pointer 编辑</legend>
        <label>
          JSON Pointer
          <input
            placeholder="/items/0"
            value={pointer}
            onChange={(e) => point(e.target.value)}
          />
        </label>
        <button
          onClick={() =>
            run(() => {
              const n = locate(parsed.root!, pointer);
              setReplacement(text.slice(n.offset, n.offset + n.length));
            })
          }
        >
          定位值
        </button>
        <label>
          节点 JSON 值
          <textarea
            value={replacement}
            onChange={(e) => setReplacement(e.target.value)}
          />
        </label>
        <button
          onClick={() =>
            run(() => {
              jsonTree(replacement);
              const n = locate(parsed.root!, pointer);
              edit(
                text.slice(0, n.offset) +
                  replacement +
                  text.slice(n.offset + n.length),
              );
            })
          }
        >
          替换节点
        </button>
      </fieldset>
      {issue && <p role="alert">{issue}</p>}
    </>
  );
}
