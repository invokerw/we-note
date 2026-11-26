import { useLayoutEffect, useRef, useState } from "react";
import MindElixir from "mind-elixir";

export type Topic = MindElixir["currentNodes"][number];
export type MindMenuTarget = { x: number; y: number; node: Topic | null };
export type Detail = "备注" | "标签" | "移动到" | "关系箭头" | "双向箭头";
export type FileActions = { exportFile?: () => void };

type MenuProps = FileActions & {
  mind: MindElixir;
  target: MindMenuTarget;
  close: () => void;
  details: (node: Topic, kind: Detail) => void;
  change: (source: string) => void;
};

export function MindMenu({
  mind,
  target,
  close,
  details,
  exportFile,
  change,
}: MenuProps) {
  const ref = useRef<HTMLDivElement>(null);
  useLayoutEffect(() => {
    const el = ref.current!;
    el.showPopover();
    function place() {
      const box = el.getBoundingClientRect();
      el.style.left = `${Math.max(4, Math.min(target.x, innerWidth - box.width - 4))}px`;
      el.style.top = `${Math.max(4, Math.min(target.y, innerHeight - box.height - 4))}px`;
    }
    place();
    el.querySelector("button")?.focus({ preventScroll: true });
    const observer = new ResizeObserver(place);
    observer.observe(el);
    window.addEventListener("resize", place);
    return () => {
      observer.disconnect();
      window.removeEventListener("resize", place);
    };
  }, [target]);
  function item(label: string, run: () => void, disabled = false) {
    return (
      <button
        key={label}
        role="menuitem"
        disabled={disabled}
        onClick={() => {
          ref.current?.hidePopover();
          close();
          run();
        }}
      >
        {label}
      </button>
    );
  }
  const { node } = target;
  const root = !node?.nodeObj.parent;
  return (
    <div
      role="menu"
      aria-label={node ? "节点操作" : "导图操作"}
      popover="auto"
      ref={ref}
      className="entry-menu mind-menu"
      onToggle={(e) => {
        if (e.newState === "closed") close();
      }}
      onKeyDown={(e) => {
        if (e.key !== "ArrowUp" && e.key !== "ArrowDown") return;
        e.preventDefault();
        const items = Array.from(
          e.currentTarget.querySelectorAll<HTMLElement>(
            "button:not(:disabled), summary",
          ),
        ).filter((el) => el.getClientRects().length);
        const index = items.indexOf(document.activeElement as HTMLElement);
        items[
          (index + (e.key === "ArrowDown" ? 1 : -1) + items.length) %
            items.length
        ]?.focus();
      }}
    >
      {node && (
        <>
          {item("改名", () => mind.beginEdit(node))}
          {item("子主题", () => mind.addChild(node))}
          {item("同级主题", () => mind.insertSibling("after", node), root)}
          {(["备注", "标签", "移动到", "关系箭头"] as const).map((kind) =>
            item(kind, () => details(node, kind), kind === "移动到" && root),
          )}
          {item("摘要", () => mind.createSummary())}
          {item("删除主题", () => mind.removeNodes(mind.currentNodes), root)}
          <details>
            <summary>更多节点操作</summary>
            {item("插入父节点", () => mind.insertParent(node), root)}
            {item("上移节点", () => mind.moveUpNode(node), root)}
            {item("下移节点", () => mind.moveDownNode(node), root)}
            {item("双向箭头", () => details(node, "双向箭头"))}
            {item("聚焦节点", () => mind.focusNode(node), root)}
            {item("取消聚焦", () => mind.cancelFocus())}
          </details>
          <hr />
        </>
      )}
      {exportFile && item("导出当前文件", exportFile)}
      {!node && (
        <>
          <hr />
          {item("撤销", () => mind.undo())}
          {item("重做", () => mind.redo())}
          {item("适应画布", () => mind.scaleFit())}
          {item("切换布局", () =>
            mind.direction === 2 ? mind.initRight() : mind.initSide(),
          )}
          {item("切换导图主题", () => {
            mind.changeTheme(
              mind.theme.name === MindElixir.DARK_THEME.name
                ? MindElixir.THEME
                : MindElixir.DARK_THEME,
            );
            change(mind.getDataString());
          })}
        </>
      )}
    </div>
  );
}

export function MindDetailDialog({
  mind,
  node,
  kind,
  close,
}: {
  mind: MindElixir;
  node: Topic;
  kind: Detail;
  close: () => void;
}) {
  const ref = useRef<HTMLDialogElement>(null);
  const [value, setValue] = useState(() =>
    kind === "备注"
      ? node.nodeObj.note || ""
      : kind === "标签"
        ? (node.nodeObj.tags || [])
            .map((t) => (typeof t === "string" ? t : t.text))
            .join("，")
        : "",
  );
  const [error, setError] = useState("");
  useLayoutEffect(() => {
    const dialog = ref.current!;
    dialog.showModal();
    return () => dialog.close();
  }, []);
  const pickTarget = kind !== "备注" && kind !== "标签";
  const targets: { id: string; topic: string }[] = [];
  function visit(item: MindElixir["nodeData"]) {
    if (item.id === node.nodeObj.id && kind === "移动到") return;
    if (item.id !== node.nodeObj.id) targets.push(item);
    item.children?.forEach(visit);
  }
  if (pickTarget) visit(mind.nodeData);
  async function submit() {
    try {
      if (kind === "备注") await mind.reshapeNode(node, { note: value });
      else if (kind === "标签")
        await mind.reshapeNode(node, {
          tags: value
            .split(/[,，]/)
            .map((x) => x.trim())
            .filter(Boolean),
        });
      else {
        const target = mind.findEle(value);
        if (!target) {
          setError("请展开目标分支后重试");
          return;
        }
        if (kind === "移动到") await mind.moveNodesIn([node], target);
        else
          mind.createArrow(node, target, {
            bidirectional: kind === "双向箭头",
          });
      }
      close();
    } catch (err) {
      setError(String(err));
    }
  }
  return (
    <dialog
      ref={ref}
      className="entry-dialog"
      aria-label={kind}
      onCancel={close}
    >
      <form
        onSubmit={(e) => {
          e.preventDefault();
          void submit();
        }}
      >
        <label>
          {kind}
          {pickTarget ? (
            <select
              autoFocus
              required
              value={value}
              onChange={(e) => setValue(e.target.value)}
            >
              <option value="">选择主题</option>
              {targets.map((t) => (
                <option key={t.id} value={t.id}>
                  {t.topic}
                </option>
              ))}
            </select>
          ) : (
            <input
              autoFocus
              value={value}
              onChange={(e) => setValue(e.target.value)}
            />
          )}
        </label>
        {error && <p role="alert">{error}</p>}
        <footer>
          <button type="button" onClick={close}>
            取消
          </button>
          <button className="primary">确定</button>
        </footer>
      </form>
    </dialog>
  );
}
