import { useEffect, useMemo, useState, useRef, type ReactNode } from "react";
import Markdown from "react-markdown";
import katex from "rehype-katex";
import "katex/dist/katex.min.css";
import { inspect, extensions, noteSyntax, type Branch } from "./document";
import HeadingEditor from "./HeadingEditor";
import Source from "./Source";

let diagramEngine: Promise<(typeof import("mermaid"))["default"]> | undefined;
function Diagram({ source }: { source: string }) {
  const [result, set] = useState({ url: "", error: "" });
  useEffect(() => {
    let active = true,
      url = "";
    set({ url: "", error: "" });
    async function render() {
      diagramEngine ??= import("mermaid").then(({ default: m }) => {
        m.initialize({
          startOnLoad: false,
          securityLevel: "strict",
          htmlLabels: false,
          suppressErrorRendering: true,
          secure: [
            "securityLevel",
            "startOnLoad",
            "htmlLabels",
            "maxTextSize",
            "maxEdges",
            "dompurifyConfig",
            "suppressErrorRendering",
          ],
        });
        return m;
      });
      const m = await diagramEngine;
      const { svg } = await m.render("diagram-" + crypto.randomUUID(), source);
      if (active) {
        url = URL.createObjectURL(new Blob([svg], { type: "image/svg+xml" }));
        set({ url, error: "" });
      }
    }
    render().catch((e) => {
      if (active) set({ url: "", error: String(e) });
    });
    return () => {
      active = false;
      if (url) URL.revokeObjectURL(url);
    };
  }, [source]);
  return result.url ? (
    <img className="diagram" alt="Mermaid 图表" src={result.url} />
  ) : (
    <span role="status">{result.error || "正在绘图…"}</span>
  );
}
export type MarkdownIO = {
  image?: (src: string, alt: string) => ReactNode;
  link?: (href: string, label: string) => boolean;
};
export function MarkdownView({
  text,
  io,
  offset = 0,
  activate,
  toggle,
}: {
  text: string;
  io: MarkdownIO;
  offset?: number;
  activate?: (start: number, end: number) => void;
  toggle?: (pos: number) => void;
}) {
  return (
    <div
      className="reading"
      onClick={(e) => {
        const target = e.target as Element;
        if (!activate || target.closest("a,input,button")) return;
        const block = target.closest<HTMLElement>("[data-block-start]");
        if (block)
          activate(
            offset + Number(block.dataset.blockStart),
            offset + Number(block.dataset.blockEnd),
          );
      }}
    >
      <Markdown
        remarkPlugins={[...extensions, noteSyntax]}
        rehypePlugins={[
          [katex, { trust: false }],
          () => (tree) => {
            for (const n of tree.children) {
              if (n.type === "element" && n.position) {
                n.properties["data-block-start"] = n.position.start.offset;
                n.properties["data-block-end"] = n.position.end.offset;
              }
            }
          },
        ]}
        components={{
          img: ({ src, alt }) =>
            typeof src === "string" ? (
              io.image ? (
                io.image(src, alt || "")
              ) : (
                <img src={src} alt={alt} />
              )
            ) : null,
          a: ({ href, children }) => (
            <a
              href={href}
              target={href?.startsWith("#") ? undefined : "_blank"}
              rel="noreferrer"
              onClick={(e) => {
                if (href && io.link?.(href, String(children)))
                  e.preventDefault();
              }}
            >
              {children}
            </a>
          ),
          code: ({ className, children }) =>
            className === "language-mermaid" ? (
              <Diagram source={String(children).trimEnd()} />
            ) : (
              <code className={className}>{children}</code>
            ),
          li: ({ node, children, ...p }) => (
            <li
              {...p}
              onClick={(e) => {
                if (
                  toggle &&
                  (e.target as Element).matches("input[type=checkbox]")
                ) {
                  e.stopPropagation();
                  toggle(offset + (node?.position?.start.offset ?? 0));
                }
              }}
            >
              {children}
            </li>
          ),
          input: ({ checked }) => (
            <input
              type="checkbox"
              checked={checked}
              readOnly
              disabled={!toggle}
              aria-label="任务完成"
            />
          ),
          blockquote: ({ node, children, ...p }) => (
            <blockquote {...p}>{children}</blockquote>
          ),
        }}
      >
        {text}
      </Markdown>
    </div>
  );
}
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
export type Mode = "read" | "edit" | "live" | "map";
export const modes = [
  ["read", "阅读"],
  ["edit", "源码"],
  ["live", "实时预览"],
  ["map", "思维导图"],
] as const;
export function Document({
  text,
  edit,
  mode,
  setMode,
  io,
  select,
  markdown = true,
}: {
  text: string;
  edit: (s: string) => void;
  mode: Mode;
  setMode: (m: Mode) => void;
  io: MarkdownIO;
  select: (a: number, b: number) => void;
  markdown?: boolean;
}) {
  const info = useMemo(() => inspect(markdown ? text : ""), [text, markdown]);
  const [block, setBlock] = useState<{ start: number; tail: number } | null>(
    null,
  );
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
  function activate(start: number, end: number) {
    select(start, start);
    setBlock({ start, tail: text.length - end });
  }
  const toggle = (offset: number) => {
    const body = text.slice(offset);
    const m = body.match(/^(?:[-+*]|\d+[.)])\s+\[([ xX])\]/);
    if (m) {
      const at = offset + m[0].length - 2;
      edit(text.slice(0, at) + (m[1] === " " ? "x" : " ") + text.slice(at + 1));
    }
  };
  const bounds = mode === "live" ? block : null;
  return (
    <div ref={root}>
      {markdown && mode !== "map" && (
        <details className="metadata">
          <summary>目录与属性</summary>
          {!!info.outline.length && (
            <Branches items={info.outline} jump={jump} />
          )}
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
        </details>
      )}
      {mode === "edit" ? (
        <Source
          label="笔记源码"
          text={text}
          onChange={edit}
          onSelect={select}
        />
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
          {bounds ? (
            <>
              <MarkdownView
                text={text.slice(0, bounds.start)}
                io={io}
                activate={activate}
                toggle={toggle}
              />
              <Source
                key={bounds.start}
                label="当前段落源码"
                focus
                text={text.slice(bounds.start, text.length - bounds.tail)}
                onSelect={(a, b) => select(a + bounds.start, b + bounds.start)}
                onChange={(s) =>
                  edit(
                    text.slice(0, bounds.start) +
                      s +
                      text.slice(text.length - bounds.tail),
                  )
                }
              />
              <button onClick={() => setBlock(null)}>完成段落</button>
              <MarkdownView
                text={text.slice(text.length - bounds.tail)}
                offset={text.length - bounds.tail}
                io={io}
                activate={activate}
                toggle={toggle}
              />
            </>
          ) : (
            <MarkdownView
              text={text}
              io={io}
              activate={activate}
              toggle={toggle}
            />
          )}
          <button
            onClick={() => {
              const prefix = text.length ? "\n\n" : "";
              edit(text + prefix);
              select(text.length + prefix.length, text.length + prefix.length);
              setBlock({ start: text.length + prefix.length, tail: 0 });
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
    </div>
  );
}
