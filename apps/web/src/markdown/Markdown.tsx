import { createPortal } from "react-dom";
import { boardText, boardStrokes, Whiteboard } from "./Whiteboard";
import { useEffect, useMemo, useState, useRef } from "react";
import SplitEditor from "./SplitEditor";
import { inspect, type Branch } from "./document";
import HeadingEditor from "./HeadingEditor";
import Source from "./Source";
import { syntaxTree } from "@codemirror/language";
import type { EditorView } from "@codemirror/view";
import { MarkdownView, type MarkdownIO, sourceOffset } from "./MarkdownView";
export { MarkdownView, type MarkdownIO } from "./MarkdownView";

function Branches({
  items,
  jump,
}: {
  items: Branch[];
  jump: (n: Branch) => void;
}) {
  return (
    <ul>
      {items.map((n) => (
        <li key={n.offset}>
          {n.children.length ? (
            <details open>
              <summary>
                <button
                  onClick={(e) => {
                    e.preventDefault();
                    jump(n);
                  }}
                >
                  {n.title}
                </button>
              </summary>
              <Branches items={n.children} jump={jump} />
            </details>
          ) : (
            <button onClick={() => jump(n)}>{n.title}</button>
          )}
        </li>
      ))}
    </ul>
  );
}
export type Mode = "read" | "split" | "edit" | "live" | "map";
const formats = [
  ["B", "加粗", "**", "**", "粗体"],
  ["I", "斜体", "*", "*", "斜体"],
  ["S", "删除线", "~~", "~~", "文字"],
  ["H", "标题", "## ", "", "标题"],
  ["❝", "引用", "> ", "", "引用"],
  ["☷", "无序列表", "- ", "", "列表项"],
  ["☑", "任务列表", "- [ ] ", "", "待办事项"],
  ["↗", "链接", "[", "](https://)", "链接文字"],
  ["‹/›", "行内代码", "`", "`", "代码"],
] as const;
export function Document({
  text,
  edit,
  mode,
  setMode,
  io,
  select,
  markdown = true,
  focusSource = false,
  metadataHost,
  attach,
}: {
  text: string;
  edit: (s: string) => void;
  mode: Mode;
  setMode: (m: Mode) => void;
  io: MarkdownIO;
  select: (a: number, b: number) => void;
  markdown?: boolean;
  focusSource?: boolean;
  metadataHost?: HTMLElement | null;
  attach?: () => void;
}) {
  const info = useMemo(() => inspect(markdown ? text : ""), [text, markdown]);
  const [block, setBlock] = useState<{
    start: number;
    tail: number;
    caret: number;
    original: string;
  } | null>(null);
  const root = useRef<HTMLDivElement>(null);
  const jumpOffset = useRef<number | null>(null);
  useEffect(() => {
    if (mode !== "live") setBlock(null);
    if (mode === "read" && jumpOffset.current !== null) {
      root.current
        ?.querySelector(`[data-block-start="${jumpOffset.current}"]`)
        ?.scrollIntoView({ block: "center" });
      jumpOffset.current = null;
    }
  }, [mode]);
  function jump(n: Branch) {
    if (mode === "read")
      root.current
        ?.querySelector(`[data-block-start="${n.offset}"]`)
        ?.scrollIntoView({ block: "center" });
    else {
      jumpOffset.current = n.offset;
      setMode("read");
    }
  }
  function activate(start: number, end: number, caret = 0) {
    const pos = Math.min(Math.max(caret, 0), end - start);
    select(start + pos, start + pos);
    setBlock({
      start,
      tail: text.length - end,
      caret: pos,
      original: text.slice(start, end),
    });
  }
  const toggle = (offset: number) => {
    const body = text.slice(offset);
    const m = body.match(/^(?:[-+*]|\d+[.)])\s+\[([ xX])\]/);
    if (m) {
      const at = offset + m[0].length - 2;
      edit(text.slice(0, at) + (m[1] === " " ? "x" : " ") + text.slice(at + 1));
    }
  };
  const editor = useRef<EditorView | null>(null);
  function format(before: string, after: string, sample: string) {
    const cm = editor.current;
    if (!cm) {
      const start = text.length + (text ? 2 : 0);
      edit(text + (text ? "\n\n" : "") + before + sample + after);
      setBlock({
        start,
        tail: 0,
        original: "",
        caret: before.length + sample.length,
      });
      return;
    }
    const range = cm.state.selection.main;
    const inlineNode = {
      "**": "StrongEmphasis",
      "*": "Emphasis",
      "~~": "Strikethrough",
      "`": "InlineCode",
    }[before];
    if (inlineNode) {
      let node = syntaxTree(cm.state).resolveInner(range.from, 1);
      while (node.parent && node.name !== inlineNode) node = node.parent;
      const first = node.firstChild,
        last = node.lastChild;
      if (
        node.name === inlineNode &&
        first &&
        last &&
        first !== last &&
        (range.empty || (range.from === first.to && range.to === last.from))
      ) {
        cm.dispatch({
          changes: [
            { from: first.from, to: first.to },
            { from: last.from, to: last.to },
          ],
          userEvent: "input.format",
        });
        cm.focus();
        return;
      }
    }
    const value = cm.state.sliceDoc(range.from, range.to) || sample;
    const prefix =
      ["## ", "> ", "- ", "- [ ] "].includes(before) &&
      range.from > cm.state.doc.lineAt(range.from).from
        ? "\n" + before
        : before;
    const anchor = range.from + prefix.length;
    cm.dispatch({
      changes: {
        from: range.from,
        to: range.to,
        insert: prefix + value + after,
      },
      selection: { anchor, head: anchor + value.length },
    });
    cm.focus();
  }
  const bounds =
    mode === "live"
      ? (block ?? (text ? null : { start: 0, tail: 0, caret: 0, original: "" }))
      : null;
  const sourcePane = (
    <Source
      editor={editor}
      focus={focusSource}
      label="笔记源码"
      text={text}
      onChange={edit}
      onSelect={select}
    />
  );
  function finishBlock() {
    setBlock(null);
    requestAnimationFrame(() =>
      root.current
        ?.querySelector<HTMLElement>(`[data-block-start="${bounds?.start}"]`)
        ?.focus({ preventScroll: true }),
    );
  }
  function liveKey(event: KeyboardEvent, cm: EditorView) {
    if (!bounds) return false;
    if (
      event.key === "Escape" ||
      (event.key === "Enter" && (event.ctrlKey || event.metaKey))
    ) {
      finishBlock();
      return true;
    }
    const range = cm.state.selection.main,
      length = cm.state.doc.length;
    if (
      !range.empty ||
      event.shiftKey ||
      event.altKey ||
      event.metaKey ||
      event.ctrlKey
    )
      return false;
    const end = text.length - bounds.tail;
    const type = syntaxTree(cm.state).topNode.lastChild?.name ?? "";
    if (
      event.key === "Enter" &&
      range.head === length &&
      /^(Paragraph|ATXHeading[1-6]|SetextHeading[12])$/.test(type)
    ) {
      cm.dispatch(cm.state.replaceSelection("\n\n"), {
        scrollIntoView: true,
        userEvent: "input",
      });
      return true;
    }
    const up = event.key === "ArrowUp" && range.head === 0;
    const down = event.key === "ArrowDown" && range.head === length;
    if (up || down) {
      const active = cm.dom.closest(".live-block");
      const next = (
        up ? active?.previousElementSibling : active?.nextElementSibling
      ) as HTMLElement | null;
      if (next?.hasAttribute("data-block-start")) {
        const slot = { start: bounds.start, end, original: bounds.original };
        const a = sourceOffset(Number(next.dataset.blockStart), slot),
          b = sourceOffset(Number(next.dataset.blockEnd), slot);
        activate(a, b, up ? b - a : 0);
        return true;
      }
    }
    return false;
  }
  const strokes = markdown ? boardStrokes(text) : null;
  if (strokes && (mode === "live" || mode === "read"))
    return (
      <Whiteboard
        strokes={strokes}
        change={mode === "live" ? (lines) => edit(boardText(lines)) : undefined}
        activate={() => setMode("live")}
      />
    );
  const metadata = markdown && mode !== "map" && (
    <>
      {!!info.outline.length && <Branches items={info.outline} jump={jump} />}
      <dl>
        {Object.entries(info.properties).map(([k, v]) => (
          <div key={k}>
            <dt>{k}</dt>
            <dd>{typeof v === "string" ? v : JSON.stringify(v)}</dd>
          </div>
        ))}
      </dl>
      {info.tags.map((t) => (
        <span className="tag" key={t}>
          #{t}{" "}
        </span>
      ))}
    </>
  );
  const documentView = (
    <div
      ref={root}
      className={"document-mode mode-" + mode}
      onKeyDownCapture={(e) => {
        if (
          !markdown ||
          !editor.current?.hasFocus ||
          !(e.ctrlKey || e.metaKey) ||
          e.shiftKey ||
          e.altKey
        )
          return;
        const style =
          e.key.toLowerCase() === "b"
            ? formats[0]
            : e.key.toLowerCase() === "i"
              ? formats[1]
              : null;
        if (style) {
          e.preventDefault();
          e.stopPropagation();
          format(style[2], style[3], style[4]);
        }
      }}
    >
      {(mode === "edit" || mode === "split" || mode === "live") && (
        <nav className="format-bar" aria-label="编辑工具">
          {markdown &&
            formats.map(([symbol, label, before, after, sample]) => (
              <button
                key={label}
                aria-label={label}
                title={label}
                onMouseDown={(e) => e.preventDefault()}
                onClick={() => format(before, after, sample)}
              >
                {symbol}
              </button>
            ))}
          {attach && (
            <button aria-label="插入附件" title="插入附件" onClick={attach}>
              ⊕
            </button>
          )}
        </nav>
      )}
      {mode === "split" || mode === "edit" ? (
        <SplitEditor editor={editor} source={sourcePane}>
          {mode === "split" && (
            <MarkdownView text={text} io={io} toggle={toggle} />
          )}
        </SplitEditor>
      ) : mode === "map" ? (
        <>
          <HeadingEditor text={text} edit={edit} />
          <nav aria-label="标题树思维导图" className="mindmap">
            {info.outline.length ? (
              <Branches items={info.outline} jump={jump} />
            ) : (
              <p>添加 Markdown 标题后即可生成思维导图。</p>
            )}
          </nav>
        </>
      ) : mode === "live" ? (
        <div className="live">
          <MarkdownView
            text={text}
            io={io}
            activate={activate}
            toggle={toggle}
            slot={
              bounds
                ? {
                    start: bounds.start,
                    end: text.length - bounds.tail,
                    original: bounds.original,
                    content: (
                      <div className="live-block">
                        <Source
                          key={bounds.start}
                          editor={editor}
                          label="当前段落源码"
                          focus
                          inline={{ caret: bounds.caret, keyDown: liveKey }}
                          text={text.slice(
                            bounds.start,
                            text.length - bounds.tail,
                          )}
                          onSelect={(a, b) =>
                            select(bounds.start + a, bounds.start + b)
                          }
                          onChange={(s) => {
                            if (!block) setBlock(bounds);
                            edit(
                              text.slice(0, bounds.start) +
                                s +
                                text.slice(text.length - bounds.tail),
                            );
                          }}
                        />
                        <button
                          className="finish-block"
                          title="完成段落 (Esc)"
                          aria-label="完成段落"
                          onClick={finishBlock}
                        >
                          ✓
                        </button>
                      </div>
                    ),
                  }
                : undefined
            }
          />
          <button
            className="add-paragraph"
            onClick={() => {
              const prefix =
                !text || text.endsWith("\n\n")
                  ? ""
                  : text.endsWith("\n")
                    ? "\n"
                    : "\n\n";
              edit(text + prefix);
              select(text.length + prefix.length, text.length + prefix.length);
              setBlock({
                start: text.length + prefix.length,
                tail: 0,
                original: "",
                caret: 0,
              });
            }}
          >
            添加段落
          </button>
        </div>
      ) : markdown ? (
        <MarkdownView text={text} io={io} />
      ) : (
        <pre>{text}</pre>
      )}
      {metadataHost === undefined && metadata && (
        <details className="metadata">
          <summary>目录与属性</summary>
          {metadata}
        </details>
      )}
    </div>
  );
  if (!metadataHost || !metadata) return documentView;
  return (
    <>
      {documentView}
      {createPortal(
        <section aria-label="目录与属性">
          <h2>目录与属性</h2>
          {metadata}
          {!info.outline.length &&
            !Object.keys(info.properties).length &&
            !info.tags.length && <p>当前笔记没有标题、属性或标签。</p>}
        </section>,
        metadataHost,
      )}
    </>
  );
}
