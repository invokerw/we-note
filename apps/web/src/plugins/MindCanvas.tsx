import { useEffect, useRef, useState } from "react";
import MindElixir from "mind-elixir";
import { zh_CN } from "mind-elixir/i18n";
import "mind-elixir/style";
import { readMindMap } from "./mindFile";

type Props = {
  source: string;
  change?: (source: string) => void;
  select?: (id: string) => void;
};
export default function MindCanvas({ source, change, select }: Props) {
  const host = useRef<HTMLDivElement>(null);
  const canvas = useRef<MindElixir | null>(null);
  const callbacks = useRef({ change, select });
  callbacks.current = { change, select };
  const [error, report] = useState("");
  const [selected, setSelected] = useState("");
  const [ready, setReady] = useState(false);
  const [action, setAction] = useState("");
  const [value, setValue] = useState("");
  const editable = !!change;
  useEffect(() => {
    let active = true;
    let instance: MindElixir | undefined;
    report("");
    setReady(false);
    setSelected("");
    setAction("");
    const mount = document.createElement("div");
    mount.className = "mind-host";
    host.current!.replaceChildren(mount);
    async function open() {
      const data = readMindMap(source);
      const mind = new MindElixir({
        el: mount,
        alignment: "nodes",
        editable,
        keypress: editable,
        contextMenu: editable && { locale: zh_CN },
        toolBar: true,
        allowUndo: editable,
        newTopicName: "新主题",
      });
      instance = mind;
      const failure = await mind.init(data);
      if (!active) return;
      if (failure) throw failure;
      if (mount.clientWidth < 640) mind.scaleFit();
      canvas.current = mind;
      setReady(true);
      if (callbacks.current.select) {
        for (const el of mount.querySelectorAll<HTMLElement>(
          ".me-tpc[data-nodeid]",
        )) {
          el.tabIndex = 0;
          el.setAttribute("role", "button");
          el.onkeydown = (e) => {
            if (e.key === "Enter" || e.key === " ") {
              e.preventDefault();
              callbacks.current.select?.(el.dataset.nodeid!.slice(2));
            }
          };
        }
      }
      // Initialization can supply default themes and layout to a minimal file.
      const initial = mind.getDataString();
      const update = () => {
        if (!active || !editable) return;
        const next = mind.getDataString();
        callbacks.current.change?.(next === initial ? source : next);
      };
      mind.bus.addListener("operation", update);
      mind.bus.addListener("refresh", update);
      mind.bus.addListener("changeDirection", update);
      mind.bus.addListener("linkDiv", update);
      mind.bus.addListener("selectNodes", (nodes) => {
        const id = nodes[0]?.id || "";
        setSelected(id);
        if (id) callbacks.current.select?.(id);
      });
      mind.bus.addListener("unselectNodes", () =>
        setSelected(mind.currentNode?.nodeObj.id || ""),
      );
    }
    const opened = open().catch((e) => {
      if (active) report(String(e));
    });
    return () => {
      active = false;
      canvas.current = null;
      void opened.then(() => instance?.destroy());
    };
  }, [source, editable]);
  const mind = canvas.current;
  const node =
    selected && mind?.currentNodes.find((item) => item.nodeObj.id === selected);
  function details(kind: string) {
    if (!node) return;
    setAction(kind);
    setValue(
      kind === "备注"
        ? node.nodeObj.note || ""
        : kind === "标签"
          ? (node.nodeObj.tags || [])
              .map((t) => (typeof t === "string" ? t : t.text))
              .join("，")
          : "",
    );
  }
  function destinations() {
    const targets: { id: string; title: string }[] = [];
    function visit(item: NonNullable<typeof mind>["nodeData"]) {
      if (item.id === selected && action === "移动到") return;
      if (item.id !== selected)
        targets.push({ id: item.id, title: item.topic });
      item.children?.forEach(visit);
    }
    if (mind) visit(mind.nodeData);
    return targets;
  }
  function commit() {
    if (!node || !mind) return;
    if (action === "移动到" || action === "关系箭头") {
      let target;
      try {
        target = value && mind.findEle(value);
      } catch {
        report("请展开目标分支后重试");
        return;
      }
      if (!target) return;
      if (action === "移动到") void mind.moveNodesIn([node], target);
      else mind.createArrow(node, target);
    } else
      void mind.reshapeNode(
        node,
        action === "备注"
          ? { note: value }
          : {
              tags: value
                .split(/[,，]/)
                .map((x) => x.trim())
                .filter(Boolean),
            },
      );
    setAction("");
  }
  return (
    <section
      className="native-mind"
      aria-label={editable ? "思维导图画布" : "导图预览"}
    >
      {editable && (
        <div className="toolbar mind-actions">
          <button
            disabled={!node}
            onClick={() => node && mind?.editTopic(node)}
          >
            改名
          </button>
          <button
            disabled={!node}
            onClick={() => node && void mind?.addChild(node)}
          >
            子主题
          </button>
          <button
            disabled={!node || !node.nodeObj.parent}
            onClick={() => node && void mind?.insertSibling("after", node)}
          >
            同级主题
          </button>
          {["备注", "标签", "移动到", "关系箭头"].map((k) => (
            <button
              key={k}
              disabled={!node || (k === "移动到" && !node.nodeObj.parent)}
              onClick={() => details(k)}
            >
              {k}
            </button>
          ))}
          <button disabled={!node} onClick={() => mind?.createSummary()}>
            摘要
          </button>
          <button disabled={!ready} onClick={() => mind?.scaleFit()}>适应画布</button>
          <button disabled={!ready} onClick={() => mind?.undo()}>
            撤销
          </button>
          <button disabled={!ready} onClick={() => mind?.redo()}>
            重做
          </button>
          <button
            disabled={!ready}
            onClick={() => {
              if (mind?.direction === 2) mind.initRight();
              else mind?.initSide();
            }}
          >
            切换布局
          </button>
          <button
            disabled={!node || !node.nodeObj.parent}
            onClick={() => node && void mind?.removeNodes([node])}
          >
            删除主题
          </button>
          <button
            disabled={!ready}
            onClick={() => {
              if (mind) {
                mind.changeTheme(
                  mind.theme.name === MindElixir.DARK_THEME.name
                    ? MindElixir.THEME
                    : MindElixir.DARK_THEME,
                );
                callbacks.current.change?.(mind.getDataString());
              }
            }}
          >
            切换导图主题
          </button>
        </div>
      )}
      {action && node && mind && (
        <form
          onSubmit={(e) => {
            e.preventDefault();
            commit();
          }}
        >
          <label>
            {action}
            {action === "移动到" || action === "关系箭头" ? (
              <select aria-label={action} value={value} onChange={(e) => setValue(e.target.value)}>
                <option value="">选择主题</option>
                {destinations().map((item) => (
                  <option key={item.id} value={item.id}>
                    {item.title}
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
          <button>确定</button>
          <button type="button" onClick={() => setAction("")}>
            取消
          </button>
        </form>
      )}
      {error && <p role="alert">{error}</p>}
      <div ref={host} />
    </section>
  );
}
