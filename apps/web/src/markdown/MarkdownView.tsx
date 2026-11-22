import {
  createContext,
  useContext,
  useMemo,
  useEffect,
  useState,
  type ReactNode,
} from "react";
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
// Leave the active block's place in the full Markdown tree so that references
// outside the block still resolve, and the same editor survives each keystroke.
type SlotRange = { start: number; end: number; original: string };
type LiveSlot = SlotRange & { content: ReactNode };
const RenderContext = createContext<{
  io: MarkdownIO;
  slot?: LiveSlot;
  toggle?: (pos: number) => void;
}>({ io: {} });
export function sourceOffset(pos: number, slot?: SlotRange) {
  return slot && pos >= slot.start + slot.original.length
    ? pos - slot.original.length + slot.end - slot.start
    : pos;
}
const components: Components = {
  div: function Block({ node, children, ...props }) {
    const { slot } = useContext(RenderContext);
    return node?.properties.dataLiveSlot ? (
      slot?.content
    ) : (
      <div {...props}>{children}</div>
    );
  },
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
  code: ({ className, children }) =>
    className === "language-mermaid" ? (
      <Diagram source={String(children).trimEnd()} />
    ) : (
      <code className={className}>{children}</code>
    ),
  li: function Item({ node, children, ...props }) {
    const { toggle, slot } = useContext(RenderContext);
    return (
      <li
        {...props}
        onClick={(e) => {
          if (toggle && (e.target as Element).matches("input[type=checkbox]")) {
            e.stopPropagation();
            toggle(sourceOffset(node?.position?.start.offset ?? 0, slot));
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
export function MarkdownView({
  text,
  io,
  activate,
  toggle,
  slot,
}: {
  text: string;
  io: MarkdownIO;
  activate?: (start: number, end: number, caret?: number) => void;
  toggle?: (pos: number) => void;
  slot?: LiveSlot;
}) {
  const display = slot
    ? text.slice(0, slot.start) + slot.original + text.slice(slot.end)
    : text;
  const slotStart = slot?.start,
    originalLength = slot?.original.length ?? 0,
    editable = Boolean(activate);
  const body = useMemo(
    () => (
      <Markdown
        remarkPlugins={[...extensions, noteSyntax]}
        rehypePlugins={[
          [katex, { trust: false }],
          () => (tree: Root) => {
            for (const n of tree.children) {
              if (n.type !== "element" || !n.position) continue;
              const start = n.position.start.offset;
              n.properties["data-block-start"] = start;
              n.properties["data-block-end"] = n.position.end.offset;
              if (editable) n.properties.tabIndex = 0;
            }
            if (slotStart !== undefined) {
              const i = tree.children.findIndex(
                (n) =>
                  n.type === "element" &&
                  (n.position?.start.offset ?? -1) >= slotStart,
              );
              const found =
                i >= 0 && tree.children[i].position?.start.offset === slotStart;
              tree.children.splice(
                i < 0 ? tree.children.length : i,
                found && originalLength ? 1 : 0,
                {
                  type: "element",
                  tagName: "div",
                  properties: { dataLiveSlot: true },
                  children: [],
                },
              );
            }
            if (editable)
              visit(tree, "text", (n, i, parent) => {
                if (
                  i === undefined ||
                  !parent ||
                  !n.position ||
                  parent.type !== "element"
                )
                  return;
                const start = n.position.start.offset!,
                  end = n.position.end.offset!;
                if (
                  parent.tagName === "code" ||
                  display.slice(start, end) !== n.value
                )
                  return;
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
        components={components}
      >
        {display}
      </Markdown>
    ),
    [display, slotStart, originalLength, editable],
  );
  const strokes = boardStrokes(text);
  if (strokes) return <Whiteboard strokes={strokes} />;
  function open(block: HTMLElement, caret?: number) {
    const start = sourceOffset(Number(block.dataset.blockStart), slot);
    activate?.(
      start,
      sourceOffset(Number(block.dataset.blockEnd), slot),
      caret === undefined ? 0 : sourceOffset(caret, slot) - start,
    );
  }
  return (
    <RenderContext.Provider value={{ io, toggle, slot }}>
      <div
        className="reading"
        onClick={(e) => {
          if (
            !activate ||
            (e.target as Element).closest("a,input,button,.source")
          )
            return;
          const block = (e.target as Element).closest<HTMLElement>(
            "[data-block-start]",
          );
          if (!block || !window.getSelection()?.isCollapsed) return;
          const point = document.caretPositionFromPoint?.(e.clientX, e.clientY);
          const range = point
            ? null
            : document.caretRangeFromPoint?.(e.clientX, e.clientY);
          const node = point?.offsetNode ?? range?.startContainer;
          const leaf =
            node?.parentElement?.closest<HTMLElement>("[data-text-start]");
          open(
            block,
            leaf && block.contains(leaf)
              ? Number(leaf.dataset.textStart) +
                  (point?.offset ?? range?.startOffset ?? 0)
              : undefined,
          );
        }}
        onKeyDown={(e) => {
          const target = e.target as HTMLElement;
          if (
            activate &&
            e.key === "Enter" &&
            target.hasAttribute("data-block-start")
          ) {
            e.preventDefault();
            open(target);
          }
        }}
      >
        {body}
      </div>
    </RenderContext.Provider>
  );
}
