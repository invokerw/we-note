import {
  Facet,
  StateEffect,
  StateField,
  type EditorSelection,
  type EditorState,
} from "@codemirror/state";
import {
  Decoration,
  EditorView,
  ViewPlugin,
  WidgetType,
  type DecorationSet,
  type ViewUpdate,
} from "@codemirror/view";
import { createRoot } from "react-dom/client";
import type { Root as ReactRoot } from "react-dom/client";
import { SKIP, visit } from "unist-util-visit";
import { parseMarkdown, taskCheckChange } from "./document";
import { MarkdownView, type MarkdownIO } from "./MarkdownView";

type Fragment = { from: number; to: number; kind: string; widget?: Preview };
const mounted = new WeakMap<
  HTMLElement,
  { root: ReactRoot; observer: ResizeObserver }
>();

class Preview extends WidgetType {
  constructor(
    readonly source: string,
    readonly definitions: string,
    readonly block: boolean,
    readonly io: MarkdownIO,
  ) {
    super();
  }
  eq(other: Preview) {
    return (
      this.source === other.source &&
      this.definitions === other.definitions &&
      this.block === other.block &&
      this.io === other.io
    );
  }
  toDOM(view: EditorView) {
    const host: HTMLElement = document.createElement(
      this.block ? "div" : "span",
    );
    host.className = "live-preview";
    const root = createRoot(host);
    root.render(
      <MarkdownView
        text={this.source + this.definitions}
        io={this.io}
        preview={this.block ? "block" : "inline"}
        toggle={(offset) => {
          const change = taskCheckChange(this.source, offset);
          if (change) {
            const start = view.posAtDOM(host);
            view.dispatch({
              changes: {
                from: start + change.from,
                to: start + change.to,
                insert: change.insert,
              },
              userEvent: "input.task",
            });
          }
        }}
      />,
    );
    host.addEventListener("mousedown", (e) => {
      if (e.button === 0 && !e.metaKey && !e.ctrlKey) e.preventDefault();
    });
    host.addEventListener(
      "click",
      (e) => {
        const target = e.target as HTMLElement;
        if (
          target.closest("input[type=checkbox]") ||
          (target.closest("a") && (e.metaKey || e.ctrlKey || e.detail === 0))
        )
          return;
        e.preventDefault();
        e.stopPropagation();
        const point = document.caretPositionFromPoint?.(e.clientX, e.clientY);
        const range = point
          ? null
          : document.caretRangeFromPoint?.(e.clientX, e.clientY);
        const node = point?.offsetNode ?? range?.startContainer;
        const leaf =
          node?.parentElement?.closest<HTMLElement>("[data-text-start]");
        const start = view.posAtDOM(host, 0);
        let offset = 0;
        if (node && host.contains(node) && node.nodeType === Node.TEXT_NODE) {
          const code = node.parentElement?.closest("pre > code");
          const withinNode = point?.offset ?? range?.startOffset ?? 0;
          const base = leaf
            ? Number(leaf.dataset.textStart)
            : this.source.indexOf(((code ?? node).textContent ?? "").trimEnd());
          if (base >= 0) {
            let within = withinNode;
            if (code) {
              // Highlighted code spans can contain identical tokens on different lines.
              const prefix = document.createRange();
              prefix.selectNodeContents(code);
              prefix.setEnd(node, withinNode);
              within = prefix.toString().length;
            }
            offset = Math.min(this.source.length, base + within);
          }
        }
        const head = start + offset;
        view.dispatch({
          selection: {
            anchor: e.shiftKey ? view.state.selection.main.anchor : head,
            head,
          },
          scrollIntoView: true,
        });
        view.focus();
      },
      true,
    );
    // Images, math and diagrams finish laying out after CodeMirror's first measure.
    const observer = new ResizeObserver(() => view.requestMeasure());
    observer.observe(host);
    host.addEventListener("load", () => view.requestMeasure(), true);
    mounted.set(host, { root, observer });
    return host;
  }
  destroy(host: HTMLElement) {
    const mount = mounted.get(host);
    if (!mount) return;
    mount.observer.disconnect();
    queueMicrotask(() => mount.root.unmount());
  }
}

function fragments(text: string, io: MarkdownIO) {
  const result: Fragment[] = [];
  // Plain prose and ATX headings can be displayed by the incremental syntax tree alone.
  if (!/[\[|$>`~:@]|www\.|^ {0,3}(?:[-*_][ \t]*){3,}$|^ {4}\S/m.test(text))
    return result;
  const tree = parseMarkdown(text);
  const definitions = tree.children
    .filter((n) => n.type === "definition")
    .map((n) => text.slice(n.position!.start.offset, n.position!.end.offset))
    .join("\n\n");
  visit(tree, (node) => {
    if (!node.position || node.type === "root") return;
    const from = node.position.start.offset!,
      to = node.position.end.offset!;
    const source = text.slice(from, to);
    const block =
      ["code", "math", "table", "thematicBreak"].includes(node.type) ||
      (node.type === "blockquote" && /^>\s*\[![a-z]+\]/i.test(source));
    const reference =
      node.type === "linkReference" || node.type === "imageReference";
    if (
      block ||
      reference ||
      ["inlineMath", "image", "link"].includes(node.type)
    ) {
      result.push({
        from,
        to,
        kind: node.type,
        widget: new Preview(
          source,
          (reference || (block && source.includes("["))) && definitions
            ? "\n\n" + definitions
            : "",
          block,
          io,
        ),
      });
      return SKIP;
    }
    if (node.type === "yaml") result.push({ from, to, kind: node.type });
    if (node.type === "text") {
      for (const m of source.matchAll(/(?<!\\)\[\[[^\[\]\n]+\]\]/g)) {
        const start = from + m.index;
        result.push({
          from: start,
          to: start + m[0].length,
          kind: "wiki",
          widget: new Preview(m[0], "", false, io),
        });
      }
    }
  });
  return result;
}

function decorate(items: Fragment[], selection: EditorSelection) {
  return Decoration.set(
    items.flatMap(({ from, to, widget }) => {
      if (!widget || selection.ranges.some((r) => r.from <= to && r.to >= from))
        return [];
      return Decoration.replace({
        widget,
        block: widget.block,
        inclusive: widget.block,
      }).range(from, to);
    }),
    true,
  );
}
const refreshed = StateEffect.define<Fragment[]>();
type Previews = { items: Fragment[]; decorations: DecorationSet };

const resources = Facet.define<MarkdownIO, MarkdownIO>({
  combine: (values) => values[0] ?? {},
});
const previews = StateField.define<Previews>({
  create(state) {
    const items = fragments(state.doc.toString(), state.facet(resources));
    return { items, decorations: decorate(items, state.selection) };
  },
  update(previous, tr) {
    let items = previous.items;
    if (tr.docChanged) {
      // Never show stale rendered content. Retain untouched widgets until the idle parse.
      items = items.flatMap((item) => {
        const touched = tr.changes.touchesRange(item.from, item.to);
        const from = tr.changes.mapPos(item.from, 1),
          to = tr.changes.mapPos(item.to, -1);
        if (touched === "cover" || from >= to) return [];
        return [
          { ...item, from, to, widget: touched ? undefined : item.widget },
        ];
      });
    }
    for (const e of tr.effects) if (e.is(refreshed)) items = e.value;
    return items === previous.items && !tr.selection
      ? previous
      : { items, decorations: decorate(items, tr.state.selection) };
  },
  provide: (f) => EditorView.decorations.from(f, (value) => value.decorations),
});
const refresh = ViewPlugin.fromClass(
  class {
    timer?: ReturnType<typeof setTimeout>;
    constructor(readonly view: EditorView) {}
    update(update: ViewUpdate) {
      if (update.docChanged) this.schedule();
    }
    schedule() {
      clearTimeout(this.timer);
      this.timer = setTimeout(() => {
        if (this.view.composing) {
          this.schedule();
          return;
        }
        const state = this.view.state;
        const items = fragments(state.doc.toString(), state.facet(resources));
        if (items.length || state.field(previews).items.length)
          this.view.dispatch({ effects: refreshed.of(items) });
      }, 120);
    }
    destroy() {
      clearTimeout(this.timer);
    }
  },
);
export function livePreview(io: MarkdownIO) {
  return [resources.of(io), previews, refresh];
}
export function frontmatterEnd(state: EditorState) {
  const first = state.field(previews, false)?.items[0];
  return first?.kind === "yaml" ? first.to : -1;
}
export function literalAt(state: EditorState, pos: number) {
  return state
    .field(previews)
    .items.find(
      (f) =>
        ["yaml", "math", "table", "code"].includes(f.kind) &&
        f.from <= pos &&
        pos <= f.to,
    );
}
