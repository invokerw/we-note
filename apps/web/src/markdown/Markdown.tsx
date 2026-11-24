import { createPortal } from "react-dom";
import { boardText, boardStrokes, Whiteboard } from "./Whiteboard";
import { useEffect, useMemo, useRef, type RefObject } from "react";
import SplitEditor from "./SplitEditor";
import { inspect, taskCheckChange, type Branch } from "./document";
import HeadingEditor from "./HeadingEditor";
import Source from "./Source";
import { formatSelection } from "./format";
import { EditorView } from "@codemirror/view";
import { MarkdownView, type MarkdownIO } from "./MarkdownView";
import {
  defaultMarkdownPreferences,
  type MarkdownPreferences,
} from "../preferences";
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
  editor,
  markdown = true,
  focusSource = false,
  metadataHost,
  attach,
  preferences = defaultMarkdownPreferences,
  onPreferencesChange,
}: {
  text: string;
  edit: (s: string) => void;
  mode: Mode;
  setMode: (m: Mode) => void;
  io: MarkdownIO;
  editor: RefObject<EditorView | null>;
  markdown?: boolean;
  focusSource?: boolean;
  metadataHost?: HTMLElement | null;
  attach?: () => void;
  preferences?: MarkdownPreferences;
  onPreferencesChange?: (patch: Partial<MarkdownPreferences>) => void;
}) {
  const metadataText =
    markdown && (mode === "map" || metadataHost !== null) ? text : "";
  const info = useMemo(() => inspect(metadataText), [metadataText]);
  const root = useRef<HTMLDivElement>(null);
  const jumpOffset = useRef<number | null>(null);
  useEffect(() => {
    if (mode === "read" && jumpOffset.current !== null) {
      root.current
        ?.querySelector(`[data-block-start="${jumpOffset.current}"]`)
        ?.scrollIntoView({ block: "center" });
      jumpOffset.current = null;
    }
  }, [mode]);
  function jump(n: Branch) {
    const cm = editor.current;
    if (cm) {
      cm.dispatch({
        selection: { anchor: n.offset },
        effects: EditorView.scrollIntoView(n.offset, { y: "center" }),
      });
      cm.focus();
      return;
    }
    if (mode === "read")
      root.current
        ?.querySelector(`[data-block-start="${n.offset}"]`)
        ?.scrollIntoView({ block: "center" });
    else {
      jumpOffset.current = n.offset;
      setMode("read");
    }
  }
  const toggle = (offset: number) => {
    const change = taskCheckChange(text, offset);
    if (change)
      edit(text.slice(0, change.from) + change.insert + text.slice(change.to));
  };
  function format(before: string, after: string, sample: string) {
    const cm = editor.current;
    if (cm && !cm.composing) formatSelection(cm, before, after, sample);
  }
  const sourcePane = (
    <Source
      editor={editor}
      focus={mode === "live" || focusSource}
      live={mode === "live"}
      io={io}
      label={mode === "live" ? "笔记正文" : "笔记源码"}
      text={text}
      onChange={edit}
    />
  );
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
      data-markdown-theme={markdown ? "clean" : undefined}
      data-markdown-font-size={markdown ? preferences.fontSize : undefined}
      onKeyDownCapture={(e) => {
        if (
          !markdown ||
          !editor.current?.hasFocus ||
          editor.current.composing ||
          e.nativeEvent.isComposing ||
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
      {mode === "split" || mode === "edit" || mode === "live" ? (
        <SplitEditor
          editor={editor}
          source={sourcePane}
          label={mode === "live" ? "正文编辑区" : "源码栏"}
          ratio={markdown ? preferences.splitRatio : undefined}
          linked={markdown ? preferences.syncScroll : undefined}
          onRatioChange={
            markdown
              ? (splitRatio) => onPreferencesChange?.({ splitRatio })
              : undefined
          }
          onLinkedChange={
            markdown
              ? (syncScroll) => onPreferencesChange?.({ syncScroll })
              : undefined
          }
        >
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
