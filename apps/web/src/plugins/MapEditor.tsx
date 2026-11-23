import { useMemo, useRef, useState } from "react";
import {
  setTopicNote,
  topic,
  topicColor,
  topics,
  type Sheet,
  type Topic,
  type Workbook,
} from "./xmind";

type Branch = "left" | "right";
type TopicEntry = {
  node: Topic;
  parent?: Topic;
  bucket?: string;
  index?: number;
  depth: number;
};
type PositionedTopic = TopicEntry & {
  x: number;
  y: number;
  width: number;
  height: number;
  branch: Branch;
};
type MapLayout = {
  width: number;
  height: number;
  nodes: PositionedTopic[];
  byId: Map<string, PositionedTopic>;
};

const NODE_WIDTH = 144;
const NODE_MAX_WIDTH = 320;
const NODE_GAP_X = 72;
const NODE_GAP_Y = 20;
const BOARD_PADDING = 60;
const TITLE_CHAR_WIDTH = 14;
const NOTE_CHAR_WIDTH = 10;

function graphChildren(node: Topic) {
  return Object.entries(node.children ?? {}).flatMap(([bucket, children]) =>
    children.map((child, index) => ({ child, bucket, index })),
  );
}

function childEntries(node: Topic, depth: number, parent?: Topic): TopicEntry[] {
  return graphChildren(node).flatMap(({ child, bucket, index }) => [
    {
      node: child,
      parent: node,
      bucket,
      index,
      depth,
    },
    ...childEntries(child, depth + 1, node),
  ]);
}

function sourceLines(value: string | undefined, fallback = "") {
  const source = value?.trim() || fallback;
  return source ? source.replace(/\r\n?/g, "\n").split("\n") : [];
}

function longestLine(lines: string[]) {
  return Math.max(0, ...lines.map((line) => [...line].length));
}

function wrapLines(lines: string[], maxChars: number) {
  return lines.flatMap((line) => {
    const chars = [...line];
    if (!chars.length) return [""];
    const output: string[] = [];
    while (chars.length) output.push(chars.splice(0, maxChars).join(""));
    return output;
  });
}

function nodeTextLayout(node: Topic) {
  const titleSource = sourceLines(node.title, "未命名");
  const noteSource = sourceLines(node.notes?.plain?.content);
  const desiredWidth = Math.max(
    0,
    longestLine(titleSource) * TITLE_CHAR_WIDTH + 32,
    longestLine(noteSource) * NOTE_CHAR_WIDTH + 32,
  );
  const width = Math.min(NODE_MAX_WIDTH, Math.max(NODE_WIDTH, desiredWidth));
  const titleCapacity = Math.max(8, Math.floor((width - 32) / TITLE_CHAR_WIDTH));
  const noteCapacity = Math.max(12, Math.floor((width - 24) / NOTE_CHAR_WIDTH));
  const titleLines = wrapLines(titleSource, titleCapacity);
  const noteLines = wrapLines(noteSource, noteCapacity);
  return {
    width,
    titleLines,
    noteLines,
    height:
      24 +
      titleLines.length * 19 +
      (noteLines.length ? 4 + noteLines.length * 13 : 0),
  };
}

function dimensions(node: Topic) {
  const { width, height } = nodeTextLayout(node);
  return { width, height };
}

function makeLayout(sheet: Sheet): MapLayout {
  const root = sheet.rootTopic;
  const measurements = new Map<string, ReturnType<typeof dimensions>>();
  const heights = new Map<string, number>();
  function measure(node: Topic) {
    if (!measurements.has(node.id)) measurements.set(node.id, dimensions(node));
    return measurements.get(node.id)!;
  }
  function subtreeHeight(node: Topic): number {
    const cached = heights.get(node.id);
    if (cached !== undefined) return cached;
    const own = measure(node).height;
    const children = graphChildren(node);
    const descendants = children.reduce(
      (height, { child }) => height + subtreeHeight(child),
      Math.max(0, (children.length - 1) * NODE_GAP_Y),
    );
    const result = Math.max(own, descendants);
    heights.set(node.id, result);
    return result;
  }

  const branchFor = (node: Topic, fallback: Branch): Branch => {
    const direction = `${node.branch || ""} ${node.structureClass || ""}`.toLowerCase();
    if (direction.includes("left")) return "left";
    if (direction.includes("right")) return "right";
    if (!node.position?.manual && typeof node.position?.x === "number")
      return node.position.x < 0 ? "left" : "right";
    return fallback;
  };
  const rootChildren = graphChildren(root);
  const balanced = `${sheet.structureClass || ""} ${root.structureClass || ""}`
    .toLowerCase()
    .includes("balanced");
  const branches = rootChildren.map(({ child }, index) =>
    branchFor(child, balanced && index % 2 ? "left" : "right"),
  );
  const branchHeight = (side: Branch) =>
    rootChildren.reduce(
      (height, { child }, index) =>
        branches[index] === side
          ? height + subtreeHeight(child) + NODE_GAP_Y
          : height,
      -NODE_GAP_Y,
    );
  const leftHeight = Math.max(0, branchHeight("left"));
  const rightHeight = Math.max(0, branchHeight("right"));
  const totalHeight = Math.max(
    dimensions(root).height,
    leftHeight,
    rightHeight,
  ) + BOARD_PADDING * 2;
  const positions: PositionedTopic[] = [];
  const rootSize = measure(root);
  const rootY = totalHeight / 2;
  positions.push({
    node: root,
    depth: 0,
    x: 0,
    y: rootY,
    width: rootSize.width,
    height: rootSize.height,
    branch: "right",
  });

  function placeBranch(
    entry: { child: Topic; bucket: string; index: number },
    side: Branch,
    depth: number,
    start: number,
    parentX: number,
    parentWidth: number,
  ) {
    const size = measure(entry.child);
    const height = subtreeHeight(entry.child);
    const y = start + height / 2;
    const direction = side === "right" ? 1 : -1;
    const x = parentX + direction * (parentWidth / 2 + NODE_GAP_X + size.width / 2);
    positions.push({
      node: entry.child,
      parent: undefined,
      bucket: entry.bucket,
      index: entry.index,
      depth,
      x,
      y,
      width: size.width,
      height: size.height,
      branch: side,
    });
    let cursor = start;
    for (const child of graphChildren(entry.child)) {
      const childSide = side;
      placeBranch(child, childSide, depth + 1, cursor, x, size.width);
      cursor += subtreeHeight(child.child) + NODE_GAP_Y;
    }
  }

  for (const side of ["left", "right"] as const) {
    let cursor = rootY - branchHeight(side) / 2;
    rootChildren.forEach((entry, index) => {
      if (branches[index] !== side) return;
      placeBranch(entry, side, 1, cursor, 0, rootSize.width);
      cursor += subtreeHeight(entry.child) + NODE_GAP_Y;
    });
  }
  const minX = Math.min(...positions.map((position) => position.x - position.width / 2));
  const maxX = Math.max(...positions.map((position) => position.x + position.width / 2));
  const minY = Math.min(...positions.map((position) => position.y - position.height / 2));
  const maxY = Math.max(...positions.map((position) => position.y + position.height / 2));
  const contentWidth = maxX - minX + BOARD_PADDING * 2;
  const contentHeight = maxY - minY + BOARD_PADDING * 2;
  const width = Math.max(1200, contentWidth);
  const height = Math.max(720, totalHeight, contentHeight);
  const shiftX = BOARD_PADDING + (width - contentWidth) / 2 - minX;
  const shiftY = BOARD_PADDING + (height - contentHeight) / 2 - minY;
  const byId = new Map<string, PositionedTopic>();
  for (const position of positions) {
    position.x += shiftX;
    position.y += shiftY;
    byId.set(position.node.id, position);
  }
  return {
    width,
    height,
    nodes: positions,
    byId,
  };
}

function nodePath(from: PositionedTopic, to: PositionedTopic) {
  const fromX = from.x + (to.x >= from.x ? from.width / 2 : -from.width / 2);
  const toX = to.x + (to.x >= from.x ? -to.width / 2 : to.width / 2);
  const bend = Math.max(34, Math.abs(toX - fromX) * 0.42);
  return `M ${fromX} ${from.y} C ${fromX + (to.x >= from.x ? bend : -bend)} ${from.y}, ${toX - (to.x >= from.x ? bend : -bend)} ${to.y}, ${toX} ${to.y}`;
}

function topicPath(root: Topic) {
  const output: TopicEntry[] = [{ node: root, depth: 0 }];
  output.push(...childEntries(root, 1));
  return output;
}

function removeTopic(root: Topic, id: string): Topic | undefined {
  for (const [bucket, children] of Object.entries(root.children ?? {})) {
    const index = children.findIndex((child) => child.id === id);
    if (index >= 0) {
      const [removed] = children.splice(index, 1);
      if (!children.length) delete root.children?.[bucket];
      return removed;
    }
    for (const child of children) {
      const removed = removeTopic(child, id);
      if (removed) return removed;
    }
  }
  return undefined;
}

type MapAction = "child" | "sibling" | "parent" | "up" | "down" | "delete";
type ContextMenu = { x: number; y: number; nodeId?: string };
type EditPopover = {
  id: string;
  x: number;
  y: number;
  value: string;
};
type InlineTitleEditor = {
  id: string;
  value: string;
};

function MapCanvas({
  sheet,
  selected,
  select,
  action,
  editTopic,
}: {
  sheet: Sheet;
  selected: string;
  select: (id: string) => void;
  action: (action: MapAction, id: string) => void;
  editTopic: (id: string, fn: (topic: Topic) => void) => void;
}) {
  const layout = useMemo(() => makeLayout(sheet), [sheet]);
  const [zoom, setZoom] = useState(1);
  const [pan, setPan] = useState({ x: 0, y: 0 });
  const [contextMenu, setContextMenu] = useState<ContextMenu>();
  const canvas = useRef<SVGSVGElement>(null);
  const stage = useRef<HTMLElement>(null);
  const canvasDrag = useRef<
    { x: number; y: number; panX: number; panY: number } | undefined
  >(undefined);
  const editorField = useRef<HTMLTextAreaElement>(null);
  const [editor, setEditor] = useState<EditPopover>();
  const [inlineTitle, setInlineTitle] = useState<InlineTitleEditor>();
  const root = sheet.rootTopic;
  const entries = topicPath(root);
  const relationships = sheet.relationships ?? [];
  const nodes = layout.nodes;
  const byId = layout.byId;

  function openContextMenu(e: React.MouseEvent, nodeId?: string) {
    e.preventDefault();
    e.stopPropagation();
    finishInlineTitle(true);
    if (editor) finishEditor(true);
    if (nodeId) select(nodeId);
    const rect = stage.current?.getBoundingClientRect();
    if (!rect) return;
    setContextMenu({
      nodeId,
      x: Math.max(8, e.clientX - rect.left),
      y: Math.max(8, e.clientY - rect.top),
    });
  }
  function closeContextMenu() {
    setContextMenu(undefined);
  }
  function pointerDown(e: React.PointerEvent<SVGSVGElement>) {
    if ((e.target as Element).closest(".mindmap-node")) return;
    if (e.button !== 0) return;
    closeContextMenu();
    canvasDrag.current = { x: e.clientX, y: e.clientY, panX: pan.x, panY: pan.y };
    e.currentTarget.setPointerCapture(e.pointerId);
  }
  function pointerMove(e: React.PointerEvent<SVGSVGElement>) {
    if (!canvasDrag.current) return;
    setPan({
      x: canvasDrag.current.panX + e.clientX - canvasDrag.current.x,
      y: canvasDrag.current.panY + e.clientY - canvasDrag.current.y,
    });
  }
  function pointerUp(e: React.PointerEvent<SVGSVGElement>) {
    canvasDrag.current = undefined;
    if (canvas.current?.hasPointerCapture(e.pointerId))
      canvas.current.releasePointerCapture(e.pointerId);
  }
  function wheel(e: React.WheelEvent<SVGSVGElement>) {
    e.preventDefault();
    setZoom((value) =>
      Math.max(0.45, Math.min(2, value + (e.deltaY < 0 ? 0.1 : -0.1))),
    );
  }
  function openEditor(id: string, anchor: { x: number; y: number }) {
    const current = entries.find((entry) => entry.node.id === id)?.node;
    if (!current) return;
    setEditor({
      id,
      x: anchor.x,
      y: anchor.y,
      value: current.notes?.plain?.content ?? "",
    });
    requestAnimationFrame(() => editorField.current?.focus());
  }
  function finishEditor(save: boolean) {
    const draft = editor;
    if (!draft) return;
    if (save) {
      editTopic(draft.id, (current) => setTopicNote(current, draft.value));
    }
    setEditor(undefined);
  }
  function startInlineTitle(id: string) {
    finishEditor(true);
    finishInlineTitle(true);
    const current = entries.find((entry) => entry.node.id === id)?.node;
    if (!current) return;
    select(id);
    closeContextMenu();
    setInlineTitle({ id, value: current.title ?? "" });
  }
  function finishInlineTitle(save: boolean) {
    const draft = inlineTitle;
    if (!draft) return;
    if (save) editTopic(draft.id, (current) => { current.title = draft.value; });
    setInlineTitle(undefined);
  }
  function keyDown(e: React.KeyboardEvent<HTMLElement>) {
    if (e.target instanceof HTMLInputElement || e.target instanceof HTMLTextAreaElement || e.target instanceof HTMLSelectElement)
      return;
    if (!selected) return;
    if (e.key === "Tab") {
      e.preventDefault();
      action("child", selected);
    } else if (e.key === "Enter") {
      e.preventDefault();
      action("sibling", selected);
    } else if (e.key === "Delete" || e.key === "Backspace") {
      e.preventDefault();
      action("delete", selected);
    } else if (e.key === "F2") {
      e.preventDefault();
      startInlineTitle(selected);
    }
  }
  function stageClick(e: React.MouseEvent<HTMLElement>) {
    closeContextMenu();
    finishInlineTitle(true);
    if (editor && !(e.target as Element).closest(".mindmap-edit-popover"))
      finishEditor(true);
  }
  const contextEntry = contextMenu?.nodeId
    ? entries.find((entry) => entry.node.id === contextMenu.nodeId)
    : undefined;
  const contextSiblings =
    contextEntry?.parent && contextEntry.bucket
      ? contextEntry.parent.children?.[contextEntry.bucket] ?? []
      : [];
  const canMoveUp = contextEntry?.index !== undefined && contextEntry.index > 0;
  const canMoveDown =
    contextEntry?.index !== undefined && contextEntry.index < contextSiblings.length - 1;
  return (
    <section
      ref={stage}
      className="mindmap-stage"
      aria-label="XMind 脑图画布"
      tabIndex={0}
      onKeyDown={keyDown}
      onClick={stageClick}
    >
      <svg
        ref={canvas}
        className="mindmap-canvas"
        role="img"
        aria-label={`${sheet.title || root.title || "未命名"}脑图`}
        viewBox={`0 0 ${layout.width} ${layout.height}`}
        onPointerDown={pointerDown}
        onPointerMove={pointerMove}
        onPointerUp={pointerUp}
        onPointerCancel={pointerUp}
        onWheel={wheel}
        onContextMenu={(e) => openContextMenu(e)}
      >
        <g transform={`translate(${pan.x} ${pan.y}) scale(${zoom})`}>
          <g className="mindmap-edges" aria-hidden="true">
            {entries.slice(1).map((entry) => {
              const child = byId.get(entry.node.id);
              const parent = entry.parent && byId.get(entry.parent.id);
              return child && parent && entry.bucket !== "detached" && entry.bucket !== "summary" ? (
                <path key={entry.node.id} d={nodePath(parent, child)} />
              ) : null;
            })}
          </g>
          <g className="mindmap-relationships" aria-hidden="true">
            {relationships.map((relationship) => {
              const from = byId.get(relationship.end1Id);
              const to = byId.get(relationship.end2Id);
              if (!from || !to) return null;
              const middleX = (from.x + to.x) / 2;
              const middleY = (from.y + to.y) / 2;
              return (
                <g key={relationship.id}>
                  <path d={nodePath(from, to)} />
                  {relationship.title && (
                    <text x={middleX} y={middleY - 8} textAnchor="middle">
                      {relationship.title}
                    </text>
                  )}
                </g>
              );
            })}
          </g>
          {nodes.map((position) => {
            const active = position.node.id === selected;
            const fill = topicColor(position.node) || (position.node.id === root.id ? "#314e85" : "#edf2fa");
            const text = nodeTextLayout(position.node);
            const lines = text.titleLines;
            const notes = text.noteLines;
            const white = position.node.id === root.id && !topicColor(position.node);
            return (
              <g
                key={position.node.id}
                className="mindmap-node"
                role="button"
                tabIndex={0}
                aria-label="主题节点"
                aria-pressed={active}
                transform={`translate(${position.x - position.width / 2} ${position.y - position.height / 2})`}
                onClick={() => select(position.node.id)}
                onDoubleClick={() => startInlineTitle(position.node.id)}
                onContextMenu={(e) => openContextMenu(e, position.node.id)}
                onKeyDown={(e) => {
                  if (e.key === "Enter" || e.key === " ") {
                    e.preventDefault();
                    select(position.node.id);
                  }
                }}
              >
                <rect
                  width={position.width}
                  height={position.height}
                  rx="12"
                  fill={fill}
                  className={active ? "selected" : ""}
                />
                {inlineTitle?.id === position.node.id ? (
                  <foreignObject
                    className="mindmap-node-editor-foreign"
                    x={4}
                    y={4}
                    width={position.width - 8}
                    height={Math.max(22, lines.length * 19)}
                    onPointerDown={(e) => e.stopPropagation()}
                    onClick={(e) => e.stopPropagation()}
                  >
                    <input
                      className="mindmap-node-inline-editor"
                      aria-label="主题标题"
                      value={inlineTitle.value}
                      autoFocus
                      onChange={(e) => setInlineTitle((current) => current ? { ...current, value: e.target.value } : current)}
                      onBlur={() => finishInlineTitle(true)}
                      onKeyDown={(e) => {
                        e.stopPropagation();
                        if (e.key === "Enter") {
                          e.preventDefault();
                          finishInlineTitle(true);
                        } else if (e.key === "Escape") {
                          e.preventDefault();
                          finishInlineTitle(false);
                        }
                      }}
                    />
                  </foreignObject>
                ) : (
                  <text className="mindmap-node-title" x={position.width / 2} y={24} textAnchor="middle" fill={white ? "#fff" : "#252c39"}>
                    {lines.map((line, index) => (
                      <tspan key={index} x={position.width / 2} dy={index ? 19 : 0}>
                        {line}
                      </tspan>
                    ))}
                  </text>
                )}
                {notes.length > 0 && (
                  <text
                    className="mindmap-node-note"
                    x={position.width / 2}
                    y={24 + lines.length * 19 + 4}
                    textAnchor="middle"
                    fill={white ? "#dbe7ff" : "#6d7787"}
                  >
                    {notes.map((line, index) => (
                      <tspan key={index} x={position.width / 2} dy={index ? 13 : 0}>
                        {line}
                      </tspan>
                    ))}
                  </text>
                )}
              </g>
            );
          })}
          {entries.flatMap((entry) =>
            (entry.node.summaries ?? []).map((summary) => {
              const summaryNode = byId.get(summary.topicId);
              if (!summaryNode) return null;
              return (
                <path
                  key={`summary-${summary.id}`}
                  className="mindmap-summary"
                  d={`M ${summaryNode.x - summaryNode.width / 2} ${summaryNode.y - summaryNode.height / 2 - 8} q -18 12 0 24`}
                  aria-label={`概要 ${summary.range}`}
                />
              );
            }),
          )}
        </g>
      </svg>
      {editor && (
        <div
          className="mindmap-edit-popover"
          style={{ left: editor.x, top: editor.y }}
          onPointerDown={(e) => e.stopPropagation()}
          onClick={(e) => e.stopPropagation()}
        >
          <label>
            主题备注
            <textarea
              ref={editorField}
              aria-label="主题备注"
              value={editor.value}
              autoFocus
              rows={3}
              placeholder="输入备注"
              onChange={(e) => setEditor((current) => current ? { ...current, value: e.target.value } : current)}
              onKeyDown={(e) => {
                e.stopPropagation();
                if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) {
                  e.preventDefault();
                  finishEditor(true);
                } else if (e.key === "Escape") {
                  e.preventDefault();
                  finishEditor(false);
                }
              }}
            />
          </label>
          <div className="mindmap-edit-popover-actions">
            <button onClick={() => finishEditor(false)}>取消</button>
            <button className="primary" onClick={() => finishEditor(true)}>确定</button>
          </div>
        </div>
      )}
      {contextMenu && (
        <div
          className="mindmap-context-menu"
          style={{ left: contextMenu.x, top: contextMenu.y }}
          role="menu"
          onClick={(e) => e.stopPropagation()}
        >
          {contextMenu.nodeId ? (
            <>
              <button
                role="menuitem"
                disabled={!contextEntry?.parent}
                onClick={() => {
                  action("delete", contextMenu.nodeId!);
                  closeContextMenu();
                }}
              >
                <span>删除</span>
                <kbd aria-hidden="true">Delete</kbd>
              </button>
              <button
                role="menuitem"
                onClick={() => {
                  action("child", contextMenu.nodeId!);
                  closeContextMenu();
                }}
              >
                <span>插入下级主题</span>
                <kbd aria-hidden="true">Tab</kbd>
              </button>
              <button
                role="menuitem"
                disabled={!contextEntry?.parent}
                onClick={() => {
                  action("sibling", contextMenu.nodeId!);
                  closeContextMenu();
                }}
              >
                <span>插入同级主题</span>
                <kbd aria-hidden="true">Enter</kbd>
              </button>
              <button
                role="menuitem"
                disabled={!contextEntry?.parent}
                onClick={() => {
                  action("parent", contextMenu.nodeId!);
                  closeContextMenu();
                }}
              >
                插入上级主题
              </button>
              <button
                role="menuitem"
                disabled={!canMoveUp}
                onClick={() => {
                  action("up", contextMenu.nodeId!);
                  closeContextMenu();
                }}
              >
                上移节点
              </button>
              <button
                role="menuitem"
                disabled={!canMoveDown}
                onClick={() => {
                  action("down", contextMenu.nodeId!);
                  closeContextMenu();
                }}
              >
                下移节点
              </button>
              <div className="mindmap-context-menu-separator" />
              <button
                role="menuitem"
                onClick={() => {
                  openEditor(contextMenu.nodeId!, {
                    x: contextMenu.x,
                    y: contextMenu.y,
                  });
                  closeContextMenu();
                }}
              >
                备注
              </button>
            </>
          ) : (
            <button role="menuitem" onClick={() => { setZoom(1); setPan({ x: 0, y: 0 }); closeContextMenu(); }}>
              适应画布
            </button>
          )}
        </div>
      )}
    </section>
  );
}

export function MapEditor({
  book,
  index,
  edit,
}: {
  book: Workbook;
  index: number;
  switchSheet?: (i: number) => void;
  edit: (book: Workbook) => void;
}) {
  const [selected, select] = useState("");
  const sheet = book.sheets[index];
  const entries = topicPath(sheet.rootTopic);
  const node = entries.find((entry) => entry.node.id === selected)?.node || sheet.rootTopic;

  function updateSheet(fn: (next: Sheet) => void) {
    const next = structuredClone(sheet);
    fn(next);
    topics(next.rootTopic);
    edit({
      ...book,
      sheets: book.sheets.map((old, sheetIndex) =>
        sheetIndex === index ? next : old,
      ),
    });
  }
  function change(fn: (topic: Topic, next: Sheet) => void, id = node.id) {
    updateSheet((next) => {
      const selectedTopic = topics(next.rootTopic).find((item) => item.id === id);
      if (selectedTopic) fn(selectedTopic, next);
    });
  }
  function addChild(id = node.id) {
    const child = topic("新主题");
    change((current) => {
      ((current.children ??= {}).attached ??= []).push(child);
    }, id);
    select(child.id);
  }
  function addSibling(id = node.id) {
    const entry = entries.find((item) => item.node.id === id);
    if (!entry?.parent || entry.bucket === undefined || entry.index === undefined) return;
    const sibling = topic("新主题");
    updateSheet((next) => {
      const parent = topics(next.rootTopic).find((item) => item.id === entry.parent!.id);
      const siblings = parent?.children?.[entry.bucket!];
      siblings?.splice(entry.index! + 1, 0, sibling);
    });
    select(sibling.id);
  }
  function addParent(id = node.id) {
    const entry = entries.find((item) => item.node.id === id);
    if (!entry?.parent || entry.bucket === undefined || entry.index === undefined) return;
    const parentId = entry.parent.id;
    const parentTopic = topic("新主题");
    updateSheet((next) => {
      const parent = topics(next.rootTopic).find((item) => item.id === parentId);
      const siblings = parent?.children?.[entry.bucket!];
      if (!siblings) return;
      const currentIndex = siblings.findIndex((item) => item.id === id);
      if (currentIndex < 0) return;
      const [current] = siblings.splice(currentIndex, 1);
      parentTopic.children = { attached: [current] };
      siblings.splice(currentIndex, 0, parentTopic);
    });
    select(parentTopic.id);
  }
  function moveSibling(id: string, direction: -1 | 1) {
    const entry = entries.find((item) => item.node.id === id);
    if (!entry?.parent || entry.bucket === undefined || entry.index === undefined) return;
    const parentId = entry.parent.id;
    updateSheet((next) => {
      const parent = topics(next.rootTopic).find((item) => item.id === parentId);
      const siblings = parent?.children?.[entry.bucket!];
      if (!siblings) return;
      const currentIndex = siblings.findIndex((item) => item.id === id);
      const targetIndex = currentIndex + direction;
      if (currentIndex < 0 || targetIndex < 0 || targetIndex >= siblings.length) return;
      [siblings[currentIndex], siblings[targetIndex]] = [
        siblings[targetIndex],
        siblings[currentIndex],
      ];
    });
    select(id);
  }
  function deleteSelected(id = node.id) {
    const entry = entries.find((item) => item.node.id === id);
    if (!entry?.parent) return;
    const parentId = entry.parent.id;
    updateSheet((next) => {
      removeTopic(next.rootTopic, id);
      next.relationships = next.relationships?.filter(
        (relationship) => relationship.end1Id !== id && relationship.end2Id !== id,
      );
    });
    select(parentId);
  }
  function perform(action: MapAction, id: string) {
    select(id);
    if (action === "child") addChild(id);
    else if (action === "sibling") addSibling(id);
    else if (action === "parent") addParent(id);
    else if (action === "up") moveSibling(id, -1);
    else if (action === "down") moveSibling(id, 1);
    else if (action === "delete") deleteSelected(id);
  }
  return (
    <div className="mindmap-editor">
      <div className="mindmap-shell">
        <div className="mindmap-canvas-pane">
          <MapCanvas
            sheet={sheet}
            selected={node.id}
            select={(id) => {
              select(id);
            }}
            action={perform}
            editTopic={(id, fn) => change(fn, id)}
          />
        </div>
      </div>
    </div>
  );
}
