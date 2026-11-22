import { isolateHistory } from "@codemirror/commands";
import { syntaxTree } from "@codemirror/language";
import {
  EditorSelection,
  type ChangeSpec,
  type EditorState,
  type Line,
  type TransactionSpec,
} from "@codemirror/state";
import type { EditorView } from "@codemirror/view";

const marks: Record<string, string> = {
  "**": "StrongEmphasis",
  "*": "Emphasis",
  "~~": "Strikethrough",
  "`": "InlineCode",
};
const list = /^(?:[-+*]|\d+[.)])[ \t]+(?:\[[ xX]\][ \t]+)?/;
const blockPrefix =
  /^[ \t]*(?:(?:> ?)+[ \t]*)?(?:#{1,6}[ \t]+|(?:[-+*]|\d+[.)])[ \t]+(?:\[[ xX]\][ \t]+)?)?/;

function selectedLines(state: EditorState) {
  const { from, to } = state.selection.main;
  const first = state.doc.lineAt(from).number,
    last = state.doc.lineAt(Math.max(from, to - 1)).number;
  return Array.from({ length: last - first + 1 }, (_, i) =>
    state.doc.line(first + i),
  );
}

function formatLines(state: EditorState, prefix: string): TransactionSpec {
  const lines = selectedLines(state);
  const items = lines
    .filter((line) => lines.length === 1 || line.text.trim())
    .map((line) => {
      const indent = line.text.match(/^[ \t]*/)![0].length;
      const text = line.text.slice(indent);
      const pattern =
        prefix === "## "
          ? /^#{1,6}(?:[ \t]+|$)/
          : prefix === "> "
            ? /^> ?/
            : list;
      const old = text.match(pattern)?.[0] ?? "";
      const same = prefix === "- [ ] " ? /\[[ xX]\]/.test(old) : old === prefix;
      return { from: line.from + indent, old, same };
    });
  const remove = items.every((item) => item.same);
  const changes = state.changes(
    items
      .filter((item) => remove || !item.same)
      .map(({ from, old }) => ({
        from,
        to: from + old.length,
        insert: remove ? "" : prefix,
      })),
  );
  const { anchor, head } = state.selection.main;
  return {
    changes,
    selection: {
      anchor: changes.mapPos(anchor, 1),
      head: changes.mapPos(head, 1),
    },
  };
}

function enclosingMark(
  state: EditorState,
  from: number,
  to: number,
  name: string,
) {
  let node = syntaxTree(state).resolveInner(from, 1);
  while (node.parent && node.name !== name) node = node.parent;
  const open = node.firstChild,
    close = node.lastChild;
  if (
    node.name === name &&
    node.to >= to &&
    open &&
    close &&
    open.to <= close.from &&
    (from === to || (to > open.to && from < close.from))
  )
    return { open, close };
}

function formatText(state: EditorState, delimiter: string): TransactionSpec {
  const range = state.selection.main;
  function content(line: Line) {
    const start = Math.max(
        range.from,
        line.from + line.text.match(blockPrefix)![0].length,
      ),
      end = Math.min(range.to, line.to);
    if (start >= end) return [];
    const text = state.sliceDoc(start, end),
      trimmed = text.trim();
    if (!trimmed) return [];
    const from = start + text.indexOf(trimmed),
      to = from + trimmed.length;
    return [
      { from, to, mark: enclosingMark(state, from, to, marks[delimiter]) },
    ];
  }
  const pieces = selectedLines(state).flatMap(content),
    remove = pieces.every((p) => p.mark);
  const edits: ChangeSpec[] = [];
  for (let i = 0; i < pieces.length; i++) {
    const { from, mark } = pieces[i];
    let { to } = pieces[i];
    if (remove && mark) {
      // One emphasis span may cross a soft line break.
      while (pieces[i + 1]?.mark?.open.from === mark.open.from)
        to = pieces[++i].to;
      const { open, close } = mark;
      edits.push(
        from <= open.to
          ? { from: open.from, to: open.to }
          : { from, insert: state.sliceDoc(close.from, close.to) },
        to >= close.from
          ? { from: close.from, to: close.to }
          : { from: to, insert: state.sliceDoc(open.from, open.to) },
      );
    } else if (!mark)
      edits.push({ from, insert: delimiter }, { from: to, insert: delimiter });
  }
  const changes = state.changes(edits);
  const a = changes.mapPos(range.from, 1),
    b = changes.mapPos(range.to, -1);
  return {
    changes,
    selection:
      range.anchor <= range.head
        ? EditorSelection.single(a, b)
        : EditorSelection.single(b, a),
  };
}

function typeWithMark(state: EditorState, delimiter: string): TransactionSpec {
  const pos = state.selection.main.head;
  if (
    state.sliceDoc(Math.max(0, pos - delimiter.length), pos) === delimiter &&
    state.sliceDoc(pos, pos + delimiter.length) === delimiter
  )
    return {
      changes: { from: pos - delimiter.length, to: pos + delimiter.length },
    };
  const mark = enclosingMark(state, pos, pos, marks[delimiter]);
  let left = delimiter,
    right = delimiter;
  if (mark && pos >= mark.open.to && pos <= mark.close.from) {
    if (pos === mark.open.to) return { selection: { anchor: mark.open.from } };
    if (pos === mark.close.from)
      return { selection: { anchor: mark.close.to } };
    left = state.sliceDoc(mark.close.from, mark.close.to);
    right = state.sliceDoc(mark.open.from, mark.open.to);
  }
  return {
    changes: { from: pos, insert: left + right },
    selection: { anchor: pos + left.length },
  };
}

export function formatSelection(
  view: EditorView,
  before: string,
  after: string,
  sample: string,
) {
  const { state } = view,
    { from, to, empty } = state.selection.main;
  let spec: TransactionSpec;
  if (!after) spec = formatLines(state, before);
  else if (before === after)
    spec = empty ? typeWithMark(state, before) : formatText(state, before);
  else {
    const value = state.sliceDoc(from, to) || sample,
      anchor = from + before.length;
    spec = {
      changes: { from, to, insert: before + value + after },
      selection: { anchor, head: anchor + value.length },
    };
  }
  view.dispatch({
    ...spec,
    userEvent: "input.format",
    annotations: isolateHistory.of("full"),
    scrollIntoView: true,
  });
  view.focus();
}
