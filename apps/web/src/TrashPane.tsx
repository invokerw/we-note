import { PhoneSheet } from "./PhoneUI";
import { decodeText } from "./plugins/archive";
import {
  lazy,
  Suspense,
  useEffect,
  useRef,
  useState,
  type ReactNode,
} from "react";
import { createPortal } from "react-dom";
import { entryName } from "./libraryEntries";
import { MarkdownView, type MarkdownIO } from "./markdown/MarkdownView";

import { isMindMap } from "./plugins/mindFile";
const MindCanvas = lazy(() => import("./plugins/MindCanvas"));

export type TrashEntry = {
  key: string;
  path: string;
  kind: "file" | "folder" | "asset";
  detail?: string;
};
export type TrashAction = (
  operation: "restore" | "purge",
  entry: TrashEntry,
) => void;

type Actions = { action: TrashAction; canPurge: boolean; busy: boolean };
export function TrashList({
  entries,
  selected,
  select,
  action,
  canPurge,
  busy,
  footer,
  phone,
  error,
}: Actions & {
  entries?: TrashEntry[];
  selected: string;
  select: (entry: TrashEntry) => void;
  footer?: ReactNode;
  phone: boolean;
  error?: string;
}) {
  const [menu, setMenu] = useState<{
    entry: TrashEntry;
    x: number;
    y: number;
  }>();
  const menuRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!menu || phone) return;
    menuRef.current?.querySelector("button")?.focus();
    const outside = (event: PointerEvent) => {
      if (!menuRef.current?.contains(event.target as Node)) setMenu(undefined);
    };
    const close = () => setMenu(undefined);
    document.addEventListener("pointerdown", outside);
    window.addEventListener("resize", close);
    return () => {
      document.removeEventListener("pointerdown", outside);
      window.removeEventListener("resize", close);
    };
  }, [menu, phone]);
  function show(entry: TrashEntry, x: number, y: number) {
    if (busy || (entry.kind === "asset" && !canPurge)) return;
    setMenu({
      entry,
      x: Math.max(4, Math.min(x, innerWidth - 140)),
      y: Math.max(4, Math.min(y, innerHeight - 90)),
    });
  }
  function apply(operation: "restore" | "purge") {
    if (menu) action(operation, menu.entry);
    setMenu(undefined);
  }
  return (
    <>
      <div className="list-scroll">
        {entries?.map((entry) => (
          <div
            className="entry-row"
            key={entry.key}
            onContextMenu={(event) => {
              event.preventDefault();
              show(entry, event.clientX, event.clientY);
            }}
          >
            <button
              className={"entry" + (selected === entry.key ? " current" : "")}
              aria-current={selected === entry.key || undefined}
              aria-label={entryName(entry.path)}
              title={entry.path}
              onClick={() => select(entry)}
            >
              <span>
                <i
                  className={
                    entry.kind === "folder" ? "folder-icon" : "file-icon"
                  }
                  aria-hidden="true"
                />
                {entryName(entry.path)}
              </span>
              <small>{entry.detail || entry.path}</small>
            </button>
            {(entry.kind !== "asset" || canPurge) && (
              <button
                className="entry-more"
                aria-haspopup="menu"
                disabled={busy}
                aria-label={`${entryName(entry.path)} 的回收站操作`}
                onClick={(event) => {
                  const rect = event.currentTarget.getBoundingClientRect();
                  show(entry, rect.left, rect.bottom);
                }}
              >
                •••
              </button>
            )}
          </div>
        ))}
        {!entries?.length && (
          <p className="list-empty">
            {error || (entries ? "回收站为空。" : "正在加载回收站…")}
          </p>
        )}
      </div>
      <footer>
        总共 {entries?.length || 0} 项{footer}
      </footer>
      {menu && phone && <PhoneSheet title="回收站操作" close={() => setMenu(undefined)}>
        <div className="phone-choices">
          <button onClick={() => apply("restore")}>恢复</button>
          {canPurge && <button className="danger-action" onClick={() => apply("purge")}>永久删除</button>}
        </div>
      </PhoneSheet>}
      {menu && !phone && createPortal(
          <div
            ref={menuRef}
            className="entry-menu"
            role="menu"
            style={{ left: menu.x, top: menu.y }}
            onBlur={(event) => {
              if (!event.currentTarget.contains(event.relatedTarget))
                setMenu(undefined);
            }}
            onKeyDown={(event) => {
              if (event.key === "Escape") setMenu(undefined);
            }}
          >
            <button role="menuitem" onClick={() => apply("restore")}>
              恢复
            </button>
            {canPurge && (
              <button className="danger-action" role="menuitem" onClick={() => apply("purge")}>
                永久删除
              </button>
            )}
          </div>,
          document.body,
        )}
    </>
  );
}

export function TrashDocument({
  entry,
  read,
  io,
  action,
  canPurge,
  busy,
}: Actions & {
  entry: TrashEntry;
  read: (entry: TrashEntry) => Promise<Uint8Array>;
  io: MarkdownIO;
}) {
  const [content, setContent] = useState<{ text?: string; error?: string }>({});
  useEffect(() => {
    let current = true;
    read(entry)
      .then((bytes) => decodeText(bytes))
      .then((text) => {
        if (current) setContent({ text });
      })
      .catch((err) => {
        if (current) setContent({ error: String(err) });
      });
    return () => {
      current = false;
    };
  }, [entry.key, entry.path, read]);
  return (
    <article className="document trash-document">
      <header className="document-head">
        <h1 title={entry.path}>{entryName(entry.path)}</h1>
        <div className="head-actions">
          <button disabled={busy} onClick={() => action("restore", entry)}>
            恢复
          </button>
          {canPurge && (
            <button disabled={busy} onClick={() => action("purge", entry)}>
              永久删除
            </button>
          )}
        </div>
      </header>
      <div className="trash-preview-content document-mode" data-markdown-theme="clean">
        {content.text === undefined ? (
          <p>{content.error || "正在加载笔记…"}</p>
        ) : isMindMap(entry.path) ? (
          <Suspense fallback="正在载入导图…">
            <MindCanvas source={content.text} />
          </Suspense>
        ) : /\.md$/i.test(entry.path) ? (
          <MarkdownView text={content.text} io={io} />
        ) : (
          <pre>{content.text}</pre>
        )}
      </div>
    </article>
  );
}
