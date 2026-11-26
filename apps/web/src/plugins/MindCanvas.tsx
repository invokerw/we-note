import { useEffect, useRef, useState } from "react";
import MindElixir from "mind-elixir";
import {
  MindMenu,
  MindDetailDialog,
  type Detail,
  type FileActions,
  type MindMenuTarget,
  type Topic,
} from "./MindMenu";
import "mind-elixir/style";
import { readMindMap } from "./mindFile";

type Props = FileActions & {
  source: string;
  change?: (source: string) => void;
  select?: (id: string) => void;
};
export default function MindCanvas({
  source,
  change,
  select,
  exportFile,
}: Props) {
  const host = useRef<HTMLDivElement>(null);
  const canvas = useRef<MindElixir | null>(null);
  const callbacks = useRef({ change, select });
  callbacks.current = { change, select };
  const [error, report] = useState("");
  const [menu, setMenu] = useState<MindMenuTarget | null>(null);
  const [detail, setDetail] = useState<{ node: Topic; kind: Detail } | null>(
    null,
  );
  const touch = useRef<{
    x: number;
    y: number;
    target: EventTarget;
    start: number;
  } | null>(null);
  function openMenu(
    mind: MindElixir,
    target: EventTarget | null,
    x: number,
    y: number,
  ) {
    if (
      !(target instanceof Element) ||
      target.closest("#input-box, button, .mind-elixir-toolbar")
    )
      return;
    const node = target.closest<Topic>(".me-tpc");
    if (node && !mind.currentNodes.includes(node)) mind.selectNode(node);
    setMenu({ node, x, y });
  }
  const editable = !!change;
  useEffect(() => {
    let active = true;
    let instance: MindElixir | undefined;
    report("");
    setMenu(null);
    setDetail(null);
    const mount = document.createElement("div");
    mount.className = "mind-host";
    host.current!.replaceChildren(mount);
    async function open() {
      const data = readMindMap(source);
      const mind = new MindElixir({
        el: mount,
        theme: MindElixir.THEME,
        alignment: "nodes",
        editable,
        keypress: editable,
        contextMenu: false,
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
      if (editable)
        mind.bus.addListener("showContextMenu", (e) => {
          if (active) openMenu(mind, e.target, e.clientX, e.clientY);
        });
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
        if (id) callbacks.current.select?.(id);
      });
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
  return (
    <section
      className="native-mind"
      aria-label={editable ? "思维导图画布" : "导图预览"}
    >
      {error && (
        <div role="alert">
          {error}{" "}
          {exportFile && <button onClick={exportFile}>导出当前文件</button>}
        </div>
      )}
      <div
        ref={host}
        className="mind-surface"
        onKeyDownCapture={(e) => {
          if (
            !editable ||
            !canvas.current ||
            !(e.key === "ContextMenu" || (e.shiftKey && e.key === "F10"))
          )
            return;
          e.preventDefault();
          e.stopPropagation();
          const target = canvas.current.currentNode || e.currentTarget;
          const box = target.getBoundingClientRect();
          openMenu(
            canvas.current,
            target,
            box.left + box.width / 2,
            box.top + box.height / 2,
          );
        }}
        onTouchStart={(e) => {
          if (!editable) return;
          const point = e.touches[0];
          touch.current =
            e.touches.length === 1
              ? {
                  x: point.clientX,
                  y: point.clientY,
                  target: e.target,
                  start: e.timeStamp,
                }
              : null;
        }}
        onTouchMove={(e) => {
          const start = touch.current,
            point = e.touches[0];
          if (
            start &&
            Math.hypot(point.clientX - start.x, point.clientY - start.y) > 8
          )
            touch.current = null;
        }}
        onTouchCancel={() => {
          touch.current = null;
        }}
        onTouchEnd={(e) => {
          const start = touch.current;
          touch.current = null;
          if (start && canvas.current && e.timeStamp - start.start >= 450) {
            openMenu(canvas.current, start.target, start.x, start.y);
          }
        }}
      />
      {menu && mind && change && (
        <MindMenu
          mind={mind}
          target={menu}
          change={change}
          exportFile={exportFile}
          close={() => setMenu(null)}
          details={(node, kind) => setDetail({ node, kind })}
        />
      )}
      {detail && mind && (
        <MindDetailDialog
          mind={mind}
          {...detail}
          close={() => setDetail(null)}
        />
      )}
    </section>
  );
}
