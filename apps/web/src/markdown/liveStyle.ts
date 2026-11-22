import { frontmatterEnd } from "./livePreview";
import { syntaxTree } from "@codemirror/language";
import {
  Decoration,
  EditorView,
  ViewPlugin,
  WidgetType,
  type ViewUpdate,
} from "@codemirror/view";
import type { Range } from "@codemirror/state";

class TaskBox extends WidgetType {
  constructor(readonly checked: boolean) {
    super();
  }
  eq(other: TaskBox) {
    return this.checked === other.checked;
  }
  toDOM(view: EditorView) {
    const box = document.createElement("input");
    box.type = "checkbox";
    box.className = "live-task";
    box.setAttribute("aria-label", "任务完成");
    box.checked = this.checked;
    box.addEventListener("mousedown", (e) => e.preventDefault());
    box.addEventListener("change", () => {
      const from = view.posAtDOM(box) + 1;
      view.dispatch({
        changes: { from, to: from + 1, insert: box.checked ? "x" : " " },
        userEvent: "input.task",
      });
    });
    return box;
  }
}
const styles: Record<string, string> = {
  StrongEmphasis: "strong",
  Emphasis: "em",
  Strikethrough: "strike",
  InlineCode: "code",
  Link: "link",
};
const delimiters = new Set([
  "EmphasisMark",
  "HeaderMark",
  "CodeMark",
  "StrikethroughMark",
  "QuoteMark",
]);
const hidden = Decoration.replace({}),
  marker = Decoration.mark({ class: "live-marker" });

function decorate(view: EditorView) {
  const { state } = view,
    { doc, selection } = state;
  const marks: Range<Decoration>[] = [];
  const yamlEnd = frontmatterEnd(state);
  const touches = (from: number, to: number) =>
    selection.ranges.some((r) => r.from <= to && r.to >= from);
  for (const { from, to } of view.visibleRanges) {
    syntaxTree(state).iterate({
      from,
      to,
      enter(node) {
        if (node.name !== "Document" && node.to <= yamlEnd) return false;
        const heading = /^(?:ATX|Setext)Heading([1-6])$/.exec(node.name);
        const line = doc.lineAt(node.from);
        if (heading)
          marks.push(
            Decoration.line({ class: `live-h${heading[1]}` }).range(line.from),
          );
        const style = styles[node.name];
        if (style)
          marks.push(
            Decoration.mark({ class: `live-${style}` }).range(
              node.from,
              node.to,
            ),
          );
        if (node.name === "FencedCode" || node.name === "CodeBlock") {
          for (
            let i = doc.lineAt(Math.max(node.from, from)).number;
            i <= doc.lineAt(Math.min(node.to, to)).number;
            ++i
          )
            marks.push(
              Decoration.line({ class: "live-fence" }).range(doc.line(i).from),
            );
        }
        if (node.name === "TaskMarker") {
          if (touches(node.from, node.to))
            marks.push(marker.range(node.from, node.to));
          else
            marks.push(
              Decoration.replace({
                widget: new TaskBox(
                  doc.sliceString(node.from + 1, node.to - 1).toLowerCase() ===
                    "x",
                ),
              }).range(node.from, node.to),
            );
        }
        if (node.name === "ListMark" && !touches(line.from, line.to)) {
          if (/^[-+*]\s+\[[ xX]\]/.test(line.text.trimStart()))
            marks.push(hidden.range(node.from, node.to + 1));
          else if (/^[-+*]$/.test(doc.sliceString(node.from, node.to)))
            marks.push(
              Decoration.mark({ class: "live-bullet" }).range(
                node.from,
                node.to,
              ),
            );
        }
        if (node.name === "QuoteMark")
          marks.push(Decoration.line({ class: "live-quote" }).range(line.from));
        const parent = node.node.parent;
        if (!delimiters.has(node.name) || !parent) return;
        if (parent.name === "FencedCode") {
          marks.push(marker.range(node.from, node.to));
          return;
        }
        if (node.to > line.to) return;
        const blockMark =
          node.name === "HeaderMark" || node.name === "QuoteMark";
        const active = blockMark
          ? touches(line.from, line.to)
          : touches(parent.from, parent.to);
        const end =
          !active && blockMark && doc.sliceString(node.to, node.to + 1) === " "
            ? node.to + 1
            : node.to;
        marks.push((active ? marker : hidden).range(node.from, end));
      },
    });
    for (
      let i = doc.lineAt(from).number, end = doc.lineAt(to).number;
      i <= end;
      i++
    ) {
      const line = doc.line(i);
      if (line.from <= yamlEnd)
        marks.push(Decoration.line({ class: "live-fence" }).range(line.from));
      else if (!line.length)
        marks.push(Decoration.line({ class: "live-blank" }).range(line.from));
    }
  }
  return Decoration.set(marks, true);
}
export const liveStyle = ViewPlugin.fromClass(
  class {
    decorations;
    constructor(view: EditorView) {
      this.decorations = decorate(view);
    }
    update(u: ViewUpdate) {
      if (
        u.docChanged ||
        u.selectionSet ||
        u.viewportChanged ||
        frontmatterEnd(u.startState) !== frontmatterEnd(u.state) ||
        syntaxTree(u.startState) !== syntaxTree(u.state)
      )
        this.decorations = decorate(u.view);
    }
  },
  { decorations: (v) => v.decorations },
);
