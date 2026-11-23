import {
  createContext,
  useContext,
  useMemo,
  useEffect,
  useState,
  type ReactNode,
} from "react";
import { highlightTree } from "@lezer/highlight";
import { fenceLanguage, codeTokens } from "./codeHighlight";
import Markdown, { type Components } from "react-markdown";
import type { Root } from "hast";
import { visit } from "unist-util-visit";
import katex from "rehype-katex";
import "katex/dist/katex.min.css";
import { boardStrokes, Whiteboard } from "./Whiteboard";
import { extensions, noteSyntax } from "./document";

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
const RenderContext = createContext<{
  io: MarkdownIO;
  toggle?: (pos: number) => void;
}>({ io: {} });
function Code({ className, children }: { className?: string; children?: ReactNode }) {
  const language = className?.match(/(?:^|\s)language-([^\s]+)/)?.[1];
  const content = useMemo(() => {
    const parser = language && fenceLanguage(language)?.parser;
    if (!parser || typeof children !== "string" || children.length > 100_000) return children;
    const parts: ReactNode[] = [];
    let cursor = 0;
    highlightTree(parser.parse(children), codeTokens, (from, to, style) => {
      if (from > cursor) parts.push(children.slice(cursor, from));
      parts.push(<span key={from} className={style}>{children.slice(from, to)}</span>);
      cursor = to;
    });
    parts.push(children.slice(cursor));
    return parts;
  }, [language, children]);
  if (language === "mermaid") return <Diagram source={String(children).trimEnd()} />;
  return <code className={className} data-language={language}>{content}</code>;
}
const components: Components = {
  pre: ({ node, ...props }) => (
    <pre {...props} className="markdown-code-block" />
  ),
  img: function Image({ src, alt }) {
    const { io } = useContext(RenderContext);
    if (typeof src !== "string") return null;
    return io.image ? io.image(src, alt || "") : <img src={src} alt={alt} />;
  },
  a: function Link({ href, children }) {
    const { io } = useContext(RenderContext);
    return (
      <a
        href={href}
        target={href?.startsWith("#") ? undefined : "_blank"}
        rel="noreferrer"
        onClick={(e) => {
          if (href && io.link?.(href, e.currentTarget.textContent || ""))
            e.preventDefault();
        }}
      >
        {children}
      </a>
    );
  },
  code: Code,
  li: function Item({ node, children, ...props }) {
    const { toggle } = useContext(RenderContext);
    return (
      <li
        {...props}
        onClick={(e) => {
          if (toggle && (e.target as Element).matches("input[type=checkbox]")) {
            e.stopPropagation();
            toggle(node?.position?.start.offset ?? 0);
          }
        }}
      >
        {children}
      </li>
    );
  },
  input: function Task({ checked }) {
    const { toggle } = useContext(RenderContext);
    return (
      <input
        type="checkbox"
        checked={checked}
        readOnly
        disabled={!toggle}
        aria-label="任务完成"
      />
    );
  },
};
const inlineComponents: Components = {
  ...components,
  p: ({ children }) => <>{children}</>,
};

export function MarkdownView({
  text,
  io,
  toggle,
  preview,
}: {
  text: string;
  io: MarkdownIO;
  toggle?: (pos: number) => void;
  preview?: "block" | "inline";
}) {
  const body = useMemo(
    () => (
      <Markdown
        remarkPlugins={[...extensions, noteSyntax]}
        rehypePlugins={[
          [katex, { trust: false }],
          () => (tree: Root) => {
            for (const n of tree.children) {
              if (n.type === "element" && n.position) {
                n.properties["data-block-start"] = n.position.start.offset;
              }
            }
            // A click in a rendered table cell should put the caret on that character.
            if (preview)
              visit(tree, "text", (n, i, parent) => {
                if (
                  i === undefined ||
                  parent?.type !== "element" ||
                  parent.tagName === "code" ||
                  !n.position
                )
                  return;
                const start = n.position.start.offset!,
                  end = n.position.end.offset!;
                if (text.slice(start, end) !== n.value) return;
                parent.children[i] = {
                  type: "element",
                  tagName: "span",
                  properties: { "data-text-start": start },
                  children: [n],
                };
                return i + 1;
              });
          },
        ]}
        components={preview === "inline" ? inlineComponents : components}
      >
        {text}
      </Markdown>
    ),
    [text, preview],
  );
  const strokes = boardStrokes(text);
  if (strokes) return <Whiteboard strokes={strokes} />;
  const Tag = preview === "inline" ? "span" : "div";
  return (
    <RenderContext.Provider value={{ io, toggle }}>
      <Tag className="reading">{body}</Tag>
    </RenderContext.Provider>
  );
}
