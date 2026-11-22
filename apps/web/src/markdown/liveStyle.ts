import { syntaxTree } from "@codemirror/language";
import {
  Decoration,
  EditorView,
  ViewPlugin,
  type ViewUpdate,
} from "@codemirror/view";
import type { Range } from "@codemirror/state";

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
  "LinkMark",
  "QuoteMark",
]);

function decorate(view: EditorView) {
  const marks: Range<Decoration>[] = [];
  syntaxTree(view.state).iterate({
    enter(node) {
      const heading = /^(?:ATX|Setext)Heading([1-6])$/.exec(node.name);
      if (heading)
        marks.push(
          Decoration.line({ class: `live-h${heading[1]}` }).range(
            view.state.doc.lineAt(node.from).from,
          ),
        );
      const style = styles[node.name];
      if (style)
        marks.push(
          Decoration.mark({ class: `live-${style}` }).range(node.from, node.to),
        );
      if (node.name === "QuoteMark") {
        marks.push(
          Decoration.line({ class: "live-quote" }).range(
            view.state.doc.lineAt(node.from).from,
          ),
        );
      }
      const parent = node.node.parent;
      if (node.name === "CodeMark" && parent?.name === "FencedCode") return;
      // Keep image markup and reference labels intact when editing their source.
      if (node.name === "LinkMark" && parent?.name !== "Link") return;
      const editingLink =
        parent?.name === "Link" &&
        view.state.selection.ranges.some(
          (range) => range.from <= parent.to && range.to >= parent.from,
        );
      if (
        (node.name === "URL" ||
          node.name === "LinkTitle" ||
          node.name === "LinkLabel") &&
        parent?.name === "Link" &&
        !editingLink &&
        view.state.doc.lineAt(node.from).to >= node.to
      ) {
        marks.push(Decoration.replace({}).range(node.from, node.to));
      }
      if (delimiters.has(node.name)) {
        const at =
          editingLink ||
          view.state.selection.ranges.some(
            (r) => r.from <= node.to && r.to >= node.from,
          );
        // Reveal a delimiter at the caret so arrow keys and Backspace can edit it.
        const mark = at
          ? Decoration.mark({ class: "live-marker" })
          : Decoration.replace({});
        marks.push(mark.range(node.from, node.to));
      }
    },
  });
  return Decoration.set(marks, true);
}
export const liveStyle = ViewPlugin.fromClass(
  class {
    decorations;
    constructor(view: EditorView) {
      this.decorations = decorate(view);
    }
    update(update: ViewUpdate) {
      if (
        update.docChanged ||
        update.selectionSet ||
        syntaxTree(update.startState) !== syntaxTree(update.state)
      )
        this.decorations = decorate(update.view);
    }
  },
  { decorations: (v) => v.decorations },
);
