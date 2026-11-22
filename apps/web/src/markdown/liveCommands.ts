import {
  isolateHistory,
  indentLess,
  indentMore,
  insertNewlineAndIndent,
} from "@codemirror/commands";
import { insertNewlineContinueMarkupCommand } from "@codemirror/lang-markdown";
import { syntaxTree } from "@codemirror/language";
import { EditorSelection } from "@codemirror/state";
import { EditorView } from "@codemirror/view";
import { literalAt } from "./livePreview";

const continueMarkup = insertNewlineContinueMarkupCommand({
  nonTightLists: false,
});
const listItem = /^(\s*)(?:[-+*]|\d+[.)])\s+/;

function replace(
  view: EditorView,
  from: number,
  to: number,
  insert: string,
  caret = from + insert.length,
) {
  view.dispatch({
    changes: { from, to, insert },
    selection: { anchor: caret },
    scrollIntoView: true,
    userEvent: "input",
    annotations: isolateHistory.of("full"),
  });
  return true;
}

function paragraphBreak(view: EditorView, soft: boolean) {
  const { state } = view,
    { from, to, empty } = state.selection.main;
  const line = state.doc.lineAt(from);
  const tree = syntaxTree(state);
  const node = tree.resolveInner(from, -1);
  let code = node;
  while (
    code.parent &&
    !["FencedCode", "CodeBlock", "Table"].includes(code.name)
  )
    code = code.parent;
  const literal = literalAt(state, from);
  if (empty && from === line.to && !soft) {
    const fence = line.text.match(/^ {0,3}(`{3,}|~{3,}|\$\$)[^`~]*$/);
    if (fence) {
      const marks =
        code.name === "FencedCode" ? code.getChildren("CodeMark") : [];
      const closingCode = marks.length > 1 && marks.at(-1)!.to === from;
      const closingMath =
        literal?.kind === "math" &&
        literal.to === from &&
        literal.from < line.from;
      if (closingCode || closingMath) return replace(view, from, to, "\n\n");
      const openingCode = marks.length === 1 && marks[0].from >= line.from;
      const openingMath =
        line.text.trim() === "$$" &&
        (!literal || (literal.from === line.from && literal.to === line.to));
      if (openingCode || openingMath)
        return replace(view, from, to, "\n\n" + fence[1], from + 1);
    }
  }
  if (["FencedCode", "CodeBlock", "Table"].includes(code.name) || literal)
    return insertNewlineAndIndent(view);
  if (soft) {
    const before = state.sliceDoc(line.from, from);
    const spaces = before.endsWith("\\")
      ? ""
      : " ".repeat(Math.max(0, 2 - (before.match(/ *$/)?.[0].length ?? 0)));
    return replace(view, from, to, spaces + "\n");
  }
  if (
    empty &&
    from === line.to &&
    /^(?:[-+*]|\d+[.)])\s+(?:\[[ xX]\]\s*)?$|^>\s*$/.test(line.text)
  ) {
    const separator =
      line.number > 1 && state.doc.line(line.number - 1).text.trim()
        ? "\n"
        : "";
    return replace(view, line.from, to, separator);
  }
  if (continueMarkup(view)) return true;
  // Close and reopen nested inline marks when splitting their text across paragraphs.
  let left = "",
    right = "",
    start = from,
    end = to;
  if (empty)
    for (let n: typeof node | null = node; n; n = n.parent) {
      if (
        !["Emphasis", "StrongEmphasis", "Strikethrough", "InlineCode"].includes(
          n.name,
        )
      )
        continue;
      const open = n.firstChild,
        close = n.lastChild;
      if (!open || !close || open.from === close.from) continue;
      if (start === open.to && !left) start = end = open.from;
      else if (end === close.from && !left) start = end = close.to;
      else if (start > open.to && end < close.from) {
        left += state.sliceDoc(close.from, close.to);
        right = state.sliceDoc(open.from, open.to) + right;
      }
    }
  return replace(view, start, end, left + "\n\n" + right);
}

// A single empty source line between prose paragraphs is one paragraph boundary.
function paragraphGap(view: EditorView, lineNumber: number) {
  const { state } = view,
    { doc } = state;
  if (lineNumber < 2 || lineNumber >= doc.lines || doc.line(lineNumber).length)
    return;
  const from = doc.line(lineNumber - 1).to,
    to = doc.line(lineNumber + 1).from;
  if (
    !doc.line(lineNumber - 1).length ||
    literalAt(state, from) ||
    literalAt(state, to)
  )
    return;
  const tree = syntaxTree(state);
  function prose(pos: number, bias: -1 | 1) {
    let node = tree.resolveInner(pos, bias);
    while (node.parent?.parent) node = node.parent;
    return /^(?:Paragraph|Document|ATXHeading[1-6]|SetextHeading[12])$/.test(
      node.name,
    );
  }
  if (prose(from, -1) && prose(to, 1)) return { from, to };
}

export const liveKeys = EditorView.domEventHandlers({
  keydown(event, view) {
    if (
      event.isComposing ||
      event.keyCode === 229 ||
      view.composing ||
      event.metaKey ||
      event.ctrlKey ||
      event.altKey ||
      view.state.selection.ranges.length !== 1
    )
      return false;
    const { state } = view,
      range = state.selection.main;
    const line = state.doc.lineAt(range.head);
    if (event.key === "Enter") return paragraphBreak(view, event.shiftKey);
    if (range.empty && !event.shiftKey) {
      const gap =
        event.key === "Backspace" && range.head === line.from
          ? paragraphGap(view, line.number - 1)
          : event.key === "Delete" && range.head === line.to
            ? paragraphGap(view, line.number + 1)
            : undefined;
      if (gap) return replace(view, gap.from, gap.to, "");
    }
    if (
      (event.key === "ArrowUp" || event.key === "ArrowDown") &&
      (range.empty || event.shiftKey)
    ) {
      const down = event.key === "ArrowDown",
        target = view.moveVertically(range, down);
      if (
        target.head !== range.head &&
        paragraphGap(view, state.doc.lineAt(target.head).number)
      ) {
        const next = view.moveVertically(target, down);
        const selection = event.shiftKey
          ? EditorSelection.range(
              range.anchor,
              next.head,
              next.goalColumn,
              next.bidiLevel ?? undefined,
              next.assoc,
            )
          : next;
        view.dispatch({ selection, scrollIntoView: true, userEvent: "select" });
        return true;
      }
    }
    if (event.key === "Tab" && listItem.test(line.text))
      return (event.shiftKey ? indentLess : indentMore)(view);
    return false;
  },
});
