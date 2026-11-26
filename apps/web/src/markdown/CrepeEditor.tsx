import { useEffect, useRef, useState, type RefObject } from "react";
import { Crepe } from "@milkdown/crepe";
import { editorViewCtx, editorViewOptionsCtx, parserCtx, remarkStringifyOptionsCtx, serializerCtx } from "@milkdown/kit/core";
import { Plugin, type SelectionBookmark } from "@milkdown/kit/prose/state";
import { Slice, type Node as PMNode } from "@milkdown/kit/prose/model";
import { splitListItem } from "@milkdown/kit/prose/schema-list";
import { $prose } from "@milkdown/kit/utils";
import "@milkdown/crepe/theme/common/style.css";
import "@milkdown/crepe/theme/frame.css";
import "./crepe.css";
import { parseMarkdown } from "./document";
import { patchBlocks, type RichWriting, type Span } from "./crepeSource";

type Props = {
  focusFrom: RefObject<Element | null>;
  text: string;
  edit: (value: string) => void;
  openSplit: () => void;
  writing?: RefObject<RichWriting | null>;
  upload?: (file: File) => Promise<string>;
  imageURL?: (url: string) => Promise<string>;
};
const unsupported = "这篇笔记含有需要保留原文的语法，请在分屏编辑的源码栏修改。";
// Crepe adds a writable empty paragraph after a terminal list, quote or table.
// It acquires a Markdown source range when the user starts typing into it.
function markdownBlocks(doc: PMNode) {
  const nodes = doc.content.content;
  const last = nodes.at(-1);
  const previous = nodes.at(-2);
  if (
    previous &&
    previous.type.name !== "heading" &&
    previous.type.name !== "paragraph" &&
    last?.type.name === "paragraph" &&
    last.content.size === 0
  ) {
    return nodes.slice(0, -1);
  }
  return nodes;
}

export default function CrepeEditor(props: Props) {
  const host = useRef<HTMLDivElement>(null);
  const latest = useRef(props);
  latest.current = props;
  const emitted = useRef(props.text);
  const [initial, reset] = useState(props.text);
  const [message, report] = useState("");
  useEffect(() => {
    if (emitted.current !== props.text) {
      emitted.current = props.text;
      reset(props.text);
    }
  }, [props.text]);
  useEffect(() => {
    const mount = document.createElement("div");
    host.current!.replaceChildren(mount);
    let active = true;
    report("");
    const tree = parseMarkdown(initial);
    const hasHeader = tree.children[0]?.type === "yaml";
    const blocks = hasHeader ? tree.children.slice(1) : tree.children;
    if (
      (hasHeader && !blocks.length) ||
      blocks.some((n) =>
        ["yaml", "definition", "html", "footnoteDefinition"].includes(n.type),
      )
    ) {
      report(unsupported);
      return;
    }
    let source = initial;
    let ranges: Span[] = blocks.map((n) => [
      n.position!.start.offset!,
      n.position!.end.offset!,
    ]);
    if (!ranges.length) ranges = [[source.length, source.length]];
    const protectedBlocks = new WeakSet<PMNode>();
    const originals = new WeakMap<PMNode, string>();
    const bookmarks = new Set<{ position: SelectionBookmark }>();
    const imageURLs = new Set<string>();
    let initialized = false;
    let originalDoc: PMNode;
    const initialRanges = ranges;
    const editor = new Crepe({
      root: mount,
      defaultValue: hasHeader ? initial.slice(ranges[0][0]) : initial,
      featureConfigs: {
        [Crepe.Feature.BlockEdit]: { blockHandle: { getOffset: () => 4 } },
        [Crepe.Feature.ImageBlock]: {
          onUpload: (file) => {
            if (!latest.current.upload) throw Error("当前无法上传图片");
            return latest.current.upload(file);
          },
          async proxyDomURL(url) {
            const result = (await latest.current.imageURL?.(url)) ?? url;
            if (result.startsWith("blob:")) {
              if (active) imageURLs.add(result);
              else URL.revokeObjectURL(result);
            }
            return result;
          },
        },
      },
    });
    editor.editor.config((ctx) => {
      ctx.update(editorViewOptionsCtx, options => ({
        ...options,
        handleKeyDown(view, event) {
          if (options.handleKeyDown?.call(this, view, event)) return true;
          if (event.key !== "Enter" || event.isComposing || view.composing ||
              event.shiftKey || event.ctrlKey || event.metaKey || event.altKey) return false;
          const { $from } = view.state.selection;
          const item = $from.node(-1);
          if (!item || item.type.name !== "list_item" || item.attrs.checked !== true || !$from.parent.content.size)
            return false;
          // Enter creates a new task. Keep the completed state on the original item.
          return splitListItem(item.type, { ...item.attrs, checked: false })(view.state, view.dispatch);
        },
      }));
      ctx.update(remarkStringifyOptionsCtx, options => {
        const text = options.handlers?.text;
        if (!text) return options;
        return { ...options, handlers: { ...options.handlers,
          text(node, parent, state, info) {
            const markdown = text(node, parent, state, info);
            if (parent?.type === "link" || !node.value.includes("[[")) return markdown;
            // Crepe escapes opening brackets in ordinary text. Keep complete wiki links indexable.
            return markdown.replace(/(?<!\\)\\\[\\\[(?=[^\[\]\n]+\]\])/g, "[[");
          },
        } };
      });
    });
    editor.editor.use(
      $prose(
        (ctx) =>
          new Plugin({
            filterTransaction(tr) {
              if (!active || !initialized || !tr.docChanged) return true;
              const retained = new Set(tr.doc.content.content);
              if (
                tr.before.content.content.some(
                  (n) => protectedBlocks.has(n) && !retained.has(n),
                )
              ) {
                report("此段包含笔记专用语法，请在分屏编辑的源码栏修改此段。");
                return false;
              }
              for (const pending of bookmarks)
                pending.position = pending.position.map(tr.mapping);
              return true;
            },
            view: () => ({
              update(view, prev) {
                if (!active || !initialized || prev.doc.eq(view.state.doc))
                  return;
                if (view.state.doc.eq(originalDoc)) {
                  ranges = initialRanges;
                  source = emitted.current = initial;
                  latest.current.edit(initial);
                  return;
                }
                const before = markdownBlocks(prev.doc),
                  after = markdownBlocks(view.state.doc);
                let first = 0,
                  oldEnd = before.length,
                  newEnd = after.length;
                while (
                  first < oldEnd &&
                  first < newEnd &&
                  before[first] === after[first]
                )
                  first++;
                if (first === oldEnd && first === newEnd) return;
                while (
                  oldEnd > first &&
                  newEnd > first &&
                  before[oldEnd - 1] === after[newEnd - 1]
                ) {
                  oldEnd--;
                  newEnd--;
                }
                const changed = after
                  .slice(first, newEnd)
                  .map(
                    (n) =>
                      originals.get(n) ??
                      ctx
                        .get(
                          serializerCtx,
                        )(view.state.schema.topNodeType.create(null, n))
                        .replace(/\n$/, ""),
                  );
                const insert = first === oldEnd;
                const prefix = insert && first === before.length ? "\n\n" : "";
                const suffix = insert && first < before.length ? "\n\n" : "";
                let offset =
                  (ranges[first]?.[0] ?? ranges.at(-1)![1]) + prefix.length;
                const updated: Span[] = changed.map((raw) => {
                  const start = offset;
                  offset += raw.length + 2;
                  return [start, start + raw.length];
                });
                const next = patchBlocks(
                  source,
                  ranges,
                  first,
                  oldEnd,
                  prefix + changed.join("\n\n") + suffix,
                );
                const delta = next.length - source.length;
                ranges = [
                  ...ranges.slice(0, first),
                  ...updated,
                  ...ranges
                    .slice(oldEnd)
                    .map(([a, b]): Span => [a + delta, b + delta]),
                ];
                source = next;
                emitted.current = next;
                latest.current.edit(next);
              },
            }),
          }),
      ),
    );
    const ready = editor
      .create()
      .then(() => {
        if (!active) return;
        editor.editor.action((ctx) => {
          const view = ctx.get(editorViewCtx);
          originalDoc = view.state.doc;
          const nodes = markdownBlocks(originalDoc);
          if (ranges.length !== nodes.length)
            throw Error(unsupported);
          nodes.forEach((n, i) => {
            const raw = initial.slice(...ranges[i]);
            originals.set(n, raw);
            const complexWikiBlock = raw.includes("[[") && !n.isTextblock;
            if (complexWikiBlock || /\\\[\\?\[|^>\s*\[!|<\/?[a-z][^>]*>/im.test(raw))
              protectedBlocks.add(n);
          });
          initialized = true;
          // A mode switch may finish loading after the user has focused another control.
          const focusFrom = latest.current.focusFrom;
          if (focusFrom.current && document.activeElement === focusFrom.current) view.focus();
          focusFrom.current = null;
          if (props.writing)
            props.writing.current = {
              focusedView: () => view.root.activeElement === view.dom ? view : undefined,
              async compositionEnd() {
                if (view.composing)
                  await new Promise<void>((resolve) => {
                    view.dom.addEventListener(
                      "compositionend",
                      () => setTimeout(resolve, 0),
                      { once: true },
                    );
                    (view.dom as HTMLElement).blur();
                  });
              },
              insertion() {
                const bookmark = {
                  position: view.state.selection.getBookmark(),
                };
                bookmarks.add(bookmark);
                return (markdown) => {
                  if (!active || !bookmarks.delete(bookmark)) return false;
                  const doc = ctx.get(parserCtx)(markdown);
                  // Crepe represents block image alt text as a numeric width. Keep the
                  // uploaded Markdown for untouched blocks so exports retain the filename.
                  const blocks = parseMarkdown(markdown).children;
                  if (blocks.length === doc.childCount) {
                    doc.forEach((node, _offset, index) => {
                      const span = blocks[index].position;
                      if (node.type.name === "image-block" && span)
                        originals.set(node, markdown.slice(span.start.offset, span.end.offset));
                    });
                  }
                  const selection = bookmark.position.resolve(view.state.doc);
                  const tr = view.state.tr
                    .setSelection(selection)
                    .replaceSelection(Slice.maxOpen(doc.content));
                  view.dispatch(tr);
                  return true;
                };
              },
            };
        });
      })
      .catch((e) => {
        if (active) {
          mount.hidden = true;
          report(String(e));
        }
      });
    return () => {
      active = false;
      if (props.writing) props.writing.current = null;
      bookmarks.clear();
      for (const url of imageURLs) URL.revokeObjectURL(url);
      void ready.then(() => editor.destroy());
    };
  }, [initial, props.writing]);
  return (
    <section aria-label="可视化编辑器">
      {message && (
        <p role="status">
          {message} <button onClick={props.openSplit}>打开分屏编辑</button>
        </p>
      )}
      <div ref={host} />
    </section>
  );
}
